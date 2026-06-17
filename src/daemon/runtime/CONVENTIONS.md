# Daemon runtime conventions (PRD-004 bootstrap seam) — READ BEFORE FILLING A STUB

Wave 1 (PRD-004a) stood up the Hono server, the config resolver, the permission
and runtime-path middleware mounts, the structured logger, and the production
listen path. It also **pre-wired three registration seams** so each Wave-2 Bee
(004b job queue, 004c file watcher, 004d runtime-path) fills **only its own
module + its own test file** with **zero contention** on the bootstrap or any
shared file — the same stub pattern that kept PRD-003's parallel wave clean.

The whole point: **the bootstrap already imports, registers, and lifecycles your
service.** You swap the stub for the real impl in your module and pass it into
`createDaemon({ services: { … } })` from your test. You never edit `server.ts`,
`index.ts`, `config.ts`, `logger.ts`, or the permission middleware.

---

## 0. The dependency-injection seam (how every Wave-2 service plugs in)

`createDaemon(options)` (in `server.ts`) takes injected services with stub
defaults:

```ts
const daemon = createDaemon({
  services: {
    queue: myRealJobQueueService,        // 004b
    watcher: myRealFileWatcherService,   // 004c
    runtimePath: myRealRuntimePathService, // 004d
  },
});
```

Each service defaults to its **no-op stub** (`noopJobQueueService`,
`noopFileWatcherService`, `noopRuntimePathService`), so the daemon compiles and
runs today with inert services. The bootstrap:

- registers all three into `daemon.services`,
- starts them in `startServices()` (order: queue → watcher → runtime-path),
- stops them in `stopServices()` (reverse order),
- mounts `runtimePathMiddleware(services.runtimePath, getMode)` ahead of every
  **session-scoped** route group (so 004d's reject is fail-closed-before-handler).

**Your job:** implement the interface, export it under the **same name**, and
construct the daemon with it **in your test**. The bootstrap does the rest.

### The shared lifecycle contract (`services/types.ts`)

```ts
interface DaemonService {
  start(): void | Promise<void>;  // awaited by the bootstrap on listen
  stop(): void | Promise<void>;   // awaited by the bootstrap on shutdown
}
```

`start`/`stop` must be idempotent-friendly and safe to call even if the service
did nothing. The job queue and file watcher both extend `DaemonService`; the
runtime-path service declares `start`/`stop` with the same shape.

---

## 1. How to reach the storage client + catalog (the daemon is the ONLY DeepLake client)

Your service does **not** open DeepLake. It receives the storage client (the
`StorageQuery` interface from `../storage/client.js`) and uses the catalog
helpers. Take them as constructor deps:

```ts
import type { StorageQuery, QueryScope } from "../../storage/client.js";
import { healTargetFor, catalogTable } from "../../storage/catalog/index.js";
import { isOk } from "../../storage/result.js";

export interface JobQueueDeps {
  readonly storage: StorageQuery;   // run queries through this — never a raw fetch
  readonly scope: QueryScope;       // the resolved { org, workspace } for queue rows
}
```

Storage rules you MUST follow (from `storage/catalog/CONVENTIONS.md` and the
typescript-node stinger):

- Run every statement through `storage.query(sql, scope, opts)`. It already
  bounds timeout + returns the closed `QueryResult` union — **never** hand-roll a
  `fetch`, and **never** import `storage/transport.ts` directly.
- Branch on the result `kind` (`ok` / `query_error` / `connection_error` /
  `timeout`) via `isOk(...)`; do not wrap a storage call in a bare try/catch.
- Build SQL with the guards from `../../storage/sql.js`: identifiers through
  `sqlIdent`, values through `sLiteral` / `sqlStr` / `sqlLike`. `npm run
  audit:sql` scans `src/daemon/storage` — if you add a query helper, put it where
  the audit sees it OR keep it guard-clean regardless. **Never hand-quote a value.**
- For a NEW table (004b's `memory_jobs`): define its `CatalogTable` once (its
  ColumnDef array, `pattern`, `scope`), add it to a catalog group per
  `storage/catalog/CONVENTIONS.md`, and create/heal it through the existing
  `buildCreateTableSql` / `withHeal` path — **never** a hand-rolled `ALTER`.

---

## 2. 004b — Durable Job Queue (`services/job-queue.ts`)

**Edit:** `src/daemon/runtime/services/job-queue.ts` (replace the stub body).
**Test:** `tests/daemon/runtime/services/job-queue.test.ts` (new file).
**Do NOT edit:** `server.ts`, `index.ts`, `services/types.ts`.

**Implement** (keep these export names — the bootstrap imports `noopJobQueueService`):

- `JobQueueService` — already declared; implement every method.
- `createJobQueueService(deps: JobQueueDeps): JobQueueService` — add this real
  factory. Your test constructs it with the fake transport (see §5) and passes it
  to `createDaemon({ services: { queue } })`.
- Keep `noopJobQueueService` exported (the bootstrap default).

**Behaviour (PRD-004b / D-3):** lease (5min) — a leased job is not leasable by
another worker until expiry/complete/fail (b-AC-1); max_attempts 5 → `dead`
(b-AC-2); reaper reclaims stale leases from crashed workers (b-AC-3); failed-with-
attempts sets `next_run_at` by exponential backoff (base 1s doubling, cap 5min,
b-AC-4); restart resumes queued jobs + reaps dangling leases (b-AC-5); first
enqueue creates `memory_jobs` from its ColumnDef array and retries once (b-AC-6);
completed jobs purged past a window, dead retained longer (b-AC-7).

**Lifecycle:** `start()` ensures the `memory_jobs` table + starts the reaper
timer; `stop()` clears the reaper. There is also an **opt-in LIVE** integration
test (creds now work) — put it under `tests/integration/*.itest.ts` so it runs
only via `npm run test:integration`, never in `npm run test`/`ci`.

---

## 3. 004c — Identity File Watcher (`services/file-watcher.ts`)

**Edit:** `src/daemon/runtime/services/file-watcher.ts` (replace the stub body).
**Test:** `tests/daemon/runtime/services/file-watcher.test.ts` (new file).
**Do NOT edit:** `server.ts`, `index.ts`, `services/types.ts`.

**Implement** (keep export names — the bootstrap imports `noopFileWatcherService`):

- `FileWatcherService` — already declared (`active: boolean` + `DaemonService`).
- `createFileWatcherService(deps: FileWatcherDeps): FileWatcherService` — add the
  real factory (watch root, harness targets, git-sync toggle). Your test passes
  the result to `createDaemon({ services: { watcher } })`.
- Keep `noopFileWatcherService` exported (the bootstrap default).

**Behaviour (PRD-004c / D-6):** on an identity-file change, regenerate per-harness
copies each with a do-not-edit header (c-AC-1); debounce a burst (500ms default)
into exactly one sync + one commit (c-AC-3); unchanged canonical → byte-identical
copies, no spurious commit (c-AC-4); git-on → timestamped commit (c-AC-2), git-off
→ copies only, no commit (c-AC-5); removed canonical reconciles its copy and the
watcher keeps running (c-AC-6); the service is active for the whole process life
(c-AC-7 — the bootstrap's `start()` already guarantees this).

**Tests:** temp dirs + a real temp git repo; use **vitest fake timers** for the
debounce/sweep windows. Watcher choice is yours (chokidar or `node:fs.watch`) —
prefer cross-platform reliability (Windows dev host). Git: prefer shelling out to
`git` (no dep).

---

## 4. 004d — Runtime Path Negotiation (`middleware/runtime-path.ts`)

**Edit:** `src/daemon/runtime/middleware/runtime-path.ts` (replace the stub body).
**Test:** `tests/daemon/runtime/middleware/runtime-path.test.ts` (new file).
**Do NOT edit:** `server.ts`, `index.ts`.

**Implement** (keep export names — the bootstrap imports all three):

- `RuntimePathService` — the claim-map service (already declared; `start`/`stop`
  match `DaemonService`). Implement `claim` / `activePath` / `start` / `stop`.
- `runtimePathMiddleware(service, getMode)` — **keep this signature.** The
  bootstrap mounts it exactly so, ahead of permission, on every session group.
  Replace the pass-through body with: read `x-honeycomb-runtime-path` + session
  id, claim, and reject/409 before the handler.
- Keep `noopRuntimePathService` exported (the bootstrap default).

**Behaviour (PRD-004d / D-2):** a request without a valid `x-honeycomb-runtime-path`
is rejected BEFORE any session handler (d-AC-4), with no capture write (d-AC-7);
first path to touch a session claims it, a different path → 409 (d-AC-1); a claim
past TTL (default 4h, sweep ~5min, D-2) is swept and the session reclaimable
(d-AC-2); the holder re-requesting its own session refreshes the timestamp
(d-AC-3 / d-AC-6); a diagnostics query reports the active claimed path (d-AC-5).

**Where it's already mounted:** `server.ts` mounts `runtimePathMiddleware` ahead
of permission middleware on every group with `session: true` (`/api/memories`,
`/memory`, `/api/hooks`, `/mcp`). You do not change the mount; you give the
middleware behaviour. The mount-ahead-of-permission order is what makes the 409
fail-closed before any handler or capture write.

---

## 5. Testing posture (verification = in-process, no real network)

- **Server/middleware:** build a daemon with `createDaemon({ … })` and exercise
  `daemon.app.request("/path", { headers })` — no socket. Assert on the `Response`
  (status + JSON body) and on `daemon.logger.recent()` for log assertions.
- **Storage-backed services (004b):** use the fake transport
  (`tests/helpers/fake-deeplake.ts`): `new FakeDeepLakeTransport()`, enqueue
  scripted responses (or pass a SQL-aware `responder`), build a `StorageClient`
  via `createStorageClient({ transport: fake, provider })`, and pass it as your
  service dep. Assert on `fake.requests` for the exact SQL + scope that went out.
- **Watcher (004c):** temp dirs + temp git repo + `vi.useFakeTimers()`.
- **Mode-dependent behaviour:** construct daemons in `local` / `team` / `hybrid`
  via `createDaemon({ config: { host, port, mode, widened } })` (or inject a
  resolved `RuntimeConfig`). Permission middleware reads the mode through a thunk,
  so one daemon per mode is enough.
- **No `.skip` / `.only`.** `vitest run` is CI. Live integration tests use the
  `.itest.ts` suffix under `tests/integration/` (run only by `test:integration`).
- Name each test after the AC it proves (e.g. `b-AC-1 …`) so the ledger maps
  one-to-one to a passing test.

---

## 5a. Attaching route handlers later (PRD-005+ — not Wave 2, but the same seam)

Wave 2 fills services/middleware, not route bodies. For completeness (and because
004d reads the session-group list): a later module attaches a real handler to a
scaffolded group via `daemon.group(base)`, which returns a Hono router bound to
the root app at `base`:

```ts
daemon.group("/api/memories")?.get("/:id", handler); // registers /api/memories/:id
```

The handler inherits the permission middleware (and, for a session group, the
runtime-path middleware) the bootstrap already mounted at `${base}/*` — no
re-wiring (a-AC-6). An unfilled path under a known group falls through to the
root 501 scaffold. `daemon.group()` returns `undefined` for an unknown prefix.
The session groups (behind 004d's middleware) are: `/api/memories`, `/memory`,
`/api/hooks`, `/mcp`.

## 6. The bootstrap files you must NOT touch (shared-file contention seams)

`server.ts` (mounts every group + middleware + /health + /api/status),
`index.ts` (the daemon public surface + `runDaemon`), `config.ts`, `logger.ts`,
`middleware/permission.ts`, and `services/types.ts`. All three Wave-2 services
flow into the daemon through injection — there is no edit to make in any of these.
If you think you need to edit one, you've found a seam gap: flag it rather than
editing, so the parallel wave stays contention-free.
