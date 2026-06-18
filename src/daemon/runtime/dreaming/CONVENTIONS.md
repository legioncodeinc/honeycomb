# Dreaming module — CONVENTIONS (PRD-009)

The dreaming loop lives under `src/daemon/runtime/dreaming/` (daemon-only; the
DeepLake path lives only in the daemon bundle — the `tests/daemon/storage/invariant.test.ts`
import-graph assertion enforces it). Wave 1 built the `dreaming_state` catalog
table, the dreaming config, the shared contracts, 009a (the token-budget trigger,
DONE), and the dreaming session-runner HARNESS, and pre-wired the 009b / 009c
strategy stubs. Wave 2's two Bees each fill ONE module + its test file,
contention-free.

**Read this file before filling a stub.** It is the contract Wave 2 follows.

## What Wave 1 shipped (DO NOT TOUCH these files)

| File | What it owns | Status |
|---|---|---|
| `config.ts` | `memory.dreaming` config (zod): `enabled`, `tokenThreshold` (100k), `maxInputTokens` (128k), `backfillOnFirstRun`. `resolveDreamingConfig` + the env provider. | DONE |
| `contracts.ts` | The cross-module shapes: `DreamingJobPayload`, the seven-op mutation vocabulary `DREAMING_MUTATION_KINDS` + `MUTATION_KIND_TO_OPERATION`, `DreamingMutation` / `DreamingMutationSet` (zod boundaries), `DreamingPassResult`. The `parse*` boundary validators. A genuinely new cross-module field is a Wave-1 change (raise it), not a stub edit. | DONE |
| `trigger.ts` | 009a IN FULL — `DreamingTrigger` with `incrementDreamingCounter` (FR-2) + `checkAndEnqueueDreaming` (FR-3..7). Append-only version-bumped; reset SUBTRACTS the threshold; the single-pending guard. | DONE |
| `runner.ts` | The pass-lifecycle HARNESS: the `DreamingPayloadStrategy` seam, the model call (`memory_dreaming` workload), the defensive parse, the 008c apply loop, the state update on success. | DONE (harness) |
| `../../storage/catalog/dreaming-state.ts` | The `dreaming_state` catalog table (version-bumped, `scope:"agent"`, FR-1 columns). | DONE |

A Wave-2 Bee ADDS its body to its stub module + its own test; it does NOT edit any
Wave-1 file, the catalog barrel, the trigger, the runner, or the OTHER Bee's stub.

## Locked decisions (binding — D-1..D-6, see EXECUTION_LEDGER-prd-009.md)

- **D-1** counter scope = per (org, workspace, agent_id). Org/workspace ride the
  `QueryScope` partition; `agent_id` is the inner key + the deterministic row id.
- **D-2** thresholds 100k / 128k, configurable under `memory.dreaming`.
- **D-3** `dreaming_state` is APPEND-ONLY version-bumped (highest-version read); the
  reset SUBTRACTS the threshold (NOT hard-zero) so a summary write between the
  threshold-read and the reset is not lost (FR-5); `pending_job_id` guards a 2nd
  enqueue (FR-6).
- **D-6** mutations apply via 008c `submitProposal`; destructive → pending review.

## The payload-strategy interface you IMPLEMENT (`runner.ts`)

This is the single seam each Wave-2 Bee fills. Implement it in YOUR stub module:

```ts
import type { DreamingPayload, DreamingPayloadStrategy } from "./runner.js";

export class IncrementalPayloadStrategy implements DreamingPayloadStrategy {
  readonly mode = "incremental" as const;            // 009c: "compaction"
  async loadPayload(storage, scope, job): Promise<DreamingPayload | null> {
    // assemble the prompt + token budget for this scope/mode; return null when
    // there is nothing to dream over (the harness records an empty pass).
  }
}
```

`DreamingPayload` is `{ prompt: string; tokenBudget: number }`. The harness forwards
`prompt` to the model and echoes `tokenBudget` for accounting — it is blind to HOW
you assembled it. Return `null` to mean "nothing to dream over" (no new summaries
for incremental; empty graph for compaction).

## The runner harness you CONSUME (don't re-implement)

`DreamingRunner.runPass(job)` already does ALL of this — you supply only the strategy:

1. `strategy.loadPayload(...)` → `null` short-circuits to an empty pass.
2. `model.complete("memory_dreaming", payload.prompt)` — the STRONGER target (D-5 /
   b-AC-6). The model seam is raw-in/raw-out; the harness strips CoT + a fence,
   JSON-parses, and validates via `parseDreamingMutationSet` (drop-invalid, never
   fails the job).
3. For each mutation → `submitProposal` (the 008c apply seam, below).
4. On success → `stateUpdater.recordPassComplete(agentId, lastPassAt)` (b-AC-5).

So 009b/009c add NO model call, NO apply loop, NO state write — only payload assembly
(and, for 009c, the `honeycomb dream` CLI verb).

## The 008c apply seam (D-6 / b-AC-2 / index AC-2)

The harness submits EVERY mutation through `submitProposal` (008c control plane). The
human-facing mutation kind maps onto a control-plane operation via
`MUTATION_KIND_TO_OPERATION` (`contracts.ts`):

| Mutation kind | → operation | Routes to |
|---|---|---|
| `create_entity` | `entity.create` | direct-apply (bounded) |
| `create_attribute` | `claim.add` | direct-apply (bounded) |
| `supersede_attribute` | `claim.supersede` | direct-apply (bounded, append-only) |
| `update_aspect` | `aspect.rename` | **pending review** (not bounded) |
| `merge_entities` | `entity.merge` | **pending review** (destructive) |
| `delete_entity` | `entity.archive` | **pending review** (destructive) |
| `delete_attribute` | `claim.archive` | **pending review** (destructive) |

The destructive kinds map to operations OUTSIDE 008c's `DIRECT_APPLY_OPERATIONS`
allow-list, so the control plane's risk router ALWAYS sends them to pending review —
the harness needs no special-casing. A non-empty `riskNote` on a mutation pushes even
an additive op to review (D-6). Raw artifacts are NEVER rewritten (the apply path has
no code path that reaches `sessions`/`source`/memory tables — c-AC-3 inherited from
008c).

## The mutation contract (`contracts.ts`)

The model returns a `DreamingMutationSet`: `{ mutations: DreamingMutation[], summary,
tokenBudget }`. Each `DreamingMutation` is `{ kind, payload, rationale, confidence,
riskNote }`. `payload` is the genuinely-schemaless body the harness threads into the
008c proposal payload — shape it per the target operation (e.g. `entity.create`
reads `name`/`type`; `claim.supersede` reads `entityId`/`aspectId`/`groupKey`/
`claimKey`/`content`; see `ontology/control-plane.ts` `applyBoundedOperation` for the
exact keys each operation reads).

## Module + test locations

| Module | Stub (fill this) | Test (name each `describe` after the AC it proves) |
|---|---|---|
| 009b incremental runner | `dreaming/incremental.ts` | `tests/daemon/runtime/dreaming/incremental.test.ts` |
| 009c compaction + CLI | `dreaming/compaction.ts` | `tests/daemon/runtime/dreaming/compaction.test.ts` |

The 009a trigger test is `tests/daemon/runtime/dreaming/trigger.test.ts` (DONE).
Optional opt-in LIVE tests (gated, throwaway table, highest-version read) go under
`tests/integration/*.itest.ts`. No `.skip` / `.only`; `vitest run` is CI. Drive a
FAKE transport + a FAKE `ModelClient` (`createFakeModelClient({ memory_dreaming:
'<json>' })`) + a FAKE queue — assert the emitted scoped SQL, the escaping, the
mutation→operation mapping, the routes, and the state update.

## Reaching storage / catalog / SQL safety

- `storage` — the `StorageQuery` client. **Never a raw fetch.** All writes go through
  the `writes.ts` primitives or `submitProposal`; reads through guarded statements.
  `audit:sql` scans `src/daemon` (the whole daemon), so EVERY value goes through
  `val.*` / `sLiteral` / `sqlLike` and EVERY identifier through `sqlIdent`. Never
  hand-quote a value.
- `scope` — the `{ org, workspace }` partition (the OUTER ring). The INNER ring is the
  `agent_id` conjunct every engine-table read/write carries (D-1 / a-AC-6).
- Resolve a `HealTarget` via `healTargetFor("dreaming_state")` from
  `catalog/index.js` — never re-state columns.

## Idempotency on the LIVE backend

A DETERMINISTIC id + a POLL-CONVERGENT highest-version read (the trigger's
`readState` already does this for `dreaming_state`; the job queue does it for
`memory_jobs`). Reuse the pattern; do not single-shot a by-id read on the live
backend — a single read can land on a stale segment and under-report the version.

## Daemon assembly is DEFERRED

Wave 1 is constructed-and-tested, not wired into the running daemon. The queue
handler that leases a `dreaming` job and invokes the runner with the mode-selected
strategy — plus the maintenance-loop tick calling `checkAndEnqueueDreaming` and the
summary-writer calling `incrementDreamingCounter` — land when 009b/009c are filled and
the assembly step runs. Keep every export's signature stable so assembly is a pure
wiring step.
