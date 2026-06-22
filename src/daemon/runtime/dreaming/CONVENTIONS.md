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

## Locked decisions (binding — D-1..D-6, see library/ledger/EXECUTION_LEDGER-prd-009.md)

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

## The daemon-resident worker (PRD-026, `worker.ts`)

PRD-009 left a gap: nothing in the LIVE daemon CONSUMES a `dreaming` job. The trigger
enqueues and the runner can run, but no harness leased a `dreaming` job and invoked the
runner. PRD-026 Wave 1 Track B fills that with `worker.ts` — `createDreamingWorker(deps)`
→ a `DreamingJobWorker` modelled on `pipeline/stage-worker.ts` (same `runOnce()` /
`start()` / `stop()` shape, overlap guard, injected `setTimer`/`clearTimer`).

`runOnce()`:

1. `queue.lease(["dreaming"])` — the additive kind filter (below). `null` → return false.
2. `parseDreamingJobPayload(leased.payload)`. A malformed payload → `queue.fail(id, …)`,
   return true (NEVER a silent `complete` of a job we never ran).
3. Select the strategy by mode (D-4): `compaction` when `mode === "compaction"` OR the
   first-run backfill rule (`shouldEnterCompaction(config, lastPassAt)`, resolving
   `last_pass_at` via the injected trigger's `readState`) fires; else `incremental`.
   `maxInputTokens` is threaded from the resolved `memory.dreaming` config.
4. Construct the runner (injected `ModelClient`, the `{org,workspace}` scope, the
   strategy, the state-updater) and `await runner.runPass(job)`.
5. On success `queue.complete(id)`; on throw `queue.fail(id, message)` — the stage-worker
   try/catch shape (`dreaming.worker.*` events), never a swallowed error.

The worker holds NO provider/SQL knowledge: the model is the injected 006 `ModelClient`,
every write goes through the runner's `submitProposal` + the trigger's append-only path,
and it issues NO direct SQL (`audit:sql` clean).

### The kind-filtered lease (`services/job-queue.ts`)

`JobQueueService.lease(kinds?: readonly string[])` is ADDITIVE: omitting `kinds` leases
ANY kind (existing callers unchanged); supplying `["dreaming"]` leases ONLY a dreaming
job, leaving `summary` / `skillify` jobs queued for their own worker. Without this, a
generic lease would grab a foreign job, fail to parse it, and `fail()` it — walking a
legit job toward `dead`. The filter threads into `selectLeasable` (filter `states` by
`kinds.includes(s.type)`).

### The state-updater wiring (additive trigger method)

The runner's `DreamingStateUpdater.recordPassComplete(agentId, passAt)` is the b-AC-5
seam. The worker builds it from the trigger via a NARROW, ADDITIVE public method added to
`DreamingTrigger`: `recordPassComplete(scope, passAt)` — it reads the current state and
appends a version that stamps `last_pass_at = passAt` and clears `pending_job_id`,
reusing the trigger's existing `appendVersion` (the SAME path the terminal-clear takes),
never a new in-place write. The worker's `DreamingTriggerSeam` dep exposes just
`readState` + `recordPassComplete`; the worker adapts `(agentId, passAt)` onto
`(scope, passAt)`.

## Enablement — operator guide (PRD-026, D-1)

The dreaming loop is a PREMIUM tier: it makes real model calls (the `memory_dreaming`
workload), so the SHIPPED default stays **OFF**. Turning it on is ONE knob, but read
the posture below before flipping it for a fleet.

### The enable knob

```bash
# Off (the shipped default) — the counter still accumulates, but NO pass is queued
# and the daemon-resident worker is never even constructed.
HONEYCOMB_DREAMING_ENABLED=false   # or simply unset

# On — the gated worker is built + started at assembly (it leases ONLY ["dreaming"]),
# the trigger enqueues at threshold, and a real consolidation pass runs.
HONEYCOMB_DREAMING_ENABLED=true
```

Sibling tuning knobs (all clamp-and-default, never fatal on a typo — see `config.ts`):

| Env var | Default | Effect |
|---|---|---|
| `HONEYCOMB_DREAMING_ENABLED` | `false` | Master switch. OFF → counter grows, nothing queued, worker not built. |
| `HONEYCOMB_DREAMING_TOKEN_THRESHOLD` | `100000` | Tokens-since-last-pass that queues a pass; the reset SUBTRACTS this (FR-5). |
| `HONEYCOMB_DREAMING_MAX_INPUT_TOKENS` | `128000` | Input budget a pass's payload is sampled to (compaction). |
| `HONEYCOMB_DREAMING_BACKFILL_ON_FIRST_RUN` | `true` | First run with no prior pass enters compaction (full graph) not incremental. |

When ON, the real pass ALSO needs the inference model wired: an `agent.yaml`
`inference:` block at the workspace root with the `memory_dreaming` workload, plus the
`ANTHROPIC_API_KEY` stored in the machine-bound `.secrets/` store and referenced as
`${ANTHROPIC_API_KEY}` (PRD-026 AC-T). Absent the key, the daemon still boots cleanly:
`buildInferenceModelClient` degrades to the no-op client and dreaming yields empty,
zero-mutation passes (never a failed job, never a crash).

### Triggering a pass manually

The automatic trigger is the maintenance-loop tick at threshold. To force one NOW:

```bash
# Enqueue a pass on the loopback daemon (the diagnostics "Dream now" seam).
honeycomb dream trigger

# Ask for a full-graph COMPACTION pass (vs the steady-state incremental).
honeycomb dream trigger --compact
```

`honeycomb dream trigger` POSTs to `POST /api/diagnostics/dream` through the loopback
daemon client (the same actor/scope headers every CLI verb stamps). The ack is the
decision only — `enqueued` (a pass was queued), `running` (a pass is already in flight
or the counter is below threshold), or `skipped` + `disabled` (the master switch is
off, pointing you back at `HONEYCOMB_DREAMING_ENABLED=true`). The ack carries NO token
or secret (AC-6).

### The default-flip posture (D-1)

> **The shipped default stays OFF until the AC-5 live proof exists; ON is then a one-line flip.**

Flipping the SHIPPED default ON (so a fresh install dreams without an explicit knob) is
licensed ONLY by the AC-5 behavioral proof:
`tests/integration/dreaming-consolidation-live.itest.ts` — a real pass, against live
DeepLake with the real model, that consolidates a seeded messy graph (dups merge or a
merge proposal goes pending; stale claim superseded; junk archived/pending) WITHOUT
losing anything source-backed, with the measured before/after delta recorded in the
itest output. Until that artifact exists, leaving the default OFF protects a free-tier
user from surprise model spend. The knob above is the opt-in in the meantime.

## Daemon assembly is DEFERRED (the Wave-1c bee, NOT this one)

The worker is CONSTRUCTED-AND-TESTED here; it is NOT wired into the running daemon by
this module. The Wave-1c daemon-assembly bee edits `assemble.ts` to construct AND start
the worker ONLY when `resolveDreamingConfig().enabled` (default OFF), stop it in
teardown, and wire the trigger's `pendingTerminal` probe + the maintenance-loop tick /
summary-writer counter calls. `createDreamingWorker` does NOT decide enablement.
Constructing the worker has no side effects until `start()` / `runOnce()` runs. Keep
every export's signature stable so assembly is a pure wiring step.
