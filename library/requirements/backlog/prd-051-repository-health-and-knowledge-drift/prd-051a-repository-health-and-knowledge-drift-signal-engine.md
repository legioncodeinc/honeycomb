# PRD-051a: Drift and Staleness Signal Engine

> **Parent:** [PRD-051](./prd-051-repository-health-and-knowledge-drift-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None. Reads existing inputs; writes only a derived, machine-local health snapshot cache.

---

## Overview

This is the heart of the wedge: a daemon-side engine that turns data Honeycomb already holds into four honest, explainable signals about a single project. It does no I/O against the user's repository beyond reading, and it produces a per-project snapshot that the read API (051b) serves and the page (051c) renders.

The engine is a pure-ish reducer: given the codebase graph, the on-disk knowledge-doc set, the PRD/IRD lifecycle state, and the skillify watermarks for a project, it emits a `HealthSnapshot` of signals plus evidence. Every signal carries the inputs that produced it, so the UI can always answer "why is this flagged."

## Goals

- Compute four signals for a given project id:
  - **Knowledge drift:** for each knowledge doc that references code (an explicit path or a **uniquely-resolving symbol** in the committed symbol roster), classify each reference as **live** (resolves, content hash unchanged since the doc's last edit), **changed** (resolves, hash moved after the doc's edit), or **deleted/renamed** (no longer in the roster). Flag any doc with a changed or deleted reference, ranked with deletion weighted above change, and by how many references moved or disappeared. The roster is built from committed files only, so a dirty working tree never produces phantom drift.
  - **Documentation staleness:** docs whose last-modified is older than the code they reference (relative staleness), with a weaker secondary fixed-age heuristic for docs that reference no resolvable code.
  - **PRD-to-knowledge gap:** a PRD/IRD in `completed/` whose Related code-touchpoints changed in a window during which no file under `library/knowledge/` changed, i.e. shipped-but-undocumented. Flag conservatively.
  - **Skill freshness:** skillify watermark ([`watermark.ts`](../../../../src/daemon/runtime/skillify/watermark.ts)) lag versus recent `sessions` volume for the project; high lag means sessions are accumulating un-mined.
- Emit an explainable `HealthSnapshot` per project: each signal is a list of evidence rows (doc path, code reference, what changed, timestamps) plus a small rolled-up band (Healthy / Watch / Drifting) driven by the worst contributing signal.
- Be **fail-soft on every input**: a missing codebase graph, an empty `library/knowledge/`, no PRDs, or a missing watermark each degrade the affected signal to `insufficient-data`, never a throw and never a falsely-green result.
- Be **deterministic and reconstructable**: same inputs produce the same snapshot; deleting the cache and recomputing yields the same signals.

## Non-Goals

- Serving the snapshot over HTTP (051b) or rendering it (051c).
- Any LLM call. v1 is structural and timestamp/hash-based. Semantic "is the prose still accurate" grading is a future, separately-scoped signal.
- Mutating any knowledge doc, running a Stinger, or triggering skillify. Read-only with respect to the repo.
- Defining nudge thresholds (PRD-053 owns when a signal becomes a reminder).

## User stories

- As the dashboard, I can ask the engine for a project's health and get back a structured, evidence-bearing snapshot I can render without further computation.
- As a developer reading a drift flag, I can see exactly which doc is stale and which code change made it stale, so I trust the flag.
- As a user on a brand-new repo with no graph yet, I see "not enough data" per signal instead of a broken or misleadingly-healthy page.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given a project with a built codebase graph and knowledge docs that reference code, the engine returns a knowledge-drift list where every flagged doc has at least one evidence row naming the referenced code and the change that postdates the doc. |
| a-AC-1b | A doc referencing a symbol/file that no longer resolves in the committed roster (deleted or renamed) is flagged as **deleted/renamed** drift and ranked above a doc with only **changed** references; a test drives a deletion and asserts the state + ranking. References are resolved against committed state only, so a dirty working tree alone never produces a drift flag. |
| a-AC-2 | The engine computes documentation-staleness (relative: doc older than its referenced code) and emits evidence rows; the fixed-age fallback only applies to docs with no resolvable code reference and is labeled as the weaker heuristic. |
| a-AC-3 | The engine computes a PRD-to-knowledge gap by joining a `completed/` PRD's Related code-touchpoints against `library/knowledge/` change activity, and flags only when referenced code changed and no knowledge file changed in the same window (no false positive on a documented change). |
| a-AC-4 | The engine computes skill-freshness from the skillify watermark lag versus recent session volume and emits a magnitude the UI can band. |
| a-AC-5 | Each missing input degrades exactly its dependent signal to `insufficient-data` while the other signals still compute; a unit test drives each missing-input case and asserts no throw and no false-green. |
| a-AC-6 | The rolled-up band is driven by the worst contributing signal and always references the offending signal(s); a test asserts the band cannot read "Healthy" while a Drifting-level signal is present. |
| a-AC-7 | The snapshot is deterministic: recomputing from the same inputs produces an identical signal set (timestamps of computation aside). |

## Implementation notes

- **Reuse the codebase graph as the change oracle, and build the symbol roster from it.** The graph already records content hashes, snapshots, and extracted symbols ([`extract.ts`](../../../../src/daemon/runtime/codebase/extract.ts), [`hash.ts`](../../../../src/daemon/runtime/codebase/hash.ts), [`snapshot.ts`](../../../../src/daemon/runtime/codebase/snapshot.ts), [`query.ts`](../../../../src/daemon/runtime/codebase/query.ts)). Derive a **committed symbol roster** (unique symbol + owning file + content hash) from the commit-addressed snapshot. "Changed" reduces to: resolve the doc's reference in the roster, compare its content hash / last-changed marker to the doc's mtime. "Deleted/renamed" reduces to: the doc's reference was resolvable previously but is absent from the current roster. Do not re-parse the tree; query the existing graph.
- **Reference extraction is the precision lever.** Resolve only explicit relative paths and symbols that resolve **uniquely** in the roster. Ambiguous symbols and fuzzy prose-to-symbol matches are dropped in v1 (precision over recall; a missed drift is safer than a wrong one). A reference into code outside the selected project is ignored for that project's score, not flagged.
- **PRD lifecycle is folder-derived.** A PRD's state is its placement under `backlog/` vs `in-work/` vs `completed/`; its code-touchpoints come from the Related section links the house style already includes. Parse links, not prose.
- **Watermark lag** reads the skillify watermark and the project's recent session count; express lag as both a count and a recency so the UI can choose a representation.
- **Snapshot cache** is written to the runtime dir keyed by the codebase graph's `SnapshotIdentity` (worktree + commit, via [`resolveSnapshotIdentity`](../../../../src/daemon/runtime/codebase/identity.ts)) and grouped under `project_id`, with a computed-at stamp. Keying on worktree+commit (not `project_id` alone) keeps two worktrees of one repo from colliding, and the `commit` in the key self-invalidates the cache on a new commit. It is a cache: any read path must tolerate its absence by recomputing.
- **Contracts file:** define `HealthSnapshot`, `Signal`, and `EvidenceRow` types in a `contracts.ts` next to the engine, mirroring the pattern in [`codebase/contracts.ts`](../../../../src/daemon/runtime/codebase/contracts.ts) and [`skillify/contracts.ts`](../../../../src/daemon/runtime/skillify/contracts.ts), validated with zod at the boundary.

## Resolved decisions

> Settled with the operator on 2026-06-26 (see the [parent index](./prd-051-repository-health-and-knowledge-drift-index.md#resolved-decisions) for full rationale).

- **Reference resolution:** explicit path + uniquely-resolving symbol only; ambiguous symbols dropped; a reference into another project is ignored for this project's score, not flagged.
- **Deletion as drift:** deleted/renamed references (absent from the committed roster) are a first-class state ranked above changed (a-AC-1b).
- **PRD-to-knowledge gap window:** between the PRD entering `completed/` and now; flag only when the PRD's Related code areas changed and no `library/knowledge/` file changed in that window.
- **Skill-freshness scope:** per-project only in v1; team-propagation lag excluded.
- **Snapshot cache:** keyed by `SnapshotIdentity` (worktree + commit), grouped under `project_id`; invalidated on a graph-version/commit bump or explicit refresh.

## Open questions

- [ ] Exact ranking weights between "changed" and "deleted" references when a single doc has both (deletion ranks higher; the precise score blend is an implementation detail with a test).

## Related

- [`src/daemon/runtime/codebase/`](../../../../src/daemon/runtime/codebase/index.ts) — the graph, hashes, snapshots, and query surface the drift oracle reads.
- [`src/daemon/runtime/skillify/watermark.ts`](../../../../src/daemon/runtime/skillify/watermark.ts) and [`miner.ts`](../../../../src/daemon/runtime/skillify/miner.ts) — the skill-freshness inputs.
- [`src/daemon/runtime/codebase/contracts.ts`](../../../../src/daemon/runtime/codebase/contracts.ts) — the contracts/zod pattern this engine's types follow.
- [Codebase Graph knowledge doc](../../../knowledge/private/architecture/system-overview.md) — system context for the graph.
- Sibling sub-PRDs: [051b read-only health API](./prd-051b-repository-health-and-knowledge-drift-read-only-health-api.md), [051c dashboard page](./prd-051c-repository-health-and-knowledge-drift-dashboard-page.md).
