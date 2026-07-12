# PRD-081f: Composition-Root Closeout and Verification

> **Parent:** [PRD-081: Daemon Assembly Modularization](./prd-081-daemon-assembly-modularization-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-2 focused days plus review/verification)
> **Schema changes:** None
> **Blocked by:** PRD-081a through PRD-081e

---

## Overview

The final wave decomposes the remaining resource-construction blocks, reduces `assemble.ts` to the visible
composition flow and compatibility exports, removes obsolete imports/comments, updates live conventions,
and runs the full deterministic, bundle, packaging, and upgrade verification matrix.

This wave is closeout, not a catch-all. Any new feature, behavioral correction, or follow-up discovered
during refactoring is recorded separately. PRD-081 ships only when the final root is smaller and clearer
without hiding construction or weakening the proven behavioral contracts.

---

## Goals

- Extract remaining storage and operational resource construction into narrow factories.
- Leave one explicit top-level flow in `assemble.ts`.
- Keep `src/daemon/index.ts` and all external assembly import paths unchanged.
- Remove unused imports and stale line-number comments introduced by moved code.
- Document the supported extension path for future mounts, workers, resources, and lifecycle handles.
- Verify source, bundles, local-queue upgrade behavior, package shape, and optional live assembly.
- Produce a complete provenance ledger for QA.

## Non-Goals

- No behavior cleanup, optimization, renamed public API, or changed configuration.
- No conversion to workspaces/packages or new path alias.
- No change to esbuild entry roots.
- No generated-output hand edits.
- No backwards rewrite of historical completed PRDs, QA reports, or execution ledgers whose line numbers
  describe their historical implementation.
- No recall-engine decomposition.

## User stories

- As a contributor, I want `assembleDaemon()` to show the complete production composition at a glance so
  that I can place a new dependency in the correct phase.
- As a release owner, I want deterministic, bundle, upgrade, and package gates recorded so that source
  movement cannot ship with a broken daemon artifact.
- As a QA reviewer, I want a complete provenance and criterion map so that moved behavior can be audited
  without reconstructing the plan from commit history.

---

## Remaining construction blocks

| Current range | Responsibility | Target owner |
|---|---|---|
| `assemble.ts:2802-2847` | Runtime config, state-root migration, log/fleet store selection, logger, runtime/lock settings, probe defaults | `assembly/operational-resources.ts` with migration order explicit |
| `assemble.ts:2859-2914` | Credential provider, read storage, write storage, boot/live tenancy and org name | `assembly/storage-resources.ts` |
| `assemble.ts:2925-2939` | Optional local ANN index construction/cold build | `memories/index-assembly.ts` or an existing local-index factory module |
| `assemble.ts:2950-3003` | Vault, shared queue, local queue, hybrid router, shared-pipeline warnings | `assembly/operational-resources.ts` or a focused `assembly/queue-resources.ts` if needed for cohesion |
| `assemble.ts:3005-3079` | Capture/memory outboxes, trackers, counters, pending-link store, pollinating trigger | `assembly/feature-resources.ts` |
| `assemble.ts:3093-3146` | Health tracker/cell, daemon services, embed preference reconciliation | `assembly/service-resources.ts` |
| `assemble.ts:3162-3222` | Health-detail live thunks and mutable Portkey/memory feature signals | `assembly/health-state.ts` |
| `assemble.ts:3234-3241` | Stable late-bound Cohere reranker delegate | `inference/reranker-runtime.ts` |
| `assemble.ts:3243-3298` | Auth/policy selection, `createDaemon`, wildcard waking middleware | Remain explicit in `assemble.ts` unless a tiny `daemon-shell.ts` improves clarity without hiding order |
| `assemble.ts:3307-3415` | Embed attachment, installed-harness resolver, shared holders/memo/provider, mount call | Root orchestration using extracted factories and coordinator |

No single `createEverything()` factory is allowed. Factories return cohesive resources with explicit types,
and the root visibly passes outputs to the next phase.

---

## Resource factory contracts

### Storage resources

```ts
interface StorageResources {
  readonly provider?: CredentialProvider;
  readonly read: StorageClient;
  readonly write: StorageClient;
  readonly scope: QueryScope;
  readonly orgName?: string;
}
```

Required behavior:

- one provider resolution;
- distinct production read/write lazy clients with their existing concurrency limits;
- injected `storage` reused as write fallback unless `writeStorage` is explicitly injected;
- live getter-backed production scope, boot-frozen injected scope;
- no token exposed in the resource result.

### Operational resources

The implementation may split queues from local stores, but ownership remains explicit:

- state-root migration completes before any state-family store opens;
- injected storage suppresses unintended real disk stores where current tests rely on it;
- log/fleet stores exist before default logger construction when the logger consumes them;
- one shared DeepLake queue, one local queue, and one hybrid queue router;
- queue routing and shared-pipeline warnings retain current gates;
- local stores remain cwd-independent where already specified.

### Feature resources

One factory may construct small root-owned shared resources when ordering is documented:

- capture dropped-events counter;
- gated-captures counter;
- pending-link store;
- memory-formation tracker;
- capture outbox;
- memory outbox;
- pollinating trigger;
- keep-both memo;
- calibration provider;
- harness plugin-status holder;
- projects view cache.

If one factory becomes a broad context, split by lifecycle/feature. Each returned field must have at least two
consumers or a clear ownership reason; otherwise construct it visibly in the root.

### Health state

One object owns mutable health cells and live read thunks:

- pipeline health bit/tracker;
- Portkey health;
- memory-feature signal;
- embed availability/reason;
- outbox counts;
- queue counts/status;
- public/detail projection inputs;
- `pipelineStatus()` getter exposed by `AssembledDaemon`.

The health object does not start timers; 081e maintenance owns refresh cadence.

### Stable reranker delegate

Recall receives one stable object before route mounting. Lifecycle may set or clear its private inner
implementation after Portkey resolution. The object identity handed to recall never changes, and Portkey off
or build failure clears any previous inner implementation.

---

## Required final `assemble.ts` shape

The exact function names may differ, but the root must read approximately as follows:

```ts
export function assembleDaemon(options: AssembleDaemonOptions = {}): AssembledDaemon {
  const base = createOperationalResources(options);
  const storage = createStorageResources(options, base);
  const features = createFeatureResources(options, base, storage);
  const health = createHealthState(...);
  const services = createServiceResources(...);
  const { authenticator, policy } = authForMode(base.config.mode, storage.read, storage.scope);

  const daemon = createDaemon({ ... });
  installActivityMiddleware(daemon, ...); // remains after createDaemon, before work routes

  const mounted = mountDaemonSurfaces({ ... });
  const maintenance = createMaintenanceRuntime({ ... });
  const workers = createWorkerRuntime({ ... });
  const hibernation = createHibernationRuntime({ ... });
  const lifecycle = createDaemonLifecycle({ mounted, maintenance, workers, hibernation, ... });

  return {
    daemon,
    config: base.config,
    pipelineStatus: health.pipelineStatus,
    start: lifecycle.start,
    shutdown: lifecycle.shutdown,
  };
}
```

The waking middleware may remain as an inline explicit block rather than a helper if that makes its order
more obvious. Clarity of load-bearing order takes precedence over line count.

---

## Final source rules

1. `assemble.ts` is no more than 600 physical lines.
2. It contains no raw SQL, route handler implementation, worker implementation, timer state machine, vault
   parser, filesystem lock implementation, or feature-specific row parsing.
3. It contains no individual feature mount call outside the one coordinator.
4. It contains no individual worker `start()`/`stop()` call outside lifecycle/runtime construction.
5. It imports no handler solely to populate `defaultSeamFns`; defaults own those imports.
6. All public facade exports are explicit.
7. No extracted module imports `assemble.ts`.
8. Dependency direction is:

```text
contracts / feature implementations
  <- leaf assembly adapters and feature builders
  <- mount/resource/lifecycle coordinators
  <- assemble.ts
  <- src/daemon/index.ts
```

9. Every new source file carries the license header.
10. Biome owns formatting; no hand-compressed code is used to reach the line target.

---

## Documentation touched

### Modified live documentation

- `src/daemon/runtime/CONVENTIONS.md`: add the new composition-root extension rules and module ownership.
- Domain `CONVENTIONS.md` files only where they describe a hard-coded old assembly location or tell future
  work to edit `assemble.ts` directly.
- `BUILD.md` only if module movement changes documented source layout; entry roots and build order remain
  unchanged.

### Not modified

- Historical completed PRDs, QA reports, and execution ledgers retain their original evidence and line
  references.
- `library/notes/` remains human-only.
- Generated bundles are not documentation sources.

Live comments should refer to stable symbols/modules rather than new hard-coded line numbers. For example,
prefer "wired by `assembleDaemon` through `assembly/mounts/index.ts`" over "wired at `assemble.ts:3405`."

---

## Files expected to remain unchanged

The compatibility design aims to leave these source contracts unchanged:

- `src/daemon/index.ts`
- `src/daemon/runtime/server.ts`
- `src/daemon/runtime/config.ts`
- `src/daemon/runtime/logger.ts`
- `src/daemon/runtime/middleware/permission.ts`
- `src/daemon/runtime/services/types.ts`
- all harness, CLI, MCP, SDK, and daemon-client import paths.

If implementation discovery appears to require changing one of these files, stop the wave and document the
seam gap before editing it.

---

## Detailed implementation plan

1. Re-run all PRD-081 characterization suites before closeout changes.
2. Extract storage resources first. Preserve one provider resolution and read/write fallback behavior.
3. Extract state migration and operational-store construction. Add a real composition test proving migration
   precedes opening log, telemetry, queue, outbox, and vault state families; the existing manual ordering test
   alone is insufficient.
4. Extract queue resources only if the operational factory becomes too broad. Preserve one shared queue,
   one local queue, and one hybrid router.
5. Extract local ANN index assembly to the memory domain if it remains in the root. Preserve real-assembly
   gating, fire-and-forget cold build, and fail-soft logging.
6. Extract feature resources in dependency order. Construct `memoryFormation` before any callback that closes
   over it. Construct each shared holder exactly once.
7. Extract health state without moving health timers. Prove public/detail/telemetry getters read the same
   mutable cells.
8. Extract the stable reranker delegate and prove recall holds the same object while lifecycle sets/clears its
   inner implementation.
9. Rewrite `assembleDaemon()` as explicit phase calls. Do not alter the order of `createDaemon`, activity
   middleware, route coordinator, or lifecycle construction.
10. Remove unused imports and obsolete private types/helpers. Run `npm run typecheck` after each removal batch.
11. Search for all pre-PRD-081 public symbols and prove each is explicitly re-exported from `assemble.ts`.
12. Search for `from "./assemble.js"` or equivalent inside extracted modules; the count must be zero.
13. Search `assemble.ts` for individual `mount`, worker `start/stop`, raw SQL guard calls, and Node filesystem
    operations. Any remaining occurrence requires an explicit root-level rationale.
14. Update `runtime/CONVENTIONS.md` with:
    - where new resource builders live;
    - where new route mounts are added;
    - where new worker construction is added;
    - where lifecycle pausables are registered;
    - the files that remain protected shared seams;
    - the rule that feature domains do not import `assembly/` coordinators or `assemble.ts`.
15. Run formatting and the deterministic gate.
16. Run all build/package/smoke gates.
17. If credentials are available, run `tests/integration/daemon-assembly-live.itest.ts` and relevant assembled
    API/live tests. Record unavailable credentials as not run, not passed.
18. Produce a QA handoff table mapping every PRD-081 acceptance criterion to source and tests. QA authorship
    remains with the quality agent and lands in the empty `qa/` directory.

---

## Verification matrix

### Required deterministic gates

```text
npm run format
npm run typecheck
npm run dup
npm test
npm run audit:sql
npm run ci
npm run build
```

`npm run format` modifies files and runs before the read-only gates. `npm run ci` intentionally repeats its
component checks as the repository's merge gate.

### Required bundle/package gates

```text
npm run smoke:daemon-bundle
npm run smoke:local-queue-upgrade
npm run smoke:local-queue-packaged-upgrade
npm run pack:check
```

### Targeted suites

- all `tests/daemon/runtime/assembly/*.test.ts` added by PRD-081;
- `tests/daemon/runtime/assemble.test.ts`;
- `tests/daemon/runtime/assemble-hibernation.test.ts`;
- `tests/daemon/runtime/assemble-telemetry.test.ts`;
- `tests/daemon/runtime/boot-without-credentials.test.ts`;
- `tests/daemon/runtime/fleet-health-recovery.test.ts`;
- `tests/daemon/runtime/lock-continuity.test.ts`;
- `tests/daemon/runtime/workspace-base-dir.test.ts`;
- `tests/daemon/runtime/memories/lifecycle-wiring.test.ts`;
- assembled ontology, sources/documents, pollinating, dashboard, route-conformance, queue, outbox, and
  projects suites.

### Optional credential-gated proof

- `tests/integration/daemon-assembly-live.itest.ts`;
- `tests/integration/local-queue-idle-meter-live.itest.ts`;
- assembled data/memories/VFS/product/ontology/hook/golden-path live tests where the environment supports
  them.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| f-AC-1 | Remaining storage, operational, feature, service, health, and reranker resource construction moves to cohesive typed factories with no all-purpose assembly context. |
| f-AC-2 | `assemble.ts` is no more than 600 physical lines and reads as explicit normalize -> construct -> create daemon -> middleware -> mount -> lifecycle -> return orchestration. |
| f-AC-3 | `src/daemon/index.ts` and every existing assembly consumer compile without import-path or API changes. |
| f-AC-4 | `createDaemon` remains before waking middleware, and all work mounts remain after it; health/status non-waking behavior remains proven. |
| f-AC-5 | One instance is preserved for every shared storage client, queue, outbox, scope, trigger, memo, provider, cache, holder, health cell, embed attachment, and reranker delegate. |
| f-AC-6 | No moved implementation remains duplicated in `assemble.ts`; duplication and SQL audits stay green. |
| f-AC-7 | No extracted module imports `assemble.ts`, no new tier-direction violation exists, and daemon-only storage confinement remains intact. |
| f-AC-8 | Live conventions describe the new extension points; historical evidence documents remain unchanged. |
| f-AC-9 | Every new source file has the required license header and the complete source tree is Biome-formatted. |
| f-AC-10 | `npm run ci` and `npm run build` pass. |
| f-AC-11 | Daemon bundle, local-queue upgrade, packaged-upgrade, and package-shape gates pass. |
| f-AC-12 | Credential-gated tests are either recorded as passed with evidence or explicitly recorded as not run; none are silently represented as passing. |
| f-AC-13 | No generated output was hand-edited and no durable data/schema/config migration is required. |
| f-AC-14 | QA receives a complete criterion-to-code-to-test map and can audit PRD-081 without reconstructing move provenance from Git history alone. |

---

## Rollback

The final normalization commit can be reverted without reverting already-extracted modules because the
compatibility facade remains. If a resource-factory extraction regresses behavior, revert that factory move
and restore visible construction in `assemble.ts`; do not patch around it with global lookups. No data,
schema, credential, or queue rollback is required.

## Open questions

None block closeout. The exact split between `operational-resources.ts` and an optional
`queue-resources.ts` is decided by cohesion and import-cycle analysis, subject to the ownership and
no-all-purpose-context constraints in this sub-PRD.
