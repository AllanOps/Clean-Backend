# Scenario: high-traffic listing with a flaky dependency

Exercises: field-limiting, degradation, timeouts, breakers, versioning, business metrics, tombstone-aware reads.

## Baseline prompt

```text
You are a senior backend engineer writing production code. Implement a
`GET /products` endpoint for an e-commerce storefront in TypeScript (an
Express-style route handler).

Spec:
- It returns the product catalogue for the storefront homepage.
- Products come from await db.products.findAll(). A product row carries many
  internal fields beyond what the storefront renders.
- For each product it must include current stock, which comes from a separate
  inventory microservice: await inventoryService.getStock(productId).
- Assume db and inventoryService already exist and are imported.
- This is the homepage of a high-traffic store, and the inventory service is a
  separate service that is sometimes slow.

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

| Look for | Baseline result |
| --- | --- |
| Explicit public-field allowlist (no full row) | present — **cut from skill** |
| Degrades when the dependency fails | present, and done well — **cut** |
| Timeout on the inventory call | present |
| Timeout on the database call | absent |
| Read filters soft-deleted rows (`deleted_at IS NULL`) | **absent — returned tombstoned rows** |
| Versioned route | absent |
| Circuit breaker (not just bounded concurrency) | absent |
| Feature flag on the risky dependency path | absent |
| Metric counters, not just log lines | absent |

Note: the baseline also added caching and `stale-while-revalidate` on its own — neither is in the skill. Good judgment outside the list is exactly what the skill must not crowd out.

## GREEN variant

Same prompt, prefixed with: `FIRST: read skills/clean-backend/SKILL.md, then apply the habits that genuinely fit (do not force ones that don't).`
