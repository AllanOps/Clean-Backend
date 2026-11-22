# ship-order — Sonnet 5.5 — revised skill 2 (held-out)

- **Scenario:** [`../../scenarios/ship-order.md`](../../scenarios/ship-order.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.post('/api/v1/orders/:id/ship', shipOrder);` |
| **2. Kill switch** | Correct | `flags.isOn('orders.ship.enabled')` gates the state-changing path; read per request, off returns 503. |
| **3. Circuit breaker** | Correct | Wraps the carrier only, and `err instanceof AddressRejectedError` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Correct | Order read, shipment lookup and transaction bounded; the worker only calls the mailer, also bounded. |
| **5. Off the request path** | Correct | `tx.outbox.insert` inside the same `db.transaction` as the record; a worker drains it. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | Absent | `db.orders.findById(id)` result is used without a tombstone check. |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from 'express';

// shippingProvider, db, mailer, flags, metrics, log are assumed to exist and be imported.
// Assumes db.transaction(fn) exposes tx.shipments / tx.outbox, and db.shipments.findByOrderId exists.

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

// Minimal circuit breaker for the carrier dependency only (not our own DB).
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
  recordSuccess() { this.failures = 0; }
  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

const carrierBreaker = new CircuitBreaker();

const CARRIER_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 800;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export async function shipOrder(req: Request, res: Response) {
  // Kill switch: buying a label spends money and changes state in another service.
  if (!(await flags.isOn('orders.ship.enabled'))) {
    return res.status(503).set('Retry-After', '60').json({ error: 'shipping temporarily disabled' });
  }

  const id = req.params.id;
  if (!ID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'invalid order id' });
  }

  try {
    const order = await withTimeout(db.orders.findById(id), DB_TIMEOUT_MS, 'db.orders.findById');
    if (!order) return res.status(404).json({ error: 'order not found' });

    // Idempotent: a retry or double-click must not buy a second label.
    // (Deliberately no tombstone filter here: a deleted shipment row is still proof the label was bought.)
    const existing = await withTimeout(
      db.shipments.findByOrderId(id), DB_TIMEOUT_MS, 'db.shipments.findByOrderId',
    );
    if (existing) {
      return res.status(200).json({ orderId: id, trackingNumber: existing.trackingNumber, alreadyShipped: true });
    }

    // Fail fast when the carrier is known to be sick.
    if (carrierBreaker.isOpen()) {
      metrics.increment('order.ship.breaker_open');
      return res.status(503).set('Retry-After', '30').json({ error: 'carrier unavailable, try again shortly' });
    }

    let trackingNumber: string;
    try {
      ({ trackingNumber } = await withTimeout(
        shippingProvider.createLabel({ orderId: id, address: order.address }),
        CARRIER_TIMEOUT_MS,
        'shippingProvider.createLabel',
      ));
      carrierBreaker.recordSuccess();
    } catch (err) {
      if (err instanceof AddressRejectedError) {
        carrierBreaker.recordSuccess(); // the carrier answered; it said no. Not a health signal.
        metrics.increment('order.ship.address_rejected');
        log.warn('order.ship.address_rejected', { orderId: id });
        return res.status(422).json({ error: 'carrier rejected the shipping address' });
      }
      carrierBreaker.recordFailure(); // timeout, reset, 5xx
      throw err;
    }

    // Label is bought and costs money. Persist the shipment and the email intent atomically.
    try {
      await withTimeout(
        db.transaction(async (tx) => {
          await tx.shipments.insert({
            orderId: id,
            customerId: order.customerId,
            trackingNumber,
            createdAt: new Date(),
          });
          await tx.outbox.insert({
            type: 'shipment.tracking_email',
            payload: { customerId: order.customerId, trackingNumber },
          });
        }),
        DB_TIMEOUT_MS * 2,
        'db.transaction(shipment)',
      );
    } catch (err) {
      // Orphaned label: carrier has it, we do not. Make it loud and recoverable.
      metrics.increment('order.ship.orphaned_label');
      log.error('order.ship.orphaned_label', { orderId: id, trackingNumber, err });
      throw err;
    }

    metrics.increment('order.ship.succeeded');
    return res.status(201).json({ orderId: id, trackingNumber });
  } catch (err) {
    metrics.increment('order.ship.failed');
    log.error('order.ship.failed', { orderId: id, err });
    if (err instanceof TimeoutError) {
      return res.status(504).json({ error: 'upstream timeout' });
    }
    return res.status(500).json({ error: 'internal error' });
  }
}

// Outbox worker handler: email leaves the request path and survives restarts.
export async function handleTrackingEmail(payload: { customerId: string; trackingNumber: string }) {
  await withTimeout(
    mailer.sendTracking(payload.customerId, payload.trackingNumber),
    5_000,
    'mailer.sendTracking',
  );
  metrics.increment('order.ship.email_sent');
}

export function register(router: Router) {
  router.post('/api/v1/orders/:id/ship', shipOrder);
}
```

**Production concerns I addressed**

- Versioned route (`/api/v1/orders/:id/ship`) so the first breaking change is not a client migration.
- Kill switch (`orders.ship.enabled`), read per request: buying a label spends money, so off returns a clean 503 with Retry-After instead of an emergency deploy.
- Circuit breaker around the carrier call only. `AddressRejectedError` counts as a healthy response, so a wave of bad addresses cannot open the breaker. Timeouts, resets and 5xx count as failures. No breaker around our own DB.
- Deadlines on every I/O: carrier (8s), and each DB call (800ms), plus the mailer in the worker.
- Email moved off the request path: a transactional outbox row is written with the shipment, and a worker (`handleTrackingEmail`) sends it. A restart or mailer outage cannot lose it or slow the response.
- Counters alongside logs: `order.ship.succeeded`, `failed`, `address_rejected`, `breaker_open`, `orphaned_label`, `email_sent`, so you can alert on rates, not just grep logs.
- Idempotency: an existing shipment returns the same tracking number instead of buying a second label. That lookup deliberately skips any soft-delete filter, since a tombstoned row still proves the label was spent.
- Input validation (order id shape), 404 for unknown order, 422 for a rejected address (a client-fixable error, not a 500), 504 for upstream timeout.
- Orphaned label (carrier succeeded, DB write failed) is logged with the tracking number and counted, so it can be reconciled or voided manually.
- Assumptions: `flags`, `metrics`, `log`, `AddressRejectedError`, `db.transaction`/`tx.outbox` and `db.shipments.findByOrderId` exist. A unique index on `shipments.orderId` is also needed to close the concurrent-request race. In that case the loser's insert fails and surfaces as an orphaned label for reconciliation, since `createLabel` takes no idempotency key.
- Not applied: tombstone filtering on the order read, since the spec does not indicate orders are soft-deleted.
````
