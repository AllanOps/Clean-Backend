# charges — Sonnet 5.5 — with skill 3

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with skill; the agent read `skills/clean-backend/SKILL.md` (v2.0.1 working copy)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `// app.post('/api/v1/charges', createCharge);` |
| **2. Feature flags** | Absent | Declined: *"feature flag (new endpoint, nothing to roll back from)"*. The SKILL.md skip clause covers only a change with *"no behavioral surface — a pure refactor or a typo"* fix; a new endpoint has behavioral surface, so the decline does not meet the pre-registered skip rule. |
| **3. Circuit breaker** | Present | Around the provider only, not the DB, so criterion (a) holds. But `providerBreaker.fail();` runs on every provider error, card declines included, so a wave of declines opens the breaker on a healthy provider: criterion (b) fails. |
| **4. Deadline on every I/O** | Correct | Lookup, provider, and `db.charges.insert` all bounded. |
| **5. Off the request path** | Present | `void withTimeout(mailer.sendReceipt(customerId, chargeId), MAIL_TIMEOUT_MS, 'mailer')`: detached and caught, but not durable; lost on restart. The run notes it would use a queue if one existed; the spec provides none. |
| **6. Business counters** | Correct | `charge.succeeded`, `charge.failed`, `charge.persist_failed`, `receipt.failed`, `charge.shed_breaker_open`. |
| **7. Tombstone-aware reads** | n/a | Declined as having *"no soft-deleted reads here"*. The only read is the idempotency lookup. |

## Verbatim output

````markdown
```typescript
import type { Request, Response } from 'express';
// Assumed to exist: paymentProvider, db, mailer, log, metrics

const CURRENCIES = new Set(['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy']);
const MAX_AMOUNT_CENTS = 5_000_000;           // hard ceiling, tune per business
const PROVIDER_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 800;
const MAIL_TIMEOUT_MS = 5_000;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// Minimal circuit breaker for the payment provider (per-process).
class Breaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private threshold = 5, private cooldownMs = 30_000) {}
  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) return false; // half-open: let one probe through
    return true;
  }
  ok() { this.failures = 0; }
  fail() {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}
const providerBreaker = new Breaker();

interface ChargeInput { customerId: string; amountCents: number; currency: string }

function parseBody(body: unknown): ChargeInput | null {
  if (typeof body !== 'object' || body === null) return null;
  const { customerId, amountCents, currency } = body as Record<string, unknown>;
  if (typeof customerId !== 'string' || !/^[\w-]{1,64}$/.test(customerId)) return null;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents)) return null;
  if (amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) return null;
  if (typeof currency !== 'string' || !CURRENCIES.has(currency.toLowerCase())) return null;
  return { customerId, amountCents, currency: currency.toLowerCase() };
}

// Receipt is off the request path. Ideally this is a durable queue job
// (queue.enqueue('receipt.send', ...)); here it is a detached, bounded, fully-caught call.
function sendReceiptAsync(customerId: string, chargeId: string): void {
  void withTimeout(mailer.sendReceipt(customerId, chargeId), MAIL_TIMEOUT_MS, 'mailer')
    .catch((err) => {
      log.error('receipt.failed', { customerId, chargeId, err: String(err) });
      metrics.increment('receipt.failed');
    });
}

export async function createCharge(req: Request, res: Response): Promise<void> {
  const started = Date.now();

  const input = parseBody(req.body);
  if (!input) {
    metrics.increment('charge.rejected_invalid');
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.length > 128) {
    res.status(400).json({ error: 'idempotency_key_required' });
    return;
  }

  try {
    // Replay: same key returns the original result and never charges twice.
    // Intentionally NOT filtered for tombstones: a spent key stays spent.
    const existing = await withTimeout(
      db.charges.findByIdempotencyKey(idempotencyKey), DB_TIMEOUT_MS, 'db.find');
    if (existing) {
      res.status(200).json({ chargeId: existing.chargeId, replayed: true });
      return;
    }

    if (providerBreaker.isOpen()) {
      metrics.increment('charge.shed_breaker_open');
      res.status(503).set('Retry-After', '30').json({ error: 'payments_unavailable' });
      return;
    }

    let chargeId: string;
    try {
      ({ chargeId } = await withTimeout(
        // idempotencyKey forwarded so the provider also dedupes if we time out and the client retries
        paymentProvider.charge({ ...input, idempotencyKey } as any),
        PROVIDER_TIMEOUT_MS, 'provider.charge'));
      providerBreaker.ok();
    } catch (err) {
      providerBreaker.fail();
      metrics.increment('charge.failed');
      log.error('charge.failed', { customerId: input.customerId, idempotencyKey, err: String(err) });
      // Timeout means outcome unknown: tell the client to retry with the SAME key.
      const unknown = err instanceof TimeoutError;
      res.status(unknown ? 504 : 502).json({ error: unknown ? 'charge_outcome_unknown' : 'charge_failed' });
      return;
    }

    try {
      await withTimeout(db.charges.insert({
        chargeId, idempotencyKey, ...input, createdAt: new Date(),
      }), DB_TIMEOUT_MS, 'db.insert');
    } catch (err) {
      // Money moved but we have no record: highest-severity path.
      metrics.increment('charge.persist_failed');
      log.error('charge.persist_failed', { chargeId, ...input, idempotencyKey, err: String(err) });
      res.status(202).json({ chargeId, status: 'charged_pending_record' });
      return;
    }

    metrics.increment('charge.succeeded');
    metrics.timing('charge.latency_ms', Date.now() - started);
    res.status(201).json({ chargeId });
    sendReceiptAsync(input.customerId, chargeId);
  } catch (err) {
    metrics.increment('charge.error');
    log.error('charge.error', { err: String(err) });
    res.status(500).json({ error: 'internal_error' });
  }
}

// app.post('/api/v1/charges', createCharge);
```

**Production concerns I addressed**
- Versioned route (`/api/v1/charges`) so the first breaking change is not a client migration.
- Boundary validation: safe integer, positive, capped amount, currency allowlist, customerId shape.
- Idempotency: required `Idempotency-Key`, replay lookup before charging, key forwarded to the provider; the lookup deliberately does not hide tombstoned rows.
- Deadlines on every I/O: provider (8s), DB reads and writes (800ms), mailer (5s).
- Circuit breaker around the payment provider; fails fast with 503 and `Retry-After` instead of piling retries on a sick dependency.
- Timeout on charge returns 504 "outcome unknown" (retry with the same key) rather than a false failure; no blind internal retries on money.
- Charged-but-not-persisted path: 202 with chargeId, critical log, dedicated counter.
- Receipt email moved off the request path, bounded and fully caught (a durable queue job is the better home).
- Counters, not just logs: `charge.succeeded`, `charge.failed`, `charge.persist_failed`, `receipt.failed`, `charge.shed_breaker_open`, plus latency, for alerting on charges per minute.
- Skipped on purpose: feature flag (new endpoint, nothing to roll back from) and tombstone filters (no soft-deleted reads here).
````
