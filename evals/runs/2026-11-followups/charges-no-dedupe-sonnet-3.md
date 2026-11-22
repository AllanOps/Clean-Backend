# charges-no-dedupe — Sonnet 5.5 — baseline 3

- **Scenario:** [`../../scenarios/charges-no-dedupe.md`](../../scenarios/charges-no-dedupe.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| ***Idempotency* (decides this scenario)** | **Correct** | *"Step 1: claim the key BEFORE moving money."* Unique insert; non-unique errors return `503`; duplicates replay, payload mismatch returns 422. |
| **1. Version the route** | Absent | No versioned route; no route registration shown. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None around the provider. |
| **4. Deadline on every I/O** | Present | `withTimeout(paymentProvider.charge(...))`; the idempotency-claim and `db.charges` writes are unbounded. |
| **5. Off the request path** | Absent | `await withTimeout(mailer.sendReceipt(customerId, chargeId), 5_000);` inline. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup, which correctly does not filter. |

Idempotency criteria: required, claimed before `paymentProvider.charge()`, completed key replays, store error refuses the request. All four hold.

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
// Assumed to exist and be imported: paymentProvider, db, mailer, logger

const MAX_AMOUNT_CENTS = 1_000_000_00; // sanity ceiling: 1,000,000.00
const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);
const PROVIDER_TIMEOUT_MS = 15_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

type ChargeStatus = "pending" | "succeeded" | "failed" | "unknown";

/**
 * Assumed schema (db.charges):
 *  - UNIQUE(idempotency_key)
 *  - columns: id, idempotency_key, request_hash, customer_id, amount_cents,
 *    currency, status, charge_id (nullable), created_at, updated_at
 *  - db.charges.insert throws an error with code "UNIQUE_VIOLATION" on dup key
 *  - db.charges.findByIdempotencyKey(key), db.charges.update(key, patch)
 */

class ProviderTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError("provider timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function validate(body: any):
  | { ok: true; value: { customerId: string; amountCents: number; currency: string } }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body required" };
  const { customerId, amountCents, currency } = body;
  if (typeof customerId !== "string" || customerId.length === 0 || customerId.length > 128)
    return { ok: false, error: "invalid customerId" };
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS)
    return { ok: false, error: "amountCents must be a positive integer within limits" };
  if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency.toLowerCase()))
    return { ok: false, error: "unsupported currency" };
  return { ok: true, value: { customerId, amountCents, currency: currency.toLowerCase() } };
}

function hashRequest(v: { customerId: string; amountCents: number; currency: string }): string {
  return require("crypto").createHash("sha256").update(JSON.stringify([v.customerId, v.amountCents, v.currency])).digest("hex");
}

async function retry<T>(fn: () => Promise<T>, attempts: number, baseMs: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

function replay(res: Response, row: any) {
  switch (row.status as ChargeStatus) {
    case "succeeded":
      return res.status(200).json({ chargeId: row.charge_id, replayed: true });
    case "pending":
      return res.status(409).json({ error: "request in progress" });
    case "unknown":
      // Outcome unknown: money may have moved. Never auto-retry.
      return res.status(202).json({ error: "outcome pending reconciliation", replayed: true });
    default:
      return res.status(402).json({ error: "charge previously failed", replayed: true });
  }
}

export async function postCharges(req: Request, res: Response) {
  const key = req.header("Idempotency-Key");
  if (!key || !IDEMPOTENCY_KEY_RE.test(key))
    return res.status(400).json({ error: "Idempotency-Key header required" });

  const parsed = validate(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { customerId, amountCents, currency } = parsed.value;
  const requestHash = hashRequest(parsed.value);

  // Step 1: claim the key BEFORE moving money. The unique constraint makes
  // concurrent/retried requests with the same key collapse to one provider call.
  try {
    await db.charges.insert({
      idempotency_key: key,
      request_hash: requestHash,
      customer_id: customerId,
      amount_cents: amountCents,
      currency,
      status: "pending",
    });
  } catch (e: any) {
    if (e?.code === "UNIQUE_VIOLATION") {
      const existing = await db.charges.findByIdempotencyKey(key);
      if (existing && existing.request_hash !== requestHash)
        return res.status(422).json({ error: "Idempotency-Key reused with different payload" });
      return replay(res, existing);
    }
    logger.error({ err: e, key }, "charge claim failed");
    return res.status(503).json({ error: "temporarily unavailable" });
  }

  // Step 2: call the provider exactly once. NEVER retry: it does not dedupe.
  let chargeId: string;
  try {
    const result = await withTimeout(
      paymentProvider.charge({ customerId, amountCents, currency }),
      PROVIDER_TIMEOUT_MS,
    );
    chargeId = result.chargeId;
  } catch (e: any) {
    if (e instanceof ProviderTimeoutError || !e?.isDeclineOrValidation) {
      // Ambiguous: the charge may have succeeded. Mark unknown for reconciliation.
      await db.charges.update(key, { status: "unknown" }).catch((ue: unknown) =>
        logger.error({ err: ue, key }, "failed to mark charge unknown"));
      logger.error({ err: e, key, customerId, amountCents }, "ALERT charge outcome unknown");
      return res.status(202).json({ error: "outcome pending reconciliation" });
    }
    await db.charges.update(key, { status: "failed" }).catch(() => {});
    return res.status(402).json({ error: "charge declined" });
  }

  // Step 3: record success. Money has moved, so retry the write and alert loudly.
  try {
    await retry(() => db.charges.update(key, { status: "succeeded", charge_id: chargeId }), 3, 100);
  } catch (e) {
    logger.error({ err: e, key, chargeId, customerId, amountCents },
      "ALERT charge succeeded at provider but DB persist failed");
    // Still return success: customer was charged; reconcile from logs/provider.
    return res.status(201).json({ chargeId });
  }

  // Step 4: receipt is best-effort and must not affect the charge response.
  try {
    await withTimeout(mailer.sendReceipt(customerId, chargeId), 5_000);
  } catch (e) {
    logger.warn({ err: e, chargeId }, "receipt send failed; enqueue for retry");
  }

  return res.status(201).json({ chargeId });
}
```

Production concerns I addressed
- Duplicate charges: the provider does not dedupe, so I require an Idempotency-Key and claim it in the DB (unique constraint) before calling the provider. Retries and double-clicks replay the stored result instead of charging again.
- Concurrency: the unique-key insert acts as a lock, so concurrent identical requests produce one provider call. The others get 409 or a replay.
- No retries on the provider call: it is called exactly once.
- Ambiguous outcomes: timeouts and unknown errors are stored as "unknown" and return 202 with an alert, for reconciliation against the provider. They are never blindly retried.
- Payload mismatch: the same key with a different body returns 422.
- Validation: integer cents only, positive, with a ceiling, currency allowlist, bounded customerId length, and a format check on the key.
- Timeouts: the provider (15s) and mailer (5s) calls are bounded so requests do not hang.
- Persistence failure after money moved: the DB update is retried with backoff, then logged with an alert including chargeId. The client still gets success because the customer was charged.
- Receipt failure is isolated: the email is best-effort, logged, and meant to be re-queued. It never fails or re-triggers the charge.
- Observability: structured logs carry the key, chargeId, and customer, with no card data.
- Assumptions: the schema, `UNIQUE_VIOLATION` error code, and extra db methods (`findByIdempotencyKey`, `update`) are assumed. A reconciliation job for "unknown" and "pending" rows, plus auth and rate limiting, would be needed around this.
````
