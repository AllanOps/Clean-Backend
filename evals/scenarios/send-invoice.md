# Scenario: issue an invoice through an e-invoicing provider (held-out)

Exercises: kill switch on an external state change, breaker failure classification, durable offload, and deadlines on everything including any worker. Versioning and counters are also scored.

**Held-out.** This scenario was written *after* the habit 5 one-liner, and nobody had seen it before this batch. It replaces [`ship-order.md`](ship-order.md) as the held-out task, because ship-order has already been scored. It has the same shape on a different surface:

- an external call that changes state in another service
- a documented business rejection that is not a dependency failure
- a follow-up the caller does not need to wait for, here a webhook rather than an email
- no queue among the provided dependencies

## Baseline prompt

```text
You are a senior backend engineer writing production code. Implement a
`POST /invoices/:id/issue` endpoint for a B2B billing backend in TypeScript
(an Express-style route handler).

Spec:
- It registers the invoice with a government e-invoicing provider:
  await eInvoicing.register({ invoiceId, buyerTaxId, totalCents, currency })
  which returns { registrationNumber }. It throws InvoiceRejectedError when the
  provider rejects the invoice data.
- On success, persist the result with await db.invoiceRegistrations.insert(...)
  and notify the buyer's accounting system with
  await webhooks.deliver(buyerId, { type: 'invoice.issued', invoiceId, registrationNumber }).
- The invoice (with buyerId, buyerTaxId, totalCents, currency) comes from
  await db.invoices.findById(id).
- Assume eInvoicing, db, and webhooks already exist and are imported.

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

All seven habits with [`RUBRIC.md`](../RUBRIC.md). The four under test:

| Habit | Correct means |
| --- | --- |
| 2 Kill switch | A flag, readable at request time and flippable without a deploy, gates the registration call |
| 3 Breaker | It wraps `eInvoicing` only, and `InvoiceRejectedError` does **not** count toward opening it |
| 4 Deadlines | Every database and provider call is bounded, **including** any worker or drain code the run writes |
| 5 Off the request path | The webhook goes through a queue or an outbox row written in the same transaction; a detached promise is Present |

## GREEN variant

Same prompt, prefixed with: `FIRST: read skills/clean-backend/SKILL.md, then apply the habits that genuinely fit (do not force ones that don't).`
