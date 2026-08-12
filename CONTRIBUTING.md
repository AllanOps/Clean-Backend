# Contributing to Clean-Backend

Thanks for wanting to make this better. This skill is deliberately small, and it stays small because of one unusual rule — read that first.

## The bar: evidence, not good advice

**A habit ships here only if an AI assistant fails to apply it on its own.**

Plenty of excellent backend practices are *not* in this skill. Input validation, idempotency keys, graceful degradation, intention-revealing naming — all good, all measured, all cut, because baseline runs applied them reliably with zero prompting. Every line we spend restating what the model already does crowds out the seven things it doesn't.

So "this is a great practice" is not an argument for inclusion. The argument is: **here is output that omits it.** See [evals/](evals/README.md) for the protocol, the prompts, and the scorecard.

There is a second, subtler argument that also qualifies: **here is output that appears to do it and gets it wrong.** A practice the model reaches for but implements unsafely — an idempotency check that fails open, a degraded state that reads as a real value — is worth a habit even though a presence-scored eval would call it reflexive. Score it with [`evals/RUBRIC.md`](evals/RUBRIC.md) and show the Present-but-not-Correct gap.

### Which tier a finding belongs to

A habit ships when **the model that will run it** fails to apply it correctly. That makes the target tier part of the decision, not an afterthought:

| Finding | Outcome |
| --- | --- |
| A **frontier** model applies it but gets it wrong (Present, not Correct) | **Ships as a habit.** Same bar, better measurement. |
| Only a **smaller** model gets it wrong | **Documented in `evals/` with the tier stated. Not added to the skill** — it would tax every frontier user for a case they don't have. |
| You want to target a smaller tier properly | **A separate skill**, with its own measurements. Never a conditional section bolted onto this one. |

"Present but not Correct" is not a new *kind* of habit — it is the same habit measured better. Idempotency looked reflexive under presence-scoring; under the rubric it is reflexive on frontier and unsafe on smaller models. The right response to that was re-scoring, not new content.

No frontier Present-but-not-Correct has been observed yet. If you find one, it ships.

### Wanted: other model families

Every result so far is Claude — frontier and Haiku-class. The scenarios and rubric are committed precisely so someone can run them elsewhere.

**Running the baselines against GPT, Gemini, Llama, or a local model and reporting back is the single most valuable contribution available right now.** You need no repo access: take a prompt from [`evals/scenarios/`](evals/scenarios/) verbatim, run it with no skill loaded, score it with the rubric, and file a [re-measurement issue](https://github.com/AllanOps/Clean-Backend/issues/new/choose).

A result showing a habit is **already reflexive** on your model is as valuable as one showing a gap — it tells us the skill is narrower than advertised, and narrowing it is the whole design.

## Ways to contribute

- **Propose a habit** — with evidence it's missing from baseline output. [Open a new-habit issue](https://github.com/AllanOps/Clean-Backend/issues/new/choose) *before* writing a PR.
- **Challenge a habit** — if you can show the model already does one of the seven unprompted, that's a valuable issue. We'll cut it.
- **Improve the evaluation** — better scenarios, a confound we missed, results from a different model.
- **Fix or sharpen** an existing habit, or the repo itself.
- **Report a security issue** — see [SECURITY.md](SECURITY.md). Never a public issue.

## The habit format

Each habit is a `###` section inside one of the two parts. Match this structure:

````markdown
### <N>. <The habit, imperative, one line>

```TypeScript
// Measured: <what the baseline output does instead>
<2-4 lines>

// <The habit, stated positively.>
<2-4 lines>
```

<1-2 lines: the consequence that makes it worth it>

**Skip it when** <an observable condition where applying it would be wrong>.
````

Use ` ```SQL ` when the example is a query (habit 7). Keep code blocks short — they illustrate, they don't compile.

### Rules that come from how the skill is tested

- **Positive form, not prohibition.** Write "fill the version slot," not "don't forget to version." Guidance phrased as a ban measurably backfires when it competes with another instinct.
- **Every habit needs a `Skip it when`**, keyed to something observable. Over-application is a real failure mode: not everything deserves a flag.
- **Part 1 vs Part 2.** Part 1 is for habits absent from *every* baseline regardless of task shape. Part 2 is for habits the model applies when the task cues them and drops when it doesn't. If you're unsure, it's Part 2.
- **No external links inside `skills/`.** If one is genuinely necessary, add it to [`scripts/url-allowlist.json`](scripts/url-allowlist.json) in the same PR with a justification — CI blocks un-allowlisted links in skill content by design.
- **No images or binaries** in skill content; it stays copy-pasteable plain text.

**Numbering.** Habits are numbered sequentially across both parts. Adding one means appending within its part and renumbering anything after it, plus the matching row in the README table. Keep the two in sync — CI checks the anchors.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/); releases and the changelog are generated from them.

| Prefix | Use it for | Version effect |
| --- | --- | --- |
| `feat:` | a new habit or capability | minor bump |
| `fix:` | correcting an existing habit | patch bump |
| `docs:` | README/docs only | no release |
| `ci:` / `chore:` | tooling, workflows, evals | no release |

Add `!` or a `BREAKING CHANGE:` footer when you remove or fundamentally change a habit — that changes what existing installs receive.

## Run the checks locally

All dependency-free Node (no `npm install`):

```bash
node scripts/validate-repo.mjs    # frontmatter + manifests + consistency
node scripts/scan-content.mjs     # prompt-injection / hidden-content scan
node scripts/test-scanners.mjs    # the scanner's own test suite
```

Optionally, with the Claude Code CLI installed:

```bash
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate . --strict
```

CI runs all of these plus markdown linting and a link/anchor check.

## Licensing of contributions

By submitting a contribution you agree it is licensed under the project's [MIT License](LICENSE) (inbound = outbound, per [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)). No separate CLA.

## What review looks like

- Every change to `skills/` gets a human read for prompt injection and for fit with the evidence bar — not just a green CI check.
- A proposed habit without evidence will be sent back with a scenario to run, not rejected outright.
- Maintainer response is best-effort; a nudge after a week is welcome.

Keep it sharp, keep it honest, and thanks for contributing.
