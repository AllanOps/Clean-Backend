# charges — Haiku 5.5 — baseline 2

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), baseline prompt used verbatim
- **Model:** Claude Haiku 5.5 (`claude-haiku-5-5`, smaller tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Absent | No versioned route. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None. |
| **4. Deadline on every I/O** | Present | Provider and mailer bounded; `db.charges.insert/findById/update` unbounded. |
| **5. Off the request path** | Absent | `await withTimeout(mailer.sendReceipt(...))` inline. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup. |
| *Idempotency* (cut) | Correct | *"Claims the idempotency key before any money moves. The insert is the lock"*; non-unique errors rethrown (fails closed); a completed key replays; payload mismatch returns 422. |
| *Validation* (cut) | Present | Validated first. |

**Shipped habits reaching Present or better: 1 of 6 applicable. Reaching Correct: 0 of 6 applicable.**

## Verbatim output

````markdown
```typescript
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
// Existing dependencies (assumed present in the project).
import { db, mailer, paymentProvider } from "../clients";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["USD", "EUR", "GBP", "CAD", "AUD"]);
/** $100,000.00 per charge. Anything larger should go through manual review. */
const MAX_AMOUNT_CENTS = 100_000_00;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAILER_TIMEOUT_MS = 5_000;
/** A pending reservation older than this is treated as abandoned and may be re-driven. */
const PENDING_STALE_MS = 60_000;

const CUSTOMER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

// ---------------------------------------------------------------------------
// Types and errors
// ---------------------------------------------------------------------------

export interface ChargeInput {
  customerId: string;
  amountCents: number;
  currency: string;
}

type ChargeStatus = "pending" | "succeeded" | "failed";

interface ChargeRecord extends ChargeInput {
  /** Equal to the Idempotency-Key. Used as the primary key so duplicates cannot be inserted. */
  id: string;
  status: ChargeStatus;
  chargeId?: string;
  failureCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

type Reservation =
  | { kind: "reserved" }
  | { kind: "replay"; record: ChargeRecord }
  | { kind: "in_progress" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseChargeBody(body: unknown): ChargeInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object.");
  }
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || !CUSTOMER_ID_RE.test(customerId)) {
    throw new HttpError(400, "invalid_customer_id", "customerId must be 1-64 letters, digits, '_' or '-'.");
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
      `amountCents must be an integer between 1 and ${MAX_AMOUNT_CENTS}.`,
    );
  }
  // Strict: must already be an uppercase ISO 4217 code. No silent normalization.
  if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency)) {
    throw new HttpError(400, "unsupported_currency", "currency must be a supported ISO 4217 code.");
  }
  return { customerId, amountCents, currency };
}

function readIdempotencyKey(req: Request): string {
  const raw = req.headers["idempotency-key"];
  if (typeof raw !== "string" || !IDEMPOTENCY_KEY_RE.test(raw)) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key header is required (16-128 chars: letters, digits, '_' or '-').",
    );
  }
  return raw;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

// Assumed error codes from the DB driver and payment client.
const isUniqueViolation = (err: unknown) => errorCode(err) === "DUPLICATE_KEY";
const isDeclined = (err: unknown) => errorCode(err) === "card_declined";

/**
 * Claims the idempotency key before any money moves. The insert is the lock:
 * two concurrent requests with the same key cannot both reach the provider.
 */
async function reserve(key: string, input: ChargeInput): Promise<Reservation> {
  const now = new Date();
  try {
    await db.charges.insert({ id: key, ...input, status: "pending", createdAt: now, updatedAt: now });
    return { kind: "reserved" };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  const existing = await db.charges.findById(key);
  if (!existing) {
    return { kind: "in_progress" };
  }
  if (
    existing.customerId !== input.customerId ||
    existing.amountCents !== input.amountCents ||
    existing.currency !== input.currency
  ) {
    throw new HttpError(422, "idempotency_key_reused", "Idempotency-Key was already used for a different request.");
  }
  if (existing.status !== "pending") {
    return { kind: "replay", record: existing };
  }
  if (Date.now() - existing.updatedAt.getTime() < PENDING_STALE_MS) {
    return { kind: "in_progress" };
  }
  // Stale pending: the previous attempt's outcome is unknown. Re-drive the provider
  // with the same key; the provider must deduplicate on it. (Use a conditional
  // update in the real DB so only one retry takes over.)
  await db.charges.update(key, { updatedAt: now });
  return { kind: "reserved" };
}

// ---------------------------------------------------------------------------
// Handler: POST /charges
// ---------------------------------------------------------------------------

export async function postCharge(req: Request, res: Response): Promise<void> {
  const requestId =
    typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : randomUUID();
  const log = logger.child({ requestId, route: "POST /charges" });

  try {
    const input = parseChargeBody(req.body);
    const key = readIdempotencyKey(req);

    const reservation = await reserve(key, input);
    if (reservation.kind === "in_progress") {
      throw new HttpError(409, "charge_in_progress", "A charge with this Idempotency-Key is in progress.", true);
    }
    if (reservation.kind === "replay") {
      const { record } = reservation;
      if (record.status === "failed") {
        throw new HttpError(402, record.failureCode ?? "card_declined", "The payment was declined.");
      }
      res.status(200).json({
        chargeId: record.chargeId,
        status: record.status,
        amountCents: record.amountCents,
        currency: record.currency,
      });
      return;
    }

    // We own the reservation. Charge the customer.
    let chargeId: string;
    try {
      ({ chargeId } = await withTimeout(
        paymentProvider.charge({ ...input, idempotencyKey: key }),
        PROVIDER_TIMEOUT_MS,
        "paymentProvider.charge",
      ));
    } catch (err) {
      if (isDeclined(err)) {
        await db.charges.update(key, { status: "failed", failureCode: "card_declined", updatedAt: new Date() });
        throw new HttpError(402, "card_declined", "The payment was declined.");
      }
      // Timeout or provider failure: the money may or may not have moved.
      // Leave the row pending so a retry with the same key re-drives the provider.
      log.error({ err, idempotencyKey: key }, "charge outcome unknown");
      throw new HttpError(
        502,
        "payment_provider_unavailable",
        "Payment could not be confirmed. Retry with the same Idempotency-Key.",
        true,
      );
    }

    try {
      await db.charges.update(key, { status: "succeeded", chargeId, updatedAt: new Date() });
    } catch (err) {
      // Money moved but we could not record it. Never mark this failed.
      // A retry with the same key re-drives the provider, which returns the same chargeId.
      log.error(
        { err, chargeId, idempotencyKey: key },
        "CRITICAL: charge succeeded but persistence failed; needs reconciliation",
      );
      throw new HttpError(
        500,
        "persist_failed",
        "Charge was processed but not saved. Retry with the same Idempotency-Key.",
        true,
      );
    }

    // The charge is complete. A receipt failure must not turn this into an error.
    try {
      await withTimeout(
        mailer.sendReceipt(input.customerId, chargeId),
        MAILER_TIMEOUT_MS,
        "mailer.sendReceipt",
      );
    } catch (err) {
      log.error({ err, chargeId }, "receipt email failed; needs retry");
    }

    log.info({ chargeId, amountCents: input.amountCents, currency: input.currency }, "charge succeeded");
    res.status(201).json({
      chargeId,
      status: "succeeded",
      amountCents: input.amountCents,
      currency: input.currency,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, retryable: err.retryable, requestId },
      });
      return;
    }
    log.error({ err }, "unhandled error in POST /charges");
    res.status(500).json({
      error: { code: "internal_error", message: "Unexpected error.", retryable: true, requestId },
    });
  }
}
```

**Production concerns I addressed**

- **Double charges on retry:** Requires an `Idempotency-Key` header. Replays of a completed key return the original result without charging again, and reusing a key for a different payload returns 422.
- **Concurrent duplicates:** The key is claimed with a pending row before the provider is called, so two simultaneous requests cannot both charge.
- **Unknown outcomes:** Timeouts and provider failures leave the row pending and return a retryable 502. Only a definite decline is marked failed.
- **Charged but not recorded:** If the DB write fails after a successful charge, the row is never marked failed. The error is logged as critical for reconciliation, and a same-key retry recovers it.
- **Receipt failures:** The email is sent with a timeout and its failure is logged without failing the request, since the money has already moved.
- **Input validation:** Strict checks on customer ID format, integer cent amounts within a ceiling, and an allowlisted uppercase currency code.
- **Timeouts:** Both the provider and mailer calls are bounded so a hung dependency cannot hold the request open.
- **Error contract:** Consistent JSON errors with a machine-readable code, a `retryable` flag, and a request ID for log correlation. Internal details are not leaked to clients.
- **Logging:** Structured logs use IDs and amounts only, with no card or customer PII.
````
