# PRD-081e: Runtime Lifecycle Ownership

> **Parent:** [PRD-081: Daemon Assembly Modularization](./prd-081-daemon-assembly-modularization-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** XL (3-5 focused days)
> **Schema changes:** None
> **Blocked by:** PRD-081a through PRD-081d

---

## Overview

This is the highest-risk PRD-081 wave. It extracts health/graph/maintenance timers, background-worker
ownership, hibernation pause/resume wiring, and the returned `start()`/`shutdown()` methods from
`assembleDaemon()`.

The existing lifecycle is not rewritten. Its sequence, gates, error boundaries, mutable handles, and
idempotence are encoded in focused runtime objects and then orchestrated by one lifecycle controller.
Construction still occurs before lifecycle creation; no extracted runtime reaches back into `assemble.ts`
or discovers dependencies globally.

---

## Goals

- Give maintenance timers one owner with explicit arm, pause/resume, and stop operations.
- Give worker/coordinator handles one owner with explicit build/start/stop behavior.
- Give hibernation registration one owner and preserve the exact pausable set.
- Give top-level lifecycle sequencing one controller whose order is directly tested.
- Keep `AssembledDaemon.start()` and `.shutdown()` signatures and idempotence unchanged.
- Preserve fail-soft worker construction, fallback behavior, and partial/injected worker semantics.
- Preserve capture flush and lock release boundaries.

## Non-Goals

- No lifecycle semantic fix. In particular, this wave does not redesign behavior after an awaited health
  probe or `startServices()` failure.
- No replacement of timers with a scheduler framework.
- No new `DaemonService` registration or edit to `services/types.ts`.
- No queue polling, retry, lease, backoff, consolidation, or hibernation policy change.
- No change to health response shape or event names.
- No use of process-global singleton runtimes.

## User stories

- As a daemon operator, I want startup, hibernation, wake, and shutdown to retain their proven order so that
  the structural refactor does not lose writes, leak handles, or leave stale locks.
- As a feature engineer, I want one explicit lifecycle registration point so that a new background component
  has a clear start, pause/resume, stop, and close contract.
- As a reviewer, I want trace-based lifecycle tests so that ordering changes are intentional and visible.

---

## Target runtime components

### `assembly/maintenance-runtime.ts`

Owns:

- cached health refresh and interval;
- initial/periodic codebase graph build and in-flight guard;
- pollinating maintenance tick;
- lifecycle reverify tick;
- access-log compaction tick;
- calibration refit tick and shared provider invalidation;
- timer creation, `unref`, cancellation, re-arm, and state reset.

Proposed surface:

```ts
interface MaintenanceRuntime {
  readonly startInitial: () => Promise<void>;
  readonly startBackground: () => void;
  readonly pausables: () => readonly Pausable[];
  readonly stop: () => void;
}
```

The final surface may expose narrower methods so health/graph can start before daemon services and the other
ticks after background-worker gating. One `start()` that obscures this order is not acceptable.

### `assembly/worker-runtime.ts`

Owns mutable handles for:

- summary worker;
- memory-pipeline worker;
- skillify worker;
- pollinating worker;
- optional consolidated lease coordinator;
- resolved poll backoff and consolidation selection;
- Portkey late binding and provider health updates as they affect worker construction;
- fail-soft fallback that starts a deferred pipeline loop if pollinating/coordinator construction fails.

Proposed surface:

```ts
interface WorkerRuntime {
  readonly start: () => Promise<void>;
  readonly pausables: () => readonly Pausable[];
  readonly stop: () => void;
}
```

Construction factories from 081c are injected. `worker-runtime.ts` does not rebuild their feature internals.

### `assembly/hibernation-runtime.ts`

Owns:

- creation of `DeepLakeHibernation`;
- adaptation of worker/timer/outbox handles to labeled pausables;
- secret-free logging of hibernate/wake/pause/resume errors;
- immediate outbox kick after resume;
- idempotent start/stop and clearing the active controller on shutdown.

### `assembly/lifecycle.ts`

Owns:

- `started` and `locked` state;
- canonical top-level start sequence;
- canonical top-level shutdown sequence;
- early return when already started;
- `startBackgroundWorkers:false` boundary;
- lock release last.

It receives already constructed daemon/resources/runtimes through a typed `DaemonLifecycleDeps`. It does not
receive the complete `AssembleDaemonOptions` and it does not create feature resources.

---

## Canonical startup sequence

The following order is preserved exactly:

1. Return immediately when `started` is already true.
2. Acquire the single-instance lock before any health, graph, service, outbox, timer, inference, worker, or
   hibernation work.
3. Mark `locked = true` and `started = true` as the current implementation does.
4. If storage health probing is enabled:
   1. start the initial health refresh;
   2. await it only when `awaitInitialHealthProbe` is true;
   3. arm the periodic health interval.
5. If graph auto-build is enabled:
   1. fire the initial graph rebuild off the readiness path;
   2. arm the graph interval.
6. Await `daemon.startServices()`.
7. If `startBackgroundWorkers` is false, return at this exact boundary.
8. Start the capture-outbox drainer when present.
9. Start the memory-outbox drainer when present.
10. Arm pollinating maintenance.
11. Arm reverify maintenance.
12. Arm access-log compaction maintenance.
13. Arm calibration-refit maintenance.
14. Resolve poll backoff and consolidation, falling back to safe defaults on malformed configuration.
15. Resolve Portkey settings/status and set or clear the stable late-bound Cohere reranker.
16. Build/start the summary worker when enabled, inside its existing fail-soft boundary.
17. Build the pipeline worker when enabled. Start it immediately unless consolidated polling defers its own
    loop.
18. Build/start the skillify worker when enabled, inside its existing fail-soft boundary.
19. Migrate the DeepLake token into a real vault when eligible, without gating daemon availability.
20. Build the pollinating worker when enabled.
21. Select one of the existing polling paths:
    - consolidated real workers: create/start one lease coordinator;
    - independent/injected path: start pollinating and pipeline loops independently;
    - pollinating build failure after pipeline deferral: start the pipeline loop as fallback.
22. Build the full hibernation pausable set.
23. Start the hibernation controller when enabled.

---

## Canonical shutdown sequence

The following order is preserved exactly:

1. Flush the exact capture handler returned by route assembly while storage/services remain available.
2. Stop and clear hibernation before stopping any pausable so a wake cannot race teardown.
3. Stop and clear the consolidated lease coordinator.
4. Stop and clear the pollinating worker.
5. Stop and clear the summary worker.
6. Stop and clear the pipeline worker.
7. Stop and clear the skillify worker.
8. Clear the health interval.
9. Clear the graph interval.
10. Stop and clear pollinating maintenance.
11. Stop and clear reverify maintenance.
12. Stop and clear access-log compaction maintenance.
13. Stop and clear calibration maintenance.
14. If started, await `daemon.stopServices()` and set `started = false`.
15. Await local queue stop.
16. Close capture outbox.
17. Close memory outbox.
18. Close log store.
19. If locked, release the single-instance lock and set `locked = false`.

Capture outbox and memory outbox `close()` retain responsibility for stopping their own drain intervals if
that is the current contract. This wave does not insert new close operations or change close order.

---

## Hibernation pausable set

The exact active driver is registered, never both alternatives:

- consolidated lease coordinator, or independent pipeline/pollinating worker loops;
- pollinating maintenance tick;
- lifecycle reverify tick;
- access-log compaction tick;
- calibration refit tick;
- health probe interval;
- graph build interval;
- capture-outbox drainer when present;
- memory-outbox drainer when present.

On outbox resume, the interval is re-armed and an immediate drain kick occurs. Timer handles are re-created,
not resumed after cancellation. All pause/resume/stop operations remain idempotent and fail-soft.

---

## Files touched

### New files

- `src/daemon/runtime/assembly/maintenance-runtime.ts`
- `src/daemon/runtime/assembly/worker-runtime.ts`
- `src/daemon/runtime/assembly/hibernation-runtime.ts`
- `src/daemon/runtime/assembly/lifecycle.ts`

### Modified files

- `src/daemon/runtime/assemble.ts`: remove timer helpers, mutable lifecycle handles, and returned lifecycle
  bodies; construct runtimes and delegate to the lifecycle controller.

### Tests

- `tests/daemon/runtime/assembly/start-order.test.ts`
- `tests/daemon/runtime/assembly/shutdown-order.test.ts`
- `tests/daemon/runtime/assembly/maintenance-runtime.test.ts`
- `tests/daemon/runtime/assembly/worker-runtime.test.ts`
- `tests/daemon/runtime/assembly/hibernation-runtime.test.ts`
- existing `tests/daemon/runtime/assemble-hibernation.test.ts`
- existing worker, telemetry, health, queue, outbox, and lifecycle suites.

---

## Detailed implementation plan

1. Confirm the 081a start/shutdown trace tests pass against the unextracted implementation.
2. Extract maintenance state and helpers first. Move health refresh, graph rebuild, interval/tick arm functions,
   in-flight state, and stop/reset behavior into `maintenance-runtime.ts`.
3. Preserve phase-specific methods so health/graph start before services while pollinating/lifecycle ticks
   start only after the background-worker gate.
4. Add direct fake-timer tests for repeated arm, pause, resume, and stop. Assert one live handle per concern.
5. Extract worker mutable handles and build/start/stop decisions into `worker-runtime.ts` using 081c factories.
6. Preserve one independent fail-soft boundary per worker build and the exact stderr/logger behavior.
7. Add a matrix for `startSummaryWorker`, `startPipelineWorker`, `startSkillifyWorker`, and
   `startPollinatingWorker` combinations.
8. Add consolidation tests for:
   - two real workers -> one coordinator;
   - consolidation disabled -> independent loops;
   - injected pollinating worker -> independent lifecycle;
   - pollinating build failure after pipeline deferral -> pipeline fallback starts.
9. Extract hibernation adapter construction. Accept already-built pausables; do not let hibernation discover
   workers or timers by reading root state.
10. Prove the pausable labels and set match the pre-move set and that coordinator/independent alternatives
    are mutually exclusive.
11. Extract the top-level lifecycle controller last. Move `started` and `locked` into its closure/object.
12. Pass the exact route-mounted capture handler into lifecycle. Do not create a second flush abstraction.
13. Translate the pre-existing start body one sequence block at a time and run the trace test after each
    block.
14. Translate shutdown separately after startup is green. Run the shutdown trace after each ownership group.
15. Test repeated `start`, repeated `shutdown`, shutdown without background workers, and shutdown after a
    partial injected lifecycle setup.
16. Pin current partial-start exception behavior rather than adding cleanup logic in this structural wave.
17. Search `assemble.ts` for remaining timer/worker handle mutation. Only orchestration/runtime construction
    references may remain.
18. Run `npm run format`, `npm run ci`, `npm run build`, and the daemon/local-queue smokes.

---

## Test plan

| Concern | Required proof |
|---|---|
| Lock boundary | No lifecycle event occurs before lock acquisition. |
| Initial work | Awaited/unawaited health and fire-and-forget graph behavior retain configuration semantics. |
| Service boundary | Services start before background work; `startBackgroundWorkers:false` returns immediately afterward. |
| Worker gates | Every enabled/disabled combination builds and starts exactly the intended workers. |
| Consolidation | Coordinator and independent loops are mutually exclusive except the documented injected-worker path. |
| Fail-soft builds | One worker build failure does not prevent later worker construction or daemon availability. |
| Reranker binding | Recall retains one stable delegate; Portkey on sets its inner implementation, off/failure clears it. |
| Maintenance | Every timer has at most one live handle and can stop/re-arm cleanly. |
| Hibernation | Exact pausable set, no duplicate driver, immediate outbox kick on wake, no wake during shutdown. |
| Capture flush | Flush is first and occurs while services/storage are available. |
| Shutdown | Exact 19-step trace and lock release last. |
| Idempotence | Second start is a no-op; second shutdown is safe; repeated pause/resume does not duplicate work. |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| e-AC-1 | Health, graph, pollinating, reverify, access-compaction, and calibration handles move to one maintenance runtime with unchanged start/pause/resume/stop behavior. |
| e-AC-2 | Summary, pipeline, skillify, pollinating, and coordinator handles move to one worker runtime with unchanged gates, consolidation, injected-worker behavior, and fail-soft fallbacks. |
| e-AC-3 | Hibernation moves to one runtime that registers exactly the current pausable set and never registers both coordinator and independent drivers. |
| e-AC-4 | `AssembledDaemon.start()` delegates to the lifecycle controller and produces the exact 23-step canonical start trace. |
| e-AC-5 | `startBackgroundWorkers:false` still returns after `daemon.startServices()` and before outboxes, maintenance, workers, migration, or hibernation. |
| e-AC-6 | `AssembledDaemon.shutdown()` produces the exact 19-step canonical shutdown trace with capture flush first and lock release last. |
| e-AC-7 | Start, shutdown, maintenance arm/stop, worker stop, and hibernation operations remain idempotent. |
| e-AC-8 | Current partial-start failure semantics are unchanged and any desired cleanup improvement is tracked separately. |
| e-AC-9 | No timer, worker, coordinator, outbox, store, or lock handle is duplicated or leaked across repeated lifecycle operations. |
| e-AC-10 | Existing health, telemetry, hibernation, local queue, outbox, pipeline, pollinating, summary, skillify, and assembly tests pass unchanged. |
| e-AC-11 | Every new source file carries the license header and no lifecycle module imports `assemble.ts`. |
| e-AC-12 | `npm run ci`, `npm run build`, `npm run smoke:daemon-bundle`, and both local-queue upgrade smokes pass. |

---

## Rollback

Keep maintenance, worker runtime, hibernation, startup, and shutdown extraction in separately revertible
commits. If startup regresses, revert lifecycle delegation before modifying feature workers. If shutdown
regresses, revert the shutdown extraction while retaining already-green maintenance/worker modules. No data
rollback is required.

## Open questions

None for this behavior-neutral wave. Cleanup after a failed awaited startup step is explicitly deferred to a
separate behavior-change requirement rather than combined with lifecycle movement.
