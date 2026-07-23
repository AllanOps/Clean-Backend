# Scenario: delete endpoint

Exercises: soft delete, authorization, idempotency, versioning, business metrics.

This scenario exists in a **corrected** form. Our first version mentioned a "Trash / restore feature" and support tickets about accidental deletion — which handed the model the answer and made soft-delete look like something the skill had taught. The prompt below removes every such hint.

## Baseline prompt

```text
You are a senior backend engineer writing production code. Implement a
`DELETE /documents/:id` endpoint for a document-management SaaS backend in
TypeScript (an Express-style route handler).

Spec:
- The authenticated user (available as req.userId) deletes one of their
  documents by id.
- Assume db.documents already exists with the usual query methods, and a
  document row has an ownerId.
- This serves real production traffic.

Write it the way you genuinely would ship it for production — include whatever
checks, error handling, helpers, and safeguards you would actually put in. This
is real production code, not a toy.

Return exactly two things:
1. The complete code in a single TypeScript block.
2. A short bulleted list titled "Production concerns I addressed".

IMPORTANT: Write this purely from your own engineering judgment. Do NOT read or
use any "backend practices" skill, plugin, or repo file, and do not search the
codebase — just write it as you normally would from scratch.
```

## What to score

| Look for | Baseline result (2 neutral runs) |
| --- | --- |
| Soft delete rather than row removal | present 2/2 — **cut from skill** |
| Ownership enforced without a TOCTOU window | present 2/2 — **cut** |
| Re-delete is idempotent | present 2/2 — **cut** |
| Side effects via transactional outbox | present 2/2 |
| Metric counters per outcome | present 2/2 |
| Timeout on the database calls | absent 2/2 |
| Versioned route | absent 2/2 |
| Feature flag on the risky path | absent 2/2 |

The delete *write* path is reflexive. The gap is on the **read** side — see the products scenario, where a listing returned soft-deleted rows.

## GREEN variant

Same prompt, prefixed with: `FIRST: read skills/clean-backend/SKILL.md, then apply the habits that genuinely fit (do not force ones that don't).`
