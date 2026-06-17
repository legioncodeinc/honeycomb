# MCP and SDK

> Category: Integrations | Version: 1.0 | Date: June 2026 | Status: Active

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

The MCP server runs inside the daemon, reachable over streamable HTTP at `/mcp` or as a stdio subprocess. It is separate from hooks and can run alongside them. Every MCP tool handler calls the daemon's own API internally, stamping `x-honeycomb-runtime-path: plugin` plus actor headers, so MCP traffic is identified and scoped like any other plugin-path call.

The merged tool surface unions both source systems' tools and renames them under the `honeycomb_` prefix.

| Cluster | Tools |
|---|---|
| Memory | `memory_search`, `memory_store`, `memory_get`, `memory_list`, `memory_modify`, `memory_forget`, `memory_feedback` |
| Browse | `honeycomb_search`, `honeycomb_read`, `honeycomb_index` (virtual-filesystem style read-only recall) |
| Sessions | `session_search`, `session_bypass` |
| Goals and KPIs | `honeycomb_goal_add`, `honeycomb_kpi_add` |
| Codebase | `honeycomb_code_search`, `honeycomb_code_context`, `honeycomb_code_blast`, `honeycomb_code_impact` |
| Agent coordination | `agent_peers`, `agent_message_send`, `agent_message_inbox` |
| Secrets (value-safe) | `secret_list`, `secret_exec` |

`memory_search` is the hybrid recall described in [`../ai/retrieval.md`](../ai/retrieval.md). `memory_modify` and `memory_forget` require a reason because every mutation is audited. `session_search` queries session transcripts and can infer lineage from a child session key, which is how OpenClaw resolves a parent session. The `honeycomb_search`/`read`/`index` trio is the browse surface carried from Hivemind's MCP tools, backed by the virtual filesystem in [`../data/memory-virtual-filesystem.md`](../data/memory-virtual-filesystem.md). The secrets tools never expose values: `secret_list` returns names and `secret_exec` queues a command and returns redacted output, per [`../security/secrets.md`](../security/secrets.md).

The codebase tools are registered when the codebase graph is enabled for the workspace after `honeycomb graph build`, and surface the query endpoints documented in [`../data/codebase-graph.md`](../data/codebase-graph.md).

## The OpenClaw extension surface

OpenClaw gets a native extension on top of MCP. It registers the same memory and browse tools plus the goal and KPI tools as agent-callable commands, batches capture at `agent_end`, and supplements the agent's memory corpus on `before_agent_start`. The extension carries an env-harvesting workaround from the Hivemind build (tuning values are read from a global object rather than `process.env`); the build mechanics are in [`../infrastructure/monorepo-build-release.md`](../infrastructure/monorepo-build-release.md).

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
