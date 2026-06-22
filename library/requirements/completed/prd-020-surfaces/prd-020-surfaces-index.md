# PRD-020: Surfaces

> **Status:** Completed
> **Priority:** P1
> **Effort:** L
> **Schema changes:** None

---

## Overview

Surfaces are the operator-facing front of Honeycomb: the unified `@honeycomb/cli`, the daemon-served dashboard, the Cursor extension, and the notifications-plus-health guardrails. All of them are thin clients of the daemon (port 3850), which is the only DeepLake client. The CLI consolidates the hivemind product verbs and otherhive engine verbs into one dispatcher (setup, status, recall, agent, ontology, secret, skill, route, sources, graph, goal, org, workspace, sessions prune, update); the dashboard renders KPIs, sessions, settings, graph, and skill-sync state served by the daemon; the Cursor extension bundles the hook wiring plus a dashboard webview on top of the editor; and the notifications framework plus the D1-D5 environment health check catch silent failures before they cause data loss. This module makes Honeycomb usable and observable without anyone touching DeepLake directly.

## Goals

- One unified `honeycomb` CLI dispatcher covering the merged command surface, with every storage command routed through the daemon.
- A dashboard served by the daemon presenting KPIs, sessions, settings, graph, rules, and skill-sync state.
- A Cursor extension that bundles hook wiring and a dashboard surface with no-terminal login.
- A trigger-agnostic, fail-soft notifications framework plus a proactive D1-D5 environment health check with idempotent auto-wiring.

## Non-Goals

- The daemon's storage, tenancy, and memory engine internals (owned by other modules).
- The hook lifecycle contract and per-harness shims (covered by harness integrations).
- The MCP and SDK surfaces (covered by harness integrations).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-020a-surfaces-cli`](./prd-020a-surfaces-cli.md) | `@honeycomb/cli` unified command surface. | Draft |
| [`prd-020b-surfaces-dashboard`](./prd-020b-surfaces-dashboard.md) | Dashboard served by the daemon. | Draft |
| [`prd-020c-surfaces-cursor-extension`](./prd-020c-surfaces-cursor-extension.md) | Cursor extension: hooks bundle plus dashboard surface. | Draft |
| [`prd-020d-surfaces-notifications-health`](./prd-020d-surfaces-notifications-health.md) | Notifications framework plus environment health checks. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the unified CLI, when any storage-touching command runs (recall, sessions prune, graph, etc.), then it issues a daemon request and never opens DeepLake directly. |
| AC-2 | Given the daemon is running, when a user opens the dashboard, then it renders KPIs, sessions, settings, graph, and skill-sync state served by the daemon. |
| AC-3 | Given a missing prerequisite (daemon down, logged out, hooks unwired), when the health check runs, then the failing dimension (D1-D5) is surfaced and auto-wiring resolves the wirable ones idempotently. |

## Data model changes

None. Surfaces read and write through the daemon's existing endpoints.

## API changes

Additive daemon endpoints to serve dashboard data and notification/health state. No breaking changes; CLI org/workspace verbs pass through to the existing auth dispatcher.

## Open questions

- [ ] Is the dashboard a webview, a TUI, or both, and where is the canonical implementation?
- [ ] Should notifications collapse all sources (rules, queue, backend) under one priority model now or later?
- [ ] How much of the health check generalizes beyond Cursor's `cursor-agent` dimensions to other harnesses?

## Related

- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [Cursor Extension Architecture](../../../knowledge/private/frontend/cursor-extension-architecture.md)
- [Notifications and Environment Health](../../../knowledge/private/operations/notifications-and-health.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
