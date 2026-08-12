# 2026-07 runs — attested records

> **These are attested records, not transcripts.** They are scored observations
> recorded while the runs happened, written up afterwards. The full model outputs
> were not retained. Trust these for the verdicts and the specific behaviours
> quoted; do not treat them as verbatim output.
>
> This gap is why the [capture protocol](../README.md#capture-protocol) exists.
> Everything from 2026-08 onward is verbatim.

All runs used the prompts now committed in [`../../scenarios/`](../../scenarios/).
Scoring here is **presence-based** — it predates [`../../RUBRIC.md`](../../RUBRIC.md).

## Frontier baselines (7 runs)

charges ×4, products ×1, delete ×2. No skill loaded.

| Practice | Runs applying it | Behaviour recorded |
| --- | --- | --- |
| API versioning | 0/7 | Every route unversioned: `POST /charges`, `GET /products`, `DELETE /documents/:id`. |
| Feature flags | 0/7 | No kill switch on any endpoint. |
| Circuit breakers | 0/7 | Bounded concurrency and retries appeared; a breaker never did. One run named breakers as future work and implemented a worker pool instead. |
| Timeouts | partial | The external call was bounded in every run; the database call was not. |
| Work off request path | task-dependent | The delete runs used a transactional outbox; the charges runs awaited `mailer.sendReceipt` inline. |
| Business counters | task-dependent | The delete runs emitted per-outcome counters; the charges and products runs logged only. |
| Tombstone-aware reads | mixed | The delete write path tombstoned 2/2; the products **read** returned soft-deleted rows. |
| Idempotency | 6/6 applicable | Mandatory key, replay, provider pass-through, unique-constraint race handling, and correct money-moved-persist-failed ordering. |
| Validation | 7/7 | Type narrowing, bounds, currency allowlists. |
| Field-limiting | 7/7 | Explicit public DTOs; never a raw row. |
| Graceful degradation | 7/7 | Stale-then-unknown fallbacks; failures never 500'd the page. |
| Naming | 7/7 | Intention-revealing throughout. |

Two runs also added caching and `stale-while-revalidate` unprompted — neither is in the skill.

## Haiku-class baselines (4 runs)

charges ×2, products ×1, delete ×1. No skill loaded.

| Practice | Recorded |
| --- | --- |
| Validation, naming, field-limiting | Applied in every run. |
| Graceful degradation | Present but wrong on products: failed stock lookups collapsed to `stock: 0, inStock: false`, rendering the catalogue sold out during an inventory blip. |
| Idempotency | One run omitted it entirely. One accepted `idempotencyKey?` as optional and, on a lookup error, **logged a warning and charged anyway** — described in its own summary as "graceful degradation." |
| Soft delete | Hard `db.documents.delete(...)`. No tombstone. |
| All seven shipped habits | Absent in all four runs. |

## Trigger tests (4 runs)

Menu-selection proxy: the skill's description alongside five plausible decoys.

| Task | Loaded clean-backend? |
| --- | --- |
| `POST /orders` writing a row and calling another service | yes |
| "Review our payments service for production readiness" | yes, and nothing else |
| Background worker emailing weekly digests | yes |
| Responsive React pricing table (control) | no — "no HTTP endpoints, DB, or jobs" |

## Over-application tests (2 runs)

Skill loaded, on tasks where most habits would be wrong.

| Task | Recorded |
| --- | --- |
| Internal `GET /internal/queue-depth`, single consumer, atomic deploy | Skipped versioning, flags, breakers — each citing the matching `Skip it when`. Applied the DB deadline and a gauge. |
| One-off backfill script, run once from a laptop | Skipped versioning, breakers, offload. Adapted flags into dry-run-by-default plus `--apply`, counters into stdout tallies plus exit codes. Bounded the DB both server-side (`statement_timeout`) and client-side. |

Neither over-applied a habit.

## Known confounds

Two prompts in this batch leaked their own answers and were corrected:

- The delete task originally mentioned a "Trash / restore feature" and accidental-deletion support tickets. Re-run neutrally; soft-delete remained reflexive on frontier (2/2).
- A rollout task asked "how I shipped this safely." Its feature-flag result was discarded in favour of the neutral baselines.

The committed scenarios are the corrected versions.
