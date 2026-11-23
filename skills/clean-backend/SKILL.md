---
name: clean-backend
description: Use when designing, writing, or reviewing backend code — HTTP endpoints, payment or state-changing flows, database reads and writes, calls to other services, background jobs, rolling out a risky change, or production alerting and on-call.
license: MIT
---

# Clean Backend

The operational habits that don't surface from inside the code in front of you.

Every practice here was measured missing from real baseline output. The practices
that showed up reliably without prompting were removed — see *Deliberately not
covered* at the end. Apply these **in addition to** your own engineering judgment;
they are a floor to add, not a checklist that replaces what you already do well.

## Part 1 — Absent from every baseline

Three lifecycle decisions. Nothing inside a single endpoint cues them, which is
exactly why they get skipped.

### 1. Version the route from day one

```TypeScript
// Measured: the route ships unversioned, every time.
POST /charges
GET  /products

// Fill the version slot.
POST /api/v1/charges
GET  /api/v1/products
```

Mobile clients outlive your refactors. An unversioned route turns the first
breaking change into a coordinated migration.

**Skip it when** the service has exactly one consumer that you deploy atomically
with it.

### 2. Deploying is not releasing

```TypeScript
// Measured: a new money-moving endpoint ships live, with no way to turn it off.
router.post('/api/v1/charges', createCharge);

// A kill switch, read on every request, that you can flip without a deploy.
router.post('/api/v1/charges', (req, res) =>
  flags.isOn('charges.enabled')
    ? createCharge(req, res)
    : res.status(503).set('Retry-After', '60').json({ error: 'temporarily disabled' }));
```

A path that moves money or changes state in another service ships behind a kill
switch, including a brand-new endpoint with no old path to fall back to. Off
means a clean 503 instead of an emergency deploy at 3am. When you replace an
existing path, gate the new version and keep the old one as the fallback.

**Skip it when** the path only reads, or only writes your own database, or the
change has no behavioral surface — a pure refactor or a typo fix. Flagging those
only creates flag debt.

### 3. Break the circuit before you retry

```TypeScript
// Measured: bounded concurrency and retries appear; a breaker never does.
while (!ok) await inventory.get(id);

// Fail fast once the dependency is known-sick.
if (breaker.isOpen()) return fallback();
if (!bucket.take())   return backoff();

// Count only transport failures toward opening it.
try {
  const result = await provider.charge(req);
  breaker.recordSuccess();
  return result;
} catch (err) {
  if (isDecline(err) || isClientError(err)) breaker.recordSuccess(); // the dependency answered
  else breaker.recordFailure();                                      // timeout, reset, 5xx
  throw err;
}
```

Retrying into a struggling dependency is how one slow service becomes two dead
ones. A card decline, a 4xx, or a not-found is a healthy dependency saying no;
counting it lets a wave of declines take your endpoint down while the provider
is fine.

**Skip it when** the call has no downstream service. A breaker around your own
primary database usually converts a slow query into an outage.

## Part 2 — Present only when the task cues them

You already reach for these when the task makes them obvious. The gap is the
quiet case, so make them unconditional.

### 4. Every I/O gets a deadline, including the database

```TypeScript
// Measured: the scary external call gets a deadline; the database call doesn't.
await withTimeout(paymentProvider.charge(order), 8_000);
await db.charges.insert(row);              // unbounded

// Both cross a process boundary. Both get one.
await withTimeout(db.charges.insert(row), 800);
```

The hung dependency that takes you down is the one nobody thought could hang.

### 5. Anything the caller doesn't await leaves the request path

```TypeScript
// Measured: the receipt email is awaited inline, on the user's latency budget.
await mailer.sendReceipt(customerId, chargeId);

// Hand it to a worker and return the receipt now.
await queue.enqueue('receipt.send', { customerId, chargeId });

// No queue in reach? Your database is one: write an outbox row in the same
// transaction as the record, and let a worker drain it. The worker's claim and
// mark-done calls are I/O too: give them the same deadlines as the handler.
await db.transaction(async (tx) => {
  await tx.charges.insert(row);
  await tx.outbox.insert({ type: 'receipt.send', payload: { customerId, chargeId } });
});
```

Email, PDFs, webhooks, search indexing, thumbnails — none of it belongs in the
response. A detached promise (`void send().catch(log)`) leaves the request path
but not durably: a restart loses it, so it is the inline call with the failure
hidden.

### 6. Emit the counter, not just the log line

```TypeScript
// Measured: rich structured logs, and nothing you can alert on.
log.error('charge.failed', { err });

// A log is forensics after the fact. A counter is a page during it.
log.error('charge.failed', { err });
metrics.increment('charge.failed');
```

Alert on charges per minute and checkout failures per minute, not CPU. Healthy
servers happily serve a broken product.

### 7. Every read filters tombstones

```SQL
-- Measured: the delete path tombstones correctly, then a read forgets.
SELECT * FROM products WHERE active = true;      -- returns deleted rows

-- The tombstone only means anything if every read respects it.
SELECT * FROM products WHERE active = true AND deleted_at IS NULL;
```

Soft delete is a read-side discipline. Stamping `deleted_at` is the easy half.

**Skip it when** the read is an idempotency or audit lookup. A tombstoned row is
still proof the key was spent; hiding it lets a retry charge the customer twice.

## Deliberately not covered

Field-limited responses, validation at the boundary, idempotency keys, graceful
degradation, and intention-revealing naming are **not** in this skill. Each was
measured across baseline runs and applied reliably without any prompting —
including complete idempotency on money-moving endpoints in every single run.
Carrying them here would spend your context restating what you already do, and
crowd out the seven above.
