# charges — Sonnet 5.5 — baseline 1

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `app.post("/charges", ...)` — unversioned. |
| **2. Feature flags** | Absent | No flag anywhere. |
| **3. Circuit breaker** | Absent | None. The closing notes list a provider circuit breaker under *Not shown, assumed to be handled elsewhere*. |
| **4. Deadline on every I/O** | Present | Provider and mailer wrapped in `withTimeout`; `await db.charges.insert(record)` is unbounded. |
| **5. Off the request path** | Absent | `await withTimeout(mailer.sendReceipt(...))` inline, with the comment *"Ideally enqueue to an outbox/job queue for retries; inline attempt shown here."* |
| **6. Business counters** | Absent | Structured logs only; no metrics call. |
| **7. Tombstone-aware reads** | n/a | No visibility read. |
| *Idempotency* (cut) | Present | Key required and forwarded to the provider, but never claimed in the store before the charge and no replay path. Correctness rests on provider-side dedupe, which the spec does not promise. |
| *Validation* (cut) | Present | Header format and body fields checked before any dependency call. |

**Shipped habits reaching Present or better: 2 of 6 applicable. Reaching Correct: 0 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";

// Assumed to exist and be imported: paymentProvider, db, mailer, logger (optional; console fallback below)

const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "JPY"]);
// Zero-decimal currencies: amountCents is interpreted as the minor unit either way.
const MAX_AMOUNT_CENTS = 100_000_00; // hard ceiling per charge: 100,000.00; tune per business
const MAX_ID_LENGTH = 128;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

const PROVIDER_TIMEOUT_MS = 15_000;
const MAILER_TIMEOUT_MS = 5_000;
const DB_INSERT_ATTEMPTS = 3;

const log = {
  info: (msg: string, ctx: object) => console.log(JSON.stringify({ level: "info", msg, ...ctx })),
  warn: (msg: string, ctx: object) => console.warn(JSON.stringify({ level: "warn", msg, ...ctx })),
  error: (msg: string, ctx: object) => console.error(JSON.stringify({ level: "error", msg, ...ctx })),
};

interface ChargeInput {
  customerId: string;
  amountCents: number;
  currency: string;
}

type ValidationResult =
  | { ok: true; value: ChargeInput }
  | { ok: false; errors: { field: string; message: string }[] };

function validateBody(body: unknown): ValidationResult {
  const errors: { field: string; message: string }[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  }
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || customerId.trim() === "" || customerId.length > MAX_ID_LENGTH) {
    errors.push({ field: "customerId", message: `must be a non-empty string up to ${MAX_ID_LENGTH} chars` });
  }
  // Number.isSafeInteger rejects floats, NaN, Infinity, strings like "100"
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    errors.push({ field: "amountCents", message: "must be a positive integer" });
  } else if (amountCents > MAX_AMOUNT_CENTS) {
    errors.push({ field: "amountCents", message: `must not exceed ${MAX_AMOUNT_CENTS}` });
  }
  const normalizedCurrency = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!SUPPORTED_CURRENCIES.has(normalizedCurrency)) {
    errors.push({ field: "currency", message: "must be a supported ISO 4217 code" });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      customerId: (customerId as string).trim(),
      amountCents: amountCents as number,
      currency: normalizedCurrency,
    },
  };
}

class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

// Note: this bounds how long WE wait; it does not cancel the underlying call.
// If the provider client supports AbortSignal, pass one in as well.
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isDeclineError(err: any): boolean {
  // Adapt to the real provider SDK's error taxonomy.
  return err?.type === "card_error" || err?.code === "card_declined" || err?.status === 402;
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === "23505" /* postgres unique_violation */ || err?.code === "DUPLICATE";
}

// Persist with bounded retries. The customer has ALREADY been charged at this point,
// so a transient DB failure must not be treated as "the charge failed".
async function persistChargeWithRetry(record: Record<string, unknown>, requestId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= DB_INSERT_ATTEMPTS; attempt++) {
    try {
      await db.charges.insert(record);
      return true;
    } catch (err: any) {
      if (isDuplicateKeyError(err)) {
        // Same chargeId / idempotency key already stored: a prior attempt succeeded.
        log.info("charge already persisted", { requestId, chargeId: record.chargeId });
        return true;
      }
      log.warn("charge insert failed", { requestId, chargeId: record.chargeId, attempt, error: err?.message });
      if (attempt < DB_INSERT_ATTEMPTS) await sleep(100 * 2 ** attempt + Math.random() * 50);
    }
  }
  return false;
}

export async function createChargeHandler(req: Request, res: Response): Promise<void> {
  const requestId = (req.header("x-request-id") ?? randomUUID()).slice(0, 64);
  res.setHeader("x-request-id", requestId);

  // 1. Idempotency key: required so client/network retries can never double-charge.
  const idempotencyKey = req.header("idempotency-key");
  if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    res.status(400).json({
      error: "invalid_idempotency_key",
      message: "Idempotency-Key header (8-128 chars, [A-Za-z0-9_-:.]) is required",
      requestId,
    });
    return;
  }

  // 2. Validate input.
  const parsed = validateBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "validation_failed", details: parsed.errors, requestId });
    return;
  }
  const { customerId, amountCents, currency } = parsed.value;

  // NOTE: authN/authZ is assumed to run in upstream middleware. Before this point, ensure
  // the authenticated principal is allowed to charge `customerId` (never trust the body alone).

  // 3. Charge the provider. Pass the idempotency key so retries return the same charge.
  let chargeId: string;
  try {
    const result = await withTimeout(
      paymentProvider.charge({ customerId, amountCents, currency, idempotencyKey } as any),
      PROVIDER_TIMEOUT_MS,
      "paymentProvider.charge",
    );
    if (!result || typeof result.chargeId !== "string" || result.chargeId === "") {
      throw new Error("provider returned malformed response");
    }
    chargeId = result.chargeId;
  } catch (err: any) {
    if (isDeclineError(err)) {
      log.info("charge declined", { requestId, customerId, code: err?.code });
      res.status(402).json({ error: "charge_declined", requestId });
      return;
    }
    // Timeout / network / 5xx: the outcome is UNKNOWN. The money may have moved.
    // Do not tell the client it failed definitively; they should retry with the same
    // Idempotency-Key, and reconciliation should catch anything that slips through.
    const unknownOutcome = err instanceof TimeoutError || err?.name === "FetchError" || err?.code === "ECONNRESET";
    log.error("provider charge error", {
      requestId, customerId, amountCents, currency, idempotencyKey,
      unknownOutcome, error: err?.message,
    });
    res
      .status(unknownOutcome ? 504 : 502)
      .json({ error: unknownOutcome ? "charge_outcome_unknown" : "payment_provider_error", retryable: true, requestId });
    return;
  }

  // 4. Persist. Money has moved, so failure here is an incident, not a plain 500.
  const persisted = await persistChargeWithRetry(
    { chargeId, customerId, amountCents, currency, idempotencyKey, status: "succeeded", createdAt: new Date() },
    requestId,
  );
  if (!persisted) {
    // Page on-call / feed reconciliation: charge exists at provider, missing in our DB.
    log.error("CRITICAL: charge succeeded at provider but could not be persisted", {
      requestId, chargeId, customerId, amountCents, currency, idempotencyKey,
    });
    // 202: accepted and charged, bookkeeping pending. Returning 500 would invite a retry storm.
    res.status(202).json({ chargeId, status: "succeeded_pending_record", requestId });
    return;
  }

  // 5. Receipt is best-effort. A mail failure must never fail or roll back a completed charge.
  //    (Ideally enqueue to an outbox/job queue for retries; inline attempt shown here.)
  try {
    await withTimeout(mailer.sendReceipt(customerId, chargeId), MAILER_TIMEOUT_MS, "mailer.sendReceipt");
  } catch (err: any) {
    log.warn("receipt email failed; needs retry", { requestId, chargeId, customerId, error: err?.message });
  }

  log.info("charge created", { requestId, chargeId, customerId, amountCents, currency });
  res.status(201).json({ chargeId, status: "succeeded", requestId });
}

// Wrap in an async-safe error boundary so an unexpected throw never hangs the request.
export function createChargeRoute(app: { post: Function }) {
  app.post("/charges", (req: Request, res: Response) => {
    createChargeHandler(req, res).catch((err) => {
      log.error("unhandled error in POST /charges", { error: err?.message });
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    });
  });
}
```

**Production concerns I addressed**

- Strict input validation: safe-integer positive cents, upper limit, allowlisted and normalized currency, bounded ID length, non-object bodies rejected; no PII or card data logged.
- Idempotency: a required `Idempotency-Key` header is forwarded to the provider and stored with the charge (back it with a unique DB index), so client or proxy retries cannot double-charge. Duplicate-key insert errors are treated as "already saved".
- Timeouts on the provider and mailer calls, so slow dependencies cannot pin connections.
- Error taxonomy: declines return 402; timeouts and network errors return 504 with "outcome unknown" and are retryable with the same key; other provider failures return 502; malformed provider responses are rejected.
- Charged-but-not-persisted path: bounded retries with jittered backoff, then a CRITICAL log carrying all reconciliation data and a 202 response, not a 500 that invites retries.
- Mail failure is isolated: it is logged for later retry and never fails or rolls back a completed charge. An outbox or queue would be the next step.
- Observability: request ID propagated to the response and logs, structured JSON logs, and an async error wrapper so unexpected throws always produce a response.
- Not shown, assumed to be handled elsewhere: authN/authZ (the caller may charge this `customerId`), rate limiting, body size limits, a provider circuit breaker, a periodic provider-to-DB reconciliation job, and tests.
````
