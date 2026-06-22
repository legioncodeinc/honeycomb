# PRD-030 — Memory compaction (bound version-bump growth)

> Status: completed · Owner: `/the-smoker` · Type: M (feature)
> Goal: fill the `compaction.ts` gap so append-only `appendVersionBumped` tables don't grow unbounded — prune
> or collapse superseded + old versions so storage AND highest-version reads stay bounded at scale, WITHOUT
> losing current state or auditable lineage.

> **Reconciliation (2026-06-22):** the `reports/` QA report records a `NOT VERIFIED` Critical (the
> `epistemic_assertions` compaction key-column was mis-mapped to `claim_key` → silent no-op). That fix
> has since landed and been independently verified on `main` — `COMPACTABLE_KEY_COLUMNS.epistemic_assertions = "id"`
> (traced to the `recordAssertion` writer) plus a writer-cross-check guard test that fails on any
> divergence. AC-6 is satisfied; this PRD is complete. See `library/ledger/EXECUTION_LEDGER.md` (gap-track audit).

## Why

The storage write model is append-only by design: `appendVersionBumped` (`src/daemon/storage/writes.ts`)
INSERTs a NEW row at `version` = N+1 on EVERY edit to skills, rules, and claim history; a read takes
`ORDER BY version DESC LIMIT 1`. That correctly survives DeepLake's lack of transactions (it coalesces rapid
in-place UPDATEs and silently drops one) — but it means versioned tables GROW UNBOUNDEDLY: a claim edited
1,000 times is 1,000 rows, and every highest-version read scans all of them. The dreaming `compaction.ts`
exists as a payload strategy for the *graph* (it assembles a full-graph prompt for the model), but there is
NO routine that PRUNES the storage-level version history — nothing reaps superseded/old `version` rows. At
scale this inflates storage AND read cost on the hottest tables. This PRD adds the missing version-history
compactor: bound the row count per key while keeping the current state byte-identical and lineage auditable.

## Scope / What

A compactor that reaps version-bumped history WITHOUT changing current-state reads:

- **What is safe to compact.** ONLY versions strictly BELOW the highest live version per logical key/id, and
  ONLY after a retention window (keep-latest-N and/or a time window) so recent lineage stays auditable. The
  highest-version row per key is NEVER touched — current state is invariant across compaction.
- **Where it runs.** Decide (D-2): a Dreaming pass that couples to PRD-026's enabled runner (compaction-as-
  maintenance, reusing the job queue + single-pending guard) vs a standalone maintenance job. Lay out the
  tradeoff; default toward the standalone maintenance job keyed by the same `dreaming_state`-style cadence so
  it can run even when the premium dreaming loop is OFF.
- **Read-correctness under eventual consistency.** Compaction MUST NOT race a reader into a stale-empty state.
  DeepLake flaps stale segments, so deletes must be ordered so the highest-version row is always resolvable:
  reap old versions only after confirming (poll-convergently) the surviving highest version is durably
  readable. Never delete-then-rely-on-an-immediate-read.
- **Idempotent + crash-safe.** Re-running compaction on an already-compacted key is a no-op; a crash mid-pass
  leaves the table in a readable state (current version intact, partial reap is fine, never a lineage hole
  below the retained window without the survivor).
- **The measurable bar.** A table with N versions per key compacts to ≤K retained versions per key with the
  highest-version read UNCHANGED (byte-identical) before and after, and the total row count strictly dropping.

Out: changing the append-only write pattern itself (correctness depends on it); the graph-consolidation
semantics (merge/supersede/prune of entities — that is the Dreaming loop, PRD-009/026); compacting
append-only EVENT tables that have no version concept (sessions/raw events — those are not version-bumped).

## Decisions

- **D-1 — Retention policy: keep-latest-N within a time window (configurable, conservative default).** Retain
  the highest version ALWAYS, plus the most-recent N prior versions, plus any version inside a retention time
  window (e.g. last 30 days), whichever is larger. Default conservative (e.g. N=5 + 30-day window) so routine
  compaction never reaps recently-auditable lineage. Below the window AND below N → eligible to reap.
- **D-2 — Compaction-as-dreaming-pass vs standalone maintenance job.** Lay out both: (a) a dreaming pass
  couples to PRD-026's runner and inherits the single-pending guard + queue, but only runs when dreaming is
  ENABLED (premium tier); (b) a standalone maintenance-loop job runs regardless of the premium switch and is
  the right home for a storage-hygiene chore that every install needs. DECISION: standalone maintenance job
  as the primary, exposed via a `honeycomb` maintenance verb; optionally ALSO triggerable as a step of a
  dreaming pass when 026 is enabled. This keeps storage-bounding from being gated behind premium dreaming.
- **D-3 — Reap order is delete-old-after-confirming-survivor (eventual-consistency-safe).** Resolve the
  highest version per key POLL-CONVERGENTLY (the `trigger.ts` `RESOLVE_POLLS` posture), confirm it is durably
  readable, THEN delete eligible lower versions. Never delete the only readable copy of current state, and
  never order deletes such that a concurrent reader's `ORDER BY version DESC LIMIT 1` could transiently return
  empty.
- **D-4 — Idempotent + crash-safe by construction.** Compaction computes the reap set from the CURRENT
  highest-version-and-retention view each run; a re-run on a compacted key finds nothing eligible (no-op). A
  crash mid-reap leaves a strictly smaller-but-correct table: the survivor set is always a SUPERSET of
  {highest version} ∪ {retained window} at every moment.
- **D-5 — Lineage/audit preservation.** Compaction reaps only versions OUTSIDE the retention window; the
  audit story is "recent lineage is fully retained, ancient superseded versions are reaped". A supersede
  chain's current + recent-N + windowed history survive. Reaping is logged (count reaped per table/key) so an
  operator can see what was collapsed. No source-backed current claim is ever reaped (it is the highest
  version).
- **D-6 — Scope: version-bumped tables only.** Compaction targets `appendVersionBumped` tables (skills,
  rules, claim history, `dreaming_state`-style counters). It does NOT touch `appendOnlyInsert` event tables
  (sessions/raw events) — those have no version-supersession concept and their retention is a separate concern.

## Acceptance criteria

- **AC-1 — Bounds row count, current read unchanged (the behavioral bar).** Gated live itest: seed a
  version-bumped table with N (e.g. 50) versions of one key. Run compaction. After it, read back
  poll-convergently and assert: rows for that key ≤ K (the retention bound), the highest-version read is
  BYTE-IDENTICAL to the pre-compaction read, and the total row count strictly dropped.
- **AC-2 — Retention window honored.** Versions inside the keep-latest-N AND inside the time window survive;
  only versions outside BOTH are reaped. Proven with a seeded mix of recent + old versions: the old-and-
  beyond-N are gone, the recent-or-windowed remain, the current is untouched.
- **AC-3 — Eventual-consistency safe (no stale-empty race).** During/after a compaction pass, a concurrent
  highest-version read for the key NEVER returns empty and NEVER returns a non-current version. Proven by
  interleaving a poll-convergent read against a live compaction on a throwaway namespaced table; the current
  state is always resolvable.
- **AC-4 — Idempotent.** Running compaction twice in a row on the same key reaps on the first pass and is a
  no-op on the second (zero rows deleted, current read still byte-identical). Asserted on the live itest.
- **AC-5 — Crash-safe.** A compaction interrupted mid-reap (simulated partial delete) leaves the highest
  version readable and the retained window intact; a subsequent re-run completes to the bound. No lineage
  hole that drops the survivor.
- **AC-6 — Lineage + safety + gates.** No source-backed current claim is reaped; reaped counts are logged per
  table/key; `npm run ci`, `build`, `audit:sql`, `audit:openclaw`, and the invariant test pass. The live
  itest is gated (creds-only, skipped in CI) and isolates to a throwaway, namespaced table it is free to DROP
  (the same isolation the live counter smoke uses), never a real `dreaming_state`/skills/rules table.

## Risks / Out of scope

- **Risk — racing a reader into stale-empty.** The core hazard. Mitigated by D-3 (confirm survivor durable
  before reaping; poll-convergent resolution) and proven by AC-3. See the project memory note on DeepLake
  eventual-consistency poll reads — a single immediate read after a delete is forbidden.
- **Risk — reaping auditable lineage too aggressively.** Mitigated by D-1's conservative keep-latest-N +
  time-window default; reaping is logged so an operator can widen the window if needed.
- **Risk — gating storage hygiene behind premium dreaming.** Mitigated by D-2: the primary path is a
  standalone maintenance job, not a dreaming-only pass.
- **Out of scope.** Changing the append-only write model (correctness depends on it). Graph consolidation
  semantics (PRD-009/026). Event-table (`appendOnlyInsert`) retention. A general TTL/GC for non-versioned
  tables.

## Dependencies

- **Storage write model** — `src/daemon/storage/writes.ts` (`appendVersionBumped` is what grows; this PRD
  reaps its history) and the guarded `sql.ts` helpers (every value/identifier through `sLiteral`/`sqlIdent`).
- **Poll-convergent reads** — the `trigger.ts` `RESOLVE_POLLS` posture is mandatory for resolving the
  highest version per key before reaping (D-3) and on every read-back assertion.
- **PRD-026 (Dreaming loop enablement)** — IF compaction is wired as a dreaming pass (D-2 option b), it rides
  PRD-026's enabled runner + single-pending guard + job queue. The standalone-maintenance primary path does
  NOT require 026, but the optional dreaming-pass coupling does — so this PRD likely follows 026.
- **PRD-009 (Dreaming Loop)** — the `compaction.ts` module + the maintenance-loop cadence this work extends.
- Throwaway-table isolation — the live itest reuses the namespaced-throwaway-table pattern the live counter
  smoke uses, so it never touches a real shared table.

## Reference

- The gap to fill: storage-level version-history reaping for `appendVersionBumped` tables; the dreaming
  `compaction.ts` (`src/daemon/runtime/dreaming/compaction.ts`) is graph-prompt assembly, NOT version reaping.
- Write model: `src/daemon/storage/writes.ts` (`appendVersionBumped`, `appendOnlyInsert`, the `val.*` /
  `sLiteral` / `sqlIdent` guards), `src/daemon/storage/sql.ts`.
- Poll-convergent read posture: `src/daemon/runtime/dreaming/trigger.ts` (`RESOLVE_POLLS`, `readState`).
- Related feature: `library/requirements/in-work/prd-009-dreaming-loop/` and PRD-026.
