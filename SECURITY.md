# Security Policy

Clean-Backend ships a **Claude Code skill** — markdown that gets injected into a user's AI agent as instructions. That makes the threat model unusual: the main risk isn't a crashing binary, it's *content that quietly steers an agent into doing something harmful*. This document explains what counts as a vulnerability here and how to report one.

## Supported versions

Only the **latest release** is supported. Fixes ship in a new release rather than as patches to older tags.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/AllanOps/Clean-Backend/security/advisories/new) (Security tab → *Report a vulnerability*). You'll get an acknowledgement as soon as the maintainer sees it, and a fix or decision as fast as a solo-maintained project can reasonably move. Coordinated disclosure is appreciated — give us a chance to release a fix before going public.

## What counts as a vulnerability

Because installing this skill copies its content into the user's agent, the following are treated as security issues:

- **Prompt injection / instruction hijacking** — skill content that tells an agent to ignore its guidance, change its behavior, or follow embedded commands.
- **Data exfiltration** — content that steers an agent to read and transmit environment variables, secrets, credentials, tokens, or file contents.
- **Remote code execution** — content that nudges an agent to fetch and run remote scripts or commands.
- **Hidden content** — invisible or bidirectional Unicode, zero-width characters, or encoded blobs used to smuggle instructions past a human reviewer.
- **Malicious or deceptive links** — links to credential-harvesting, malware, or typosquatted destinations inside skill content.
- **Manifest tampering** — changes that repoint the plugin/marketplace `source` at a foreign repository, or otherwise redirect what gets installed.
- **Supply-chain issues in CI** — an un-pinned or compromised GitHub Action, over-privileged token, or workflow that could leak the release credential.

## What is *not* a security issue

- **Backend advice you disagree with.** If you think a trick is wrong, incomplete, or bad practice, that's a great [regular issue](https://github.com/AllanOps/Clean-Backend/issues/new/choose) — not a vulnerability report.
- **Typos and broken links** in docs — open a normal issue or PR.

## How we reduce the risk

Every pull request runs, before a human ever merges it:

- **Manifest & frontmatter validation** against the Agent Skills spec.
- **A content scan** of `skills/` that hard-fails on invisible/bidirectional Unicode, encoded blobs, raw-IP URLs, un-allowlisted external links, and instruction patterns associated with exfiltration or remote execution.
- **Workflow hardening**: GitHub Actions pinned by commit SHA, least-privilege (read-only by default) tokens, `pull_request` triggers that deny forks access to secrets, and a [zizmor](https://github.com/zizmorcore/zizmor) audit of the workflows themselves.
- **GitHub secret scanning + push protection** on the repository.

Automated scanning is a floor, not a ceiling — every change to skill content also gets a human review.
