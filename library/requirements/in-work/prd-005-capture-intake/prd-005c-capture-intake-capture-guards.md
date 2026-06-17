# PRD-005c: Capture Guards

> **Parent:** [PRD-005](./prd-005-capture-intake-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S

## Scope

Implement the guards that gate capture on every turn: a bypass switch, a plugin-enabled check, an entrypoint check, a recursion guard, and fail-soft hook behavior. Capture runs on every turn, so it has to be defensible. These guards live in the shim layer, ahead of the daemon call, and ensure that capture is skipped cleanly when it should not run and that a capture error never breaks the agent's turn. The recursion guard specifically keeps the summary and skillify workers, which themselves run the harness CLI, from capturing their own activity as new turns.

## Goals

- Disable capture outright with a bypass switch (`HONEYCOMB_CAPTURE=false`).
- Skip capture when the integration plugin is disabled.
- Ensure only the intended hook entrypoint captures, via an entrypoint check.
- Prevent the summary and skillify workers from capturing their own CLI activity as new turns (recursion guard).
- Fail soft: when capture errors, the hook exits cleanly rather than breaking the agent's turn.

## Non-Goals

- The capture INSERT (PRD-005a) and embedding attachment (PRD-005b).
- The summary and skillify workers themselves (only guarded against here).
- Daemon-side write logic; guards live in the shim layer.

## User stories

- As a developer, I want capture to fail soft so that a capture error never breaks my agent's turn.
- As an operator, I want a bypass switch so that I can disable capture instantly without uninstalling the plugin.
- As the system, I want a recursion guard so that the background workers do not pollute `sessions` with their own CLI turns.

## Functional requirements

- **FR-1** The capture gate SHALL skip capture when `HONEYCOMB_CAPTURE === "false"`; any other value (including unset) SHALL leave capture enabled.
- **FR-2** The gate SHALL skip capture when the integration plugin is disabled.
- **FR-3** The gate SHALL apply an entrypoint check so only the intended hook process captures, skipping non-capture entrypoints.
- **FR-4** A recursion guard SHALL detect when the current process is a summary or skillify worker running the harness CLI and SHALL suppress capture of that activity as new turns.
- **FR-5** The capture hook SHALL fail soft: any error during capture (gate evaluation, payload normalization, or the daemon call) SHALL cause the hook to exit cleanly without breaking the agent's turn.
- **FR-6** The gate logic SHALL be shared across all per-agent shims (the `capture-gate` shared module) so behavior is uniform across harnesses.
- **FR-7** When capture is skipped by any guard, the agent's turn SHALL proceed unaffected and no `sessions` row SHALL be written.
- **FR-8** Guard evaluation SHALL run in the shim layer ahead of the daemon call, so a skipped turn makes no daemon request.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `HONEYCOMB_CAPTURE=false`, when a turn occurs, then capture is skipped and the turn proceeds. |
| AC-2 | Given a disabled plugin, when a turn occurs, then capture is skipped. |
| AC-3 | Given a non-capture entrypoint, when a turn occurs, then capture is skipped. |
| AC-4 | Given a summary or skillify worker running the harness CLI, when it acts, then the recursion guard prevents its activity from being captured as new turns. |
| AC-5 | Given capture errors, when the hook runs, then the hook exits cleanly rather than breaking the turn. |
| AC-6 | Given any guard skips capture, when the turn completes, then no daemon capture request was made and no sessions row was written. |

## Implementation notes

- The recursion guard keeps the summary and skillify workers, which themselves run the harness CLI, from capturing their own activity as new turns. Without it, the workers would generate `sessions` rows that re-trigger the very workers that produced them.
- These guards live in the shim layer documented in the hook lifecycle. The `capture-gate` shared module implements the `HONEYCOMB_CAPTURE !== "false"` gate and the only-CLI entrypoint check used by every capture path.
- Fail-soft is a hard requirement: hooks run on the critical path of the agent's turn, so an uncaught capture error must never surface to the user as a broken turn.
- The bypass switch is env-based for harnesses with an env channel; the location for harnesses without one is open (see below).

## Dependencies

- PRD-005a (the capture path these guards gate).
- The shared shim core (`capture-gate` and entrypoint check modules) from the hook lifecycle integration.
- The summary worker and skillify miner (the recursion guard's subjects).

## Open questions

- [ ] Where does the bypass switch live for harnesses without an env channel (config versus header)?
- [ ] How does the recursion guard identify worker-spawned CLI processes across harnesses (env marker, process tree, or lock file)?

## Related

- [parent index](./prd-005-capture-intake-index.md)
- [Session Capture](../../../knowledge/private/ai/session-capture.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
