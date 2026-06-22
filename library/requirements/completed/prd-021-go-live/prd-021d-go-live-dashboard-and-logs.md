# PRD-021d: Dashboard and Logs (the part the operator sees)

> **Parent:** [PRD-021](./prd-021-go-live-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The operator-visible surface: real KPIs and sessions served from live DeepLake, a viewable dashboard host, and a live capture-event log that streams as the AI works. The dashboard data contract and views exist (020b), but nothing serves them from real storage or hosts them viewably, and the request-logger ring buffer has no reader. This sub-PRD owns making `mountDashboardApi` serve real data, attaching the `/api/logs` handler, choosing and standing up the dashboard host, and adding the live log surface (`honeycomb logs --follow` and a dashboard live-log panel). It does not own the composition root that mounts these (021a), the CLI `dashboard` and `logs` verbs that open them (021b), the hook runtime that produces the events (021c), or the MCP surface (021e).

## Goals

- `mountDashboardApi` serving real KPIs, sessions, settings, graph, rules, and skill-sync from the live DeepLake storage.
- The `/api/logs` handler attached, reading the request-logger ring buffer (`src/daemon/runtime/logger.ts`).
- A real, viewable dashboard host that the daemon serves as a surface, reusing the canonical 020b view layer.
- A live log surface streaming capture events as the AI works (`honeycomb logs --follow` and a dashboard live-log panel).
- Connectivity and empty states reused from 020b so the operator never sees a silent blank.

## Non-Goals

- The composition root that calls `mountDashboardApi` and attaches `/api/logs` (021a).
- The CLI `dashboard` and `logs` verbs (021b), though this defines what they open.
- The capture pipeline that writes the events the log streams (021c).
- The MCP transport (021e).
- The 020b view component implementation, which this serves real data into rather than rewrites.

## User stories

- As an operator, I want the dashboard to show my real sessions and KPIs so that I can see memory working without writing a query.
- As an operator, I want to open the dashboard as an actual page so that "the dashboard" is something I can look at, not just a data contract.
- As an operator, I want a live log of capture events so that I can watch the AI interact and confirm turns are being captured in real time.
- As an operator, I want a clear connectivity state when the daemon is down so that I know an empty dashboard means connectivity, not absence of data.

## Functional requirements

- FR-1: `mountDashboardApi` serves real KPIs, sessions, settings, graph, rules, and skill-sync from the live DeepLake storage passed in by the composition root, replacing any placeholder data source.
- FR-2: The `/api/logs` handler is attached, reading the request-logger ring buffer (`src/daemon/runtime/logger.ts`), so log events are queryable and streamable from the daemon.
- FR-3: The daemon serves a real, viewable dashboard host: it renders the canonical 020b view layer as a viewable surface, served at `/` or `/dashboard`.
- FR-4: The host reuses the 020b view-tree to HTML serializer (`renderDashboardHtml`), which is renderer-agnostic, so a daemon-served HTML page and a TUI are both cheap to stand up from the same views.
- FR-5: `honeycomb dashboard` opens the served dashboard host.
- FR-6: A live log surface streams capture events as the AI works, exposed as `honeycomb logs --follow` and a dashboard live-log panel, both reading the `/api/logs` ring-buffer stream.
- FR-7: Connectivity and empty states reuse 020b: when the daemon is unreachable the surface shows a clear connectivity banner, and an unbuilt graph or an empty session list shows the 020b empty-state prompt rather than an error or a blank panel.
- FR-8: All dashboard and log reads go through daemon endpoints only; the dashboard and log surfaces never open DeepLake directly.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a running daemon against live DeepLake, when the dashboard loads, then `mountDashboardApi` serves real KPIs, sessions, settings, graph, rules, and skill-sync. |
| AC-2 | Given the daemon, when it is assembled, then the `/api/logs` handler reads the request-logger ring buffer and exposes log events. |
| AC-3 | Given `honeycomb dashboard`, when it runs, then it opens a real viewable dashboard host rendering the canonical 020b views. |
| AC-4 | Given a live coding session, when `honeycomb logs --follow` or the dashboard live-log panel is open, then capture events stream as the AI works. |
| AC-5 | Given the daemon is unreachable, when the dashboard opens, then it surfaces the 020b connectivity state rather than a silent blank. |
| AC-6 | Given no graph has been built or no sessions exist, when those views open, then they show the 020b empty-state prompt rather than an error. |

## Implementation notes

- The dashboard is a daemon-served surface: it reads through daemon endpoints and never opens DeepLake, so serving real data is a matter of pointing `mountDashboardApi` at the live storage client the composition root constructs.
- `renderDashboardHtml` already serializes the 020b view tree and is renderer-agnostic, so the daemon-served HTML page and an eventual TUI share one view layer; the host choice is the open question, not the view code.
- The live log is the "watch the AI interact" requirement: it streams the same capture events the 021c hook runtime produces, read from the `logger.ts` ring buffer, so the operator sees turns land in real time. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-021a composition root that calls `mountDashboardApi` and attaches `/api/logs`.
- PRD-020b dashboard views, the data contract, the connectivity and empty states, and `renderDashboardHtml`.
- PRD-021b CLI `dashboard` and `logs` verbs that open these surfaces.
- PRD-021c hook runtime, whose capture events the live log streams.
- The request-logger ring buffer (`src/daemon/runtime/logger.ts`).

## Open questions

- [ ] Dashboard host: a daemon-served local HTML page versus a TUI versus an editor webview (carries the 020b open question forward).
- [ ] Should the live log stream via server-sent events, a polling endpoint, or a websocket, given the ring-buffer source?
- [ ] How much history should the ring buffer retain, and should `logs --follow` backfill recent events on attach?

## Related

- [parent index](./prd-021-go-live-index.md)
- [Cursor Extension Architecture](../../../knowledge/private/frontend/cursor-extension-architecture.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
