# ship-order — Sonnet 5.5 — revised skill 1 (held-out)

- **Scenario:** [`../../scenarios/ship-order.md`](../../scenarios/ship-order.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.post('/api/v1/orders/:id/ship', (req, res, next) => {` |
| **2. Kill switch** | Correct | `flags.isOn('orders.ship.enabled')` gates the state-changing path; read per request, off returns 503. |
| **3. Circuit breaker** | Correct | Wraps the carrier only, and `isCarrierAnswer` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Correct | `db.orders.findById`, `db.shipments.findByOrderId` and the `db.transaction` each wrapped in `withTimeout`. |
| **5. Off the request path** | Correct | `tx.outbox.insert` inside the same `db.transaction` as the record; a worker drains it. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | Correct | `if (!order \|\| order.deletedAt) {` returns 404; the existing-shipment lookup is left unfiltered. |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from 'express';

// Assumed to exist alongside shippingProvider, db, mailer:
//   flags.isOn(name), metrics.increment(name), log.{info,warn,error},
//   db.transaction(fn), db.shipments.findByOrderId, tx.outbox.insert,
//   and a UNIQUE index on shipments.order_id.
declare const flags: { isOn(name: string): boolean };
declare const metrics: { increment(name: string, tags?: Record<string, string>): void };
declare const log: {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
};

// ---------- deadlines ----------
class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const CARRIER_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 800;

// ---------- circuit breaker for the carrier ----------
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}
  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      // half-open: let one probe through
      this.failures = this.threshold - 1;
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

const carrierBreaker = new CircuitBreaker();

// Only transport-level trouble (timeout, reset, 5xx) counts against the carrier.
// A rejected address means the carrier answered and is healthy.
function isCarrierAnswer(err: unknown): boolean {
  if (err instanceof AddressRejectedError) return true;
  const status = (err as { status?: number })?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// ---------- validation ----------
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- handler ----------
async function shipOrder(req: Request, res: Response): Promise<void> {
  // Kill switch: this buys a label (spends money) and mutates our state.
  if (!flags.isOn('orders.ship.enabled')) {
    res.status(503).set('Retry-After', '60').json({ error: 'shipping temporarily disabled' });
    return;
  }

  const orderId = req.params.id;
  if (!ORDER_ID.test(orderId)) {
    res.status(400).json({ error: 'invalid order id' });
    return;
  }

  try {
    const order = await withTimeout(db.orders.findById(orderId), DB_TIMEOUT_MS, 'orders.findById');
    // Tombstone check: a soft-deleted order must look like it does not exist.
    if (!order || order.deletedAt) {
      res.status(404).json({ error: 'order not found' });
      return;
    }
    if (!order.address) {
      res.status(422).json({ error: 'order has no shipping address' });
      return;
    }

    // Idempotency: a retry must never buy a second label. Deliberately NOT filtered
    // for tombstones - a stamped row is still proof the label was bought.
    const existing = await withTimeout(
      db.shipments.findByOrderId(orderId), DB_TIMEOUT_MS, 'shipments.findByOrderId');
    if (existing) {
      res.status(200).json({ orderId, trackingNumber: existing.trackingNumber, alreadyShipped: true });
      return;
    }

    if (carrierBreaker.isOpen()) {
      metrics.increment('ship.carrier_circuit_open');
      res.status(503).set('Retry-After', '30').json({ error: 'carrier unavailable, try again shortly' });
      return;
    }

    let trackingNumber: string;
    try {
      const label = await withTimeout(
        shippingProvider.createLabel({ orderId, address: order.address }),
        CARRIER_TIMEOUT_MS, 'shippingProvider.createLabel');
      carrierBreaker.recordSuccess();
      trackingNumber = label.trackingNumber;
    } catch (err) {
      if (isCarrierAnswer(err)) carrierBreaker.recordSuccess();
      else carrierBreaker.recordFailure();
      throw err;
    }

    // Shipment + email intent commit atomically. The email is sent by an outbox
    // worker, off the request path, and survives restarts.
    try {
      await withTimeout(
        db.transaction(async (tx) => {
          await tx.shipments.insert({ orderId, trackingNumber, customerId: order.customerId });
          await tx.outbox.insert({
            type: 'tracking.send',
            payload: { customerId: order.customerId, trackingNumber },
          });
        }),
        DB_TIMEOUT_MS * 2, 'shipments.persist');
    } catch (err) {
      // We hold a paid label we failed to record. Make it findable for reconciliation.
      log.error('ship.persist_failed_after_label', { orderId, trackingNumber, err });
      metrics.increment('ship.orphaned_label');
      res.status(500).json({ error: 'shipment could not be recorded' });
      return;
    }

    metrics.increment('ship.succeeded');
    log.info('ship.succeeded', { orderId, trackingNumber });
    res.status(201).json({ orderId, trackingNumber });
  } catch (err) {
    if (err instanceof AddressRejectedError) {
      metrics.increment('ship.address_rejected');
      log.warn('ship.address_rejected', { orderId });
      res.status(422).json({ error: 'carrier rejected the shipping address' });
      return;
    }
    if (err instanceof TimeoutError) {
      metrics.increment('ship.timeout');
      log.error('ship.timeout', { orderId, err });
      res.status(504).json({ error: 'upstream timed out' });
      return;
    }
    metrics.increment('ship.failed');
    log.error('ship.failed', { orderId, err });
    res.status(502).json({ error: 'could not create shipping label' });
  }
}

export function registerShipRoutes(router: Router): void {
  router.post('/api/v1/orders/:id/ship', (req, res, next) => {
    shipOrder(req, res).catch(next);
  });
}
```

Production concerns I addressed

- Versioned route (`/api/v1/orders/:id/ship`) so the first breaking change is not a client migration.
- Kill switch (`orders.ship.enabled`) read per request. This endpoint spends money at the carrier and mutates state, so off means a clean 503 with `Retry-After`, not an emergency deploy.
- Circuit breaker around the carrier call. Only transport failures (timeouts, resets, 5xx) count. `AddressRejectedError` and 4xx responses count as the carrier answering, so a wave of bad addresses cannot open the breaker. There is no blind retry of the label purchase, because it is not safe to repeat.
- Deadlines on every I/O call, including each database call (800ms) and the carrier (8s). A hung dependency returns 504 instead of tying up the request.
- Email is off the request path. The shipment row and an outbox row are written in one transaction, and a worker sends the tracking email. A crash cannot lose the email or send one for a shipment that was never recorded.
- Counters next to the logs (`ship.succeeded`, `ship.failed`, `ship.timeout`, `ship.address_rejected`, `ship.carrier_circuit_open`, `ship.orphaned_label`) so you can alert on shipments per minute and failure rate.
- Tombstones: a soft-deleted order returns 404. The existing-shipment lookup deliberately does not filter tombstones, since a tombstoned row still proves the label was bought.
- Idempotency: if a shipment already exists for the order, return it (200) instead of buying a second label. Assumes a unique index on `shipments.order_id` as the backstop for concurrent requests.
- Orphaned-label handling: if the label is bought but the insert fails, log the `trackingNumber` at error level and bump a counter so someone can reconcile or void it.
- Input validation (order id format, address present) and distinct status codes: 400, 404, 422 (address), 503 (disabled or breaker open), 504 (timeout), 502 (carrier failure).
- Assumptions: `flags`, `metrics`, `log`, `db.transaction` and `db.shipments.findByOrderId` exist, `order.deletedAt` is the tombstone field, and `AddressRejectedError` is imported.
````
