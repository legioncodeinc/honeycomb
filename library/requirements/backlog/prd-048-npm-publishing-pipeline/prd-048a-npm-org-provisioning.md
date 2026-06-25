# PRD-048a — npm org `@legioncodeinc` provisioning + trusted publisher

> Status: backlog · Parent: PRD-048 · Wave: W0 · Type: S (off-repo, manual)
> Goal: make the scope `@legioncodeinc` a real, publish-capable npm org with the maintainer as a member,
> and configure **GitHub Actions as the package's trusted publisher** so CI publishes tokenlessly via OIDC
> (npm Trusted Publishing) — the hard off-repo prerequisite every later sub-PRD's publish step depends on.
> **No `NPM_TOKEN` is minted or stored** (supersedes the original automation-token approach — see PRD-048
> D-2′).

## Why
RELEASING.md step (a): a scoped publish requires the **npm org/scope to already exist** with the
publishing identity as a member. The auth mechanism, however, has been **amended (PRD-048 D-2′, operator
decision)** from an org Automation token to **npm Trusted Publishing (OIDC)**: instead of a long-lived
`NPM_TOKEN` secret, `release.yaml` presents a short-lived GitHub OIDC identity (`id-token: write`) that
npm verifies against a **trusted publisher** configured on the package. None of this lives in the repo —
it is account-side provisioning that must be done by hand with the maintainer's npmjs account before the
in-repo rename (048b) means anything. Doing it first also de-risks the naming decision: if `@legioncodeinc`
is somehow unavailable, we learn it here, before any in-repo churn.

**Bootstrap nuance (the one real wrinkle of Trusted Publishing).** A trusted publisher can only be
configured on a package that **already exists** on npm. So the very first publish cannot be tokenless — it
is a one-time **manual publish** (interactive, 2FA) by a maintainer/org member, which creates the package
on the registry. Only after the package exists can the trusted publisher be attached, after which every
subsequent CI publish from `release.yaml` is tokenless OIDC. (That first manual publish is the deliberate
go-live step PRD-048 D-1 keeps out of scope; this sub-PRD provisions everything up to it.)

## What (scope)
- **Verify scope availability.** Confirm `@legioncodeinc` is free / already owned by us on npmjs.com. If
  taken by a third party, STOP and escalate the naming decision (alternatives `@legioncode`, `@olliebot`)
  to the PRD-048 owner before 048b renames anything.
- **Create the org** `@legioncodeinc` on npmjs.com (if it does not exist) under the maintainer's account.
- **Add members + rights.** Maintainer = org member with publish rights — needed for the one-time
  bootstrap publish and any break-glass / local manual publishes.
- **Configure the trusted publisher (the CI identity — replaces the automation token).** On the package's
  npm settings (after the bootstrap publish has created the package), add a **GitHub Actions trusted
  publisher** with:
  - **Organization / user:** `legioncodeinc`
  - **Repository:** `honeycomb`
  - **Workflow filename:** `release.yaml`
  - **Environment:** optional — leave blank, or set one (and add a matching `environment:` to the publish
    job in `release.yaml`) if an extra approval gate is wanted.
  No token is generated, scoped, or stored anywhere. CI auth is the OIDC handshake; the human identity is
  only the owner-of-last-resort for break-glass.
- **No `NPM_TOKEN` secret.** Do NOT mint an Automation token and do NOT set an `NPM_TOKEN` GitHub Actions
  secret — the workflow no longer reads one. (The only release secret is `HONEYCOMB_POSTHOG_KEY` for
  PRD-050e telemetry, set the same way; see the PRD-048 cross-PRD note.)
- **Note the npm-version floor.** Trusted Publishing requires **npm >= 11.5.1** in CI; `release.yaml`
  upgrades npm before publish (Node 22 ships npm 10.x). No account-side action — recorded here so the
  provisioning owner understands why the workflow upgrades npm.

## Acceptance criteria
- **a-AC-1 — Org exists + is ours.** `@legioncodeinc` exists on npmjs.com and the maintainer's account is
  a member with publish rights. Verified via `npm org ls legioncodeinc` or the npmjs org page.
- **a-AC-2 — Trusted publisher configured (no token).** A GitHub Actions trusted publisher is configured on
  the package — org `legioncodeinc`, repo `honeycomb`, workflow `release.yaml` (optional environment) — so
  CI publishes tokenlessly via OIDC. **No Automation token is minted and no `NPM_TOKEN` secret exists** in
  the repo or GitHub Actions. (Because the trusted publisher requires the package to exist, this AC is
  satisfied once the one-time bootstrap publish has run and the publisher is attached — see a-AC-3.)
- **a-AC-3 — Bootstrap path documented.** RELEASING.md (or a short note) records that the FIRST publish is a
  one-time manual 2FA publish by an org member to create the package, after which the trusted publisher is
  attached and all subsequent CI publishes are tokenless. (The bootstrap publish itself is the PRD-048 D-1
  go-live step — out of scope here; only the documented path is in scope.)
- **a-AC-4 — npm-version floor noted.** It is recorded (here and/or RELEASING.md) that CI must run
  npm >= 11.5.1 for OIDC to engage, and that `release.yaml` upgrades npm before publish — so the provisioner
  does not mistake a tokenless-but-old-npm run for a misconfigured publisher.

## Risks / Out of scope
- **Risk — scope unavailable.** Handle by verifying FIRST (a-AC-1 blocks 048b); escalate naming, do not
  silently pick a different scope.
- **Risk — trusted-publisher misconfig silently denies the publish.** A mismatch in org/repo/workflow
  filename causes npm to reject the OIDC publish. Mitigated by a-AC-2's exact triple
  (`legioncodeinc` / `honeycomb` / `release.yaml`) and a dry-run rehearsal (048d) before the real tag.
- **Risk — bootstrap chicken-and-egg.** Trusted publishing cannot be configured before the package exists;
  forgetting this makes the first CI publish fail. Mitigated by a-AC-3 documenting the one-time manual
  bootstrap publish.
- **Out of scope — the in-repo rename / switch-flips (048b).** This sub-PRD only provisions the account
  side; it changes no `package.json` field.
- **Out of scope — actually publishing (incl. the bootstrap publish).** Provisioning makes a real publish
  possible; PRD-048 D-1 keeps the go-live publish out of scope.

## Dependencies
- npmjs.com account (the maintainer's — confirmed: the user has an NPMjs account).
- GitHub repo admin access to configure the trusted publisher on npm (and, if an environment is used, to
  create it in repo settings). No GitHub Actions secret is set for npm auth.
- `release.yaml`'s OIDC publish path (`id-token: write` + the npm-upgrade step) — already wired; this
  configures the npm-side trusted publisher it authenticates against.
