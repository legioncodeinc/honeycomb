# EXECUTION LEDGER — PRD-019 Harness Integrations (XL)

> Orchestrator: `/the-smoker` Bee Army · Branch: `prd-019-harness-integrations` · Started 2026-06-18
> Status: **IN-WORK**

The largest PRD: 5 sub-surfaces, 36 ACs (3 index + 6a + 6b + 6c + 6d + 6e). All are THIN CLIENTS
of the daemon — the daemon (already built across 001–018) owns DeepLake, capture writes, recall,
summaries, runtime-path enforcement. 019 builds the surfaces that REACH it.

## Existing footprint (DO NOT rebuild — these already exist from 001–018)
- `src/daemon/runtime/capture/` — `capture-handler.ts` (338 LOC daemon-side capture pipeline),
  `event-contract.ts`, `turn-counters.ts`.
- `src/daemon/runtime/middleware/runtime-path.ts` — runtime-path claim + **409 on conflict** (PRD-004d).
- `src/daemon/runtime/server.ts` — already mounts `/api/hooks` (session, protected) + `/mcp` (session,
  protected) route groups behind runtime-path→permission middleware. Handlers attach via `daemon.group(path)`.
- `src/shared/capture-gate.ts` — the `HONEYCOMB_CAPTURE !== "false"` gate.
- `harnesses/{claude-code,codex,cursor,hermes,pi}/src/index.ts` + `harnesses/openclaw/src/index.ts` — entry STUBS.
- `mcp/src/index.ts` — MCP server entry STUB; esbuild already bundles `mcp/bundle/server.js`.
- esbuild builds each `harnesses/<h>/src/index.ts` → `harnesses/<h>/bundle/` (the connector install source).

## What 019 BUILDS (the 5 client surfaces)
- **019a connector-base** — `src/connectors/` abstract base (`install()`/`uninstall()`, `writeJsonIfChanged`,
  `isHoneycombEntry`, `detectPlatforms`, foreign-config-preserve, skill symlink-link, idempotent
  hook-trust-fingerprint) + ≥1 concrete connector (Claude Code reference) + `honeycomb setup/connect/uninstall`
  CLI verbs. Install-time only — NEVER opens DeepLake, holds no daemon handle.
- **019b hook-lifecycle core** — `src/hooks/shared/` agent-agnostic core: `HookInput` normalized shape,
  the 6 logical events (session-start, user_message capture, pre-tool-use VFS intercept, post-tool capture,
  assistant_message capture, session-end summary spawn), credential read from `~/.honeycomb/credentials.json`,
  a daemon-HTTP seam that calls `/api/hooks/*` stamping `x-honeycomb-runtime-path`, capture-gate + only-CLI-entry
  guard, context-renderer (read-only, absorbs errors). Plus the daemon-side `/api/hooks/*` handler attach
  (wire `capture-handler.ts` onto the route group) if not already attached.
- **019c per-harness shims** — Claude Code is the REFERENCE (full 6-event); each other harness
  (Codex, Cursor, OpenClaw, Hermes, pi, + OpenCode/Gemini/OhMyPi noted) is a THIN override of event-name map +
  payload normalize + context channel (model-only vs user-visible) + host-CLI for summaries + async pattern +
  CLI fallback for write-intercept-less harnesses. Maps onto 019b's core; no memory logic in shim code.
- **019d MCP server** — `mcp/src/` registers the unified `honeycomb_` tool surface (Memory cluster, Browse
  trio, Sessions, Goals/KPIs, Agent-coord, Codebase [conditional on graph], value-safe Secrets), each handler
  routing through an injected daemon-API seam stamping `x-honeycomb-runtime-path: plugin` + actor headers;
  arg schemas reject unknown args; `memory_modify`/`memory_forget` require a `reason`; secrets never return
  values. Streamable-HTTP `/mcp` + stdio transports behind a seam.
- **019e SDK** — `src/sdk/` `HoneycombClient` (fetch-only, no native deps → Node/Bun/browser), `remember`/
  `recall` + full daemon surface, typed errors (ApiError/NetworkError/TimeoutError), retry split (GET retries,
  mutations don't), actor/token model, value-safe secrets. Separate entry points: React bindings, Vercel AI SDK
  helper, OpenAI tool helper.

## Decisions
- **D-1 Scaffold-then-5-parallel.** Wave 1 scaffolds ALL contracts/seams/stubs for the 5 surfaces (so the
  parallel agents map onto stable types with zero shared-file contention). Wave 2 = 5 agents, each owning a
  DISTINCT directory (`src/connectors`, `src/hooks/shared`, `harnesses/*`+`src/hooks/<h>`, `mcp/src`, `src/sdk`).
- **D-2 Thin-client invariant everywhere.** Every 019 surface is a NON-daemon root — imports nothing from
  `daemon/storage` except the pure `sql.js` helpers; reaches the daemon ONLY through an injected HTTP/dispatch
  seam. `tests/daemon/storage/invariant.test.ts` must scan the new roots and stay green.
- **D-3 References gate = documented convention.** No sibling repos exist under `references/<harness>/` in this
  repo; the gate is recorded as a contribution rule + CONVENTIONS note (CI enforcement is the PRD's open
  question, deferred). Shims cite the protocol they implement in comments.
- **D-4 Reference-shim-full, others-parameterized.** Claude Code shim is implemented fully against the shared
  core and is the baseline every other shim's test asserts equivalence to. Non-reference shims are real thin
  overrides (event-map + normalize + channel + host-CLI), constructed-and-tested behind seams; their actual
  runtime binary/extension wiring is the deferred assembly step (matches the whole 001–018 posture).
- **D-5 No new schema / no new DeepLake.** PRD says Schema changes: None. All surfaces are thin clients.
- **D-6 Actor + runtime-path stamping is structural.** The MCP/SDK/hook seams stamp the headers; the daemon
  (already built) enforces. Tests assert the headers are stamped, not re-test daemon enforcement.

## Wave plan
- **Wave 1 — scaffold (typescript-node-worker-bee):** contracts/seams/stubs for all 5 surfaces, index barrels,
  CONVENTIONS.md per dir, the AC matrix pre-filled, the invariant test extended to scan the new non-daemon
  roots. All existing tests stay green; no behavior yet.
- **Wave 2 — 5 parallel fills:** 019a (harness-integration), 019b (harness-integration), 019c (harness-
  integration), 019d (typescript-node), 019e (typescript-node). Each: full impl + AC-named Vitest + green gates
  for its surface. 019c maps onto 019b's scaffolded core seams; 019a writes 019b's scaffolded handler set.
- **Wave 3 — security (opus) → quality (sonnet):** connector FS-write/symlink/foreign-config safety + uninstall
  containment; hook credential handling + no-SQL/no-DeepLake + capture-gate; MCP secrets value-safety +
  arg-schema rejection + reason-required mutation gate + actor stamping; SDK token handling + no value leak.
  Then quality AC-by-AC.

## Acceptance-criteria matrix (36 tracked) — states updated by Wave 2

> Wave 1 (scaffold) pre-filled the **Landing test** column: the named `*.test.ts` file
> (mirroring `src/` under `tests/`) each Wave-2 AC must land in. States stay PENDING until
> Wave 2 writes the test + flips it to VERIFIED. Tests run under `vitest run` (`tests/**/*.test.ts`).

### Index (cross-surface)
| ID | Gist | Landing test | State |
|---|---|---|---|
| AC-1 | setup/connect patches config + writes hooks + links skills; uninstall reverses only HC | `tests/connectors/connector-base.test.ts` (`index AC-1 setup wires config + handlers + skill links; uninstall reverses only Honeycomb`) | VERIFIED |
| AC-2 | native event → normalized shape → `/api/hooks/*` with `x-honeycomb-runtime-path` | `tests/hooks/shared/capture.test.ts` (`index AC-2: native event → normalized shape → /api/hooks/capture with runtime-path`) | VERIFIED |
| AC-3 | MCP harness lists unified `honeycomb_` surface; every handler routes through daemon API | `tests/mcp/tools.test.ts` (`index AC-3 …the registry registers the full base surface and each registered tool has a handler`) | VERIFIED |

### 019a connector-base — `tests/connectors/connector-base.test.ts`
| ID | Gist | Landing test | State |
|---|---|---|---|
| a-AC-1 | preserve foreign hooks on install | `tests/connectors/connector-base.test.ts` (`a-AC-1 install preserves a third-party hook already in the config`) | VERIFIED |
| a-AC-2 | uninstall removes only HC + unlinks emptied config | `tests/connectors/connector-base.test.ts` (`a-AC-2 uninstall removes ONLY Honeycomb's entries and unlinks an emptied config` + `a-AC-2 uninstall preserves a foreign hook and keeps the still-populated config`) | VERIFIED |
| a-AC-3 | idempotent re-install: no write, fingerprint unchanged | `tests/connectors/connector-base.test.ts` (`a-AC-3 re-install with no change writes NO config file (fingerprint unchanged)` + `a-AC-3 the second install records zero NEW config writes on the fake fs`) | VERIFIED |
| a-AC-4 | `setup` wires both detected harnesses | `tests/connectors/connector-base.test.ts` (`a-AC-4 \`honeycomb setup\` with no target wires BOTH detected harnesses`) | VERIFIED |
| a-AC-5 | new connector = subclass overriding 4 seams only | `tests/connectors/claude-code.test.ts` (`a-AC-5 install/uninstall are INHERITED from the base, not redeclared on the subclass` + `a-AC-5 the subclass declares ONLY the seam overrides`) | VERIFIED |
| a-AC-6 | skill link preserves foreign entries | `tests/connectors/connector-base.test.ts` (`a-AC-6 skill linking preserves a foreign entry already in the skill dir`) | VERIFIED |

### 019b hook-lifecycle — `tests/hooks/shared/*.test.ts`
| ID | Gist | Landing test | State |
|---|---|---|---|
| b-AC-1 | partial-vocab still completes (batch@end) | `tests/hooks/shared/capture.test.ts` (`b-AC-1: batched-at-end produces the SAME daemon rows as incremental`) | VERIFIED |
| b-AC-2 | reads creds + normalizes + local daemon req, no DeepLake/SQL | `tests/hooks/shared/capture.test.ts` (`b-AC-2: reads creds + normalizes + makes a local daemon request, no DeepLake/SQL`) | VERIFIED |
| b-AC-3 | session-start ensures tables + placeholder + context + additionalContext | `tests/hooks/shared/session-start.test.ts` (`b-AC-3: ensures tables + placeholder + context + returns additionalContext, in FR-3 order`) | VERIFIED |
| b-AC-4 | pre-tool grep → daemon hybrid, nothing hits real FS | `tests/hooks/shared/pre-tool-use.test.ts` (`b-AC-4: a Bash grep on the memory path → daemon hybrid search, nothing hits the real FS`) | VERIFIED |
| b-AC-5 | session-end marks + usage + skillify + detached summary under lock | `tests/hooks/shared/session-end.test.ts` (`b-AC-5: marks ended + usage + skillify (daemon), acquires lock, spawns detached worker`) | VERIFIED |
| b-AC-6 | second runtime path → 409 | `tests/hooks/shared/session-start.test.ts` (`b-AC-6: the second runtime path is rejected with 409 (daemon enforces; core surfaces)`) | VERIFIED |

### 019c per-harness shims — `tests/hooks/<harness>/*.test.ts`
| ID | Gist | Landing test | State |
|---|---|---|---|
| c-AC-1 | each harness → same daemon rows as reference | `tests/hooks/claude-code/shim.test.ts` (`c-AC-1 a user_message normalizes to the SAME daemon body across harnesses` + `c-AC-1 a tool_call normalizes to the SAME daemon body across harnesses` + `c-AC-1 every harness maps native event names onto the SAME logical events` + runtime-path + dropped-event) | VERIFIED |
| c-AC-2 | no-pre-tool → CLI fallback for goal/KPI | `tests/hooks/openclaw/shim.test.ts` (`c-AC-2 a goal write with no pre-tool hook falls back to a CLI call` + `c-AC-2 a kpi write also falls back to a CLI call`) + `tests/hooks/pi/shim.test.ts` (`c-AC-2 pi has no pre-tool hook → goal/KPI routes through the CLI fallback`) | VERIFIED |
| c-AC-3 | OpenClaw `agent_end` → new-slice only | `tests/hooks/openclaw/shim.test.ts` (`c-AC-3 agent_end sends ONLY the new-message slice since the last flush` + `c-AC-3 the batched new-slice produces the SAME daemon rows as incremental capture` + `c-AC-3 the agent is auto-routed from the session key`) | VERIFIED |
| c-AC-4 | Codex detached setup + brief login line | `tests/hooks/codex/shim.test.ts` (`c-AC-4 autoUpdate + table-ensure are deferred to a DETACHED setup process` + `c-AC-4 only a brief login-state line is injected (signed-in)` + `c-AC-4 / c-AC-5 the channel is user-visible and the envelope carries the brief line`) | VERIFIED |
| c-AC-5 | model-only vs user-visible channel each lands | `tests/hooks/shims-channel.test.ts` (`c-AC-5 model-only harnesses carry the VERBATIM block in additionalContext` + `c-AC-5 user-visible harnesses carry the block as transcript text` + `c-AC-5 the SAME block routes to BOTH a model-only and a user-visible harness`) | VERIFIED |
| c-AC-6 | shim cites `references/<harness>/` sibling | `tests/hooks/shims-references-gate.test.ts` (`c-AC-6 every shim cites references/<harness>/` + `c-AC-6 every shim source file cites its protocol in a comment`) | VERIFIED |

### 019d MCP server — `tests/mcp/*.test.ts`
| ID | Gist | Landing test | State |
|---|---|---|---|
| d-AC-1 | unified surface lists + stamps plugin + actor | `tests/mcp/tools.test.ts` (`d-AC-1 a harness listing tools sees the unified honeycomb_ surface` + `d-AC-1 every handler routes through the daemon seam, stamping plugin + actor` + `d-AC-1 the production seam stamps x-honeycomb-runtime-path: plugin + actor headers`) | VERIFIED |
| d-AC-2 | secrets value-safe (list names, exec redacted) | `tests/mcp/secrets.test.ts` (`d-AC-2 secret_list returns NAMES only…` + `d-AC-2 secret_exec returns REDACTED output…`) | VERIFIED |
| d-AC-3 | modify/forget w/o reason → rejected | `tests/mcp/tools.test.ts` (`d-AC-3 memory_modify without reason is rejected before any daemon call` + `d-AC-3 memory_forget without reason is rejected before any daemon call`) | VERIFIED |
| d-AC-4 | codebase cluster conditional on graph build | `tests/mcp/codebase-conditional.test.ts` (`d-AC-4 with the graph NOT built, the codebase tools are absent` + `d-AC-4 after \`honeycomb graph build\` …the codebase tools appear`) | VERIFIED |
| d-AC-5 | `session_search` infers parent lineage | `tests/mcp/sessions.test.ts` (`d-AC-5 session_search stamps the inferred parent onto the daemon request`) | VERIFIED |
| d-AC-6 | HTTP and stdio both route through daemon | `tests/mcp/transports.test.ts` (`d-AC-6 both transports bind to the SAME McpServer instance` + `d-AC-6 the same tool over either transport runs the same handler → same daemon call`) | VERIFIED |

### 019e SDK — `tests/sdk/*.test.ts`
| ID | Gist | Landing test | State |
|---|---|---|---|
| e-AC-1 | remember/recall carry token + actor + actorType | `tests/sdk/client.test.ts` (3 named) | VERIFIED |
| e-AC-2 | typed errors + GET-retries / mutation-no-retry | `tests/sdk/client.test.ts` (7 named) | VERIFIED |
| e-AC-3 | runs Node/Bun/browser, no native dep | `tests/sdk/client.test.ts` (3 named) | VERIFIED |
| e-AC-4 | `useRecall` → results + loading + typed-error | `tests/sdk/react.test.ts` (3 named) | VERIFIED |
| e-AC-5 | Vercel + OpenAI helpers reuse core client | `tests/sdk/helpers.test.ts` (7 named) | VERIFIED |
| e-AC-6 | secrets names + redacted only | `tests/sdk/client.test.ts` (3 named) | VERIFIED |

> **019e fill (Wave 2) landed.** `src/sdk/client.ts` filled (fetch-only pipeline: actor+token
> headers on every call, retry split via `RetryPolicy`, AbortController timeout, typed-error
> mapping, full grouped surface, value-safe secrets). `react.ts`/`vercel.ts`/`openai.ts` filled
> reusing the core client (React via an injected `ReactRuntime` seam — no `@types/react` dep).
> `package.json#exports` (`.`,`./react`,`./vercel`,`./openai`) + OPTIONAL `peerDependencies`
> (react,ai) + `sdk` files entry + 4 esbuild SDK bundle entries added. Gates green: `npm run ci`=0,
> `npm run build`=0 (4 SDK bundles), `audit:sql`=0, `audit:openclaw`=0, invariant green, jscpd
> 0.41% (< 7), 26 SDK tests pass. DEFERRED: publishing `@honeycomb/sdk` as its own npm package
> (the module is constructed-and-tested as subpath exports of this repo).

## Wave-2 ownership map (zero shared-file contention — D-1)

| Stream | Agent | OWNS (exclusive write) |
|---|---|---|
| 019a | harness-integration | `src/connectors/**`, `tests/connectors/**` |
| 019b | harness-integration | `src/hooks/shared/**`, `tests/hooks/shared/**` |
| 019c | harness-integration | `src/hooks/{claude-code,codex,cursor,openclaw,hermes,pi}/**`, `src/hooks/contracts.ts`, `src/hooks/index.ts`, `tests/hooks/<harness>/**` |
| 019d | typescript-node | `mcp/src/**`, `tests/mcp/**`, `package.json` MCP dep + exports |
| 019e | typescript-node | `src/sdk/**`, `tests/sdk/**`, `package.json` SDK exports + esbuild SDK entries |

Shared/boundary files touched in Wave 1 (NOT re-touched by a single stream in Wave 2 without coordination):
`tests/daemon/storage/invariant.test.ts` (extended now — stable), `src/shared/capture-gate.ts` (reused, not modified),
`esbuild.config.mjs` + `package.json#files` (MCP bundle already wired; SDK entries are a documented 019e build note).

## Watchdog (live lessons / fixes / deferrals)
- **Wave 1 scaffold:** `@modelcontextprotocol/sdk` is NOT yet a dependency; 019d defines local
  `ToolRegistry`/`DaemonApiSeam` seams and uses `zod/v3` (resolves via installed zod ^4). Wave 2's
  first 019d step is adding the SDK dep + backing `registerTool`. (mcp/src/CONVENTIONS.md)
- **Wave 1 scaffold:** SDK framework helpers (`react`/`vercel`/`openai`) are separate entry points
  with NO peer deps added this wave; Wave 2 adds `package.json#exports` subpaths + esbuild entries +
  `peerDependencies` (react, ai). Build stays green via the existing tsc pass. (src/sdk/CONVENTIONS.md)
- **Wave 1 scaffold:** the daemon `/api/hooks/*` handler attach (wire `capture-handler.ts` onto the
  already-mounted `/api/hooks` route group) is a 019b Wave-2 step; the route group exists in
  `server.ts`. (src/hooks/shared/CONVENTIONS.md)
- **Wave 2 — 019a connector-base (LANDED):** `HarnessConnector` base filled (install/uninstall/
  `writeJsonIfChanged`/`isHoneycombEntry`/`detectPlatforms`/`patchConfig`/`linkSkills`/`unlinkSkills`);
  `ClaudeCodeConnector` reference filled (4 seam overrides, subclass-only — a-AC-5); `src/connectors/cli.ts`
  `setup`/`connect`/`uninstall` verbs filled behind a `ConnectorFs` + `ConnectorRegistry` seam.
  - **Honeycomb-entry sentinel:** `isHoneycombEntry` keys off a stamped `_honeycomb: true` field
    (`HONEYCOMB_ENTRY_KEY`), NOT a command substring — a `${…_PLUGIN_ROOT}/bundle/…` command is not
    self-identifying, so a substring match would duplicate-on-reinstall (a-AC-3) and risk clobbering a
    foreign hook (a-AC-1/a-AC-2). Legacy `…/honeycomb/bundle/…` path is a back-compat fallback. (CONVENTIONS.md)
  - **Honest deferral (matches 001–018):** the bundled `honeycomb` bin is NOT wired to dispatch to
    `setup`/`connect`/`uninstall`; the verbs are constructed-and-tested behind the seams (mirrors
    `org.ts`/`skillify.ts`). Bin dispatch is the deferred pure-wiring step.
  - Gates green: `npm run ci` (typecheck + jscpd 0-clones + 1261 tests + audit:sql), `npm run build`,
    `audit:openclaw`, `tests/daemon/storage/invariant.test.ts` (scans `src/connectors`, still green).
- **Wave 2 — 019d MCP server (LANDED):** `@modelcontextprotocol/sdk@^1.29.0` added to
  `package.json#dependencies`; esbuild bundles it into `mcp/bundle/server.js` (THIN_CLIENT_EXTERNAL =
  `node:*` only), no esbuild change. Filled `handlers.ts` (per-cluster daemon-routed `HANDLERS` +
  reason-gate + value-safe secrets), `sessions.ts` (`inferParentSessionKey` + lineage-stamping
  `sessionSearch`), `registry.ts` (`createMcpToolRegistry` backs `ToolRegistry` over
  `McpServer.registerTool`; strict-parse rejects unknown args BEFORE dispatch; `registerHoneycombSurface`
  gates codebase on `graphBuilt`; `invoke(name,args)` drives the exact wrapped handler both transports
  run), `daemon-seam.ts` (`createHttpDaemonApiSeam` stamps `plugin` + actor + actor-type on every call,
  behind an injected `fetch`), `transports.ts` (`bindAllTransports` binds streamable-HTTP + stdio to the
  SAME `McpServer` behind the `TransportBinder` seam). `createMcpServer(opts)` wires it; backward-
  compatible with the Wave-1 positional `DaemonApiSeam`.
  - **Final tool list (22):** memory_search·memory_store·memory_get·memory_list·memory_modify\*·
    memory_forget\*·memory_feedback · honeycomb_search·honeycomb_read·honeycomb_index ·
    session_search·session_bypass · honeycomb_goal_add·honeycomb_kpi_add ·
    agent_peers·agent_message_send·agent_message_inbox · honeycomb_code_search†·honeycomb_code_context†·
    honeycomb_code_blast†·honeycomb_code_impact† · secret_list‡·secret_exec‡.
    (\* reason-required · † codebase, graph-gated · ‡ value-safe.)
  - **HARD security property (d-AC-2):** no tool returns a raw secret value — `secret_list` rebuilds
    `{ names }` from names alone (a daemon that attaches `value` cannot leak it); `secret_exec` always
    returns the `[REDACTED]` token. `tests/mcp/secrets.test.ts` plants a secret and asserts it never
    appears in the serialized result.
  - **Honest deferral (matches 001–018):** the real daemon-API fetch over loopback + the transport
    socket / process-stdio bind are constructed-and-tested behind the `fetch` / `TransportBinder` seams;
    the live `connect()` against the daemon's mounted `/mcp` group is the deploy-time assembly step. NO
    live MCP endpoint is claimed serving. (mcp/src/CONVENTIONS.md)
  - AC matrix: index AC-3 + d-AC-1..6 → VERIFIED with named tests. Gates green: `npm run ci`
    (typecheck + jscpd 0.52%/threshold 7 + 1269 tests + audit:sql), `npm run build`, `audit:openclaw`,
    `tests/daemon/storage/invariant.test.ts` (scans `mcp/`, still green).
- **Wave 2 — 019b hook-lifecycle (LANDED):** the agent-agnostic core filled —
  `runSessionStart` (FR-3 order, gated ensure+placeholder, fail-soft), `runCapture` +
  `runCaptureBatch` (gate→`/api/hooks/capture`; batched-at-end ≡ incremental, b-AC-1),
  `runPreToolUse` (VFS intercept via injected `VfsIntercept`; grep→search, write→deny,
  unmodelable→echo-rewrite; NO `node:fs` import so nothing hits real FS, b-AC-4),
  `runSessionEnd` (one daemon mark/usage/skillify call + lock-acquire→detached spawn →
  release-on-throw, b-AC-5), `createContextRenderer` (POST `/api/hooks/context`,
  read-only, absorbs errors → "").
  - **Additive seams (STABLE for 019c):** `SessionStartSeams`/`SessionStartDeps`,
    `VfsIntercept`+`VfsToolOp`, `SummaryLock`, each with a recording fake. Nothing in
    `contracts.ts` was renamed/re-typed — `SessionStartDeps extends HookCoreDeps` with
    OPTIONAL extras; `runPreToolUse`/`runSessionEnd` take the new seam as an OPTIONAL
    trailing param, so 019c's existing `HookCoreDeps` construction stays compatible.
  - **409 stamping (b-AC-6 / D-6):** every hook call stamps `x-honeycomb-runtime-path`;
    a daemon `409` is SURFACED (`reason:"runtime-path-conflict"`), never thrown — the
    core stamps, the daemon enforces (driven by `createFakeDaemonHookClient({status:409})`).
  - **Daemon attach (LANDED):** `src/daemon/runtime/capture/attach.ts`
    `attachHooksHandlers(daemon, {storage, queue, sessionsTarget?})` wires
    `capture-handler.ts` onto the `/api/hooks` group (defaults `healTargetFor("sessions")`);
    BEFORE→501 scaffold, AFTER→201 live (`tests/daemon/runtime/capture/attach.test.ts`).
    `createDaemon` unchanged; importing the daemon never auto-invokes it.
  - **Honest deferral:** real `DaemonHookClient`/`CredentialReader` + the
    `/api/hooks/context` + `/api/hooks/session-end` daemon handlers + real
    `SessionStartSeams`/`VfsIntercept`/`SummaryLock`/`SummarySpawn` bindings + the daemon
    assembly that calls `attachHooksHandlers` are the deferred pure-wiring steps. NO
    harness is claimed wired. (src/hooks/shared/CONVENTIONS.md)
  - AC matrix: b-AC-1..6 + index AC-2 → VERIFIED with named tests. Gates green: `npm run ci`,
    `npm run build`, `audit:sql`, `audit:openclaw`, invariant (scans `src/hooks`, green).
- **Wave 2 — 019c per-harness shims (LANDED):** the six shims filled as THIN overrides
  over ONE shared normalization engine. `src/hooks/normalize.ts` (`createShim(spec)` +
  `ShimSpec`) is the single engine every shim runs — so c-AC-1 equivalence is STRUCTURAL,
  not coincidental: a shim is a `ShimSpec` config (event-map + channel + host-CLI +
  `references` + the per-harness `extractData`/`deriveMeta`/`renderUserVisible`). The
  canonical capture-data builders (`userMessageData`/`assistantMessageData`/`toolCallData`/
  `sessionStartData`/`sessionEndData`/`preToolData`) define the reference's `{ kind, ... }`
  shapes; every shim reuses them, so two harnesses naming fields differently still normalize
  to byte-identical `HookInput`s.
  - **REFERENCE (FR-1):** `claude-code/shim.ts` — full 6-event (`SessionStart`,
    `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`/`SubagentStop`, `SessionEnd`);
    its `claudeCodeExtractData` is the baseline every other shim asserts equivalence to.
  - **codex** (FR-3 / c-AC-4): brief login line (`codexRenderUserVisible`) + detached
    `codexSessionStartSetup` (autoUpdate+ensureTables deferred) + Bash-only PreToolUse +
    `codex exec` host-CLI + user-visible channel.
  - **cursor** (FR-4): `workspace_roots[0]` cwd (`cursorDeriveMeta`) + `Shell`→canonical-Bash
    intercept + `additional_context` model-only key + `cursor-agent`→`claude` host-CLI.
  - **openclaw** (FR-5 / c-AC-3 / c-AC-2): `openclawSliceSinceLastFlush` (new-slice cursor) +
    `openclawExpandBatch`→`runCaptureBatch` (rows ≡ incremental, b-AC-1) + agent auto-route
    from `agent:alice:` session key + `before_agent_start`/`before_prompt_build`→session-start +
    NO PreToolUse → `openclawGoalKpiFallback` CLI route.
  - **hermes** (FR-6): terminal-only tool filter + `{ context }` output (`hermesContextOutput`)
    + MCP-tools mention (`HERMES_MCP_MENTION`) + `hermes --non-interactive` host-CLI.
  - **pi** (FR-7 / c-AC-2): static `AGENTS.md` fenced block (`piAgentsBlock`) + session-end-only
    events + NO PreToolUse → `piGoalKpiFallback` + `piResolveHostCli(provider,model)`.
  - **Channel routing (FR-10 / c-AC-5):** `shim.renderContext(block)` → `ContextEnvelope`
    (`{channel:"model-only", additionalContext}` for Claude Code/Cursor/OpenClaw;
    `{channel:"user-visible", text}` for Codex/Hermes/pi). Same logical block, correct surface.
  - **References gate (FR-11 / D-3 / c-AC-6):** each shim stamps `references/<harness>/` on the
    `HarnessShim.references` field AND cites the protocol in its module header (no `references/`
    repo exists — documented convention).
  - **FR-8 future shims (OpenCode/Gemini/OhMyPi):** documented in `src/hooks/CONVENTIONS.md` as
    thin `ShimSpec` configs to be added later — NOT implemented this wave.
  - **Honest deferral:** shims are CONSTRUCTED-AND-TESTED behind the 019b seams; NO harness is
    live-wired. The per-harness runtime binary/extension dispatch (`harnesses/<h>/src/index.ts`,
    the pi raw-`.ts` extension, the OpenClaw native extension, the Cursor extension) is the
    deferred assembly step (matches the 001–018 / 019b posture). (src/hooks/CONVENTIONS.md)
  - AC matrix: c-AC-1..6 → VERIFIED with named tests (63 hook tests pass). Gates green:
    `npm run ci`=0 (typecheck + jscpd 0.4%/threshold 7 + 1314 tests + audit:sql), `npm run build`=0,
    `audit:openclaw`=0, `audit:sql`=0, `tests/daemon/storage/invariant.test.ts` (scans `src/hooks`,
    3/3 green).
- (more filled as Wave 2 lands)
