# Review-shaped trigger batch — Sonnet 5.5 — 2026-11-22

- **Scenario:** [`../../scenarios/review-trigger.md`](../../scenarios/review-trigger.md), all eight prompts used verbatim
- **Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`)
- **Condition:** installed plugin in the live registry; no prompt named a skill, plugin, or repo
- **Pre-registered:** pass = loads on at least 5 of 6 backend prompts and 0 of 2 controls (committed in 180fda4, before any run)
- **Isolation:** every transcript shows no Read, Glob, Grep, or Bash call
- **Record kind:** transcript-checked. Each verdict is the `Skill` tool call in the agent's transcript. Outputs are summarised.

## Results

| # | Vocabulary | Prompt (abridged) | `Skill` call | Loaded? |
| --- | --- | --- | --- | --- |
| B1 | none | "Is this ready for production? Review it" + `POST /invites` | `clean-backend:clean-backend` | **yes** |
| B2 | none | "Can you look this over before I merge it?" + `GET /reports/:id` | `clean-backend:clean-backend` | **yes** |
| B3 | some | "Review this endpoint. It calls our pricing service" | `clean-backend:clean-backend` | **yes** |
| B4 | some | "Code review please. This runs in our background job worker." | `clean-backend:clean-backend` | **yes** |
| B5 | many | Refund handler "before it goes to production... calls Stripe" | `clean-backend:clean-backend` | **yes** |
| B6 | many | Search rollout "for production readiness and on-call concerns" | `clean-backend:clean-backend` | **yes** |
| C1 | control | React `Avatar` component review | none | no (correct) |
| C2 | control | Python EXIF photo-rename script review | none | no (correct) |

**Sensitivity 6/6, specificity 2/2. Passes the pre-registered bar.**

## Reading it

- **The 2026-11-22 miss did not reproduce.** B1 uses the exact framing that missed earlier the same day: *"Is this ready for production? Review it"*, followed by a short handler. This time it loaded the skill. The most likely reading is that selection varies from run to run, not that review prompts are a blind spot. The description stays unchanged.
- **Vocabulary did not matter at n=6.** The two prompts with no trigger words loaded the skill as reliably as the four with them.
- **Loading is not the same as applying, and the reviews show both.**
  - B6 asked for a feature flag on the rollout. B4 declined flags and versioning for a worker, on the grounds that there is no surface for them. B3 declined flags and queueing, saying there was "nothing to defer".
  - B2 kept the PDF render on the request path, because the caller needs the bytes, and offered enqueue/poll only if renders are slow.
  - These are the skip conditions working inside a review. They are uncontrolled observations, not scored GREEN runs.
- **Combined with the earlier test on the same day:** 8 of 9 backend prompts loaded the skill, and 0 of 4 controls did.
