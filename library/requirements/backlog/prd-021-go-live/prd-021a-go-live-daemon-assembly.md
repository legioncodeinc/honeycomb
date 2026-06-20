# PRD-021a: Daemon Assembly (the composition root)

> **Parent:** [PRD-021](./prd-021-go-live-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

The composition root: the one function, `assembleDaemon()`, that constructs the live storage client from resolved config, builds `createDaemon`, fires every mount and attach seam exactly once after construction, replaces the three no-op services with their real implementations, binds the socket, and shuts down gracefully. This sub-PRD owns the daemon entry point (`src/daemon/index.ts`), the assembly order, the real-service swap, the socket bind and graceful shutdown, and the live `/health` storage probe. It does not own the CLI that starts the daemon (021b), the hook handlers it attaches (021c), the dashboard views or log surface it mounts (021d), or the MCP transports (021e), though it is the caller that wires all of them.

## Goals

- A single `assembleDaemon()` composition root that is the only place the production daemon is constructed and wired.
- Every mount and attach seam fired exactly once, after construction, in a deterministic order.
- The three no-op services (`JobQueueService`, `FileWatcherService`, `RuntimePathService`) replaced with their real implementations.
- A bound socket on port 3850 with idempotent start, a PID and lock file, and graceful shutdown on SIGINT and SIGTERM.
- A `/health` endpoint that flips from a static stub to a live storage probe.

## Non-Goals

- The CLI daemon lifecycle verbs (`honeycomb daemon start|stop|status`) and ensure-running-on-demand (021b).
- The hook handler bodies and per-harness wiring (021c).
- The dashboard view rendering and the log ring-buffer reader (021d).
- The MCP transport bind (021e).
- Any new storage logic, table, column, or index. The composition root constructs the existing client only.

## User stories

- As an operator, I want one command to bring up a fully wired daemon so that every surface (hooks, dashboard, notifications, sessions prune) is live without me wiring anything by hand.
- As an operator, I want `/health` to actually probe DeepLake so that a green health check means the store is reachable, not just that the process is up.
- As an operator, I want SIGINT and SIGTERM to drain and close cleanly so that a stop never leaves a half-open socket or a stale lock file.
- As a maintainer, I want exactly one place that imports `daemon/storage` so that the thin-client invariant holds everywhere else.

## Functional requirements

- FR-1: `assembleDaemon()` constructs the live storage client from resolved config, using `resolveStorageConfig` plus `envCredentialProvider` for the DeepLake credentials, and is the only production caller that imports `daemon/storage`.
- FR-2: `assembleDaemon()` builds the daemon via `createDaemon({ storage, authenticator, policy, services, logger })` (`src/daemon/runtime/server.ts`), passing the constructed storage client, the configured authenticator and policy, the real services, and the logger.
- FR-3: After construction, the composition root fires each mount and attach seam exactly once and in a deterministic order: `attachHooksHandlers(daemon, {...})` (`src/daemon/runtime/capture/attach.ts`), `mountDashboardApi(daemon, { storage })` (`src/daemon/runtime/dashboard/api.ts`), `mountNotificationsApi(daemon, {...})` (`src/daemon/runtime/notifications/api.ts`), and `attachSessionsPrune(daemon, {...})` (`src/daemon/runtime/sessions/prune.ts`).
- FR-4: The three no-op services (`JobQueueService`, `FileWatcherService`, `RuntimePathService`, currently the `noop*` stubs in `createDaemon`) are replaced with their real implementations and passed into `createDaemon` via the `services` argument.
- FR-5: `startDaemon(daemon)` binds the socket on port 3850 via `@hono/node-server` (`src/daemon/runtime/listen.ts`).
- FR-6: The daemon installs SIGINT and SIGTERM handlers that perform a graceful shutdown: call `stopServices()` to drain the real services and then close the listening socket.
- FR-7: `/health` flips from a static stub to a live storage probe: a 200 means the storage client reached DeepLake, and a failed probe surfaces a non-200 with a diagnostic body rather than reporting healthy.
- FR-8: Start is idempotent and writes a PID and lock file: a second start against an already-bound port 3850 detects the running daemon and does not double-bind or corrupt the lock.
- FR-9: `assembleDaemon()` is deployment-mode aware: it constructs the daemon for local single-user mode as the first-class path, and for team or hybrid mode behind the existing auth, without changing the assembly order.
- FR-10: The entry point is `src/daemon/index.ts`, bundled by esbuild to `daemon/index.js`; running the bundle invokes `assembleDaemon()` then `startDaemon()`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given resolved config with DeepLake credentials, when `assembleDaemon()` runs, then it constructs the live storage client and is the only production code importing `daemon/storage`. |
| AC-2 | Given a constructed daemon, when the composition root runs, then `attachHooksHandlers`, `mountDashboardApi`, `mountNotificationsApi`, and `attachSessionsPrune` are each called exactly once after construction. |
| AC-3 | Given `createDaemon`, when the daemon is assembled, then the three no-op services are replaced with their real `JobQueueService`, `FileWatcherService`, and `RuntimePathService` implementations. |
| AC-4 | Given a running daemon, when `/health` is requested, then it performs a live storage probe and returns 200 only when DeepLake is reachable. |
| AC-5 | Given a running daemon, when SIGINT or SIGTERM is received, then `stopServices()` drains the services and the socket closes without leaving a stale lock file. |
| AC-6 | Given a daemon already bound to port 3850, when a second start runs, then it detects the running daemon via the PID and lock file and does not double-bind. |

## Implementation notes

- The composition root is the legitimate exception to the thin-client invariant: it is inside `src/daemon/`, so importing `daemon/storage` here is correct, and keeping all storage construction in this one function is what lets the bin, hooks, MCP, and SDK stay thin clients.
- Fire the seams after construction, never during, so the daemon object is fully built before any handler is attached. Exactly-once is the contract every prior CONVENTIONS note promised; the composition root is where that promise is kept.
- The real-service swap is a drop-in for the `noop*` stubs already accepted by `createDaemon`; no `createDaemon` signature change is needed, only real implementations passed through `services`.
- The `/health` probe should be a cheap, read-only round trip so it can be polled by the D2 health dimension (020d) and the CLI `status` without load. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-019b hook lifecycle core, whose handlers `attachHooksHandlers` mounts.
- PRD-020b dashboard data contract, whose endpoints `mountDashboardApi` serves.
- PRD-020d notifications API and the D2 reachability probe that consumes `/health`.
- PRD-020a sessions prune, whose daemon endpoint `attachSessionsPrune` mounts.
- The storage modules behind `resolveStorageConfig`, `envCredentialProvider`, and `createDaemon`.
- The auth architecture for the authenticator and policy passed to `createDaemon`.

## Open questions

- [ ] Daemon process model: foreground versus backgrounded, PID and lock file location, and port-conflict handling on 3850 (shared with 021b).
- [ ] Should the real `FileWatcherService` watch on assembly or lazily on first use, to keep cold start fast?
- [ ] How aggressive should the `/health` storage probe be: a connectivity-only check versus a light query?

## Related

- [parent index](./prd-021-go-live-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
