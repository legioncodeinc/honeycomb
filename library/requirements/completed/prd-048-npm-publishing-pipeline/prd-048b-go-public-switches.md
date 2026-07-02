# PRD-048b — Go-public switch-flips + `@honeycomb/sdk` name reconciliation

> Status: backlog · Parent: PRD-048 · Wave: W0 · Type: M
> Goal: flip the three in-repo go-public switches (scoped name, `publishConfig`, remove `private`) in ONE
> commit, and reconcile every shipped name reference so the published tarball advertises a package name
> that actually resolves. After this lands, the release preflight stops failing closed.

## Why
RELEASING.md steps (a)–(c) are three edits to `package.json`, all present today as draft markers:
`"name": "honeycomb"` (taken, unscoped), a **commented** `//publishConfig` block, and `"private": true`.
Flipping them is what arms a real publish. Doing them together (D-3) avoids a half-flipped state where
the preflight's intent is ambiguous. AND: renaming the package to `@legioncodeinc/honeycomb` changes what
the SDK subpath exports resolve as (`@legioncodeinc/honeycomb`, `…/react`, `…/vercel`, `…/openai`), while
README + `src/sdk/` still advertise the placeholder `@honeycomb/sdk` — a name that exists nowhere. The
README ships *inside the tarball* (`files` allowlist), so a published package whose own docs say
`npm i @honeycomb/sdk` is a broken first impression (D-4).

## What (scope)
- **(a) Scoped name.** `package.json` `name`: `honeycomb` → `@legioncodeinc/honeycomb`. Leave `bin`
  (`"honeycomb": "bundle/cli.js"`) untouched — the command stays `honeycomb`.
- **(b) `publishConfig`.** Uncomment the existing `//publishConfig` block into a real
  `"publishConfig": { "access": "public", "provenance": true }`.
- **(c) Remove the guard.** Delete `"private": true`.
- **Update the draft marker.** Remove or update the `//go-public` explainer key in `package.json` so it no
  longer says "DRAFT — un-publishable"; point it at RELEASING.md's "Cut the release" section instead.
- **Reconcile name references (D-4).** Replace load-bearing `@honeycomb/sdk` references with
  `@legioncodeinc/honeycomb` (+ correct subpaths) in: README (the SDK/install bullet), `src/sdk/CONVENTIONS.md`,
  and the `src/sdk/index.ts` barrel comment. Keep the historical PRD-019e references in `library/` as-is
  (they are archival, not shipped) — only shipped artifacts must be correct.

## Acceptance criteria
- **b-AC-1 — Name is scoped.** `package.json` `name === "@legioncodeinc/honeycomb"`; `bin.honeycomb`
  unchanged.
- **b-AC-2 — publishConfig is live + public + signed.** A real (uncommented) `publishConfig` with
  `access: "public"` and `provenance: true`.
- **b-AC-3 — Guard removed.** No `private` key in `package.json`.
- **b-AC-4 — Preflight passes.** `release.yaml`'s publishability preflight no longer aborts (both
  conditions false) — verified on a dispatch run. (Note: this DISARMS the hard safety catch — see PRD-048
  D-6; the operative guard becomes "no tag pushed", enforced by 048d.)
- **b-AC-5 — No dangling `@honeycomb/sdk` in shipped artifacts.** `grep -rn "@honeycomb/sdk"` over README +
  `src/sdk/**` returns nothing load-bearing; install/SDK docs reference `@legioncodeinc/honeycomb` and its
  real subpaths. The core import is `@legioncodeinc/honeycomb`; helpers are `@legioncodeinc/honeycomb/react`
  (etc.).
- **b-AC-6 — Gates green.** `npm run ci` + `build` + `pack:check` stay green after the rename (the
  `exports`/`files` paths are name-independent, so the bundle is unaffected).

## Risks / Out of scope
- **Risk — disarming the safety catch.** Flipping (a)/(c) means the preflight no longer fails closed.
  Mitigated by sequencing: land this on the working branch, and rely on PRD-048 D-1/D-6 (no tag) + 048d's
  "no tag + no real dispatch" guard. Do NOT merge-and-tag in the same motion.
- **Risk — missed name reference ships a broken doc.** Mitigated by the grep gate (b-AC-5) over shipped
  files specifically.
- **Out of scope — token/secret (048a) and the `"version"` lifecycle (048c).** Separate sub-PRDs.
- **Out of scope — renaming the SDK into its own package.** Subpath exports of the scoped main package
  only (PRD-019e open question stays deferred).

## Dependencies
- **048a** — the `@legioncodeinc` org must exist (b-AC-4's dispatch run reaching the publish step needs the
  scope to be real for a meaningful dry-run, and the name must be one we own).
- `package.json` (`name`, `//publishConfig`, `private`, `//go-public`, `bin`, `exports`, `files`).
- README, `src/sdk/CONVENTIONS.md`, `src/sdk/index.ts` (the shipped name references).
- `release.yaml`'s preflight (the consumer that flips from fail-closed to pass).
