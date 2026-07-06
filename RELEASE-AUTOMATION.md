# Release automation (AI changesets → gated bump → publish → Discord)

This repo automates the full release path. Humans write code; the version bump,
release notes, npm publish, and Discord announcement are automated, with a
single human gate on `minor` releases.

> This is the **pilot** implementation on honeycomb. Once proven, replicate the
> `scripts/release/` scripts + the two workflows in the sibling packages.

## The flow

```
PR opened ──▶ release-gate.yaml
                │  Claude Sonnet 5 (Bedrock) reads the diff, picks a bump,
                │  writes .changeset/ai-*.md
                ├─ patch ─▶ bump on the PR branch now ........ release-gate = success
                ├─ minor ─▶ hold ............................. release-gate = pending
                │            └─ @thenotoriousllama comments "Approved Release"
                │               ▶ bump on the PR branch ...... release-gate = success
                └─ major ─▶ blocked, label needs-manual-release release-gate = failure
                                     │
PR merges to main ───────────────────┘
   │  tag-on-merge.yaml sees the new package.json version and pushes vX.Y.Z
   │  (via RELEASE_PAT so the tag triggers the next workflow)
   ▼
release.yaml (unchanged publish core)
   │  full gate → npm publish (OIDC trusted publishing) → post-publish smoke
   ├─ ai-release-notes.mjs → RELEASE_NOTES.md (Sonnet 5, fail-soft)
   ├─ GitHub Release (body = RELEASE_NOTES.md)
   └─ discord-notify.mjs → Discord webhook
```

### The `release-gate` rules (spec #1)

| AI bump | `release-gate` status | Effect |
| --- | --- | --- |
| **patch** | `success` immediately | auto-approved; version bumped on the PR branch |
| **minor** | `pending` | blocked until the approval comment; then bumped + `success` |
| **major** | `failure` | hard-blocked; `needs-manual-release` label; cut it by hand |

**Minor approval:** GitHub user **@thenotoriousllama** comments the phrase
`Approved Release` (case-insensitive, anywhere in the comment) on the PR. Only
that login counts.

**The bump is decided once.** After a patch is applied or a minor is approved,
the PR carries the version bump, and a double-bump guard (comparing
`package.json` at the PR base vs head) keeps later pushes from bumping again —
the gate stays green without re-evaluating. If the PR changes substantially
after the bump and you want a different bump, delete the release/bump commit (or
the changeset) from the branch to force a fresh evaluation.

**Docs-only PRs never release.** If every changed file (outside `.changeset/`)
is markdown (`.md` / `.mdx` / `.markdown`), the gate goes `success` with no AI
call, no bump, and therefore no tag and no release.

**Opt out:** add the `no-changeset` label to any PR. The gate goes `success`
with no bump/release regardless of what it touches.

## One-time setup

### 1. Secrets (repo → Settings → Secrets and variables → Actions → Secrets)

| Secret | Used by | What |
| --- | --- | --- |
| `AWS_BEDROCK_API_KEY` | gate + notes | An [Amazon Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html). Exported to the SDK as `AWS_BEARER_TOKEN_BEDROCK`; the IAM identity behind it needs `bedrock:InvokeModel` |
| `DISCORD_WEBHOOK_URL` | release | The Discord webhook URL (keep it a secret — anyone with it can post) |
| `RELEASE_PAT` | tag-on-merge | Fine-grained PAT, this repo, **Contents: write** (pushes the release tag so release.yaml fires) |

> **Long-term vs short-term key.** Use a **long-term** Bedrock API key here — it's
> tied to an IAM user and does not expire, so CI keeps working. A short-term key
> expires within ~12 hours and would silently break the gate.

### 2. Variables (same page → Variables)

| Variable | Example | What |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `BEDROCK_MODEL_ID` | *(from your account)* | The Sonnet 5 **cross-region inference-profile** id |

Get the exact model id from your account (it carries a geo prefix, e.g.
`us.anthropic.claude-sonnet-5-…`):

```bash
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileName,'Sonnet 5')]"
```

The IAM user behind the access key needs `bedrock:InvokeModel` on the Sonnet 5
model **and** the inference-profile ARN. Because the `us.` profile fans out
across US regions, grant it on the underlying foundation-model ARNs in each of
those regions, not just one.

### 3. Branch protection

`.github/rulesets/main-protection.json` already lists `release-gate` as a
required status check. Sync the ruleset to GitHub so the gate is enforced at
merge.

## Known limitations (pilot)

- **Fork PRs.** A fork PR gets a read-only `GITHUB_TOKEN`, so the workflow
  cannot set the `release-gate` status or push the bump. Release automation is
  skipped for forks — a maintainer pushes the branch into this repo (or adds a
  changeset + status manually) to release a fork contribution.
- **AI picks the bump.** `major` is always blocked, and every AI bump is visible
  in two review gates (the PR itself, then the merge). Still, sanity-check the
  changeset the bot writes. To remove AI semver judgment entirely, switch
  `scripts/release/ai-changeset.mjs` to derive the bump from Conventional Commit
  prefixes and let the model write only the summary.
- **RELEASE_PAT.** Required because GITHUB_TOKEN-pushed tags don't trigger
  workflows. Alternative: retrigger `release.yaml` on `push: branches: [main]`
  (detect the version change and tag inside that job) to drop the PAT.

## Files

| Path | Role |
| --- | --- |
| `scripts/release/ai-changeset.mjs` | PR-time: Sonnet 5 picks bump + summary, writes the changeset |
| `scripts/release/apply-bump.mjs` | Consumes the changeset, `npm version` on the PR branch, CHANGELOG |
| `scripts/release/ai-release-notes.mjs` | Release-time: Sonnet 5 writes `RELEASE_NOTES.md` (fail-soft) |
| `scripts/release/discord-notify.mjs` | Release-time: posts notes to Discord (fail-soft) |
| `.github/workflows/release-gate.yaml` | The PR gate + the minor-approval comment handler |
| `.github/workflows/tag-on-merge.yaml` | Tags the bumped version on merge to main |
| `.github/workflows/release.yaml` | Publish core (unchanged) + notes + Discord steps |
