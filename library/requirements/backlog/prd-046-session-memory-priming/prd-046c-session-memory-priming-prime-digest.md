# PRD-046c — Prime digest service

> Status: backlog · Parent: PRD-046 · Wave: W1 · Type: M
> Goal: assemble the session-start prime — a compact, token-bounded, recency-aware index of Tier-1
> keys (recent timestream + durable facts), scoped to the repo/agent — that the SessionStart hooks
> (046d) inject. This is the "push the index" half of the design.

## Why
The prime is what carries Honeycomb's long-term memory into a fresh session, cheaply. It must be small
(it is pushed unconditionally), oriented (recent + durable), and clean (deduped, scoped, no secrets).
Assembling it is a cheap SQL skim over the Tier-1 keys (046b) — no vector cost, no generation at read
time — which is the efficiency argument for doing it every session. See
`session-priming-architecture.md` §4.

## What (scope)
- **A daemon endpoint/service** (e.g. `GET /api/memories/prime`, or an MCP/daemon call the hook uses)
  that returns the assembled digest for a given scope (org/workspace/agent + repo/project).
- **Two key lists:**
  - **Recent timestream** — the last N distilled sessions, newest first ("what were we just doing"),
    **age-weighted via PRD-045d recency dampening**.
  - **Durable facts** — the top M long-lived facts for this project ("what is always true here"), which
    age slowly (durable tier).
- **Token budget.** The whole block is bounded (~300–800 tokens target); N/M are tuned to the budget,
  not fixed counts, so the prime never blows the window.
- **Dedup.** No fact appears twice across the two lists or as near-duplicates (reuse PRD-045c semantic
  dedup) — the index is distinct entries only.
- **Each line is a key + opaque id** the resolve tool (046e) consumes, plus a one-line footer telling
  the agent how to expand (`hivemind_read`) or mine (`hivemind_search`).
- **Cold-repo degradation.** A repo/agent with no memory yet returns an honest "nothing yet" digest,
  never an error or a fabricated entry.

## Acceptance criteria
- **c-AC-1 — Assembled correctly.** A prime request returns recent-timestream + durable Tier-1 keys for
  the scope, each with its id. Unit-tested against fake storage for content + structure.
- **c-AC-2 — Token-bounded.** The digest respects the token budget; an over-long candidate set is
  trimmed (newest/most-durable kept), never truncated mid-key. Unit-tested at the budget boundary.
- **c-AC-3 — Recency-weighted + durable-preserving.** Recent keys are ordered newest-first under the
  PRD-045d dampener; durable facts are present regardless of age. Unit-tested with controlled timestamps.
- **c-AC-4 — Deduped + scoped.** No duplicate/near-duplicate keys; every key is within the requested
  org/workspace/agent scope. Unit-tested.
- **c-AC-5 — Cheap + cold-safe.** Assembling the prime issues only SQL skims (no LLM/gate/vector call
  at read time); a cold repo returns an honest empty digest, never an error. Unit-tested; `audit:sql`
  clean.

## Risks / Out of scope
- **Risk — the prime is noise.** If keys are generic (046b) the prime is ignored. The kill criterion is
  046f's pull-through measurement.
- **Risk — wrong scope granularity.** Repo-level vs workspace-level scoping affects relevance. Make the
  scope explicit in the request; default to the current repo/agent.
- **Out of scope — the hook that injects it** (→ 046d), **key generation** (→ 046b), **proving it helps**
  (→ 046f).

## Dependencies
- **046b** (the Tier-1 keys this skims), **PRD-045d** (recency dampening), **PRD-045c** (dedup).
- The recall/scope plumbing in `src/daemon/runtime/memories/` for the scoped SQL skim.
- `session-priming-architecture.md` for the digest shape + token target.
