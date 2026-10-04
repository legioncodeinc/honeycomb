# ADR-0012, MCP is a spawned stdio child; the daemon `/mcp` group stays a scaffold

> **Status:** Accepted | **Date:** 2026-10-04
> **Supersedes:** none | **Superseded by:** none
> **Owners:** mcp, daemon, integrations | **Related:** PRD-019d, PRD-021e

## Context

Harness MCP clients register a command and spawn it. The channel they speak is that process's
stdio. Hermes registers `node mcp/bundle/server.js` (`harnesses/hermes/.mcp.json`). The Claude
Code plugin registers the same bundle under `${CLAUDE_PLUGIN_ROOT}`
(`harnesses/claude-code/.mcp.json`). A child that also opened a listening port would bind an
address the harness never dials.

The lock is `c3b587db0dd84cc2891da6f7bc763d1b972001f1` (2026-06-20), the go-live assembly that
makes `mcp/bundle/server.js` answer `initialize` over stdio. `serveHttp` defaults to false
(`mcp/src/index.ts`). The bundle entry calls `startMcpServer()` with no HTTP options, so the
production process connects stdio and stands up no listener. `serveHttp: true` is the opt-in,
and that listener binds loopback only (`mcp/src/transports.ts`). The go-live security note
records the same posture: a harness-spawned bundle runs stdio only, with no network listener.

The daemon still lists `/mcp` as a protected, session-scoped route group
(`src/daemon/runtime/server.ts`). No module in `src/daemon` attaches a handler to that group,
and no daemon caller starts the MCP server. A request to a known group with no handler falls
through to the root scaffold and returns 501 (`not_implemented`).

Two requirements still describe an older shape. PRD-019d places the server inside the daemon,
reachable at `/mcp` and on stdio. PRD-021e requires both transports connected, and its process
question is still unchecked: the same daemon process, or a separate MCP process. Knowledge that
says the server binds both stdio and streamable HTTP describes the construction seam
(`createMcpServer` builds both transports). The live entry connects stdio. This ADR answers
that open process question.

The thin-client rule is already recorded in PRD-021e and the MCP knowledge page: the server
calls the daemon API and does not open DeepLake. This record is the transport and process
choice.

## Decision drivers

- Harness clients spawn a command. The registration shape is stdio.
- A listening child binds a port the harness does not use.
- Go-live locked the bundle as stdio-only unless `serveHttp` is set, and a set flag binds loopback.
- The daemon `/mcp` group was scaffolded in the PRD-004 runtime and never received a handler.

## Decision

1. A harness speaks MCP by spawning `node mcp/bundle/server.js` (or the plugin-local copy of
   that bundle). That process answers `initialize` over stdio.

2. Streamable HTTP on the MCP process is opt-in. `serveHttp` defaults to false. When it is
   true, the listener binds `127.0.0.1` only.

3. The daemon `/mcp` group stays a protected, session-scoped scaffold. With no handler
   attached, requests return 501. The daemon process does not start the MCP server.

4. PRD-021e's open process question is closed here: a separate MCP process, spawned by the
   harness. PRD-019 stays in-work. Other criteria in that folder remain unmet, so this record
   is not a reason to mark that folder completed.

## Consequences

**Positive**

- Harness registration matches the client model: spawn a command, speak stdio.
- The default bundle has no network listener.
- The tool server starts and stops with the harness, separate from the daemon's loopback API.

**Negative / accepted**

- A client that calls the daemon's `/mcp` prefix receives 501. The group remains in the route
  table so permission and runtime-path middleware stay mounted for a later handler.
- PRD-019d and PRD-021e still describe an in-daemon server and both transports as the connected
  default. Those sentences are stale relative to this decision. The unchecked process question
  in PRD-021e is answered here; the PRD text is left for the requirements librarian.
- `serveHttp: true` remains available for a loopback listener on the MCP process. Harness
  registration uses the stdio entry.

## Revisit triggers

Re-open this decision if either of these becomes true:

1. A harness needs streamable HTTP on the daemon, so the spawned stdio child no longer covers
   that client.
2. The MCP server must share the daemon process, and a handler replaces the `/mcp` 501 scaffold.

## Links

- PRD-019d: `library/requirements/in-work/prd-019-harness-integrations/prd-019d-harness-integrations-mcp-server.md`
- PRD-021e: `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md` (open process question, still unchecked in that file)
- Go-live security note: `library/requirements/completed/prd-021-go-live/reports/2026-06-19-security-report.md`
- Lock: `c3b587db0dd84cc2891da6f7bc763d1b972001f1` (2026-06-20)
