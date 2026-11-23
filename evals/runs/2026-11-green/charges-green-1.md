# charges — Sonnet 5.5 — with skill 1

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with skill; the agent read `skills/clean-backend/SKILL.md` (v2.0.1 working copy)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.post("/api/v1/charges", async (req: Request, res: Response) => {` |
| **2. Feature flags** | Absent | Declined: *"Intentionally skipped: feature flag (new endpoint, no old path to fall back to)"*. The SKILL.md skip clause covers only a change with *"no behavioral surface — a pure refactor or a typo"* fix; a new endpoint has behavioral surface, so the decline does not meet the pre-registered skip rule. |
| **3. Circuit breaker** | Present | Around the provider only, not the DB, so criterion (a) holds. But `providerBreaker.failure();` runs on every provider error, card declines included, so a wave of declines opens the breaker on a healthy provider: criterion (b) fails. |
| **4. Deadline on every I/O** | Correct | Idempotency lookup, provider charge, and `db.charges.insert` each wrapped in `withTimeout`. |
| **5. Off the request path** | Present | `void withTimeout(mailer.sendReceipt(customerId, chargeId), MAIL_TIMEOUT_MS, "mailer.sendReceipt")`: detached and caught, but not durable; lost on restart. The run notes it would use a queue if one existed; the spec provides none. |
| **6. Business counters** | Correct | `charge.succeeded`, `charge.failed`, `charge.persist_failed`, `charge.replayed`, `receipt.failed`. |
| **7. Tombstone-aware reads** | Correct | The idempotency lookup *"Deliberately does NOT filter deleted_at"*, which is the rubric's Correct case. |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from "express";
// Assumed to exist and be imported: paymentProvider, db, mailer, log, metrics

const MAX_AMOUNT_CENTS = 10_000_000; // $100k sanity ceiling
const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);
const PROVIDER_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 800;
const MAIL_TIMEOUT_MS = 5_000;

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Minimal in-process circuit breaker for the payment provider only.
// Not used around our own DB: a breaker there turns slow queries into outages.
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private threshold = 5, private cooldownMs = 15_000) {}
  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      this.failures = this.threshold - 1; // half-open: allow one probe
      return false;
    }
    return true;
  }
  success() { this.failures = 0; }
  failure() {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}
const providerBreaker = new CircuitBreaker();

interface ChargeInput { customerId: string; amountCents: number; currency: string }

function validate(body: unknown): { ok: true; value: ChargeInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const { customerId, amountCents, currency } = body as Record<string, unknown>;
  if (typeof customerId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(customerId))
    return { ok: false, error: "invalid customerId" };
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS)
    return { ok: false, error: "amountCents must be a positive integer within limits" };
  if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency.toLowerCase()))
    return { ok: false, error: "unsupported currency" };
  return { ok: true, value: { customerId, amountCents, currency: currency.toLowerCase() } };
}

// Receipt is off the request path: the caller is not awaiting it.
// Replace with queue.enqueue("receipt.send", ...) when a durable queue is available;
// until then this is best-effort with a deadline, and failures are counted and logged.
function sendReceiptAsync(customerId: string, chargeId: string): void {
  void withTimeout(mailer.sendReceipt(customerId, chargeId), MAIL_TIMEOUT_MS, "mailer.sendReceipt")
    .then(() => metrics.increment("receipt.sent"))
    .catch((err) => {
      log.error("receipt.failed", { chargeId, customerId, err: String(err) });
      metrics.increment("receipt.failed");
    });
}

export function registerChargeRoutes(router: Router) {
  // Versioned from day one.
  router.post("/api/v1/charges", async (req: Request, res: Response) => {
    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return res.status(400).json({ error: "Idempotency-Key header required (max 128 chars)" });
    }

    const parsed = validate(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { customerId, amountCents, currency } = parsed.value;

    try {
      // Idempotency lookup. Deliberately does NOT filter deleted_at: a tombstoned
      // row still proves the key was spent, and hiding it would allow a double charge.
      const existing = await withTimeout(
        db.charges.findByIdempotencyKey(idempotencyKey),
        DB_TIMEOUT_MS,
        "db.charges.findByIdempotencyKey",
      );
      if (existing) {
        if (existing.customerId !== customerId || existing.amountCents !== amountCents || existing.currency !== currency) {
          return res.status(422).json({ error: "Idempotency-Key reused with different parameters" });
        }
        metrics.increment("charge.replayed");
        return res.status(200).json({ chargeId: existing.chargeId, replayed: true });
      }

      if (providerBreaker.isOpen()) {
        metrics.increment("charge.shed_breaker_open");
        res.setHeader("Retry-After", "15");
        return res.status(503).json({ error: "payment provider temporarily unavailable" });
      }

      let chargeId: string;
      try {
        // Pass the idempotency key through so a provider-side retry or our own
        // timeout cannot produce a second real charge.
        ({ chargeId } = await withTimeout(
          paymentProvider.charge({ customerId, amountCents, currency, idempotencyKey }),
          PROVIDER_TIMEOUT_MS,
          "paymentProvider.charge",
        ));
        providerBreaker.success();
      } catch (err) {
        providerBreaker.failure();
        metrics.increment("charge.failed");
        log.error("charge.failed", { customerId, amountCents, currency, idempotencyKey, err: String(err) });
        // A timeout is ambiguous: the charge may have succeeded. Tell the client to
        // retry with the SAME key rather than treating it as a definite failure.
        if (err instanceof TimeoutError) {
          return res.status(504).json({ error: "payment outcome unknown, retry with the same Idempotency-Key" });
        }
        return res.status(502).json({ error: "payment failed" });
      }

      try {
        await withTimeout(
          db.charges.insert({ chargeId, customerId, amountCents, currency, idempotencyKey, createdAt: new Date() }),
          DB_TIMEOUT_MS,
          "db.charges.insert",
        );
      } catch (err) {
        // Money moved but we failed to record it. Highest-severity signal: page on it.
        metrics.increment("charge.persist_failed");
        log.error("charge.persist_failed", { chargeId, customerId, amountCents, currency, idempotencyKey, err: String(err) });
        // Retry with the same key will hit the provider's idempotency and return the same chargeId.
        return res.status(500).json({ error: "charge processed but not recorded, retry with the same Idempotency-Key" });
      }

      metrics.increment("charge.succeeded");
      sendReceiptAsync(customerId, chargeId);
      return res.status(201).json({ chargeId });
    } catch (err) {
      metrics.increment("charge.error");
      log.error("charge.unexpected", { idempotencyKey, err: String(err) });
      return res.status(500).json({ error: "internal error" });
    }
  });
}
```

**Production concerns I addressed**

- Boundary validation: strict types, safe positive integer cents, max amount, currency allowlist, customerId format; no float money.
- Idempotency: required `Idempotency-Key`, replay returns the original charge, parameter mismatch returns 422, key is forwarded to the provider.
- Idempotency lookup ignores soft-delete tombstones, so a deleted row cannot allow a double charge.
- Deadlines on every I/O: provider (8s), database reads and writes (800ms), mailer (5s).
- Ambiguous timeouts: a provider timeout returns 504 telling the client to retry with the same key, not a definite failure.
- Money moved but insert failed: distinct `charge.persist_failed` counter and error log with full context for reconciliation.
- Circuit breaker around the payment provider only (not our DB), failing fast with 503 and Retry-After.
- Receipt email taken off the request path (best-effort background send with timeout; swap for a durable queue enqueue when available), so mailer failure or slowness never fails or slows a successful charge.
- Metrics counters alongside logs (`charge.succeeded`, `charge.failed`, `charge.persist_failed`, `receipt.failed`, etc.) so alerts can fire on rates, not just forensics.
- Versioned route `/api/v1/charges`.
- Intentionally skipped: feature flag (new endpoint, no old path to fall back to). Not shown: auth/authorization that the caller owns `customerId`, rate limiting, and a unique index on `idempotency_key` (required to close the concurrent-request race between lookup and insert).
````
