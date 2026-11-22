# charges — Sonnet 5.5 — baseline 2

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | No versioned mount; handler registered as `/charges`. |
| **2. Feature flags** | Absent | No flag anywhere. |
| **3. Circuit breaker** | Absent | None. |
| **4. Deadline on every I/O** | Present | Provider and mailer bounded; `db.charges.findByIdempotencyKey` and `db.charges.insert` unbounded. |
| **5. Off the request path** | Present | `void withTimeout(mailer.sendReceipt(...)).catch(...)`: a floating promise, lost on restart. Comment: *"Ideally enqueue to an outbox/job queue; inline with timeout shown here."* (the code is not inline, it floats) |
| **6. Business counters** | Absent | Logs only; *"Alerting hook / dead-letter queue would go here."* |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup, which correctly does not filter. |
| *Idempotency* (cut) | Present | Required, replayed on a completed key, mismatch returns 422. But looked up, not claimed: two concurrent first requests both pass `findByIdempotencyKey` and both reach the provider. Relies on provider dedupe. |
| *Validation* (cut) | Present | Body and header validated first. |

**Shipped habits reaching Present or better: 3 of 6 applicable. Reaching Correct: 0 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
// Assumed to already exist and be imported: paymentProvider, db, mailer, logger

// ---------- Config ----------
const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);
const MIN_AMOUNT_CENTS = 50;
const MAX_AMOUNT_CENTS = 1_000_000; // $10k per charge; larger needs a manual/review flow
const PROVIDER_TIMEOUT_MS = 15_000;
const MAILER_TIMEOUT_MS = 5_000;
const CUSTOMER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

// ---------- Helpers ----------
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

interface ValidCharge {
  customerId: string;
  amountCents: number;
  currency: string; // normalized lowercase
}

function validateBody(body: unknown): ValidCharge {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_body", "Request body must be a JSON object");
  }
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || !CUSTOMER_ID_RE.test(customerId)) {
    throw new ApiError(400, "invalid_customer_id", "customerId is missing or malformed");
  }
  // Money is integer cents only: reject floats, NaN, Infinity, strings, unsafe ints.
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents)) {
    throw new ApiError(400, "invalid_amount", "amountCents must be an integer");
  }
  if (amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    throw new ApiError(
      400,
      "amount_out_of_range",
      `amountCents must be between ${MIN_AMOUNT_CENTS} and ${MAX_AMOUNT_CENTS}`,
    );
  }
  if (typeof currency !== "string") {
    throw new ApiError(400, "invalid_currency", "currency is required");
  }
  const normalizedCurrency = currency.trim().toLowerCase();
  if (!SUPPORTED_CURRENCIES.has(normalizedCurrency)) {
    throw new ApiError(400, "unsupported_currency", "Unsupported currency");
  }
  return { customerId, amountCents, currency: normalizedCurrency };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === "23505" || e?.code === "ER_DUP_ENTRY" || e?.code === "P2002";
}

// Map provider failures to client-facing results without leaking provider internals.
function mapProviderError(err: unknown): ApiError {
  const e = err as { type?: string; code?: string; message?: string };
  if (e?.type === "card_declined" || e?.code === "card_declined") {
    return new ApiError(402, "card_declined", "Payment was declined");
  }
  if (e?.type === "invalid_request") {
    return new ApiError(422, "charge_rejected", "Charge was rejected");
  }
  // Timeouts / 5xx / network: the outcome is UNKNOWN. Client must retry with the
  // SAME Idempotency-Key so the provider dedupes rather than double charging.
  return new ApiError(
    502,
    "provider_unavailable",
    "Payment outcome could not be confirmed; retry with the same Idempotency-Key",
    true,
  );
}

// ---------- Handler ----------
export async function postCharges(req: Request, res: Response): Promise<void> {
  const requestId = (req.header("x-request-id") ?? randomUUID()).slice(0, 64);
  res.setHeader("x-request-id", requestId);
  const log = logger.child({ requestId, route: "POST /charges" });

  try {
    // 1. AuthN/AuthZ: caller may only charge for their own customer
    //    (auth middleware is assumed to set req.auth).
    const auth = (req as any).auth as { customerId?: string; isService?: boolean } | undefined;
    if (!auth) throw new ApiError(401, "unauthenticated", "Authentication required");

    // 2. Idempotency key is mandatory for a money-moving call.
    const idempotencyKey = req.header("idempotency-key");
    if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new ApiError(400, "missing_idempotency_key", "A valid Idempotency-Key header is required");
    }

    // 3. Validate input
    const { customerId, amountCents, currency } = validateBody(req.body);
    if (!auth.isService && auth.customerId !== customerId) {
      throw new ApiError(403, "forbidden", "Not allowed to charge this customer");
    }

    // 4. Replay: same key already completed -> return the original result.
    const existing = await db.charges.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (
        existing.customerId !== customerId ||
        existing.amountCents !== amountCents ||
        existing.currency !== currency
      ) {
        throw new ApiError(422, "idempotency_key_reuse", "Idempotency-Key was used with different parameters");
      }
      log.info({ chargeId: existing.chargeId }, "idempotent replay");
      res.status(200).json({ chargeId: existing.chargeId, replayed: true });
      return;
    }

    // 5. Charge. Idempotency key is forwarded so provider-side retries
    //    (including our own after a timeout) cannot double charge.
    let chargeId: string;
    try {
      const result = await withTimeout(
        paymentProvider.charge({ customerId, amountCents, currency, idempotencyKey } as any),
        PROVIDER_TIMEOUT_MS,
        "paymentProvider.charge",
      );
      if (!result || typeof result.chargeId !== "string" || !result.chargeId) {
        throw new Error("provider returned no chargeId");
      }
      chargeId = result.chargeId;
    } catch (err) {
      const mapped = mapProviderError(err);
      log.error(
        { customerId, amountCents, currency, code: mapped.code, err: (err as Error)?.message },
        "charge failed",
      );
      throw mapped;
    }

    // 6. Persist. Money has moved: a failure here is a CRITICAL reconciliation event,
    //    not a reason to tell the client the charge failed.
    try {
      await db.charges.insert({
        chargeId,
        customerId,
        amountCents,
        currency,
        idempotencyKey,
        status: "succeeded",
        createdAt: new Date(),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Concurrent duplicate request won the race; treat as replay.
        log.warn({ chargeId }, "duplicate insert; concurrent request with same key");
        res.status(200).json({ chargeId, replayed: true });
        return;
      }
      log.fatal(
        { chargeId, customerId, amountCents, currency, idempotencyKey, err: (err as Error)?.message },
        "CRITICAL: charge succeeded at provider but DB insert failed; needs reconciliation",
      );
      // Alerting hook / dead-letter queue would go here.
      res.status(202).json({ chargeId, status: "processing" });
      return;
    }

    // 7. Receipt is best-effort: never fail or delay a completed charge on email problems.
    //    (Ideally enqueue to an outbox/job queue; inline with timeout shown here.)
    void withTimeout(mailer.sendReceipt(customerId, chargeId), MAILER_TIMEOUT_MS, "mailer.sendReceipt").catch(
      (err) => log.warn({ chargeId, err: (err as Error)?.message }, "receipt email failed; queue for retry"),
    );

    log.info({ chargeId, amountCents, currency }, "charge succeeded");
    res.status(201).json({ chargeId });
  } catch (err) {
    if (err instanceof ApiError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, retryable: err.retryable, requestId },
      });
      return;
    }
    log.error({ err: (err as Error)?.stack }, "unhandled error in POST /charges");
    res.status(500).json({
      error: { code: "internal_error", message: "Internal server error", retryable: false, requestId },
    });
  }
}
```

**Production concerns I addressed**

- **Double-charge protection:** mandatory `Idempotency-Key` header, forwarded to the provider, stored with the charge, with replay lookup and a unique-constraint race fallback. The same key with different params returns 422.
- **Strict input validation:** integer-only safe cents (no floats, NaN or strings), min and max bounds, a currency allowlist normalized to lowercase, and a customerId format check. Non-object bodies are rejected.
- **AuthN/AuthZ:** the caller must be authenticated and may only charge their own customerId, unless it is a service principal.
- **Timeouts:** hard timeouts on the provider and the mailer so slow dependencies can't pin connections.
- **Unknown-outcome handling:** provider timeouts and 5xx map to a retryable 502 that tells the client to retry with the same key. Declines map to 402 and rejections to 422. Provider internals are not leaked.
- **Charged-but-not-persisted:** a DB failure after a successful charge logs a fatal "needs reconciliation" event with all identifiers and returns 202 with the chargeId. It never returns a failure that invites a retry-and-double-charge. This is the hook for alerting or a dead-letter queue.
- **Email is non-blocking:** a receipt failure never fails the request or changes the response. It is logged for retry, and an outbox or queue is the better long-term home.
- **Observability:** request ID propagation, structured logs with a chargeId and request context, and no card or PII data and no raw bodies logged.
- **Consistent error contract:** a uniform `{error:{code,message,retryable,requestId}}` shape, with a catch-all 500 that doesn't expose stack traces.
- **Assumptions and gaps:** the provider accepts an `idempotencyKey` field, and `db.charges` has `findByIdempotencyKey` plus a unique index on the key. Rate limiting, per-customer velocity limits, and a pending-row-first write for stronger in-flight dedupe would sit alongside this at the gateway or DB layer.
````
