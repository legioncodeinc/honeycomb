# PRD-058c: Stale code-reference detection and healing

> **Parent:** [PRD-058 Memory Lifecycle](./prd-058-memory-lifecycle-index.md)
> **Implements:** the `σ(m,t)` term of [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M
> **Schema changes:** Additive (lazy-healed columns on `memories`)

---

## Phase Overview

### Goals

A memory that names code that no longer exists is silently wrong. A memory that says "embeddings flow through `src/daemon/storage/noopEmbedClient`" reads as authoritative right up until an agent follows the path and finds nothing there, having burned a turn. This sub-PRD implements the **staleness term `σ(m,t)`** from the scoring model: it extracts the code references a memory makes, resolves each against the live codebase-graph snapshot (PRD-014), and turns the fraction that no longer resolve into a bounded staleness probability that demotes the memory in recall.

The work runs as a diagnostic in the existing maintenance worker (`observe` / `execute`), so detection ships visible-but-inert first and only changes ranking once an operator trusts it. Staleness never deletes a row: it is a soft re-ranking signal that composes with 058a's recency multiplier, and a reference that returns (a branch switch restores a file, a rename is reverted) flips the memory back to fresh on the next snapshot. Detection and healing append to `memory_history` exactly like every other lifecycle action, so the audit trail is total even though salience changes.

### The equation this implements

From the scoring model, Term 3. Each extracted reference resolves against the latest snapshot `G_t` with a per-reference probability:

```text
resolve(r, G_t) ∈ [0,1]
  = 1            if r matches a symbol in G_t exactly
  = sim(r, r*)   if the best fuzzy match r* in G_t (rename candidate) is close
  = 0            if r looks like indexed code but is absent
  = (excluded)   if r is outside the indexed graph → contributes nothing (unknown)
```

Staleness is the probability that *at least one* in-scope reference is dangling, the empty-product giving `σ = 0` for a memory with no indexed references:

```text
σ(m,t) = 1 − Π_{r ∈ refs_indexed(m)} [ resolve(r, G_t) · v(m,t) ]
```

`v(m,t)` is the **verification-freshness** factor that decays trust in the last check, so the system re-verifies rather than trusting one stale read forever:

```text
v(m,t) = 2^( −(t − verified_at(m)) / h_verify )      h_verify default 14 d
```

When `v` falls below a re-verification threshold the memory is re-queued for a fresh snapshot check (spaced re-verification, the staleness analogue of 058e's reinforcement). The master equation's contribution is the demotion `(1 − σ)^s`, where `s` is the staleness exponent: under the maintenance worker's `observe` posture `s = 0` (the factor is the identity, staleness is visible but inert), under `execute` `s > 0` (measured, demotion applied). Crucially `(1 − σ)^s` feeds the **same recency-multiplier stage** 058a owns, not a second independent score path: staleness is one more bounded `(0,1]` input multiplied into that single demotion step, so the two signals compose and never fight. `P ≤ R` still holds; staleness can only demote, never invent relevance.

### Scope

- A maintenance-worker diagnostic that, for each memory carrying extractable code references (file paths, `file#symbol`, qualified symbol names, flag identifiers), classifies each reference via `resolve(r, G_t)` against the latest codebase-graph resolution snapshot for that workspace and computes `σ(m,t)`.
- A conservative reference extractor that pulls candidate references from memory content. Over-matching is safe by construction: a token that *looks* like indexed code but is absent becomes `stale`, a token outside the indexed graph becomes `unknown`, never `stale`.
- The verification-freshness factor `v(m,t)` and a `verified_at` timestamp, so trust in a check decays and spaced re-verification is driven by `h_verify`.
- A `ref_status` signal (`fresh` / `stale` / `unknown`) and the specific unresolved `stale_refs`, written via additive lazy-healed columns.
- Staleness fed as an input into the 058a recency-multiplier stage, gated by posture: `observe` (`s = 0`, flag only), `execute` (`s > 0`, demote, never hard-drop). All actions recorded to `memory_history`.

### Out of scope

- The recency math itself and the demotion mechanics of the multiplier stage (sub-PRD 058a); this sub-PRD only feeds `(1 − σ)` into that stage.
- Auto-rewriting the memory's text to the new path. Detection and demotion only; a rewrite is a supersession and belongs to the conflict path (sub-PRD 058b).
- References to code outside the indexed graph (third-party libs, npm specifiers, external URLs). Those are `excluded` from the product and surface as `unknown`, never `stale`.
- Fuzzy-rename similarity tuning beyond a documented default `sim`; the rename-candidate threshold is a sweep point, not a fixed assertion.
- Hard time-based deletion or expiry of stale memories -> retention worker, PRD-030.
- The activation-paced re-verification *scheduler* (which memories get re-checked how often) -> sub-PRD 058e drives the cadence from activation; this sub-PRD provides the per-check `σ` and the `verified_at` it reads.

### Dependencies

- **Blocked by:** PRD-014 codebase graph (resolution snapshot + the synthesized `graph/` query surface). Already shipped.
- **Composes with:** sub-PRD 058a (its recency multiplier is the stage staleness demotes through), sub-PRD 058e (activation paces re-verification frequency; `verified_at` is the staleness analogue of `last_reinforced_at`), sub-PRD 058d (dashboard surface, the `s` exponent config).

---

## User Stories

### US-55c.1 - Dangling references are detected, fresh ones left alone, unknowns held neutral

**As a** memory store, **I want** to know when a memory names a symbol the codebase no longer has, **so that** I stop surfacing it as authoritative without punishing memories whose references I simply cannot see.

**Acceptance criteria:**
- AC-55c.1.1 Given a memory referencing `src/foo/bar.ts#doThing` and the latest resolution snapshot has no such symbol, when the diagnostic runs, then that reference resolves `resolve = 0`, so `σ = 1`, and the memory is marked `ref_status = 'stale'` with `verified_at = now()` and the unresolved reference recorded in `stale_refs`.
- AC-55c.1.2 Given a memory whose every reference resolves exactly in the snapshot, when the diagnostic runs, then each `resolve = 1`, the product is `1` (modulo `v`), `σ ≈ 0`, and it is marked `ref_status = 'fresh'`.
- AC-55c.1.3 Given a memory referencing a path outside the indexed graph (a bare npm specifier, an external URL, a file the graph does not cover), when the diagnostic runs, then that reference is `excluded` from the product and the memory is marked `unknown`, never `stale`.
- AC-55c.1.4 Given a memory with no extractable indexed references at all, when the diagnostic runs, then by the empty-product convention `σ = 0` and the memory is treated as non-stale (`fresh`-equivalent for ranking), never demoted.
- AC-55c.1.5 Given a reference whose best snapshot match is a close fuzzy rename candidate `r*`, when the diagnostic runs, then it contributes `resolve = sim(r, r*) ∈ (0,1)` rather than a hard `0`, so a likely rename demotes partially rather than flagging fully stale.

### US-55c.2 - Healing posture is governed, never an automatic silent change

**As an** operator, **I want** stale-ref handling to default to observe-only and, when active, to demote rather than delete, **so that** detection never silently changes recall before I trust it and never loses a memory.

**Acceptance criteria:**
- AC-55c.2.1 Given the worker posture is `observe` (`s = 0`), when a stale ref is found, then `(1 − σ)^s = (1 − σ)^0 = 1`: the memory is flagged and surfaced in the dashboard but its recall ranking is unchanged.
- AC-55c.2.2 Given the posture is `execute` (`s > 0`) and demotion is enabled, when a stale ref is found, then `(1 − σ)^s < 1` is fed into the 058a recency-multiplier stage so the memory's effective recall score is demoted, never hard-dropped and never removed from the result set by staleness alone.
- AC-55c.2.3 Given a reference returns in a later snapshot (a branch switch restored the file, a rename was reverted), when re-verification runs, then `resolve` climbs back to `1`, `σ` falls, `ref_status` flips back to `fresh`, and any demotion is lifted.
- AC-55c.2.4 Given any detection or heal action, when it is applied, then it is appended to `memory_history` (actor, reason, the `σ` value and `stale_refs`), so the change is auditable and reversible.

### US-55c.3 - Re-verification is spaced and eventual-consistency safe

**As a** maintenance worker, **I want** to re-check stale refs against fresh snapshots rather than trusting one read, **so that** a transient or lagging snapshot does not permanently mislabel a memory and trust decays until re-confirmed.

**Acceptance criteria:**
- AC-55c.3.1 Given a memory whose `verified_at` is old enough that `v(m,t) = 2^(−(t − verified_at)/h_verify)` has dropped below the re-verification threshold, when the worker schedules work, then the memory is re-queued for a fresh snapshot check.
- AC-55c.3.2 Given a memory marked `stale`, when the codebase graph publishes a newer resolution snapshot, then a re-verification job re-checks its references against the new snapshot rather than trusting the prior verdict.
- AC-55c.3.3 Given snapshot reads can lag (DeepLake eventual consistency), when the diagnostic reads the snapshot, then it polls to convergence rather than acting on a single immediate read, because a single read can see a stale segment and wrongly flag a live symbol.

---

## Data Model Changes

| Model | Change | Type | Nullable | Default | Index |
|---|---|---|---|---|---|
| `memories` | `ref_status` | `enum('fresh','stale','unknown')` | yes | null | index |
| `memories` | `verified_at` | `timestamptz` (drives `v(m,t)` and spaced re-verification) | yes | null | no |
| `memories` | `stale_refs` | `text[]` (the specific unresolved references) | yes | null | no |

Added via additive lazy schema-healing (`healMissingColumns`), consistent with the way the pipeline creates tables and columns lazily on first write (see `memory-pipeline.md`). No migration step, no backfill. Existing rows read as `null` and are treated as `unknown` until first verified, which keeps them neutral in ranking (an `unknown` memory is not demoted). `verified_at` is the staleness analogue of 058e's `last_reinforced_at`: the timestamp the freshness factor `v` decays from.

---

## API / Endpoint Specs

No new public write endpoint. Detection runs inside the maintenance worker, so staleness cannot be spoofed by a client. The `ref_status`, `verified_at`, and `stale_refs` fields are exposed **read-only** on the memory shape returned by the existing memories API and on the recall response, so the dashboard (sub-PRD 058d) and agent consumers can render them alongside `freshnessScore` (058a) and the other health signals.

A manual trigger is exposed through the existing maintenance `observe` / `execute` diagnostic runner (consistent with the other maintenance diagnostics described in `memory-pipeline.md`), not a bespoke endpoint. Recall responses gain a per-hit `staleness` (the `σ` value) and `refStatus`, so a consumer can see why a memory was demoted:

```jsonc
{
  "results": [
    {
      "source": "memories",
      "id": "…",
      "score": 0.62,
      "freshnessScore": 0.93,
      "staleness": 1.0,
      "refStatus": "stale",
      "staleRefs": ["src/daemon/storage/noopEmbedClient"],
      "degraded": false
    }
  ]
}
```

---

## Technical Considerations

- **Conservative reference extraction.** Pull candidate references from memory content with a conservative matcher (path-like tokens, `file#symbol`, qualified symbol names, flag identifiers). Over-matching is safe by construction: a real-looking-but-absent token resolves to `unknown` when it is outside the indexed graph and only to `stale` when it *looks* like indexed code and the snapshot lacks it. The asymmetry is deliberate, the failure mode of an aggressive matcher is "more `unknown`," not "more false `stale`."
- **Snapshot is the oracle, not the filesystem.** Resolution is a lookup against the codebase-graph resolution snapshot for the workspace via the PRD-014 query surface (`find/`, `show/`, the node id format `<source_file>:<symbol>:<kind>`), not a `stat` of the working tree. This respects the daemon's indexed view and the org/workspace/agent tenancy every stage threads, and it means staleness reflects what the graph knows, not what one checkout happens to have on disk. The graph's own honest caveat (a "0 incoming" node is not proof of dead code) is why absence is scored as a dangling reference only for exact-id misses, with fuzzy-rename `sim` catching the common rename case.
- **Verification-freshness drives re-checks.** `v(m,t)` decays trust in `verified_at` on a `h_verify`-day half-life. A memory verified fresh weeks ago is not trusted indefinitely; once `v` crosses the threshold it is re-queued. This is the staleness analogue of reinforcement: trust is earned by a recent check, not a one-time stamp.
- **Eventual-consistency poll-to-convergence.** Per the repo's hard rule, snapshot read-backs poll until convergence. A single immediate read can see a stale segment and wrongly flag a live symbol; the diagnostic never acts on one read.
- **Composition, not duplication, with 058a recency.** Demotion is expressed as the `(1 − σ)^s` factor fed *into* the single 058a recency-multiplier stage, not as a parallel score path. The two signals multiply into one demotion step, so they compose cleanly and a memory is never double-penalized through two competing pipelines.
- **Fail-soft everywhere.** If the codebase graph is unavailable for a workspace, the diagnostic marks nothing `stale` (everything stays `unknown`), logs, and returns; it never mass-flags on a missing oracle. Recall never throws or hangs on this path, a missing or unparseable `σ` is treated as `unknown` (neutral), exactly as 058a treats a missing timestamp as maximally fresh. A degraded staleness estimate beats a 500.

---

## Files Touched

### New files
- `src/daemon/runtime/maintenance/stale-ref-diagnostic.ts` - the cross-reference diagnostic: resolve each reference via the snapshot, compute `σ(m,t)` and `v(m,t)`, write `ref_status` / `verified_at` / `stale_refs`, append to `memory_history`, and emit the heal action by posture.
- `src/daemon/runtime/maintenance/reference-extract.ts` - the conservative reference matcher (path-like tokens, `file#symbol`, qualified symbols, flag identifiers).
- `tests/daemon/runtime/maintenance/stale-ref-diagnostic.spec.ts`
- `tests/daemon/runtime/maintenance/reference-extract.spec.ts`

### Modified files
- the maintenance worker registration (per `memory-pipeline.md`, the diagnostics runner) - register the diagnostic and its `observe` / `execute` wiring and the manual-trigger path.
- `src/daemon/runtime/memories/recall.ts` - accept the `(1 − σ)^s` staleness demotion as an input into the existing 058a recency-multiplier stage (not a new stage); emit `staleness`, `refStatus`, `staleRefs` on each hit.
- `src/daemon/storage/schema` source - additive `ref_status` / `verified_at` / `stale_refs` ColumnDefs, healed via `healMissingColumns`.
- the eval harness (`src/eval/*`) - the staleness precision / recall / F1 slice against a labeled dangling-ref set.

---

## Test Plan

- **Unit:** reference-extraction precision (path-like, `file#symbol`, flag tokens; prose that merely mentions a word does not match an indexed symbol); `resolve` classification (exact -> `1`, fuzzy rename -> `sim`, indexed-but-absent -> `0`, out-of-graph -> excluded); the `σ` product including the empty-product `σ = 0` case; `v(m,t)` half-life math (`v = 0.5` at `Δt = h_verify`); fail-soft on a missing graph (everything `unknown`, nothing `stale`).
- **Integration:** a memory referencing a symbol present in the snapshot, then the symbol deleted from the snapshot, then re-added, asserting `ref_status` transitions `fresh -> stale -> fresh` and the demotion is applied then lifted (AC-55c.2.3).
- **Consistency:** assert the diagnostic polls the snapshot to convergence rather than single-reading, and that a transient stale segment does not produce a persisted `stale` verdict (AC-55c.3.3).
- **Eval:** a staleness slice in the lifecycle eval suite computing staleness precision / recall / F1 against a labeled dangling-ref set (do we flag the dead references and only those?); commit the slice result so the choice of `sim` threshold and `s` is auditable, not asserted.
- **Live dogfood:** against a real repo index, delete a referenced symbol, run maintenance under `observe` and confirm `stale` surfaces in the dashboard with the right `stale_refs` and recall ranking unchanged; flip to `execute` and confirm the memory demotes through the 058a stage and never hard-drops; re-add the symbol, run re-verification, and confirm it flips back to `fresh` and the demotion lifts.

---

## Risks and Open Questions

- **Risk:** aggressive reference extraction flags prose that merely mentions a path or a common word. **Mitigation:** the conservative matcher plus the `unknown`-default asymmetry (out-of-graph -> `unknown`, not `stale`) plus observe-only posture by default; a mis-extracted token that is not an indexed symbol resolves to `unknown` and is neutral.
- **Risk:** a branch switch makes half the repo's symbols look stale at once. **Mitigation:** re-verification plus poll-to-convergence so a lagging or transient snapshot self-corrects, the `v(m,t)` re-check cadence, and demotion-not-deletion so a transient mass-flag is reversible on the next snapshot (a flipped-back `fresh` lifts the demotion, no row was lost).
- **Open question:** should `stale_refs` cap its array length for very reference-dense memories? Likely cap at a small `N` and record the overflow as a count rather than storing every unresolved token; confirm the cap against dogfood data on the most reference-heavy memories.

---

## Related

- [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md) - the `σ(m,t)` term (Term 3), the `resolve` cases, and the `(1 − σ)^s` demotion this implements.
- [`prd-058-memory-lifecycle-index.md`](./prd-058-memory-lifecycle-index.md) - the parent feature PRD.
- [`prd-058a-memory-lifecycle-recency-decay.md`](./prd-058a-memory-lifecycle-recency-decay.md) - the recency-multiplier stage staleness demotes through.
- [`codebase-graph.md`](../../../knowledge/private/data/codebase-graph.md) - the resolution snapshot and `graph/` query surface this diagnostic resolves against.
- [`memory-pipeline.md`](../../../knowledge/private/ai/memory-pipeline.md) - the maintenance worker `observe` / `execute` model and the lazy schema-healing this reuses.
