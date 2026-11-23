# Live trigger test — Sonnet 5.5 — 2026-11-22

- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`)
- **Condition:** the installed plugin (`clean-backend:clean-backend`, v2.0.x) in a live registry of a few hundred skills. No prompt named a skill, a plugin, or this repo.
- **Isolation:** every prompt opened with *"The files in your current working directory are unrelated to this task: do not read, list, or search them."* All five transcripts show no Read, Glob, Grep, or Bash call. This closes the confound in the 2026-08 test, where an agent read `RUBRIC.md` and the earlier runs.
- **Record kind:** transcript-checked. Each verdict comes from the `Skill` tool calls in the agent's transcript, not from the agent's account of itself. Outputs are summarised, not reproduced.

## Prompts and results

| # | Task (abridged) | Kind | `Skill` call in transcript | Loaded clean-backend? |
| --- | --- | --- | --- | --- |
| 1 | Express `POST /orders/:id/cancel`: owner-scoped cancel that refunds through `paymentClient.refund` | backend | `clean-backend:clean-backend` | **yes** |
| 2 | *"Is this ready for production? Review it and tell me what you'd change"*, followed by a 6-line `GET /users/:id/orders` handler that fans out to a shipping API | backend (review) | none | **no** |
| 3 | Queue worker: consumes `verify-address` jobs, calls `geocoder.lookup`, writes to `db.addresses` | backend | `clean-backend:clean-backend` | **yes** |
| 4 | React `<TagInput>` component | control | none | no (correct) |
| 5 | CSS sticky-footer fix | control | none | no (correct) |

**Sensitivity 2/3, specificity 2/2.** The plan's pass bar was 3/3 and 0/2, so this run **does not pass**.

## Reading it

- **The miss is the review prompt.** It was short, came with pasted code, and never said "backend", "endpoint", or "service". The description does name "reviewing backend code". The agent wrote a strong review without the skill: it caught IDOR, the missing timeout, and the unbounded fan-out, and it suggested a breaker. It also left out versioning, flags, the DB deadline, and counters. In 2026-08 a review prompt did trigger, but that prompt said *"payments service goes live next week, give me a production-readiness review"*, which is much more explicit. One prompt is not enough to blame the description, so the wording stays unchanged until a review-shaped batch exists.
- **The two loads show the content at work, uncontrolled.**
  - Run 1 mounted the route under `/api/v1` and cited the single-consumer skip condition. It bounded every DB call (800 ms), emitted outcome counters, filtered `deletedAt: null`, and declined a breaker and a flag, giving a stated reason for each.
  - Run 3 bounded the DB write and put a breaker on the geocoder only: *"a breaker on your own primary database tends to turn a slow query into an outage."* Permanent 4xx responses do not trip it, and it emits four outcome counters.
  - These outputs are anecdotal: there is no paired baseline. Even so, they show that habits 4 and 6, which no Sonnet 5.5 baseline applied, appear once the skill is loaded.
