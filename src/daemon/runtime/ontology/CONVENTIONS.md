# Ontology module — CONVENTIONS (PRD-008)

The knowledge-graph ontology lives under `src/daemon/runtime/ontology/` (daemon-only;
the DeepLake path lives only in the daemon bundle — the invariant test enforces it).
Wave 1 built the shared contracts, the **shared supersede-by-version-bump helper**, and
008a (the entity model + the inline linker), and pre-wired the 008b / 008c stubs.
Wave 2's two Bees each fill ONE module + its test file, contention-free.

**Read this file before filling a stub.** It is the contract Wave 2 follows.

## The three write paths into the graph

| Path | Who | Module | Cost |
|---|---|---|---|
| Inline linker | 008a (Wave 1, DONE) | `entity-model.ts` | Cheapest: model-free, no I/O, links only |
| Background bulk writer | 006d (shipped) | `pipeline/graph-persist.ts` | Heavy: upserts entities from extraction |
| Control plane | 008c (Wave 2) | `control-plane.ts` | Most trust-controlled: audited proposals |

008b (dependencies + supersession) is the shared mechanic the control plane and the
pipeline both invoke — not a fourth path.

## Shared files — DO NOT TOUCH (Wave-1 surface)

| File | What it owns |
|---|---|
| `contracts.ts` | `EntityRef`, `Aspect`, `AttributeSlot`, `Attribute` (+ provenance), `Proposal`, `Assertion`, the fixed D-1 `ENTITY_TYPES`, the operation/predicate/status enums, and the `parseProposal` / `parseAssertion` boundary validators. The cross-module shapes. A genuinely new cross-module field is a Wave-1 change (raise it), not a stub edit. |
| `supersede.ts` | `supersedeClaim` — THE append-only version-bump core. Both 008b and 008c reuse it. Also `attributeVersionId`, `slotClaimKey`, and the re-exported catalog `buildSupersedeMarkSql` / `buildHighestActiveVersionSql` / `CLAIM_ACTIVE` / `CLAIM_SUPERSEDED`. |
| `entity-model.ts` | 008a — FILLED. `writeEntity` / `writeAspect` / `writeAttribute`, aspect weighting (`confirmAspectWeight` / `decayAspectWeight`), and the inline linker (`inlineLinkMemory`, `extractProperNounCandidates`). |

A Wave-2 Bee ADDS its own logic to its stub module + its own test; it does NOT edit
any shared file, and it does NOT edit the OTHER Bee's stub.

## The contracts you consume (`contracts.ts`)

- **`EntityRef`** `{ id, canonicalName, displayName?, type: EntityType }` — a canonical
  entity reference. `id` is deterministic off agent + canonical name. Scope is NOT on
  the ref; it rides the `QueryScope` partition + the `agentId` you thread.
- **`Aspect`** `{ id, entityId, name, weight }` — a weighted dimension. Floor `0.1`,
  ceiling `1.0` (`ASPECT_WEIGHT_FLOOR` / `ASPECT_WEIGHT_CEILING`).
- **`AttributeSlot`** `{ groupKey, claimKey }` — the addressable claim slot (a-AC-5).
- **`Attribute`** `{ id, aspectId, slot, kind, status, content, confidence, importance,
  version, provenance }` — `kind` ∈ `attribute|constraint`, `status` ∈
  `active|superseded|deleted`. `provenance.memoryId` is MANDATORY (a-AC-3).
- **`Proposal`** (zod boundary): `{ operation, status, payload, confidence, rationale,
  riskNote, provenance }`. Validate with `parseProposal(candidate) → Proposal | null`.
- **`Assertion`** (zod boundary): `{ predicate, content, speaker, confidence, evidence,
  status, claimKey? }`. Validate with `parseAssertion(candidate) → Assertion | null`.

## The `supersedeClaim` helper you REUSE (`supersede.ts`)

This is the single most important Wave-1 artifact for both Bees. Do NOT re-implement
the append + mark — call this:

```ts
import { supersedeClaim, type SupersedeResult } from "./supersede.js";

const result: SupersedeResult = await supersedeClaim(storage, scope, {
  entityId,            // the entity the claim hangs under (audit context)
  aspectId,            // the aspect the claim hangs under
  groupKey, claimKey,  // the addressable slot (a-AC-5)
  newAttribute: {      // the claim to land as the new active version N+1
    kind, content, confidence, importance,
    provenance: { memoryId, source, proposalId? },  // memoryId MANDATORY
    agentId, visibility?,
  },
  priorId?,            // the prior sibling id when you already know it (skips the read)
});
// → { newId, version, supersededId }
```

What it guarantees (so you don't have to):

- APPENDS the new claim at `version` N+1 with `status='active'` (heal-aware).
- MARKS the prior sibling `status='superseded'` + `superseded_by=newId` — a single
  deliberate UPDATE of a DISTINCT prior row, content left INTACT, full history on disk
  (b-AC-1 / b-AC-2 / c-AC-4).
- NEVER an in-place mutate of a claim row's content (008b FR-6).
- Resolves the prior id POLL-CONVERGENTLY when you don't pass `priorId` (the live
  segment-freshness flap is handled — see `pipeline/graph-persist.ts` for why).

It is MECHANISM, not POLICY: the constraint-exemption (D-7 / b-AC-5) and the
risk-routing (D-6) live in the CALLER, not in `supersedeClaim`. A deliberate
`claim.supersede` of a constraint through the control plane is legitimate.

## Reaching storage / catalog / SQL safety

Every function takes `(storage: StorageQuery, scope: QueryScope, …)`:

- `storage` — the `StorageQuery` client. **Never a raw fetch.** All writes go through
  the `writes.ts` primitives (`appendOnlyInsert` / `appendVersionBumped` /
  `updateOrInsertByKey`), each heal-aware via `withHeal`. `audit:sql` scans `src/daemon`.
- `scope` — the `{ org, workspace }` partition (the OUTER scope ring). The INNER ring is
  the `agent_id` conjunct every engine-table read/write carries (D-2 / a-AC-6).
- Resolve a `HealTarget` via `healTargetFor("<table>")` from `catalog/index.js` — never
  re-state columns.
- Every value through `val.str()` / `val.text()` / `val.num()` (the guarded path) or
  `sLiteral` / `sqlLike`; every identifier through `sqlIdent`. NEVER hand-quote a value.

## Scope discipline (D-2 / a-AC-6) — engine tables

`entities`, `entity_aspects`, `entity_attributes`, `entity_dependencies`,
`memory_entity_mentions`, `epistemic_assertions`, `ontology_proposals` are ALL
engine-scoped (`scope: "agent"`): they carry `agent_id` (default `'default'`) +
`visibility`, NOT explicit `org_id`/`workspace_id` columns. So "scoped by
org/workspace/agent_id" = the partition `QueryScope` (org + workspace) + the
`agent_id = '<self>'` conjunct on every statement. A read that omits the agent
conjunct can cross the agent boundary — always include it.

## Write patterns (from the catalog, PRD-002d / 003b)

| Table | Pattern | Primitive |
|---|---|---|
| `entities` | update-or-insert | `updateOrInsertByKey` (by deterministic id) |
| `entity_aspects` | update-or-insert | `updateOrInsertByKey` (by deterministic id) |
| `entity_attributes` | version-bumped | append via `supersedeClaim` / `writeAttribute` |
| `entity_dependencies` | append-only | `appendOnlyInsert` (008b) |
| `memory_entity_mentions` | append-only | `appendOnlyInsert` (linker, DONE) |
| `epistemic_assertions` | version-bumped | `appendVersionBumped` (008c) |
| `ontology_proposals` | append-only | `appendOnlyInsert` (008c; status advances by NEW row) |

Idempotency on this LIVE backend = a DETERMINISTIC id + a POLL-CONVERGENT dedup probe
(see `isPresentById` in `entity-model.ts` and the module headers). Reuse the pattern;
do not single-shot a probe.

## Where each Wave-2 module + test lives

| Module | Stub | Test (name each `describe` after the AC it proves) |
|---|---|---|
| 008b dependencies + supersession | `ontology/dependencies.ts` | `tests/daemon/runtime/ontology/dependencies.test.ts` |
| 008c control plane | `ontology/control-plane.ts` | `tests/daemon/runtime/ontology/control-plane.test.ts` |

Optional opt-in LIVE tests (gated, throwaway table, the highest-version read):
`tests/integration/ontology-supersede-live.itest.ts` (Wave 1 pattern) and an apply
smoke. No `.skip` / `.only`; `vitest run` is CI. Drive a FAKE transport — assert the
emitted scoped SQL, the escaping, the slot keys, and the version-bump SQL.

### Filling 008b

1. Fill `writeDependencyEdge` — call `assertDependencyReason(type, reason)` FIRST
   (rejects a loose `related_to` with no reason, b-AC-3), then `appendOnlyInsert` the
   edge with `strength` / `confidence` (the values 007b's gate reads, b-AC-4).
2. Fill `supersedeOnConflict` — the conflict detector (lexical overlap + negation/
   antonym, + optional LLM fallback via the `ModelClient` seam OFF by default, D-5),
   then SKIP a `constraint` prior (D-7 / b-AC-5), else call `supersedeClaim`.
3. Do NOT touch `supersede.ts`, `contracts.ts`, `entity-model.ts`, or `control-plane.ts`.

### Filling 008c

1. Fill `submitProposal` — `parseProposal` (c-AC-6) → risk-route (D-6: bounded ops in
   `DIRECT_APPLY_OPERATIONS` + low risk note apply directly + an applied row with
   evidence copied onto the resulting rows, c-AC-1; everything else → pending, c-AC-2).
   A `claim.supersede` invokes `supersedeClaim` (c-AC-4). NEVER rewrite raw artifacts
   (c-AC-3).
2. Fill `recordAssertion` — `parseAssertion` (c-AC-5) → `appendVersionBumped` into
   `epistemic_assertions`; NEVER auto-promote into a claim (008c FR-8).
3. Wire the `honeycomb ontology` CLI (`stream apply --dry-run` reports the plan without
   mutating, scoped by org/workspace/agent — c-AC-7).
4. Do NOT touch `supersede.ts`, `contracts.ts`, `entity-model.ts`, or `dependencies.ts`.

## Daemon assembly is DEFERRED

Wave 1 is constructed-and-tested, not wired into the running daemon. The pipeline
hand-off (the linker running right after the memory commit) and the CLI registration
land when 008b/008c are filled and the assembly step runs. Keep every export's
signature stable so the assembly is a pure wiring step.
