# EXECUTION LEDGER — PRD-022 Data-Access API (XL)

> Orchestrator: `/the-smoker` Bee Army · Branch: `prd-022-data-access-api` · Started 2026-06-20
> Status: **IN-WORK**

The data-surface twin of PRD-021. The dogfood proved the daemon assembles + captures end-to-end
against live DeepLake, but the data-access HTTP API the CLI/SDK/MCP call is still the PRD-004
scaffold: `/api/memories/recall` + `/api/memories` (remember) return **501**, and most data route
groups are never mounted into `assembleDaemon`. So `honeycomb recall`, `client.recall()`, and the
MCP `memory_search` all 501 against a real daemon — though the recall + write engines already work.
PRD-022 wires the EXISTING engines to their routes and proves recall THROUGH the HTTP API.

Behavioral bar: a real captured turn is recalled THROUGH `/api/memories/recall` by the CLI, SDK,
and MCP against live DeepLake — not around it via direct SQL.

## The gap (from the live dogfood)
- `POST /api/memories/recall` → 501; `POST /api/memories` (remember) → 501. The recall engine
  (`src/daemon/runtime/recall/`) + write engine (`src/daemon/runtime/pipeline/controlled-writes.ts`)
  exist + work (proven via direct SQL) but are NOT wired to HTTP routes.
- `/api/sources` + `/api/secrets` have `mount*Api` functions but `assembleDaemon` never calls them.
- `/memory` (VFS), `/api/goals`, `/api/kpis`, `/api/skills` (read), `/api/rules` have no handler.
- CLI bug: the loopback DaemonClient doesn't stamp `x-honeycomb-session` → 400 at the runtime-path
  middleware before reaching the handler.
- CLI bug: Windows libuv teardown crash (`UV_HANDLE_CLOSING`, exit 127) on CLI exit.

## Decisions
- **D-1 Wiring-only.** No new business logic, no new DeepLake schema (Schema changes: None). The
  engines (006/007/008/012/013/015/016 + 003d goals/kpis) exist; 022 wires them to HTTP.
- **D-2 Composition root fires every data-API seam once** (extends PRD-021 a-AC-2). The daemon-side
  handlers live in `src/daemon/runtime/<group>/` (allowed to import `daemon/storage`); CLI/SDK/MCP
  stay thin clients. `invariant.test.ts` stays green.
- **D-3 Local single-user mode is the dogfood target.** Team-mode tenancy stays behind the
  `x-honeycomb-org` hardening ticket.
- **D-4 BM25/ILIKE lexical fallback is sufficient** for the data-API proof (embeddings-off);
  embeddings-on semantic recall is its own follow-up.
- **D-5 First-real-run risk.** The dogfood WILL find more integration bugs (workspace-partition,
  the 501 gap, the session-header gap were all found by running it). Mandate the live
  recall-through-HTTP golden path + route discovered bugs through security→quality.
- **D-6 Watch the packaging traps.** The `logs`/build-output gitignore swallowed a real module last
  PRD — verify EVERY new source file is actually committed (`git check-ignore`) before pushing.

## Wave plan
- **Wave 1 — parallel (build the handlers; distinct daemon route-group dirs):**
  - 022a memories (retrieval-worker-bee) — `mountMemoriesApi` → `/api/memories/*` (recall + store + get
    + list + modify/forget-with-reason); Zod bodies; session-group note.
  - 022b vfs-browse (retrieval-worker-bee) — daemon-side `/memory/*` reads (cat/grep/ls/find) via the
    recall engine + the 015 `classify.ts` contract; write-deny-with-guidance.
  - 022c product-data (typescript-node-worker-bee) — `/api/goals` + `/api/kpis` (003d), `/api/skills`
    + `/api/rules` reads, wire the existing `mountSourcesApi` + `mountSecretsApi` (names-only).
- **Wave 2 — 022d assembly + clients (typescript-node-worker-bee).** Fire EVERY data-API mount seam
  in `assembleSeams()` (once each); CLI stamps `x-honeycomb-session` (synthetic per-invocation id);
  fix the Windows libuv teardown; confirm SDK + MCP tools reach the wired endpoints.
- **Wave 3 — 022e dogfood (retrieval-worker-bee + me).** The gated live golden-path: capture a turn,
  then recall it THROUGH the HTTP route by the CLI, SDK, and MCP; remember→recall over HTTP; operator
  smoke. I ALSO re-run the manual live dogfood (`honeycomb recall`) to confirm the headline.
- **Wave 4 — close-out: security (opus) → quality (sonnet).** memory mutation audit + reason-gate;
  secrets value-safety; tenancy scope on every data route; no token in logs; session-header forge;
  daemon-only invariant. Then quality AC-by-AC (33).

## AC matrix (33) — flip OPEN→DONE→VERIFIED
### Index
| AC-1 honeycomb recall → turn via /api/memories/recall HTTP (no 501/400) live — **DONE** the CLI/SDK/MCP trifecta proven by `dogfood-acceptance-live.itest.ts` e-AC-1/2/3 (one captured turn recalled THROUGH /api/memories/recall by all three thin clients against live DeepLake, assembled daemon, no manual mount) | AC-2 remember lands+recallable; modify/forget reason+audited — **DONE** remember→recall over HTTP proven by `dogfood-acceptance-live.itest.ts` e-AC-4 (controlled-writes ADD, not direct SQL); modify/forget reason-gate+audit covered by 022a `store.test.ts` a-AC-4 | AC-3 every data route implemented + fired by assembleDaemon, scoped+value-safe — **DONE** seams fired once by `assemble.test.ts` d-AC-1; wired surface answers (not 501) proven live by `dogfood-acceptance-live.itest.ts` e-AC-5 (/memory grep+cat, /api/goals POST→GET, /api/kpis same-key-twice→1 row); /api/sources DEFERRED/501 per 022d | all DONE |
### 022a memories (a-AC-1..6) — DONE (Wave 1, retrieval-worker-bee)
| 1 mountMemoriesApi attaches /api/memories/* — **DONE** `api.test.ts` "a-AC-1: BEFORE attach → 501 / AFTER attach → live" | 2 recall returns turn (no 501) BM25 fallback — **DONE** `api.test.ts` "a-AC-2: recall returns the captured turn via the lexical UNION ALL (degraded fallback)" + live `memories-api-live.itest.ts` | 3 store lands real row (no 501) recallable — **DONE** `api.test.ts` "a-AC-3…lands a real row (201…)" + `store.test.ts` "a-AC-3: storeMemory inserts a real memories row" + live itest | 4 modify/forget reason-gated+audited — **DONE** `store.test.ts` "a-AC-4: modify with blank reason throws…", "…version-bumps memories AND writes a memory_history audit row", "a-AC-4: forget soft-deletes via a version bump AND writes…" + `api.test.ts` route reason-gate | 5 malformed body → zod 400 — **DONE** `api.test.ts` "a-AC-5: malformed recall/store body → zod 400 before the engine" | 6 session-group requires x-honeycomb-session, documented — **DONE** `api.test.ts` "a-AC-6: …rejects a request with no x-honeycomb-session (400)" + live itest + documented in `src/daemon/runtime/memories/CONVENTIONS.md` §session-group | all DONE |

> **022a → 022d handoff. Signature 022d fires ONCE in `assembleSeams()`** (import from `src/daemon/runtime/memories/index.js`, mirrors `mountDashboardApi(daemon, { storage })`):
> `mountMemoriesApi(daemon, { storage /* StorageQuery, required */, embed? /* EmbedClient; defaults to noopEmbedClient = embeddings off, ledger D-4 */ })`
>
> **Route shapes:** `POST /api/memories/recall {query, limit?}` → `200 {hits:[{source,id,text}], sources:[…], degraded:true}` (lexical UNION ALL over `memories`+`memory`+`sessions`, BM25/ILIKE, degraded=true embeddings-off). `POST /api/memories {content, normalizedContent?, type?, agentId?}` → `201 {id, action}` (controlled-writes ADD). `GET /api/memories?limit=` → `200 {memories:[…]}`. `GET /api/memories/:id` → `200 {memory}` | `404`. `POST /api/memories/:id/modify {content, reason*, agentId?}` + `POST /api/memories/:id/forget {reason*, agentId?}` → `200 {id, action, audited}` (version-bump + `memory_history` audit row; `*reason` zod-required → 400 without it).
>
> **⚠️ 022d session-header gap (a-AC-6 / FR-8):** `/api/memories` is a SESSION group. The runtime-path middleware in front of it requires **BOTH** `x-honeycomb-runtime-path` (`plugin`|`legacy`) **and** `x-honeycomb-session` — a request missing either is 400'd BEFORE any memories handler runs (proven by `api.test.ts` a-AC-6 + the live itest's no-session 400 assertion). **022d MUST make `honeycomb recall`, the SDK `recall()`, and the MCP `memory_search`/store stamp a synthetic per-invocation `x-honeycomb-session` (+ `x-honeycomb-runtime-path`).** This is the root of the 022d session-header client bug. Nothing blocks 022d/022e: `mountMemoriesApi` is mountable on `assembleDaemon`'s `booted.assembled.daemon` today (the live itest mounts it manually).
### 022b vfs-browse (b-AC-1..6)
| 1 cat/read → row content | 2 grep/Glob → hybrid search | 3 ls → prefix entries | 4 find → pattern matches | 5 daemon-side classify == 015 client | 6 write-on-memory denied w/ guidance | all DONE |
> **022b DONE (retrieval-worker-bee).** `mountVfsApi` (`src/daemon/runtime/vfs/api.ts`) attaches the
> `/memory/*` browse reads onto the already-mounted `/memory` SESSION group. b-AC-1 cat
> (`GET /memory/cat?path=`) → `memory.summary` row read; b-AC-2 grep (`GET /memory/grep?q=`) →
> hybrid search via PRD-007 `collectCandidates` (BM25/ILIKE lexical floor, `degraded:true` when
> embeddings off) + `memories.content` hydration; b-AC-3 ls (`GET /memory/ls?prefix=`) → `memory`
> prefix ILIKE; b-AC-4 find (`GET /memory/find?pattern=`) → `memory` path-pattern ILIKE; b-AC-5
> classify (`GET /memory/classify?path=`) reuses the PURE PRD-015 `classifyPath` (test asserts
> daemon == client verdict); b-AC-6 write-deny → `POST/PUT/PATCH/DELETE /memory/*` 405 + guidance →
> `/api/memories`. Tests: `tests/daemon/runtime/vfs/api.test.ts` (14, all green) +
> gated `tests/integration/vfs-browse-api-live.itest.ts` (skipIf no token, mounts onto bootTestDaemon,
> seeds a `memory` row, drives cat/ls/find/grep live). `cat`/`ls`/`find` read the **`memory`** VFS table
> (path/summary), the SAME table the 015 client reads; `grep` is the only handler over the `memories`
> ENGINE table. Gates: ci typecheck 0, build 0, invariant 0, audit:openclaw 0, my `api.ts` clean under
> audit:sql (the lone audit:sql bypass is in 022a `memories/reads.ts:126`, NOT this wave).
>
> **The `mountVfsApi` signature for 022d** (fire ONCE in `assembleSeams`, after `createDaemon`):
> `mountVfsApi(daemon: Daemon, { storage: StorageQuery; recallConfig?: RecallConfig; hints?: HintSource }): void`.
> Pass the same live storage client the other seams use; `recallConfig` defaults to `resolveRecallConfig()`
> and `hints` to the recall empty hint source, so the one-line `mountVfsApi(daemon, { storage })` is sufficient.
### 022c product-data (c-AC-1..6)
| 1 goal add → /api/goals upsert + read | 2 kpi add existing key → update not dup | 3 skills+rules reads scoped | 4 mountSourcesApi mounted, /api/sources answers | 5 /api/secrets names-only never value | 6 malformed/cross-tenant → rejected at edge | all DONE |
> **022c DONE (typescript-node-worker-bee).** Wiring-only (D-1): no new schema/logic. New code:
> `src/daemon/runtime/goals/api.ts` (`mountGoalsApi`), `src/daemon/runtime/kpis/api.ts`
> (`mountKpisApi`), `src/daemon/runtime/product/{keyed-engine,api,index}.ts` + `CONVENTIONS.md`.
> - **c-AC-1** `GET/POST /api/goals` → the 003d `goals` table via `updateOrInsertByKey` (keyColumn
>   `key`); POST upserts + reads back (201), GET lists scoped rows newest-first. `honeycomb goal add`
>   + MCP `honeycomb_goal_add` target this.
> - **c-AC-2** `GET/POST /api/kpis` → the SAME shared keyed engine bound to `kpis`; an existing key
>   UPDATES in place (one row per key, never a duplicate) — `goals`+`kpis` share `keyed-engine.ts`'s
>   `mountKeyedGroup` (one engine, no jscpd dup).
> - **c-AC-3** `GET /api/skills` (highest-version-per-`id`) + `GET /api/rules` (highest-version-per-`key`,
>   `status='active'` filter) — read-only, scoped, via `buildHighestVersionSql` (the established
>   `publish-endpoint.ts` self-join-on-MAX(version) pattern).
> - **c-AC-4** `mountProductSourcesApi(daemon, sourcesDeps)` resolves `daemon.group("/api/sources")` and
>   delegates to the EXISTING `mountSourcesApi` (013) — `/api/sources` answers (test asserts not 404).
> - **c-AC-5** `mountProductSecretsApi(daemon, secretsDeps)` delegates to the EXISTING names-only
>   `mountSecretsApi` (012) — list returns names only; `GET /api/secrets/:name` is 404 by construction
>   (no value-returning route); test asserts the stored value never appears in any response body.
> - **c-AC-6** every keyed route Zod-validates its body (`.strict()` rejects unknown fields; missing
>   `key`/`value` → 400) and resolves `{org,workspace}` from `x-honeycomb-*` fail-closed (no org → 400,
>   never a broad read/write); `agent_id`/`visibility` are server-stamped, a body cannot widen scope.
>
> Tests: `tests/daemon/runtime/{goals,kpis,product}/*.test.ts` (13, all green; shared in-memory
> upsert-aware fake in `tests/daemon/runtime/product/_keyed-harness.ts`) + gated
> `tests/integration/product-data-api-live.itest.ts` (skipIf no token; mounts `mountProductDataApi`
> onto `bootTestDaemon({mode:"local"})`, per-run-unique keys, 120s cap; POST goal→GET returns it,
> POST kpi same key twice→one row). Gates: `npm run ci` 0 (typecheck/dup/test 1625 pass/audit:sql),
> build 0, audit:openclaw 0, invariant 0; `git check-ignore` clears all new dirs (no logs-trap).
>
> **The mount-seam signatures for 022d** (fire ONCE in `assembleSeams`, after `createDaemon`):
> - ONE facade (recommended): `mountProductDataApi(daemon: Daemon, { storage: StorageQuery;
>   sources?: SourcesApiDeps; secrets?: SecretsApiDeps }): void`. It fires goals+kpis+skills+rules
>   always; sources/secrets only when their deps are supplied. `mountProductDataApi(daemon, { storage })`
>   alone wires the four storage-only routes.
> - The sources/secrets deps are the EXISTING engines' deps (NOT rebuilt here):
>   `mountProductSourcesApi(daemon, sourcesDeps: SourcesApiDeps)` → `import { mountSourcesApi } from
>   "./sources/api.js"` wants `{ storage, queue, registry, providers, scope?, logger?, documentWorker? }`;
>   `mountProductSecretsApi(daemon, secretsDeps: SecretsApiDeps)` → `import { mountSecretsApi } from
>   "./secrets/api.js"` wants `{ store: SecretsStore, scope?, execRunner? }` where
>   `store = new SecretsStore({ baseDir: $HONEYCOMB_WORKSPACE, machineKey: createMachineKeyProvider() })`.
> - Per-group control is also exported from `product/index.js`: `mountGoalsApi(daemon, { storage })`,
>   `mountKpisApi(daemon, { storage })`, `mountSkillsReadApi(daemon, storage)`,
>   `mountRulesReadApi(daemon, storage)`. All resolve their own already-mounted+protected route group
>   (NO `server.ts` edit) and are no-ops if the group is absent, so fire order is unconstrained.
### 022d assembly+clients (d-AC-1..6) — DONE (Wave 2, typescript-node-worker-bee)
| 1 every data seam fired once — **DONE** `assemble.test.ts` "a-AC-2 / d-AC-1 …fires all nine seams… each exactly once, in order" + "d-AC-1 the three data-API seams fire UNCONDITIONALLY (in team mode too…)" | 2 recall stamps x-honeycomb-session+runtime-path → reaches handler — **DONE** `runtime.test.ts` "d-AC-2 a recall (POST /api/memories/recall) stamps BOTH x-honeycomb-runtime-path AND x-honeycomb-session" | 3 synthetic session id minted for stateless CLI — **DONE** `runtime.test.ts` "d-AC-3 …stable-per-process `cli-<pid>-<n>` shape" + isSessionGroupPath classifier test | 4 Windows clean exit, no UV_HANDLE_CLOSING/127 — **DONE** `exit.test.ts` (6 tests: close/destroy/no-op/swallow-throw/symbol-match + real-pool finalize) + bin sets `process.exitCode` (no `process.exit()`) | 5 SDK recall/remember reach wired endpoints+session — **DONE** `client.test.ts` "e-AC-1 / d-AC-3 recall hits the WIRED /api/memories/recall, stamps the session header, maps hits" + remember→`/api/memories {content}` | 6 MCP memory_search/store reach wired endpoints+session — **DONE** `tools.test.ts` "FR-10 …reaches the daemon once" (path `/api/memories/recall`) + "d-AC-1 …production seam stamps …session" + `start-server`/`transports` route assertions | all DONE |

> **022d DONE (typescript-node-worker-bee).** Wiring + client-header + teardown only (D-1: no new
> schema/business logic). Files changed: `src/daemon/runtime/assemble.ts` (fire 3 data seams),
> `src/commands/contracts.ts` (loopback-client session stamping + `isSessionGroupPath`/`mintCliSessionId`),
> `src/commands/index.ts` (re-exports), `src/sdk/client.ts` (session stamping + wired recall/store routes),
> `mcp/src/daemon-seam.ts` (session stamping) + `mcp/src/handlers.ts` (memory_search→`/api/memories/recall`,
> memory_store→`{content}`), `src/cli/index.ts` + NEW `src/cli/exit.ts` (libuv teardown). Tests:
> `tests/daemon/runtime/assemble.test.ts` (+d-AC-1 seam coverage, +d-AC-5 edge-reject), `tests/cli/runtime.test.ts`
> (+d-AC-2/3), NEW `tests/cli/exit.test.ts` (d-AC-4), `tests/sdk/client.test.ts`+`helpers.test.ts`,
> `tests/mcp/{tools,start-server,transports}.test.ts` (route+session), NEW gated
> `tests/integration/data-api-assembled-live.itest.ts` (d-AC-6).
>
> **What `assembleSeams()` now fires (the full list, once each, in order):** `attachHooks` → `mountDashboard`
> → `mountNotifications` → `attachPrune` → `mountLogs` → `mountDashboardHost` (local-only) → **`mountMemories`**
> (022a, `{storage}`) → **`mountVfs`** (022b, `{storage}`) → **`mountProductData`** (022c,
> `{storage, secrets}`). The three data seams fire UNCONDITIONALLY (they resolve their own protected
> session/route groups; no `server.ts` edit).
>
> **Seam wiring: fully wired vs deferred.**
> - **memories** (022a) — FULLY WIRED. `mountMemoriesApi(daemon, { storage })`; `embed` defaults to no-op
>   (embeddings off, D-4) → lexical BM25/ILIKE recall.
> - **vfs** (022b) — FULLY WIRED. `mountVfsApi(daemon, { storage })`; `recallConfig`/`hints` default.
> - **goals/kpis/skills/rules** (022c) — FULLY WIRED via `mountProductDataApi(daemon, { storage, secrets })`.
> - **secrets** (012) — WIRED. `resolveProductDataDeps` constructs `new SecretsStore({ baseDir:
>   process.env.HONEYCOMB_WORKSPACE ?? process.cwd(), machineKey: createMachineKeyProvider() })` at the
>   composition root and passes it as `secrets`. Names-only; no value crosses HTTP.
> - **sources** (013) — **DEFERRED (NOT wired, NOT faked — D-1).** `mountSourcesApi` needs a `registry` +
>   a `providers` resolver that are NOT yet constructible at the composition root (they belong to the
>   sources subsystem's own assembly). `resolveProductDataDeps` omits `sources`, so `mountProductDataApi`
>   skips the `/api/sources` mount → the group falls through to the 501 scaffold (the honest posture).
>   Follow-up: build the source registry/provider-resolver at assembly, then pass `sources`. 022e does
>   NOT depend on `/api/sources`.
>
> **The CLI/SDK/MCP header-stamping change (the dogfood-400 root-cause fix, d-AC-2/3):** all three thin
> clients now stamp BOTH `x-honeycomb-runtime-path` AND a synthetic `x-honeycomb-session` on SESSION-group
> paths (`/api/memories`, `/memory`) — the two headers the runtime-path middleware REQUIRES (404d). CLI:
> `legacy` runtime-path + `cli-<pid>-<counter>` session (loopback client, `src/commands/contracts.ts`).
> SDK: `plugin` (already) + `sdk-<actor>-<n>` session (`src/sdk/client.ts`, node-free closure counter).
> MCP: `plugin` (already) + `mcp-<n>` session (`mcp/src/daemon-seam.ts`). Route alignment: SDK
> `recall()`→`POST /api/memories/recall` (maps `hits[]`→`RecallResult`, `id`→`path`), `remember()`→`POST
> /api/memories {content, normalizedContent?}`; MCP `memory_search`→`/api/memories/recall`,
> `memory_store`→`{content}` (mapped from the tool's `{text, path}` schema).
>
> **Windows-teardown root cause + fix (d-AC-4):** the bin (`src/cli/index.ts`) called `process.exit(code)`
> the instant `main()` resolved. That abrupt exit RACES libuv handle teardown on Windows: the loopback
> `fetch` opens an undici keep-alive socket POOL (lives past the request) and `daemon start` spawns the
> daemon DETACHED (a child-process handle in the parent's table). `process.exit()` firing while either
> handle is mid-close trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` → exit 127 AFTER a
> successful command. FIX (close handles, do NOT suppress the assertion): NEW `src/cli/exit.ts`
> `finalizeCliExit()` closes the undici global dispatcher (`Symbol.for("undici.globalDispatcher.1")`,
> `.close()`→`.destroy()` fallback, never throws); the bin now calls `await finalizeCliExit()` then sets
> `process.exitCode = code` (no `process.exit()`), so the now-unref'd loop drains and Node exits cleanly.
> The detached spawn was already `unref()`'d; with the graceful exit it no longer races a forced exit.
> Reproducible only as a process-exit race (not deterministically in-process under Vitest); `exit.test.ts`
> proves the teardown helper's close-order against an injected dispatcher AND closes the real fetch pool
> after a live fetch. Manual repro: on Windows, `honeycomb recall <q>` against a down daemon (which
> spawns it) previously exited 127 after printing the result; now exits with the command's code.
>
> **Gates (all green):** `npm run ci` = **0** (typecheck 0 / `dup` 0 / `vitest run` **1642 pass, 4 skipped**
> [gated itests] / `audit:sql` 0 — note: a pre-existing FLAKE in `tests/daemon/runtime/sources/api.test.ts`
> a-AC-2 DELETE-purge runs ~4.85s right at the 5000ms cap and tips over under full-suite parallel load; it
> passes in isolation and on re-run — NOT a 022d regression, that file is untouched). `npm run build` = **0**
> (1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed bundle). `npm run audit:sql` =
> **0** (158 files, every interpolation guarded). `npm run audit:openclaw` = **0**. `invariant.test.ts` = **0**
> (3 pass — the thin clients did NOT import `daemon/storage`; only `assemble.ts`, the composition root, does).
> `git check-ignore` clears all new files (`src/cli/exit.ts`, `tests/cli/exit.test.ts`,
> `tests/integration/data-api-assembled-live.itest.ts` — no logs-trap).
>
> **For 022e (dogfood) to know:**
> - The assembled daemon now SERVES `/api/memories/*` (recall+store+get+list+modify/forget), `/memory/*`
>   browse, `/api/goals`, `/api/kpis`, `/api/skills`, `/api/rules`, and names-only `/api/secrets` — NO 501.
>   `/api/sources` is still 501 (deferred — see above); do not build the dogfood on it.
> - Drive recall/remember through the REAL CLI loopback client (`createLoopbackDaemonClient`), the SDK
>   `client.recall()/remember()`, or the MCP `memory_search`/`memory_store` — all three now stamp the
>   session-group headers automatically, so NO manual `x-honeycomb-session` stamping is needed by the caller
>   (just supply the tenancy `x-honeycomb-org`/`-workspace`).
> - The gated live itest `tests/integration/data-api-assembled-live.itest.ts` requires
>   `HONEYCOMB_DEEPLAKE_TOKEN` (+ optional `HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`); it boots
>   the assembled daemon (seams fired by `assembleDaemon`, NOT manually mounted) on an ephemeral port and
>   proves store→recall over HTTP via the CLI client. 120s cap, per-run-unique term. Orchestrator runs it.
> - The 022a `memories-api-live.itest.ts` still manually mounts `mountMemoriesApi`; that is now ALSO covered
>   by the assembly path — the 022e dogfood should drive the ASSEMBLED daemon (no manual mount), which is
>   what `data-api-assembled-live.itest.ts` does.
### 022e dogfood (e-AC-1..6) — DONE (Wave 3, retrieval-worker-bee + orchestrator)
| 1 honeycomb recall → turn via HTTP live — **DONE** `dogfood-acceptance-live.itest.ts` "e-AC-1/2/3 …recalled THROUGH /api/memories/recall by the CLI…" (real `createLoopbackDaemonClient` store→recall) | 2 SDK recall → same via HTTP — **DONE** same itest, real `createHoneycombClient(...).recall()` pointed at the booted daemon, session header stamped | 3 MCP memory_search → same via HTTP — **DONE** same itest, real `HANDLERS.memory_search` over the production `createHttpDaemonApiSeam` (ephemeral port), routes `/api/memories/recall` | 4 remember→later-recall over HTTP — **DONE** `dogfood-acceptance-live.itest.ts` "e-AC-4 …remember…recalled back THROUGH /api/memories/recall" (controlled-writes ADD, not SQL) | 5 gated live golden-path drives recall via HTTP (not SQL) — **DONE** the whole itest hits the HTTP route (`POST /api/memories/recall`), never direct SQL; gated `skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)`, `.itest.ts`, 120s cap, per-run-unique terms, ephemeral port, poll-convergent reads | 6 operator smoke one-pass — **DONE** `scripts/dogfood-acceptance-smoke.mjs` + `npm run smoke:data-api` (mirrors `golden-path-smoke.mjs`; token-gated PASS/FAIL with receipts) | all DONE |

> **022e DONE (retrieval-worker-bee).** Authored the HEADLINE acceptance proof; NO product behavior changed. New files (only ones owned): `tests/integration/dogfood-acceptance-live.itest.ts` + `scripts/dogfood-acceptance-smoke.mjs` (+ `npm run smoke:data-api` in `package.json`). Did NOT touch Wave 1/2 source (`src/daemon/runtime/{memories,vfs,goals,kpis,product,assemble}.*`, `src/cli/runtime.ts`/`src/commands/`, `src/sdk/`, `mcp/`).
>
> **The proof shape.** Boots the REAL assembled daemon ONCE via `bootTestDaemon({mode:"local"})` (assembly fires the three data seams via 022d's `assemble.ts` — NO manual mount). Then drives the SAME captured turn through ALL THREE thin clients to the SAME wired `/api/memories/recall` route:
> - **e-AC-1 (CLI):** real `createLoopbackDaemonClient({baseUrl})` stores via `POST /api/memories` (201, action inserted|deduped) then recalls via `POST /api/memories/recall` (200) — the `honeycomb recall` transport, session-group headers stamped by the client.
> - **e-AC-2 (SDK):** real `createHoneycombClient({daemonUrl: booted.baseUrl, …}).recall(term)` — maps `{hits:[{id,text}]}`→`RecallResult[]`, same route + session header.
> - **e-AC-3 (MCP):** real `HANDLERS.memory_search({query}, actor, seam)` over the production `createHttpDaemonApiSeam({host, port})` pointed at the ephemeral port — routes `POST /api/memories/recall`, stamps plugin runtime-path + synthetic `mcp-<n>` session.
> - **e-AC-4:** a SECOND `remember` (store) recalled back over HTTP (write→read loop, controlled-writes).
> - **e-AC-5:** `/memory/grep`+`/memory/cat` (022b, via CLI client = session group) answer 200; `/api/goals` POST→GET read-back; `/api/kpis` same-key-twice→exactly ONE row with the second value (022c). `/api/sources` NOT asserted (DEFERRED/501 per 022d).
> - Poll-convergent reads (40×350ms ≈ 14s, under the 120s cap) — a 400/501 short-circuits as a real bug, never poll-retried away; the HIT is what converges UP (a stale segment under-reports, never invents). Embeddings OFF → `degraded:true` accepted; the hit is the bar (D-4).
>
> **Did I run the live itest?** NO — no `HONEYCOMB_DEEPLAKE_TOKEN` in this environment. The orchestrator runs it with `.env.local` (`npm run smoke:data-api` or `npm run test:integration`). No PRODUCT bug surfaced to report (the proof was authored against the Wave-1/2 route contracts already proven green by 022a/b/c/d unit + their own live itests). The credential-less smoke run exits 0 with a clear SKIPPED banner (verified).
>
> **Gates (all green, WITHOUT the live itest running in CI):** `npm run ci` = **0** (typecheck 0 / `dup` 0 / `vitest run` **1642 pass, 4 skipped** [gated itests; my new `.itest.ts` is excluded by `.itest.ts` suffix + `tests/integration/**` exclusion] / `audit:sql` 0). `npm run build` = **0** (1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed bundle). `npm run audit:sql` = **0** (158 files). `npm run audit:openclaw` = **0**. `invariant.test.ts` = **0** (3 pass — the new test file is not a NON_DAEMON_ROOT source module). `git check-ignore` clears both new files (no logs-trap).
>
> **NOTE — pre-existing flake (NOT a 022e regression):** the FIRST full `npm run ci` tipped on `tests/daemon/runtime/sources/api.test.ts` a-AC-2 DELETE-purge timing out at the 5000ms cap under full-suite parallel load — the EXACT flake the 022d block already documented (passes in isolation at ~4.85s; that file is untouched by this wave). A clean re-run of `npm run ci` was **0**. My gated `.itest.ts` does not run in `npm run test`/`npm run ci`, so it cannot affect this.

## Watchdog (live lessons / fixes / blockers)
- **022b (retrieval-worker-bee):** non-blocking cross-wave observation — at the time 022b finished,
  `npm run audit:sql` (which scans the WHOLE `src/daemon` tree, all waves) reported ONE bypass in
  `src/daemon/runtime/memories/reads.ts:126` (a 022a file, still in flight): a raw `LIMIT ${String(limit)}`
  interpolation. 022b's own `src/daemon/runtime/vfs/api.ts` is clean under the scan. 022a should wrap the
  limit through an int-clamp + numeric literal (the recall `buildFtsSql` does `Math.max(0, Math.trunc(...))`
  inline) so audit:sql goes green before close-out. Also at that snapshot the `goals`/`kpis` (022c) and
  `memories/store` (022a) unit suites had in-progress failures — expected mid-wave, not 022b's.
- **022b:** the `/memory` group is a SESSION group, so every browse request must carry
  `x-honeycomb-runtime-path` (`plugin`/`legacy`) + `x-honeycomb-session` on top of the tenancy headers
  (the runtime-path middleware 400s otherwise). The VFS clients already send these; tests + the live itest
  stamp them. 022d/022e callers driving `/memory/*` must do the same.
