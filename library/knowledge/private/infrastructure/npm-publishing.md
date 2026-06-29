# npm Publishing Pipeline

> Category: Infrastructure | Version: 1.1 | Date: June 2026 | Status: Active

How Honeycomb ships to npm as the scoped package `@legioncodeinc/honeycomb`, the `files` allowlist, the `prepack` build, the `pack-check.mjs` secret/required-file scan, the `release.yaml` workflow, OIDC Trusted Publishing with npm provenance, the fails-closed publishability preflight, and the post-publish global-install smoke that proves the shipped CLI actually runs.

**Related:**
- [`monorepo-build-release.md`](monorepo-build-release.md)
- [`../operations/install-and-onboarding.md`](../operations/install-and-onboarding.md)
- [`../operations/cli-command-architecture.md`](../operations/cli-command-architecture.md)
- [`../security/secrets.md`](../security/secrets.md)

---

## Why this exists

The one-command installer (see [Install and Onboarding](../operations/install-and-onboarding.md)) ends by running `npm i -g @legioncodeinc/honeycomb`. For that to work in the field, the package has to actually exist on the public registry, ship the right files, and ship *no* secrets. This pipeline is what turns the monorepo's built bundles into a published, provenance-signed tarball that is one tag push away from a release.

The defining property of the pipeline is that it **fails closed**. The machinery, the full CI gate, the build, the audits, the tarball scan, a tag-vs-version guard, a publishability preflight, and tokenless OIDC auth, is all wired and rehearsable, but multiple independent guards stop an accidental or broken publish. A real publish is a deliberate human act (a pushed `vX.Y.Z` tag), never a side effect.

---

## Published package identity

| Field | Value |
|---|---|
| Package name | `@legioncodeinc/honeycomb` (scoped to the `legioncodeinc` org) |
| Bin | `honeycomb` → `bundle/cli.js` (independent of the package name, consumers still get a `honeycomb` command) |
| SDK subpath exports | `.` (core `HoneycombClient`), `./react`, `./vercel`, `./openai` |
| Access | `public` (scoped packages default to restricted; the publish forces public) |
| Provenance | on (OIDC supply-chain attestation) |
| License | `AGPL-3.0-or-later` |

The scoped name matches the GitHub org. The bin name stays `honeycomb` regardless of the package name, so install docs and the installer always invoke `honeycomb`. The SDK ships as **subpath exports of the main package** (`@legioncodeinc/honeycomb/react`, `/vercel`, `/openai`), not a separate package, the `exports` map in `package.json` points each subpath at a `./sdk/*.js` entry. README and `src/sdk/` docs advertise the scoped name and its subpaths so the tarball never ships install instructions for a name that does not resolve.

---

## What ships: the `files` allowlist

Publishing is **allowlist-driven**, not `.npmignore`-driven: the `files` array in `package.json` is the exact set of paths that reach the tarball. It carries the built artifacts and the runtime assets the daemon-served dashboard reads, and nothing else:

- `bundle` (the `honeycomb` CLI), `daemon` (the long-lived daemon), `sdk` (the SDK entries), `mcp/bundle`, `embeddings/embed-daemon.js`
- `harnesses/*/bundle` (plus the Claude Code plugin manifest/hooks, OpenClaw `dist` + plugin manifest, Codex/OpenClaw `package.json`)
- `assets/styles.css`, `assets/tokens`, `assets/logos/honeycomb-memory-cluster.svg`, `assets/logos/fonts`, the CSS, design tokens, brand mark, and fonts the dashboard serves at runtime
- `.claude-plugin`, `scripts/ensure-tree-sitter.mjs`, `scripts/ensure-embed-deps.mjs`, `README.md`

The embedding runtime (`@huggingface/transformers` + its ONNX native runtime, ~600 MB with the model acquired at first run) is an **optional dependency**, deliberately *not* in the `files` allowlist, the model is downloaded and cached on the daemon's first warmup, keeping the published tarball lean and `npm i` fast. A slimmed/offline install simply runs recall on the BM25/ILIKE lexical fallback.

`prepack` runs `npm run build` (`tsc && node esbuild.config.mjs`), so the tarball is always built from the just-checked-out tree, the published bundles can never lag the source. `postinstall` runs `ensure-tree-sitter` + `ensure-embed-deps` on the consumer's machine to resolve the native `tree-sitter` prebuilds esbuild leaves external.

---

## The tarball guard: `pack-check.mjs`

`scripts/pack-check.mjs` (the `pack:check` script) runs `npm pack --dry-run --json` and asserts two things over the resulting file list, **before any token is touched**:

1. **No forbidden files.** It refuses to publish if the tarball would include `.npmrc`, `.env*`, anything under `secrets/`, `.github/`, or `.git/`, private-key/credential material (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`/`id_ed25519`/…), or, pointedly, any `credentials.json`. This catches a future PR that widens the `files` allowlist or switches to a permissive `.npmignore` from leaking a secret into the package.
2. **All required runtime files present.** It refuses to publish if the tarball is *missing* the `honeycomb` bin (`bundle/cli.js`), the daemon entry, the bundled dashboard app, the dashboard CSS, the design-token CSS, the brand logo, or a brand font (`assets/logos/fonts/JetBrainsMono-Regular.woff2`). The dashboard reads these from `assets/` at runtime, so an install missing them would render unstyled or 404 its fonts, a regression the forbidden-only scan cannot catch.

`pack-check` runs in the release pipeline and is also a standalone dogfood: `npm pack` + `npm install ./*.tgz` into a scratch dir proves the *artifact* (the actual runtime tarball, assets, fonts, logo, bins) works, complementing the CI dry-run that proves the *pipeline*.

---

## The release workflow

`.github/workflows/release.yaml` runs the **same full gate as `ci.yaml`** and then publishes. There are two ways in:

- **Push a version tag `vX.Y.Z`** → a real publish attempt (still gated by every guard below).
- **`workflow_dispatch`** → rehearse the whole pipeline (`dry_run` defaults to `true`, so the manual button is safe by default; a maintainer must opt *in* to a real publish).

The job, in order:

1. **Setup Node 22 + upgrade npm to ≥ 11.5.1.** Node 22 bundles npm 10.x, but OIDC Trusted Publishing requires npm ≥ 11.5.1; the upgrade runs before any `npm` invocation so the OIDC handshake can engage. Dependency caching is off on this high-privilege job (cache-poisoning hardening); `npm ci` installs from the committed lockfile.
2. **Quality gate**, `npm run ci` (typecheck + jscpd duplication + vitest + `audit:sql`).
3. **Build**, `npm run build`, with the telemetry `define` env (`HONEYCOMB_POSTHOG_KEY` secret + `HONEYCOMB_REF_DEFAULT` var) scoped to *just* this step.
4. **`audit:openclaw`** (ClawHub bundle rules) and **`pack:check`** (the tarball scan above).
5. **Tag-vs-version guard**, on a tag push the pushed `vX.Y.Z` must equal `package.json`'s version (which `sync-versions` has propagated into every manifest); a mismatch aborts.
6. **Publishability preflight** (the fails-closed guard, below).
7. **Resolve publish mode**, gated on the *trigger*, not a token.
8. **Publish** (`npm publish --provenance --access public`) or **dry-run rehearsal** (the same command with `--dry-run`).
9. **Mark publish succeeded**, a `published=true` job output emitted from a step that runs *immediately after* a real publish step succeeds. Because steps run sequentially, a failed publish stops the job before this step is reached, so the flag tracks publish *completion*, not publish *intent*. This signal, not `steps.mode.outputs.publish`, is what gates the downstream smoke (see [Post-publish install smoke](#post-publish-install-smoke)), so a later step erroring cannot leave a shipped artifact untested.
10. **GitHub Release**, only on a real tag push *and* a real publish, using `generate_release_notes`.

`prepack` (= `npm run build`) runs *again* inside `npm publish`, so the build env (the telemetry `define`) is repeated on the publish step too, and the tarball is rebuilt from the checked-out tree.

After the `release` job, a separate **`post-publish-smoke`** matrix job installs the just-published tarball from the public registry and proves the `honeycomb` bin actually runs. See the section below.

---

## OIDC Trusted Publishing and provenance

CI publishes **tokenlessly** via npm Trusted Publishing (OIDC), there is no `NPM_TOKEN` anywhere in the workflow or repo secrets. The workflow's `id-token: write` permission grants a short-lived OIDC identity that does double duty:

1. It is the **publish auth**, npm verifies it against the trusted publisher configured on the package (org + repo `honeycomb` + workflow filename `release.yaml`). A mismatch on any of those three silently denies the publish.
2. It **signs provenance**, `npm publish --provenance` emits a verifiable supply-chain attestation against the same identity.

Removing the long-lived automation token eliminates the largest standing supply-chain liability (a token that can leak, must be scoped, and must be rotated). **Bootstrap nuance:** a trusted publisher can only be configured on a package that *already exists* on npm, so the very first publish is a one-time manual 2FA publish by an org member; every subsequent CI publish is tokenless.

With Trusted Publishing the only release secret is `HONEYCOMB_POSTHOG_KEY` (the public write-only PostHog ingest key for adoption telemetry, see [Install and Onboarding](../operations/install-and-onboarding.md#operator-adoption-telemetry)), which lives only in GitHub Actions secrets and is never committed. There is no token to set alongside it.

---

## The fails-closed preflight

The publishability preflight is the guard that keeps a stray tag push from publishing a broken or duplicate package. It aborts *before any publish* if **either**:

- `package.json` still has `private: true`, the deliberate "don't publish yet" guard is intact, so this is not a real go-public; or
- `name` is the unscoped `honeycomb`, that name is already owned by a third party on the public registry, so a publish under it is impossible (403) or wrong.

Going public flips these switches together in one commit (scoped name, uncommented `publishConfig` with `access: public` + `provenance: true`, and the `private` key removed), so the repo is never half-flipped. Once flipped, the preflight passes and is no longer a hard catch, at which point the operative guard against an accidental publish is the **trigger** itself: a real `npm publish` only runs when the event is a `push`, the ref is a tag, and it is not a dry run. A `workflow_dispatch` always rehearses (it is not a `push`), even if pointed at a tag with dry-run unchecked. Real publishes only ever come from a pushed `vX.Y.Z` tag, and the trusted publisher only authorizes publishes from this repo's `release.yaml`.

---

## Post-publish install smoke

Every guard above runs *before* the upload: the CI gate, the tarball scan, the tag-vs-version guard, and the preflight all prove the *pipeline* and the *artifact-in-a-dry-run* are sound. None of them install the **published** package through the npm **global bin**. That gap shipped a real regression: v0.1.10 (PR #172) was a fix for a global install where every `honeycomb` command printed 0 bytes and exited 0, a silent CLI that sailed through the entire green gate because nothing ran the bin the way a user does. The `isCliEntry` unit test added alongside the fix guards the *logic* but can only simulate bin resolution; it never exercises a real registry install.

`post-publish-smoke` closes that gap. It is a separate job (`needs: release`) that runs **only on a real publish**, gated on `!cancelled() && needs.release.outputs.published == 'true'`. The `!cancelled()` overrides the implicit `success()`, so the smoke still runs when the `release` job published successfully but *then* failed a later step (for example, Create GitHub Release erroring), a shipped artifact is always smoke-tested.

The job runs as a 3-OS matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`, `fail-fast: false` so one OS failing still reports the others) because the bin is resolved differently per platform: a **symlink** in `<prefix>/bin` on Unix, a **`.cmd`/`.ps1` shim** in `<prefix>` on Windows, two resolution paths the unit test cannot cover. Each leg:

1. **Resolves the published version** from the pushed tag (`${GITHUB_REF_NAME#v}`).
2. **Waits for the registry to serve it**, a 30 x 10s poll on `npm view @legioncodeinc/honeycomb@<version> version`, because the registry can lag a few seconds behind a successful publish. A timeout fails the job.
3. **Global-installs from the public registry**: `npm install -g @legioncodeinc/honeycomb@<version>`.
4. **Puts the global npm bin on PATH explicitly** (both `<prefix>` for Windows shims and `<prefix>/bin` for Unix symlinks), so the smoke invokes `honeycomb` **by name through PATH**, exactly as a user would, never via an absolute path that would mask the resolution bug.
5. **Asserts `honeycomb --version`** produces non-empty output that **contains the published version** (the direct guard against the PR #172 silent-exit class).
6. **Asserts `honeycomb --help`** prints non-empty (the entry guard fired).

It cannot un-publish a bad release, npm releases are immutable, but it turns the release run **red immediately** so a fix-up patch ships fast instead of users hitting a dead CLI. A companion `hivedoctor` real-npm smoke test (`tests/`, vitest) was given a raised timeout to absorb the Windows install flake the global-install path surfaces.

---

## Version single-sourcing

`npm version` runs npm's `version` lifecycle, and a wired `"version"` script (`node scripts/sync-versions.mjs && git add -A`) propagates the bumped version into every harness manifest *and* stages them into the version commit. This closes a manifest-drift gap: the CI tag-vs-version guard checks only the *root* `package.json` version, so a drifted harness manifest would otherwise sail through. With the lifecycle script wired, the tagged commit is always internally consistent. The propagation targets are documented in [Monorepo Build and Release](monorepo-build-release.md#version-synchronization).
