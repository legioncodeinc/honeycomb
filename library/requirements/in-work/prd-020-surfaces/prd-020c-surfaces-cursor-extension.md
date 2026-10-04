# PRD-020c: Cursor Extension

> **Parent:** [PRD-020](./prd-020-surfaces-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The Honeycomb for Cursor editor extension that adds operator UX on top of the hooks integration: hook wiring and refresh, no-terminal login, a status bar, a dashboard webview, and skill symlink sync. This sub-PRD owns the extension shell (`harnesses/cursor/extension/`), its command list, the status-bar health surface, and the webview embed. It does not own the Cursor hook shim (PRD-019c), the dashboard view layer (020b, which this embeds), or the health-check engine (020d, which the status bar surfaces).

## Goals

- An extension that lets a Cursor user wire hooks, log in, and view the dashboard without a terminal.
- Hook wiring and refresh that copies the bundle and merges `~/.cursor/hooks.json` idempotently, preserving foreign hooks and the hook-trust fingerprint.
- A status bar surfacing CLI, `cursor-agent`, login, daemon connectivity, and hook-wiring health.
- A dashboard webview embedding the canonical daemon-served views, plus skill symlink sync.

## Non-Goals

- The Cursor hook shim and capture/recall mechanics (PRD-019c); the hooks integration alone is sufficient for capture, recall, skillify, and graph.
- The dashboard view layer itself (020b); the extension embeds it.
- The D1-D5 health-check engine internals (020d); the status bar surfaces the result.
- Other harnesses' extensions.

## User stories

- As a Cursor user, I want an extension so that I can wire hooks, log in, and view the dashboard without a terminal.
- As a Cursor user, I want a status bar so that I can see at a glance whether the CLI, daemon, login, `cursor-agent`, and hooks are healthy.
- As a Cursor user, I want skills to sync automatically so that org and team skills appear in my editor without manual symlinking.

## Functional requirements

- FR-1: The extension activates in Cursor and registers commands for Wire / Refresh Hooks, Login (browser or API key), Open Dashboard, and Sync Skills.
- FR-2: Wire / Refresh Hooks copies `harnesses/cursor/bundle/` to `~/.cursor/honeycomb/bundle/` and idempotently merges `~/.cursor/hooks.json`, wiring `sessionStart`, `beforeSubmitPrompt`, `preToolUse` (Shell matcher), `postToolUse`, `afterAgentResponse`, `stop`, and `sessionEnd` plus `graph-on-stop`.
- FR-3: Hook wiring preserves foreign hooks (filters via `isHoneycombEntry`, appends Honeycomb entries), stays idempotent (`writeJsonIfChanged`) to protect the hook-trust fingerprint, and reverses cleanly on uninstall, unlinking an emptied config file.
- FR-4: The status bar shows health for D1 CLI, D2 daemon connectivity, D3 `cursor-agent`, D4 `cursor-agent` login, and D5 hooks wired and current, refreshing on activation and on demand.
- FR-5: Login supports a no-terminal flow: browser-based device login or API-key entry, writing the same `~/.honeycomb/credentials.json` the CLI and daemon share.
- FR-6: The dashboard webview embeds the canonical daemon-served views (KPIs, settings, sessions, graph canvas, rules list, skill-sync state) from 020b, pointed at the local daemon.
- FR-7: On activation, the extension syncs skill symlinks into `~/.cursor/skills-cursor/` and `<project>/.cursor/skills/` without clobbering existing entries.
- FR-8: The extension runs `ensurePluginNodeModulesLink`-style self-heal to restore any broken bundle symlink a marketplace auto-upgrade may have dropped.
- FR-9: When the daemon is unreachable, the status bar and webview show a clear connectivity state and offer a fast-start action rather than failing silently.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the extension is active, when the user runs Wire / Refresh Hooks, then `harnesses/cursor/bundle/` is copied to `~/.cursor/honeycomb/bundle/` and `~/.cursor/hooks.json` is merged idempotently. |
| AC-2 | Given the extension activates, when it syncs skills, then symlinks are created into `~/.cursor/skills-cursor/` and `<project>/.cursor/skills/` without clobbering existing entries. |
| AC-3 | Given a config with foreign hooks, when Wire / Refresh Hooks runs, then foreign hooks are preserved and only Honeycomb entries are added or updated. |
| AC-4 | Given the status bar is shown, when health is evaluated, then D1-D5 states render and a failing dimension is visibly flagged. |
| AC-5 | Given the user logs in via the extension, when login completes, then credentials are written to the shared `~/.honeycomb/credentials.json`. |
| AC-6 | Given the dashboard webview opens, when the daemon is running, then it renders the same KPI, sessions, settings, graph, rules, and skill-sync views as the daemon-served dashboard. |

## Implementation notes

- The hooks integration alone is sufficient for capture, recall, skillify, and graph; the extension adds operator UX (status bar health, no-terminal login, dashboard webview, skill sync) on top.
- Hook wiring must preserve foreign hooks, stay idempotent to protect the hook-trust fingerprint, and reverse cleanly on uninstall, matching the connector-base rules (019a) and the auto-wiring engine (020d).
- The extension source lives at `harnesses/cursor/extension/`; the compiled hook scripts live at `harnesses/cursor/bundle/`.

## Dependencies

- PRD-019c Cursor hook shim and `harnesses/cursor/bundle/`.
- PRD-020b dashboard view layer embedded by the webview.
- PRD-020d health-check engine for the status-bar dimensions and auto-wiring.
- Shared `~/.honeycomb/credentials.json` and the daemon on port 3850.

## Open questions

- [ ] Should the extension bundle its own copy of the dashboard webview or load it from the daemon?
- [ ] How much of the D1-D5 status-bar logic is shared verbatim with the CLI `status` command?

## Related

- [parent index](./prd-020-surfaces-index.md)
- [Cursor Extension Architecture](../../../knowledge/private/frontend/cursor-extension-architecture.md)
- [Notifications and Environment Health](../../../knowledge/private/operations/notifications-and-health.md)
