# PRD-019d: MCP Server and Tool Surface

> **Parent:** [PRD-019](./prd-019-harness-integrations-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

The MCP server running inside the daemon, reachable over streamable HTTP at `/mcp` or as a stdio subprocess, exposing the unified `honeycomb_` tool surface across memory, browse, sessions, goals/KPIs, codebase, agent coordination, and value-safe secrets. This sub-PRD owns the MCP transport, the tool registration and argument schemas, the runtime-path and actor stamping, and the conditional registration of codebase and secrets tools. It does not own the hook lifecycle (019b) or the typed SDK (019e).

## Goals

- An MCP server inside the daemon that exposes the unified `honeycomb_` tool surface in any MCP-speaking harness's native tool list.
- Every tool handler routed through the daemon's own API, stamping `x-honeycomb-runtime-path: plugin` plus actor headers, so MCP traffic is scoped like any other plugin-path call.
- A merged tool surface that unions both source systems' tools under one prefix, covering memory, browse, sessions, goals/KPIs, codebase, agent coordination, and value-safe secrets.
- Audit and value-safety guarantees: mutating memory tools require a reason and secrets tools never expose values.

## Non-Goals

- The hook lifecycle contract and per-harness shims (019b, 019c).
- The typed SDK and framework helpers (019e).
- Daemon storage, retrieval ranking, and DeepLake access (owned by the daemon and engine modules).
- The OpenClaw native extension's non-MCP capture batching (019c), though it registers the same tools.

## User stories

- As an agent in an MCP-speaking harness, I want memory tools in my native tool list so that I can ask for recall and store explicitly.
- As a security reviewer, I want secrets tools to never return values so that the MCP surface cannot exfiltrate credentials.
- As an operator, I want every MCP call identified as plugin-path traffic so that scoping and audit are uniform.

## Functional requirements

- FR-1: The MCP server runs inside the daemon and is reachable over streamable HTTP at `/mcp` and as a stdio subprocess; it can run alongside hooks and is a thin client of the daemon.
- FR-2: Every tool handler calls the daemon's own API internally, stamping `x-honeycomb-runtime-path: plugin` plus actor headers (actor and actor type) so MCP traffic is scoped, identified, and audited like any other plugin-path call.
- FR-3: The Memory cluster registers `memory_search`, `memory_store`, `memory_get`, `memory_list`, `memory_modify`, `memory_forget`, `memory_feedback`; `memory_search` is the hybrid lexical-plus-semantic recall.
- FR-4: The Browse cluster registers `honeycomb_search`, `honeycomb_read`, `honeycomb_index` as virtual-filesystem-style read-only recall backed by the memory virtual filesystem.
- FR-5: The Sessions cluster registers `session_search` (queries transcripts and can infer lineage from a child session key, which is how OpenClaw resolves a parent session) and `session_bypass`.
- FR-6: The Goals and KPIs cluster registers `honeycomb_goal_add` and `honeycomb_kpi_add`; the Agent coordination cluster registers `agent_peers`, `agent_message_send`, `agent_message_inbox`.
- FR-7: The Codebase cluster registers `honeycomb_code_search`, `honeycomb_code_context`, `honeycomb_code_blast`, `honeycomb_code_impact`, and is registered only when the codebase graph is enabled for the workspace after `honeycomb graph build`.
- FR-8: The Secrets cluster is value-safe: `secret_list` returns names only and `secret_exec` queues a command and returns redacted output; no tool ever returns a secret value.
- FR-9: `memory_modify` and `memory_forget` require a reason argument because every mutation is audited; the handler rejects calls without one.
- FR-10: Each tool publishes an argument schema (names, types, required fields) so the harness renders correct tool signatures, and unknown or extra arguments are rejected rather than silently passed to the daemon.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the MCP server is running, when a harness lists tools, then the unified `honeycomb_` surface appears and each handler stamps `x-honeycomb-runtime-path: plugin` plus actor headers. |
| AC-2 | Given a secrets tool is called, when it returns, then values are never exposed: `secret_list` returns names and `secret_exec` returns redacted output. |
| AC-3 | Given `memory_modify` or `memory_forget` is called without a reason, when the handler runs, then the call is rejected. |
| AC-4 | Given the workspace graph is not built, when a harness lists tools, then the codebase cluster is absent; after `honeycomb graph build`, the codebase tools appear. |
| AC-5 | Given a child session key, when `session_search` runs, then it can infer the parent session lineage. |
| AC-6 | Given the daemon is reachable, when the same tool is called over streamable HTTP and over stdio, then both route through the daemon API and return equivalent results. |

## Implementation notes

- The merged tool surface unions both source systems' tools and renames them under the `honeycomb_` prefix; the browse trio is carried from Hivemind's MCP tools, backed by the virtual filesystem.
- The MCP server is separate from hooks and never opens DeepLake; it is one more thin client of the daemon API.
- Secrets value-safety follows the secrets module: names and redacted output only, never raw values.

## Dependencies

- Daemon API endpoints for memory, browse, sessions, goals/KPIs, codebase, agent coordination, and secrets.
- PRD-019c OpenClaw extension, which registers the same memory, browse, goal, and KPI tools as agent-callable commands.
- Codebase graph module and `honeycomb graph build` (PRD-020a) for conditional codebase-tool registration.
- Secrets module for the value-safe surface.

## Open questions

- [ ] Should agent-coordination tools be gated behind a workspace setting or always on?
- [ ] How are per-tool rate limits surfaced to the harness when the daemon throttles?

## Related

- [parent index](./prd-019-harness-integrations-index.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
