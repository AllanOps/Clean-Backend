# Scenario: ship an order through a label provider (held-out)

Exercises: kill switch on an external state change, breaker failure classification, durable offload. Versioning, deadlines and counters are also scored.

**Held-out.** This scenario was written *after* the habit 2, 3 and 5 revisions and was never used to draft them. It has the same shape as [`charges.md`](charges.md) on a different surface:

- an external call that changes state in another service
- a documented business rejection that is not a dependency failure
- a notification the caller does not need to wait for
- no queue among the provided dependencies

Results here measure whether the revised wording generalises, not whether it fits the prompts it was written against.

## Baseline prompt

```text
You are a senior backend engineer writing production code. Implement a
`POST /orders/:id/ship` endpoint for an e-commerce backend in TypeScript (an
Express-style route handler).

Spec:
- It buys a shipping label from a third-party carrier API:
  await shippingProvider.createLabel({ orderId, address })
  which returns { trackingNumber }. It throws AddressRejectedError when the
  carrier refuses the address.
- On success, persist the shipment with await db.shipments.insert(...) and
  email the customer with await mailer.sendTracking(customerId, trackingNumber).
- The order (with customerId and address) comes from await db.orders.findById(id).
- Assume shippingProvider, db, and mailer already exist and are imported.

Write it the way you genuinely would for real production traffic — include
whatever validation, error handling, helpers, and safeguards you would actually
put in. This is real production code, not a toy.

Return exactly two things:
1. The complete code in a single TypeScript block.
2. A short bulleted list titled "Production concerns I addressed".

IMPORTANT: Write this purely from your own engineering judgment. Do NOT read or
use any "backend practices" skill, plugin, or repo file, and do not search the
codebase — just write it as you normally would from scratch.
```

## What to score

All seven habits with [`RUBRIC.md`](../RUBRIC.md). The three under test:

| Habit | Correct means |
| --- | --- |
| 2 Kill switch | A flag, readable at request time and flippable without a deploy, gates the label purchase |
| 3 Breaker | It wraps `shippingProvider` only, and `AddressRejectedError` does **not** count toward opening it |
| 5 Off the request path | The tracking email goes through a queue or an outbox row written in the same transaction; a detached promise is Present |

## GREEN variant

Same prompt, prefixed with: `FIRST: read skills/clean-backend/SKILL.md, then apply the habits that genuinely fit (do not force ones that don't).`
