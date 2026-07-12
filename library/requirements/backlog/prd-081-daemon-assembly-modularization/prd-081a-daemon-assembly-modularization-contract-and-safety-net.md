# PRD-081a: Compatibility Contract and Assembly Safety Net

> **Parent:** [PRD-081: Daemon Assembly Modularization](./prd-081-daemon-assembly-modularization-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M-L (1-2 focused days)
> **Schema changes:** None

---

## Overview

The first wave freezes the behavior that later waves are allowed to move. It creates the compatibility
facade contracts, records every current public export, and adds characterization tests for the boundaries
most likely to regress: complete route registration, independent fail-soft mounts, dependency identity,
startup order, shutdown order, hibernation placement, and public imports.

This wave is intentionally conservative. It moves contract declarations and the production seam-default
mapping, but it does not move route bodies, worker builders, timers, or lifecycle implementation.

The existing assembly suite is broad but not complete for this purpose. `SeamFns` has 29 entries, while
the principal recording fake in `tests/daemon/runtime/assemble.test.ts` supplies only an older subset.
Tests are excluded from the production `tsc` graph, and some omitted required seams can become caught
runtime mount errors, which means the suite can pass without proving the full production mount inventory.
PRD-081a closes that characterization gap before any large move.

---

## Goals

- Define the exact public compatibility surface that must remain importable from
  `src/daemon/runtime/assemble.js`.
- Split public assembly contracts from implementation imports without changing their structural types.
- Keep one canonical `defaultSeamFns` object that maps all 29 seam fields to production implementations.
- Add complete tests for mount order, mount presence, fail-soft continuation, shared dependencies, start,
  shutdown, and public exports.
- Establish a trace vocabulary used by later lifecycle tests so ordering assertions stay readable.
- Prove the pre-refactor behavior first; later sub-PRDs must make the same tests pass without loosening them.

## Non-Goals

- No route implementation move.
- No change from positional `assembleSeams(...)` arguments to a dependency object; 081d owns that change.
- No worker, timer, hibernation, or lifecycle extraction.
- No correction of behavior exposed by characterization. A discovered behavior defect is recorded as a
  separate issue/PRD rather than silently changed in a structural wave.
- No update to generated declarations or bundles by hand.

## User stories

- As an implementation engineer, I want an executable pre-move contract so that a mechanical extraction
  cannot silently remove a mount, change an object identity, or reorder lifecycle work.
- As a reviewer, I want the full facade and seam inventory enumerated so that I can distinguish a source
  move from an API change.
- As a release owner, I want failures in characterization to block later waves so that the refactor never
  advances on an ambiguous baseline.

---

## Public compatibility surface

The following values and types must remain explicitly exportable from
`src/daemon/runtime/assemble.ts` after every PRD-081 wave:

| Kind | Symbol |
|---|---|
| Constant | `AGENT_CONFIG_FILE_NAME` |
| Constant | `LOCK_FILE_NAME` |
| Constant | `PID_FILE_NAME` |
| Function | `resolveCodebaseGraphAutoBuild` |
| Type | `AssembleDaemonOptions` |
| Type | `VaultSettingsReader` |
| Type | `SeamFns` |
| Value | `defaultSeamFns` |
| Type | `AssembledDaemon` |
| Error class | `DaemonAlreadyRunningError` |
| Type | `SingleInstanceLockOptions` |
| Function | `acquireSingleInstanceLock` |
| Function | `releaseSingleInstanceLock` |
| Function | `assembleSeams` |
| Function | `workspaceBaseDirCandidate` |
| Function | `resolveLocalQueueBaseDir` |
| Constant | `VAULT_PROVIDER_KEY` |
| Constant | `VAULT_MODEL_KEY` |
| Constant | `VAULT_POLLINATING_ENABLED_KEY` |
| Constant | `VAULT_PORTKEY_ENABLED_KEY` |
| Constant | `VAULT_PORTKEY_CONFIG_KEY` |
| Constant | `VAULT_PORTKEY_FALLBACK_KEY` |
| Function | `assembleDaemon` |

`src/daemon/index.ts` must retain its existing imports and public re-exports. That file is an acceptance
consumer, not a migration target.

---

## `SeamFns` inventory

The contract/default files must carry all 29 fields, preserving optionality exactly:

| Family | Fields |
|---|---|
| Core | `attachHooks`, `mountDashboard`, `mountNotifications`, `attachPrune`, `mountLogs` |
| Setup | `mountSetupLogin?`, `mountSetupState?`, `mountSetupMigrate?` |
| Memory and product | `mountMemories`, `mountMemoriesPrime?`, `mountConflicts?`, `mountLifecycle?`, `mountVfs`, `mountProductData`, `mountPollinate`, `mountProjectsSync` |
| Maintenance and diagnostics | `mountCompact`, `mountStaleRef`, `mountReverify?`, `mountCompactAccessLog?`, `mountCalibrate?`, `mountDiagnosticsHealth`, `mountLocalQueueDiagnostics?` |
| Integrations | `mountGraph?`, `mountHarness?`, `mountHarnessStatusIngest?`, `mountSync?`, `mountOntology?`, `mountSkillPropagation?` |

Optional fields remain optional so older test seam objects remain structurally valid where the production
code already applies a presence check. Required fields remain required; tests must stop omitting them.

---

## Files touched

### New source files

| File | Contents |
|---|---|
| `src/daemon/runtime/assembly/contracts.ts` | `PipelineStatus` if needed by public contracts, `AssembleDaemonOptions`, and `AssembledDaemon`; type-only imports wherever possible. |
| `src/daemon/runtime/assembly/mounts/contracts.ts` | The 29-field `SeamFns` interface, retaining existing `typeof mountX` signatures and optionality. |
| `src/daemon/runtime/assembly/mounts/defaults.ts` | The single production `defaultSeamFns` mapping. No second default object exists elsewhere. |

### Modified source files

| File | Change |
|---|---|
| `src/daemon/runtime/assemble.ts` | Remove the moved declarations, import the contracts for internal use, and explicitly re-export them from their new modules. No assembly behavior moves. |

### New tests

| File | Purpose |
|---|---|
| `tests/daemon/runtime/assembly/public-surface.test.ts` | Import all existing runtime values from the facade and compile representative type uses. Assert facade values are the exact moved implementations, not wrappers with divergent state. |
| `tests/daemon/runtime/assembly/mount-order.test.ts` | Build a complete 29-field recording seam set from a typed helper. Record every mount exactly once and in canonical order, including local-only setup behavior. |
| `tests/daemon/runtime/assembly/mount-failure-isolation.test.ts` | Inject one throwing optional/guarded mount at a time; assert the documented error is emitted and every later sibling still runs. Separately pin which unguarded core mounts remain fatal. |
| `tests/daemon/runtime/assembly/dependency-identity.test.ts` | Record exact object references passed to mounts and prove read/write storage routing and shared collaborator identity. |
| `tests/daemon/runtime/assembly/start-order.test.ts` | Record the current start sequence and repeated-start idempotence. |
| `tests/daemon/runtime/assembly/shutdown-order.test.ts` | Record flush/stop/close/release order and repeated-shutdown behavior. |

### Existing tests retained

The following tests remain in place and continue importing the compatibility facade:

- `tests/daemon/runtime/assemble.test.ts`
- `tests/daemon/runtime/assemble-hibernation.test.ts`
- `tests/daemon/runtime/assemble-telemetry.test.ts`
- `tests/daemon/runtime/boot-without-credentials.test.ts`
- `tests/daemon/runtime/fleet-health-recovery.test.ts`
- `tests/daemon/runtime/lock-continuity.test.ts`
- `tests/daemon/runtime/workspace-base-dir.test.ts`
- `tests/daemon/runtime/memories/lifecycle-wiring.test.ts`
- `tests/daemon/runtime/state-migration/upgrade-sequence.test.ts`
- assembled feature suites for ontology, sources/documents, pollinating, dashboard harness state, and MCP
  route conformance.

---

## Detailed implementation plan

1. Run and record the pre-change baseline:
   - `npm run typecheck`
   - `npm test`
   - `npm run audit:sql`
   - `npm run build`
2. Generate the public-symbol checklist from TypeScript AST output rather than maintaining it from memory.
3. Add `assembly/contracts.ts` with the required license header. Move only the contract declarations from
   `assemble.ts:317`, `343-549`, and `837-857`. Use `import type` for every dependency that does not need a
   runtime value.
4. Add `assembly/mounts/contracts.ts` with the license header. Move `SeamFns` from
   `assemble.ts:568-801` without changing field names, signatures, or optionality.
5. Add `assembly/mounts/defaults.ts` with the license header. Move `defaultSeamFns` from
   `assemble.ts:804-834`. Import the real mount implementations directly into this file.
6. In `assemble.ts`, explicitly re-export the moved symbols. Do not use a broad `export *` that could
   accidentally enlarge the public API.
7. Keep all existing call sites in `assemble.ts` unchanged. This is a declaration move only.
8. Add a typed `recordingSeams()` test helper that cannot omit a required `SeamFns` field. Avoid a partial
   object cast because the current gap was enabled by incomplete fakes.
9. Record canonical mount events from the pre-extraction production call path. Include direct setup tenancy
   and post-seam mounts as named events even though they are not `SeamFns` fields.
10. Add failure-isolation tests that fail one mount in the middle of a family and prove later mounts run.
    Do not wrap a complete family in one catch merely to simplify tests.
11. Add dependency-identity probes for:
    - capture receiving `writeStorage` while read surfaces receive `storage`;
    - queue identity across capture, product sources, pollinate, and job diagnostics;
    - one scope object across mounts;
    - one pending-link store across setup login and setup tenancy;
    - one harness status holder across ingest and reads;
    - one project cache across scope enumeration and onboarding;
    - one keep-both memo and calibration provider across their consumers.
12. Add start/shutdown event recorders without moving lifecycle code. These tests are the acceptance oracle
    for 081e.
13. Run `npm run format`, inspect the diff for declaration-only behavior, then run `npm run ci` and
    `npm run build`.

---

## Characterization rulings

The tests must explicitly preserve or defer the following behaviors:

1. A second `start()` is an idempotent no-op.
2. A second `shutdown()` is safe and does not release unrelated state.
3. The lock is acquired before health, graph, service, outbox, or worker startup.
4. `startBackgroundWorkers:false` returns immediately after `daemon.startServices()`.
5. `/health` and `/api/status` remain registered before waking middleware and do not wake hibernation.
6. Work routes are registered after waking middleware and do wake hibernation.
7. Capture flush occurs before services stop.
8. Current partial-start failure semantics are pinned but not fixed. If `startServices()` throws after lock
   acquisition, changing lock/started behavior is out of scope for PRD-081.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Every symbol in the public compatibility table remains importable from `src/daemon/runtime/assemble.js` with the same runtime identity or TypeScript shape. |
| a-AC-2 | `src/daemon/index.ts` compiles unchanged and continues re-exporting the same assembly surface. |
| a-AC-3 | `SeamFns` contains all 29 current fields with unchanged signatures and optionality; `defaultSeamFns` supplies every field exactly once. |
| a-AC-4 | A complete typed recording seam set proves every seam and direct mount runs exactly once in canonical order for local mode. |
| a-AC-5 | Team and hybrid tests prove local-only setup mounts remain absent and protected mounts remain present. |
| a-AC-6 | Throwing-seam tests prove every existing guarded mount remains fail-soft and later mounts still execute; unguarded mounts retain their current fatal behavior. |
| a-AC-7 | Dependency tests prove write/read storage routing and shared object identity without using value equality as a substitute for reference equality. |
| a-AC-8 | Start and shutdown trace tests pin the complete sequence, idempotence, and `startBackgroundWorkers:false` boundary before lifecycle code moves. |
| a-AC-9 | No route, worker, timer, health, authentication, tenancy, queue, outbox, or storage behavior changes in this wave. |
| a-AC-10 | `npm run ci` and `npm run build` pass. |

---

## Rollback

Revert the declaration move and new tests as one wave. Because no runtime behavior or durable state changes,
rollback requires no data or configuration action. Later sub-PRDs must not begin until this wave is green.

## Open questions

None. Any behavior discrepancy discovered while writing characterization tests is recorded separately and
resolved before this sub-PRD is accepted.
