# PRD-026 — Dreaming loop enablement + live validation (turn it ON, prove it consolidates)

> Status: backlog · Owner: `/the-smoker` · Type: M (feature)
> Goal: turn the PRD-009 Dreaming consolidation loop ON (trivially enableable, with run-away guards) and
> PROVE end-to-end, against live DeepLake, that a real pass actually consolidates — duplicates merged, stale
> claims superseded, junk pruned — WITHOUT losing source-backed memory. Enablement + safety + measurement,
> not a re-architecture.

## Why

`POST /api/diagnostics/dream` today returns `{triggered:false, status:"skipped", reason:"disabled"}`
(`src/daemon/runtime/dreaming/api.ts`). The whole consolidation loop is BUILT — the token-budget trigger
(`trigger.ts`), the runner harness + 008c risk-routed apply (`runner.ts`), the incremental + compaction
payload strategies (`incremental.ts`, `compaction.ts`), the job/mutation/budget contracts (`contracts.ts`)
— but `resolveDreamingConfig` (`config.ts`) defaults `memory.dreaming.enabled` to **false** (a premium tier,
false-safe). So it is OFF by default and UNPROVEN end-to-end live: no test seeds a known-messy workspace,
runs a real pass against live DeepLake, and asserts the graph got *sharper*. The product promise — "memory
gets sharper, not noisier: merges dups, prunes junk, supersedes stale" — rests entirely on a loop that has
never been observed doing it on real data. This PRD flips the switch (safely) and supplies the missing proof.

## Scope / What

PRD-009 built the loop; this PRD makes it RUN and MEASURES it. In scope:

- **Enablement.** Make `memory.dreaming.enabled` trivially turn-on-able — flip the default (D-1) and/or a
  first-class enable path — without touching the trigger/runner internals. Re-resolve config so the live
  `/api/diagnostics/dream` stops returning `reason:"disabled"` once enabled.
- **Run-away safety.** Confirm the existing guards actually bound a live loop: the `tokenThreshold` cadence
  (a pass fires only after ~100k tokens of summary writes, `config.ts`), the single-pending guard
  (`trigger.ts` enqueues NOTHING while `pending_job_id` is non-empty), and the per-pass input ceiling
  (`maxInputTokens`, sampled by `compaction.ts`). Add a per-pass cost ceiling decision (D-4).
- **What a pass may mutate.** Keep every mutation on the 008c risk-routed apply path (`runner.ts` →
  `submitProposal`): the seven-op vocabulary (`contracts.ts` `DREAMING_MUTATION_KINDS`) where destructive
  ops (`merge_entities`, `delete_entity`, `delete_attribute`, `supersede_attribute`) ALWAYS land in pending
  review, additive ops can direct-apply. Lineage is preserved (supersede appends, never destroys).
- **The behavioral proof.** A gated live itest that seeds a workspace with KNOWN duplicates + stale claims +
  junk, runs a real Dreaming pass against live DeepLake (real `dreaming` ModelClient call), and asserts the
  duplicates merged, the stale superseded, the junk pruned, and NOTHING source-backed was lost — read back
  POLL-CONVERGENTLY (DeepLake flaps stale segments; never a single immediate read).

Out: re-architecting the trigger/runner/strategies (PRD-009 owns them); the ontology control plane and its
pending-review queue (PRD-008, consumed here); the embedding/recall path; compaction of append-only version
growth (that is **PRD-030**, which rides this runner).

## Decisions

- **D-1 — Enablement posture: trivially-enableable, default stays conservative until proven.** Keep
  `memory.dreaming.enabled` false-safe in `config.ts` as the SHIP default (a missing flag is OFF — premium
  tier, no surprise model spend), but make ON a one-knob flip: `HONEYCOMB_DREAMING_ENABLED=true` (already the
  env seam) plus a documented "default-on after live validation passes" follow. The live-proof itest (AC-5)
  is the gate that licenses flipping the *shipped* default in a later change. Rationale: enabling a model-
  calling loop by default before it is proven on real data is the exact run-away risk the guards exist for.
- **D-2 — Cadence is the existing token-budget trigger, unchanged.** A pass fires when
  `dreaming_state.tokens_since_last_pass` crosses `tokenThreshold` (default 100k) on a maintenance tick, OR
  on the explicit `/api/diagnostics/dream` / `honeycomb dream trigger` path. No clock-based cadence is added;
  enablement does not change WHEN a pass fires, only WHETHER an enqueue happens at the threshold.
- **D-3 — Mutations stay on the 008c risk-routed apply path with lineage.** A pass mutates ONLY through
  `submitProposal`: destructive ops route to pending review, additive ops can direct-apply under the 008c
  confidence floor, and supersede APPENDS a new version (append-only, never destroys lineage). Enablement
  grants the loop no new write authority — it reuses exactly the control-plane surface PRD-009b wired.
- **D-4 — Per-pass cost ceiling.** Bound a single pass's model spend by (a) the input ceiling already
  enforced (`maxInputTokens`, sampled), and (b) a single-pass posture: the single-pending guard means at most
  ONE pass is ever in flight per scope, so cost can't fan out. Decision: no new budget primitive in this PRD;
  the ceiling is `maxInputTokens` × one-pass-at-a-time. A hard per-pass token/cost cap beyond `maxInputTokens`
  is deferred (open question on PRD-009).
- **D-5 — The model workload is the `dreaming` ModelClient seam, resolved by the router.** A live pass calls
  the real model through the PRD-010 `dreaming` workload (the seam PRD-009b wired); this PRD does not select
  or hard-code a model. The live itest exercises the REAL seam (not a fake) so the proof covers the actual
  model round-trip.
- **D-6 — Consolidation outcomes are auditable via lineage.** Every applied mutation carries provenance
  through the 008c proposal row; supersession leaves the prior version readable. The proof asserts on this
  lineage (a stale claim becomes `superseded`, its replacement `active`) rather than on opaque row deletion.

## Acceptance criteria

- **AC-1 — Enable flips the live trigger.** With `memory.dreaming.enabled` true,
  `POST /api/diagnostics/dream` no longer returns `reason:"disabled"`: it returns `{triggered:true,
  status:"enqueued"}` when at/over threshold (or `status:"running"` when a pass is already pending /
  below threshold). With it false it still returns the `skipped`/`disabled` ack. Unit-tested against the
  `api.ts` handler with a real (config-driven) trigger seam.
- **AC-2 — Cadence + single-pending guard hold live.** Summary-write increments accumulate
  `tokens_since_last_pass`; crossing `tokenThreshold` enqueues exactly ONE `dreaming` job and resets by
  SUBTRACT; a second tick while `pending_job_id` is set enqueues NOTHING. Proven by a gated live counter
  exercise that drives the threshold and asserts a single enqueue, read back poll-convergently.
- **AC-3 — A real pass consolidates a seeded set (the behavioral bar).** Gated live itest: seed a workspace
  with (a) two duplicate entities, (b) a stale attribute plus its newer contradicting claim, (c) a junk
  entity. Run ONE real Dreaming pass against live DeepLake (real `dreaming` model call). After the pass,
  read back poll-convergently and assert: the duplicates are merged to one entity (or a `merge_entities`
  proposal is pending review), the stale attribute is `superseded` with the newer claim `active`, and the
  junk entity is archived/pending-archive — i.e. the graph is measurably *smaller and sharper*.
- **AC-4 — Nothing source-backed is lost.** In the same live pass, a source-backed memory/claim present
  before the pass is STILL resolvable after it (active, with its provenance intact). Asserted explicitly:
  consolidation may supersede/merge but MUST NOT drop a source-backed claim. Before/after counts of
  source-backed claims are non-decreasing for the survivors.
- **AC-5 — Before/after measurement is recorded.** The live itest captures a before/after snapshot
  (duplicate-entity count, active-vs-superseded claim counts, junk-entity count) and asserts the delta in the
  consolidating direction. This recorded delta is the artifact that licenses a later change to flip the
  SHIPPED default (D-1).
- **AC-6 — Safety + gates green.** Destructive mutations land in pending review (never blind-applied); the
  dream-trigger ack carries no token/secret (D-4 of PRD-024 unchanged); `npm run ci`, `build`, `audit:sql`,
  `audit:openclaw`, and the invariant test all pass. The live itest is gated (creds-only, skipped in CI).

## Risks / Out of scope

- **Risk — model cost on a large real graph.** Mitigated by `maxInputTokens` sampling (compaction) + the
  single-pending guard (one pass at a time). A hard per-pass cost cap is an open question (PRD-009), not
  resolved here.
- **Risk — DeepLake segment flap on read-back.** Every post-pass assertion reads POLL-CONVERGENTLY (highest
  version per id across a bounded poll), never a single immediate read — the same posture `trigger.ts`
  already uses (`RESOLVE_POLLS`). See the project memory note on eventual-consistency poll reads.
- **Risk — enabling by default surprises a free-tier user with spend.** Mitigated by D-1: the SHIPPED default
  stays OFF until AC-5's measured proof exists; ON is one documented knob.
- **Out of scope.** Re-architecting the loop (PRD-009). Bounding append-only version-bump growth (**PRD-030**).
  The ontology control plane / pending-review queue (PRD-008). Recall/embedding changes.

## Dependencies

- **PRD-009 (Dreaming Loop)** — the trigger, runner, strategies, contracts, and config this PRD enables. This
  PRD adds NO new loop logic; it flips enablement and supplies the live proof.
- **PRD-008 (Knowledge Graph Ontology / control plane)** — the 008c `submitProposal` risk router + pending
  review the mutations apply through (D-3).
- **PRD-010 (Model & Provider Router)** — the `dreaming` workload seam the live pass calls (D-5).
- **Storage write model** — `appendVersionBumped` (claim history, append-only) + the `dreaming_state` counter
  in `src/daemon/storage/`; poll-convergent reads are mandatory on every live read-back.
- **PRD-030 (Memory compaction)** likely RIDES this PRD's enabled runner (compaction-as-dreaming-pass option),
  so 030 depends on 026.

## Reference

- Loop to enable: `src/daemon/runtime/dreaming/{trigger.ts,runner.ts,config.ts,contracts.ts,incremental.ts,compaction.ts}`.
- Live trigger endpoint: `src/daemon/runtime/dreaming/api.ts` (`POST /api/diagnostics/dream`).
- Apply path: the PRD-008 ontology control plane (`submitProposal`, risk router, pending review).
- Storage write model: `src/daemon/storage/writes.ts` (`appendVersionBumped`), the `dreaming_state` catalog table.
- Parent feature: `library/requirements/in-work/prd-009-dreaming-loop/`.
