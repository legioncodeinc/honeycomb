# PRD-046b — Tier-1 key index

> Status: completed (merged #77, 2026-06-22) · Parent: PRD-046 · Wave: W1 · Type: M
> Goal: produce the new artifact the prime needs — a ≤1-sentence, keyword-dense KEY per distilled
> summary/fact, plus a refreshable index of those keys — reusing PRD-017b synthesis output where
> possible so we sharpen rather than rebuild.

## Why
The 3-tier zoom memory's Tier 1 is an *index entry*: a one-line keyworded headline the agent skims to
decide whether to zoom in. It does not exist yet (Tiers 2 and 3 are the `memory` / `sessions` tables).
Crucially, PRD-017b synthesis already produces most of it: `/MEMORY.md` links per-session summaries
with a short `description` (≤280 chars, `SYNTHESIS_DESCRIPTION_CHARS`). That `description` is close to a
Tier-1 key. So this slice seeds keys from synthesis and adds a dedicated key-distillation only where the
description is too generic — because **key sharpness is the make-or-break for the whole strategy** (a
bland key is ignored, wasting the prime). See `distillation-and-tier1-keys.md`.

## What (scope)
- **Mount synthesis + fix `/MEMORY.md` refresh.** Wire 017b's `synthesizeMemoryIndex` /
  `synthesizeThreadHeads` into the assembly (the deferred-assembly companion to 046a) AND add the
  documented refresh follow-up: a **version-bumped** `/MEMORY.md` write (the same pattern as
  `ontology/supersede.ts` / `graph-persist.ts`) so the index refreshes as new summaries land, instead
  of the current write-once-per-scope no-op.
- **Define the Tier-1 key.** A ≤1-sentence, keyword-forward, self-contained headline carrying its
  source id/path. Seed it from the synthesis `description`; where the description is generic, generate a
  sharper key with a dedicated prompt.
- **Apply the two-step grounded discipline** (port from the prior art): structured extraction (facts
  only) → grounded narrative → derive the key from the grounded summary, never from raw turns directly,
  so a key can never invent history.
- **Store keys cheaply.** As a column on `memory`/`memories` (heal-compatible, additive) or as the
  refreshable `/MEMORY.md` index, so the prime (046c) is a pure SQL skim with no generation at read time.
- **Cover both sources:** episodic keys (from `memory` summaries) and durable keys (from `memories`
  facts).

## Acceptance criteria
- **b-AC-1 — Synthesis runs live + refreshes.** The mounted synthesis writes `/MEMORY.md`, and a
  re-synthesis after new summaries land **updates** it (version-bumped), not a no-op. Verified live
  (poll-convergent); unit-tested for the version-bump write (no in-place UPDATE).
- **b-AC-2 — Keys exist + are sharp.** Every distilled summary/fact has a ≤1-sentence keyworded key,
  keyword-forward and self-contained, carrying its id/path. Unit-tested for shape; a quality check (or
  golden sample) asserts keys carry subsystem + outcome, not just a topic.
- **b-AC-3 — Keys are grounded.** A key (and its Tier-2 summary) contains no fact absent from the
  structured extraction step. Unit-tested with a fixture where the raw turns tempt a confabulation.
- **b-AC-4 — Cheap to read.** Keys are stored (column or index) so assembling a prime is a SQL skim;
  no LLM/gate call at prime-read time. Verified by the prime path (046c) issuing no generation call.
- **b-AC-5 — Scoped + no secrets.** Keys carry org/workspace/agent scope; no secret/PII leaks into a
  key (redaction reuses the worker's existing scrub). Grep-proven; gates green.

## Risks / Out of scope
- **Risk — generic keys.** The single biggest risk in PRD-046. Mitigated by sharpening prompts, the
  good-vs-bad-key bar in the strategy doc, and the 046f pull-through measurement (a key nobody expands
  is a bad key).
- **Risk — over-generating.** Don't run a heavy distillation per read; keys are generated at
  summarize/synthesize time and stored. Read-time is pure SQL.
- **Out of scope — the prime assembly + token budget** (→ 046c), **the resolve tool** (→ 046e).

## Dependencies
- **046a** (summaries must land live before there is anything to key).
- PRD-017b synthesis (`synthesizeMemoryIndex`, `renderMemoryIndex`, `description`,
  `SYNTHESIS_DESCRIPTION_CHARS`) — reused + refreshed.
- The schema-heal path (`healMissingColumns`) for an additive key column; the version-bump write
  pattern (`ontology/supersede.ts` / `graph-persist.ts`).
- `distillation-and-tier1-keys.md` — the key definition + grounded discipline + good/bad examples.
