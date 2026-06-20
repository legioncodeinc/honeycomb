# PRD-021: Go-Live: Runtime Assembly and Dogfood

> **Status:** Backlog
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** None

---

## Overview

PRDs 001-020 were each shipped "constructed-and-tested behind seams, with runtime assembly deferred and documented." Every prior PRD left a CONVENTIONS note saying "the production assembly calls this once." PRD-021 is the milestone that burns down that deferred-assembly debt: it writes the composition root, wires the bundled bin and the per-harness hooks to the real handlers, binds the MCP transport, serves a live dashboard plus log, and proves the whole system end-to-end by dogfooding it into a real coding session. It adds no new business logic and no new DeepLake schema. It is pure wiring of existing, individually-tested seams, plus the first true end-to-end run. The acceptance bar is behavioral: a real AI coding turn is captured to DeepLake and recalled in a later session, watched live.

Concretely, the daemon has never been assembled for real. `createDaemon` ships with three no-op services (`JobQueueService`, `FileWatcherService`, `RuntimePathService`), the four mount and attach seams (`attachHooksHandlers`, `mountDashboardApi`, `mountNotificationsApi`, `attachSessionsPrune`) have unit-tested call signatures but no caller that fires them exactly once after construction, the CLI dispatcher (020a) runs but its handler seams are "not wired in this build," the per-harness binary entry points are stubs, the MCP server imports clean but does not `connect()` its transports, and only one of the three hook endpoints (`/api/hooks/capture`) is attached. PRD-021 is the single place where all of these seams meet their real implementations and the system runs for the first time against live DeepLake.

## Goals

- A composition root (`assembleDaemon()`) that constructs the live storage client, builds `createDaemon`, fires every mount and attach seam exactly once, replaces the three no-op services with their real implementations, binds the socket, and shuts down gracefully.
- A bundled CLI (`bundle/cli.js`) whose storage verbs, setup/connect/uninstall, status, dashboard, and daemon lifecycle verbs all reach real handlers and a real loopback daemon.
- A production hook runtime: real `DaemonHookClient`, `CredentialReader`, and `ContextRenderer`, the per-harness binaries wired through the 019c shim and 019b core, and all three hook endpoints attached, with Claude Code as the first fully-wired reference harness.
- A dashboard and live log the operator can actually see: real KPIs and sessions served from live DeepLake, a viewable dashboard host, and a live capture-event log that streams as the AI works.
- A bound MCP transport so the `mcp/bundle/server.js` answers a real `initialize` handshake and the unified `honeycomb_` tool surface appears in at least one harness.
- A behavioral end-to-end proof: a real coding turn captured to DeepLake, summarized, and recalled in a later session, watched live, on at least one harness.

## Non-Goals

- Any new business logic. PRD-021 wires existing, individually-tested seams and adds none of its own.
- Any new DeepLake schema, table, column, or index. Schema changes: None.
- The team-mode `x-honeycomb-org` hardening follow-up. Local single-user mode is the first-class dogfood target; team and hybrid stay behind the existing auth and ship as a separate ticket.
- Fully wiring every one of the long tail of harnesses. Claude Code is the reference; the others fast-follow. The end-to-end proof on at least one harness is non-negotiable for this PRD to be "done."
- Weakening the thin-client invariant anywhere except the daemon composition root, which legitimately owns storage.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-021a-go-live-daemon-assembly`](./prd-021a-go-live-daemon-assembly.md) | The composition root: construct, mount-once, real services, bind, shutdown. | Draft |
| [`prd-021b-go-live-cli-runtime`](./prd-021b-go-live-cli-runtime.md) | Bin dispatch bound to real handlers plus daemon lifecycle verbs. | Draft |
| [`prd-021c-go-live-hook-runtime`](./prd-021c-go-live-hook-runtime.md) | Real hook client, per-harness binary wiring, all three endpoints, reference harness. | Draft |
| [`prd-021d-go-live-dashboard-and-logs`](./prd-021d-go-live-dashboard-and-logs.md) | Live KPIs and sessions, a viewable dashboard host, a streaming log surface. | Draft |
| [`prd-021e-go-live-mcp-transport`](./prd-021e-go-live-mcp-transport.md) | Bind the MCP transports and register the server in one harness. | Draft |
| [`prd-021f-go-live-dogfood-acceptance`](./prd-021f-go-live-dogfood-acceptance.md) | The behavioral proof: capture, summarize, cross-session recall, receipts. | Draft |

## Decisions

- Wiring-only. This PRD introduces no new business logic and no new DeepLake schema. It closes the 004-020 deferred-assembly debt: each prior PRD's CONVENTIONS note that "the production assembly calls this once" is exactly the backlog this burns down.
- The thin-client invariant is preserved everywhere except the daemon composition root. The composition root is the one place allowed to import `daemon/storage` (it lives inside `src/daemon/`); the bin, hooks, MCP, and SDK stay thin clients of the loopback daemon.
- Local single-user mode is the first-class dogfood target. It sidesteps the open team-mode `x-honeycomb-org` hardening follow-up, which stays a separate ticket. Team and hybrid run behind the existing auth.
- First-run-is-the-first-real-run is a known risk. The live, composition, and conformance test rungs already found several integration bugs, and assembling for real will find more. The mitigation is a scripted golden-path smoke plus structured logging, and discovered bugs route through security then quality before close-out.
- Honest deferral remains allowed for the long tail of harnesses. Claude Code is wired first as the reference; the others fast-follow. The end-to-end proof on at least one harness is mandatory for "done."

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `honeycomb setup <harness>` plus a daemon start, when they run, then a daemon serves `/health` 200 against live DeepLake and the harness's hooks fire, with no fakes and no stubs. |
| AC-2 | Given a real coding session, when turns are captured and the session ends, then they persist to DeepLake and produce a summary, and a later session's recall surfaces that prior context end-to-end. |
| AC-3 | Given `honeycomb dashboard`, when it opens against a running daemon, then it renders the live session and KPIs from real daemon data and a live log shows capture events streaming as the AI works. |

## Data model changes

None. The composition root constructs the existing storage client and fires existing seams. No table, column, or index is added or altered. The `/health` probe reads the existing storage client; it does not introduce schema.

## API changes

None that are new. PRD-021 attaches the already-specified daemon endpoints that were built but never mounted: `/api/hooks/context` and `/api/hooks/session-end` (alongside the already-attached `/api/hooks/capture`), the dashboard data endpoints, the notifications endpoints, the sessions-prune endpoint, the `/api/logs` ring-buffer reader, and the MCP transports (streamable HTTP at `/mcp` plus stdio). No endpoint contract changes; this is the wiring that makes them reachable.

## Open questions

- [ ] Dashboard host: a daemon-served local HTML page versus a TUI versus an editor webview (carries the 020b open question forward).
- [ ] Daemon process model: foreground versus backgrounded, auto-start-on-hook, PID and lock file, and port-conflict handling on 3850.
- [ ] Which harnesses are in scope for this PRD's acceptance versus fast-follow.
- [ ] Demo and receipts packaging: recording format and redaction of credentials and captured trace content.

## Related

- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [Notifications and Environment Health](../../../knowledge/private/operations/notifications-and-health.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Cursor Extension Architecture](../../../knowledge/private/frontend/cursor-extension-architecture.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
