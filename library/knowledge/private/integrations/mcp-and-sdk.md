# MCP and SDK

> Category: Integrations | Version: 1.1 | Date: July 2026 | Status: Active

The on-demand surfaces into Honeycomb: the MCP server that exposes memory tools to harnesses, the OpenClaw extension surface, and the typed SDK for building against the daemon.

**Related:**
- [`harness-integration.md`](harness-integration.md)
- [`hook-lifecycle.md`](hook-lifecycle.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../ai/retrieval.md`](../ai/retrieval.md)
- [`../security/secrets.md`](../security/secrets.md)

---

## Two ways to ask

Hooks let the daemon volunteer context. MCP and the SDK are the other half: surfaces an agent or an application uses to ask for memory operations explicitly. MCP is for harnesses that speak the Model Context Protocol; the SDK is for code that wants a typed client. Both are thin clients of the honeycomb daemon, which is the only process that touches DeepLake.

## The MCP server

The MCP server lives at `mcp/src/` (entry `mcp/src/index.ts`) and is built by esbuild to `mcp/bundle/server.js`, a self-contained executable bundle that ships with the package. It binds two transports against one `McpServer` (built on `@modelcontextprotocol/sdk`): a **stdio** transport when run as a subprocess (`node mcp/bundle/server.js`), and a **streamable-HTTP** transport served at `/mcp` on loopback. It is separate from hooks and runs alongside them. Every tool handler calls the daemon's own API internally through the HTTP daemon seam (`mcp/src/daemon-seam.ts`), stamping `x-honeycomb-runtime-path: plugin` plus actor headers (`x-honeycomb-actor: honeycomb-mcp`, actor type `plugin`, and a synthetic `mcp-<n>` session for session-group paths), so MCP traffic is identified and scoped like any other plugin-path call. Tool input schemas use `zod/v3` for SDK compatibility, distinct from the app's `zod ^4`.

The tool surface is defined in `mcp/src/tools.ts` and handled in `mcp/src/handlers.ts`. It registers **19 tools**, 15 unconditional plus the 4-tool conditional `codebase` cluster, across five clusters (`memory`, `browse`, `goals-kpis`, `codebase`, `secrets`) under the `honeycomb_` / `memory_` / `hivemind_` / `secret_` prefixes:

| Cluster | Tools |
|---|---|
| Memory | `memory_search`, `memory_store`, `memory_get`, `memory_list`, `memory_modify`, `memory_forget` |
| Prime pull | `hivemind_read`, `hivemind_search` |
| Browse (VFS) | `honeycomb_search`, `honeycomb_read`, `honeycomb_index` |
| Goals and KPIs | `honeycomb_goal_add`, `honeycomb_kpi_add` |
| Codebase (conditional) | `honeycomb_code_search`, `honeycomb_code_context`, `honeycomb_code_blast`, `honeycomb_code_impact` |
| Secrets (value-safe) | `secret_list`, `secret_exec` |

`memory_search` is the hybrid recall described in [`../ai/retrieval.md`](../ai/retrieval.md). `memory_modify` requires **both** a `content` argument (the daemon's `POST /api/memories/:id/modify` is a version-bumped update that needs new content to write) and a `reason`; `memory_forget` requires a `reason`. Both take a `reason` because every mutation is audited. The `honeycomb_search`/`read`/`index` trio is the read-only browse surface backed by the virtual filesystem in [`../data/memory-virtual-filesystem.md`](../data/memory-virtual-filesystem.md); each dials the daemon's real VFS routes (`/memory/grep`, `/memory/cat`, `/memory/ls`). The goal and KPI tools each take a single string and the handler maps it onto the daemon's strict `{ key, value }` keyed body. The secrets tools never expose values: `secret_list` returns names and `secret_exec` queues a command and returns redacted output while preserving its `jobId`, per [`../security/secrets.md`](../security/secrets.md). The codebase tools surface the query endpoints documented in [`../data/codebase-graph.md`](../data/codebase-graph.md) once a graph exists for the workspace, and are only registered after `honeycomb graph build`.

### Tools the surface deliberately does not register (C-2, 2026-07-03)

The original Wave-1 scaffold also listed a `sessions` cluster (`session_search`, `session_bypass`), an `agent` cluster (`agent_peers`, `agent_message_send`, `agent_message_inbox`), and a `memory_feedback` tool. None had a backing daemon route: `src/daemon/runtime/server.ts` never mounts `/api/sessions` or `/api/agents`, and `/api/memories` has no `/feedback` sub-route, so every call 404'd. The pre-release QA sweep removed them (unregistered, not built) rather than publish a tool that dials a route that does not exist. Two dead arguments went with them, `memory_list`'s `prefix` (the wired `GET /api/memories` list route has no prefix filter) and `honeycomb_kpi_add`'s `goalId` (the keyed schema has no goal-linkage field). The parent-lineage inference helper still lives in `mcp/src/sessions.ts`, but it is no longer reachable as a callable MCP tool.

### Read/resolve vs search/mine

The tool surface splits along a deliberate seam between *resolving a known reference* and *mining for unknown matches*:

- **Read / resolve**, deterministic `SELECT`s. `memory_get` fetches a single memory by path; `hivemind_read` zooms a primed reference to its fuller Tier-2 summary or Tier-3 raw detail. These return exactly the row asked for; they do not rank.
- **Search / mine**, hybrid lexical-plus-semantic recall fused by reciprocal-rank, with an honest `degraded` flag when the semantic path is unavailable. `memory_search` and `hivemind_search` are the mining tools; `honeycomb_search` is the VFS-backed search variant.

This is why a session that already holds a primed reference can `hivemind_read` it cheaply without re-running a recall, while a cold query reaches for `memory_search` / `hivemind_search`.

## MCP-server-via-install

Where a harness speaks MCP, the connector registers the Honeycomb server during `honeycomb connect` so the `honeycomb_*` tools appear in the harness's native tool list, no separate "add an MCP server" step for the user. The registration is the stdio entry `node mcp/bundle/server.js`. Hermes, for example, carries it in `harnesses/hermes/.mcp.json`:

```json
{ "mcpServers": { "honeycomb": { "command": "node", "args": ["mcp/bundle/server.js"] } } }
```

and the Hermes shim appends a user-visible mention so the agent knows the tools are live: `(Honeycomb MCP tools available: honeycomb_search, honeycomb_read, honeycomb_index.)`. The same stdio bundle registers into the other MCP-speaking harnesses (Cursor through its extension, Codex, OpenClaw) during their connect step, and the daemon additionally serves the streamable-HTTP transport at `/mcp` for HTTP-speaking clients. The install-time registration is part of the connector contract documented in [`harness-integration.md`](harness-integration.md).

## The OpenClaw extension surface

OpenClaw gets a native extension on top of MCP (registered during its connect step). It registers the same memory and browse tools plus the goal and KPI tools as agent-callable commands, batches capture at `agent_end`, and supplements the agent's memory corpus on `before_agent_start`. The extension carries an env-harvesting workaround from the Hivemind build (tuning values are read from a global object rather than `process.env`); the build mechanics are in [`../infrastructure/monorepo-build-release.md`](../infrastructure/monorepo-build-release.md).

## The SDK

`@honeycomb/sdk` is a typed HTTP client with no native dependencies, safe in Node, Bun, and the browser. It wraps the daemon API so an application gets memory without speaking raw HTTP.

```typescript
import { HoneycombClient } from "@honeycomb/sdk";

const honeycomb = new HoneycombClient({
  daemonUrl: "http://localhost:3850",
  token: "Bearer hc_sk_...",   // for team / hybrid daemon modes
  actor: "agent-name",
  actorType: "llm",
});

await honeycomb.remember("prefers TypeScript", { importance: 0.9, tags: "language" });
const { results } = await honeycomb.recall("language preferences", { limit: 5 });
```

The client covers memory, the hook entry points, connectors and documents, sources, skills and goals, health and diagnostics, and the value-safe secrets surface. GET requests retry; mutating requests do not, because they are not idempotent. Errors are typed: an API error for non-2xx responses, a network error for transport failures, and a timeout error when a request exceeds the configured budget. React bindings, a Vercel AI SDK helper, and an OpenAI tool helper ship alongside the core client. Authenticated calls carry the same token and API-key model as the rest of the daemon, documented in [`../auth/auth-architecture.md`](../auth/auth-architecture.md).

## Choosing between them

Use MCP when the consumer is a harness that already speaks the protocol and you want memory tools to appear in its native tool list. Use the SDK when you are building an application, a worker, or a custom agent and want a typed client with explicit error handling. Use hooks for automatic capture and recall around the session lifecycle. All three end at the same daemon API, so the choice is about the calling environment, not about capability.
