# charges — Sonnet 5.5 — revised skill 1

- **Scenario:** [`../../scenarios/charges.md`](../../scenarios/charges.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.post('/api/v1/charges', (req, res) => {` |
| **2. Kill switch** | Correct | `flags.isOn('charges.enabled')` gates the state-changing path; read per request, off returns 503. |
| **3. Circuit breaker** | Correct | Wraps the payment provider only, and `isProviderAnswer` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Correct | `withTimeout` on `db.charges.findByIdempotencyKey` and on the `db.transaction`. No worker code written. |
| **5. Off the request path** | Correct | `tx.outbox.insert` inside the same `db.transaction` as the record; a worker drains it. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | n/a | Only read is the idempotency lookup. |

## Verbatim output

````markdown
```typescript
import { Router, Request, Response } from 'express';

// Assumed to exist and be imported: paymentProvider, db, mailer, flags, metrics, log.
// db.transaction(fn) and an `outbox` table are assumed available (a worker drains it).

const router = Router();

// ---------- config ----------
const PROVIDER_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 800;
const MAX_AMOUNT_CENTS = 100_000_00; // sanity ceiling: 100k major units
const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

// ---------- helpers ----------
class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// A decline or 4xx means the provider ANSWERED. Only transport failures
// (timeout, reset, 5xx) count toward opening the breaker.
function isProviderAnswer(err: any): boolean {
  const status = err?.status ?? err?.statusCode;
  return err?.code === 'card_declined' || (typeof status === 'number' && status >= 400 && status < 500);
}

class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  constructor(private threshold = 5, private cooldownMs = 15_000) {}

  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs && !this.probing) {
      this.probing = true; // half-open: let exactly one probe through
      return false;
    }
    return true;
  }
  recordSuccess() { this.failures = 0; this.probing = false; }
  recordFailure() {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

const providerBreaker = new CircuitBreaker();

interface ChargeInput { customerId: string; amountCents: number; currency: string }

function validate(body: any): { ok: true; value: ChargeInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const { customerId, amountCents, currency } = body;
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 128) {
    return { ok: false, error: 'customerId must be a non-empty string' };
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    return { ok: false, error: 'amountCents must be a positive integer within limits' };
  }
  if (typeof currency !== 'string' || !SUPPORTED_CURRENCIES.has(currency.toUpperCase())) {
    return { ok: false, error: 'unsupported currency' };
  }
  return { ok: true, value: { customerId, amountCents, currency: currency.toUpperCase() } };
}

// ---------- handler ----------
async function createCharge(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  metrics.increment('charge.requested');

  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    res.status(400).json({ error: 'Idempotency-Key header required (8-128 chars, [A-Za-z0-9_-])' });
    return;
  }

  const parsed = validate(req.body);
  if (!parsed.ok) {
    metrics.increment('charge.rejected_validation');
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { customerId, amountCents, currency } = parsed.value;

  try {
    // Replay: the key may already have been spent. No tombstone filter here:
    // a soft-deleted row is still proof the key was used.
    const existing = await withTimeout(
      db.charges.findByIdempotencyKey(idempotencyKey),
      DB_TIMEOUT_MS,
      'db.charges.findByIdempotencyKey',
    );
    if (existing) {
      if (
        existing.customerId !== customerId ||
        existing.amountCents !== amountCents ||
        existing.currency !== currency
      ) {
        res.status(422).json({ error: 'Idempotency-Key reused with different parameters' });
        return;
      }
      metrics.increment('charge.replayed');
      res.status(200).json({ chargeId: existing.chargeId, replayed: true });
      return;
    }

    // Fail fast when the provider is known-sick.
    if (providerBreaker.isOpen()) {
      metrics.increment('charge.shed_breaker_open');
      res.status(503).set('Retry-After', '15').json({ error: 'payment provider unavailable, retry shortly' });
      return;
    }

    let chargeId: string;
    try {
      // Assumes the provider accepts an idempotency key so a retried call after an
      // ambiguous timeout cannot double-charge.
      const result = await withTimeout(
        paymentProvider.charge({ customerId, amountCents, currency, idempotencyKey } as any),
        PROVIDER_TIMEOUT_MS,
        'paymentProvider.charge',
      );
      chargeId = result.chargeId;
      providerBreaker.recordSuccess();
    } catch (err: any) {
      if (isProviderAnswer(err)) {
        providerBreaker.recordSuccess(); // dependency is healthy, it said no
        metrics.increment('charge.declined');
        log.info('charge.declined', { customerId, code: err?.code, idempotencyKey });
        res.status(402).json({ error: 'payment declined' });
        return;
      }
      providerBreaker.recordFailure();
      metrics.increment('charge.provider_failed');
      log.error('charge.provider_failed', { err, customerId, idempotencyKey });
      // Outcome may be unknown on timeout; same key makes a client retry safe.
      const status = err instanceof TimeoutError ? 504 : 502;
      res.status(status).json({ error: 'payment provider error, retry with the same Idempotency-Key' });
      return;
    }

    // Money has moved. Persist the charge and the receipt job atomically.
    try {
      await withTimeout(
        db.transaction(async (tx: any) => {
          await tx.charges.insert({
            chargeId,
            customerId,
            amountCents,
            currency,
            idempotencyKey,
            createdAt: new Date(),
          });
          await tx.outbox.insert({
            type: 'receipt.send',
            payload: { customerId, chargeId },
          });
        }),
        DB_TIMEOUT_MS * 2,
        'db.transaction(charge+outbox)',
      );
    } catch (err) {
      // Customer was charged but we have no record. Page-worthy: reconcile from the log.
      metrics.increment('charge.persist_failed');
      log.error('charge.persist_failed', { err, chargeId, customerId, amountCents, currency, idempotencyKey });
      res.status(500).json({
        error: 'charge succeeded but could not be recorded; do not retry with a new key',
        chargeId,
      });
      return;
    }

    metrics.increment('charge.succeeded');
    metrics.timing('charge.latency_ms', Date.now() - started);
    res.status(201).json({ chargeId });
  } catch (err) {
    metrics.increment('charge.failed');
    log.error('charge.failed', { err, customerId, idempotencyKey });
    res.status(500).json({ error: 'internal error' });
  }
}

// Versioned from day one, and behind a kill switch (a new money-moving path).
router.post('/api/v1/charges', (req, res) => {
  if (!flags.isOn('charges.enabled')) {
    res.status(503).set('Retry-After', '60').json({ error: 'temporarily disabled' });
    return;
  }
  void createCharge(req, res);
});

export default router;
```

**Production concerns I addressed**
- Input validation at the boundary: safe-integer positive cents, upper sanity cap, currency allowlist, string bounds on customerId.
- Idempotency: required `Idempotency-Key`, replay returns the original charge, parameter mismatch returns 422, and the key is also passed to the provider. The replay lookup deliberately ignores soft-delete tombstones.
- Versioned route (`/api/v1/charges`) so the first breaking change is not a coordinated migration.
- Kill switch (`charges.enabled`) read per request; off returns 503 with Retry-After, no deploy needed.
- Circuit breaker around the provider that counts only transport failures (timeouts, resets, 5xx). Declines and 4xx count as the provider being healthy, so a wave of declines cannot open it. Half-open allows a single probe.
- Deadlines on every I/O: 8s on the provider, sub-second on database calls.
- Receipt email leaves the request path: an outbox row is written in the same transaction as the charge record and a worker drains it, so a restart cannot lose the receipt and a mail outage cannot slow or fail checkout.
- Correct status mapping: 400 validation, 402 decline, 422 key misuse, 502/504 provider trouble, 503 shed or disabled, 500 internal.
- The dangerous partial failure (charged but not persisted) is handled explicitly: a distinct counter, a log with everything needed to reconcile, and the chargeId returned to the caller.
- Metrics alongside logs: counters for requested, succeeded, declined, provider_failed, persist_failed, shed, replayed, plus a latency timing, so you can alert on charges per minute and failure rate.
- Assumptions to confirm: `db.transaction`, an `outbox` table with a draining worker, `findByIdempotencyKey`, and provider support for an idempotency key. A unique index on `charges.idempotencyKey` is needed to close the race between two concurrent first requests; this code relies on it (and on provider-side key dedupe) but does not add a lock.
````
