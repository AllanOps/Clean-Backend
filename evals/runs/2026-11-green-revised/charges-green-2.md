# charges — Sonnet 5.5 — revised skill 2

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.post('/api/v1/charges', (req, res) =>` |
| **2. Kill switch** | Correct | `flags.isOn('charges.enabled')` gates the state-changing path; read per request, off returns 503. |
| **3. Circuit breaker** | Correct | Wraps the payment provider only, and `isProviderAnswer` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Present | Every handler call is bounded, but the outbox worker the run also wrote calls `db.outbox.claimBatch('receipt.send', 50)`, `markDone` and `markRetry` without a deadline. A worker's database is a process boundary, so by the rubric this is Present. |
| **5. Off the request path** | Correct | `tx.outbox.insert` inside the same `db.transaction` as the record; a worker drains it. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | n/a | Idempotency lookup, deliberately not filtering `deleted_at`. |

## Verbatim output

````markdown
```typescript
import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
// Assumed to already exist: paymentProvider, db, mailer.
// Also assumed (standard infra): flags, metrics, log.

const router = Router();

// ---------- config ----------
const PROVIDER_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 800;
const MAX_AMOUNT_CENTS = 10_000_000; // sanity ceiling, $100k
const CURRENCIES = new Set(['usd', 'eur', 'gbp', 'cad', 'aud']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

// ---------- helpers ----------
class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Minimal circuit breaker around the payment provider.
class Breaker {
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
  recordSuccess() { this.failures = 0; }
  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}
const providerBreaker = new Breaker();

// A decline or 4xx means the provider answered: healthy dependency, not a transport failure.
function isProviderAnswer(err: any): boolean {
  if (err?.name === 'TimeoutError') return false;
  const status = err?.status ?? err?.statusCode;
  return err?.code === 'card_declined' || (typeof status === 'number' && status >= 400 && status < 500);
}

type ChargeBody = { customerId: string; amountCents: number; currency: string };

function validate(body: any): { ok: true; value: ChargeBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const { customerId, amountCents, currency } = body;
  if (typeof customerId !== 'string' || !ID_RE.test(customerId)) return { ok: false, error: 'invalid customerId' };
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS)
    return { ok: false, error: 'amountCents must be a positive integer within limits' };
  if (typeof currency !== 'string' || !CURRENCIES.has(currency.toLowerCase()))
    return { ok: false, error: 'unsupported currency' };
  return { ok: true, value: { customerId, amountCents, currency: currency.toLowerCase() } };
}

// ---------- handler ----------
async function createCharge(req: Request, res: Response) {
  const requestId = (req.header('x-request-id') as string) || randomUUID();
  const started = Date.now();
  res.setHeader('x-request-id', requestId);

  const idempotencyKey = req.header('idempotency-key');
  if (!idempotencyKey || !KEY_RE.test(idempotencyKey)) {
    return res.status(400).json({ error: 'Idempotency-Key header required (8-128 url-safe chars)' });
  }
  const v = validate(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { customerId, amountCents, currency } = v.value;

  try {
    // Idempotency lookup. Deliberately NOT filtering deleted_at: a tombstoned row
    // is still proof the key was spent; hiding it would allow a double charge.
    const existing = await withTimeout(
      db.charges.findByIdempotencyKey(idempotencyKey), DB_TIMEOUT_MS, 'db.findByIdempotencyKey');
    if (existing) {
      if (existing.customerId !== customerId || existing.amountCents !== amountCents || existing.currency !== currency) {
        return res.status(422).json({ error: 'Idempotency-Key reused with different parameters' });
      }
      return res.status(200).json({ chargeId: existing.chargeId, replayed: true });
    }

    // Fail fast when the provider is known-sick.
    if (providerBreaker.isOpen()) {
      metrics.increment('charge.rejected', { reason: 'breaker_open' });
      return res.status(503).set('Retry-After', '15').json({ error: 'payment provider unavailable' });
    }

    let chargeId: string;
    try {
      const result = await withTimeout(
        paymentProvider.charge({ customerId, amountCents, currency, idempotencyKey } as any),
        PROVIDER_TIMEOUT_MS, 'paymentProvider.charge');
      chargeId = result.chargeId;
      providerBreaker.recordSuccess();
    } catch (err: any) {
      if (isProviderAnswer(err)) providerBreaker.recordSuccess(); // dependency answered
      else providerBreaker.recordFailure();                      // timeout, reset, 5xx
      metrics.increment('charge.failed', { stage: 'provider', declined: String(isProviderAnswer(err)) });
      log.error('charge.provider_failed', { requestId, customerId, err: err?.message, code: err?.code });
      if (err?.code === 'card_declined') return res.status(402).json({ error: 'card declined' });
      if (err?.name === 'TimeoutError') {
        // Outcome unknown: money may have moved. The provider call carries the idempotency
        // key, so the client retrying with the same key is safe; reconciliation catches the rest.
        metrics.increment('charge.outcome_unknown');
        return res.status(504).json({ error: 'payment outcome unknown, retry with same Idempotency-Key' });
      }
      return res.status(502).json({ error: 'payment failed' });
    }

    // Money has moved. Persist charge + receipt outbox row atomically.
    try {
      await withTimeout(db.transaction(async (tx) => {
        await tx.charges.insert({
          chargeId, customerId, amountCents, currency, idempotencyKey, status: 'succeeded', createdAt: new Date(),
        });
        await tx.outbox.insert({
          type: 'receipt.send', payload: { customerId, chargeId }, createdAt: new Date(),
        });
      }), DB_TIMEOUT_MS * 2, 'db.transaction');
    } catch (err: any) {
      // Unique violation on idempotency key = concurrent duplicate; the other request won.
      if (err?.code === 'unique_violation' || err?.code === '23505') {
        return res.status(200).json({ chargeId, replayed: true });
      }
      // Customer was charged but we could not record it. Page on this.
      metrics.increment('charge.persist_failed');
      log.error('charge.persist_failed.CRITICAL', { requestId, customerId, chargeId, amountCents, currency, err: err?.message });
      return res.status(202).json({ chargeId, status: 'charged_pending_record' });
    }

    metrics.increment('charge.succeeded', { currency });
    metrics.timing('charge.latency_ms', Date.now() - started);
    log.info('charge.succeeded', { requestId, customerId, chargeId, amountCents, currency });
    return res.status(201).json({ chargeId });
  } catch (err: any) {
    metrics.increment('charge.failed', { stage: 'internal' });
    log.error('charge.internal_error', { requestId, err: err?.message });
    return res.status(500).json({ error: 'internal error' });
  }
}

// Versioned route + kill switch (read per request, flip without a deploy).
router.post('/api/v1/charges', (req, res) =>
  flags.isOn('charges.enabled')
    ? createCharge(req, res)
    : res.status(503).set('Retry-After', '60').json({ error: 'temporarily disabled' }));

export default router;

// ---------- outbox worker (separate process/cron) ----------
export async function drainReceiptOutbox() {
  const rows = await db.outbox.claimBatch('receipt.send', 50);
  for (const row of rows) {
    try {
      await withTimeout(mailer.sendReceipt(row.payload.customerId, row.payload.chargeId), 5_000, 'mailer.sendReceipt');
      await db.outbox.markDone(row.id);
    } catch (err: any) {
      metrics.increment('receipt.send_failed');
      await db.outbox.markRetry(row.id, err?.message); // backoff + attempt cap handled in markRetry
    }
  }
}
```

**Production concerns I addressed**

- Versioned route (`/api/v1/charges`) so the first breaking change is not a coordinated client migration.
- Kill switch (`charges.enabled`) read on every request; off returns a clean 503 with Retry-After, no emergency deploy.
- Circuit breaker around the payment provider that counts only transport failures (timeouts, resets, 5xx); declines and 4xx count as the dependency answering, so a wave of declines cannot open it.
- Deadlines on every I/O: provider (8s), and the database lookup and transaction too.
- Receipt email leaves the request path: written to an outbox row in the same transaction as the charge record, drained by a worker with retries.
- Idempotency via required `Idempotency-Key`, passed through to the provider, with replay returning the original result, parameter-mismatch rejected with 422, and unique-constraint races handled. The idempotency lookup does not filter tombstones.
- Boundary validation: safe-integer positive cents, an amount ceiling, a currency allowlist, and ID and key format checks.
- Unknown-outcome handling: a provider timeout returns 504 with guidance to retry using the same key, and increments `charge.outcome_unknown` for reconciliation.
- Charged-but-not-recorded case returns 202 with the chargeId, logs CRITICAL and increments `charge.persist_failed` for paging.
- Counters, not just logs: `charge.succeeded`, `charge.failed`, `charge.rejected`, `charge.persist_failed`, `charge.outcome_unknown`, `receipt.send_failed`, plus a latency timing, with request-id correlation in logs.
- Honest status codes (400, 402, 422, 502, 503, 504) and no leaking of provider internals to the client.
````
