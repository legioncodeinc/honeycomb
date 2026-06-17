# CI

Honeycomb's continuous integration lives in [`.github/workflows/ci.yaml`](../.github/workflows/ci.yaml).
It runs on every push to `main` and every pull request into `main`, and it runs
the **same recipe a developer runs locally** so a green local gate predicts a
green CI.

## Jobs

| Job | Runs on | Node | What it runs | Gated? |
|---|---|---|---|---|
| **Quality gate** | `ubuntu-latest` | `22.x`, `24.x` (matrix) | `npm ci` → `npm run ci` (typecheck + jscpd dup + vitest + audit:sql) → `npm run build` → `npm run audit:openclaw` → `npm run pack:check` | always |
| **Windows smoke** | `windows-latest` | `22.x` | `npm ci` → `npm run build` → `npm run test` | always |
| **Live DeepLake integration** | `ubuntu-latest` | `22.x` | `npm ci` → `npm run test:integration` | **only when `HONEYCOMB_DEEPLAKE_TOKEN` secret is set** |

- The **Node matrix** (`22.x` / `24.x`) is the engine-compatibility canary:
  `package.json` declares `engines.node >= 22`, so the gate proves a clean
  install and the full gate pass across the supported range, not just one pinned
  version. `npm ci` installs against the committed `package-lock.json`.
- The **Windows smoke** exists because the dev host is Windows and the build
  scripts (`esbuild.config.mjs` chmod, `scripts/pack-check.mjs`) have `win32`
  branches that a Linux runner never exercises.
- The **integration job** is opt-in and mutates a real DeepLake org — see below.

## The opt-in live-DeepLake integration suite

The default unit suite (`npm run test` / `npm run ci`) verifies the storage
client against an in-memory fake transport — there is **no live DeepLake** in the
default gate. The integration suite closes that gap by exercising the real
`HttpDeepLakeTransport` + `StorageClient` + catalog + write/vector primitives
against an actual backend.

It is **safe by construction**:

- **Auto-skips without a token.** Every `describe` block uses
  `describe.skipIf(!process.env.HONEYCOMB_DEEPLAKE_TOKEN)`. With no token,
  `npm run test:integration` exits `0` and reports the tests as *skipped*. It is
  **never** part of `npm run test` or `npm run ci` (it lives under
  `tests/integration/**/*.itest.ts`, runs only under
  [`vitest.integration.config.ts`](../vitest.integration.config.ts), and is
  explicitly excluded from the default config).
- **Isolated writes.** It targets a clearly-namespaced workspace (`honeycomb_ci`
  by default, or your `HONEYCOMB_DEEPLAKE_WORKSPACE`) and a per-run table prefix
  (`ci_smoke_<run-id>_…`, where the run id comes from `GITHUB_RUN_ID` /
  `HONEYCOMB_CI_RUN_ID`). It best-effort drops every table it creates in
  `afterAll`.
- **No secret ever hardcoded or logged.** The token is read only from the
  environment via the storage layer's own credential provider and is redacted at
  every boundary.

Run it locally (skips cleanly with no creds):

```bash
npm run test:integration
```

### Providing DeepLake credentials as GitHub secrets

The integration job reads four `HONEYCOMB_DEEPLAKE_*` repository secrets. Set
them with the GitHub CLI from the repo root:

```bash
gh secret set HONEYCOMB_DEEPLAKE_ENDPOINT   # e.g. https://api.activeloop.ai
gh secret set HONEYCOMB_DEEPLAKE_TOKEN      # the bearer token (the gate key)
gh secret set HONEYCOMB_DEEPLAKE_ORG        # your DeepLake org id
gh secret set HONEYCOMB_DEEPLAKE_WORKSPACE  # optional; defaults to honeycomb_ci
```

Each `gh secret set` prompts for the value (paste it, press Enter) so the secret
never lands in your shell history. Once `HONEYCOMB_DEEPLAKE_TOKEN` is set, the
`integration` job runs on the next push to `main`; until then (and on every fork)
the job is **skipped, not failed**.

### Environment variables the suite reads

| Variable | Required | Purpose |
|---|---|---|
| `HONEYCOMB_DEEPLAKE_ENDPOINT` | yes | DeepLake HTTP query endpoint |
| `HONEYCOMB_DEEPLAKE_TOKEN` | yes | Bearer token; its presence is the skip gate |
| `HONEYCOMB_DEEPLAKE_ORG` | yes | Org id sent as the tenancy header |
| `HONEYCOMB_DEEPLAKE_WORKSPACE` | no | Target workspace; defaults to `honeycomb_ci` |
| `HONEYCOMB_QUERY_TIMEOUT_MS` | no | Per-statement timeout (default 10000) |
| `HONEYCOMB_CI_RUN_ID` / `GITHUB_RUN_ID` | no | Per-run table-prefix seed (CI sets `GITHUB_RUN_ID`) |

## Local parity

Every CI step maps to an `npm run` script you can run locally:

```bash
npm run ci             # typecheck + dup + test + audit:sql
npm run build          # tsc + esbuild bundles
npm run audit:openclaw # ClawHub static scan of the OpenClaw bundle
npm run pack:check     # tarball forbidden-file scan (runs prepack/build first)
npm run test:integration  # opt-in live smoke (skips without a token)
```
