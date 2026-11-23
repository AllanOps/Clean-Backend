# charges — Sonnet 5.5 — baseline 3

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `app.post("/charges", express.json(...), rateLimit, requireAuth, createCharge)`. |
| **2. Feature flags** | Absent | No flag anywhere. |
| **3. Circuit breaker** | Absent | None. |
| **4. Deadline on every I/O** | Present | Provider and mailer bounded; every `db.charges.*` call unbounded. |
| **5. Off the request path** | Absent | `await withTimeout(mailer.sendReceipt(...))` inline; the notes name a transactional outbox as the fix. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup. |
| *Idempotency* (cut) | Correct | *"Claim the idempotency key BEFORE touching money"* via a unique-index insert; non-unique errors rethrown (fails closed); a completed key replays; in-progress returns 409. |
| *Validation* (cut) | Present | Validated before any I/O. |

**Shipped habits reaching Present or better: 2 of 6 applicable. Reaching Correct: 0 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
// Assumed to exist and be imported: paymentProvider, db, mailer, logger (optional; console fallback below)

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);
const MIN_AMOUNT_CENTS = 50;
const MAX_AMOUNT_CENTS = 1_000_000_00; // $1M hard ceiling; larger needs a different flow
const CUSTOMER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PROVIDER_TIMEOUT_MS = 15_000;
const MAIL_TIMEOUT_MS = 5_000;

class ValidationError extends Error {}

interface ChargeInput {
  customerId: string;
  amountCents: number;
  currency: string; // normalized lowercase
}

function parseBody(body: unknown): ChargeInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Body must be a JSON object");
  }
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || !CUSTOMER_ID_RE.test(customerId)) {
    throw new ValidationError("customerId is missing or malformed");
  }
  // Money is integer minor units. Reject floats, NaN, Infinity, strings, negatives, zero.
  if (
    typeof amountCents !== "number" ||
    !Number.isSafeInteger(amountCents) ||
    amountCents < MIN_AMOUNT_CENTS ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    throw new ValidationError(
      `amountCents must be an integer between ${MIN_AMOUNT_CENTS} and ${MAX_AMOUNT_CENTS}`,
    );
  }
  if (typeof currency !== "string") {
    throw new ValidationError("currency is required");
  }
  const normalized = currency.trim().toLowerCase();
  if (!SUPPORTED_CURRENCIES.has(normalized)) {
    throw new ValidationError("Unsupported currency");
  }
  return { customerId, amountCents, currency: normalized };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === "23505" || e?.code === "ER_DUP_ENTRY" || e?.code === "P2002";
}

const log = {
  info: (msg: string, ctx: object) => console.log(JSON.stringify({ level: "info", msg, ...ctx })),
  warn: (msg: string, ctx: object) => console.warn(JSON.stringify({ level: "warn", msg, ...ctx })),
  error: (msg: string, ctx: object) => console.error(JSON.stringify({ level: "error", msg, ...ctx })),
};

export async function createCharge(req: Request, res: Response): Promise<void> {
  const requestId = (req.headers["x-request-id"] as string) || randomUUID();
  res.setHeader("X-Request-Id", requestId);

  // 1. Idempotency key is mandatory: clients retry on timeouts, and a retry must never double-charge.
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    res.status(400).json({ error: "Idempotency-Key header (16-128 url-safe chars) is required", requestId });
    return;
  }

  // 2. Validate input.
  let input: ChargeInput;
  try {
    input = parseBody(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, requestId });
      return;
    }
    throw err;
  }

  // 3. Authorization: the authenticated principal must be allowed to charge this customer.
  //    (req.auth set by upstream auth middleware; never trust customerId from the body alone.)
  const auth = (req as any).auth as { customerId?: string; roles?: string[] } | undefined;
  if (!auth) {
    res.status(401).json({ error: "Unauthenticated", requestId });
    return;
  }
  if (auth.customerId !== input.customerId && !auth.roles?.includes("billing_admin")) {
    res.status(403).json({ error: "Forbidden", requestId });
    return;
  }

  const logCtx = { requestId, customerId: input.customerId, idempotencyKey };

  try {
    // 4. Claim the idempotency key BEFORE touching money. A unique index on
    //    charges.idempotency_key makes concurrent duplicates race safely: exactly one wins.
    try {
      await db.charges.insert({
        idempotencyKey,
        customerId: input.customerId,
        amountCents: input.amountCents,
        currency: input.currency,
        status: "pending",
        chargeId: null,
        createdAt: new Date(),
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await db.charges.findByIdempotencyKey(idempotencyKey);
      if (
        existing &&
        (existing.customerId !== input.customerId ||
          existing.amountCents !== input.amountCents ||
          existing.currency !== input.currency)
      ) {
        // Same key, different payload: client bug. Refuse rather than guess.
        res.status(422).json({ error: "Idempotency-Key reused with different parameters", requestId });
        return;
      }
      if (existing?.status === "succeeded") {
        res.status(200).json({ chargeId: existing.chargeId, replayed: true, requestId });
        return;
      }
      // pending/unknown: another request (or a crashed one) owns it. Do not re-charge blindly.
      res.status(409).json({ error: "A charge with this Idempotency-Key is in progress", requestId });
      return;
    }

    // 5. Call the provider with the same idempotency key so provider-side retries are also safe.
    let chargeId: string;
    try {
      const result = await withTimeout(
        paymentProvider.charge({ ...input, idempotencyKey } as any),
        PROVIDER_TIMEOUT_MS,
        "paymentProvider.charge",
      );
      if (!result?.chargeId || typeof result.chargeId !== "string") {
        throw new Error("Provider returned no chargeId");
      }
      chargeId = result.chargeId;
    } catch (err) {
      const e = err as { type?: string; code?: string; message?: string };
      const declined = e?.type === "card_error" || e?.code === "card_declined";
      if (declined) {
        await db.charges.updateByIdempotencyKey(idempotencyKey, { status: "declined" }).catch(() => {});
        log.info("charge declined", { ...logCtx, code: e.code });
        res.status(402).json({ error: "Payment declined", requestId });
        return;
      }
      // Timeout / network / 5xx: outcome UNKNOWN. Money may have moved. Leave the row "pending"
      // so reconciliation can resolve it via the provider (lookup by idempotency key); the client
      // may safely retry with the same key.
      log.error("provider outcome unknown", { ...logCtx, error: e?.message });
      res.status(502).json({
        error: "Payment status unknown; retry with the same Idempotency-Key",
        requestId,
      });
      return;
    }

    // 6. Persist the result. If this fails the customer HAS been charged, so never return a plain 500
    //    that invites a fresh-key retry. Log loudly for reconciliation and still return the chargeId.
    try {
      await db.charges.updateByIdempotencyKey(idempotencyKey, {
        status: "succeeded",
        chargeId,
        completedAt: new Date(),
      });
    } catch (err) {
      log.error("CRITICAL: charged but failed to persist", {
        ...logCtx,
        chargeId,
        amountCents: input.amountCents,
        currency: input.currency,
        error: (err as Error).message,
      });
      res.status(202).json({ chargeId, status: "processing", requestId });
      return;
    }

    // 7. Receipt is best-effort: a mail outage must not fail or roll back a successful charge.
    //    Bounded by a timeout so it cannot hold the response hostage. Failures are logged for a retry job.
    try {
      await withTimeout(mailer.sendReceipt(input.customerId, chargeId), MAIL_TIMEOUT_MS, "mailer.sendReceipt");
    } catch (err) {
      log.warn("receipt email failed; needs retry", { ...logCtx, chargeId, error: (err as Error).message });
    }

    log.info("charge succeeded", { ...logCtx, chargeId, amountCents: input.amountCents, currency: input.currency });
    res.status(201).json({ chargeId, requestId });
  } catch (err) {
    // Unexpected (e.g. DB down while claiming the key, before any money moved).
    log.error("unhandled error in POST /charges", { ...logCtx, error: (err as Error).message });
    res.status(500).json({ error: "Internal error", requestId });
  }
}

// Wiring: app.post("/charges", express.json({ limit: "4kb" }), rateLimit, requireAuth, createCharge);
```

**Production concerns I addressed**

- Idempotency: mandatory `Idempotency-Key`, claimed via a unique-indexed insert before charging, so retries and concurrent duplicates cannot double-charge. The key is also forwarded to the provider. Replays return the original result, and a key reused with a different payload gets 422.
- Strict validation: integer-only `amountCents` (no floats/NaN/strings), min/max bounds, currency allowlist and normalization, format checks on `customerId`, and a small body size limit.
- Authorization: the caller must own `customerId` (or be a billing admin), so the body is not trusted for identity.
- Unknown-outcome handling: provider timeouts or 5xx leave the row `pending` and return 502 so reconciliation can resolve it. Declines (402) are distinguished from unknown outcomes.
- Timeouts on the provider and mailer calls so slow dependencies cannot exhaust connections.
- Charged-but-not-persisted: logged as CRITICAL with the full context, and the client still gets the `chargeId` (202) rather than a 500 that triggers a double-charge retry.
- Receipt isolation: email failure never fails or rolls back a successful charge. It is logged for a retry job, and a transactional outbox would be better still.
- Observability: request ID propagated and echoed, structured JSON logs with no card or PII beyond IDs, and distinct log levels for alerting.
- Assumptions to confirm: `db.charges` has a unique index on `idempotencyKey` plus `findByIdempotencyKey`/`updateByIdempotencyKey`, the provider accepts an idempotency key, and auth and rate-limit middleware run before the handler. Not covered here: a reconciliation job for `pending` rows, a receipt outbox, and tests.
````
