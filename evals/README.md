# Evaluation

This skill ships only habits an AI assistant **fails to apply on its own**. That claim is worthless unless you can check it, so this directory holds the protocol, the exact prompts, the results, and the places our own method was wrong.

> **Evidence last refreshed: 2026-11-22** — Claude Sonnet 5.5 (frontier) and Haiku 5.5. Previous refresh: 2026-08-11, Claude 4 generation.
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

The next section did exactly that, on the next model generation.

## Results — 2026-11 (Claude 5)

A pre-registered batch: the batch definition and the cut rule were committed before any run was scored (see [*Pre-registered*](#pre-registered-the-2026-11-re-measurement)). It covers 12 neutral baselines, all verbatim in [`runs/2026-11-remeasure/`](runs/2026-11-remeasure/). These numbers are **never pooled** with the Claude 4 generation results above.

### Frontier — Sonnet 5.5, 7 runs

| Habit | Present or better | **Correct** | Cut rule (Correct in ≥ 80% of ≥ 5) |
| --- | --- | --- | --- |
| 1 Version the route | 0 / 7 | **0 / 7** | stays |
| 2 Feature flags | 0 / 7 | **0 / 7** | stays |
| 3 Circuit breaker | 3 / 6 | **3 / 6**: products 3/3, charges 0/3 | stays |
| 4 Deadline on every I/O | 6 / 7 | **0 / 7**: the database was unbounded in every run | stays |
| 5 Off the request path | 1 / 3 | **0 / 3**: the one Present was a floating promise | stays; extra runs not triggered |
| 6 Business counters | 0 / 7 | **0 / 7**: not one metrics call | stays |
| 7 Tombstone-aware reads | 2 / 3 | **2 / 3** | stays; n < 5, extra runs not triggered |

**Nothing is cut.** The skill is unchanged.

**The 2026-08 weakening did not replicate.**

- That batch made habit 6 the leading cut candidate. On Sonnet 5.5 it is absent in all seven runs.
- That batch's products run bounded the database. Here all seven runs leave it unbounded, which is the canonical failure the habit was written for.
- Only the breaker held up: Sonnet 5.5 builds a correct one around a dependency the task calls "sometimes slow" (3/3), and never around a payment provider the task does not flag (0/3). That is the Part 2 pattern exactly: present when the task cues it.

The 2026-08 products run now looks like the variance read was right: one unusually thorough run, not a shift in behaviour. Habits 1 and 2 are now absent in **16 of 16** neutral frontier baselines across two model generations.

### Smaller tier — Haiku 5.5, 5 runs

| Habit | Present or better | Correct |
| --- | --- | --- |
| 1, 2, 3, 6 | 0 of every applicable run | 0 |
| 4 Deadline on every I/O | 4 / 5 | 0 / 5 |
| 5 Off the request path | 0 / 2 | 0 / 2 |
| 7 Tombstone-aware reads | 0 / 2 | 0 / 2 |

On the cut practices, **Haiku 5.5 does not repeat the Claude 4-generation failures** described under *Results — smaller model*:

- **Idempotency:** the key was required in 2/2 runs, and neither failed open. One run claimed the key before charging (Correct). The other relied on the provider to dedupe (Present).
- **Soft delete:** 1/1, applied correctly.
- **Degradation:** 2/2 Correct. Unknown stock stays `null` / `"unknown"` and is never collapsed to `0`.

The sample is small (2 + 1 + 2 runs). It is still enough to stop asserting the old smaller-tier warning for this model.

### A frontier Present-but-not-Correct, on a cut practice

[CONTRIBUTING](../CONTRIBUTING.md) says a frontier Present-but-not-Correct ships. This batch produced the first one, so it is recorded here rather than buried.

- **What we saw:** idempotency reached Correct in 1 of 3 Sonnet 5.5 charges runs. The other two required the key and forwarded it to the provider, but never claimed it in their own store before the charge. One looked the key up and inserted afterwards, so two concurrent first requests both reach the provider.
- **Why it ships nothing yet:** both runs stated an assumption the spec does not support, that the provider dedupes on the key. Under that assumption no money is lost, so this is a gap in the letter of [`RUBRIC.md`](RUBRIC.md), not yet a demonstrated failure.
- **How it was settled:** a pre-registered follow-up, [`scenarios/charges-no-dedupe.md`](scenarios/charges-no-dedupe.md), adds one line stating that the provider does not deduplicate. Sonnet 5.5 scored **Correct in 5 of 5** runs ([records](runs/2026-11-followups/)). Every run claimed the key in its own unique-indexed store before calling the provider, refused the request when the store errored, and replayed completed keys. Several also recorded an ambiguous provider outcome as `unknown` and refused to re-charge it.
- **Closed.** The 2026-11 gap was the model relying on a guarantee the spec left open, not a failure to implement idempotency. Idempotency stays cut on the frontier tier.

### Deviations from the pre-registration

- **Run date.** The batch was pre-registered on 2026-11-19 and run on 2026-11-22.
- **Isolation mechanism.** The harness could not start agents in a different directory. Each agent was instead allowed exactly one tool call, a Write of its answer to a scratch directory. The transcripts confirm no agent read, listed, or searched any file, and none loaded a skill. This is stricter than the registered mechanism, but it is a change.
- **A capture gap.** One agent (Haiku 5.5, delete) skipped the Write and returned its answer as a message. That message was extracted from the transcript programmatically; its record says so.
- **The trigger test's pass bar was not pre-registered.** The 3/3 and 0/2 bar for the live trigger test lived in a private plan file. It was never committed before the run, so that test was effectively judged after the fact. The follow-up review batch below fixed this, since its bar was committed in 180fda4 before any run.
- **Scoring was not blind.** One scorer graded every run knowing the hypotheses, and that scorer is the same model family as the models under test. Every deciding line is quoted from the verbatim output, so each call can be checked, but no independent second rater was used. This is the largest uncontrolled bias in the batch.

## Results — with the skill on Claude 5 (2026-11-22)

This is the GREEN half of the 2026-11 batch. It used the same scenarios and the same Sonnet 5.5, with SKILL.md read first, and the delivery rule was committed before any run ([*Pre-registered*](#pre-registered-with-skill-green-runs-on-claude-5)). There were 7 runs, verbatim in [`runs/2026-11-green/`](runs/2026-11-green/). Each transcript shows exactly one Read, of `SKILL.md`, and one Write.

| Habit | Baseline Correct | **With skill Correct** | Delivered (≥ 80%)? |
| --- | --- | --- | --- |
| 1 Version the route | 0 / 7 | **7 / 7** | **yes** |
| 2 Feature flags | 0 / 7 | **0 / 7**: declined in every run | **no** |
| 3 Circuit breaker | 3 / 6 | **3 / 6**: products 3/3, charges 0/3 | **no** |
| 4 Deadline on every I/O | 0 / 7 | **7 / 7**: the database was bounded every time | **yes** |
| 5 Off the request path | 0 / 3 | **0 / 3**: Present 3/3, never durable | **no** |
| 6 Business counters | 0 / 7 | **7 / 7** | **yes** |
| 7 Tombstone-aware reads | 2 / 3 | **3 / 3** | **yes** |

**The skill works for four habits and falls short on three.** Habits 1, 4, 6 and 7 go from nearly absent to Correct in every run. Those include the two strongest baseline gaps, the database deadline and counters. The three shortfalls have one shared cause: in each, the model followed the text of the habit, and the text stops short of what the rubric requires.

- **Habit 2: flags were declined in all 7 runs.**
  - The charges runs gave the reason *"new endpoint, no old path to fall back to"*.
  - The habit's only example is a V1-to-V2 swap. Its skip clause covers only *"no behavioral surface"*, which does not cover a new endpoint.
  - The model treated a flag as a way to switch between two paths. It did not treat it as a kill switch for a new one.
- **Habit 3: the charges breakers trip on card declines.**
  - In all three charges runs, every provider error calls `failure()`, including a decline. A wave of declines from a healthy provider would open the breaker and take the endpoint down.
  - The habit text never mentions which failures count. The Claude 4-generation GREEN runs made this distinction unprompted; Sonnet 5.5 does not.
- **Habit 5: the receipt left the request path but not durably.**
  - All three charges runs used a detached `void ... .catch()`, and each noted it would use a queue if one existed. The spec provides only `db` and `mailer`.
  - The habit's only example is `queue.enqueue`. Nothing tells the model that an outbox row in the existing database is the durable option when there is no queue.

**No over-application.** No run put a breaker on the database. The only idempotency lookup that addressed tombstones explicitly left them unfiltered, and the delete run declined a breaker with the correct skip reason.

**Consequence, per the pre-registration:** habits 2, 3 and 5 are **wording revision candidates**. Nothing has been revised yet. Any revision must re-run this batch before it ships.

## Results — smaller model

> **Generation note.** This section describes a Claude 4-generation Haiku-class model. Haiku 5.5 behaves differently on the cut practices; see *Results — 2026-11 (Claude 5)*.

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

### Live registry, clean (2026-11-22)

Re-run on Sonnet 5.5 with both confounds closed. Every prompt told the agent the working directory was unrelated and not to read it, and the transcripts confirm none did. Verdicts come from the actual `Skill` tool calls in each transcript, not from the agent's report: [`runs/2026-11-remeasure/trigger-test.md`](runs/2026-11-remeasure/trigger-test.md).

| Task | Loaded clean-backend? |
| --- | --- |
| `POST /orders/:id/cancel` with a refund | **yes** |
| *"Is this ready for production? Review it"* followed by a 6-line handler | **no** |
| Queue worker calling an external geocoder | **yes** |
| React tag-input component (control) | no |
| CSS sticky footer (control) | no |

**Sensitivity 2/3, specificity 2/2. This misses the 3/3 bar the plan set.** That bar was not pre-registered; see *Deviations from the pre-registration*. The follow-up below settles it.

### Review-shaped prompts (2026-11-22, pre-registered)

Six backend review prompts at three vocabulary levels, plus two controls, with the pass bar committed before any run: [`scenarios/review-trigger.md`](scenarios/review-trigger.md), [record](runs/2026-11-followups/review-trigger.md).

| Vocabulary | Backend prompts loading the skill |
| --- | --- |
| None ("Is this ready for production? Review it", "look this over before I merge") | 2 / 2 |
| Some ("calls our pricing service", "background job worker") | 2 / 2 |
| Many ("payment refund... Stripe", "rollout... on-call") | 2 / 2 |
| Controls (React component, Python script) | 0 / 2 |

**Sensitivity 6/6, specificity 2/2. Passes.**

- **The earlier miss did not reproduce.** Its exact framing loaded the skill here, so the earlier miss reads as run-to-run selection variance, not a blind spot.
- **Across both trigger runs that day:** 8 of 9 backend prompts loaded the skill, and 0 of 4 controls did.
- **The description is unchanged.**

- **The miss:** a terse review prompt with pasted code and no backend vocabulary. The 2026-08 review prompt that did trigger named a "payments service" and a "production-readiness review".
- **What it suggests:** selection is reliable when the task is to *write* backend code, and weaker for an unadorned review.
- **What happens next:** one prompt is not enough to justify changing the description. That waits for a review-shaped batch.

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
5. **Two runs nearly moved us.**
   - A single thorough frontier run in 2026-08 made habit 6 look ready to cut, and three more habits look weak. We wrote that up as *"significantly weakened."*
   - The pre-registered n=7 batch in 2026-11 found habit 6 absent in every run.
   - We did not cut at n=2, and that restraint is the only reason the skill is still intact. The cut threshold is now committed before results are seen.

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

### Pre-registered: the 2026-11 re-measurement

Written and committed on 2026-11-19, **before any 2026-11 run was scored**, so the rule cannot be fitted to the results.

- **Trigger:** the Claude 5 family shipped after the 2026-08 refresh.
- **Models:** Sonnet 5.5 (frontier tier, comparable to the earlier Sonnet-class records) and Haiku 5.5 (smaller tier). Results are reported per generation and never pooled with 2026-08.
- **Runs:** neutral baselines from [`scenarios/`](scenarios/), prompts unchanged. Sonnet 5.5: charges ×3, products ×3, delete-document ×1. Haiku 5.5: charges ×2, products ×2, delete-document ×1. Habits 5 and 7 get two extra Sonnet runs each only if their first three are all Correct.
- **Isolation:** agents run from a directory unrelated to this repo and are told not to read repo files, so they cannot see the skill, rubric, or earlier runs.
- **Cut rule:** a shipped habit is cut if its **Sonnet 5.5** baseline scores **Correct in at least 80% of at least 5 applicable runs**. Present-but-not-Correct counts as not Correct. Haiku results never trigger a cut.

### Pre-registered: two follow-ups to the 2026-11 batch

Written on 2026-11-22, after the 2026-11 batch was scored and **before either follow-up was run**. Both follow-ups use Sonnet 5.5, with the same isolation as that batch: each agent's transcript must show no Read, Glob, Grep, or Bash call. Both settle questions that batch left open.

**A. Idempotency without provider dedupe.**

- **Scenario:** [`scenarios/charges-no-dedupe.md`](scenarios/charges-no-dedupe.md), run ×5. It is the charges prompt plus one line stating that the provider does not deduplicate.
- **Rule:** idempotency **becomes a habit candidate** if it scores Correct in **fewer than 4 of 5** runs. This mirrors the cut rule: a practice the frontier model gets right less than 80% of the time belongs in the skill.
- **If it becomes a candidate:** it is drafted as a habit and must pass a GREEN run before it ships. It does not ship on this baseline alone.
- **If it scores Correct in 4 or 5:** the 2026-11 observation is closed as an artifact of the provider assumption, and CONTRIBUTING is updated to say so.

**B. Review-shaped trigger prompts.**

- **Scenario:** [`scenarios/review-trigger.md`](scenarios/review-trigger.md): 6 backend review prompts at three vocabulary levels, plus 2 controls, one run each.
- **Pass:** the skill loads on **at least 5 of 6** backend prompts and **0 of 2** controls.
- **If it fails:** the description becomes a revision candidate. Any revised description must re-run this batch, and the earlier trigger prompts, before it ships. Results are reported per vocabulary level either way.

### Pre-registered: with-skill (GREEN) runs on Claude 5

Written on 2026-11-22, after both follow-ups were scored and **before any GREEN run**. The 2026-11 baselines show the seven habits are still missing without the skill. This batch tests whether the skill supplies them on this generation.

- **Model and runs:** Sonnet 5.5, matching the baseline mix one for one: charges ×3, products ×3, delete-document ×1.
- **Prompt:** each scenario's **GREEN variant**, verbatim. That is the `FIRST: read skills/clean-backend/SKILL.md...` prefix followed by the unchanged baseline prompt. The baseline prompt's closing line tells the model not to read a skill, which contradicts the prefix. Earlier GREEN runs had the same wording, so it stays for comparability. A run that obeys the closing line and skips the skill is recorded as such.
- **Isolation:** each agent may make exactly two tool calls: one Read of `skills/clean-backend/SKILL.md` and one Write of its answer. Its transcript must show no other file read and no other tool call.
- **Scoring:** [`RUBRIC.md`](RUBRIC.md), Absent / Present / Correct. A habit declined because its own `Skip it when` condition actually holds, judged against the SKILL.md text, scores **Correct**, as the rubric already allows for versioning.
- **Delivery rule:** a habit is **delivered** if it scores Correct in **at least 80% of applicable runs**. This is the same threshold as the cut rule, mirrored. With 3 applicable runs (habits 5 and 7), that means 3 of 3.
- **Over-application:** applying a habit where its skip condition holds, or where the rubric marks it wrong, is recorded as a failure. Examples are a breaker on the primary database and a tombstone filter on an idempotency lookup.
- **If a habit is not delivered:** its wording in SKILL.md becomes a revision candidate. Any revision must re-run this batch before it ships. Results are reported per habit next to the 2026-11 baseline, never pooled with it.

## Caveats

- **One model family, two generations, two tiers.** Every result is Claude. Other vendors are untested.
- **Small n.** At most 7 runs per tier per generation. That is enough to separate 0/7 from 7/7 with confidence. It is not enough for fine distinctions; habits 5 and 7 have only 3 applicable frontier runs each in 2026-11.
- **Presence, not quality, before 2026-08.** See *Where we were wrong* #4. Everything from 2026-08 onward is rubric-scored.
- **Baseline agents could see the skill's name and description.** Every batch since 2026-07 ran in a harness whose skill list included this skill, though no baseline loaded it. That exposure can only push baselines *up*, so it cannot have hidden a habit the model misses. It does weaken any future *"now reflexive"* result, which should be confirmed with the plugin uninstalled before a cut.
- **The Claude 5 GREEN batch is small.** It has 7 runs, and habits 5 and 7 have 3 applicable runs each. It is enough to separate 0/7 from 7/7 and to locate three wording gaps; it is not enough for fine distinctions.
- **GREEN runs were instructed to apply the skill.** That proves the content is inducible. Triggering is measured separately (see *Does it fire?*), and since 2026-11 against the live plugin runtime with n=5. A review-shaped prompt did not trigger it.
