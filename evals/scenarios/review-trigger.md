# Scenario: does a review prompt load the skill?

Exercises: skill selection, not content. The 2026-11 live trigger test loaded the skill for two *write this* backend tasks, and **not** for a terse *"Is this ready for production? Review it"* with pasted code. One miss is not a finding. This batch tests whether review-shaped prompts are a real blind spot.

## Protocol

- Live registry with the plugin installed, on a frontier model. No prompt names a skill, a plugin, or this repo.
- Every prompt is prefixed with: `The files in your current working directory are unrelated to this task: do not read, list, or search them.`
- The verdict comes from the `Skill` tool calls in the agent's **transcript**, not from what the agent says it did.

## Prompts

The six backend prompts vary in vocabulary on purpose. Two (B1, B2) contain none of the description's trigger words, two (B3, B4) contain some, and two (B5, B6) contain many.

**B1.** Is this ready for production? Review it and tell me what you'd change.

```ts
app.post('/invites', async (req, res) => {
  const invite = await db.invites.create({ email: req.body.email, orgId: req.body.orgId });
  await mailer.send(req.body.email, 'You are invited', inviteLink(invite.id));
  res.json(invite);
});
```

**B2.** Can you look this over before I merge it?

```ts
router.get('/reports/:id', async (req, res) => {
  const report = await db.reports.findById(req.params.id);
  const pdf = await pdfService.render(report);
  res.type('pdf').send(pdf);
});
```

**B3.** Review this endpoint. It calls our pricing service on every request.

```ts
app.get('/cart', async (req, res) => {
  const cart = await db.carts.findOne({ userId: req.userId });
  const priced = await pricingService.quote(cart.items);
  res.json({ ...cart, total: priced.total });
});
```

**B4.** Code review please. This runs in our background job worker.

```ts
queue.process('sync-crm', async (job) => {
  const contacts = await db.contacts.find({ updatedSince: job.data.since });
  for (const c of contacts) await crm.upsert(c);
});
```

**B5.** Review this payment refund handler before it goes to production. It writes to the database and calls Stripe.

```ts
app.post('/refunds', async (req, res) => {
  const order = await db.orders.findById(req.body.orderId);
  const refund = await stripe.refunds.create({ payment_intent: order.paymentIntentId });
  await db.orders.update(order.id, { status: 'refunded' });
  res.json({ refundId: refund.id });
});
```

**B6.** We're rolling this new search endpoint out to all users tomorrow. Review it for production readiness and on-call concerns.

```ts
app.get('/search', async (req, res) => {
  const hits = await searchCluster.query(req.query.q);
  const items = await db.items.findMany({ id: { in: hits.map((h) => h.id) } });
  res.json(items);
});
```

**Controls** (must not load the skill):

**C1.** Review this React component before I merge it.

```tsx
export function Avatar({ user }) {
  return <img src={user.avatarUrl} onClick={() => window.open(user.profileUrl)} />;
}
```

**C2.** Review this Python script that renames photos in a folder by their EXIF date.

```python
import os, exifread
for f in os.listdir('.'):
    tags = exifread.process_file(open(f, 'rb'))
    os.rename(f, str(tags['EXIF DateTimeOriginal']).replace(':', '-') + '.jpg')
```
