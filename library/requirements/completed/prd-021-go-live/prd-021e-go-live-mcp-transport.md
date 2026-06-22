# PRD-021e: MCP Transport Bind

> **Parent:** [PRD-021](./prd-021-go-live-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Binding the MCP server's transports so the `mcp/bundle/server.js` answers a real `initialize` handshake, binding the real `DaemonApiSeam` over loopback, and registering the MCP server in at least one MCP-speaking harness. The MCP server imports clean but does not serve: smoke proves it loads, not that it answers. This sub-PRD owns calling `connect()` on the transports, binding the daemon API seam, and getting the unified `honeycomb_` tool surface to appear in a harness's native tool list. It does not own the composition root (021a), the CLI (021b), the hook runtime (021c), or the dashboard (021d).

## Goals

- The McpServer transports actually connected (`bindAllTransports`): streamable HTTP at `/mcp` plus stdio.
- The `mcp/bundle/server.js` answering a real `initialize` handshake.
- The real `DaemonApiSeam` bound over loopback fetch, so every MCP tool routes through the daemon API.
- The MCP server registered in at least one MCP-speaking harness, so the unified `honeycomb_` tool surface appears in its native tool list.

## Non-Goals

- The MCP tool contract, schemas, or handler logic. PRD-019d owns the tool surface; this binds its transport.
- The composition root and the daemon API the seam calls (021a).
- The CLI, hook runtime, and dashboard surfaces (021b, 021c, 021d).
- Registering the MCP server in every harness. One MCP-speaking harness is the bar for this PRD; others fast-follow.

## User stories

- As a developer in an MCP-speaking harness, I want the `honeycomb_` tools to appear in my native tool list so that I can search and read memory without leaving the assistant.
- As a developer, I want the MCP server to answer a real `initialize` handshake so that the harness considers it a live server, not a dead import.
- As a maintainer, I want every MCP tool to route through the daemon API so that the thin-client invariant holds and the MCP surface never opens DeepLake.

## Functional requirements

- FR-1: The MCP server's transports are connected via `bindAllTransports`: the streamable-HTTP transport is served at `/mcp` and the stdio transport is connected, replacing the import-only-no-serve state.
- FR-2: The `mcp/bundle/server.js` answers a real `initialize` handshake over both transports, so a connecting harness negotiates capabilities and receives the tool list.
- FR-3: The real `DaemonApiSeam` is bound over loopback fetch, so every MCP tool handler routes through the daemon API at `127.0.0.1:3850` and never opens DeepLake directly.
- FR-4: The MCP server is registered in at least one MCP-speaking harness, so the unified `honeycomb_` tool surface appears in that harness's native tool list.
- FR-5: The binding preserves the 019d tool contract unchanged: this sub-PRD connects transports and binds the seam, and does not alter tool names, schemas, or handler semantics.
- FR-6: A smoke check confirms the served handshake, not just a clean import: it connects to the running server and verifies the `initialize` response and the presence of the `honeycomb_` tools.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the MCP server, when `bindAllTransports` runs, then the streamable-HTTP transport is served at `/mcp` and the stdio transport is connected. |
| AC-2 | Given a connecting client, when it speaks to `mcp/bundle/server.js`, then the server answers a real `initialize` handshake and returns the tool list. |
| AC-3 | Given any MCP tool, when its handler runs, then it routes through the bound `DaemonApiSeam` over loopback and never opens DeepLake directly. |
| AC-4 | Given an MCP-speaking harness with the server registered, when its tool list loads, then the unified `honeycomb_` tools appear in it. |
| AC-5 | Given the 019d tool contract, when transports are bound, then tool names, schemas, and handler semantics are unchanged. |
| AC-6 | Given a smoke check, when it connects to the running server, then it verifies the served `initialize` response and the presence of the `honeycomb_` tools, not merely a clean import. |

## Implementation notes

- The gap is serve-versus-import: the server bundle imports clean today (proven by smoke), but no code calls `connect()` on the transports, so no harness gets a live server. `bindAllTransports` is the one call that flips it.
- Binding the `DaemonApiSeam` over loopback keeps the MCP surface a thin client: tools fetch the daemon at `127.0.0.1:3850`, the same loopback the CLI and hooks use, so the composition root remains the only storage owner.
- One MCP-speaking harness is the acceptance bar; honest deferral of the rest is allowed, consistent with the index decision on the long tail. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-019d MCP server and the unified `honeycomb_` tool surface.
- PRD-021a composition root and the daemon API the `DaemonApiSeam` calls over loopback.
- PRD-019a connector base for registering the MCP server in the chosen harness.

## Open questions

- [ ] Which MCP-speaking harness is the first registration target for this PRD's acceptance?
- [ ] Should the streamable-HTTP transport at `/mcp` be served by the same daemon process or a separate MCP process?
- [ ] How is MCP-server registration surfaced in `honeycomb setup` versus a dedicated step?

## Related

- [parent index](./prd-021-go-live-index.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
