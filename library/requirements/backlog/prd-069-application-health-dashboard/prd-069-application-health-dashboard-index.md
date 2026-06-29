# PRD-069: Application Health Dashboard

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None. Adds local read-only health aggregation surfaces; no DeepLake schema changes.

---

## Overview

Honeycomb already has multiple health signals: primary `/health`, protected diagnostics health, setup warmup, HiveDoctor state, needs-attention files, update status, service-manager state, and CLI daemon status. Today those signals are split across CLI output, the primary dashboard, the minimal HiveDoctor status page, and telemetry. This PRD creates a browser-accessible application health dashboard that is available from Chrome even when the primary daemon is down, while also surfacing the same health information inside the regular dashboard when the primary is up.

This is the third PRD in the boot-experience sequence. PRD-067 prevents false remediation during boot. PRD-068 provides the always-fast portal shell. This PRD turns the portal into an operational health surface.

---

## Goals

- Provide one local browser page that answers "Is Honeycomb healthy? If not, which layer is failing?"
- Keep the page available from a service that is much harder to crash than the primary daemon.
- Aggregate health from HiveDoctor, primary daemon, embeddings, storage, service supervision, update state, setup/auth state, and known escalation records.
- Mirror the health dashboard inside the regular primary dashboard when `3850` is healthy.
- Keep the health dashboard read-only in v1.
- Preserve privacy: no tokens, no credential values, no raw org secrets, no DeepLake data payloads.

## Non-Goals

- A hosted fleet control plane.
- Remote commands or remote repair.
- Replacing PostHog telemetry or local incident logs.
- Building a full settings page for telemetry/auto-update toggles.
- Showing user memories, documents, skills, or private graph contents.
- Adding admin-only team health views.

---

## Code-grounded current state

| Signal | Current code source | Gap |
|---|---|---|
| Primary liveness | `src/daemon/runtime/server.ts` serves unprotected `/health` with coarse status and optional local reasons. | Visible only once primary is answering. |
| Full subsystem reasons | `src/daemon/runtime/diagnostics-health.ts` serves `/api/diagnostics/health` through the protected diagnostics group. | Not available when primary is down; not collected into a single health page. |
| Embeddings warmup | `src/daemon/runtime/dashboard/setup-state.ts` exposes `warmup: { enabled, live, warm }`. | Useful for boot UX but currently tied to primary daemon availability. |
| Dashboard connectivity | `src/dashboard/contracts.ts` has explicit `reachable` vs `unreachable` connectivity state. | The regular dashboard can show down state, but only after its host exists. |
| Regular dashboard host | `src/daemon/runtime/dashboard/host.ts` serves `/dashboard` from the primary daemon. | The host is unavailable when primary is down. |
| HiveDoctor health | `hivedoctor/src/state.ts` stores `lastKnownHealth`, backoff, failures, and last heal. | The minimal status page does not present an operator-grade timeline or layered health view. |
| HiveDoctor status page | `hivedoctor/src/status-page/server.ts` serves `/` and `/status.json` with health, escalation, suggested commands. | Too minimal for product launch; does not aggregate primary, service, update, and warmup signals. |
| HiveDoctor compose | `hivedoctor/src/compose/index.ts` wires status page, supervisor, update poll loop, install-health telemetry, needs-attention store. | All the raw ingredients exist in separate seams, but no single health model is exported. |
| Daemon service state | `src/cli/runtime.ts` and `src/commands/daemon.ts` expose service manager and PID/lock status through the lifecycle seam. | CLI-only today; browser health needs equivalent read-only state. |

---

## Health model

The dashboard should present a layered model, not one ambiguous red/green dot:

| Layer | Status values | Source |
|---|---|---|
| Portal | `ok`, `degraded` | Portal/HiveDoctor process self state. |
| HiveDoctor | `watching`, `booting`, `healing`, `needs_attention`, `disabled`, `unknown` | Supervisor state, state file, needs-attention store. |
| Primary daemon | `booting`, `ok`, `degraded`, `unreachable`, `still_starting`, `unknown` | `/health`, PID/lock, service manager state. |
| Service manager | `registered`, `running`, `not_registered`, `unavailable`, `unknown` | Existing lifecycle/service-manager seams. |
| Storage | `reachable`, `unreachable`, `not_checked`, `unknown` | Primary health reasons and cached health bit. |
| Embeddings | `disabled`, `starting`, `live`, `warm`, `unavailable`, `unknown` | Setup warmup and health reasons. |
| Schema | `ok`, `missing_table`, `unknown` | Primary health reasons. |
| Updates | `current`, `update_available`, `updating`, `failed`, `pinned`, `disabled`, `unknown` | HiveDoctor update state/poll loop, state file. |
| Telemetry | `enabled`, `disabled`, `unknown` | Opt-out resolution; do not test egress live from the dashboard. |

The visual hierarchy must answer:

1. Is the app usable?
2. Is the primary daemon booting or dead?
3. Is the watchdog actively healing?
4. What should the user do next?

---

## Browser surfaces

### Portal health page

Primary URL: `http://127.0.0.1:3852/health`

Requirements:

- Served by the portal/HiveDoctor process, not by the primary daemon.
- Read-only.
- Loopback only.
- Polls a same-origin JSON endpoint, for example `/health/status.json`.
- Shows layered status cards and an event timeline.
- Can render when primary `3850` is down.
- Links to the regular dashboard when primary is ready.

### Regular dashboard health panel

Primary URL: `http://127.0.0.1:3850/dashboard`

Requirements:

- When primary is up, the regular dashboard includes a health panel or health page using the same display model.
- The regular dashboard may call primary diagnostics endpoints directly for richer detail.
- It should link back to the portal health page for recovery/troubleshooting.
- The model and labels must match the portal so support instructions are consistent.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the primary daemon is down but HiveDoctor/portal is running, when the user opens the health dashboard in Chrome, then the page renders and clearly marks primary as unavailable or booting. |
| AC-2 | Given the primary daemon is healthy, when the user opens the portal health dashboard, then it shows primary `ok`, storage status, embeddings status, service manager state, and a link to the regular dashboard. |
| AC-3 | Given embeddings are enabled but not warm, when the health dashboard renders, then embeddings show `starting` or `live, warming`, not `failed`. |
| AC-4 | Given storage health is degraded after boot grace, when the health dashboard renders, then storage is marked degraded and the primary daemon status is not collapsed into a generic `dead`. |
| AC-5 | Given HiveDoctor has an unresolved needs-attention record, when the health dashboard renders, then the recommended action and attempted remediation steps are visible without exposing secrets. |
| AC-6 | Given telemetry opt-out is enabled, when the health dashboard renders, then it shows telemetry disabled and performs no network egress beyond loopback. |
| AC-7 | Given the portal cannot read a health signal because an endpoint is unavailable, when the page renders, then that tile shows `unknown` with a short reason and the page remains usable. |
| AC-8 | Given the regular dashboard is available, when the health panel renders there, then the labels and statuses match the portal health model. |
| AC-9 | Given a browser refresh occurs repeatedly, when the dashboard polls health, then it does not trigger DeepLake reads beyond already-cached primary health signals. |
| AC-10 | Given local mode is running, when the page serves, then it is loopback-only and includes no token, credential value, raw authorization header, or PII. |

---

## Implementation notes

Recommended implementation path:

1. Define a shared health-view contract in a file importable by HiveDoctor and dashboard web code without importing daemon storage.
2. In HiveDoctor/portal, implement a read-only health aggregator:
   - Read HiveDoctor state and needs-attention store.
   - Probe primary `/health` with a short timeout.
   - Read daemon PID/service state if a safe CLI/runtime seam is exposed, or initially mark service state `unknown`.
   - When primary is reachable and local-mode-safe, optionally call `/setup/state` and `/api/diagnostics/health`.
3. Serve `/health` HTML and `/health/status.json` from the portal.
4. Add a regular-dashboard health page/panel using the same contract.
5. Add a copy-safe recommended action map:
   - `booting`: wait, auto-refresh.
   - `still_starting`: wait or run `honeycomb daemon status`.
   - `unreachable`: run `hivedoctor status` or view logs.
   - `degraded storage`: check credentials/network.
   - `needs_attention`: follow HiveDoctor recommendation.

The health dashboard must not be a repair console in v1. It can show commands, but it must not execute them.

---

## Files expected to change

| File | Expected change |
|---|---|
| `hivedoctor/src/status-page/server.ts` or new `hivedoctor/src/portal/*` | Serve health dashboard HTML and status JSON. |
| `hivedoctor/src/compose/index.ts` | Wire aggregator dependencies: state, needs-attention, primary probe, update state. |
| `hivedoctor/src/state.ts` | Expose or preserve fields needed by the health model. |
| `src/dashboard/web/*` | Add regular-dashboard health panel/page using the shared model. |
| `src/daemon/runtime/diagnostics-health.ts` | No required behavior change, but consumed as a source when primary is healthy. |
| `src/daemon/runtime/dashboard/setup-state.ts` | No required behavior change, but consumed for warmup/auth/setup signals. |
| `src/cli/runtime.ts` | Potentially expose a safe read-only service status helper without pulling daemon storage into HiveDoctor. |

---

## Test plan

- Unit: health model maps each raw source state to stable display states.
- Unit: missing primary endpoint yields `unknown` or `unreachable`, not a thrown request.
- Unit: needs-attention record is redacted and rendered.
- Unit: telemetry opt-out is read-only and causes no egress.
- Browser test: portal health page renders on `3852` while primary `3850` is down.
- Browser test: regular dashboard health panel renders on `3850` while primary is up.
- Browser test: text fits at mobile and desktop widths.
- Live proof: start HiveDoctor with primary delayed, open Chrome to portal health, watch transition from booting to ready.

---

## Open questions

- [ ] Should service-manager status be read by HiveDoctor directly, or should the primary daemon publish it once healthy?
- [ ] Should the health dashboard timeline use the existing `incidents.ndjson`, the needs-attention file, or a new summarized local file?
- [ ] Should the regular dashboard health panel be top-level navigation or a settings subpage? Recommendation: top-level "Health" because it is support-critical.
- [ ] Should update state expose exact versions in local mode? Recommendation: yes for package versions, never for tokens or org secrets.

---

## Related

- [PRD-067: HiveDoctor Boot Grace Release Blocker](../prd-067-hivedoctor-boot-grace-release-blocker/prd-067-hivedoctor-boot-grace-release-blocker-index.md)
- [PRD-068: Portal Daemon Boot Shell](../prd-068-portal-daemon-boot-shell/prd-068-portal-daemon-boot-shell-index.md)
- [PRD-070: First Browser Load Experience](../prd-070-first-browser-load-experience/prd-070-first-browser-load-experience-index.md)
- [PRD-029: Degradation Observability](../../completed/prd-029-degradation-observability/prd-029-degradation-observability-index.md)
- [PRD-064: HiveDoctor Self-Healing Watchdog](../../in-work/prd-064-hivedoctor-self-healing-watchdog/prd-064-hivedoctor-self-healing-watchdog-index.md)
- `hivedoctor/src/status-page/server.ts`
- `hivedoctor/src/compose/index.ts`
- `src/daemon/runtime/server.ts`
- `src/daemon/runtime/diagnostics-health.ts`
- `src/daemon/runtime/dashboard/setup-state.ts`
- `src/dashboard/contracts.ts`
- `src/dashboard/launch.ts`
