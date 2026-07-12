# PRD-081: Daemon Assembly Modularization

> **Status:** Backlog
> **Priority:** P1
> **Effort:** XL (planning range: 9-15 focused engineer-days, including review and stabilization)
> **Schema changes:** None
> **Created:** 2026-07-12
> **Primary source:** `src/daemon/runtime/assemble.ts`

---

## Overview

Honeycomb's production daemon composition root has accumulated the wiring for storage, authentication,
tenancy, queues, outboxes, embeddings, inference, route installation, background workers, maintenance,
hibernation, health, startup, and shutdown in one 4,445-line file. The code remains strongly tested and
operational, but the concentration has become a delivery risk: routine feature work repeatedly edits the
same file, unrelated responsibilities share one import graph, and reviewers must reason about route order,
resource identity, and lifecycle order while reading changes that often affect only one feature.

PRD-081 decomposes `src/daemon/runtime/assemble.ts` into cohesive, daemon-only modules while preserving
`assemble.ts` as the stable public compatibility facade and visible top-level orchestration. This is a
behavior-neutral structural refactor. It adds no endpoint, configuration flag, schema, storage operation,
worker behavior, or product capability.

The final composition root must remain explicit. It will continue to show the production sequence:

```text
normalize options
  -> construct storage and local resources
  -> create the daemon
  -> install middleware and feature surfaces in canonical order
  -> construct maintenance, worker, and hibernation runtimes
  -> expose ordered start() and shutdown()
```

The target is not a service locator, plugin registry, or generic dependency-injection container. The target
is a small, readable composition root that delegates feature-owned construction and lifecycle ownership to
narrow factories with explicit dependency contracts.

---

## Problem

### Measured source concentration

| Measure | Baseline |
|---|---:|
| `assemble.ts` physical lines | 4,445 |
| File size | 264,136 bytes |
| Import declarations | 122 |
| Imported bindings | 251 |
| Top-level exported declarations | 23 |
| `AssembleDaemonOptions` fields | 26 |
| `SeamFns` mount/attach fields | 29 |
| `assembleSeams` span | 663 lines (`1254-1916`) |
| `assembleDaemon` span | 1,550 lines (`2801-4350`) |
| `start()` span | 474 lines (`3788-4261`) |
| `shutdown()` span | 86 lines (`4263-4348`) |
| Commits touching the file among the latest 100 repository commits | 77 |

### Engineering consequences

1. **Merge contention.** Work on capture durability, memory durability, recall, lifecycle, queue cost,
   authentication, projects, assets, and dashboard operations converges on the same file.
2. **Review amplification.** A small feature wiring change is reviewed in the context of 4,000-plus lines
   and hundreds of imports.
3. **Ownership blur.** Memory lifecycle adapters and pipeline worker builders live in the generic
   composition root instead of their feature domains.
4. **Hidden ordering constraints.** Hono route registration order, non-waking middleware placement,
   startup sequencing, hibernation pause/resume, and shutdown sequencing are encoded procedurally inside
   long bodies.
5. **Large dependency surface.** The root imports implementation details from nearly every runtime domain,
   making boundary violations and accidental coupling harder to see.
6. **High-risk future growth.** Every new daemon feature has an obvious but unhealthy landing point:
   another import, option, seam field, mount call, worker handle, timer, or shutdown branch in `assemble.ts`.

---

## Code-grounded baseline state

| Area | Existing symbols / lines | Required preservation |
|---|---|---|
| Public contracts | `AGENT_CONFIG_FILE_NAME`, lock/PID constants, `AssembleDaemonOptions`, `SeamFns`, `defaultSeamFns`, `AssembledDaemon` at `assemble.ts:295-857` | Existing imports from `runtime/assemble.js` and `@honeycomb/daemon` continue to compile unchanged. |
| Single-instance guard | `DaemonAlreadyRunningError`, `acquireSingleInstanceLock`, `releaseSingleInstanceLock` at `assemble.ts:860-996` | Legacy lock continuity, stale-PID handling, and acquire-before-start ordering remain unchanged. |
| Auth composition | `composeAuthenticator`, `authForMode` at `assemble.ts:1015-1046` | Local open mode and team/hybrid fail-closed behavior remain unchanged. |
| Recall lifecycle adapters | access recording, activation, staleness readers at `assemble.ts:1066-1238` | Query scope, SQL guards, batching, and fail-soft behavior remain unchanged. |
| Route installation | `assembleSeams` at `assemble.ts:1254-1916`; operational mounts at `3417-3626` | Every route is mounted once, in the same order and under the same gates and individual failure boundary. |
| Product/vault/inference dependencies | `resolveProductDataDeps` and vault/Portkey readers at `assemble.ts:1937-2363` | Secret boundaries, local scope fallback, vault precedence, and fail-soft reads remain unchanged. |
| Worker construction | pollinating, summary, pipeline, and skillify builders at `assemble.ts:2371-2791` | Exact dependencies, model fallbacks, tracking, outbox wiring, and logging remain unchanged. |
| Resource construction | `assembleDaemon` pre-lifecycle body at `assemble.ts:2801-3777` | Read/write clients remain distinct; shared objects preserve identity; middleware and mount placement remain unchanged. |
| Startup | returned `start()` at `assemble.ts:3788-4261` | Lock, health, graph, services, outboxes, maintenance, workers, Portkey, migration, consolidation, and hibernation order remain unchanged. |
| Shutdown | returned `shutdown()` at `assemble.ts:4263-4348` | Capture flush occurs first; hibernation stops before workers; services drain before local stores close; lock releases last. |
| Tenancy | `resolveDaemonTenancy`, `createLiveDaemonScope` at `assemble.ts:4354-4445` | Boot and live-reload scope behavior remain unchanged. |

---

## Goals

- Preserve `src/daemon/runtime/assemble.ts` as the only stable source import path for the existing public
  assembly API while reducing it to explicit orchestration and re-exports.
- Reduce `assemble.ts` from 4,445 lines to no more than 600 physical lines without compressing logic or
  replacing explicit sequencing with opaque registries.
- Move generic daemon concerns into `src/daemon/runtime/assembly/` and feature-specific construction into
  the owning runtime domains.
- Preserve every public export, option default, route, middleware placement, health signal, worker gate,
  fail-soft boundary, lifecycle transition, and generated bundle entrypoint.
- Replace the 24-argument `assembleSeams(...)` call with a named dependency object internally while
  retaining a compatibility wrapper for existing callers and tests.
- Make route order and start/shutdown order executable contracts rather than facts inferred from one long
  function.
- Give each resource an explicit owner responsible for its creation, start/pause/resume behavior, stop,
  and close behavior.
- Keep DeepLake access confined to the daemon and keep services dependent on `StorageQuery`/`StorageClient`
  abstractions rather than transports.
- Keep each implementation wave independently reviewable, revertible, and green under the full quality
  gate.

## Non-Goals

- No decomposition of `src/daemon/runtime/memories/recall.ts`; that requires a separate PRD after PRD-081.
- No new product feature, endpoint, route, table, column, event, environment variable, CLI option, or UI.
- No behavioral fix bundled into the moves, including known lifecycle or network issues discovered by
  unrelated audits.
- No change to `server.ts`, `index.ts`, `config.ts`, `logger.ts`, `middleware/permission.ts`, or
  `services/types.ts` to create new service seams.
- No inversion-of-control container, runtime reflection, dynamic feature loading, decorator framework,
  plugin registry, or generic `Record<string, unknown>` assembly context.
- No weakening of TypeScript types to make moved code compile. `any`, non-null assertions, and broad casts
  are not migration tools.
- No moving tests merely to make the tree look symmetrical. Existing behavior tests keep importing the
  compatibility facade unless they specifically test a new internal module.
- No hand-editing built outputs under `daemon/`, `bundle/`, `mcp/bundle/`, harness bundles, or
  `embeddings/embed-daemon.js`.
- No lifecycle promotion of this PRD folder to `in-work/` until implementation actually begins.

## User stories

- As a Honeycomb contributor, I want the composition root organized by responsibility so that a feature
  wiring change touches its owning module rather than a 4,445-line shared hotspot.
- As a reviewer, I want route, identity, and lifecycle ordering expressed as executable contracts so that a
  structural change can be reviewed without re-deriving every invariant from one long function.
- As a daemon operator, I want the refactor to be behavior-neutral so that startup, recall, capture, queues,
  maintenance, hibernation, and shutdown behave identically.
- As a release owner, I want each extraction wave independently green and revertible so that the work does
  not become a single high-risk merge event.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-081a-daemon-assembly-modularization-contract-and-safety-net`](./prd-081a-daemon-assembly-modularization-contract-and-safety-net.md) | Freeze the public surface and add characterization coverage for exports, identity, route order, startup, shutdown, and failure isolation. | Draft |
| [`prd-081b-daemon-assembly-modularization-foundation-extractions`](./prd-081b-daemon-assembly-modularization-foundation-extractions.md) | Move instance locking, auth composition, state paths, and tenancy into leaf assembly modules with facade re-exports. | Draft |
| [`prd-081c-daemon-assembly-modularization-feature-builders`](./prd-081c-daemon-assembly-modularization-feature-builders.md) | Move memory lifecycle adapters, product/vault/inference dependency construction, and worker builders to cohesive owners. | Draft |
| [`prd-081d-daemon-assembly-modularization-route-mount-coordinator`](./prd-081d-daemon-assembly-modularization-route-mount-coordinator.md) | Replace positional route wiring with grouped, explicitly ordered mount coordinators while preserving every gate and failure boundary. | Draft |
| [`prd-081e-daemon-assembly-modularization-runtime-lifecycle`](./prd-081e-daemon-assembly-modularization-runtime-lifecycle.md) | Extract maintenance, worker, hibernation, startup, and shutdown ownership without changing lifecycle order. | Draft |
| [`prd-081f-daemon-assembly-modularization-composition-root-closeout`](./prd-081f-daemon-assembly-modularization-composition-root-closeout.md) | Normalize resource construction, reduce the facade to explicit orchestration, run full verification, and document the new extension pattern. | Draft |

---

## Target source layout

```text
src/daemon/runtime/
  assemble.ts                         # compatibility facade and visible orchestration
  assembly/
    contracts.ts                      # public assembly contracts
    instance-lock.ts                  # PID/lock ownership
    state-paths.ts                    # workspace, vault, queue, agent config paths
    auth.ts                           # mode-aware authenticator/policy composition
    tenancy.ts                        # boot and live scope resolution
    storage-resources.ts              # provider, read client, write client, scope
    operational-resources.ts          # migration, log/fleet stores, logger, runtime settings
    queue-resources.ts                # shared/local/hybrid queue construction if split is needed
    feature-resources.ts              # outboxes, counters, trackers, triggers, shared holders
    service-resources.ts              # daemon service construction and embed preference reconcile
    health-state.ts                   # shared mutable health cells and live projections
    product-data.ts                   # product/secrets/sources dependency construction
    maintenance-runtime.ts            # health, graph, and maintenance timer ownership
    worker-runtime.ts                 # worker/coordinator build-start-stop ownership
    hibernation-runtime.ts            # pausable collection and idle controller
    lifecycle.ts                      # canonical start/shutdown sequence
    mounts/
      contracts.ts                    # SeamFns and named mount dependency groups
      defaults.ts                     # one canonical production seam mapping
      core.ts                         # capture, dashboard, notifications, logs, prune
      setup.ts                        # local-only setup and tenancy setup routes
      memory.ts                       # memories, VFS, product, pollinate, projects
      diagnostics.ts                  # compact, stale-ref, lifecycle and queue diagnostics
      integrations.ts                 # graph, harness, sync, ontology, skills, assets
      index.ts                        # explicit canonical coordinator
  memories/
    recall-lifecycle-sources.ts        # access, activation, and staleness storage adapters
    index-assembly.ts                  # optional local ANN construction/cold build
  inference/
    assembly-contracts.ts             # narrow Portkey/reranker build contracts
    reranker-runtime.ts               # stable late-bound Cohere delegate
  vault/
    assembly-settings.ts              # vault settings and Portkey/provider selection
  pipeline/
    assembly.ts                       # pipeline worker construction
  pollinating/
    assembly.ts                       # pollinating worker construction
  skillify/
    assembly.ts                       # skillify worker construction
  summaries/
    assembly.ts                       # summary worker construction
```

All new TypeScript source files must start with the comment-wrapped AGPL header from
`docs/license-header.txt`.

---

## Functional requirements

1. `src/daemon/runtime/assemble.ts` must continue exporting the same runtime values and TypeScript types
   consumed by `src/daemon/index.ts`, deterministic tests, and live integration tests.
2. `src/daemon/index.ts` must not require a new import path and its public re-export list must remain
   source-compatible.
3. The daemon must still construct one read storage client and one independently bounded write storage
   client in production, with injected-storage tests retaining their baseline fallback behavior.
4. `createDaemon(...)` must execute before the wildcard waking middleware is registered, and the wildcard
   middleware must remain before all work-carrying route mounts so `/health` and `/api/status` stay
   non-waking.
5. Every existing mount/attach operation must execute exactly once, under the same mode, presence, and
   resource gates, in the same effective order.
6. Each existing fail-soft mount or worker-build boundary must retain its own catch/log behavior. One
   failed optional surface must not suppress sibling surfaces.
7. The capture handler returned by route assembly must remain the exact object flushed first during
   shutdown.
8. `keepBothMemo`, `calibrationModelProvider`, `ProjectsViewCache`, queue instances, outboxes, and other
   intentionally shared objects must retain object identity across all consumers.
9. Startup must remain idempotent and acquire the instance lock before starting any service or background
   task.
10. `startBackgroundWorkers: false` must retain its early-return behavior after daemon services start and
    before outboxes, maintenance, workers, or hibernation start.
11. Worker consolidation must retain its baseline union-kind coordination and injected-worker exception.
12. Hibernation must pause and resume the same DeepLake-touching components and must not duplicate timers
    or workers across wake cycles.
13. Shutdown must retain its baseline order and remain safe after a partial start, repeated shutdown, or an
    injected no-op implementation.
14. No moved module outside `src/daemon/` may import the storage implementation, and no moved module may
    import `storage/transport.ts` directly.
15. Build outputs and package contents must remain equivalent apart from source-map/module-layout changes
    produced by the normal build.

---

## Module-level acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Every pre-PRD-081 import from `src/daemon/runtime/assemble.js` and every re-export from `src/daemon/index.ts` compiles without caller changes. |
| AC-2 | `assemble.ts` contains no more than 600 physical lines and contains only compatibility exports, option normalization, phase construction calls, `createDaemon`, canonical mount invocation, and lifecycle return wiring. |
| AC-3 | All functions in the source-provenance table are present exactly once in their destination modules; no duplicate implementation remains in `assemble.ts`. |
| AC-4 | A recording-seam test proves every existing route mount runs exactly once in the canonical order and that one optional mount throwing does not prevent later sibling mounts. |
| AC-5 | A middleware-order test proves `/health` and `/api/status` remain non-waking and a work-carrying route still touches hibernation after the wildcard middleware is installed. |
| AC-6 | An identity test proves the same `keepBothMemo`, calibration provider, projects cache, read/write clients, and capture handler reach all intended consumers. |
| AC-7 | A startup-order test proves lock -> initial health/graph work -> daemon services -> outboxes/maintenance -> workers/coordinator -> hibernation, including the `startBackgroundWorkers:false` early return. |
| AC-8 | A shutdown-order test proves capture flush -> hibernation -> coordinator/workers -> timers -> daemon services -> local queue -> outboxes/log store -> lock release. |
| AC-9 | Existing local/team/hybrid authorization, tenancy, setup-route gating, secret handling, and scope fallback tests pass unchanged. |
| AC-10 | Existing local queue, outbox, pollinating, pipeline, summary, skillify, recall lifecycle, project, asset, and dashboard assembly tests pass unchanged. |
| AC-11 | `npm run typecheck`, `npm run dup`, `npm test`, and `npm run audit:sql` pass through `npm run ci`. |
| AC-12 | `npm run build`, `npm run smoke:daemon-bundle`, `npm run smoke:local-queue-upgrade`, `npm run smoke:local-queue-packaged-upgrade`, and `npm run pack:check` pass. |
| AC-13 | No new SQL statement, DeepLake schema mutation, local SQLite schema mutation, HTTP route, environment variable, or public API is introduced. |
| AC-14 | Every new source file carries the required license header and passes Biome formatting. |
| AC-15 | The PRD-081 QA report can map every sub-PRD criterion to code and a meaningful test without relying solely on `assemble.ts` line count. |

---

## Resolved decisions

| ID | Decision |
|---|---|
| D-1 | **Compatibility facade.** `src/daemon/runtime/assemble.ts` remains the stable import path and re-exports moved symbols. Callers do not migrate during this PRD. |
| D-2 | **Mechanical waves.** Each implementation wave moves behavior without redesigning it. Signature normalization and ownership improvements occur only where specified by a sub-PRD. |
| D-3 | **Explicit orchestration.** The root and mount coordinator remain imperative and ordered. No dynamic registry or generic plugin loop hides route or lifecycle order. |
| D-4 | **Feature ownership.** Memory adapters and worker builders move to their owning domains; generic process concerns move under `runtime/assembly/`. |
| D-5 | **Named internal dependency objects.** New internal factories receive cohesive typed dependency objects. The old positional `assembleSeams` form remains as a compatibility wrapper until closeout. |
| D-6 | **Narrow contexts.** There is no single all-purpose `AssemblyContext`. Storage, operational, mount, worker, and lifecycle dependency groups remain distinct. |
| D-7 | **Behavioral order is API.** Route order, middleware order, start order, pause/resume order, and shutdown order are treated as contracts and receive direct tests before extraction. |
| D-8 | **No feature flag.** A feature flag would duplicate the composition root and create two unmaintainable boot paths. Rollback is by reverting the independently landed mechanical wave. |
| D-9 | **Generated artifacts remain generated.** Bundles are rebuilt for verification but never edited by hand or committed solely to represent the source move unless the repository's release policy explicitly requires them. |
| D-10 | **Recall decomposition is separate.** `memories/recall.ts` stays unchanged except for any type-only import needed by the moved assembly adapter, and only if unavoidable. |

---

## Migration sequence and merge policy

1. Land 081a alone. It adds the safety net and moves only contracts/default seam declarations.
2. Land 081b as one or more leaf-only commits. No route, worker, or lifecycle body moves in the same commit.
3. Land 081c with one domain builder per commit where practical.
4. Land 081d only after the ordering and failure-isolation tests are green on the pre-move implementation.
5. Land 081e only after all earlier imports have settled. Keep startup and shutdown extraction in separate
   commits if either diff becomes difficult to review.
6. Land 081f as normalization and closeout, not as a place to add deferred behavior.
7. Rebase active branches that touch `assemble.ts` between waves rather than allowing a long-running mega
   branch to accumulate conflicts.
8. Every wave must pass `npm run ci` before the next wave begins. A red wave is reverted or corrected before
   further extraction.

---

## Rollback

No runtime feature flag is introduced. Each wave is designed to be behavior-neutral and independently
revertible. Rollback consists of reverting the latest extraction commit, which restores implementation to
the compatibility facade without data migration, schema rollback, credential changes, or queue repair.

If a regression appears after multiple waves, bisect at sub-PRD boundaries in this order:

1. Route presence/order and middleware behavior: inspect/revert 081d.
2. Worker, timer, hibernation, or shutdown behavior: inspect/revert 081e.
3. Provider, vault, inference, or feature-builder behavior: inspect/revert 081c.
4. Lock, path, auth, or tenancy behavior: inspect/revert 081b.
5. Type/export breakage only: inspect/revert 081a or 081f.

Because PRD-081 changes no durable data, rollback requires no data repair.

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Route ordering changes during grouping | A static or parameterized route may shadow a sibling; a surface may disappear. | Freeze baseline order in a recording test before moving calls; use an explicit coordinator, not an unordered map. |
| Shared object is reconstructed per module | Conflict memoization, calibration invalidation, project cache, or queue behavior diverges. | Construct shared resources once in the root/resource factory and assert reference equality at consumers. |
| Failure boundaries are broadened | One optional mount or worker failure suppresses unrelated features. | Preserve each baseline try/catch and message; test a middle failure followed by successful later mounts. |
| Lifecycle ownership is split incorrectly | Duplicate timers, leaked handles, missed flush, or stale locks. | Give each extracted runtime idempotent start/stop and test the top-level order under partial and repeated lifecycle calls. |
| Import cycles appear | Typecheck or runtime initialization fails. | Keep dependency direction `contracts -> leaf builders -> coordinators -> assemble.ts`; use type-only imports for contracts. |
| Concurrent feature work edits `assemble.ts` | Merge conflicts or lost wiring. | Land small waves quickly and coordinate/rebase between waves; do not carry one multi-week refactor branch. |
| Line-count target drives over-compression | Readability worsens or order becomes hidden. | The 600-line target is subordinate to explicit orchestration and behavioral clarity; do not replace lines with opaque abstraction. |

---

## Dependencies

- [PRD-004: Daemon Runtime](../../completed/prd-004-daemon-runtime/prd-004-daemon-runtime-index.md)
- [PRD-021a: Daemon Assembly](../../completed/prd-021-go-live/prd-021a-go-live-daemon-assembly.md)
- [PRD-058: Memory Lifecycle](../../in-work/prd-058-memory-lifecycle/prd-058-memory-lifecycle-index.md)
- [PRD-062: DeepLake Compute Cost Reduction](../../completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md)
- [PRD-066: Local Queue Idle-Cost Control](../../in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md)
- [PRD-077: Per-Turn Recall Fast Path](../prd-077-per-turn-recall-fast-path/prd-077-per-turn-recall-fast-path-index.md)
- [PRD-079: Durable Capture Retry Queue](../../completed/prd-079-durable-capture-retry-queue/prd-079-durable-capture-retry-queue-index.md)
- [PRD-080: Durable Controlled-Write Outbox](../../completed/prd-080-durable-controlled-write-outbox/prd-080-durable-controlled-write-outbox-index.md)
- `src/daemon/runtime/CONVENTIONS.md`
- `BUILD.md`
- `docs/license-header.txt`

---

## Open questions

None block backlog authoring. Implementation may choose exact internal factory names where the chosen name
does not alter the module ownership, dependency direction, public facade, or acceptance criteria defined
here.
