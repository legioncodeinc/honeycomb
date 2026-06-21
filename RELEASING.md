# Releasing honeycomb

This is the go-public checklist for publishing `honeycomb` to the public npm
registry. The publish pipeline (`.github/workflows/release.yaml`) is already
wired and rehearsable, but the package ships **deliberately un-publishable** so
nothing goes out by accident. Going public is a sequence of conscious switches —
this document is the order to flip them in.

> **TL;DR for the impatient maintainer.** You must (1) pick + provision a
> **scoped** npm name (the unscoped `honeycomb` is already taken — see below),
> (2) add `publishConfig` for public access + provenance, (3) remove
> `private: true`, and (4) set the `NPM_TOKEN` repo secret. Until all four are
> done, `release.yaml` runs the full gate + a `--dry-run` and stays green
> without ever publishing.

---

## The hard constraint: the name `honeycomb` is taken

The bare name **`honeycomb` is already owned by a third party** on the public
npm registry (currently `honeycomb@0.1.4`). You **cannot** publish under the
unscoped name — a publish would 403 or, worse, be wrong. A public release MUST
use a **scoped** name under an npm org/scope you control:

- `@legioncodeinc/honeycomb` (matches the GitHub org `legioncodeinc`), or
- `@legioncode/honeycomb`, or any scope whose npm org exists and lists the
  publishing identity (you, or the CI automation token) as a member.

The release workflow has a **fail-closed preflight** that aborts the publish if
`package.json` `name` is still the unscoped `honeycomb` OR if `private: true` is
still set — so a stray tag push cannot publish a broken/duplicate package before
these switches are flipped.

---

## The go-public switches (do these in order)

### (a) Choose + provision the scoped name

1. Decide the scope (e.g. `@legioncodeinc`). The corresponding **npm org/scope
   must already exist** on npmjs.com, and the publishing identity (your npm
   account, or the automation token in step (d)) **must be a member** with
   publish rights. Create the org at npmjs.com if it does not exist.
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

### (d) Set the `NPM_TOKEN` repo secret

1. On npmjs.com, create an **automation** access token (type: Automation, so it
   bypasses 2FA in CI) scoped to publish for the package/scope.
2. In GitHub → repo **Settings → Secrets and variables → Actions → New
   repository secret**, add it as `NPM_TOKEN`.

Until this secret exists, `release.yaml` does the gate + `npm publish --dry-run`
and stays green (it will not hard-fail on a missing token) — same skip-don't-fail
pattern as `ci.yaml`'s gated integration job.

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

   > **Make sure the manifests are synced into the commit.** `npm version` runs
   > npm's `version` lifecycle but **not** `prebuild`. If you have not wired a
   > `"version": "node scripts/sync-versions.mjs && git add -A"` npm script,
   > run `node scripts/sync-versions.mjs` **before** `npm version`, or run it
   > after and amend, so the propagated manifest versions land in the tagged
   > commit. CI's tag-vs-`package.json` guard checks the root version against
   > the tag; sync-versions keeps the harness manifests honest with it.

2. **Push the tag.**
   ```sh
   git push --follow-tags
   ```
   The `vX.Y.Z` tag triggers `release.yaml`. With `NPM_TOKEN` set and this being
   a tag push (not a dry-run dispatch), the workflow runs the full gate, the
   tag-vs-version guard, the publishability preflight, then
   `npm publish --provenance --access public`, and finally creates the GitHub
   Release for the tag.

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

1. checks out, sets up Node 22 against `registry.npmjs.org`, `npm ci`;
2. runs the **full gate** — `npm run ci` + `npm run build` +
   `npm run audit:openclaw` + `npm run pack:check` (same recipe as `ci.yaml`);
3. **tag-vs-`package.json` guard** — the pushed `vX.Y.Z` must equal
   `package.json` version (skipped on dispatch);
4. **publishability preflight (fail-closed)** — aborts if `private: true` or if
   `name` is the taken unscoped `honeycomb`;
5. **publishes** with `--provenance --access public` — but ONLY when `NPM_TOKEN`
   is set AND it is not a dry run; otherwise it does `npm publish --dry-run` and
   stays green;
6. creates the **GitHub Release** for the tag (real publishes only).

`permissions` are least-privilege: `contents: write` only to create the GitHub
Release, `id-token: write` only so npm provenance can sign an OIDC supply-chain
attestation.
