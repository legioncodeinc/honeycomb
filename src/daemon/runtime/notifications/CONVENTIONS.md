# Notifications backend API (daemon side) — CONVENTIONS (PRD-020d / FR-3)

`mountNotificationsApi` (`api.ts`) is the daemon-side seam serving backend notifications to the 020d
pipeline. The pipeline is a NON_DAEMON_ROOT thin client: it fetches backend notifications THROUGH THE
DAEMON (FR-3), never opening DeepLake. This module is where the actual store read happens.

It mirrors `attachHooksHandlers` (019b): the daemon assembly calls it ONCE after
`createDaemon(...)`, attaching onto the already-mounted `/api/diagnostics` group via
`daemon.group(...)` — ZERO `server.ts` edits.

**Storage-correct.** Lives under `src/daemon/`. The Wave-2 handler reads the org's pending
notifications through the injected `StorageQuery` and returns the 020d `Notification[]` shape the
pipeline's `BackendNotificationSource` consumes.

**Wave 1 = honest no-op attach.** No route registered yet; the group answers the 501 scaffold until
Wave 2 fills the handler. The 020d pipeline already times out the backend fetch at ~1.5s and swallows
failures (FR-2 / d-AC-3), so a still-stubbed endpoint never blocks a session.
