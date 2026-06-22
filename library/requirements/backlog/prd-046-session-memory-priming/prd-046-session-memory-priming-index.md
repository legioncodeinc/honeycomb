# PRD-046 — Session Memory Priming (prime once, resolve on demand)

> Status: backlog · Owner: `/the-smoker` · Type: L (multi-feature)
> Goal: at the start of every coding session (Claude Code, Cursor to start), push the agent a tiny,
> recency-aware INDEX of Honeycomb's distilled memory (Tier-1 keys), and let the agent RESOLVE deeper
> (key → summary → raw) or MINE (semantic search) on demand — so a fresh session starts oriented
> instead of cold, without polluting the context window. The design is captured in the
> `library/knowledge/private/ai/` strategy docs; this PRD brings it to life.

## Why
A coding agent starts every session cold. Claude Code and Cursor each own their *in-session* working
memory, but nothing carries Honeycomb's cross-session, cross-repo memory into a fresh session unless we
deliberately deliver it. Two failure modes bracket the problem: too little (memory sits unused in Deep
Lake) and too much (force-feeding recall into every turn adds latency and buries the live task — the
"lost in the middle" problem). The resolution is a **push-the-index / pull-the-detail** split on a
**session cadence**: a small index pushed once at session start, and agent-driven resolve/search after.

This is buildable now because the substrate already exists:
- Three Deep Lake tables map onto the three zoom levels: `sessions` (raw turns, Tier 3), `memory`
  (per-session summaries, Tier 2), `memories` (durable distilled facts). Recall over them is hybrid
  lexical + `<#>` semantic, fused with RRF (measured recall@5 ≈ 0.72–0.78 live).
- **PRD-017 (wiki-summaries) is `Completed` and fully built** — the 017a per-session summary worker
  and the 017b `/MEMORY.md` synthesis are QA-passed (15/15 ACs). Its `/MEMORY.md` already links
  per-session summaries with short `description`s — strong prior art for the Tier-1 key index.
- The MCP pull tools (`hivemind_search` / `hivemind_read`) already exist, and Honeycomb already fires
  a **session-start step** today (skill `pull`/`auto-pull` propagation) — the exact hook shape a memory
  prime needs.

The one real blocker is small and known: **PRD-017's worker is not yet wired into the live daemon**
(deferred assembly — `runSummaryWorker` is invoked nowhere outside its module; `server.ts`/`assemble.ts`
mount no summary job), so Tier-2 summaries do not actually land on a live trigger yet. That wiring is
this PRD's first slice.

## What (scope)
Six slices, sequenced so the foundational wiring lands first and the agent-facing prime lands last:

| Sub-PRD | Wave | Deliverable |
|---|---|---|
| **046a** | W0 | **Wire + trigger the summary worker** in the daemon assembly (unblock Tier-2: summaries land live) |
| **046b** | W1 | **Tier-1 key index** — generate a ≤1-sentence keyworded key per summary/fact (reuse 017b `description`) |
| **046e** | W1 | **Resolve + mine tools** — `hivemind_read` zoom depth (key→summary→raw) + `hivemind_search` mining |
| **046c** | W1 | **Prime digest service** — recency-aware index (recent timestream + durable facts), scoped, token-bounded |
| **046d** | W2 | **SessionStart hooks** — Claude Code + Cursor inject the digest once per session |
| **046f** | W2 | **Prime eval** — measure that priming changes retrieval/behavior vs cold start (extend PRD-045f) |

GraphRAG (relational multi-hop) is explicitly a **separate, later PRD** — see Out of scope.

## Design alternatives + recommendation

### Push vs pull (the core mechanism)
- **(a) Per-turn auto-inject** ("always query Honeycomb"). Adds latency to every turn; crowds the
  window with memory the agent did not ask for.
- **(b) Push a small index once per session + pull on demand.** The agent skims a cheap table of
  contents and resolves/searches only what it wants.
**RECOMMENDED: (b).** Push the Tier-1 index at session start; everything else is agent-driven pull.
Nothing is auto-injected after the prime. This is the better of the two options the project owner
raised and the right shape for a tool-using coding agent.

### Where the Tier-1 keys come from
- **(a) Generate keys from scratch** with a new distillation pass over summaries/facts.
- **(b) Reuse PRD-017b synthesis output** — `/MEMORY.md` already links summaries with `description`s
  (≤280 chars), which is close to a Tier-1 key; derive/extend from there.
**RECOMMENDED: (b) first, (a) to sharpen.** Reuse the existing synthesis `description` as the seed key
and only add a dedicated key-distillation prompt where the description is too generic (the make-or-break
is key sharpness — see the distillation strategy doc). This avoids rebuilding what 017b already produces.

### Prime cadence
- **(a) Per turn.** Wasteful; see push/pull above.
- **(b) Per session.** A starting orientation; the agent pulls fresh within the session as needed; new
  distilled memory from this session enriches the *next* prime.
**RECOMMENDED: (b) per session,** with an optional mid-session re-prime after a harness auto-compaction
as a later optimization (not in scope here).

## Decisions
- **D-1 — Push the index, pull the detail.** Prime once per session with Tier-1 keys; the agent
  resolves/searches on demand. No per-turn auto-injection (046c/046d).
- **D-2 — Wire the existing 017 worker; do not rebuild summarization (046a).** PRD-017 is built; this
  PRD mounts + triggers it in the live daemon so Tier-2 summaries actually land. The summarization
  logic is reused as-is.
- **D-3 — Tier-1 keys reuse 017b synthesis where possible (046b).** Seed keys from the existing
  `description`; add a dedicated key-distillation prompt only to sharpen, with the two-step grounded
  discipline (structured extraction → narrative → key) to prevent hallucinated history.
- **D-4 — Resolve = SQL join; mine = RRF recall (046e).** Zoom (key→summary→raw) is a deterministic
  `hivemind_read` by id/path; mining is the existing hybrid recall via `hivemind_search`. The native
  `deeplake_hybrid_record` operator is NOT used (it returns degenerate zero scores — PRD-045a).
- **D-5 — The prime is recency-aware and deduped (046c).** Recent timestream keys are age-weighted
  (PRD-045d recency dampening); durable facts age slowly; the digest is deduped (PRD-045c) so no fact
  appears twice; the whole block is token-bounded (~300–800 tokens).
- **D-6 — Reuse the session-start hook pattern (046d).** The prime is delivered the same way skill
  propagation already is — a session-start hook calling the daemon — for Claude Code and Cursor first.
- **D-7 — Prove it or pull it (046f).** Priming must measurably change retrieval/behavior vs a cold
  start; a prime the agent ignores is worse than none. Extend the PRD-045f eval harness; the kill
  criterion is real.
- **D-8 — Do not own working memory.** The harness owns live in-session turns + compaction; Honeycomb
  owns the persistent tiers (Summary, Raw) and the index over them (Key). No Valkey-style tier here.

## Acceptance criteria
- **AC-1 — Summaries land live (046a).** With the daemon running, a finished/threshold-triggered
  session produces a `memory` summary row at `/summaries/<userName>/<sessionId>.md` via the mounted
  worker job — verified by a live read-back (poll-convergent). `runSummaryWorker` is invoked from the
  daemon assembly, not just defined.
- **AC-2 — Tier-1 keys exist (046b).** Every distilled summary/fact has a ≤1-sentence keyworded key
  (reused from 017b `description` or generated), keyword-forward and self-contained, carrying its
  id/path. Unit-tested for shape + groundedness (no fact absent from the source).
- **AC-3 — Resolve + mine work (046e).** `hivemind_read` zooms a key → its `memory.summary` → the
  `sessions` rows for that session (a SQL lookup by id/path); `hivemind_search` returns hybrid RRF
  recall. Unit-tested; the resolve chain is exact (no search at resolve time).
- **AC-4 — The prime is assembled correctly (046c).** A session-start prime request returns a
  token-bounded digest of recent-timestream + durable Tier-1 keys, scoped to the repo/agent,
  recency-weighted and deduped. Unit-tested for bound, scope, ordering, dedup.
- **AC-5 — The hooks inject it (046d).** Claude Code and Cursor each fire a SessionStart hook that
  fetches the digest and injects it as session context, once per session, gracefully degrading to
  "nothing yet" on a cold repo (never an error). Verified per harness.
- **AC-6 — Priming is proven (046f).** An eval shows the primed agent changes retrieval/behavior vs a
  cold start (e.g. fewer redundant searches, faster convergence, references a primed key) on a
  committed scenario set; a regression below the bar fails. Built on the PRD-045f harness.
- **AC-7 — Gates green + boundaries held.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw`
  stay green; the silent lexical fallback + per-arm fail-soft of recall are preserved; no working-memory
  tier is added; no secret/PII in any digest, key, or fixture (grep-proven).

## Risks / Out of scope
- **Risk — distillation quality is the make-or-break.** A bland key is ignored, wasting the prime.
  Mitigated by reusing/sharpening 017b `description`s, the two-step grounded discipline, and AC-6's
  pull-through measurement. (See `distillation-and-tier1-keys.md`.)
- **Risk — `/MEMORY.md` write-once.** 017b's index does not auto-refresh after new summaries (no
  version-bump). 046a/046b must add a refresh (version-bumped write) or the prime goes stale. Tracked
  as the first follow-up inside 046b.
- **Risk — priming staleness within a long session.** Mitigated by the pull path (agent searches fresh
  any turn); a mid-session re-prime is a later optimization, out of scope.
- **Out of scope — GraphRAG (relational multi-hop).** Approved as a SEPARATE later PRD once the prime
  is shipped and measured against a demonstrated relational gap. Design brief:
  [`graphrag-followon.md`](../../../knowledge/private/ai/graphrag-followon.md).
- **Out of scope — the harness's working memory.** CC/Cursor own live turns + compaction; not rebuilt.
- **Out of scope — turning embeddings on / the embed runtime (PRD-025) and the recall ranking internals
  (PRD-045).** This PRD consumes them; it does not re-derive them. The native hybrid operator is dead
  (PRD-045a) and not used.

## Dependencies
- **PRD-017 (wiki-summaries, `Completed`) — the Tier-2 substrate.** 046a mounts its already-built
  worker; 046b reuses its `/MEMORY.md` + `description`. Verified built-but-not-wired this cycle.
- **PRD-045 (retrieval quality upgrades).** The prime composes with 045c (dedup), 045d (recency
  dampening), 045f (eval harness); the mining path rides 045's RRF recall (045a closed: keep RRF).
- **PRD-025 (the semantic arm)** for the `<#>` recall the mining path uses.
- **The MCP server + harness installers** — `hivemind_search`/`hivemind_read`/`hivemind_index`, the
  Claude Code SessionStart hook, `src/cli/install-cursor.ts` (Cursor 1.7 hooks), and the skill
  `pull`/`auto-pull` session-start precedent.
- **The strategy docs** — `library/knowledge/private/ai/` `three-tier-memory-strategy.md`,
  `session-priming-architecture.md`, `hybrid-sql-vector-rationale.md`, `distillation-and-tier1-keys.md`.
- **DeepLake eventual consistency** — every live read-back polls to convergence, never a single read.

## Sub-PRD index
- [046a — Wire + trigger the summary worker](prd-046a-session-memory-priming-summary-worker-wiring.md) (W0)
- [046b — Tier-1 key index](prd-046b-session-memory-priming-tier1-keys.md) (W1)
- [046e — Resolve + mine tools](prd-046e-session-memory-priming-resolve-and-mine.md) (W1)
- [046c — Prime digest service](prd-046c-session-memory-priming-prime-digest.md) (W1)
- [046d — Claude Code + Cursor SessionStart hooks](prd-046d-session-memory-priming-harness-hooks.md) (W2)
- [046f — Prime eval](prd-046f-session-memory-priming-eval.md) (W2)
