# Contributing to Clean-Backend

Thanks for wanting to make this better. This repo is small and opinionated on purpose — every trick has to earn its place. This guide covers how to propose one, the exact format it must follow, and the checks it has to pass.

## Ways to contribute

- **Propose a new trick** — a production-backend habit that belongs alongside the existing set.
- **Fix or sharpen an existing trick** — a typo, wrong code, clearer wording, a better example.
- **Improve the repo itself** — docs, CI, tooling.
- **Report a security issue** — see [SECURITY.md](SECURITY.md). Do *not* open a public issue for vulnerabilities.

## The golden rule: open an issue first

For a **new trick**, [open a "new trick" issue](https://github.com/AllanOps/Clean-Backend/issues/new/choose) *before* you write a PR. This is a curated list — agreeing on scope up front saves you from writing a full trap-vs-fix pair that turns out to overlap with an existing one. Small fixes (typos, wrong code) can go straight to a PR.

## The trick format

Every trick is a **trap → fix** pair with a punchy law. Match this structure exactly — it's what makes the skill scannable and consistent:

````markdown
## <N>. <Punchy one-line law, imperative mood>.
### <Subtitle: the practice in one sentence>

For instance;

```TypeScript
// The Trap - <what people naturally do>
<3-6 lines of code>

// The Fix - <the practice>
<3-6 lines of code>
```
<1-2 lines: the consequence that makes it worth it>
**<Bold one-line law.>**
````

Use ` ```SQL ` instead of ` ```TypeScript ` when the example is a query (see trick #9). Keep code blocks short — they illustrate, they don't compile.

**Numbering.** Tricks are numbered sequentially. To add one, append the next `## N.` section in the skill and a matching row in the README table — that's it. No file states a running total, so there is no count to keep in sync.

### Style rules

- **Voice:** direct, experienced, a little blunt. "You" and "we", present tense. Think senior engineer explaining at a whiteboard, not documentation.
- **One idea per trick.** If it needs two code blocks to explain, it's probably two tricks.
- **No external links inside `skills/`** unless they're essential. If you must add one, add it to [`scripts/url-allowlist.json`](scripts/url-allowlist.json) in the same PR with a one-line justification — CI blocks un-allowlisted links in skill content by design.
- **No images or binaries** in skill content — it's meant to stay copy-pasteable plain text.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/); releases and the changelog are generated automatically from them.

| Prefix | Use it for | Version effect |
| --- | --- | --- |
| `feat:` | a new trick or capability | minor bump |
| `fix:` | correcting an existing trick | patch bump |
| `docs:` | README/docs only | no release |
| `ci:` / `chore:` | tooling, workflows | no release |

Add `!` (e.g. `feat!:`) or a `BREAKING CHANGE:` footer only when you change the skill in a way that breaks existing installs.

## Run the checks locally

Both scripts are dependency-free Node (no `npm install` needed):

```bash
node scripts/validate-repo.mjs   # frontmatter + manifest + consistency checks
node scripts/scan-content.mjs    # prompt-injection / hidden-content scan
```

Optionally, if you have the Claude Code CLI installed:

```bash
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate . --strict
```

CI runs all of these on every PR, plus markdown linting and a link check.

## Licensing of contributions

By submitting a contribution you agree it is licensed under the project's [MIT License](LICENSE) (inbound = outbound, per [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)). No separate CLA.

## What review looks like

- Every change to `skills/` gets a human read for prompt-injection and for fit with the existing voice — not just a green CI check.
- New external links are reviewed against the allowlist.
- Maintainer response is best-effort; a nudge after a week is welcome.

That's it. Keep it sharp, keep it honest, and thanks for contributing.
