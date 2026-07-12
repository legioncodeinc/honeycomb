# PRD-081c: Feature-Owned Builders and Assembly Adapters

> **Parent:** [PRD-081: Daemon Assembly Modularization](./prd-081-daemon-assembly-modularization-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1.5-3 focused days)
> **Schema changes:** None
> **Blocked by:** PRD-081a and PRD-081b

---

## Overview

This wave removes feature-domain implementation knowledge from the generic composition root. Memory
lifecycle storage adapters move beside memory recall; summary, pipeline, skillify, and pollinating worker
builders move beside their worker domains; product-data and vault/inference construction move into focused
assembly helpers.

The root continues deciding when each feature is constructed and started. The extracted factories decide
how to build their feature from explicit dependencies. No worker loop, route, query, model decision, or
feature gate changes.

---

## Goals

- Put memory recall lifecycle adapters under memory ownership.
- Put each worker builder under the feature that owns the worker.
- Replace builder access to the full `AssembleDaemonOptions` object with narrow named inputs.
- Separate vault/settings/provider selection from general process orchestration.
- Preserve vault-first settings precedence, Portkey secret boundaries, model fallbacks, storage routing,
  worker gates, and fail-soft behavior.
- Keep the root responsible for construction order and shared resource identity.

## Non-Goals

- No start/stop extraction; 081e owns lifecycle.
- No route mount extraction; 081d owns route coordination.
- No change to worker polling, leasing, retry, queue kinds, or consolidation.
- No change to recall ranking or `memories/recall.ts` orchestration.
- No new inference provider, Portkey behavior, secret field, or vault key.
- No generalized factory registry.

## User stories

- As a feature maintainer, I want worker construction beside the feature worker so that a change to its
  dependencies has one obvious owner.
- As a composition-root maintainer, I want narrow builder contracts so that assembly cannot accidentally
  expose every option and resource to every feature.
- As a security reviewer, I want vault and Portkey resolution separated from recall and worker algorithms so
  that secrets remain confined to the intended adapter layer.

---

## Exact move map

| Current range | Symbols / responsibility | Destination |
|---|---|---|
| `assemble.ts:558` | `VaultSettingsReader` structural contract | `src/daemon/runtime/vault/assembly-settings.ts` with facade re-export |
| `assemble.ts:1066-1238` | `createRecordRecallAccess`, `createActivationSource`, access-count batching, `createStalenessSource`, staleness batching, `readRefStatus`, `parseStaleRefs` | `src/daemon/runtime/memories/recall-lifecycle-sources.ts` |
| `assemble.ts:1937-1985` | `resolveProductDataDeps`, secrets store construction, source registry/provider/worker construction | `src/daemon/runtime/assembly/product-data.ts` |
| `assemble.ts:2139-2151`, `2175-2363` | Vault constants, vault-store construction, provider/model selection, Portkey selection/status, pollinating/embedding/memory gates, boolean coercion | `src/daemon/runtime/vault/assembly-settings.ts` |
| `assemble.ts:2371-2390` | `PortkeyWorkerDeps`, `RerankerMountDeps` | `src/daemon/runtime/inference/assembly-contracts.ts` or the narrowest cycle-free owning modules |
| `assemble.ts:2417-2493` | `buildGatedPollinatingWorker` | `src/daemon/runtime/pollinating/assembly.ts` |
| `assemble.ts:2511-2531` | `buildSummaryWorker` | `src/daemon/runtime/summaries/assembly.ts` |
| `assemble.ts:2543-2762` | `makePipelineEntryEnqueuer`, `withMemoryFormationTracking`, `buildPipelineWorker` | `src/daemon/runtime/pipeline/assembly.ts` |
| `assemble.ts:2778-2791` | `buildSkillifyWorker` | `src/daemon/runtime/skillify/assembly.ts` |

`catalogTrustedTableProbe` at `assemble.ts:2170-2173` is not a vault concern. It moves with the asset/control
plane mount dependencies under 081d rather than into `vault/assembly-settings.ts`.

---

## Destination contracts

### Memory recall lifecycle sources

`memories/recall-lifecycle-sources.ts` receives `StorageQuery`, request scope, and lifecycle parameters. It
owns daemon-to-recall adapters, not ranking. It must preserve:

- `recordAccess` append and access-count cache maintenance;
- batched access-count/history reads;
- staleness reads from the existing memory fields;
- `AbortSignal` propagation to storage queries;
- SQL construction through repository guards;
- per-hit neutral fallback when rows are missing or malformed;
- whole-source fail-soft behavior when storage is unavailable;
- no direct transport import or connection construction.

### Product-data dependencies

`assembly/product-data.ts` builds the existing dependency object for goals, KPIs, skills, rules, secrets,
sources, and documents. It must preserve:

- vault/secrets store rooted at the fleet state directory;
- machine-key provider construction;
- local-only default-scope fallback with team/hybrid fail-closed behavior;
- one existing durable queue reused by sources/document work;
- source construction inside its own fail-soft boundary;
- no secret value returned through names-only APIs.

### Vault and inference settings

`vault/assembly-settings.ts` owns fixed setting keys and reads. It must preserve:

- `activeProvider`, `activeModel`, `pollinating.enabled`, `portkey.enabled`, `portkey.config`, and
  `portkey.fallbackToProvider` key values;
- vault-first setting precedence where already implemented;
- environment/default fallback where already implemented;
- independent failure fallback per read;
- names-only secret presence checks;
- no raw secret returned to the root or recall engine;
- `VaultSettingsReader` structural compatibility;
- exported constants re-exported from the facade.

### Feature worker builders

Each builder accepts only its actual dependencies. It must not receive a generic assembly context or the
whole `AssembleDaemonOptions` unless a field-by-field audit proves every field is used.

| Builder | Required narrow inputs |
|---|---|
| Pollinating | storage, scope, shared queue, resolved agent config path, pollinating config provider, optional injected worker, vault reader, inference/Portkey inputs, logger, backoff. |
| Summary | storage, scope, shared queue, the baseline embed attachment/client dependency, pollinating trigger, backoff, logger. |
| Pipeline | baseline read/write storage dependencies, scope, queue, embed client, resolved agent config path, vault memory gate, keep-both memo, memory outbox, memory-formation tracker, pollinating trigger, logger, Portkey/inference inputs, backoff. |
| Skillify | storage, scope, queue, host-CLI gate dependencies, backoff, and the baseline logger dependency. |

The exact field lists are derived from implementation use before moving. Unused options are not copied into
the new contracts.

---

## Shared identity and ordering requirements

The extracted builders must consume, not reconstruct, these root-owned instances:

- one `pollinatingTrigger` shared by API trigger, summary counter, maintenance tick, and pollinating worker;
- one `keepBothMemo` shared by conflict resolution and pipeline conflict detection;
- one `memoryFormation` tracker shared by live pipeline outcomes, outbox recovery reporting, and health;
- one memory outbox instance;
- one shared daemon queue (`daemon.services.queue`);
- one embed attachment, with the full attachment or `.client` passed according to existing contracts;
- one logger and one scope object;
- one stable late-bound Cohere rerank delegate, with secret resolution remaining outside recall.

The root creates these objects before calling builders and retains ownership of start/stop order until 081e.

---

## Files touched

### New files

- `src/daemon/runtime/memories/recall-lifecycle-sources.ts`
- `src/daemon/runtime/assembly/product-data.ts`
- `src/daemon/runtime/vault/assembly-settings.ts`
- `src/daemon/runtime/inference/assembly-contracts.ts` if a shared cycle-free contract file is required
- `src/daemon/runtime/pollinating/assembly.ts`
- `src/daemon/runtime/summaries/assembly.ts`
- `src/daemon/runtime/pipeline/assembly.ts`
- `src/daemon/runtime/skillify/assembly.ts`

### Modified files

- `src/daemon/runtime/assemble.ts`: import builders/readers, preserve construction calls and order, remove
  original bodies, and re-export existing public vault constants/types.
- Feature `index.ts` files only if an existing domain convention requires a public internal export. Direct
  relative imports from `assemble.ts` are preferred when no public barrel is needed.

### Tests

Existing feature suites remain authoritative. Add narrow assembly-builder suites only where existing tests
exercise a manually built equivalent rather than the actual builder:

- `tests/daemon/runtime/memories/lifecycle-wiring.test.ts`
- `tests/daemon/runtime/pollinating/worker.test.ts`
- `tests/daemon/runtime/pollinating/pollinate-trigger-assembled.test.ts`
- `tests/daemon/runtime/summaries/worker.test.ts`
- `tests/daemon/runtime/pipeline/stage-worker.test.ts`
- `tests/daemon/runtime/pipeline/pipeline-worker.test.ts`
- `tests/daemon/runtime/skillify/*`
- `tests/daemon/runtime/sources-documents-assembled.test.ts`
- PRD-081a dependency-identity tests.

---

## Detailed implementation plan

1. Move memory lifecycle adapters first because they have narrow storage/query contracts and no process
   lifecycle ownership.
2. Copy the complete implementation and explanatory comments into
   `memories/recall-lifecycle-sources.ts`, add the license header, update imports, and delete the original
   block in the same commit.
3. Run SQL safety and lifecycle-wiring tests immediately. Confirm the SQL audit still scans the new path
   because it remains under `src/daemon`.
4. Move vault constants and setting readers to `vault/assembly-settings.ts`. Keep public constants explicitly
   re-exported from `assemble.ts`.
5. Separate the trusted catalog-table probe from vault work and leave it for 081d.
6. Add focused tests for each vault read's precedence and fail-soft default if current tests cover only the
   final assembled behavior.
7. Move `resolveProductDataDeps` into `assembly/product-data.ts`. Pass the already resolved fleet-root base
   directory or use the single path helper from 081b; do not duplicate path resolution.
8. Preserve the source dependency build's local try/catch. Do not broaden it to cover secrets or all product
   data construction.
9. Define narrow worker-builder input interfaces by tracing actual property reads. Do not mechanically move
   `AssembleDaemonOptions` into every feature module.
10. Move `buildSummaryWorker` and `buildSkillifyWorker`, the smallest builders, in separate commits.
11. Move `buildGatedPollinatingWorker`. Preserve the gate-before-heavy-construction behavior and the
    semantics of injected worker, injected `null`, disabled config, and model fallback.
12. Move the pipeline builder and its two private helpers as one unit. Preserve:
    - pipeline stage ordering;
    - inference fallback;
    - memory gate precedence;
    - memory-formation tracking;
    - outbox dependency;
    - graph/conflict fan-out;
    - pollinating trigger coupling;
    - logger event shape.
13. Keep all builder invocation sites in their current relative positions. Start/stop remains in
    `assemble.ts` for this wave.
14. Search for duplicate moved functions and old imports. Run `npm run dup` before full CI so copy/paste
    leftovers are caught early.
15. Run `npm run format`, `npm run ci`, and `npm run build`.

---

## Test plan

| Concern | Required proof |
|---|---|
| Recall access adapter | One recall event is recorded; storage failure remains neutral; request scope and signal are preserved. |
| Activation source | Batched access history/count results map to the same per-memory inputs; missing/malformed cells remain neutral. |
| Staleness source | Existing ref status/stale refs parsing and exponent behavior remain unchanged. |
| Vault precedence | Vault-first and environment/default fallbacks match pre-move behavior for every key. |
| Secret boundary | Portkey/provider secrets do not enter returned settings, recall dependencies, logs, or errors. |
| Product sources | Sources reuse the daemon queue and fail independently without suppressing secrets/product APIs. |
| Summary worker | Receives the same queue, storage, scope, embed, trigger, backoff, and logger references. |
| Pipeline worker | Receives the same memory gate, model, outbox, tracker, memo, trigger, and fan-out dependencies. |
| Skillify worker | Gate and host-CLI behavior remain unchanged. |
| Pollinating worker | Disabled/injected/real construction branches and consolidation compatibility remain unchanged. |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Recall access, activation, and staleness adapters move to the memory domain with unchanged query, scope, signal, SQL safety, and fail-soft behavior. |
| c-AC-2 | Product-data dependency construction moves to `assembly/product-data.ts` and preserves independent source-build failure isolation and secret scope. |
| c-AC-3 | Vault/provider/Portkey settings move to `vault/assembly-settings.ts`; every public key remains re-exported and every precedence/fallback branch is unchanged. |
| c-AC-4 | Pollinating, summary, pipeline, and skillify builders move to their owning domains and accept narrow typed dependencies rather than a generic assembly context. |
| c-AC-5 | Builder invocation and worker start/stop order remain in `assemble.ts` and are unchanged in this wave. |
| c-AC-6 | Reference-identity tests prove builders consume the same queue, scope, embed, trigger, memo, tracker, outbox, logger, and rerank delegate created by the root. |
| c-AC-7 | No feature builder imports `runtime/assemble.ts`, `storage/transport.ts`, or a higher-tier client surface. |
| c-AC-8 | No inference secret, memory content, scope identifier, or token is newly logged or returned. |
| c-AC-9 | No duplicate moved function remains and `npm run dup` stays below threshold. |
| c-AC-10 | `npm run ci` and `npm run build` pass. |

---

## Rollback

Each domain builder should land separately. Revert only the failing builder move and restore its original
block/imports in `assemble.ts`. Because construction inputs and durable stores are unchanged, no data repair
or runtime migration is required.

## Open questions

None block implementation. `PortkeyWorkerDeps` and `RerankerMountDeps` may share a small
`inference/assembly-contracts.ts` file only if that avoids a dependency cycle; otherwise each remains with
its narrow owner.
