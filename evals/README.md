# Evaluation

This skill ships only habits an AI assistant **fails to apply on its own**. That claim is worthless unless you can check it, so this directory holds the protocol, the exact prompts, the results, and the places our own method was wrong.

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

## Results

13 runs total; **7 of them neutral baselines** (charges ×4, products ×1, delete ×2).

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

## Does it fire?

Content only matters if the skill gets loaded. We tested the description itself:
present a model with a realistic skill menu — this skill's description alongside
plausible decoys (frontend, debugging, TDD, planning) — give it a task, and ask
only which skills it would load.

| Task | Loaded clean-backend? |
| --- | --- |
| `POST /orders` endpoint that writes a row and calls another service | yes |
| "Review our payments service for production readiness" (deliberately vague) | yes, and nothing else |
| Background worker emailing weekly digests | yes |
| Responsive React pricing table (control) | **no** — explicitly excluded as "no HTTP endpoints, DB, or jobs" |

Sensitivity 3/3, specificity 1/1. Each backend hit cited a different trigger
phrase from the description, so the enumerated triggers are doing real work.

**What this does not prove:** it measures description-driven *selection* from an
explicit menu, which is a proxy for the plugin runtime rather than the runtime
itself, with n=4 and a short decoy list. A registry with dozens of competing
skills is a harder test than this one.

## Where we were wrong

Published because a method you can't see the failures of isn't evidence.

1. **We predicted idempotency would be the biggest gap. It was the most reliably present practice.** On a neutral money-moving endpoint the baseline required an `Idempotency-Key`, deduped before charging, replayed completed results, forwarded the key to the provider, and handled the charged-but-not-persisted case — in 4 of 4 runs. Our single strongest hypothesis was wrong, and it's why the skill no longer mentions idempotency at all.
2. **Two prompts leaked their own answers.** A delete task that mentioned a "Trash / restore feature" and a rollout task that asked "how I shipped this safely" both told the model what to reach for. Soft-delete and feature-flags briefly looked reflexive as a result. The delete scenario was re-run neutrally (soft-delete: still reflexive, 2/2); the rollout scenario's flag result was discarded in favour of the neutral baselines, where flags appear 0/7.
3. **Our first classification was too clean.** We initially called it a tidy six-versus-six split. The neutral re-runs showed the real line is not "can versus can't" — the model can do all of it — but **"never" versus "only when the task cues it."** That distinction is what produced the two-part structure.

## Re-running it

There is no CI-runnable test here, and pretending otherwise would be dishonest: a run means putting the prompt to a model and reading the output. To reproduce:

1. Open a scenario file and paste its **Baseline prompt** into a fresh session with no skill loaded.
2. Score the output against the practice list above — did it version the route, gate the rollout, break the circuit, bound the DB call, offload the request path, emit counters, filter tombstones?
3. Repeat with the skill loaded and diff.

## Caveats

- **One model family, one point in time.** These results describe a current frontier model. On a smaller or older model the cut practices may stop being reflexive — re-run before assuming.
- **Small n.** 7 neutral baselines is enough to separate 0/7 from 7/7 with confidence; it is not enough for fine distinctions.
- **GREEN runs were instructed to apply the skill.** That proves the content is inducible. Triggering was measured separately (see *Does it fire?*), but via a menu-selection proxy rather than the live plugin runtime.
