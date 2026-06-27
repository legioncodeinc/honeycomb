# Dashboard Actions Surface

> Category: Frontend | Version: 1.0 | Date: June 2026 | Status: Active

How the daemon-served dashboard performs CLI lifecycle actions, logout, embeddings on/off, daemon restart, and uninstall, through the guarded `/api/actions` group, and why these four are held to a stricter trust gate than the rest of the dashboard.

**Related:**
- [`dashboard-architecture.md`](dashboard-architecture.md)
- [`../dashboard/adding-a-page.md`](../dashboard/adding-a-page.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../architecture/cli-dispatcher.md`](../architecture/cli-dispatcher.md)
- [`../security/trust-boundaries.md`](../security/trust-boundaries.md)

---

## Why this surface exists

For most of its life the dashboard was read-mostly: it rendered view-models (`api.ts`, `harness-api.ts`) and wrote vault settings (`/api/settings`) and secrets (`/api/secrets`). Anything that changed the *process*, the *credential*, or the *installation* was CLI-only, you signed out with `honeycomb logout`, toggled embeddings with `HONEYCOMB_EMBEDDINGS`, restarted with `honeycomb daemon`, and removed Honeycomb with `honeycomb uninstall`.

PRD-145 makes the dashboard a peer of the CLI for those four named lifecycle actions. They differ in kind from a settings write: they are sharp, they touch the credential file, the running process, or the on-disk footprint, so they get their own mount (`/api/actions`) and their own guard rather than riding the settings path. The seam is deliberately extensible: a future verb is one handler plus one wire method plus one control, with no new route plumbing.

```mermaid
flowchart LR
    S[Settings page<br/>settings.tsx] -->|wire.ts| A[/api/actions/*]
    A --> G{actionGuard}
    G -->|reject| R[403]
    G -->|allow| H[logout · embeddings · restart · uninstall]
    H --> E[EmbedSupervisor.setEnabled]
    H --> V[VaultStore.setSetting]
    H --> K[restart-helper.js]
    H --> C[credential files]
```

## The four actions

All four are `POST` under the `/api/actions` group (`src/daemon/runtime/dashboard/actions-api.ts`). No secret or token ever crosses a response, the richest payload is an uninstall outcome carrying ids and a command string.

| Action | Endpoint | Effect | Response |
|---|---|---|---|
| Logout | `POST /api/actions/logout` | Remove the shared + legacy credential files (idempotent, fail-soft) | `{ ok: true }` |
| Embeddings | `POST /api/actions/embeddings` | Persist `embeddings.enabled` then actuate the supervisor live | `{ ok, enabled }` |
| Restart | `POST /api/actions/restart` | Spawn the detached respawn helper, then gracefully stop this daemon | `{ ok, restarting }` |
| Uninstall | `POST /api/actions/uninstall` | v1 guided: detect wired harnesses + return the exact reversal command | `UninstallOutcome` |

Re-login is not a fifth handler: the page reuses the existing `/setup/login` device flow, now driven in-page instead of handed off to a terminal.

## The guard (these actions are sharp)

Every handler calls `actionGuard(c, mode)` first, which returns a `Response` to short-circuit or `null` to proceed. It stacks three independent barriers on top of the daemon's loopback bind:

1. **Local mode only.** A `team`/`hybrid` daemon returns `403`, the same posture as the dashboard host and `/setup/*` routes (`assemble.ts` security F-1). A self-destruct / credential surface is never exposed to a remote.
2. **Origin / CSRF.** The daemon binds loopback, but a malicious site open in the user's browser could `POST` to `127.0.0.1:3850`. The guard rejects a browser cross-origin request (`Sec-Fetch-Site: cross-site|same-site`) and requires any present `Origin` to resolve to a loopback host (`127.0.0.1`, `localhost`, `::1`).
3. **Dashboard session header.** It requires the dashboard's custom `x-honeycomb-session` header. A cross-origin `fetch` cannot set a custom header without a CORS preflight the daemon never approves, so this is a third, independent CSRF barrier.

A non-browser client (the CLI, a unit test) sends no `Sec-Fetch-Site`, so it passes barrier 2 cleanly while still needing local mode and the session header.

## Embeddings: persist then actuate

The embeddings toggle is the one action with durable state. The handler **persists first** (best-effort) so the choice survives a restart, then actuates the running supervisor:

```ts
if (store !== undefined) {
  const sc = settingsScope.resolve(c);          // same local-default scope as /api/settings
  if (sc !== null) {
    try { await store.setSetting(EMBEDDINGS_ENABLED_KEY, enabled, sc); }
    catch { /* a vault write failure must not block the live toggle */ }
  }
}
await embed.setEnabled(enabled);                 // spawn + warm, or stop the child
```

The persisted key (`embeddings.enabled`) is read at daemon boot, so the supervisor comes up in the last-chosen state. The scope is resolved through the **same** `localDefaultScopeResolver` the `/api/settings` write uses, so a dashboard toggle and a CLI `honeycomb settings set` land under identical tenancy. A missing store or unresolvable scope simply skips persistence, the live toggle still applies for the session.

## Restart: a separate respawn process

A daemon cannot cleanly restart itself. It holds a single-instance lock, so a fresh daemon started while the old one still holds the lock would see "already running" and exit, leaving nothing; and a self-respawn cannot order itself after its own lock release.

The restart handler therefore spawns `restart-helper.js` (`src/daemon/restart-helper.ts`), a tiny, dependency-free, **detached** process bundled beside the daemon entry, then defers the graceful shutdown one tick so the `200` flushes first:

```ts
spawnRestart();                                  // detached helper, unref'd, outlives the parent
setTimeout(() => shutdown(), RESTART_SHUTDOWN_DELAY_MS);  // SIGTERM self; assembly drains
```

The helper waits for the old daemon's `/health` to stop answering, waits a short grace for the lock file to clear, then starts a fresh daemon and exits. The ordering is: old drains → old exits → helper sees `/health` down → helper starts the new daemon → new daemon acquires the lock cleanly. The helper is fail-soft: if it cannot determine the entry or the wait times out, it still attempts the spawn (a fresh daemon's own stale-lock reclaim is the backstop) and never throws. It reads two env vars stamped by the handler, `HONEYCOMB_RESTART_ENTRY` (the `daemon/index.js` path) and `HONEYCOMB_RESTART_PORT` (the loopback port).

> **Known follow-up (PR-145):** the self-respawn is unit-tested with injected seams but not yet live-dogfooded; the graceful-stop path is the documented fallback. Verify a live restart before relying on the one-click flow.

## Uninstall: honest v1 (guided)

The destructive hook removal lives in the CLI connector engine (`honeycomb uninstall`), a non-daemon layer. Performing it from the very daemon serving the page would kill the page mid-operation. So `defaultUninstall()` surfaces the capability honestly rather than faking a one-click removal: it detects the wired harnesses (`detectInstalledHarnesses()`) and returns an `UninstallOutcome` naming them plus the exact reversal command (`honeycomb uninstall`) and a plain-language note. `removed` is `false` in v1, the seam is injectable so a future composition root can wire a real in-process remover.

## Hermetic by injection

Every effect is an injectable seam on `MountActionsOptions`, defaulting to the real behaviour: `removeCredentials`, `shutdown`, `spawnRestart`, `uninstall`, plus the `embed` supervisor and the optional `store`. The unit suite (`tests/daemon/runtime/dashboard/actions-api.test.ts`) drives every handler and every guard rejection against recorders, without removing a real credential, killing the test process, or spawning a real daemon.

## Mounting

`mountActionsApi(daemon, options)` mirrors `mountHarnessApi`: it resolves the already-declared protected group (`daemon.group("/api/actions")`, declared in `server.ts`) and delegates to `mountActionsGroup`, which attaches the four handlers with zero `server.ts` handler edits. It is a no-op when the group is not mounted, so a unit-constructed daemon without the group never throws. The browser side is symmetrical: `wire.ts` exposes `logout()`, `restartDaemon()`, `uninstall()`, and the embeddings toggle, and `settings.tsx` renders the Embeddings and System Actions sections (each destructive action behind a step-by-step confirmation).
