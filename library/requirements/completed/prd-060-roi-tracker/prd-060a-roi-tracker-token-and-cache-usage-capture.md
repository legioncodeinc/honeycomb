# PRD-060a: Token and Cache Usage Capture (Foundational, Claude Code First)

> **Parent:** [PRD-060](./prd-060-roi-tracker-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P1 (foundational, gates the entire measured-savings half of the ledger; nothing in 060b's measured path can be true until this lands)
> **Schema changes:** Additive token/cache columns on the `sessions` catalog group via additive schema healing. No destructive migration.

---

## Overview

This is the build that turns "measured cache savings" from an aspiration into arithmetic. Today the per-turn `usage` data Honeycomb needs **exists at the source but is thrown away in transit**:

- The capture contract ([`event-contract.ts`](../../../../src/daemon/runtime/capture/event-contract.ts)) normalizes an assistant turn down to `{ kind: "assistant_message", text }` and **discards the API `usage` object**, so the cache-read counts never reach the daemon.
- No catalog table has token/cost columns, the `sessions` group ([`sessions-summaries.ts`](../../../../src/daemon/storage/catalog/sessions-summaries.ts)) stores the raw turn JSONB but no `cache_read_input_tokens` field, so even if the contract carried it, there is nowhere to persist it.

The good news, and the reason this is scoped as a build rather than a research spike: **Claude Code already writes per-message `usage` to its transcript JSONL**, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. The data is sitting on disk; this sub-PRD is the pipe that carries it from the transcript through the capture contract into additive `sessions` columns.

Scope is **Claude Code first** (locked by the operator, it has the richest cache data). Codex and Cursor are explicit follow-ups; their transcripts expose token data differently (Cursor in particular may not surface cache-read counts at all), so a `source_tool` discriminant column is added now so the later harnesses slot in without a re-migration, and so 060b/060e can render a "Claude Code only" partial state honestly.

The whole capture path must stay **fail-soft and additive**: a transcript without `usage`, a legacy dataset missing the new columns, or a malformed count must degrade the row to "token data absent", never throw, never block capture, never wedge the daemon boot. This mirrors the additive-heal posture the catalog already uses.

## Goals

- **Carry the `usage` object through the capture contract**, extend [`event-contract.ts`](../../../../src/daemon/runtime/capture/event-contract.ts) so an assistant turn optionally carries a normalized `usage: { input, output, cacheRead, cacheCreation }` alongside its `text`, instead of discarding it. The field is optional: a turn with no usage data is a valid, un-throwing turn.
- **Extract `usage` from the Claude Code transcript**, the Claude Code capture shim reads the per-message `usage` block from the transcript JSONL and populates the contract field. Absent/partial usage → the field is omitted, not zero-filled (zero is a real, distinct value).
- **Additive token/cache columns on the `sessions` group**, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `source_tool`, added through the additive schema-heal path in [`src/daemon/storage/catalog/`](../../../../src/daemon/storage/catalog/index.ts), never a hand-written destructive migration.
- **Persist on the existing append-only write**, token counts ride the same INSERT that writes the turn; no second write path, no mutation of an existing row.
- **Degrade, never throw**, a missing column on a legacy dataset, a transcript without `usage`, or a malformed count yields a row whose token fields are null/absent and a downstream "token data absent" signal, with the daemon and capture unaffected.
- **Tag the source tool** so Claude-Code rows are distinguishable from future Codex/Cursor rows, enabling the "Claude Code only" partial state in 060b/060e.

## Non-Goals

- **Codex / Cursor capture.** Named as follow-ups; the `source_tool` column and the optional contract field make them additive, but their extraction is not in this sub-PRD.
- **Any cost computation.** This sub-PRD captures and persists *token counts*. Turning counts into cents is 060b; this module ships raw integers only.
- **Metering Honeycomb's own inference.** That is 060d (the skillify Haiku transport). This module is about the *user's* assistant turns captured from the transcript.
- **A new intake/capture harness.** We extend the existing contract and the existing Claude Code shim; we do not add a new capture path.
- **Backfilling historical sessions.** Token columns populate going forward from the moment the heal runs; retroactive backfill of pre-capture transcripts is out of scope (and feeds the "trend backfill" open question in the index).

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | The capture contract carries an **optional** normalized `usage` ({ input, output, cacheRead, cacheCreation }) on an assistant turn; a turn with no usage data validates and round-trips with the field **absent** (not zero-filled). |
| a-AC-2 | The Claude Code shim extracts `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` from the transcript JSONL and populates the contract field; a fixture-driven test asserts the four counts land from a real-shaped transcript message. |
| a-AC-3 | The `sessions` group gains `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `source_tool` via the **additive schema-heal** path, a test asserts the heal is additive (no drop/rewrite) and idempotent. |
| a-AC-4 | A dataset **missing** the new columns reads back as "token data absent" and the daemon boots + capture proceeds **without throwing**, the heal adds the columns, and reads before the heal degrade gracefully. |
| a-AC-5 | Token counts persist on the **same append-only INSERT** as the turn (no second write, no row mutation); a test asserts the count is queryable on the written row. |
| a-AC-6 | A transcript message **without** `usage`, or with a malformed/partial count, produces a row with **null** token fields and a "token data absent" downstream signal, never a throw, never a silent `0`. |
| a-AC-7 | Every Claude-Code-captured row carries `source_tool = "claude-code"`, so 060b/060e can render the **"Claude Code only"** partial state; a test asserts the discriminant is set. |

## Files touched

- [`src/daemon/runtime/capture/event-contract.ts`](../../../../src/daemon/runtime/capture/event-contract.ts), add the optional normalized `usage` field to the assistant-turn contract (the field currently discarded).
- Claude Code capture shim (the harness intake that produces the normalized turn from the transcript), extract `usage` from the per-message JSONL and populate the contract field.
- [`src/daemon/storage/catalog/sessions-summaries.ts`](../../../../src/daemon/storage/catalog/sessions-summaries.ts), add the five additive columns to the `sessions` group's `ColumnDef` list.
- [`src/daemon/storage/catalog/index.ts`](../../../../src/daemon/storage/catalog/index.ts), wire the additive columns through the schema-heal path.
- The session write path that issues the append-only INSERT for a captured turn, carry the token counts onto the persisted row.
- Tests under the capture + catalog test trees (fixture-driven extraction, additive-heal idempotence, missing-column degrade, source-tool discriminant).

## Open questions

- [ ] **Transcript discovery + freshness.** Where exactly does the shim read the Claude Code transcript JSONL from, and does it read it streaming-as-captured or reconcile after the turn? Confirm the `usage` block is present at the point of capture (Claude Code writes it per assistant message, verify timing vs the hook lifecycle).
- [ ] **Column placement: per-turn vs rolled-up.** Token counts are per assistant message; the `sessions` table is one row per turn, so per-turn columns are the natural fit, confirm 060b's measured-savings query sums cleanly over these per-turn rows rather than needing a session-level rollup column too.
- [ ] **Zero vs null discipline.** A genuine `cache_read_input_tokens = 0` (no cache hit) is a real measurement and distinct from "no usage data". Confirm the column nullability and the contract encoding keep those two apart end to end (feeds a-AC-1/a-AC-6).
- [ ] **Cursor cache reality.** Before committing Cursor as a follow-up, confirm its transcript even exposes cache-read counts, if not, measured savings is structurally Claude-Code-capped and the "Claude Code only" partial may be near-permanent for Cursor users.

## Related

- [PRD-060b](./prd-060b-roi-tracker-cost-and-savings-engine.md), consumes the persisted token counts to compute measured cache savings; this sub-PRD is its hard upstream dependency.
- [PRD-060e](./prd-060e-roi-tracker-roi-tracker-dashboard-page.md), renders the "Claude Code only" partial state keyed off the `source_tool` discriminant and the token-data-absent signal.
- [PRD-005: Capture Intake](../../completed/prd-005-capture-intake/prd-005-capture-intake-index.md) · [Session Capture](../../../knowledge/private/ai/session-capture.md), the capture contract + intake path this extends.
- [`src/daemon/storage/catalog/CONVENTIONS.md`](../../../../src/daemon/storage/catalog/CONVENTIONS.md), the additive-heal + ColumnDef conventions the new columns follow.
- **Security/quality handoff:** captured token data widens the captured-trace surface; `security-worker-bee` (penultimate) reviews the new columns + extraction for PII/leak before `quality-worker-bee` (last) verifies the build. This sub-PRD surfaces the handoff; it does not author the audit.
</content>
