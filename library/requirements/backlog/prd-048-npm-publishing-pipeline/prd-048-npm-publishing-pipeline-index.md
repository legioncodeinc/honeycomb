# PRD-048 — NPM publishing pipeline go-public (org provisioning, switch-flips, rehearsal)

> Status: backlog · Owner: `/the-smoker` · Type: M (multi-feature, partly off-repo)
> Goal: take Honeycomb from a deliberately **un-publishable draft** to a package that is
> one tag push away from a real npm release — by provisioning the `@legioncodeinc` npm org,
> flipping the four go-public switches documented in [RELEASING.md](../../../../RELEASING.md),
> hardening the version-sync lifecycle gap RELEASING.md flags, and proving the whole pipeline
> green via a CI dry-run + a local pack-install dogfood. **The first real tag-push publish is
> explicitly OUT of scope** (a separate, deliberate manual step) — this PRD ends with the line
> green and the safety catch (`private`/name guard) being the only thing between us and live.

## Why
The publish infrastructure is **already built and rehearsable** — and that is exactly why this is
a switch-flipping PRD, not a build-it-from-scratch PRD. A grounded read of the release surface
(`.github/workflows/release.yaml`, `RELEASING.md`, `scripts/pack-check.mjs`, `scripts/sync-versions.mjs`,
`package.json`) shows:

- **The pipeline exists and fails closed.** `release.yaml` runs the full CI gate + build + audits +
  pack-check, a tag-vs-`package.json` version guard, a **publishability preflight that aborts if
  `private: true` or the name is the unscoped `honeycomb`**, a token gate (no `NPM_TOKEN` → `--dry-run`,
  stays green), provenance via OIDC (`id-token: write`), and a GitHub Release step. Nothing is missing
  from the *machinery*.
- **The package ships deliberately un-publishable.** `package.json` carries `"private": true`, the
  unscoped name `honeycomb` (owned by a third party on npm — `honeycomb@0.1.4`), and a **commented-out**
  `publishConfig` block. This is intentional: a stray tag push cannot leak a broken or duplicate package.
- **Going public is a documented sequence of four conscious switches** (RELEASING.md): (a) scoped name,
  (b) `publishConfig` public+provenance, (c) remove `private`, (d) set the `NPM_TOKEN` repo secret —
  plus the off-repo prerequisite that the **npm org/scope must exist** with our identity as a publishing
  member.
- **RELEASING.md flags one real gap.** `npm version` runs npm's `version` lifecycle but **not**
  `prebuild`, so `scripts/sync-versions.mjs` does not auto-run on a version bump. Without a wired
  `"version"` npm script, the propagated harness-manifest versions can drift out of the tagged commit —
  a latent footgun the go-live runbook currently works around by hand.
- **The published name is changing, so name references must be reconciled.** Renaming the package to
  `@legioncodeinc/honeycomb` makes the SDK subpath entries resolve as `@legioncodeinc/honeycomb`,
  `@legioncodeinc/honeycomb/react`, etc. — but README and `src/sdk/` docs currently advertise the
  placeholder `@honeycomb/sdk`. Install instructions that ship in the tarball must be correct on day one.

This PRD spends the existing infrastructure: it does the off-repo provisioning, flips the switches the
infra was built to wait for, closes the version-sync gap, fixes the now-incorrect install docs, and
proves it all green WITHOUT crossing the go-live line.

## Decisions (made before authoring)
- **D-0 — Scoped name is `@legioncodeinc/honeycomb`.** Matches the GitHub org `legioncodeinc` and
  RELEASING.md's primary recommendation. The `bin` stays `honeycomb` (independent of package name —
  consumers still get a `honeycomb` command). *(User decision, 2026-06-22.)*
- **D-1 — Scope depth STOPS at a green rehearsal.** This PRD ends at: CI dry-run green on a branch with
  all switches flipped + a local `pack:check` + scratch-dir install dogfood passing. The actual
  `npm version` + `git push --follow-tags` that publishes `vX.Y.Z` is a **separate manual go-live step**,
  not an acceptance criterion here. *(User decision, 2026-06-22.)*

## What (scope)
Four sub-PRDs, sequenced so the off-repo provisioning and the safe in-repo edits come first, the
lifecycle hardening lands before any tag is ever cut, and the rehearsal/verification proves the whole
chain last:

| Sub-PRD | Wave | Deliverable | Confidence |
|---|---|---|---|
| **048a** | W0 | **npm org `@legioncodeinc` provisioning** — org exists, publishing identity is a member, automation token minted, `NPM_TOKEN` repo secret set | high (off-repo, manual) |
| **048b** | W0 | **Go-public switch-flips + name reconciliation** — scoped name, `publishConfig`, remove `private`, fix README/SDK `@honeycomb/sdk` → `@legioncodeinc/honeycomb` | high |
| **048c** | W1 | **Version-sync lifecycle hardening** — wire the `"version"` npm script so `sync-versions` + `git add` run inside `npm version`, closing the manifest-drift gap | high |
| **048d** | W1 | **Rehearsal + verification** — CI dry-run green with switches flipped, local `pack:check` + `npm pack` + scratch-dir install dogfood; NO tag pushed | high |

## Design alternatives + recommendation (per sub-PRD)

### 048a — where the publishing identity lives
- **(a) Publish as a personal npm account** added to the `@legioncodeinc` org. Simple; ties releases to
  one human.
- **(b) An org automation token** (type: Automation, bypasses 2FA in CI) as the CI publishing identity,
  with humans as org members for break-glass local publishes.
**RECOMMENDED: (b) for CI** (`release.yaml` already reads `NPM_TOKEN` and expects an automation token —
RELEASING.md step (d)), with the maintainer's personal account as an org **member** for rehearsal/manual
fallback. The token is the CI identity; the human is the owner-of-last-resort.

### 048b — how aggressively to reconcile the `@honeycomb/sdk` placeholder
- **(a) Minimal:** flip the four switches; leave README/SDK docs saying `@honeycomb/sdk`.
- **(b) Reconcile:** flip the switches AND update README + `src/sdk/CONVENTIONS.md` + the `index.ts`
  barrel comment so the advertised import path matches what actually resolves post-publish
  (`@legioncodeinc/honeycomb` and its `/react`,`/vercel`,`/openai` subpaths).
**RECOMMENDED: (b).** The README ships *in the tarball* (`files` allowlist) — a published package whose
own README tells users to `npm i @honeycomb/sdk` (a name that does not exist) is a broken first
impression. Docs-vs-reality reconciliation is cheap and must land with the rename, not after.

### 048c — closing the `npm version` / sync-versions gap
- **(a) Document-only:** keep RELEASING.md's "run sync-versions before `npm version` by hand" workaround.
- **(b) Wire a `"version"` npm script:** `"version": "node scripts/sync-versions.mjs && git add -A"` so a
  bump auto-propagates the version into every harness manifest AND stages them into the version commit.
**RECOMMENDED: (b).** A manual pre-step is a footgun that ships a mislabeled package the day someone
forgets it; the CI tag-vs-`package.json` guard only checks the *root* version, so drifted manifest
versions sail through. Automate it so the tagged commit is always internally consistent.

### 048d — how to rehearse without going live
- **(a) CI dry-run only** — `workflow_dispatch` with `dry_run=true` (the default), confirm green.
- **(b) CI dry-run + local pack-install dogfood** — also `pack:check` + `npm pack` + install the tarball
  into a scratch dir and smoke the CLI/dashboard, proving the *runtime* tarball (assets, fonts, logo,
  bins) actually works, not just that the pipeline is green.
**RECOMMENDED: (b).** The CI dry-run proves the *pipeline*; the local install proves the *artifact*.
Both are safe (RELEASING.md: `private: true` blocks `npm publish` but NOT `npm pack`/local install), and
together they are the strongest go-live confidence available short of publishing.

## Decisions
- **D-2 — CI publishes via an org Automation token (048a); humans are org members for break-glass
  (048a).** The `NPM_TOKEN` secret is the CI identity; no release depends on a single human's 2FA.
- **D-3 — The scoped name + `publishConfig` + `private` removal land together in ONE switch-flip commit
  (048b),** so the repo is never in a half-flipped state where the preflight's intent is ambiguous.
- **D-4 — README + SDK docs are reconciled to `@legioncodeinc/honeycomb` in the same change as the rename
  (048b).** The tarball never ships install instructions for a name that does not exist.
- **D-5 — The `"version"` lifecycle script is wired BEFORE any tag is ever cut (048c).** Manifest drift
  is closed by automation, not by a runbook step a human can forget.
- **D-6 — This PRD does NOT push a tag (D-1).** Acceptance ends at a green dry-run + local dogfood; the
  go-live tag is a separate, deliberate, human-pulled trigger. The preflight stays the safety catch
  until then — but note flipping `private`/name (048b) DISARMS that catch, so the only remaining guard
  against an accidental publish becomes "no tag pushed + no real-publish dispatch." 048d records this.
- **D-7 — Provenance stays ON.** `publishConfig.provenance: true` + the workflow's `--provenance` +
  `id-token: write` are kept; the first (later) real publish carries an OIDC supply-chain attestation.

## Acceptance criteria
- **AC-1 — The npm org is real and publish-capable (048a).** `@legioncodeinc` exists on npmjs.com; the
  CI automation identity and the maintainer are members with publish rights to the scope; an Automation
  token is minted and stored as the `NPM_TOKEN` GitHub Actions repo secret. Verified by `npm org ls
  legioncodeinc` (or the npmjs UI) and a token-present `release.yaml` run reaching the publish step in
  `--dry-run` mode.
- **AC-2 — The four go-public switches are flipped (048b).** `package.json` has `name:
  "@legioncodeinc/honeycomb"`, an uncommented `publishConfig` with `access: "public"` + `provenance:
  true`, and **no** `private` key; the release preflight's two abort conditions are both false. Proven by
  the preflight step passing in a dispatch run.
- **AC-3 — Name references are consistent (048b).** No shipped artifact advertises the non-existent
  `@honeycomb/sdk`: README and `src/sdk/CONVENTIONS.md` + the `src/sdk/index.ts` barrel comment reference
  `@legioncodeinc/honeycomb` (+ its `/react`,`/vercel`,`/openai` subpaths). `grep -rn "@honeycomb/sdk"`
  over shipped files (README, `src/sdk/**`) returns nothing load-bearing.
- **AC-4 — Version bumps stay internally consistent (048c).** A `"version"` npm script runs
  `scripts/sync-versions.mjs` + `git add` so `npm version <bump>` propagates the new version into every
  harness manifest AND stages them into the version commit. Proven by a dry `npm version --no-git-tag-version`
  (or a throwaway bump) showing all harness manifests updated and staged, then reverted.
- **AC-5 — The pipeline is green end-to-end in dry-run (048d).** A `workflow_dispatch` run of
  `release.yaml` (with the switches flipped on the branch) clears the full gate, build, audits,
  pack-check, the tag-vs-version guard (or its dispatch-skip), the **now-passing** preflight, and reaches
  `npm publish --provenance --access public --dry-run` green.
- **AC-6 — The runtime tarball actually works (048d).** `npm run pack:check` passes (required files
  present, no forbidden files/secrets), and `npm pack` + `npm install ./*.tgz` into a scratch dir yields
  a working `honeycomb` CLI and a dashboard whose assets (CSS, fonts, logo) load.
- **AC-7 — No accidental go-live (D-1/D-6).** No `vX.Y.Z` tag is pushed and no real publish occurs as
  part of this PRD; `npm view @legioncodeinc/honeycomb` still 404s (or shows nothing published by us) at
  PRD close. The go-live runbook (RELEASING.md "Cut the release") is confirmed accurate against the flipped
  state and is the only remaining step.
- **AC-8 — Gates stay green.** `npm run ci` / `build` / `audit:openclaw` / `audit:sql` / `pack:check`
  stay green across every sub-PRD; no secret/token is committed (the `NPM_TOKEN` lives only in GitHub
  Actions secrets, never in the repo — grep-proven).

## Risks / Out of scope
- **Risk — flipping `private`/name DISARMS the only hard safety catch.** Once 048b lands, the preflight no
  longer fails closed, so an accidental tag push or a `dry_run=false` dispatch with the token set WOULD
  publish. Mitigated by D-1/D-6 (no tag this PRD), by 048d documenting that "no tag + no real dispatch" is
  now the operative guard, and by the token-gate still requiring `NPM_TOKEN` to be present for a real
  publish. The go-live tag remains a deliberate human action.
- **Risk — the `@legioncodeinc` npm org name is itself taken/unavailable.** Mitigated in 048a: verify
  scope availability FIRST; if unavailable, escalate the naming decision (the alternatives
  `@legioncode` / `@olliebot` were on the table) before any in-repo rename in 048b.
- **Risk — automation token scope/expiry.** An over-broad or short-lived token is a supply-chain liability.
  Mitigated by 048a: a granular Automation token scoped to the package/scope, with a documented rotation
  owner.
- **Risk — first publish is irreversible-ish.** npm unpublish is heavily restricted within 72h and blocked
  after. Mitigated by D-1 (this PRD does not publish) + the local pack-install dogfood (048d) catching
  artifact defects before the human ever cuts the real tag.
- **Out of scope — the first real `vX.Y.Z` publish + GitHub Release.** Deliberately deferred to a manual
  go-live step (D-1). This PRD makes it a one-command action; it does not take it.
- **Out of scope — the build/bundle/pack-check machinery itself.** Owned by PRD-001b and the existing
  `ci-release` surface; this PRD consumes them, it does not re-spec them.
- **Out of scope — publishing the SDK as its own separate npm package.** `@honeycomb/sdk`-as-its-own-package
  was an explicit PRD-019e open question; this PRD ships the SDK as subpath exports of the main scoped
  package only.
- **Out of scope — CHANGELOG / release-notes prose.** Owned by `changelog-release-notes-worker-bee`; the
  GitHub Release uses `generate_release_notes` for now.

## Dependencies
- **The release pipeline (the machinery).** `.github/workflows/release.yaml` (gate + preflight + token gate
  + provenance + Release), `RELEASING.md` (the canonical go-public runbook this PRD executes and verifies),
  `scripts/pack-check.mjs` (the tarball guard 048d runs).
- **`package.json`** — the `name`, `private`, commented `publishConfig`, `files` allowlist, `bin`, and the
  `scripts` block where 048c wires the `"version"` lifecycle hook.
- **`scripts/sync-versions.mjs`** — the version single-source propagator 048c wires into `npm version`.
- **`src/sdk/**` + README** — the name references 048b reconciles (`exports` subpaths, `CONVENTIONS.md`,
  the barrel comment, README install/SDK sections).
- **npmjs.com org `@legioncodeinc`** (off-repo) — must exist with publish rights before 048b's rename is
  meaningful (048a is the hard prerequisite for any real or dry-run-to-publish-step run).
- **Project memory — DeepLake/dogfood discipline.** The local pack-install dogfood (048d) is the
  "run the live dogfood before declaring a wiring PRD done" rule applied to packaging: a green CI dry-run
  is necessary but not sufficient; the artifact must be installed and exercised.

## Sub-PRD index
- [048a — npm org `@legioncodeinc` provisioning + token](prd-048a-npm-org-provisioning.md) (W0)
- [048b — Go-public switch-flips + `@honeycomb/sdk` name reconciliation](prd-048b-go-public-switches.md) (W0)
- [048c — Version-sync lifecycle hardening (`"version"` npm script)](prd-048c-version-sync-lifecycle.md) (W1)
- [048d — Rehearsal + verification (CI dry-run + local pack-install dogfood)](prd-048d-rehearsal-verification.md) (W1)
