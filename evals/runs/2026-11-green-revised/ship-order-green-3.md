# ship-order — Sonnet 5.5 — revised skill 3 (held-out)

- **Scenario:** [`../../scenarios/ship-order.md`](../../scenarios/ship-order.md), **GREEN variant** used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`, frontier tier), 2026-11-22
- **Condition:** with the revised skill (habits 2, 3, 5 as of commit eb7d2e2)
- **Record kind:** verbatim
- **Isolation:** exactly two tool calls in the transcript: one Read of `SKILL.md`, one Write of the answer.
- **Retry note:** the first dispatch of this batch failed on API timeouts and connection errors before any output was written; this is the second dispatch, with identical prompts.

## Scorecard

| Habit | Score | Deciding line |
| --- | --- | --- |
| **1. Version the route** | Correct | `router.post('/api/v1/orders/:id/ship', (req, res) => {` |
| **2. Kill switch** | Correct | `flags.isOn('orders.ship.enabled')` gates the state-changing path; read per request, off returns 503. |
| **3. Circuit breaker** | Correct | Wraps the carrier only, and `isDependencyAnswer` keeps business rejections from opening it. |
| **4. Deadline on every I/O** | Correct | Order read, shipment lookup and transaction each wrapped in `withTimeout`. |
| **5. Off the request path** | Correct | `tx.outbox.insert` inside the same `db.transaction` as the record; a worker drains it. |
| **6. Business counters** | Correct | Outcome counters via `metrics.increment` alongside the logs. |
| **7. Tombstone-aware reads** | Absent | `db.orders.findById(orderId)` result is used without a tombstone check. |

## Verbatim output

````markdown
```typescript
import type { Request, Response, Router } from 'express';

// Already in scope per the spec: shippingProvider, db, mailer, AddressRejectedError.
// Assumed infra (declared so the file type-checks; swap for your real modules):
declare const flags: { isOn(name: string): boolean };
declare const metrics: { increment(name: string, tags?: Record<string, string>): void };
declare const log: {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
};
declare const carrierBreaker: {
  isOpen(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
};

// ---- Deadlines: every I/O crosses a process boundary, the DB included. ----
const CARRIER_TIMEOUT_MS = 8_000;
const DB_READ_TIMEOUT_MS = 800;
const DB_WRITE_TIMEOUT_MS = 1_500;

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

// The carrier answered (even if the answer was "no"): not a health signal.
function isDependencyAnswer(err: unknown): boolean {
  return err instanceof AddressRejectedError;
}

const UUID_OR_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function registerShipRoutes(router: Router): void {
  // Versioned from day one. Kill switch is read on every request so it can be
  // flipped without a deploy: this endpoint spends money at the carrier.
  router.post('/api/v1/orders/:id/ship', (req, res) => {
    if (!flags.isOn('orders.ship.enabled')) {
      metrics.increment('order.ship.disabled');
      return res.status(503).set('Retry-After', '60').json({ error: 'shipping temporarily disabled' });
    }
    return shipOrder(req, res);
  });
}

async function shipOrder(req: Request, res: Response): Promise<Response> {
  const orderId = req.params.id;

  // 1. Validate at the boundary.
  if (!UUID_OR_ID.test(orderId)) {
    return res.status(400).json({ error: 'invalid order id' });
  }

  try {
    // 2. Load the order.
    const order = await withTimeout(db.orders.findById(orderId), DB_READ_TIMEOUT_MS, 'db.orders.findById');
    if (!order) {
      return res.status(404).json({ error: 'order not found' });
    }
    if (!order.address || !order.customerId) {
      return res.status(422).json({ error: 'order is missing address or customer' });
    }

    // 3. Idempotency: a double-click or client retry must not buy a second label.
    //    Deliberately NOT filtered by tombstone: a spent label is a spent label.
    const existing = await withTimeout(
      db.shipments.findByOrderId(orderId),
      DB_READ_TIMEOUT_MS,
      'db.shipments.findByOrderId',
    );
    if (existing) {
      return res.status(200).json({ orderId, trackingNumber: existing.trackingNumber, alreadyShipped: true });
    }

    // 4. Fail fast when the carrier is known-sick instead of piling onto it.
    if (carrierBreaker.isOpen()) {
      metrics.increment('order.ship.carrier_unavailable');
      return res.status(503).set('Retry-After', '30').json({ error: 'carrier temporarily unavailable' });
    }

    // 5. Buy the label (deadline + breaker; only transport failures trip it).
    let trackingNumber: string;
    try {
      const label = await withTimeout(
        shippingProvider.createLabel({ orderId, address: order.address }),
        CARRIER_TIMEOUT_MS,
        'shippingProvider.createLabel',
      );
      carrierBreaker.recordSuccess();
      trackingNumber = label.trackingNumber;
    } catch (err) {
      if (isDependencyAnswer(err)) carrierBreaker.recordSuccess(); // healthy carrier saying no
      else carrierBreaker.recordFailure();                         // timeout, reset, 5xx
      throw err;
    }

    // 6. Persist the shipment AND the email intent in one transaction.
    //    The email leaves the request path: a worker drains the outbox, so a
    //    mailer outage or a restart cannot lose it or slow this response.
    try {
      await withTimeout(
        db.transaction(async (tx) => {
          await tx.shipments.insert({ orderId, trackingNumber, shippedAt: new Date() });
          await tx.outbox.insert({
            type: 'shipment.tracking_email',
            payload: { customerId: order.customerId, trackingNumber },
          });
        }),
        DB_WRITE_TIMEOUT_MS,
        'db.transaction(shipment+outbox)',
      );
    } catch (err) {
      // A label was bought but we could not record it: this is the one case
      // that costs real money and must be reconciled by a human or a job.
      metrics.increment('order.ship.label_orphaned');
      log.error('order.ship.label_orphaned', { orderId, trackingNumber, err });
      return res.status(500).json({ error: 'shipment could not be recorded', orderId });
    }

    metrics.increment('order.ship.succeeded');
    return res.status(201).json({ orderId, trackingNumber });
  } catch (err) {
    if (err instanceof AddressRejectedError) {
      // Client-fixable, not an outage: 422, not 5xx.
      metrics.increment('order.ship.address_rejected');
      log.warn('order.ship.address_rejected', { orderId });
      return res.status(422).json({ error: 'carrier rejected the shipping address' });
    }
    if (err instanceof TimeoutError) {
      metrics.increment('order.ship.timeout');
      log.error('order.ship.timeout', { orderId, err });
      return res.status(504).json({ error: 'upstream timeout, safe to retry' });
    }
    metrics.increment('order.ship.failed');
    log.error('order.ship.failed', { orderId, err });
    return res.status(500).json({ error: 'internal error' });
  }
}
```

Production concerns I addressed

- Route is versioned (`/api/v1/orders/:id/ship`) so the first breaking change is not a coordinated client migration.
- Kill switch (`orders.ship.enabled`) read per request, returning a clean 503 with `Retry-After`, because the endpoint spends money at the carrier.
- Circuit breaker around the carrier: fails fast when open, and only transport failures (timeouts, resets, 5xx) count. An `AddressRejectedError` is treated as the carrier answering, so a wave of bad addresses cannot open the breaker.
- Deadlines on every I/O call, the database reads and the transaction as well as the carrier call. Timeouts return 504.
- Tracking email is not sent inline. The shipment row and an outbox row are written in one transaction and a worker drains the outbox. The customer's latency does not depend on the mailer, and a restart cannot lose the email. The worker would call `mailer.sendTracking(customerId, trackingNumber)`.
- Idempotency: an existing shipment for the order returns 200 with its tracking number, so double-clicks and client retries do not buy a second label. This lookup deliberately does not filter tombstones. It assumes `db.shipments.findByOrderId` exists. A unique index on `shipments.orderId` is still needed to close the concurrent-request race.
- Validation at the boundary: id format gives 400, a missing order gives 404, and an order without an address or customer gives 422.
- Error mapping: a rejected address is 422 (client-fixable), not a 5xx that would page someone.
- Orphaned-label case: if the label is bought but the DB write fails, the failure is logged with the tracking number and counted under a dedicated `order.ship.label_orphaned` metric so it can be reconciled.
- Counters as well as logs (`order.ship.succeeded`, `failed`, `timeout`, `address_rejected`, `carrier_unavailable`, `label_orphaned`), so you can alert on shipments per minute and failure rate, not just search logs afterward.
- Not applied: tombstone filtering on `orders.findById`, since this is a single lookup by id and the order repository is assumed to own that filter.
````
