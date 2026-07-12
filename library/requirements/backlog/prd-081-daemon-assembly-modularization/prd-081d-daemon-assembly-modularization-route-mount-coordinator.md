# PRD-081d: Ordered Route-Mount Coordinator

> **Parent:** [PRD-081: Daemon Assembly Modularization](./prd-081-daemon-assembly-modularization-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (2-3 focused days)
> **Schema changes:** None
> **Blocked by:** PRD-081a through PRD-081c

---

## Overview

This wave extracts route installation from the 663-line `assembleSeams` function and the separate
post-seam mount block. It introduces grouped mount functions behind one explicit coordinator and replaces
internal positional plumbing with a named dependency object.

Route order is treated as behavior. The coordinator remains imperative and readable. It does not iterate an
unordered registry, infer dependencies from names, or apply one family-wide failure boundary. Every route
keeps its existing mode gate, resource gate, optionality, storage client, scope, and error handling.

The exported positional `assembleSeams(...)` function remains available as a compatibility wrapper. The
production root uses the new named contract.

---

## Goals

- Move all route/mount composition into `runtime/assembly/mounts/`.
- Make canonical mount order executable and reviewable.
- Replace the internal 24-argument call with `MountDaemonSurfacesDeps`.
- Preserve the exact capture handler and every shared collaborator passed into routes.
- Preserve local-only setup surfaces and team/hybrid protection.
- Preserve independent fail-soft boundaries for optional/operational mounts.
- Incorporate direct post-`assembleSeams` mounts into the same documented coordinator without changing
  their relative position.

## Non-Goals

- No route path, method, schema, response, auth policy, or middleware change.
- No movement of handler implementation from its feature module.
- No dynamic plugin/feature registry.
- No replacement of Hono route groups.
- No removal of the exported positional `assembleSeams` compatibility form.
- No start/shutdown extraction.

## User stories

- As a feature engineer, I want one documented mount family and dependency contract so that adding a surface
  does not require navigating unrelated lifecycle and storage construction.
- As a reviewer, I want route order, mode gates, storage routing, and failure isolation visible in one
  coordinator so that Hono shadowing and missing mounts are detectable.
- As an operator, I want the same routes and protections after the refactor so that internal organization is
  invisible at runtime.

---

## Target files

| File | Responsibility |
|---|---|
| `assembly/mounts/contracts.ts` | `SeamFns` from 081a plus named dependency groups and `MountedDaemonSurfaces`. |
| `assembly/mounts/core.ts` | Capture, dashboard, notifications, prune, and logs. |
| `assembly/mounts/setup.ts` | Local-only setup login, pending tenancy selection, state, and migration. |
| `assembly/mounts/memory.ts` | Memories, conflicts, lifecycle, prime, VFS, product data, pollinate, and project sync. |
| `assembly/mounts/diagnostics.ts` | Compact/stale/reverify/calibrate/access-log, health, local queue, jobs, capture drain, and memory redrive. |
| `assembly/mounts/integrations.ts` | Graph, harness, harness ingest, sync, ontology, skill propagation, settings, auth/actions, scope/onboarding, and assets. |
| `assembly/mounts/index.ts` | Explicit canonical coordinator plus positional `assembleSeams` compatibility wrapper. |

Family boundaries may shift one mount where doing so prevents a cycle, but the canonical global order below
is fixed.

---

## Internal dependency contract

The production coordinator receives one named object with cohesive nested groups, not 31 positional values
and not one untyped context:

```ts
interface MountDaemonSurfacesDeps {
  readonly daemon: Daemon;
  readonly storage: StorageClient;
  readonly writeStorage: StorageClient;
  readonly scope: QueryScope;
  readonly identity: {
    readonly orgName?: string;
    readonly workspaceDir: string;
    readonly projectsDir?: string;
  };
  readonly services: {
    readonly embed: EmbedAttachment;
    readonly queue: DaemonServices["queue"];
    readonly logStore: LogStore;
  };
  readonly health: {
    readonly detail: () => HealthDetail;
    readonly captureDroppedEvents?: CaptureDroppedEventsCounter;
    readonly gatedCaptures?: GatedCapturesCounter;
  };
  readonly shared: {
    readonly pendingLinkStore: PendingLinkStore;
    readonly keepBothMemo: KeepBothMemoStore;
    readonly calibrationProvider: CalibrationModelProvider;
    readonly harnessPluginStatus: HarnessPluginStatusHolder;
    readonly projectsViewCache: ProjectsViewCache<ProjectCountsMap>;
    readonly localVectorIndex?: LocalVectorIndex;
  };
  readonly optional: {
    readonly vault?: VaultSettingsReader;
    readonly captureOutbox?: CaptureOutbox;
    readonly memoryOutbox?: MemoryOutbox;
    readonly reranker?: RerankerMountDeps;
  };
  readonly seams: SeamFns;
}
```

The exact type may split further to avoid cycles. The required design is named, readonly dependencies with
no `any`, no service locator, and no module reading global state that the root already resolved.

`MountedDaemonSurfaces` must return at least the exact capture handler used by shutdown. It may also return
mount-owned shared handles only when a later lifecycle phase genuinely needs them.

---

## Canonical production mount order

The following order is frozen by 081a and preserved by the coordinator:

1. `attachHooks` using `writeStorage` for capture writes.
2. `mountDashboard` using read `storage`.
3. `mountNotifications`.
4. `attachPrune`.
5. `mountLogs`.
6. optional `mountSetupLogin` in local mode only.
7. direct `mountSetupTenancyApi` in local mode only, using the same pending-link store.
8. optional `mountSetupState` in local mode only.
9. optional `mountSetupMigrate` in local mode only.
10. `mountMemories`.
11. optional `mountConflicts` using the root-owned keep-both memo.
12. optional `mountLifecycle`.
13. optional `mountMemoriesPrime` compatibility mount.
14. `mountVfs`.
15. `mountProductData`.
16. `mountPollinate` using the daemon's shared queue.
17. `mountProjectsSync`.
18. `mountCompact`.
19. `mountStaleRef`.
20. optional `mountReverify`.
21. optional `mountCompactAccessLog`.
22. optional `mountCalibrate` using the shared calibration provider.
23. `mountDiagnosticsHealth`.
24. optional `mountLocalQueueDiagnostics`.
25. optional `mountGraph`.
26. optional `mountHarness`.
27. optional `mountHarnessStatusIngest` using the shared holder.
28. optional `mountSync`.
29. optional `mountOntology`.
30. optional `mountSkillPropagation`.
31. `mountCaptureDrainApi` when the capture outbox exists.
32. `mountMemoryRedriveApi` for real assembly only.
33. `mountSettingsApi` only when the reader is a full `VaultStore`.
34. `mountAuthStatusApi`.
35. `mountActionsApi`.
36. `mountJobsDiagnosticsApi`.
37. `mountScopeEnumerationApi` using the shared projects cache.
38. `mountOnboardingApi` using the same cache for invalidation.
39. `mountScopeSwitchApi`.
40. `mountAssetsApi` using the trusted catalog probe.

`mountMemoriesApi` retains its internal literal-route-before-parameter-route registration. The standalone
prime mount remains in its current compatibility role; PRD-081 does not consolidate or remove it.

---

## Ordering and boundary invariants

1. `createDaemon()` runs before the wildcard activity middleware.
2. The wildcard activity middleware runs before all 40 work-carrying mount calls.
3. `/health` and `/api/status`, registered during `createDaemon()`, remain outside the waking path.
4. Capture alone receives `writeStorage`; recall, dashboard, reads, healers, and diagnostics receive read
   `storage`.
5. Each optional/guarded mount retains its own catch and existing message. A family function may not catch
   the whole family.
6. Local-only setup routes are never registered in team or hybrid mode.
7. Identity comes from authenticated middleware/default scope behavior, never a body-forged tenancy.
8. The exact `CaptureHandler` returned by `attachHooks` is returned to lifecycle for flush.
9. The same pending-link store spans setup login and setup tenancy.
10. The same calibration provider spans recall, manual calibration, and periodic invalidation.
11. The same projects cache spans enumeration and onboarding mutation.
12. The same harness holder spans ingest and readback.

---

## Files touched

### New files

- `src/daemon/runtime/assembly/mounts/core.ts`
- `src/daemon/runtime/assembly/mounts/setup.ts`
- `src/daemon/runtime/assembly/mounts/memory.ts`
- `src/daemon/runtime/assembly/mounts/diagnostics.ts`
- `src/daemon/runtime/assembly/mounts/integrations.ts`
- `src/daemon/runtime/assembly/mounts/index.ts`

`contracts.ts` and `defaults.ts` already exist from 081a and are extended only as required.

### Modified files

- `src/daemon/runtime/assemble.ts`: replace the large positional `assembleSeams` invocation and direct
  mount block with one `mountDaemonSurfaces({...})` call; retain explicit exported compatibility wrapper.
- No handler implementation file changes unless a type-only export is required to avoid a cycle.

### Tests

- PRD-081a mount-order and failure-isolation suites become the primary oracle.
- Existing assembled route suites remain unchanged.
- Add `tests/daemon/runtime/assembly/route-inventory.test.ts` to request representative endpoints from every
  mounted family and prove they are not scaffold fallthroughs in the modes where they should exist.

---

## Detailed implementation plan

1. Confirm the complete 40-event pre-move trace is green.
2. Add `MountDaemonSurfacesDeps` and `MountedDaemonSurfaces` to the mount contract file. Use readonly nested
   groups and type-only imports.
3. Add a private adapter that converts the old positional `assembleSeams(...)` arguments into the named
   dependency object. Keep the exported function signature and default seam argument unchanged.
4. Extract core mounts first. Move implementation and comments, delete the original calls, and rerun the
   order trace after this single family.
5. Extract setup mounts. Preserve the one `mode === "local"` gate and each optional mount's independent
   catch. Pass one pending-link store to both login and tenancy selection.
6. Extract memory/product mounts. Preserve read/write client choice, lifecycle inputs, nectar multiplier,
   local index, calibration provider, memo, and queue identity.
7. Extract diagnostics mounts. Keep `mountStaleRef` required, newer seams optional as declared, and each
   fail-soft boundary local.
8. Extract integrations and post-seam control-plane mounts. Preserve the real-assembly and full-vault
   gates.
9. Move `catalogTrustedTableProbe` with the asset/control-plane dependency builder rather than vault code.
10. Construct `ProjectsViewCache` once before the coordinator call, or have one mount-resource factory
    return it once. Do not construct one cache per family.
11. Replace the production positional call with `mountDaemonSurfaces({...})`. Leave the positional wrapper
    solely for compatibility tests/callers.
12. Verify the returned capture handler is reference-equal to the object whose `flush()` is called during
    shutdown.
13. Add route-inventory requests for setup, memories, VFS, diagnostics, graph/harness/sync/ontology/skills,
    settings/actions/auth, projects/onboarding/scope, and assets.
14. Inject a failure at one guarded mount in each family and confirm later global events still occur.
15. Search for route mount calls remaining in `assemble.ts`; only the one coordinator call is allowed after
    this wave.
16. Run `npm run format`, `npm run ci`, and `npm run build`.

---

## Test plan

| Concern | Required proof |
|---|---|
| Canonical order | Exact 40-event trace in local mode with all optional/resource-gated mounts enabled. |
| Mode gates | Setup family absent in team/hybrid; protected route families remain available with auth. |
| Exactly once | No duplicate mount or duplicate Hono route registration introduced by wrapper/coordinator coexistence. |
| Failure isolation | One guarded failure does not suppress later mounts within or after its family. |
| Fatal mounts | Unguarded core failures retain current propagation rather than being accidentally swallowed. |
| Storage routing | Capture gets `writeStorage`; all read surfaces get the exact read client. |
| Shared identity | Pending store, memo, calibration provider, project cache, harness holder, queue, scope, and capture handler retain reference identity. |
| Route inventory | Representative endpoint in each family avoids 404/501 in allowed modes and remains absent where gated. |
| Hibernation | Health/status do not wake; mounted work routes do wake. |
| Public facade | Positional `assembleSeams` and `defaultSeamFns` remain compatible. |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | Production assembly performs one `mountDaemonSurfaces` call with a named typed dependency object; no 24-argument production call remains. |
| d-AC-2 | The exported positional `assembleSeams(...)` compatibility wrapper remains source-compatible and delegates to the same coordinator without duplicate registration. |
| d-AC-3 | All 40 mount events execute exactly once in the canonical order in local mode when all optional/resource-gated mounts are enabled. |
| d-AC-4 | Team/hybrid modes omit local-only setup routes and retain protected surfaces under existing auth/RBAC. |
| d-AC-5 | Each existing guarded mount retains an independent failure boundary and later mounts continue after an injected failure. |
| d-AC-6 | Capture alone receives write storage; every read/recall/heal/diagnostic surface receives read storage. |
| d-AC-7 | The coordinator returns the exact capture handler flushed first by shutdown. |
| d-AC-8 | Shared identity tests pass for pending-link store, keep-both memo, calibration provider, projects cache, harness holder, queue, scope, and local index. |
| d-AC-9 | No route path/method/body/status/auth/schema behavior changes and representative route inventory tests pass. |
| d-AC-10 | `assemble.ts` contains no individual feature mount call after this wave. |
| d-AC-11 | Every new file carries the license header; no mount module imports `assemble.ts`. |
| d-AC-12 | `npm run ci` and `npm run build` pass. |

---

## Rollback

Revert mount families in reverse extraction order. The compatibility wrapper means callers do not need a
coordinated rollback. There is no data/schema rollback. If a route disappears, revert 081d before changing
handler code, because handler implementations are explicitly outside this wave.

## Open questions

None. A mount may move between the proposed family files to prevent an import cycle, but its global order,
gate, dependencies, error boundary, and acceptance criteria cannot change.
