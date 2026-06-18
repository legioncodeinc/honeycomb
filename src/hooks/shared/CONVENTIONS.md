# Lifecycle hook shared core — CONVENTIONS (PRD-019b)

The agent-agnostic hook core lives under `src/hooks/shared/`. It normalizes a harness's
native lifecycle event into the `HookInput` shape, reads the device-flow credential, and
makes a LOCAL request to the daemon (`127.0.0.1:3850`) `/api/hooks/*`. Wave 1 (019b scaffold)
ships the contracts + seams + honest stubs; Wave 2 fills the five core module bodies.

**Read this file before filling the core.** It is the contract 019c (shims) and 019a
(connector handler-set) both map onto.

## The central invariant: hooks are THIN CLIENTS — never open DeepLake, never build SQL

This is the rule the whole sub-PRD is built around (FR-2 / FR-9 / b-AC-2 / D-2), and a
Wave-3 security target.

- **Module home = `src/hooks/` ON PURPOSE.** `src/hooks` is in `NON_DAEMON_ROOTS`
  (`tests/daemon/storage/invariant.test.ts`). A stray `from ".../daemon/storage"` import
  here FAILS the build — the thin-client invariant is ENFORCED, not merely a convention.
- **The `DaemonHookClient` seam is the ONLY path out to the daemon.**
  `interface DaemonHookClient { send(req): Promise<DaemonHookResponse> }` (`contracts.ts`).
  The real impl POSTs over loopback stamping `x-honeycomb-runtime-path` + session + actor
  headers; the fake (`createFakeDaemonHookClient`) records every call. A test asserts the
  daemon was reached ONLY through this seam (and that the gate short-circuited by asserting
  `.calls` is empty).
- **OK to import (pure, storage-free):** `src/shared/capture-gate.ts` (the capture gate —
  REUSE it, never re-implement), and, in Wave 2's `pre-tool-use.ts`, the `src/daemon-client/vfs/`
  `DeepLakeFs` intercept (itself a thin client that dispatches SQL THROUGH the daemon).
- **NEVER import** `createStorageClient`, `StorageClient`, or anything under `daemon/storage`
  that opens a connection.

If you find yourself importing the storage client or building SQL — STOP. Wrong direction,
Critical security finding.

## The six logical events (FR-1) — every shim maps its native names onto these

| Logical event       | Daemon endpoint (sub-path)   | Core module          |
|---------------------|------------------------------|----------------------|
| `session-start`     | `/api/hooks/session-start`   | `session-start.ts`   |
| `user_message`      | `/api/hooks/capture`         | `capture.ts`         |
| `pre-tool-use`      | (VFS via `daemon-client/vfs`)| `pre-tool-use.ts`    |
| `tool_call`         | `/api/hooks/capture`         | `capture.ts`         |
| `assistant_message` | `/api/hooks/capture`         | `capture.ts`         |
| `session-end`       | `/api/hooks/session-end`     | `session-end.ts`     |

The exact endpoint names are confirmed against the daemon `server.ts` route group
`/api/hooks` (already mounted, session+protected) when Wave 2 wires the real `DaemonHookClient`.
The daemon-side capture boundary is `src/daemon/runtime/capture/event-contract.ts` (the zod
`CaptureRequest`); a shim's normalized `HookInput.data` for a capture event maps onto that
boundary 1:1.

## The capture gate is REUSED, not re-implemented (FR-10)

`capture.ts` re-exports `runCaptureGuarded` from `src/shared/capture-gate.ts`. The gate
(`HONEYCOMB_CAPTURE !== "false"`, plugin-enabled, entrypoint, recursion-guard) DECIDES; the
core PERFORMS the (guarded) daemon call. When the gate skips, NO daemon request is made and
NO `sessions` row is written (c-AC-6). The gate is a PURE function — the shim resolves the
`CaptureGateEnv` from its own env/config/header channel and passes it in.

## Partial-vocabulary completeness (FR-7 / b-AC-1)

A harness with a partial event vocabulary still completes the lifecycle: capture BATCHED at
session end (e.g. OpenClaw's `agent_end` message slice) produces the SAME daemon-written rows
as incremental capture, just grouped into one flush. Wave 2's `runCapture` normalizes a slice
of messages down to one `HookInput` per event and dispatches each — the daemon writes one row
per event either way.

## Runtime-path stamping is structural (FR-8 / D-6)

Every hook call stamps `x-honeycomb-runtime-path` (`plugin` for a runtime extension, `legacy`
for a hook script) — carried on `HookInput.runtimePath` and forwarded by the seam. The daemon
(already built, PRD-004d `runtime-path.ts`) enforces one active path per session and returns
`409` on conflict (b-AC-6). This core STAMPS the header; it never re-tests enforcement. Drive
the 409 path in a Wave-2 test with `createFakeDaemonHookClient({ status: 409 })`.

## Read-only, fail-soft context (FR-3 / FR-10)

`context-renderer.ts` is READ-ONLY and ABSORBS its own errors — a render failure returns `""`,
never a throw. session-start threads the rendered block into `HookResult.additionalContext`;
the shim (019c) routes it through its harness's channel (model-only vs user-visible, c-AC-5).

## What Wave 2 filled (signatures are STABLE — additive only; 019c consumes them)

Wave 2 (this stream, 019b) filled the five core bodies WITHOUT changing the Wave-1
signatures, and added seams ADDITIVELY (every addition is an optional field / extra
seam / new export — nothing existing was renamed or re-typed, so 019c maps onto a
stable surface):

- `runSessionStart(input, deps: SessionStartDeps)` (b-AC-3) —
  credential→heal→autoUpdate→[gated]ensureTables→[gated]placeholder→render context→
  autoPullSkills→spawnGraphPull→return `additionalContext`. The two gated steps run
  ONLY when `shouldCapture({ captureFlag })` is true (FR-3). Every heal/update/pull
  step is FAIL-SOFT (FR-10). `SessionStartDeps extends HookCoreDeps` with two OPTIONAL
  fields (`seams`, `captureEnv`) — a plain `HookCoreDeps` still satisfies it.
- `runCapture(input, deps, env, ctx?)` + `runCaptureBatch(inputs, deps, env, ctx?)`
  (b-AC-1 / b-AC-2 / FR-4 / FR-7) — gate→dispatch to `/api/hooks/capture`; the batch
  path flushes a slice of events through the same gate+seam → the daemon writes one
  row per event, IDENTICAL to incremental (b-AC-1). A `409` is surfaced as
  `{ ok:false, reason:"runtime-path-conflict" }`, never thrown (b-AC-6 / D-6).
- `runPreToolUse(input, deps, vfs?)` (b-AC-4 / FR-5) — lowers the pre-tool payload to
  a `VfsToolOp` and routes it through the injected `VfsIntercept` seam (wraps PRD-015
  `DeepLakeFs`). grep/Glob→search, cat/Read→read, ls→list, find→find (all `replace`);
  Write/Edit→`deny`; unmodelable Bash→`rewrite` to `HARMLESS_ECHO`. There is NO
  `node:fs` import in this module — the seam is the sole route, so nothing hits the
  real filesystem (b-AC-4). `vfs` defaults to a recording fake.
- `runSessionEnd(input, deps, spawn, lock?)` (b-AC-5 / FR-6) — one daemon call to
  `/api/hooks/session-end` carrying the mark/usage/skillify intents (fail-soft), then
  acquire the `SummaryLock`, spawn the detached worker, and RELEASE the lock if the
  spawn throws before ownership (the `--resume` retrigger). `lock` defaults to a fake.
- `createContextRenderer(daemon).render` (b-AC-3 / FR-3 / FR-10) — POSTs to
  `/api/hooks/context`, coerces the body to the block text, and ABSORBS any error
  (rejected dispatch / non-200 / malformed) to `""` — read-only, never a throw.

### New ADDITIVE seams (in `contracts.ts`) 019c constructs and tests against

- `SessionStartSeams` (+ `createFakeSessionStartSeams` / `createNoopSessionStartSeams`)
  — heal/autoUpdate/ensureTables/writePlaceholderSummary/autoPullSkills/spawnGraphPull.
  The real impls already exist from prior PRDs; session-start CALLS them through the
  seam, it does NOT reimplement them.
- `VfsIntercept` + `VfsToolOp` (+ `createFakeVfsIntercept`) — the pre-tool VFS route.
- `SummaryLock` (+ `createFakeSummaryLock`) — the per-session summary lock.
- `SessionStartDeps` — the additive session-start dependency bundle.

## The daemon-side `/api/hooks/*` attach (filled this wave)

`src/daemon/runtime/capture/attach.ts` exports `attachHooksHandlers(daemon, { storage,
queue, sessionsTarget?, embed?, logger? })` — the single named seam the daemon
assembly calls AFTER `createDaemon(...)` to wire `capture-handler.ts` onto the
already-mounted `/api/hooks` route group (defaulting `sessionsTarget` to
`healTargetFor("sessions")`). BEFORE the attach the group answers the 501 scaffold;
AFTER it `/api/hooks/capture` is live (201) inheriting the runtime-path + permission
middleware. This is daemon-side (storage-correct) and additive — `createDaemon` is
unchanged and importing the daemon never auto-invokes it.

## Deferred assembly (honest deferral — mirrors PRD-015 D-9)

Constructed-and-tested behind seams; NOT wired into a running daemon or a harness
binary. NO harness is claimed wired. The deferred wiring steps:
1. the real `DaemonHookClient` (a thin loopback POST to `127.0.0.1:3850/api/hooks/*`
   stamping the runtime-path + session + actor headers),
2. the real `CredentialReader` (reads `~/.honeycomb/credentials.json`; never logs the
   token),
3. the real `ContextRenderer` is filled here but its daemon `/api/hooks/context`
   endpoint handler is a later daemon step,
4. the real `SessionStartSeams` (bind to the existing `healDriftedOrgToken`/`autoUpdate`
   /`autoPullSkills`/graph-pull impls), the real `VfsIntercept` (wrap `DeepLakeFs`),
   and the real `SummaryLock` + `SummarySpawn` (host-CLI per harness — a 019c concern),
5. the daemon assembly that constructs the live storage client + queue and calls
   `attachHooksHandlers` once.

## Daemon + hook assembly is DEFERRED (mirrors PRD-015 D-9)

Wave 1 is constructed-and-tested, not wired into the running daemon or the harness binaries.
Deferred assembly: (1) the real `DaemonHookClient` (a thin loopback POST), (2) the real
`CredentialReader` (reads `~/.honeycomb/credentials.json`), (3) the real `ContextRenderer`
(daemon-fetched block), (4) the `/api/hooks/*` daemon-side handler attach (wire
`capture-handler.ts` onto the `/api/hooks` route group if not already attached). These are
wiring steps; no contract body changes.
