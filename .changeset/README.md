# Changesets (AI-authored)

This folder holds a **single pending release intent** per PR, in Changesets
frontmatter format:

```md
---
"@legioncodeinc/honeycomb": patch
---

A one-line, user-facing summary of the change.
```

Unlike vanilla Changesets, the entry here is normally written **for you** by
`scripts/release/ai-changeset.mjs` (Claude Sonnet 5 on Amazon Bedrock) when a PR
opens — see `.github/workflows/release-gate.yaml` and `RELEASE-AUTOMATION.md`.

- **patch** → auto-approved; the version is bumped on the PR branch immediately.
- **minor** → held until GitHub user **@thenotoriousllama** comments
  `Approved Release` (case-insensitive) on the PR.
- **major** → blocked; cut a major release manually.

You may still write the file by hand — if a changeset already exists, the AI
step leaves it alone. Add the `no-changeset` label to a PR to skip release
automation entirely. Only `README.md` in this folder is ignored by the tooling.
