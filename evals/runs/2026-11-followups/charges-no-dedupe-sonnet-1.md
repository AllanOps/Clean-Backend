# charges-no-dedupe — Sonnet 5.5 — baseline 1

- **Scenario:** [`../../scenarios/charges-no-dedupe.md`](../../scenarios/charges-no-dedupe.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| ***Idempotency* (decides this scenario)** | **Correct** | `claim = await db.chargeAttempts.claim({ key, requestHash, customerId: input.customerId })` before `paymentProvider.charge`; a claim error returns `503` with *"nothing charged"*; completed keys replay (`replayed: true`); in-flight returns 409. |
| **1. Version the route** | Absent | No versioned route; no route registration shown. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None around the provider. |
| **4. Deadline on every I/O** | Present | `withTimeout(paymentProvider.charge(...))`; the idempotency-claim and `db.charges` writes are unbounded. |
| **5. Off the request path** | Absent | `await mailer.sendReceipt(input.customerId, chargeId);` inline. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup, which correctly does not filter. |

Idempotency criteria: required, claimed before `paymentProvider.charge()`, completed key replays, store error refuses the request. All four hold.

## Verbatim output

````markdown
```typescript
import { createHash } from "node:crypto";
import type { Request, Response } from "express";

// Assumed to exist and be imported: paymentProvider, db, mailer, logger.
// Assumed db surface beyond db.charges.insert (needs a migration):
//   db.chargeAttempts.claim({ key, requestHash, customerId }) -> { created: boolean, record }
//     backed by a UNIQUE index on `key`; atomic insert-if-absent, status 'pending'.
//   db.chargeAttempts.update(key, patch)
// Statuses: pending | succeeded | declined | unknown

const ALLOWED_CURRENCIES = new Set(["USD", "EUR", "GBP", "CAD", "AUD"]);
const MAX_AMOUNT_CENTS = 10_000_000; // $100k sanity ceiling; tune per business
const PROVIDER_TIMEOUT_MS = 20_000;
const KEY_RE = /^[A-Za-z0-9_\-:.]{16,128}$/;

class ProviderTimeoutError extends Error {}

type ChargeInput = { customerId: string; amountCents: number; currency: string };

function validate(body: unknown): { ok: true; value: ChargeInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || customerId.length === 0 || customerId.length > 128)
    return { ok: false, error: "customerId must be a non-empty string" };
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0)
    return { ok: false, error: "amountCents must be a positive integer" };
  if (amountCents > MAX_AMOUNT_CENTS) return { ok: false, error: "amountCents exceeds maximum" };
  if (typeof currency !== "string") return { ok: false, error: "currency must be a string" };
  const cur = currency.toUpperCase();
  if (!ALLOWED_CURRENCIES.has(cur)) return { ok: false, error: "unsupported currency" };

  return { ok: true, value: { customerId, amountCents, currency: cur } };
}

function hashRequest(input: ChargeInput): string {
  return createHash("sha256")
    .update(`${input.customerId}|${input.amountCents}|${input.currency}`)
    .digest("hex");
}

// Provider has no cancellation: on timeout we stop waiting but the charge MAY have happened.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError("provider timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Only treat as "definitely no money moved" when the provider clearly says so.
// Adapt to the real client's error shape. Anything else is ambiguous.
function isDefiniteDecline(err: unknown): boolean {
  const e = err as { type?: string; status?: number } | null;
  return e?.type === "card_declined" || e?.type === "invalid_request" || (e?.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);
}

export async function postCharges(req: Request, res: Response): Promise<void> {
  // 1. Idempotency key is mandatory: the provider will not protect us from double charges.
  const key = req.header("Idempotency-Key");
  if (!key || !KEY_RE.test(key)) {
    res.status(400).json({ error: "Idempotency-Key header required (16-128 chars)" });
    return;
  }

  // 2. Validate input.
  const parsed = validate(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const input = parsed.value;
  const requestHash = hashRequest(input);

  // 3. Claim the key BEFORE touching the provider. Unique index makes this race-safe,
  //    so two concurrent identical requests can never both reach paymentProvider.charge().
  let claim;
  try {
    claim = await db.chargeAttempts.claim({ key, requestHash, customerId: input.customerId });
  } catch (err) {
    logger.error({ err, key }, "charge claim failed");
    res.status(503).json({ error: "temporarily unavailable" }); // nothing charged
    return;
  }

  if (!claim.created) {
    const rec = claim.record;
    if (rec.requestHash !== requestHash) {
      res.status(422).json({ error: "Idempotency-Key reused with a different request" });
      return;
    }
    switch (rec.status) {
      case "succeeded":
        res.status(200).json({ chargeId: rec.chargeId, replayed: true });
        return;
      case "declined":
        res.status(402).json({ error: "charge declined", replayed: true });
        return;
      case "pending":
        res.status(409).json({ error: "request already in progress" });
        return;
      default: // unknown outcome: never auto-retry, needs reconciliation
        res.status(409).json({ error: "previous attempt outcome unknown; under review" });
        return;
    }
  }

  // 4. Single provider call. NO retries: each call moves money.
  let chargeId: string;
  try {
    const result = await withTimeout(paymentProvider.charge(input), PROVIDER_TIMEOUT_MS);
    chargeId = result.chargeId;
  } catch (err) {
    if (isDefiniteDecline(err)) {
      await db.chargeAttempts.update(key, { status: "declined" }).catch((e: unknown) =>
        logger.error({ e, key }, "failed to record decline"));
      res.status(402).json({ error: "charge declined" });
      return;
    }
    // Timeout / network / 5xx: money may or may not have moved.
    await db.chargeAttempts.update(key, { status: "unknown" }).catch((e: unknown) =>
      logger.error({ e, key }, "failed to record unknown outcome"));
    logger.error({ err, key, customerId: input.customerId, amountCents: input.amountCents },
      "ALERT: charge outcome unknown, reconcile with provider");
    res.status(502).json({ error: "payment outcome unknown; do not retry with a new key" });
    return;
  }

  // 5. Money has moved. Record immediately on the attempt row (the durable source of truth),
  //    then insert the charge. Failures here must NOT turn into a 5xx that invites a retry.
  await db.chargeAttempts.update(key, { status: "succeeded", chargeId }).catch((err: unknown) =>
    logger.error({ err, key, chargeId }, "ALERT: charged but failed to update attempt"));

  try {
    await db.charges.insert({
      chargeId,
      customerId: input.customerId,
      amountCents: input.amountCents,
      currency: input.currency,
      idempotencyKey: key,
      createdAt: new Date(),
    });
  } catch (err) {
    logger.error({ err, key, chargeId, ...input },
      "ALERT: charged but failed to persist charge; needs backfill");
  }

  // 6. Receipt is best effort: a mail failure must not fail or replay a completed charge.
  try {
    await mailer.sendReceipt(input.customerId, chargeId);
  } catch (err) {
    logger.warn({ err, chargeId }, "receipt send failed; enqueue for retry");
  }

  res.status(201).json({ chargeId });
}
```

Production concerns I addressed
- Double charging: provider has no idempotency, so I require an Idempotency-Key header and atomically claim it in a unique-indexed attempts table before calling the provider. Concurrent or retried duplicates never reach `charge()`.
- Same key with a different payload is rejected (422) via request hash.
- Replays return the stored result (succeeded/declined); in-flight returns 409.
- No automatic retries on the provider call, since each call moves money.
- Ambiguous outcomes (timeout, network, 5xx) are recorded as `unknown`, return 502, alert, and block re-execution until reconciled against the provider. Only clear declines are treated as "no money moved".
- Timeout wrapper so requests don't hang; documented that it can't cancel the provider call.
- Strict validation: positive safe-integer cents, max ceiling, currency allowlist/normalisation, string length bounds.
- Post-charge failures (DB insert, attempt update) never return an error that invites a retry; they are logged as alerts for backfill, with the attempt row as durable record.
- Receipt email is best effort and cannot fail a completed charge (should be moved to a queue with retries).
- Structured logging without card data; key/chargeId included for reconciliation.
- Assumptions to implement: `chargeAttempts` table with unique key, a reconciliation job for `unknown`/orphaned `pending` rows, auth on the route, and rate limiting.
````
