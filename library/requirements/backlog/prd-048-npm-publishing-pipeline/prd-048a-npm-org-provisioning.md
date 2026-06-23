# PRD-048a — npm org `@legioncodeinc` provisioning + automation token

> Status: backlog · Parent: PRD-048 · Wave: W0 · Type: S (off-repo, manual)
> Goal: make the scope `@legioncodeinc` a real, publish-capable npm org with the CI automation identity
> and the maintainer as members, and wire its Automation token into GitHub Actions as `NPM_TOKEN` — the
> hard off-repo prerequisite every later sub-PRD's publish step depends on.

## Why
RELEASING.md step (a)/(d): a scoped publish requires the **npm org/scope to already exist** with the
publishing identity as a member, and `release.yaml`'s token gate reads a `NPM_TOKEN` secret (an
**Automation** token, so it bypasses 2FA in CI). None of this lives in the repo — it is account-side
provisioning that must be done by hand, with the maintainer's npmjs account, before the in-repo rename
(048b) means anything. Doing it first also de-risks the naming decision: if `@legioncodeinc` is somehow
unavailable, we learn it here, before any in-repo churn.

## What (scope)
- **Verify scope availability.** Confirm `@legioncodeinc` is free / already owned by us on npmjs.com. If
  taken by a third party, STOP and escalate the naming decision (alternatives `@legioncode`, `@olliebot`)
  to the PRD-048 owner before 048b renames anything.
- **Create the org** `@legioncodeinc` on npmjs.com (if it does not exist) under the maintainer's account.
- **Add members + rights.** Maintainer = org member with publish rights (break-glass / local manual
  publishes). Mint a granular **Automation** access token scoped to publish for `@legioncodeinc/*` (or the
  single package) — this is the CI identity.
- **Wire the secret.** GitHub → repo Settings → Secrets and variables → Actions → new repository secret
  `NPM_TOKEN` = the Automation token.
- **Document the rotation owner** (who rotates the token, on what cadence) in RELEASING.md or a short note,
  so the credential is not orphaned.

## Acceptance criteria
- **a-AC-1 — Org exists + is ours.** `@legioncodeinc` exists on npmjs.com and the maintainer's account is
  a member with publish rights. Verified via `npm org ls legioncodeinc` or the npmjs org page.
- **a-AC-2 — Automation token minted + scoped.** An Automation-type token (2FA-bypassing) scoped to the
  package/scope exists. Its value is NEVER committed to the repo or pasted into any tracked file.
- **a-AC-3 — `NPM_TOKEN` secret set.** The token is stored as the GitHub Actions repository secret
  `NPM_TOKEN`. Verified by `release.yaml`'s token gate resolving `has_token=true` on a dispatch run.
- **a-AC-4 — Rotation owner recorded.** A one-line note names who owns token rotation and the cadence.

## Risks / Out of scope
- **Risk — scope unavailable.** Handle by verifying FIRST (a-AC-1 blocks 048b); escalate naming, do not
  silently pick a different scope.
- **Risk — token too broad / never rotated.** Mitigated by a granular Automation token + a recorded
  rotation owner (a-AC-2/a-AC-4).
- **Out of scope — the in-repo rename / switch-flips (048b).** This sub-PRD only provisions the account
  side; it changes no `package.json` field.
- **Out of scope — actually publishing.** Provisioning makes a real publish possible; PRD-048 D-1 keeps it
  out of scope.

## Dependencies
- npmjs.com account (the maintainer's — confirmed: the user has an NPMjs account).
- GitHub repo admin access to set the Actions secret.
- `release.yaml`'s token gate (the consumer of `NPM_TOKEN`) — already wired; this only feeds it.
