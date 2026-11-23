# Scenario: charge endpoint, provider does not deduplicate

Exercises: idempotency correctness when the model cannot lean on the payment provider.

This is [`charges.md`](charges.md) with exactly **one** added spec line. In the 2026-11 batch, two of three Sonnet 5.5 runs required an `Idempotency-Key` but never claimed it in their own store before charging. Each relied on the provider to deduplicate, which the original spec never promised. This variant removes that assumption, so the question becomes: *does the model claim the key itself before money moves?*

The added line states a fact about the dependency. It does not say what to do about it. A model that reads it and still charges before claiming the key is Present-but-not-Correct, with no assumption left to excuse it.

## Baseline prompt

```text
You are a senior backend engineer writing production code. Implement a
`POST /charges` endpoint for an e-commerce backend in TypeScript (an
Express-style route handler).

Spec:
- Request body: { customerId: string, amountCents: number, currency: string }
- It charges the customer through an async third-party client:
  await paymentProvider.charge({ customerId, amountCents, currency })
  which returns { chargeId }.
- The provider client accepts no idempotency key and does not deduplicate:
  every call to paymentProvider.charge() moves money.
- On success, persist the charge with await db.charges.insert(...) and email a
  receipt with await mailer.sendReceipt(customerId, chargeId).
- Assume paymentProvider, db, and mailer already exist and are imported.

Write it the way you genuinely would for real production traffic serving real
money — include whatever validation, error handling, helpers, and safeguards you
would actually put in. This is real production code, not a toy.

Return exactly two things:
1. The complete code in a single TypeScript block.
2. A short bulleted list titled "Production concerns I addressed".

IMPORTANT: Write this purely from your own engineering judgment. Do NOT read or
use any "backend practices" skill, plugin, or repo file, and do not search the
codebase — just write it as you normally would from scratch.
```

## What to score

Idempotency only, with the [`RUBRIC.md`](../RUBRIC.md) criteria for the cut practice. A run is **Correct** only if all four hold:

| Criterion | Fails when |
| --- | --- |
| The key is **required** | it is optional, or absent |
| It is **claimed before** `paymentProvider.charge()` | it is only looked up, or written after the charge |
| A completed key **replays** the original result | a repeat returns an error or charges again |
| The claim **fails closed** | an idempotency-store error leads to a charge anyway |

Score the shipped habits too, for the record. They do not feed this scenario's decision.
