# PRD-020b: Daemon-Served Dashboard

> **Parent:** [PRD-020](./prd-020-surfaces-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The dashboard served by the daemon, presenting KPIs, sessions, settings, the codebase graph, rules, and skill-sync state, opened via `honeycomb dashboard`. This sub-PRD owns the dashboard views, the daemon-served data contract behind them, and the connectivity-state handling. It is the canonical view layer the Cursor extension webview (020c) embeds. It does not own the extension shell (020c), the CLI dispatcher (020a), or the daemon's storage internals.

## Goals

- A dashboard served by the daemon that renders KPIs, sessions, settings, the codebase graph, rules, and skill-sync state without anyone writing queries.
- A single canonical view layer shared with the Cursor extension webview so both surfaces show the same data.
- A clear connectivity state when the daemon is unreachable, never failing silently or hanging.
- A read path that goes only through daemon endpoints, never opening DeepLake.

## Non-Goals

- The Cursor extension shell, status bar, and hook wiring (020c).
- The CLI dispatcher (020a), though `honeycomb dashboard` launches this surface.
- Notifications and the D1-D5 health check internals (020d), though the dashboard may display their state.
- Daemon storage, tenancy, and memory engine internals.

## User stories

- As an operator, I want a dashboard so that I can see memory KPIs, sessions, and skill-sync state without writing queries.
- As an operator, I want a clear message when the daemon is down so that I know the dashboard is empty because of connectivity, not because there is no data.
- As a team lead, I want the rules and skill-sync views so that I can confirm org rules and shared skills are propagating.

## Functional requirements

- FR-1: `honeycomb dashboard` launches the daemon-served dashboard surface and points it at the daemon on port 3850.
- FR-2: The dashboard renders a KPIs view (memory volume, savings, session counts, and other org-level metrics) from daemon-served data.
- FR-3: The dashboard renders a sessions view listing captured sessions with metadata (project, dates, event counts, status), served by the daemon.
- FR-4: The dashboard renders a settings view for the active org and workspace configuration exposed by the daemon.
- FR-5: The dashboard renders a codebase graph view (graph canvas) for the active workspace when a graph has been built, served by the daemon's graph endpoints.
- FR-6: The dashboard renders a rules view listing the org-wide rules from the `honeycomb_rules` table and a skill-sync view showing pulled and shared team skills.
- FR-7: All views read through daemon endpoints only; the dashboard never opens DeepLake and holds no storage logic.
- FR-8: When the daemon is unreachable, the dashboard surfaces a clear connectivity state (for example a banner with the daemon URL and a retry affordance) rather than hanging or showing blank panels.
- FR-9: The dashboard view components are the canonical implementation the Cursor extension webview embeds, so both surfaces share KPI, session, settings, graph, rules, and skill-sync rendering.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the daemon is running, when the dashboard loads, then it renders KPIs, sessions, settings, graph, rules, and skill-sync state from daemon-served data. |
| AC-2 | Given the daemon is unreachable, when the dashboard opens, then it surfaces a clear connectivity state rather than failing silently or hanging. |
| AC-3 | Given a workspace with a built codebase graph, when the graph view opens, then the graph canvas renders from the daemon's graph endpoints. |
| AC-4 | Given org-wide rules exist, when the rules view opens, then it lists the active rules from the daemon. |
| AC-5 | Given the Cursor extension webview, when it embeds the dashboard, then it renders the same views from the same daemon data contract. |
| AC-6 | Given no graph has been built, when the graph view opens, then it shows an empty-state prompt to run `honeycomb graph build` rather than an error. |

## Implementation notes

- The dashboard is a daemon-served surface; it reads through daemon endpoints and never opens DeepLake. It shares the KPI, session, settings, graph, rules, and skill-sync views the Cursor extension webview embeds.
- The connectivity state reuses the same daemon-reachability probe the D1/D2 health dimensions use (020d) so the message is consistent across surfaces.
- The canonical implementation home (webview bundle versus TUI) is shared with the CLI `dashboard` verb and the Cursor extension to avoid duplicate view code.

## Dependencies

- Daemon endpoints for KPIs, sessions, settings, graph, rules, and skill-sync state.
- PRD-020a `honeycomb dashboard` launch verb.
- PRD-020c Cursor extension webview, which embeds these views.
- Codebase graph module for the graph canvas data.

## Open questions

- [ ] Is the dashboard a webview, a TUI, or both, and where is the canonical implementation home?
- [ ] Should KPI refresh be polling, on-open only, or a daemon push?

## Related

- [parent index](./prd-020-surfaces-index.md)
- [Cursor Extension Architecture](../../../knowledge/private/frontend/cursor-extension-architecture.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
