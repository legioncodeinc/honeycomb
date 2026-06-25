# Releasing honeycomb

This is the go-public checklist for publishing `honeycomb` to the public npm
registry. The publish pipeline (`.github/workflows/release.yaml`) is already
wired and rehearsable, but the package ships **deliberately un-publishable** so
nothing goes out by accident. Going public is a sequence of conscious switches —
this document is the order to flip them in.

> **TL;DR for the impatient maintainer.** You must (1) pick + provision a
> **scoped** npm name (the unscoped `honeycomb` is already taken — see below),
> (2) add `publishConfig` for public access + provenance, (3) remove
> `private: true`, and (4) **configure GitHub Actions as the package's trusted
> publisher on npm** (tokenless OIDC — no `NPM_TOKEN`). Until the three in-repo
> switches are flipped, `release.yaml` runs the full gate + a `--dry-run` and
> stays green without ever publishing.
>
> **Auth is npm Trusted Publishing (OIDC), not a token.** CI authenticates with a
> short-lived GitHub OIDC identity that npm verifies against the trusted publisher
> you configure on the package — there is **no `NPM_TOKEN` secret** anywhere.
> Provenance stays on (same identity). One catch: a trusted publisher can only be
> set on a package that already exists, so the **first** publish is a one-time
> manual 2FA publish; every CI publish after that is tokenless.

---

## The hard constraint: the name `honeycomb` is taken

The bare name **`honeycomb` is already owned by a third party** on the public
npm registry (currently `honeycomb@0.1.4`). You **cannot** publish under the
unscoped name — a publish would 403 or, worse, be wrong. A public release MUST
use a **scoped** name under an npm org/scope you control:

- `@legioncodeinc/honeycomb` (matches the GitHub org `legioncodeinc`), or
- `@legioncode/honeycomb`, or any scope whose npm org exists and lists the
  publishing identity (you, as an org member) with publish rights. CI itself
  publishes tokenlessly via the trusted publisher (switch (d)), not via a member
  account.

The release workflow has a **fail-closed preflight** that aborts the publish if
`package.json` `name` is still the unscoped `honeycomb` OR if `private: true` is
still set — so a stray tag push cannot publish a broken/duplicate package before
these switches are flipped.

---

## The go-public switches (do these in order)

### (a) Choose + provision the scoped name

1. Decide the scope (e.g. `@legioncodeinc`). The corresponding **npm org/scope
   must already exist** on npmjs.com, and your npm account **must be a member**
   with publish rights (for the bootstrap publish and break-glass; CI publishes
   via the trusted publisher in step (d), not an account). Create the org at
   npmjs.com if it does not exist.
2. Set it in `package.json`:
   ```jsonc
   "name": "@legioncodeinc/honeycomb",
   ```
   Do **not** change anything else about the name (the `bin` is `honeycomb`,
   which is independent of the package name and stays as-is — consumers still
   get a `honeycomb` command).

### (b) Make the scoped package public + provenance-signed

Scoped packages default to **restricted** (private) on npm. Add a
`publishConfig` block to `package.json` so a plain `npm publish` goes out public
and signed:

```jsonc
"publishConfig": {
  "access": "public",
  "provenance": true
},
```

(The workflow also passes `--access public --provenance` explicitly, so this is
belt-and-suspenders — but setting it in `package.json` makes local `npm publish`
behave the same as CI.) A commented example of this block lives in
`package.json` next to the `name` field; uncomment + fill it.

### (c) Remove the publish guard

Delete the `private: true` line from `package.json`. This is the single
deliberate "don't publish yet" switch. With it present, `npm publish` refuses to
run at all (npm itself blocks it), which is why the draft is safe.

> Note: `private: true` blocks `npm publish` but **does NOT** block `npm pack`
> or a local `npm install` of a packed tarball. So you can rehearse packaging
> and do a local-install dogfood (below) **without** removing `private` — leave
> it set until you genuinely intend to go live.

### (d) Configure the trusted publisher on npm (tokenless OIDC — no `NPM_TOKEN`)

CI authenticates via **npm Trusted Publishing**: GitHub Actions presents a
short-lived OIDC identity that npm verifies against a trusted publisher you
configure on the package. There is **no `NPM_TOKEN` secret** — nothing
long-lived to leak or rotate.

1. **First publish is a one-time manual bootstrap.** A trusted publisher can only
   be attached to a package that already exists on npm. So the very first release
   is a manual, interactive (2FA) publish by an org member with publish rights:
   ```sh
   npm publish --access public --provenance=false
   ```
   This creates `@legioncodeinc/honeycomb` on the registry. **You must pass
   `--provenance=false`** here: `publishConfig.provenance: true` makes npm try to
   generate a provenance attestation, which only works inside a supported CI OIDC
   environment, so a local publish without the override fails. Provenance is not
   skipped going forward, every subsequent CI publish (tag push) generates it
   normally. (See "Cut the release" below for the bootstrap-vs-subsequent split.)
2. **Attach the trusted publisher.** On npmjs.com → the package → **Settings →
   Trusted Publishers → GitHub Actions**, add:
   - **Organization / user:** `legioncodeinc`
   - **Repository:** `honeycomb`
   - **Workflow filename:** `release.yaml`
   - **Environment:** optional — leave blank, or set one and add a matching
     `environment:` to the publish job in `release.yaml` for an extra approval gate.
3. **Do NOT set an `NPM_TOKEN` secret.** The workflow does not read one. The only
   release secret is `HONEYCOMB_POSTHOG_KEY` (PRD-050e telemetry), set separately.

> **npm version floor.** Trusted Publishing requires **npm >= 11.5.1**. Node 22
> bundles npm 10.x, so `release.yaml` upgrades npm (`npm i -g npm@^11.5.1`) before
> publish — without it the OIDC handshake never engages and the publish fails.

Until the package exists + the trusted publisher is attached, a real CI publish
cannot succeed; before then, `release.yaml` on a `workflow_dispatch` does the gate
+ `npm publish --dry-run` and stays green (the `--dry-run` does no OIDC handshake)
— same skip-don't-fail pattern as `ci.yaml`'s gated integration job.

> **What guards against an accidental publish now.** Once switches (a) through
> (c) are flipped, the fail-closed publishability preflight no longer aborts
> (that is its job; it only blocked the unscoped/`private` draft). And with
> tokenless OIDC there is no `NPM_TOKEN` whose absence used to force a dry-run. So
> the single operative guard becomes the **trigger**: only a `vX.Y.Z` **tag push**
> publishes for real. A `workflow_dispatch` always resolves to `--dry-run` (it is
> not a tag ref), even with `dry_run=false`, because the publish-mode step
> requires a tag push. Put plainly: as long as **no `vX.Y.Z` tag is pushed**,
> nothing goes live. The trusted publisher also only authorizes publishes from
> this repo's `release.yaml`, so no other workflow can publish.

---

## Rehearse first (do this before the real tag)

Two ways to rehearse, both safe and requiring **no** changes to the switches
above:

1. **CI rehearsal** — GitHub → **Actions → Release → Run workflow**, leave
   `dry_run` checked (it defaults to **true**). This runs the entire pipeline —
   the full gate, the build, the audits, pack-check, and `npm publish
   --dry-run` — without publishing. Use this to confirm the pipeline is green.
   (Note: while `private`/name are still un-flipped, the **publishability
   preflight will fail by design** — that proves the guard works. To rehearse
   the *publish path* itself, run the dispatch on a branch where you have flipped
   (a)–(c) but not yet pushed a tag, or accept that a full green rehearsal only
   happens once the go-public switches are in.)
2. **Local rehearsal** — `npm run pack:check` (runs `prepack` → a fresh build,
   then scans the tarball for forbidden + required files), then `npm pack` and
   `npm install ./honeycomb-*.tgz` into a scratch dir and run the dashboard.
   This works even with `private: true` still set.

---

## Cut the release

Once (a)–(d) are flipped and a dry-run rehearsal is green:

1. **Bump the version.** The version is single-sourced in the root
   `package.json` and propagated to every harness manifest by
   `scripts/sync-versions.mjs` (it runs as the `prebuild` hook). Bump with:
   ```sh
   npm version patch   # or: minor | major
   ```
   `npm version` writes the new version into `package.json` and creates the
   annotated git tag `vX.Y.Z`.

   > **The manifests sync automatically.** `npm version` runs npm's `version`
   > lifecycle script, which this repo wires to
   > `node scripts/sync-versions.mjs && git add <the manifest paths>`. So a bump
   > propagates the new version into every harness manifest and stages those
   > manifests into the version commit on its own: no manual sync step, no
   > amend. (The `git add` is scoped to the exact files sync-versions writes, not
   > a blanket `git add -A`, so it cannot stage an accidental asset deletion.)
   > CI's tag-vs-`package.json` guard checks the root version against the tag;
   > sync-versions keeps the harness manifests honest with it.

   > **Bootstrap (first release only).** The trusted publisher cannot be attached
   > until the package exists on npm, so the FIRST publish is a one-time manual
   > publish by an org member: `npm publish --access public --provenance=false`
   > (interactive, 2FA; `--provenance=false` is required because a local publish
   > cannot generate the CI-only provenance attestation that `publishConfig` asks
   > for), then attach the trusted publisher per switch (d). Every release after
   > the first is the tokenless CI flow below, which DOES carry provenance.

2. **Push the tag.**
   ```sh
   git push --follow-tags
   ```
   The `vX.Y.Z` tag triggers `release.yaml`. Because this is a tag push (not a
   dry-run dispatch), the workflow upgrades npm (>= 11.5.1), runs the full gate,
   the tag-vs-version guard, the publishability preflight, then
   `npm publish --provenance --access public` — authenticating **tokenlessly via
   OIDC** against the trusted publisher (no `NPM_TOKEN`) — and finally creates the
   GitHub Release for the tag.

---

## Verify the published package

1. ```sh
   npm view @legioncodeinc/honeycomb
   ```
   Confirm the version, the `bin`, and that provenance is attached (npm shows a
   provenance badge / the package page links the build attestation).
2. Fresh-install dogfood:
   ```sh
   npm install -g @legioncodeinc/honeycomb
   honeycomb --help
   ```
   Then run the dashboard and confirm assets (CSS, fonts, logo) load — these are
   the runtime files `pack-check.mjs` asserts are present in the tarball.
3. Confirm the GitHub Release was created for the tag with generated notes.

---

## What the release workflow does (reference)

`.github/workflows/release.yaml` triggers on a `v*` tag push or a manual
`workflow_dispatch` (`dry_run` defaults true). It:

1. checks out, sets up Node 22 against `registry.npmjs.org`, **upgrades npm to
   >= 11.5.1** (required for Trusted Publishing OIDC), `npm ci`;
2. runs the **full gate** — `npm run ci` + `npm run build` +
   `npm run audit:openclaw` + `npm run pack:check` (same recipe as `ci.yaml`);
3. **tag-vs-`package.json` guard** — the pushed `vX.Y.Z` must equal
   `package.json` version (skipped on dispatch);
4. **publishability preflight (fail-closed)** — aborts if `private: true` or if
   `name` is the taken unscoped `honeycomb`;
5. **publishes** with `--provenance --access public`, **authenticating tokenlessly
   via OIDC** against the trusted publisher (no `NPM_TOKEN`) — but ONLY on a tag
   push that is not a dry run; otherwise it does `npm publish --dry-run` and stays
   green;
6. creates the **GitHub Release** for the tag (real publishes only).

`permissions` are least-privilege: `contents: write` only to create the GitHub
Release, `id-token: write` doing double duty — it is both the **publish auth** for
npm Trusted Publishing (replacing `NPM_TOKEN`) and the identity npm provenance
signs its OIDC supply-chain attestation against.
