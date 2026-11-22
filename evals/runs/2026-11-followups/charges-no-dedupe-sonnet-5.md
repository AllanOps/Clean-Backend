# charges-no-dedupe — Sonnet 5.5 — baseline 5

- **Scenario:** [`../../scenarios/charges-no-dedupe.md`](../../scenarios/charges-no-dedupe.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| ***Idempotency* (decides this scenario)** | **Correct** | `db.chargeAttempts.claim` with `status: "in_progress"` before the provider, unwrapped, so a store error throws before any charge; completed keys replay; in-progress and unknown return 409. |
| **1. Version the route** | Absent | No versioned route; no route registration shown. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None around the provider. |
| **4. Deadline on every I/O** | Present | `withTimeout(paymentProvider.charge(...))`; the idempotency-claim and `db.charges` writes are unbounded. |
| **5. Off the request path** | Absent | `await mailer.sendReceipt(input.customerId, chargeId);` inline. |
| **6. Business counters** | Correct | `charges.succeeded`, `charges.declined`, `charges.unknown`, `charges.persist_failed`, `receipts.failed`. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup, which correctly does not filter. |

Idempotency criteria: required, claimed before `paymentProvider.charge()`, completed key replays, store error refuses the request. All four hold.

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
import { createHash } from "node:crypto";

// Assumed to exist and be imported: paymentProvider, db, mailer, logger, metrics.
//
// Assumed extra persistence (needed because the provider does NOT dedupe):
//   db.chargeAttempts.claim({ key, fingerprint, customerId, ... })
//       -> { claimed: true } | { claimed: false, existing: ChargeAttempt }
//      Backed by a UNIQUE index on `key`. Atomic insert-if-absent.
//   db.chargeAttempts.update(key, patch)
//   ChargeAttempt.status: "in_progress" | "succeeded" | "unknown" | "failed"

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);
const MAX_AMOUNT_CENTS = 5_000_000; // $50k sanity ceiling; tune per business
const PROVIDER_TIMEOUT_MS = 15_000;
const KEY_RE = /^[A-Za-z0-9_\-:.]{16,128}$/;

class ProviderTimeoutError extends Error {}

interface ChargeInput {
  customerId: string;
  amountCents: number;
  currency: string;
}

function parseBody(body: unknown): { ok: true; value: ChargeInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || customerId.length === 0 || customerId.length > 128) {
    return { ok: false, error: "customerId must be a non-empty string (max 128 chars)" };
  }
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  if (amountCents > MAX_AMOUNT_CENTS) {
    return { ok: false, error: "amountCents exceeds the maximum allowed" };
  }
  if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency.toLowerCase())) {
    return { ok: false, error: "unsupported currency" };
  }
  return { ok: true, value: { customerId, amountCents, currency: currency.toLowerCase() } };
}

function fingerprint(i: ChargeInput): string {
  return createHash("sha256").update(`${i.customerId}|${i.amountCents}|${i.currency}`).digest("hex");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new ProviderTimeoutError("provider timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Persist a charge that already moved money. Retries the DB write a few times
// because losing this record means an untracked charge.
async function persistChargeWithRetry(row: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await db.charges.insert(row);
      return true;
    } catch (err) {
      logger.error({ err, attempt, chargeId: row.chargeId }, "charge persist failed");
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
  return false;
}

export async function postCharges(req: Request, res: Response): Promise<void> {
  // 1. Idempotency key is mandatory: the provider cannot protect us from
  //    client retries, double-clicks, or load balancer replays.
  const key = req.header("Idempotency-Key");
  if (!key || !KEY_RE.test(key)) {
    res.status(400).json({ error: "Idempotency-Key header required (16-128 chars)" });
    return;
  }

  const parsed = parseBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const input = parsed.value;
  const fp = fingerprint(input);

  // 2. Claim the key BEFORE touching the provider. Unique constraint makes
  //    concurrent duplicates lose the race instead of double-charging.
  const claim = await db.chargeAttempts.claim({
    key,
    fingerprint: fp,
    customerId: input.customerId,
    amountCents: input.amountCents,
    currency: input.currency,
    status: "in_progress",
  });

  if (!claim.claimed) {
    const ex = claim.existing;
    if (ex.fingerprint !== fp) {
      res.status(422).json({ error: "Idempotency-Key reused with different parameters" });
      return;
    }
    if (ex.status === "succeeded") {
      res.status(200).json({ chargeId: ex.chargeId, replayed: true });
      return;
    }
    if (ex.status === "failed") {
      res.status(402).json({ error: "charge previously declined", replayed: true });
      return;
    }
    // in_progress or unknown: never re-call the provider automatically.
    res.status(409).json({ error: "charge outcome pending; do not retry with a new key", status: ex.status });
    return;
  }

  // 3. Call the provider exactly once. No automatic retries.
  let chargeId: string;
  try {
    const result = await withTimeout(paymentProvider.charge(input), PROVIDER_TIMEOUT_MS);
    chargeId = result.chargeId;
  } catch (err) {
    if (err instanceof ProviderTimeoutError) {
      // Money may or may not have moved. Leave the key as "unknown" for
      // reconciliation against the provider; do NOT free it for retry.
      await db.chargeAttempts.update(key, { status: "unknown" }).catch((e: unknown) =>
        logger.error({ e, key }, "failed to mark attempt unknown"));
      logger.error({ key, customerId: input.customerId }, "provider timeout, outcome unknown");
      metrics.increment("charges.unknown");
      res.status(202).json({ error: "charge outcome unknown, being reconciled", status: "unknown" });
      return;
    }
    // Any other thrown error is also ambiguous unless the provider client
    // exposes a definitive decline. Treat declines as failed, rest as unknown.
    const declined = (err as { code?: string }).code === "card_declined";
    await db.chargeAttempts
      .update(key, { status: declined ? "failed" : "unknown" })
      .catch((e: unknown) => logger.error({ e, key }, "failed to update attempt"));
    logger.error({ err, key }, "provider charge error");
    metrics.increment(declined ? "charges.declined" : "charges.unknown");
    if (declined) res.status(402).json({ error: "payment declined" });
    else res.status(502).json({ error: "payment provider error, outcome unverified", status: "unknown" });
    return;
  }

  // 4. Money has moved. Record the chargeId on the attempt first (cheap,
  //    keyed write) so a crash after this point is recoverable.
  await db.chargeAttempts
    .update(key, { status: "succeeded", chargeId })
    .catch((e: unknown) => logger.error({ e, key, chargeId }, "failed to record chargeId on attempt"));

  const persisted = await persistChargeWithRetry({
    chargeId,
    customerId: input.customerId,
    amountCents: input.amountCents,
    currency: input.currency,
    idempotencyKey: key,
    createdAt: new Date(),
  });
  if (!persisted) {
    // Customer was charged; do not return an error that invites a retry.
    logger.fatal({ chargeId, key, customerId: input.customerId }, "CHARGED BUT NOT PERSISTED - reconcile");
    metrics.increment("charges.persist_failed");
  }

  // 5. Receipt is best-effort and must never fail or re-trigger the charge.
  try {
    await mailer.sendReceipt(input.customerId, chargeId);
  } catch (err) {
    logger.warn({ err, chargeId }, "receipt email failed; queue for retry");
    metrics.increment("receipts.failed");
  }

  metrics.increment("charges.succeeded");
  res.status(201).json({ chargeId });
}
```

Production concerns I addressed
- Double-charge prevention: provider has no idempotency, so a required `Idempotency-Key` is claimed in a unique-indexed `chargeAttempts` table before calling the provider. Concurrent or replayed requests lose the claim and get the stored result or a 409.
- Key reuse with different payload is rejected (422) via a request fingerprint.
- Provider is called exactly once: no automatic retries, since each call moves money.
- Ambiguous outcomes (timeout, unknown error) are recorded as `unknown`, return 202/502, and keep the key locked so nothing re-charges; a reconciliation job must resolve them against the provider.
- Declines are distinguished from unknowns and only declines are marked `failed`.
- Timeout on the provider call so requests do not hang on the connection pool.
- Strict input validation: integer cents, positive, safe-integer, upper cap, currency allowlist, string length limits.
- Charged-but-unrecorded case: chargeId is written to the attempt record first, DB insert is retried with backoff, and a failure is logged at fatal level with a metric, while still returning success to avoid a customer retry.
- Receipt email failure is isolated and cannot fail the request or cause a re-charge.
- Observability: structured logs with key/chargeId (no card data), metrics for succeeded, declined, unknown, persist_failed, and receipt failures to alert on.
- Assumptions to confirm: the `chargeAttempts` table and `logger`/`metrics` exist; auth (that the caller may charge this `customerId`) and rate limiting are handled by upstream middleware.
````
