<div align="center">

<img src="assets/banner.svg" alt="clean-backend — backend practices that keep production boring" width="880">

[![CI](https://github.com/AllanOps/Clean-Backend/actions/workflows/ci.yml/badge.svg)](https://github.com/AllanOps/Clean-Backend/actions/workflows/ci.yml)
[![Actions Security](https://github.com/AllanOps/Clean-Backend/actions/workflows/actions-security.yml/badge.svg)](https://github.com/AllanOps/Clean-Backend/actions/workflows/actions-security.yml)
[![Release](https://img.shields.io/github/v/release/AllanOps/Clean-Backend?sort=semver)](https://github.com/AllanOps/Clean-Backend/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2.svg)](https://docs.claude.com/en/docs/claude-code/plugins)

</div>

> [!NOTE]
> **clean-backend is a [Claude Code](https://claude.com/claude-code) skill.** It supplies the operational habits an AI assistant does not reach for on its own when it designs, writes, or reviews your backend code.

Most "best practices" lists tell your AI things it already does perfectly well. We measured which ones it actually misses and then deleted everything else.

---

## The measurement

We put neutral production-code tasks: a payment endpoint, a product listing, a delete endpoint, all in front of a fresh model with **no skill loaded**, then repeated them with the skill, and diffed the output for thirteen runs.

Field-limited responses, validation at the boundary, graceful degradation, intention-revealing naming, and **complete idempotency on money-moving endpoints in 6 of 6 runs applied reliably with zero prompting**, so we cut them from the skill.

API versioning, feature flags, circuit breakers **never appeared in a single neutral run**, so they became the skill.

We then went looking for an eighth habit in the two shapes most likely to hide one — a column rename on a hot table, and a webhook receiver. Both came back empty. Seven is the whole set at this resolution.

> [!IMPORTANT]
> **The cuts were measured on a frontier model.** Re-running the same scenarios on a small, fast model, two of them do not hold: it hard-deleted rows instead of tombstoning, and its idempotency was either missing or **failed open** on a money endpoint. If you run this skill against a smaller model, don't assume those. The seven habits below are needed on both tiers — more so on the smaller one.

The full protocol, every prompt, both scorecards, the run records, the empty eighth-habit hunt, and the four places our own methodology was wrong: **[evals/](evals/README.md)**.

**Evidence last refreshed: 2026-08-11** (Claude frontier and Haiku-class). That date is part of the claim — models improve, and a habit that becomes reflexive gets cut. See [when we re-measure](evals/README.md#when-to-re-measure).

---

## See it in action

Seven neutral baselines. A charge endpoint, a product listing, a delete endpoint. Not one of them versioned the route:

```ts
// What a fresh model writes, every time:
POST /charges

// What it does not write unless something tells it to:
POST /api/v1/charges
```

Mobile clients outlive your refactors. An unversioned route turns the first breaking change into a coordinated migration — and nothing inside the endpoint you're writing ever reminds you.

---

## The seven

**Part 1 — absent from every endpoint-writing baseline.** Lifecycle decisions that are invisible from inside a single endpoint. (When the task *itself* is a risky rollout, the model does reach for flags on its own — but writing a feature is the common case, and there they never appeared.)

| # | Habit | Why it gets skipped |
| --- | --- | --- |
| 1 | [Version the route from day one](skills/clean-backend/SKILL.md#1-version-the-route-from-day-one) | Nothing in the endpoint cues it |
| 2 | [Deploying is not releasing](skills/clean-backend/SKILL.md#2-deploying-is-not-releasing) | Rollout is org policy, not local craft |
| 3 | [Break the circuit before you retry](skills/clean-backend/SKILL.md#3-break-the-circuit-before-you-retry) | Retries feel like enough |

**Part 2 — present only when the task cues them.** The model does these when the task makes them obvious, and skips them when it doesn't.

| # | Habit | The observed gap |
| --- | --- | --- |
| 4 | [Every I/O gets a deadline](skills/clean-backend/SKILL.md#4-every-io-gets-a-deadline-including-the-database) | The external call was bounded; the DB call wasn't |
| 5 | [Get it off the request path](skills/clean-backend/SKILL.md#5-anything-the-caller-doesnt-await-leaves-the-request-path) | The receipt email was awaited inline |
| 6 | [Emit the counter, not just the log](skills/clean-backend/SKILL.md#6-emit-the-counter-not-just-the-log-line) | Rich logs, nothing to alert on |
| 7 | [Every read filters tombstones](skills/clean-backend/SKILL.md#7-every-read-filters-tombstones) | Deletes tombstoned; a read returned them anyway |

**[Read the skill →](skills/clean-backend/SKILL.md)**

---

## Install

### As a Claude Code plugin (recommended)

```text
/plugin marketplace add AllanOps/Clean-Backend
/plugin install clean-backend@allanops
```

Then either invoke it explicitly with `/clean-backend:clean-backend`, or just ask for backend code — it triggers on its own.

### Manual install

```bash
git clone https://github.com/AllanOps/Clean-Backend.git
cp -r Clean-Backend/skills/clean-backend ~/.claude/skills/clean-backend
```

Installed this way it's invoked as plain `/clean-backend`.

---

## Why you can trust this repo

A skill is *instructions injected into your agent*, so every change is treated as a supply-chain change:

- **Schema-validated** — the skill and plugin manifests are checked against the Agent Skills spec on every PR.
- **Scanned for prompt injection** — CI hard-fails on invisible or bidirectional Unicode, homoglyph/mixed-script words, encoded blobs, raw-IP links, un-allowlisted URLs, and instructions that would steer an agent to exfiltrate or execute anything. The scanner has its own test suite.
- **Locked-down automation** — Actions pinned by commit SHA, read-only tokens, and a [zizmor](https://github.com/zizmorcore/zizmor) audit of the workflows themselves.

See [SECURITY.md](SECURITY.md) for the threat model and private reporting.

---

## Contributing

The bar here is unusual: a new habit has to be one the model **doesn't already apply on its own**. Bring evidence, or bring a scenario we can run. Start with a **[new-habit issue](https://github.com/AllanOps/Clean-Backend/issues/new/choose)**; the format and the evidence bar are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

By contributing you agree your work is licensed under the same MIT license as the project.

---

## License

[MIT](LICENSE) © AllanOps
