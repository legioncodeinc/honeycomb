# PRD-020a: Unified CLI Command Surface

> **Parent:** [PRD-020](./prd-020-surfaces-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L

## Scope

The `@honeycomb/cli` unified dispatcher and command surface: setup, status, dashboard, remember, recall, agent, ontology, secret, skill, hook, route, sources, graph, goal, org, workspace, sessions prune, uninstall, and update, split between the entry-point parser and the command handlers, all routed through the daemon. This sub-PRD owns the dispatcher, the merged command set, the device-flow auth and token-drift heal, and the daemon-routed storage commands. It does not own the dashboard rendering (020b), the Cursor extension (020c), or the notifications and health framework (020d), though it exposes their entry points.

## Goals

- One `honeycomb` executable for every harness, consolidating the Hivemind product verbs and our memory engine's verbs into a single dispatcher.
- A clean split between the entry-point parser (`src/cli/index.ts`) and the command handlers (`src/commands/`), so presentation never entangles storage logic.
- Every storage-touching command routed through the daemon, never opening DeepLake directly.
- RFC 8628 device-flow auth shared with the daemon and hooks, with automatic org-token-drift healing.

## Non-Goals

- The dashboard UI and its data endpoints (020b).
- The Cursor extension surface (020c).
- The notifications framework and the D1-D5 health check internals (020d), though `status` surfaces health.
- Daemon storage, tenancy, and memory engine internals.

## User stories

- As a developer, I want one `honeycomb` executable for every harness so that I do not learn a separate tool per assistant.
- As a developer, I want `honeycomb status` to tell me daemon connectivity, login state, and environment health so that I can diagnose a broken setup fast.
- As a developer, I want `honeycomb sessions prune --before <date>` to clean trace history without leaving orphaned summaries.
- As an admin, I want `honeycomb org` and `honeycomb workspace` to manage tenancy from the same CLI.

## Functional requirements

- FR-1: The unified entry point (`src/cli/index.ts`) parses global flags (`--help`, `--version`, and shared options), dispatches to the matching handler, and prints usage when no command is given.
- FR-2: The command set covers `setup`, `status`, `dashboard`, `remember`, `recall`, `agent`, `ontology`, `secret`, `skill`, `hook`, `route`, `sources`, `graph`, `goal`, `org`, `workspace`, `sessions prune`, `uninstall`, and `update`; each maps to a handler under `src/commands/`.
- FR-3: Every storage-touching command (`remember`, `recall`, `sessions prune`, `graph`, `route`, `sources`, `goal`, and so on) issues a daemon request on port 3850 and never opens DeepLake directly.
- FR-4: `org` and `workspace` subcommands are recognized by an `AUTH_SUBCOMMANDS` set and passed through, with the full argument array, to the auth-login dispatcher.
- FR-5: Skillify operations are reached under `honeycomb skill ...` (scope, pull, unpull, force), for example `honeycomb skill scope team --users alice,bob` and `honeycomb skill pull --force`.
- FR-6: `setup` detects installed assistants, wires hooks via the connector base, and brings up the daemon; `honeycomb connect <harness>` wires one harness; `uninstall` reverses only Honeycomb's changes for the detected or named targets.
- FR-7: Auth uses the RFC 8628 device flow: request device code, open or print the verification URI, poll for the token, validate against `/me`, select the preferred org (honoring `HONEYCOMB_ORG_ID`), mint a long-lived API token, and write credentials to `~/.honeycomb/credentials.json` at `0600`.
- FR-8: `healDriftedOrgToken` runs on session start: it decodes the JWT, compares the `org_id` claim with the active org, and re-mints a corrected token (unique per-mint name) when they mismatch, so queries always hit the active tenant.
- FR-9: `sessions prune` lists sessions grouped by path for the logged-in author, filters by `--before <date>` or `--session-id <id>`, and asks the daemon to delete matching `sessions` rows and the paired `memory` summary rows so traces and summaries never desync.
- FR-10: `status` reports daemon connectivity, login state, and environment health (the D1-D5 dimensions from 020d), and `update` self-updates the CLI, daemon, and bundles with a `--dry-run` option.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given any top-level command, when it dispatches, then the entry point parses global flags and routes to the matching handler, with org/workspace verbs passed through to the auth dispatcher. |
| AC-2 | Given `honeycomb sessions prune --before <date>`, when it runs, then the daemon deletes matching `sessions` rows and the paired `memory` summaries so traces and summaries never desync. |
| AC-3 | Given any storage-touching command, when it runs, then it issues a daemon request and never opens DeepLake directly. |
| AC-4 | Given a drifted org token on session start, when `healDriftedOrgToken` runs, then it re-mints a token whose `org_id` claim matches the active org. |
| AC-5 | Given `honeycomb login` on a headless box, when it runs, then the device flow completes and credentials are written to `~/.honeycomb/credentials.json` at `0600`. |
| AC-6 | Given `honeycomb skill scope team --users alice,bob`, when it runs, then the skillify scope is updated through the daemon. |

## Implementation notes

- The split guarantees CLI presentation never entangles storage, encryption, or synchronization logic; handlers express their work as daemon calls.
- The daemon reads the same credential file at startup, so once the CLI logs in, every hook and the daemon share one authenticated identity.
- `sessions prune` deletes both the `sessions` trace rows and the `/summaries/<user>/<sessionId>.md` row in `memory`, preventing orphaned summaries. American spelling, direct prose, no em dashes.

## Dependencies

- Daemon API (port 3850) for every storage command.
- Auth architecture for device flow and token minting.
- PRD-019a connector base for `setup`, `connect`, and `uninstall`.
- PRD-020d health check for the `status` health dimensions.

## Open questions

- [ ] What is the full flag set per command, and which flags are global versus per-command?
- [ ] Should `dashboard` launch a webview, a TUI, or both (shared with 020b)?

## Related

- [parent index](./prd-020-surfaces-index.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [Notifications and Environment Health](../../../knowledge/private/operations/notifications-and-health.md)
