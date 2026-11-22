# charges-no-dedupe — Sonnet 5.5 — baseline 2

- **Scenario:** [`../../scenarios/charges-no-dedupe.md`](../../scenarios/charges-no-dedupe.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| ***Idempotency* (decides this scenario)** | **Correct** | Unique-key `db.charges.insert` with `status: "pending" as ChargeStatus` before the provider; non-unique errors return `503` with *"no charge attempted"*; duplicates replay or return 409/422. |
| **1. Version the route** | Absent | No versioned route; no route registration shown. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None around the provider. |
| **4. Deadline on every I/O** | Present | `withTimeout(paymentProvider.charge(...))`; the idempotency-claim and `db.charges` writes are unbounded. |
| **5. Off the request path** | Present | `mailer.sendReceipt(customerId, chargeId).catch(...)`: fire-and-forget, not durable. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup, which correctly does not filter. |

Idempotency criteria: required, claimed before `paymentProvider.charge()`, completed key replays, store error refuses the request. All four hold.

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
// paymentProvider, db, mailer, logger are assumed to exist and be imported.

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);
const MAX_AMOUNT_CENTS = 10_000_000; // $100k sanity ceiling per charge
const PROVIDER_TIMEOUT_MS = 20_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

type ChargeStatus = "pending" | "succeeded" | "failed" | "unknown";

/*
 * Assumed db.charges contract (needs a UNIQUE index on idempotency_key):
 *   insert(row)                 -> throws UniqueViolationError on duplicate key
 *   findByIdempotencyKey(key)   -> row | null
 *   update(id, patch)           -> void
 * `unknown` means money may or may not have moved; it is NEVER auto-retried and
 * is picked up by a reconciliation job against the provider's dashboard/API.
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
  | { ok: true; customerId: string; amountCents: number; currency: string }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid body" };
  const { customerId, amountCents, currency } = body;
  if (typeof customerId !== "string" || customerId.length === 0 || customerId.length > 128)
    return { ok: false, error: "customerId invalid" };
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS)
    return { ok: false, error: "amountCents must be a positive integer within limits" };
  if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency.toLowerCase()))
    return { ok: false, error: "unsupported currency" };
  return { ok: true, customerId, amountCents, currency: currency.toLowerCase() };
}

function replay(res: Response, row: any) {
  switch (row.status as ChargeStatus) {
    case "succeeded":
      return res.status(200).json({ chargeId: row.chargeId, replayed: true });
    case "failed":
      return res.status(402).json({ error: "charge failed", replayed: true });
    case "pending":
      return res.status(409).json({ error: "charge in progress, retry later" });
    default:
      // unknown: do not re-charge; needs reconciliation
      return res.status(409).json({ error: "charge outcome unconfirmed; do not retry, contact support" });
  }
}

export async function postCharges(req: Request, res: Response) {
  const idemKey = req.header("Idempotency-Key");
  if (!idemKey || !IDEMPOTENCY_KEY_RE.test(idemKey)) {
    return res.status(400).json({ error: "Idempotency-Key header required (16-128 chars)" });
  }

  const v = validate(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { customerId, amountCents, currency } = v;

  // 1. Atomically claim the key BEFORE moving money. The provider does not
  //    dedupe, so this unique-key insert is our only duplicate protection.
  let rowId: string;
  try {
    const row = await db.charges.insert({
      idempotencyKey: idemKey,
      customerId,
      amountCents,
      currency,
      status: "pending" as ChargeStatus,
      createdAt: new Date(),
    });
    rowId = row.id;
  } catch (err: any) {
    if (err?.code === "UNIQUE_VIOLATION" || err?.name === "UniqueViolationError") {
      const existing = await db.charges.findByIdempotencyKey(idemKey);
      if (existing) {
        // Same key with different payload is a client bug; refuse.
        if (
          existing.customerId !== customerId ||
          existing.amountCents !== amountCents ||
          existing.currency !== currency
        ) {
          return res.status(422).json({ error: "Idempotency-Key reused with different parameters" });
        }
        return replay(res, existing);
      }
    }
    logger.error({ err, idemKey }, "failed to claim charge row; no charge attempted");
    return res.status(503).json({ error: "temporarily unavailable" });
  }

  // 2. Call the provider exactly once. NO automatic retries: a retry could double charge.
  let chargeId: string;
  try {
    const result = await withTimeout(
      paymentProvider.charge({ customerId, amountCents, currency }),
      PROVIDER_TIMEOUT_MS,
    );
    chargeId = result.chargeId;
  } catch (err: any) {
    // Timeouts / network errors are ambiguous: money may have moved.
    // Explicit provider declines are definitive.
    const definitiveDecline = err?.type === "card_declined" || err?.declined === true;
    const status: ChargeStatus = definitiveDecline ? "failed" : "unknown";
    await db.charges
      .update(rowId, { status, error: String(err?.message ?? err).slice(0, 500) })
      .catch((e: unknown) => logger.error({ e, rowId }, "failed to record charge failure"));
    if (status === "unknown") {
      logger.error({ rowId, idemKey, customerId, amountCents }, "ALERT: ambiguous charge outcome, reconcile");
      return res.status(502).json({ error: "charge outcome unconfirmed; do not retry blindly" });
    }
    return res.status(402).json({ error: "charge declined" });
  }

  // 3. Persist success. If this fails, money moved: log everything needed to reconcile.
  try {
    await db.charges.update(rowId, { status: "succeeded", chargeId, completedAt: new Date() });
  } catch (err) {
    logger.error(
      { err, rowId, chargeId, idemKey, customerId, amountCents, currency },
      "CRITICAL: charge succeeded at provider but DB update failed",
    );
    // Still tell the client it succeeded; retrying must not re-charge (row stays pending -> 409).
    return res.status(200).json({ chargeId, warning: "recorded with delay" });
  }

  // 4. Receipt is best-effort and must never fail or re-run the charge.
  mailer.sendReceipt(customerId, chargeId).catch((err: unknown) => {
    logger.warn({ err, chargeId }, "receipt email failed; enqueue for retry");
  });

  return res.status(201).json({ chargeId });
}
```

Production concerns I addressed
- Double-charge protection: the provider has no idempotency key, so I require a client Idempotency-Key and claim it with a unique-key DB insert (status pending) before calling the provider; replays return the stored result.
- Payload mismatch on a reused key returns 422; an in-flight duplicate returns 409.
- No automatic retries of paymentProvider.charge(), since every call moves money.
- Ambiguous outcomes (timeout or network error) are recorded as `unknown`, alerted on, never retried, and left for reconciliation against the provider; only explicit declines are marked `failed`.
- Explicit 20s timeout on the provider call.
- Input validation: integer cents, positive, max ceiling, currency allowlist, bounded customerId, malformed key rejected.
- Provider-success-but-DB-write-failure is handled: critical log with all reconciliation fields, the row stays pending so retries cannot re-charge, and the client still gets the chargeId.
- The receipt email is fire-and-forget with failure logging, so an email outage cannot fail or duplicate a charge (a real system should use an outbox or queue).
- Error responses do not leak provider internals; stored error text is truncated.
- Assumptions to confirm: a unique index on idempotency_key, the `findByIdempotencyKey` and `update` db methods, and a reconciliation job for `unknown` and stale `pending` rows.
````
