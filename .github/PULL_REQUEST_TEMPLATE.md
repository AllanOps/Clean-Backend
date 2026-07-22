## What this changes

<!-- One or two sentences. Link the issue it resolves, e.g. Closes #123 -->

## Type of change

- [ ] New trick
- [ ] Fix / sharpening of an existing trick
- [ ] Docs / CI / tooling

## Checklist

- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`…)
- [ ] Ran `node scripts/validate-repo.mjs` and `node scripts/scan-content.mjs` locally — both passed
- [ ] Content follows the trap-vs-fix format in [CONTRIBUTING.md](../CONTRIBUTING.md)

## Security checklist (required for any change under `skills/`)

- [ ] No new external URLs — or they're added to `scripts/url-allowlist.json` with a justification
- [ ] No invisible / bidirectional Unicode or encoded blobs
- [ ] Nothing that would direct an agent to fetch or run remote content, or to read or transmit environment variables or secrets
