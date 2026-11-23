# charges — Haiku 5.5 — baseline 1

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), baseline prompt used verbatim
- **Model:** Claude Haiku 5.5 (`claude-haiku-5-5`, smaller tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | `// router.post("/charges", express.json({ limit: "10kb" }), createCharge);` |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None. |
| **4. Deadline on every I/O** | Present | Provider and mailer bounded; `withRetry(() => db.charges.insert(record), ...)` retried but unbounded. |
| **5. Off the request path** | Absent | `await withTimeout(mailer.sendReceipt(...))` inline. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | n/a | No read. |
| *Idempotency* (cut) | Present | Key required and forwarded to the provider; never stored before the charge, no replay. Does **not** fail open. |
| *Validation* (cut) | Present | Validated first. |

**Shipped habits reaching Present or better: 1 of 6 applicable. Reaching Correct: 0 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
// Assumed to exist in the project, per the spec:
import { paymentProvider, db, mailer } from "./deps";
// Assumed structured logger (pino-style: child(), fatal(), error()):
import { logger } from "./logger";

const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP", "CAD", "AUD"]);
const MAX_AMOUNT_CENTS = 5_000_000; // $50,000.00 per-charge ceiling; set per risk policy
const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAILER_TIMEOUT_MS = 5_000;
const DB_INSERT_ATTEMPTS = 3;
const DB_RETRY_BASE_DELAY_MS = 200;

interface ChargeRequestBody {
  customerId: string;
  amountCents: number;
  currency: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, baseDelayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

function parseChargeBody(body: unknown): ChargeRequestBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || !CUSTOMER_ID_PATTERN.test(customerId)) {
    throw new HttpError(400, "invalid_customer_id", "customerId is missing or malformed");
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    throw new HttpError(
      400,
      "invalid_amount",
      `amountCents must be an integer between 1 and ${MAX_AMOUNT_CENTS}`,
    );
  }
  if (typeof currency !== "string") {
    throw new HttpError(400, "invalid_currency", "currency is required");
  }
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(normalizedCurrency)) {
    throw new HttpError(400, "unsupported_currency", "currency is not supported");
  }

  return { customerId, amountCents, currency: normalizedCurrency };
}

function parseIdempotencyKey(header: string | undefined): string {
  if (!header || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key header is required (8-128 chars: letters, digits, _ or -)",
    );
  }
  return header;
}

function isCardDeclined(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "card_declined";
}

export async function createCharge(req: Request, res: Response, next: NextFunction): Promise<void> {
  const requestId = req.get("x-request-id") ?? randomUUID();

  try {
    const body = parseChargeBody(req.body);
    const idempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key"));
    const log = logger.child({ requestId, idempotencyKey });

    // 1. Charge the customer. The idempotency key lets the client (and us) retry
    //    safely after a timeout or a crash without double-charging.
    let chargeId: string;
    try {
      const charge = await withTimeout(
        paymentProvider.charge({ ...body, idempotencyKey }),
        PROVIDER_TIMEOUT_MS,
        "paymentProvider.charge",
      );
      chargeId = charge.chargeId;
    } catch (err) {
      if (isCardDeclined(err)) {
        log.info({ err }, "charge declined");
        throw new HttpError(402, "card_declined", "Payment was declined");
      }
      // Ambiguous outcome is possible (e.g. timeout). Same key on retry is safe.
      log.error({ err }, "charge failed or outcome unknown");
      throw new HttpError(
        502,
        "payment_provider_error",
        "Payment could not be confirmed. Retry with the same Idempotency-Key.",
      );
    }

    // 2. Persist the charge. Money has moved at this point, so a failure here
    //    must be loud and must not be reported as a clean failure.
    const record = {
      chargeId,
      customerId: body.customerId,
      amountCents: body.amountCents,
      currency: body.currency,
      idempotencyKey,
      status: "succeeded" as const,
      createdAt: new Date(),
    };
    try {
      await withRetry(() => db.charges.insert(record), DB_INSERT_ATTEMPTS, DB_RETRY_BASE_DELAY_MS);
    } catch (err) {
      log.fatal({ err, chargeId }, "CHARGE_NOT_PERSISTED: provider charge succeeded, DB insert failed");
      throw new HttpError(
        500,
        "charge_persistence_failed",
        "Charge was processed but not recorded. Retry with the same Idempotency-Key.",
      );
    }

    // 3. Receipt email. The charge is already durable, so a mail failure must
    //    not fail the request. Log it for a retry job to pick up.
    try {
      await withTimeout(
        mailer.sendReceipt(body.customerId, chargeId),
        MAILER_TIMEOUT_MS,
        "mailer.sendReceipt",
      );
    } catch (err) {
      log.error({ err, chargeId }, "receipt email failed; charge is recorded");
    }

    res.status(201).json({
      chargeId,
      amountCents: body.amountCents,
      currency: body.currency,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } });
      return;
    }
    next(err);
  }
}

// Registration (body size capped so large payloads are rejected early):
// router.post("/charges", express.json({ limit: "10kb" }), createCharge);
```

Production concerns I addressed

- Input validation: customerId format, integer amountCents within a bounded range, and currency whitelisted and normalized. Malformed requests get a 400 before any provider call.
- Idempotency: a required Idempotency-Key header is forwarded to the provider, so client retries after timeouts or crashes cannot double-charge.
- Partial failure after money moves: if the DB insert fails after a successful charge, the insert is retried, and if it still fails the error is logged at fatal level with the chargeId for reconciliation. The client gets a 500 that tells it to retry with the same key.
- Provider errors: card declines map to 402. Timeouts and other provider failures map to 502 with no internal details leaked, and the outcome is logged.
- Timeouts: provider and mailer calls have explicit timeouts so a hung dependency cannot hold the request open.
- Email is non-fatal: a receipt failure is logged and does not fail a charge that is already recorded. A retry queue is the next step if receipts must be guaranteed.
- Safe responses: errors carry a stable code and the request ID, and the response never echoes internal error text or the full customer record.
- Body size limit and structured logging with request IDs for tracing.

Assumptions to check: the provider accepts an idempotencyKey field (the spec's call shape has none, so this is an addition); there is a shared logger with pino-style methods; a upstream auth middleware sets the customer identity, so the endpoint should be authenticated and customerId checked against the caller in a real deployment.
````
