# AGENTS.md

Workspace instructions for AI agents working in **Honeycomb** (`@legioncodeinc/honeycomb`).
Read this before editing. Keep it short and factual.

## What this repo is

Honeycomb is a **cross-harness AI coding memory system**: a long-lived local **daemon** (the *only* storage client) plus thin clients (per-harness hooks, the unified CLI, an MCP server, and a TypeScript SDK) that all reach the daemon over loopback HTTP (`127.0.0.1:3850`). Memory is persisted in **Activeloop Deep Lake** as three tiers (key → summary → raw) with hybrid BM25 + 768-dim vector recall. Built on Hivemind. Licensed AGPL-3.0-or-later (every new source file gets the header in `docs/license-header.txt`).

Node **>= 22.5.0**, ESM (`"type": "module"`), TypeScript strict, single npm package (no workspaces). `@honeycomb/*` are **tsconfig path aliases**, not packages.

## Major directories

| Path | Role |
|---|---|
| `src/shared/` | Tier 1 — single source of truth for constants (`constants.ts`), types, lifecycle flags. Nothing re-declares these. |
| `src/daemon-client/` | Tier 1 — thin fetch-only client surface that harnesses/CLI/MCP import. |
| `src/daemon/` | Tier 2 — **the daemon core. The ONLY place DeepLake is touched.** `storage/` (SQL, catalog, healing, vector), `runtime/` (Hono server, services, middleware, pipelines). |
| `src/cli/` | Tier 4 — the `honeycomb` CLI entry. |
| `harnesses/{claude-code,codex,cursor,hermes,pi,openclaw}/` | Tier 4 — per-harness thin adapters. Each has `src/` → bundled to `bundle/` (cursor also has `extension/`). |
| `mcp/src/` | Tier 4 — MCP server entry. |
| `embeddings/src/` | Tier 3 — the embed daemon (opt-in, ~600 MB runtime, optionalDependency). |
| `sdk/` | Published `@legioncodeinc/honeycomb` subpath entries (`/react`, `/vercel`, `/openai`); core entry is fetch-only/browser-safe. |
| `tests/` | Vitest. Mirrors `src/`. `.itest.ts` under `tests/integration/` = live (needs creds), run only via `test:integration`. |
| `library/` | Docs library (PRDs, IRDs, knowledge). `notes/` is human-only. |
| `daemon/`, `bundle/`, `mcp/bundle/`, `harnesses/*/bundle/`, `embeddings/embed-daemon.js` | Built outputs — do not hand-edit. |
| `scripts/` | Build, smoke, audit, and sync scripts. |
| `agent.yaml` | Inference model router config (committed; secrets are `${REF}` only, never inline). |

## Build / quality gate

```bash
npm install              # postinstall rebuilds tree-sitter + ensures embed deps
npm run build            # tsc (whole graph) && node esbuild.config.mjs (per-target bundles)
npm run typecheck        # tsc --noEmit
npm run ci               # THE GATE: typecheck + jscpd dup + vitest + SQL-safety audit
npm run lint             # biome check .
npm run format           # biome format --write .  (do not hand-fight formatting)
npm test                 # vitest run
npm run test:watch       # vitest
npm run test:integration # live .itest.ts — needs Deep Lake creds, NOT part of ci
npm run dup              # jscpd (threshold 7) over src/harnesses/mcp/embeddings
npm run audit:sql        # grep gate: no raw interpolation into SQL strings
npm run pack:check       # verify the published tarball shape
```

**`npm run ci` is the hard line.** Every PR passes it or does not merge.

esbuild injects `__HONEYCOMB_VERSION__` (and PRD-050 substrate defines) via `define`; versions are single-sourced from root `package.json` by `scripts/sync-versions.mjs` into `.claude-plugin`, harness plugin manifests, and `daemon/package.json`. Don't edit those version fields by hand.

## Architecture boundaries (load-bearing)

- **Fixed build direction** (see `BUILD.md` and the `//build-order` note in `package.json`). One `tsc` pass covers the whole graph; **dependents never import upward**. Tier 1 (shared, daemon-client) ← Tier 2 (daemon) ← Tier 3 (embeddings) ← Tier 4 (harnesses, mcp, cli) ← Tier 5 (esbuild bundles). If you find yourself importing a higher tier from a lower one, stop.
- **DeepLake confinement:** only `src/daemon` imports the storage/DeepLake access path. Everything else imports the thin `src/daemon-client`. No harness/CLI/MCP bundle may transitively pull in DeepLake.
- **The daemon is the sole storage client.** Services receive a `StorageQuery` and the catalog helpers as deps — they do not open storage themselves and never import `storage/transport.ts` directly.
- **Shared-file contention seams:** do **not** edit `src/daemon/runtime/server.ts`, `index.ts`, `config.ts`, `logger.ts`, `middleware/permission.ts`, or `services/types.ts` to add a service — services are dependency-injected via `createDaemon({ services })`. See `src/daemon/runtime/CONVENTIONS.md` before touching the runtime.
- **Shared constants** (`DAEMON_PORT=3850`, `DAEMON_HOST`, `HONEYCOMB_VERSION`, `PRODUCT_SLUG`) live only in `src/shared/constants.ts`. Re-declaring any is a drift bug flagged by `npm run dup`.

## SQL safety (critical)

The DeepLake query endpoint **binds no parameters** — values are escaped by hand. Always go through the helpers in `src/daemon/storage/sql.ts`:

- Identifiers → `sqlIdent`
- String values → `sqlStr` (or `eLiteral`/`E'...'` for bodies with escape sequences)
- LIKE patterns → `sqlLike`

**Never hand-quote a value or interpolate a raw value into a SQL string.** `npm run audit:sql` (part of `ci`) scans all of `src/daemon` — including `runtime/services/job-queue.ts` — and fails the build on any bypass. Run every statement through `storage.query(sql, scope, opts)`; branch on the `QueryResult` kind via `isOk(...)`, do not bare try/catch.

## Coding conventions

- **Biome** owns formatting: tabs, lineWidth 120. Run `npm run format`; don't argue with it. `noExplicitAny`, `noNonNullAssertion`, `noForEach` are warnings.
- **No duplication:** `npm run dup` (jscpd, threshold 7) fails on copy-paste. Extract to `src/shared` instead.
- **Imports use the path aliases** (`@honeycomb/shared`, `@honeycomb/daemon-client`, `@honeycomb/daemon`) per `tsconfig.json` `paths`. ESM means `.js` extensions on relative imports are resolved by the bundler.
- **Tests:** name each test after the AC it proves (e.g. `b-AC-1 …`). No `.skip`/`.only`. Live tests use the `.itest.ts` suffix under `tests/integration/`. In-process testing via `createDaemon({...}).app.request(...)` and the fake transport in `tests/helpers/fake-deeplake.ts` — no real network.
- **New tables/columns:** define a `CatalogTable` (ColumnDef array) once, add to a catalog group, and create/heal through `buildCreateTableSql` / `withHeal`. Never hand-roll an `ALTER`. Schema healing is additive.
- **Durable state goes in Deep Lake, not JSON/JSONL sidecars** (FR-8).

## Sensitive areas — read before editing

- `src/daemon/runtime/CONVENTIONS.md` — the DI/service seam and what you must NOT touch.
- `BUILD.md` — build order, per-target entry roots, dist layout.
- `src/daemon/storage/sql.ts` + `scripts/audit-sql-safety.mjs` — the SQL safety floor.
- `CONTRIBUTING.md` — the gate, CLA requirement, code style.
- `RELEASING.md` — the go-live / npm Trusted Publishing (OIDC) procedure; **there is no `NPM_TOKEN`**, first publish is a manual 2FA bootstrap.
- `SECURITY.md` — security bugs go private, not public issues.
- `agent.yaml` + `.secrets/` — secrets are `${SECRET_REF}` only; inline raw keys are rejected at parse.

## Notes

- The daemon **binds loopback only**. Cross-device/team sharing happens via Deep Lake org/workspace scope, not a remote bind.
- **Embeddings are opt-in** (optionalDependency, model fetched on first warmup). With embeddings off, recall silently falls back to BM25/ILIKE lexical — never an error, no quality cliff.
- The local SQLite-backed queue (`--experimental-sqlite`) has a packaged-upgrade smoke (`smoke:local-queue-*`); recent daemon boot hotfixes target macOS launchd readiness — keep boot paths fail-safe.
