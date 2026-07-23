# Scenario: money-moving charge endpoint

Exercises: idempotency, timeouts, validation, async offload, breakers, versioning, business metrics.

Run 4 times as a neutral baseline. Every hint about *which* practices matter is deliberately absent — the task says "production" and nothing more.

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

| Look for | Baseline result (4 runs) |
| --- | --- |
| `Idempotency-Key` required, deduped, replayed | present 4/4 — **cut from skill** |
| Input validation before any dependency call | present 4/4 — **cut** |
| Timeout on the provider call | present 4/4 |
| Timeout on the database call | absent |
| Receipt email moved off the request path | absent — awaited inline |
| Versioned route (`/v1/charges`) | absent 4/4 |
| Circuit breaker around the provider | absent 4/4 |
| Kill-switch flag on the endpoint | absent 4/4 |
| Metric counters, not just log lines | absent 4/4 |

## GREEN variant

Same prompt, prefixed with: `FIRST: read skills/clean-backend/SKILL.md, then apply the habits that genuinely fit (do not force ones that don't).`
