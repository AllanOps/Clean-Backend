# Run records

The scorecards in [`../README.md`](../README.md) are summaries. These are the runs behind them, so you can check the scoring rather than take our word for it.

## Two kinds of record, clearly labelled

| Kind | What it is | Trust it for |
| --- | --- | --- |
| **Verbatim** | The model's complete output, captured at run time, with a rubric scorecard citing the deciding lines. | Auditing our scoring line by line. |
| **Attested** | Scored observations recorded during the run, written up afterwards. **Not a transcript.** | The verdicts and the specific behaviours we cite — not for reading exact output we no longer hold. |

The earliest runs predate this directory and exist only as attested records; that is a real limitation and it is labelled on every such file. Everything from 2026-08 onward is verbatim.

## Index

| Directory | Runs | Kind |
| --- | --- | --- |
| [`2026-07-attested/`](2026-07-attested/) | 7 frontier baselines, 4 Haiku baselines, 4 trigger tests, 2 over-application runs | attested |
| [`2026-08-rubric-batch/`](2026-08-rubric-batch/) | 4 neutral baselines (charges + products × frontier + Haiku), scored with the rubric | verbatim |

## Capture protocol

For any new run, record:

1. **Scenario** — a link to the file in [`../scenarios/`](../scenarios/), used verbatim. Never a reworded prompt; the comparison to published results breaks otherwise.
2. **Model and date** — specific version where known. Behaviour moves between releases; that is the whole point.
3. **Condition** — baseline (no skill) or with-skill.
4. **Rubric scorecard** — Absent / Present / Correct per practice, per [`../RUBRIC.md`](../RUBRIC.md), each with the line that decided it.
5. **Verbatim output** — the model's complete response.

Wrap captured output in a four-backtick fence, because the outputs themselves contain three-backtick code fences.

**Redaction:** CI scans the whole repo for invisible/bidirectional Unicode and raw-IP URLs. If a captured output trips it, redact the offending literal in the artifact and note the redaction inline. Do not weaken the scanner to accommodate an artifact.

## Reading a scorecard

`Present` means the practice appeared and a reviewer skimming a summary would tick it off. `Correct` means it survives the failure it exists to prevent. The gap between those two columns is usually where the finding is — a fail-open idempotency check and a stock field that reads `0` for "unknown" are both Present, and both lose money.
