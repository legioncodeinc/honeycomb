# PRD-048d — Rehearsal + verification (CI dry-run + local pack-install dogfood)

> Status: backlog · Parent: PRD-048 · Wave: W1 · Type: M
> Goal: prove the whole publish chain green WITHOUT going live — a CI `workflow_dispatch` dry-run on the
> switch-flipped branch reaching the publish step green, plus a local `pack:check` + `npm pack` +
> scratch-dir install dogfood that proves the *runtime tarball* actually works. This is the PRD's close-out
> and the strongest go-live confidence short of publishing.

## Why
A green pipeline proves the *machinery*; an installed tarball proves the *artifact*. Project memory: run
the live dogfood before declaring a wiring PRD done — a CI dry-run that never installs the package can pass
while the tarball is missing a runtime asset (CSS, fonts, the logo, a bin) that `pack-check` allow-lists
but a real install would expose. RELEASING.md confirms both rehearsals are safe: `private: true` blocks
`npm publish` but NOT `npm pack` / local install, and the `workflow_dispatch` `dry_run` defaults to true.
After 048b removes `private` and the auth switches to trigger-gated OIDC (PRD-048 D-2′), the catch that
matters becomes "no `vX.Y.Z` tag pushed" — a `workflow_dispatch` always dry-runs (it is not a tag ref), so
only a tag triggers a real publish. This sub-PRD makes that the explicit, documented operative guard and
verifies the pipeline stops exactly one deliberate human action short of live.

## What (scope)
- **CI dry-run rehearsal.** On the branch with 048b's switches flipped, run `release.yaml` via
  Actions → Release → Run workflow with `dry_run` checked (default). Confirm it clears the full gate,
  build, audits, pack-check, the dispatch-skipped tag guard, the now-passing preflight, the npm upgrade
  (>= 11.5.1) and the trigger-gated publish-mode step (a dispatch resolves to dry-run because it is not a
  tag ref — no token involved), and reaches `npm publish --provenance --access public --dry-run` GREEN.
  (The `--dry-run` does no OIDC handshake, so it is green even before the trusted publisher is attached.)
- **Local pack-check.** `npm run pack:check` (runs `prepack` → fresh build, then scans the tarball for
  forbidden/secret files and asserts required runtime files present).
- **Local install dogfood.** `npm pack`, then `npm install ./legioncodeinc-honeycomb-*.tgz` into a scratch
  dir; run `honeycomb --help` and launch the dashboard; confirm assets (CSS, fonts, logo) load — the
  runtime files pack-check allow-lists.
- **Document the operative guard.** Record (in RELEASING.md or 048's report) that, post-048b + the OIDC
  auth switch (D-2′), the safety catch is no longer the preflight nor a token, but the **trigger**: only a
  `vX.Y.Z` tag push publishes (a `workflow_dispatch` always dry-runs, even with `dry_run=false`, because it
  is not a tag ref). So the operative guard is "**no `vX.Y.Z` tag pushed**", and the real go-live is
  RELEASING.md "Cut the release" — a separate, deliberate step.
- **Confirm nothing published.** `npm view @legioncodeinc/honeycomb` still 404s / shows nothing we
  published, at PRD close.

## Acceptance criteria
- **d-AC-1 — CI dry-run green to the publish step.** A `workflow_dispatch` `dry_run=true` run of
  `release.yaml` on the switch-flipped branch reaches `npm publish … --dry-run` green; the preflight passes
  (not fails closed); the publish-mode step resolves to dry-run (a dispatch is not a tag ref — no token
  gate exists any more, auth is tokenless OIDC). Run URL recorded in the report.
- **d-AC-2 — pack-check passes.** `npm run pack:check` is green: required runtime files present, no
  forbidden files, no secrets/tokens in the tarball.
- **d-AC-3 — Installed tarball works.** `npm pack` + install into a scratch dir yields a working
  `honeycomb` CLI (`honeycomb --help`) and a dashboard whose CSS/fonts/logo load. Evidence (terminal
  output / screenshot note) in the report.
- **d-AC-4 — No go-live occurred.** No `vX.Y.Z` tag pushed; no real publish; `npm view
  @legioncodeinc/honeycomb` shows nothing published by us. (PRD-048 AC-7.)
- **d-AC-5 — Operative guard + go-live runbook documented.** RELEASING.md (or the 048 report) states that
  the preflight is now disarmed and auth is tokenless OIDC, names "**no `vX.Y.Z` tag pushed**" as the live
  guard (a dispatch always dry-runs, so only a tag triggers a real publish), and confirms "Cut the release"
  is accurate against the flipped state (including the one-time manual bootstrap publish).

## Risks / Out of scope
- **Risk — an accidental real publish during rehearsal.** Now that the preflight is disarmed (048b) and
  auth is trigger-gated OIDC (D-2′), a real publish is gated purely on a **tag push** — a `workflow_dispatch`
  (even `dry_run=false`) resolves to dry-run because it is not a tag ref, so the disarming-then-stray-tag
  path is the live risk: a stray `vX.Y.Z` tag would publish. Mitigated by pushing NO tag this PRD, leaving
  `dry_run` checked on any dispatch, the trusted publisher only authorizing publishes from this repo's
  `release.yaml`, and d-AC-5's explicit guard documentation.
- **Risk — eventual-consistency / flaky live reads in any smoke.** Project memory: poll to convergence,
  never a single immediate read, in any live-backed smoke this dogfood touches.
- **Risk — scratch-dir install pulls the heavy optional embed dep.** The `@huggingface/transformers`
  optional dep (~600 MB) is NOT in `files` and downloads at first warmup; the install dogfood should run
  with the BM25/lexical fallback (no embed runtime required) to stay fast — confirm the CLI/dashboard work
  without it.
- **Out of scope — the real `vX.Y.Z` publish + GitHub Release.** The deliberate go-live step (PRD-048 D-1).
- **Out of scope — pack-check / build internals.** Consumed as-is.

## Dependencies
- **048a, 048b, 048c** — all switches flipped, org provisioned, version lifecycle wired before a
  representative rehearsal.
- `release.yaml` (the dispatch dry-run target), `scripts/pack-check.mjs` (d-AC-2), the `files` allowlist +
  bundle outputs (the artifact under test), RELEASING.md "Rehearse first" / "Cut the release" (the runbook
  this verifies).
- Project memory: [Dogfood surfaces integration bugs], [DeepLake eventual-consistency poll reads].
