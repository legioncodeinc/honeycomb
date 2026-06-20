# MCP server — CONVENTIONS (PRD-019d)

The MCP server lives under `mcp/src/`. It runs inside the daemon, reachable over streamable
HTTP at `/mcp` or as a stdio subprocess, and exposes the unified `honeycomb_` tool surface.
Wave 1 (019d scaffold) ships the `ToolRegistry` contract, the `DaemonApiSeam`, the cluster
grouping, and the ~25-tool name list with strict arg-schema placeholders; Wave 2 backs the
registry with the MCP SDK, wires the transports, and fills the handlers.

## The central rule: one more THIN CLIENT of the daemon (FR-1 / FR-2 / D-2)

- **`mcp` is in `NON_DAEMON_ROOTS`** (`tests/daemon/storage/invariant.test.ts`). The server opens
  NO DeepLake. Every handler routes through the `DaemonApiSeam` (`call(req)`), which calls the
  daemon's own API internally, stamping `x-honeycomb-runtime-path: plugin` + actor headers (FR-2 /
  d-AC-1). The fake (`createFakeDaemonApiSeam`) records every call so a Wave-2 test asserts every
  handler routes through the daemon AND the stamps are present (D-6 — assert the stamp, not the
  daemon's enforcement).

## The zod v4/v3 split is load-bearing

The app uses zod ^4, but the MCP SDK (`@modelcontextprotocol/sdk`) speaks zod v3. MCP tool input
schemas therefore import from `"zod/v3"` (the compatibility subpath the installed zod ^4 ships).
Mixing zod majors silently breaks `inputSchema` inference. `contracts.ts` and `tools.ts` import
`zod/v3`; do NOT switch them to bare `"zod"`.

## The MCP SDK is NOT yet a dependency (Wave 2 adds it)

Wave 1 keeps the build green WITHOUT adding `@modelcontextprotocol/sdk` (no new dependency this
wave). The `ToolRegistry` and `DaemonApiSeam` are LOCAL interfaces (seams); `createToolRegistry`'s
`registerTool` is an honest stub that throws until Wave 2 backs it with `McpServer.registerTool`.

**Wave 2 build note:** adding `@modelcontextprotocol/sdk` to `package.json#dependencies` is the
first Wave-2 step. The MCP bundle (`mcp/bundle/server.js`) is already wired in `esbuild.config.mjs`
(THIN_CLIENT_EXTERNAL, Node hash-bang) and `package.json#files` — no build change needed for the
bundle itself; only the SDK dep + the transport wiring.

## The unified surface (FR-3..FR-8) — `tools.ts`

~25 tools across seven clusters. Each `ToolSpec` carries its `honeycomb_`-prefixed name, cluster,
and a STRICT `zod/v3` arg-schema placeholder (`.strict()` rejects unknown args, FR-10 / d-AC-1).

| Cluster      | Tools |
|--------------|-------|
| memory       | memory_search, memory_store, memory_get, memory_list, memory_modify*, memory_forget*, memory_feedback |
| browse       | honeycomb_search, honeycomb_read, honeycomb_index |
| sessions     | session_search (infers parent lineage from a child key, d-AC-5), session_bypass |
| goals-kpis   | honeycomb_goal_add, honeycomb_kpi_add |
| agent        | agent_peers, agent_message_send, agent_message_inbox |
| codebase†    | honeycomb_code_search, honeycomb_code_context, honeycomb_code_blast, honeycomb_code_impact |
| secrets‡     | secret_list, secret_exec |

\* `memory_modify` / `memory_forget` REQUIRE a `reason` arg — the handler rejects a call without
one (FR-9 / d-AC-3). The arg schema already makes `reason` required; the Wave-2 handler enforces it.

† the `codebase` cluster is registered CONDITIONALLY — only after `honeycomb graph build` enables
the workspace graph (FR-7 / d-AC-4). `CONDITIONAL_TOOL_NAMES` is the exact set to gate.

‡ the `secrets` cluster is VALUE-SAFE (FR-8 / d-AC-2): `secret_list` returns NAMES only,
`secret_exec` queues a command and returns REDACTED output. No tool ever returns a secret value —
the Wave-2 handler + the daemon secrets module enforce this; the Wave-3 security audit verifies it.

## Transports behind a seam (FR-1 / d-AC-6)

Streamable-HTTP `/mcp` and stdio both route through the same `DaemonApiSeam`, so the SAME tool
called over either transport returns equivalent results (d-AC-6). The daemon `server.ts` already
mounts the `/mcp` route group (session + protected, behind runtime-path → permission). Wave 2
wires the SDK transport onto it + the stdio subprocess.

## What Wave 2 fills (signatures STABLE — pure fill)

- Add `@modelcontextprotocol/sdk` dep; back `ToolRegistry.registerTool` with `McpServer.registerTool`.
- The real `DaemonApiSeam` (internal daemon-API caller stamping plugin + actor headers).
- Each tool handler (memory/browse/sessions/goals-kpis/agent/codebase/secrets), the reason-required
  gate, the secrets value-safety, the conditional codebase registration, the HTTP + stdio transports.

## Wave 2 — what landed (PRD-019d FILLED)

The `@modelcontextprotocol/sdk@^1.29.0` dependency is added to `package.json#dependencies`. The
build stays green: esbuild bundles the SDK into `mcp/bundle/server.js` (THIN_CLIENT_EXTERNAL only
externalizes `node:*`), so no esbuild change was needed. The unified `honeycomb_` surface is now
fully registered + routed:

| Module | Owns |
|--------|------|
| `handlers.ts` | The `HANDLERS` table — one daemon-routed handler per tool. Reason-required gate (`memory_modify`/`memory_forget` reject a missing/blank `reason` BEFORE any daemon call). Value-safe secrets (`toSecretListResult` reconstructs from names only; `toSecretExecResult` always redacts). |
| `sessions.ts` | `inferParentSessionKey` (pure lineage derivation from a child key) + `sessionSearch` (stamps `parentSessionKey` onto the daemon request — how OpenClaw resolves a parent slice). |
| `registry.ts` | `createMcpToolRegistry` backs `ToolRegistry` over `McpServer.registerTool`. The wrapped handler STRICT-parses args (unknown/extra → rejected, FR-10), routes through the daemon seam (FR-2), shapes the MCP envelope. `registerHoneycombSurface` registers every cluster, GATING the codebase cluster on `graphBuilt` (d-AC-4). `invoke(name,args)` drives the exact wrapped handler both transports run (used by the d-AC-6 test). |
| `daemon-seam.ts` | `createHttpDaemonApiSeam` — the production seam. Stamps `x-honeycomb-runtime-path: plugin` + `x-honeycomb-actor` + `x-honeycomb-actor-type` on EVERY call (FR-2 / d-AC-1 / D-6). Behind an injected `fetch` so a test asserts the stamps with no socket. |
| `transports.ts` | `bindAllTransports` binds streamable-HTTP (`StreamableHTTPServerTransport`) AND stdio (`StdioServerTransport`) to the SAME `McpServer` (d-AC-6). Behind the `TransportBinder` seam so a test asserts equivalence without binding a port. |
| `index.ts` | `createMcpServer(opts)` wires it all: registry over the injected seam + actor, surface registration with codebase gating, both transports bound. Backward-compatible with the Wave-1 positional `DaemonApiSeam`. |

### HARD security property (d-AC-2)

No tool ever returns a raw secret value. `secret_list` reconstructs `{ names }` from the daemon
body's `names` array ALONE — even a daemon that attaches `value`/`values` fields cannot leak them.
`secret_exec` coerces to `{ status, output }` with `output` ALWAYS the redacted string (defaults to
`[REDACTED]`). `tests/mcp/secrets.test.ts` proves a planted secret never appears in the serialized
result.

### Honest deferral (assembly step — NOT claimed live)

- The **real daemon-API fetch over loopback** (`createHttpDaemonApiSeam` with `globalThis.fetch`) is
  constructed-and-tested behind the `fetch` seam. The live wiring against the running daemon on
  `127.0.0.1:3850` is the deploy-time assembly step.
- The **transport socket / process-stdio bind** is behind the `TransportBinder` seam. `connect()` is
  defined but NOT called at construction; the daemon (which mounts `/mcp` in `server.ts`) calls it
  once it owns the HTTP request stream / the process stdio.
- We do **NOT** claim a live MCP endpoint is serving — only that the seams stamp + route correctly
  and that HTTP and stdio resolve to the same handler dispatch.

## Wave 2b — PRD-021e MCP transport BOUND LIVE (the deferral above is now CLOSED)

021e flips the "imports clean but doesn't serve" state. `index.ts` adds `startMcpServer()` — the
caller 019d defined but never made — and a `isMainEntry()` guard so the bundled `mcp/bundle/server.js`
auto-starts when run directly (never on import; mirrors `src/daemon/index.ts`).

| Concern | 021e resolution |
|---------|-----------------|
| **stdio bind (e-AC-1/e-AC-2)** | `startMcpServer()` calls `transports.stdio.connect()` on the constructed server, so the bundle answers a REAL `initialize` over the process stdin/stdout — the path a harness uses when it spawns the bundle. Proven by the gated itest spawning the BUILT bundle. |
| **HTTP `/mcp` serve (e-AC-1/e-AC-6)** | `serveStreamableHttp()` stands up a loopback `node:http` server (127.0.0.1 only) routing `/mcp` into the connected `StreamableHTTPServerTransport` (stateless, `enableJsonResponse: true`). Opt-in via `startMcpServer({ serveHttp: true })`. |
| **SDK one-transport-per-server rule** | The MCP SDK `Protocol` allows ONE transport per `McpServer` (`server.connect` throws on a second). `bindAllTransports` stays a CONSTRUCTION-equivalence seam (same registry → same handlers); the LIVE path connects stdio to the primary server and stands up a SECOND server (identical surface) for the served HTTP transport. Same `honeycomb_` contract byte-for-byte (e-AC-5). |
| **DaemonApiSeam loopback (e-AC-3)** | Unchanged — every handler still routes through `createHttpDaemonApiSeam` over `127.0.0.1:3850` stamping `plugin` + actor. mcp/ opens NO DeepLake; `invariant.test.ts` stays green. |
| **Harness registration (e-AC-4)** | `harnesses/hermes/.mcp.json` registers a `honeycomb` stdio server (`node mcp/bundle/server.js`) so the hermes tool list loads the unified surface. A distinct config file — NOT `harnesses/hermes/src/index.ts` (021c owns that). |

Tests: `tests/mcp/start-server.test.ts` (in-memory `Client` real `initialize` + tool list; tool call
routes via the fake seam; served `/mcp` answers a real `initialize`), `tests/mcp/registration.test.ts`
(the artifact lists the server), `tests/mcp/transports.test.ts` (serve/404 + `handleHttpRequest`), and
the GATED `tests/integration/mcp-transport-live.itest.ts` (spawns the BUILT bundle over stdio,
`initialize` + `tools/list`, build-aware skip-if-missing, no DeepLake token needed).
