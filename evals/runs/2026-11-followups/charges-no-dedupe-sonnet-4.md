# charges-no-dedupe — Sonnet 5.5 — baseline 4

- **Scenario:** [`../../scenarios/charges-no-dedupe.md`](../../scenarios/charges-no-dedupe.md), baseline prompt used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** baseline, no skill loaded
- **Record kind:** verbatim
- **Isolation:** the agent was permitted exactly one tool call (a Write of its answer to a scratch directory). Its transcript shows no Read, Glob, Grep, Bash, or Skill call.

## Scorecard

| Practice | Score | Deciding line |
| --- | --- | --- |
| ***Idempotency* (decides this scenario)** | **Correct** | Unique insert with `status: "pending"` before the provider; `if (err?.code !== "UNIQUE_VIOLATION")` returns `503`; replays the stored outcome; a stale pending row is marked `unknown` rather than re-charged. |
| **1. Version the route** | Absent | No versioned route; no route registration shown. |
| **2. Feature flags** | Absent | None. |
| **3. Circuit breaker** | Absent | None around the provider. |
| **4. Deadline on every I/O** | Present | `withTimeout(paymentProvider.charge(...))`; the idempotency-claim and `db.charges` writes are unbounded. |
| **5. Off the request path** | Present | `mailer.sendReceipt(customerId, providerChargeId).catch(...)`: fire-and-forget, not durable. |
| **6. Business counters** | Absent | Logs only. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup, which correctly does not filter. |

Idempotency criteria: required, claimed before `paymentProvider.charge()`, completed key replays, store error refuses the request. All four hold.

## Verbatim output

````markdown
```typescript
import type { Request, Response } from "express";
import { createHash } from "node:crypto";

// Assumed to already exist and be imported: paymentProvider, db, mailer, logger.
// Assumed db.charges additions (needed because the provider does NOT dedupe, so we must):
//   - unique index on charges.idempotencyKey
//   - insert() throws an error with code "UNIQUE_VIOLATION" on a duplicate key
//   - findByIdempotencyKey(key), update(id, patch)

type ChargeStatus = "pending" | "succeeded" | "unknown" | "failed";

interface ChargeRow {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  customerId: string;
  amountCents: number;
  currency: string;
  status: ChargeStatus;
  providerChargeId?: string;
  createdAt: Date;
}

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);
const MAX_AMOUNT_CENTS = 1_000_000_00; // sanity ceiling: 1,000,000.00
const PROVIDER_TIMEOUT_MS = 15_000;
const STALE_PENDING_MS = 60_000;

class ProviderTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError("provider timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function validate(body: unknown):
  | { ok: true; value: { customerId: string; amountCents: number; currency: string } }
  | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const { customerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof customerId !== "string" || customerId.length === 0 || customerId.length > 128) {
    return { ok: false, error: "customerId must be a non-empty string" };
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    return { ok: false, error: "amountCents must be a positive integer within limits" };
  }
  if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency.toLowerCase())) {
    return { ok: false, error: "unsupported currency" };
  }
  return { ok: true, value: { customerId, amountCents, currency: currency.toLowerCase() } };
}

function hashRequest(v: { customerId: string; amountCents: number; currency: string }): string {
  return createHash("sha256").update(`${v.customerId}|${v.amountCents}|${v.currency}`).digest("hex");
}

function respondFromRow(res: Response, row: ChargeRow) {
  switch (row.status) {
    case "succeeded":
      return res.status(200).json({ chargeId: row.providerChargeId, status: "succeeded" });
    case "failed":
      return res.status(402).json({ error: "charge was declined", status: "failed" });
    case "unknown":
      // Money may or may not have moved. Never re-charge; reconciliation resolves it.
      return res.status(202).json({ status: "processing", message: "outcome pending reconciliation" });
    case "pending":
    default:
      return res.status(409).json({ error: "request already in progress", status: "pending" });
  }
}

async function persistWithRetry(fn: () => Promise<unknown>, attempts = 4): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (i === attempts - 1) return false;
      await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }
  }
  return false;
}

export async function postCharges(req: Request, res: Response): Promise<void> {
  // 1. Idempotency key is mandatory: the provider will not protect us from double charges.
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    res.status(400).json({ error: "Idempotency-Key header (8-128 chars) is required" });
    return;
  }

  // 2. Validate input.
  const parsed = validate(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { customerId, amountCents, currency } = parsed.value;
  const requestHash = hashRequest(parsed.value);

  // 3. Claim the key BEFORE touching the provider. The unique index makes this atomic,
  //    so concurrent retries/double-clicks cannot both reach paymentProvider.charge().
  let row: ChargeRow;
  try {
    row = (await db.charges.insert({
      idempotencyKey,
      requestHash,
      customerId,
      amountCents,
      currency,
      status: "pending",
      createdAt: new Date(),
    })) as ChargeRow;
  } catch (err: any) {
    if (err?.code !== "UNIQUE_VIOLATION") {
      logger.error({ err, idempotencyKey }, "charge claim insert failed");
      res.status(503).json({ error: "temporarily unavailable, safe to retry" });
      return;
    }
    const existing = (await db.charges.findByIdempotencyKey(idempotencyKey)) as ChargeRow | null;
    if (!existing) {
      res.status(503).json({ error: "temporarily unavailable, safe to retry" });
      return;
    }
    if (existing.requestHash !== requestHash) {
      res.status(422).json({ error: "Idempotency-Key reused with a different request" });
      return;
    }
    // A pending row that is stale means the original worker died mid-flight; the provider
    // outcome is unknown, so flag it for reconciliation rather than charging again.
    if (existing.status === "pending" && Date.now() - existing.createdAt.getTime() > STALE_PENDING_MS) {
      await db.charges.update(existing.id, { status: "unknown" }).catch(() => undefined);
      logger.error({ chargeRowId: existing.id }, "stale pending charge marked unknown for reconciliation");
      existing.status = "unknown";
    }
    respondFromRow(res, existing);
    return;
  }

  // 4. Call the provider exactly once. No automatic retries: every call moves money.
  let providerChargeId: string;
  try {
    const result = await withTimeout(
      paymentProvider.charge({ customerId, amountCents, currency }),
      PROVIDER_TIMEOUT_MS,
    );
    providerChargeId = result.chargeId;
  } catch (err: any) {
    if (err instanceof ProviderTimeoutError || !err?.isDefinitiveDecline) {
      // Ambiguous: the provider may have charged. Do not retry, do not report failure.
      await persistWithRetry(() => db.charges.update(row.id, { status: "unknown" }));
      logger.error({ err, chargeRowId: row.id, idempotencyKey }, "provider outcome unknown, needs reconciliation");
      res.status(202).json({ status: "processing", message: "outcome pending reconciliation" });
      return;
    }
    // Definitive decline (provider told us no money moved).
    await persistWithRetry(() => db.charges.update(row.id, { status: "failed" }));
    res.status(402).json({ error: "charge was declined", status: "failed" });
    return;
  }

  // 5. Money has moved. Record it; if the DB is flaky, retry, and as a last resort log loudly
  //    with the chargeId so it can be reconciled. Never return an error that invites a re-charge.
  const saved = await persistWithRetry(() =>
    db.charges.update(row.id, { status: "succeeded", providerChargeId }),
  );
  if (!saved) {
    logger.fatal(
      { chargeRowId: row.id, providerChargeId, customerId, amountCents, currency },
      "CHARGE SUCCEEDED AT PROVIDER BUT NOT PERSISTED - manual reconciliation required",
    );
  }

  // 6. Receipt is best-effort and must not affect the response.
  mailer.sendReceipt(customerId, providerChargeId).catch((err: unknown) => {
    logger.warn({ err, providerChargeId }, "receipt email failed; enqueue for retry");
  });

  res.status(201).json({ chargeId: providerChargeId, status: "succeeded" });
}
```

Production concerns I addressed
- Double-charge prevention: provider has no idempotency, so a required `Idempotency-Key` header is claimed in our DB (unique index) before the provider is called; retries, double-clicks and concurrent requests cannot reach `charge()` twice.
- Replay semantics: duplicate keys return the stored outcome (200/402/202/409); same key with a different payload returns 422.
- Ambiguous outcomes: timeouts and unclassified errors are recorded as `unknown` and return 202, never retried automatically and never reported as failure; stale `pending` rows are flagged for reconciliation instead of re-charging.
- Provider timeout (15s) so requests do not hang indefinitely.
- Post-charge persistence failure: retried with backoff; last resort is a fatal log with chargeId and amounts for manual reconciliation, and the client still gets success so it does not retry.
- Receipt email is fire-and-forget with failure logging, so a mailer outage cannot fail or duplicate a charge.
- Input validation: types, safe positive integer cents, upper bound, currency allowlist, customerId length.
- Assumptions to confirm: the db additions (unique index, `UNIQUE_VIOLATION`, `findByIdempotencyKey`, `update`), the provider error shape (`isDefinitiveDecline`), and a `logger`. Also still needed outside this handler: a reconciliation job for `unknown`/`pending` rows, authn/authz that the caller may charge this customerId, rate limiting, and a durable retry queue for receipts.
````
