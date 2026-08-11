# Scoring rubric

Our first evaluation asked *"did the practice appear?"* That was enough to separate 0/7 from 7/7 on a frontier model, but it is not a measurement — a practice can appear and be wrong in a way that costs money. See *Where we were wrong* #4 in [README.md](README.md).

This rubric grades each practice **Absent / Present / Correct**. Every "Correct" criterion below comes from a failure we actually observed in a run; none of them are hypothetical.

- **Absent** — no attempt.
- **Present** — the practice is recognisably there. This is what a summary bullet or a skim would credit.
- **Correct** — the implementation holds up under the failure it exists to prevent.

Score `Present` when any correctness criterion fails. The gap between Present and Correct is the finding.

## The seven habits

### 1. Version the route from day one

| | |
| --- | --- |
| Present | A version appears in the route or an `Accept` header. |
| Correct | Present, **and** the skip condition was honoured — a single-consumer service deployed atomically with its only caller is allowed to have no version, and choosing that deliberately counts as correct. |

### 2. Deploying is not releasing

| | |
| --- | --- |
| Present | A flag guards the risky path. |
| Correct | The flag is reachable **without a redeploy** (env var, config service, flag provider) — not a module constant or a hardcoded boolean, which is a deploy by another name. It gates the *risky* path specifically, not the whole handler as a formality. |

*Observed:* a migration baseline resolved the switch from `process.env`, explicitly so rollback was "a config change, not a redeploy." A `const ENABLED = true` would score Present, not Correct.

### 3. Break the circuit before you retry

| | |
| --- | --- |
| Present | A breaker exists around a dependency. |
| Correct | (a) It wraps an **external** dependency, not the service's own primary database — a breaker there converts a slow query into an outage. (b) **Expected business failures do not trip it.** A wave of card declines is a healthy provider; only transport-level failures should count toward opening. |

*Observed:* both with-skill runs explicitly declined to wrap the DB and said why. One classified provider errors into `declined / invalid / transient` and called `recordFailure()` only for `transient`. That distinction is the difference between Present and Correct.

### 4. Every I/O gets a deadline, including the database

| | |
| --- | --- |
| Present | At least one call is bounded. |
| Correct | **Every** process boundary is bounded — the database and the queue, not only the scary external HTTP call. |
| Note | A `Promise.race` bounds *your wait*, not the socket; the abandoned call keeps running. Passing an `AbortSignal` where the client supports one is stronger, but its absence does not by itself drop the score to Present. |

*Observed:* the most common frontier miss. Charges and products baselines bounded the payment provider and inventory service, and left `db.insert` / `db.findAll` unbounded.

### 5. Anything the caller doesn't await leaves the request path

| | |
| --- | --- |
| Present | The work is not awaited inline in the handler. |
| Correct | It is handed to a **durable** queue. A floating promise (`doWork().catch(log)`) is Present, not Correct — it is lost on process restart, which is exactly when it matters. |

*Observed:* a smaller-model run fired the receipt as a floating `.catch()` promise; a webhook baseline awaited the mailer inline while noting in a comment that it belonged in an outbox.

### 6. Emit the counter, not just the log line

| | |
| --- | --- |
| Present | A metrics call exists. |
| Correct | Counters cover **business outcomes** — success, failure, degraded, duplicate — not only a duration timer or an infrastructure gauge. The question to ask: could you alert on a drop in successful checkouts from these series alone? |

*Observed:* smaller-model runs emitted rich structured logs and zero counters. A latency timer alone is Present.

### 7. Every read filters tombstones

| | |
| --- | --- |
| Present | At least one read filters `deleted_at IS NULL` (or equivalent). |
| Correct | Visibility reads filter tombstones, **and** idempotency or audit lookups deliberately do not. A refunded charge is still proof its key was spent; filtering it there permits a double charge. |

*Observed:* a with-skill run refused this habit on its idempotency lookup and left an inline comment so nobody would "fix" it later. Refusing it there is Correct; applying it blindly is a money bug.

## Practices we cut

Not in the skill, but graded here because on a smaller model they failed — and the failures were of the Present-not-Correct kind.

### Idempotency keys

| | |
| --- | --- |
| Present | An idempotency key is read or stored. |
| Correct | The key is **required**, not optional; it is claimed **before** the money moves, not merely looked up; a completed key **replays the original result**; and the check **fails closed** — if the idempotency store is unreachable, the request is refused, not charged. |

*Observed:* a smaller-model run accepted `idempotencyKey?` as optional and, on a lookup error, logged a warning and charged anyway — describing it in its own summary as "graceful degradation." That is Present and actively unsafe.

### Graceful degradation

| | |
| --- | --- |
| Present | A dependency failure is caught and the request still succeeds. |
| Correct | The degraded state is **distinguishable from a real value**. Collapsing "unknown" into `0` / `false` / `null` silently converts an outage into wrong data. |

*Observed:* a listing endpoint mapped failed stock lookups to `stock: 0, inStock: false`, so an inventory blip renders the whole catalogue sold out. A frontier run kept `stock: number | null` with an explicit `availability: 'unknown'`.

### Validation, field-limiting, naming

Graded Present/Absent only. Both tiers applied these reliably, and we have not observed a correctness failure worth codifying. If you find one, that is a valuable issue.

## Using this

When re-running a scenario, score each row Absent / Present / Correct and keep the evidence — the specific line that decided it. Two numbers matter: how many practices reached Present, and how many reached Correct. On a frontier model those numbers were close. On a smaller model they diverged, and the divergence was the whole finding.
