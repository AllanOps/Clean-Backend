# 12 Backend Tricks: What production would reward.

### These 12 solid alterations and mindset are the ones that separate a system that survives "Black Friday" from one that takes the company down with it.
None are "clever". They’re habits that *look* like overhead, until they save you at 3am.

## 1. Send less - Always send less.
### Send less data than you think

For instance;

```TypeScript
// The Trap - Return the whole row
GET /users/:id
{ id, name, email, createdAt, updatedAt, internalFlags, ... }

// The Fix - Pick fields per screen
GET /users/:id?fields=id,name
{ id: 1, name: 'John' }
```
Every byte is a second on a 3G phone.
**Pick fields per endpoint, NOT per model.**

## 2. Timeouts on HTTP are the easy half.
### Timeouts on every I/O, not just HTTP

For instance;

```TypeScript
// The Trap - Only one IO has a deadline
fetch(url, {timeout: 5000});
await db.query(sql); // Can hang
await redis.get(key); // Can hang

// The Fix - Wrap every boundary
const t = (p, ms) => Promise.race([
    p, sleep(ms).then(() => fail()),
]);
await t(db.query(sql), 800);
```
**Anything that crosses a process boundary can hang.**
Wrap every I/O call. Default deadline, then loosen.

## 3. Make the second click no-op, not a bug.
### Idempotency keys anywhere money moves

> [!IMPORTANT]
> This is very important. The number one source of customer pain is "I clicked, but it didn't work, so I clicked again...
> and now I got charged twice."

For instance;

```TypeScript
// The Trap - Retry charges twice
POST /charges { amount: 4900 }

// The Fix - Stable key, server dedupes
POST /charges
Idempotency-Key: 8f2c...-94d1
if (seen(key)) return cached(key);
return cache(key, charge(amount));
```

Refresh, retry, network blip - the user's intent was one charge.
**Anywhere money or state moves, charge a key.**

## 4. Reject early. Spare the database.
### Validate at the door, not the database.

For instance;

```TypeScript
// The Trap - DB rejects bad input
async function createOrder(req) {
    await db.insert('orders', req.body);
}

// The Fix - Door rejects bad input
function createOrder(req, res) {
    if (!req.body.email) return 400;
    if (!req.body.items) return 400;
    return db.insert('orders', req.body);
}
```

A bad request that reaches the database *is a tax that we pay forever*.
**Schema-validate at the controller, not the table.**

## 5. Deploying is not the same as releasing.
### Feature flags by default - even on side projects.

For instance;

```TypeScript
// The Trap - Deploy = Release for everyone
return renderCheckoutV2();

// The Fix - Flag-gated rollout
if (flags.checkoutV2.on(user)) {
    return renderCheckoutV2();
}
return renderCheckoutV1();
// Rollback = Flip a switch, not a deploy
```

Code live to nobody is safer than code rolled back to everyone.
**Every risky path goes behind a flag.** Even on a side project.

## 6. If a request waits for it, it shouldn't.
### Async the heavy work, receipts in 40ms beats 4s

For instance;

```TypeScript
// The Trap - User awaits 4 seconds
await renderInvoicePDF(order);
res.send('ok');

// The Fix - Receipt in 40ms
queue.enqueue('invoice.render', {
    orderId,
});
res.send({ status: queued });
```

**Anything the user doesn't need in a milisecond goes to a worker.**
Email. PDFs. Webhooks. Image work. Search indexing. All async.

## 7. Rate-limit users. Then rate-limit yourselves.
### Internal rate limits + circuit breakers

For instance;

```TypeScript
// The Trap - Blind retry storm
while (!ok) await serviceB.call();

// The Fix - Bucket + Circuit Breaker
const lim = new Bucket({ rps: 200 });
if (!lim.take())    return backoff();
if (breaker.open()) return fallback();
return await serviceB.call();
```

One service flooding another is how a retry storm becomes an outage.
**Internal calls deserve buckets and breakers, not blind retries.**

## 8. Version the API from day one.
### We will need /v2 sooner than we think.

For instance;

```TypeScript
// The Trap - Unversioned, breaks every client
GET /api/users/:id

// The Fix - Version the URL from day one
GET /api/v1/users/:id
GET /api/v2/users/:id   // Breaking change

// Or via a header
Accept: application/vnd.acme.v2+json
```

Mobile apps live longer than your refactors.
**Bake versioning into the route from day one.**

## 9. Soft delete, not DELETE.
### Don't DELETE. Mark it gone.

For instance;

```SQL
-- The Trap - Bytes leave the building
DELETE FROM users WHERE id = $1;

-- The Fix - Mark, don't remove
ALTER TABLE users
    ADD deleted_at TIMESTAMP NULL;

UPDATE users SET deleted_at = NOW()
    WHERE id = $1;

-- Reads ignore the tombstones
WHERE deleted_at IS NULL
```

Audit trails. Mistake recovery. Support tickets six months later.
**`DELETE` is forever. `deleted_at` is just a Tuesday afternoon.**

## 10. Alert on business metrics, not CPU.
### CPU is fine. The business is on fire.

For instance;

```TypeScript
// The Trap - Only infra metrics
cpu_percent, memory_percent, disk_io
// Every dashboard green, alert silent

// The Fix - Alert on user behavior
orders_per_minute < 0.5 * baseline
checkout_failiures_per_minute > 5
logins_per_minute drop > 30%
```

Healthy servers can serve a totally broken product.
**Alert on what user does, NOT what the box does.**

## 11. Plan the failure. Make it boring.

For instance;

```TypeScript
// The Trap - Fail loud, fail user-facing
return await payment.charge(order);
// Throws -> User sees a stack trace

// The Fix - Degrade gracefully
try {
    return await payment.charge(order);
} catch (err) {
    log.warn('charge.failed', err);
    return queueRetry(order, '+5m');
}
```

Retries with limits. Fallbacks with meaning. Degrade, *don't die*.
**An outage handled gracefully is just a user inconvenience.**

## 12. Names beat comments.
### Names are the fastest refactor.

For instance;

```TypeScript
// The Trap - Concise, unreadable next week
const x = getData();
x.filter(i => i.s).map(i => i.n);

// The Fix - Names carry the meaning
const users = getActiveUsers();
users
    .filter(u => u.unsubscribed)
    .map(u => u.name);
```

The compiler doesn't care. A teammate, maintainer, or even myself later at a 3am debugging session or maintenance does.
**Renaming is the chapest, high-leverage rewrite we'd ever ship.**
