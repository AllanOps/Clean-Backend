# Evaluation

This skill ships only habits an AI assistant **fails to apply on its own**. That claim is worthless unless you can check it, so this directory holds the protocol, the exact prompts, the results, and the places our own method was wrong.

> **Evidence last refreshed: 2026-08-11** — Claude frontier and Haiku-class.
> Run records are in [`runs/`](runs/README.md). This date matters: see *When to re-measure*.

## Protocol

1. **RED (baseline).** Give a fresh model a neutral production-code task with **no skill loaded** and no hint about any specific practice. Ask for the code plus a list of "production concerns I addressed."
2. **GREEN.** Same task, with the skill loaded and applied.
3. **Diff.** Anything present in RED is something the model already does — it does not belong in the skill. Anything absent from RED and present in GREEN is a candidate.

The whole method rests on the prompts being genuinely neutral. Ours weren't, twice — see *Where we were wrong*.

## Scenarios

Committed so you can re-run them against your own model:

- [`scenarios/charges.md`](scenarios/charges.md) — a money-moving `POST /charges` endpoint
- [`scenarios/products.md`](scenarios/products.md) — a high-traffic `GET /products` listing with a flaky dependency
- [`scenarios/delete-document.md`](scenarios/delete-document.md) — a `DELETE /documents/:id` endpoint

## Results — frontier model

7 neutral baselines (charges ×4, products ×1, delete ×2).

| Practice | Neutral baselines applying it | Verdict |
| --- | --- | --- |
| API versioning | 0 / 7 | **shipped** — Part 1 |
| Feature flags | 0 / 7 | **shipped** — Part 1 |
| Circuit breakers | 0 / 7 | **shipped** — Part 1 |
| Timeouts on every I/O | partial — external call bounded, DB call not | **shipped** — Part 2 |
| Work off the request path | task-dependent | **shipped** — Part 2 |
| Business-metric counters | task-dependent | **shipped** — Part 2 |
| Tombstone-aware reads | delete path yes, read path no | **shipped** — Part 2 |
| Idempotency keys | 6 / 6 applicable | cut |
| Validation at the boundary | 7 / 7 | cut |
| Field-limited responses | 7 / 7 | cut |
| Graceful degradation | 7 / 7 | cut |
| Intention-revealing naming | 7 / 7 | cut |

The shape of the result: **code-hygiene and correctness practices are already reflexive; lifecycle and platform practices are not.** Nothing inside a single endpoint cues "version this," "flag this," or "break the circuit."

## First re-measurement (2026-08-11) — four claims weakened

The tables above are presence-scored and predate the rubric. The first rubric-scored batch — 4 neutral baselines, charges + products × frontier + Haiku, all verbatim in [`runs/2026-08-rubric-batch/`](runs/2026-08-rubric-batch/) — **contradicts four of them.**

Frontier baselines, scored Absent / Present / Correct:

| Habit | Published claim | charges | products | Status |
| --- | --- | --- | --- | --- |
| 1 Version the route | absent 0/7 | Absent | Absent | **holds** |
| 2 Feature flags | absent 0/7 | Absent | Absent | **holds** |
| 3 Circuit breaker | absent 0/7 | Absent | **Correct** | weakened |
| 4 Deadline on every I/O | external bounded, DB not | Present | **Correct** | weakened |
| 5 Off the request path | task-dependent | Present | n/a | holds |
| 6 Business counters | task-dependent | **Correct** | **Correct** | **significantly weakened** |
| 7 Tombstone-aware reads | read path missed | n/a | **Correct** | weakened |

The products run bounded `db.products.findAll()`, built a circuit breaker with a half-open probe that correctly excludes non-transport failures, filtered `deletedAt` on the read, and emitted per-outcome counters — all unprompted, all things the published tables record as gaps.

**Nothing has been cut on this evidence.** The [policy](#when-to-re-measure) requires a habit to score Correct *across repeated runs*, and n=2 is not that. But the direction is clear and it points at our own skill:

- **Habit 6 is the leading cut candidate** — Correct in both fresh frontier runs.
- **Habits 3, 4, and 7** each reached Correct once and need n ≥ 5 to settle.
- **Habits 1 and 2 are unshaken** — versioning and feature flags have now been absent in 9 of 9 neutral frontier baselines.

Two honest reads of the same data: either frontier behaviour has moved since the original batch, or run-to-run variance was always higher than aggregate counts revealed. This batch cannot distinguish them, and both argue for the same next step — re-measure 3, 4, 6, and 7 at higher n before deciding.

## Results — smaller model

The table above describes a frontier model. We re-ran the same three neutral scenarios on a small, fast model (Haiku-class, 4 runs) to see whether the cuts generalise.

**They do not.** The cut practices split in two:

| Cut practice | Frontier | Smaller model |
| --- | --- | --- |
| Validation at the boundary | reflexive | reflexive |
| Intention-revealing naming | reflexive | reflexive |
| Field-limited responses | reflexive | reflexive |
| Graceful degradation | reflexive | **present but materially wrong** |
| Idempotency keys | 6/6, thorough | **1/2, and the one that appeared fails open** |
| Soft delete | 2/2 | **0/1 — hard `DELETE`** |

Two failure modes, and the second is the dangerous one:

- **Absent.** The smaller model hard-deleted a row where every frontier run reached for a `deleted_at` tombstone, and omitted idempotency entirely on a money endpoint.
- **Present but hollow.** Where idempotency did appear it was optional (`idempotencyKey?`), it never reserved the key before charging, and the lookup **failed open** — if the idempotency store errored, it charged anyway. Its own summary sold this as a feature: *"graceful degradation where idempotency checks can fail without blocking the charge."* Likewise a listing endpoint collapsed unknown stock into `0`, rendering the entire catalogue out-of-stock whenever the inventory service was slow.

All seven shipped habits were absent across all four runs — unversioned routes, no flags, no breakers, no counters, unbounded DB calls.

**What this means for the skill.** The seven habits are *more* necessary on smaller models, not less. But the cuts were made against frontier behaviour, so **if you run this skill on a smaller model, idempotency and soft delete are no longer safe to assume.** Habits 1-7 remain correct for both tiers.

## Does it fire?

Content only matters if the skill gets loaded. We tested the description itself: present a model with a realistic skill menu — this skill's description alongside plausible decoys (frontend, debugging, TDD, planning) — give it a task, and ask only which skills it would load.

| Task | Loaded clean-backend? |
| --- | --- |
| `POST /orders` endpoint that writes a row and calls another service | yes |
| "Review our payments service for production readiness" (deliberately vague) | yes, and nothing else |
| Background worker emailing weekly digests | yes |
| Responsive React pricing table (control) | **no** — explicitly excluded as "no HTTP endpoints, DB, or jobs" |

Sensitivity 3/3, specificity 1/1. Each backend hit cited a different trigger phrase from the description, so the enumerated triggers are doing real work.

**What this does not prove:** it measures description-driven *selection* from an explicit menu, which is a proxy for the plugin runtime rather than the runtime itself, with n=4 and a short decoy list. A registry with dozens of competing skills is a harder test than this one.

### Live registry (2026-08-11)

The menu proxy above was re-run against the **installed plugin** in a registry of roughly a hundred real skills. No skill was mentioned in any prompt; each agent was asked afterwards to list what it had consulted.

| Task | Loaded clean-backend? |
| --- | --- |
| "Implement a `POST /orders` endpoint..." | **yes** — loaded `clean-backend:clean-backend` v2.0.0 from the plugin cache |
| "Our payments service goes live next week, give me a production-readiness review" | **yes** — attributed six of the seven habits by name in its output |
| Responsive React pricing table (control) | **no** — *"loading it would have meant applying idempotency keys and circuit breakers to a pricing card"* |

Sensitivity 2/2, specificity 1/1, against the real registry rather than a curated menu.

**Confounds, both real:**

- **The agents' working directory was this repo.** A repo named for the skill plausibly primes selection toward it. That cuts against the two positives — but it makes the control *stronger*, since the priming worked against abstention and it abstained anyway with explicit reasoning.
- **The `POST /orders` run also read [`RUBRIC.md`](RUBRIC.md) and the run artifacts**, and credited them for the stricter bar it applied ("why the breaker ignores business rejections, why fulfilment goes to a durable outbox rather than a floating promise"). Its output quality is therefore *skill + rubric + artifacts*, not the skill alone. The trigger result stands; the quality is not skill-attributable.

A clean version of this test runs from a directory unrelated to this repo, with the eval material out of reach.

## Does it over-apply?

A skill that adds ceremony where none is warranted makes code worse. Every test above measures under-application; this one measures the opposite. Two tasks where most of the habits would be wrong, run **with the skill loaded**:

| Task | Result |
| --- | --- |
| An internal `GET /internal/queue-depth`, single consumer, deployed atomically with its only caller | Skipped versioning, flags, and breakers — each citing the matching `Skip it when`. Applied the DB deadline and a gauge. |
| A one-off backfill script to be run once from a laptop and deleted | Skipped versioning, breakers, and offload. Adapted flags into dry-run-by-default plus `--apply`, and counters into stdout tallies plus exit codes. |

**Neither run over-applied a habit.** The skip conditionals hold under the conditions they name.

Two things worth noting beyond the pass:

- **Adaptation, not ritual.** Habits 2 and 6 have no skip clause covering a CLI script. Rather than bolting on a feature flag and a `metrics.increment` that "goes nowhere" from a laptop, the run preserved each habit's *purpose* in a form that fit — rollback-without-redeploy became a dry run; alertable counters became exit codes. That is the "apply in addition to your own judgment" framing working as intended.
- **It out-scored the baselines on habit 4.** The script bounded the database both server-side (`statement_timeout`, which actually cancels) and client-side (a backstop for a wedged connection), ordered so the server wins and you get a real error. That is `Correct` under [`RUBRIC.md`](RUBRIC.md); most frontier baselines only reached `Present`.

## Habits we looked for and did not find

We hunted for an eighth habit in the two task shapes with the most lifecycle character. Both came back empty, on a frontier model:

- **A column rename on a hot table.** Candidate: expand/contract. The baseline went straight to it unprompted — four migrations, bidirectional sync triggers so old and new pods can both write during a rolling deploy, batched backfill with `FOR UPDATE SKIP LOCKED`, `CREATE INDEX CONCURRENTLY` with invalid-index cleanup, `lock_timeout` on every DDL, a drift check, and a refusal to contract if the columns ever diverged. No gap.
- **A Stripe webhook receiver.** Candidates: signature verification, replay protection, retry semantics. All present unprompted, including the subtle one — 5xx only for transient failures so the provider backs off, 200 for duplicates and permanently-broken payloads so retries aren't burned for three days. No gap.

Publishing the empty result matters: at this task-shape resolution, seven is the whole set. We would rather stop than pad.

**One refinement these hunts did produce.** The migration baseline reached for a feature flag on its own, to make the read-switch a config change rather than a redeploy. Habit 2 is listed in Part 1 as absent from every baseline — accurate for tasks that are *write this endpoint*, but not unconditional. **When the task itself is a risky rollout, the model reaches for flags without prompting.** The habit still earns its place, because writing a feature is the common case and the flag never appeared there.

## Where we were wrong

Published because a method you can't see the failures of isn't evidence.

1. **We predicted idempotency would be the biggest gap. On the frontier model it was the most reliably present practice.** On a neutral money-moving endpoint the baseline required an `Idempotency-Key`, deduped before charging, replayed completed results, forwarded the key to the provider, and handled the charged-but-not-persisted case — in 4 of 4 runs. Our single strongest hypothesis was wrong, and it's why the skill no longer mentions idempotency. (On a smaller model that finding reverses — see *Results — smaller model*.)
2. **Two prompts leaked their own answers.** A delete task that mentioned a "Trash / restore feature" and a rollout task that asked "how I shipped this safely" both told the model what to reach for. Soft-delete and feature-flags briefly looked reflexive as a result. The delete scenario was re-run neutrally (soft-delete: still reflexive on frontier, 2/2); the rollout scenario's flag result was discarded in favour of the neutral baselines, where flags appear 0/7.
3. **Our first classification was too clean.** We initially called it a tidy six-versus-six split. The neutral re-runs showed the real line is not "can versus can't" — the model can do all of it — but **"never" versus "only when the task cues it."** That distinction produced the two-part structure.
4. **We scored presence, not correctness.** Every verdict in the tables above asks "did the practice appear," not "was it implemented correctly." On the frontier model the distinction rarely mattered; the implementations were genuinely good. On a smaller model it is the entire story — a fail-open idempotency check and a stock field that reads `0` for "unknown" both *appear* as ticked boxes and are both wrong in ways that cost money. [`RUBRIC.md`](RUBRIC.md) now grades Absent / Present / Correct, with every correctness criterion drawn from a failure we actually observed. The tables above predate it and remain presence-scored; re-scoring them is open work.

## Re-running it

There is no CI-runnable test here, and pretending otherwise would be dishonest: a run means putting the prompt to a model and reading the output. To reproduce:

1. Open a scenario file and paste its **Baseline prompt** into a fresh session with no skill loaded.
2. Score the output with [`RUBRIC.md`](RUBRIC.md) — Absent / Present / Correct for each practice, keeping the line that decided each call.
3. Repeat with the skill loaded and diff.

Report both numbers: how many practices reached Present, and how many reached Correct. The gap between them is usually the interesting part.

## When to re-measure

**This evidence has a shelf life.** The skill's whole thesis — ship only what the model misses — is measured against a moving target. Every model release can turn a habit into a no-op, and a habit that has quietly become reflexive is exactly the dead weight this project was built to delete. A skill that stops being re-measured keeps *looking* evidence-backed while ceasing to be.

**Re-measure when:**

- A major model release ships, or the model you actually run this against changes.
- A contributor reports a habit now being applied unprompted.
- The refresh date above is more than a couple of model generations old.

**What a result means:**

| Baseline result for a shipped habit | Consequence |
| --- | --- |
| Still Absent or Present-not-Correct | Habit stays. Update the refresh date. |
| Now **Correct**, unprompted, across repeated runs | **Cut the habit.** Same bar that removed the original five. |

Cutting is the success case, not a regression. The skill getting shorter as models improve is the design working.

Report a result with the [re-measurement issue template](https://github.com/AllanOps/Clean-Backend/issues/new/choose) — including a result that argues for a cut.

## Caveats

- **One model family, two tiers, one point in time.** Frontier results come from a current frontier Claude; the smaller-model results from a Haiku-class model. Other vendors are untested.
- **Small n.** 7 neutral frontier baselines and 4 smaller-model runs are enough to separate 0/7 from 7/7 with confidence; they are not enough for fine distinctions.
- **Presence, not quality.** See *Where we were wrong* #4.
- **GREEN runs were instructed to apply the skill.** That proves the content is inducible. Triggering was measured separately (see *Does it fire?*), but via a menu-selection proxy rather than the live plugin runtime.
