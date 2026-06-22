# PRD-021b: CLI Runtime (bin dispatch plus daemon lifecycle)

> **Parent:** [PRD-021](./prd-021-go-live-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Binding the 020a CLI dispatcher to real handlers and adding the daemon lifecycle verbs, so the bundled `bundle/cli.js` becomes a real end-to-end CLI. The dispatcher (`src/cli/index.ts`) already runs, but its handler seams are unbound ("not wired in this build"). This sub-PRD owns binding each storage verb to a real loopback `DaemonClient`, binding setup/connect/uninstall to the 019a connector, binding `status` to the 020d health check, binding `dashboard` to the 020b launcher, adding the `honeycomb daemon start|stop|status` verbs plus ensure-running-on-demand, and making `login` actually write credentials and heal org drift. It does not own the composition root the daemon verbs start (021a), the hook runtime (021c), the dashboard rendering (021d), or the MCP transport (021e).

## Goals

- Every storage verb's `DaemonClient` bound to a real loopback client at `127.0.0.1:3850`.
- `setup`, `connect`, and `uninstall` bound to the 019a connector (`connectorMain`).
- `status` bound to the 020d `HealthCheck` so it reports the real D1-D5 probes.
- `dashboard` bound to the 020b `launchDashboard`.
- Daemon lifecycle verbs (`honeycomb daemon start|stop|status`) plus ensure-running-on-demand, so any storage verb auto-starts a daemon if one is down.
- `login` that actually completes the device flow, writes `~/.honeycomb/credentials.json` at `0600`, and runs `healDriftedOrgToken`.

## Non-Goals

- The `assembleDaemon()` composition root that the daemon verbs start (021a).
- The hook client, per-harness binaries, and reference-harness wiring (021c).
- The dashboard view rendering and the log surface (021d).
- The MCP transport bind (021e).
- Any change to the 020a command set, flag set, or dispatcher structure beyond binding its seams and adding the `daemon` verb.

## User stories

- As a developer, I want `honeycomb recall` to actually return memory from the daemon so that the CLI is a real tool, not a dry run.
- As a developer, I want `honeycomb daemon start` to bring the daemon up and `honeycomb daemon stop` to take it down so that I control its lifecycle explicitly.
- As a developer, I want any storage verb to auto-start the daemon if it is down so that I never see a connection-refused error for a daemon I forgot to start.
- As a developer, I want `honeycomb login` to write my credentials at `0600` and re-mint a drifted org token so that every later hook and the daemon share one authenticated identity.
- As a developer, I want `honeycomb status` to show the real D1-D5 health so that I can diagnose a broken setup in one command.

## Functional requirements

- FR-1: Each storage verb's `DaemonClient` is bound to a real loopback client targeting `127.0.0.1:3850`, replacing the unbound "not wired in this build" seam, so `recall`, `remember`, `sessions prune`, `graph`, `route`, `sources`, `goal`, and the rest issue real daemon requests.
- FR-2: `setup`, `connect`, and `uninstall` are bound to the 019a connector entry point (`connectorMain`), so `honeycomb setup` detects and wires assistants, `honeycomb connect <harness>` wires one, and `uninstall` reverses only Honeycomb's changes.
- FR-3: `status`'s health source is bound to the 020d `HealthCheck`, so it runs the real D1-D5 probes (CLI installed, daemon reachable, agent present, agent login, hooks wired) rather than a placeholder.
- FR-4: `dashboard` is bound to the 020b `launchDashboard`, so `honeycomb dashboard` opens the live daemon-served dashboard surface.
- FR-5: New daemon lifecycle verbs are added: `honeycomb daemon start` brings the daemon up (via the 021a entry point), `honeycomb daemon stop` signals it down, and `honeycomb daemon status` reports whether it is running and bound to port 3850.
- FR-6: Ensure-running-on-demand: any storage verb checks for a running daemon and auto-starts one if it is down, so a storage command never fails solely because the daemon was not already up.
- FR-7: `honeycomb login` runs the device flow to completion and writes `~/.honeycomb/credentials.json` at `0600`, so the daemon and every hook read the same credential file.
- FR-8: `healDriftedOrgToken` runs as part of login and on session start: it re-mints a corrected token when the `org_id` claim does not match the active org, so queries always hit the active tenant.
- FR-9: The bundled `bundle/cli.js` is the real end-to-end CLI: running it dispatches through the bound handlers, the daemon lifecycle verbs, and the loopback client, with no remaining "not wired in this build" paths.
- FR-10: Daemon lifecycle and ensure-running-on-demand are deployment-mode aware: local single-user mode is the first-class path, and team or hybrid mode runs behind the existing auth without a separate CLI surface.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given any storage verb (recall, remember, sessions prune, graph), when it runs against a live daemon, then its `DaemonClient` issues a real loopback request to `127.0.0.1:3850` and returns real data. |
| AC-2 | Given `honeycomb daemon start`, when it runs, then a daemon is brought up via the 021a entry point and `honeycomb daemon status` reports it running on port 3850. |
| AC-3 | Given the daemon is down, when a storage verb runs, then ensure-running-on-demand auto-starts a daemon and the verb completes rather than failing with connection refused. |
| AC-4 | Given `honeycomb login`, when the device flow completes, then `~/.honeycomb/credentials.json` is written at `0600` and `healDriftedOrgToken` corrects a drifted org token. |
| AC-5 | Given `honeycomb status`, when it runs, then it reports the real D1-D5 health from the 020d `HealthCheck`, not a placeholder. |
| AC-6 | Given the bundled `bundle/cli.js`, when any command runs, then it dispatches through bound handlers with no remaining "not wired in this build" path. |

## Implementation notes

- The bindings reuse the 020a dispatcher and command set unchanged; this sub-PRD only fills the handler seams and adds the `daemon` verb, so CLI presentation still never entangles storage logic.
- Ensure-running-on-demand should share its reachability check with the 020d D2 dimension and the 021a `/health` probe, so "is the daemon up" has one answer everywhere.
- The credential file is the shared identity: once `login` writes it at `0600`, the 021a daemon reads it at startup and the 021c hooks read it via `CredentialReader`, so all three speak as one authenticated identity. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-021a `assembleDaemon()` and the daemon entry point that the `daemon start` verb invokes.
- PRD-020a unified CLI dispatcher and command set, whose seams this binds.
- PRD-019a connector base (`connectorMain`) for setup, connect, and uninstall.
- PRD-020b `launchDashboard` for the `dashboard` verb.
- PRD-020d `HealthCheck` for `status`.
- PRD-011 auth architecture for the device flow, the `0600` credential write, and `healDriftedOrgToken`.

## Open questions

- [ ] Daemon process model: should `daemon start` run foreground or background, and how is port-conflict on 3850 handled (shared with 021a)?
- [ ] Should ensure-running-on-demand start a daemon silently or prompt, and how long should a storage verb wait for a fresh daemon to bind?
- [ ] Which storage verbs, if any, should refuse to auto-start a daemon (for example destructive prune)?

## Related

- [parent index](./prd-021-go-live-index.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
- [Notifications and Environment Health](../../../knowledge/private/operations/notifications-and-health.md)
