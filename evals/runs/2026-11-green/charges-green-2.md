# charges — Sonnet 5.5 — with skill 2

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with skill; the agent read `skills/clean-backend/SKILL.md` (v2.0.1 working copy)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `// router.post('/api/v1/charges', postCharge);` |
| **2. Feature flags** | Absent | Declined: no flag; the run gives no reason. The SKILL.md skip clause covers only a change with *"no behavioral surface — a pure refactor or a typo"* fix; a new endpoint has behavioral surface, so the decline does not meet the pre-registered skip rule. |
| **3. Circuit breaker** | Present | Around the provider only, not the DB, so criterion (a) holds. But `providerBreaker.failure();` runs on every provider error, card declines included, so a wave of declines opens the breaker on a healthy provider: criterion (b) fails. |
| **4. Deadline on every I/O** | Correct | Lookup, provider, and insert all wrapped in `withTimeout`. |
| **5. Off the request path** | Present | `void withTimeout(mailer.sendReceipt(customerId, chargeId), MAIL_TIMEOUT_MS, 'mailer.sendReceipt')`: detached and caught, but not durable; lost on restart. The run notes it would use a queue if one existed; the spec provides none. |
| **6. Business counters** | Correct | `charge.succeeded`, `charge.failed` tagged by stage, `charge.persist_failed`, `charge.receipt_failed`. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup, unfiltered. |

## Verbatim output

````markdown
```typescript
import type { Request, Response } from 'express';

// paymentProvider, db, mailer are assumed imported. log and metrics are assumed
// to be the app's structured logger and metrics client (metrics.increment).

const MAX_AMOUNT_CENTS = 10_000_000;
const ALLOWED_CURRENCIES = new Set(['USD', 'EUR', 'GBP']);
const PROVIDER_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 800;
const MAIL_TIMEOUT_MS = 5_000;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Minimal circuit breaker around the payment provider. Fails fast when the
// provider is known-sick instead of piling up 8s waits.
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private threshold = 5, private cooldownMs = 30_000) {}
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

interface ChargeBody {
  customerId: string;
  amountCents: number;
  currency: string;
}

function parseBody(body: unknown): { ok: true; value: ChargeBody } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body required' };
  const { customerId, amountCents, currency } = body as Record<string, unknown>;
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 128) {
    return { ok: false, error: 'customerId invalid' };
  }
  if (!Number.isSafeInteger(amountCents) || (amountCents as number) <= 0 || (amountCents as number) > MAX_AMOUNT_CENTS) {
    return { ok: false, error: 'amountCents must be a positive integer within limits' };
  }
  if (typeof currency !== 'string' || !ALLOWED_CURRENCIES.has(currency.toUpperCase())) {
    return { ok: false, error: 'currency unsupported' };
  }
  return {
    ok: true,
    value: { customerId, amountCents: amountCents as number, currency: currency.toUpperCase() },
  };
}

// Versioned from day one.
export async function postCharge(req: Request, res: Response): Promise<void> {
  const requestId = String(req.header('x-request-id') ?? '');

  const parsed = parseBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { customerId, amountCents, currency } = parsed.value;

  // Idempotency: a client retry must never charge twice.
  const idempotencyKey = req.header('idempotency-key');
  if (!idempotencyKey || idempotencyKey.length > 128) {
    res.status(400).json({ error: 'Idempotency-Key header required' });
    return;
  }

  try {
    // Deliberately no tombstone filter here: a deleted row still proves the key was spent.
    const existing = await withTimeout(
      db.charges.findByIdempotencyKey(customerId, idempotencyKey),
      DB_TIMEOUT_MS,
      'db.findByIdempotencyKey',
    );
    if (existing) {
      res.status(200).json({ chargeId: existing.chargeId, replayed: true });
      return;
    }
  } catch (err) {
    log.error('charge.idempotency_lookup_failed', { requestId, customerId, err });
    metrics.increment('charge.failed', { stage: 'lookup' });
    res.status(503).json({ error: 'temporarily unavailable' });
    return;
  }

  if (providerBreaker.isOpen()) {
    metrics.increment('charge.failed', { stage: 'breaker_open' });
    res.status(503).set('Retry-After', '30').json({ error: 'payment provider unavailable' });
    return;
  }

  let chargeId: string;
  try {
    // No automatic retry of the charge itself: a timeout is ambiguous (it may have succeeded).
    const result = await withTimeout(
      paymentProvider.charge({ customerId, amountCents, currency }),
      PROVIDER_TIMEOUT_MS,
      'paymentProvider.charge',
    );
    chargeId = result.chargeId;
    providerBreaker.success();
  } catch (err) {
    providerBreaker.failure();
    const timedOut = err instanceof TimeoutError;
    log.error('charge.provider_failed', { requestId, customerId, amountCents, currency, timedOut, err });
    metrics.increment('charge.failed', { stage: timedOut ? 'provider_timeout' : 'provider' });
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'payment outcome unknown, do not retry blindly; contact support' : 'payment failed',
    });
    return;
  }

  // Money has moved. From here on, never lose track of it.
  try {
    await withTimeout(
      db.charges.insert({ chargeId, customerId, amountCents, currency, idempotencyKey, createdAt: new Date() }),
      DB_TIMEOUT_MS,
      'db.charges.insert',
    );
  } catch (err) {
    log.error('charge.persist_failed_after_capture', { requestId, chargeId, customerId, amountCents, currency, err });
    metrics.increment('charge.persist_failed'); // page on any nonzero value; needs reconciliation
    res.status(202).json({ chargeId, status: 'processing' });
    return;
  }

  metrics.increment('charge.succeeded');

  // Receipt is not part of the response: detach it, bound it, never let it fail the charge.
  // (In production this should be a durable queue job rather than an in-process task.)
  void withTimeout(mailer.sendReceipt(customerId, chargeId), MAIL_TIMEOUT_MS, 'mailer.sendReceipt').catch((err) => {
    log.warn('charge.receipt_failed', { requestId, chargeId, customerId, err });
    metrics.increment('charge.receipt_failed');
  });

  res.status(201).json({ chargeId });
}

// router.post('/api/v1/charges', postCharge);
```

**Production concerns I addressed**

- Route versioned as `/api/v1/charges` so the first breaking change is not a coordinated migration.
- Strict boundary validation: integer cents, positive, capped, currency allowlist, bounded string lengths.
- Idempotency-Key required and checked before charging, so client retries cannot double-charge; the lookup deliberately ignores soft-delete tombstones.
- Deadlines on every I/O call, including the database, not just the payment provider.
- Circuit breaker around the payment provider (fail fast with 503 and Retry-After); no blind retry of the charge, since a timeout is ambiguous. A timeout returns 504 with an "outcome unknown" message.
- Charge succeeded but insert failed: logged with full identifiers, a dedicated counter to page on, and a 202 with the chargeId so the money is never silently lost.
- Receipt email taken off the request path, bounded by its own timeout, and its failure cannot fail or slow the charge (should become a queue job in real deployment).
- Counters (`charge.succeeded`, `charge.failed` by stage, `charge.persist_failed`, `charge.receipt_failed`) alongside structured logs, so alerts can fire on charge rates and failures.
- Not applied: feature flag (no risky new behavior path to gate), since this is a new endpoint.
````
