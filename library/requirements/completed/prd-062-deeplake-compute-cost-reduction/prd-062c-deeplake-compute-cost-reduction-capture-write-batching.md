# PRD-062c: Capture Write Batching & Envelope Trimming

> **Parent:** [PRD-062: DeepLake Compute Cost Reduction](./prd-062-deeplake-compute-cost-reduction-index.md)
> **Status:** Backlog, draft (2026-06-26). The metadata-bloat fix (Driver 2).
> **Priority:** P1
> **Effort:** M
> **Schema changes:** None to the column set. Changes the *content* written into the existing `sessions.message` column; optional additive truncation/marker field via schema healing.

---

## Goals

Cut the per-event write cost and the "insane amount of extra JSON metadata" the operator flagged. Today every captured hook event does **one append-only INSERT** to `sessions` ([`capture-handler.ts:218`](../../../../src/daemon/runtime/capture/capture-handler.ts)), and the `message` column holds the **full normalized envelope** `JSON.stringify({ event, metadata })` ([`capture-handler.ts:285`](../../../../src/daemon/runtime/capture/capture-handler.ts)), which for a tool call includes the **entire serialized tool input and response**. Two fixes:

1. **Batch the writes.** Buffer captured events over a short, bounded flush window (by size or time) and write them as a **single multi-row append** instead of one INSERT per event. A burst of turns becomes one write, not N.
2. **Trim the envelope.** Cap oversized tool input/response payloads to a documented byte budget with an explicit truncation marker, and stop repeating per-row metadata that is invariant across a session. Persist **only what the extractor and recall actually consume**.

Both are forward-only and behind flags. Driver 2 scales with activity, so this is the win that keeps cost flat as *usage* (not just installs) grows.

## Non-Goals

- **No retro-compaction.** Existing oversized rows are left as-is; shrinking the historical table is PRD-030 territory and a parent non-goal.
- **No capability cut.** Every field a downstream consumer reads stays. Trimming targets bytes no one reads (megabyte tool blobs, repeated invariant metadata), not signal.
- **No change to the harness capture contract.** The event shape harnesses send is unchanged; trimming happens daemon-side at persist time.

---

## User Stories

### US-62c.1 — Batched capture writes

**As a** user in an active session, **I want** my captured turns written to DeepLake in batches, **so that** a busy session is a few writes, not hundreds.

**Acceptance criteria:**
- AC-62c.1.1 N captured events within the flush window produce **one** multi-row append; a test asserts the write count drops from N to 1 for a within-window burst.
- AC-62c.1.2 A flush is forced on window close, on shutdown, and on a size cap, so no buffered event is lost on a clean stop; a test asserts the buffer is drained on shutdown.
- AC-62c.1.3 The 062a meter shows `capture-write` query count per session dropping in proportion to the batch factor.

### US-62c.2 — Trimmed envelope

**As an** operator, **I want** oversized tool I/O and repeated metadata kept out of the persisted envelope, **so that** we stop shipping megabytes of redundant JSON to DeepLake.

**Acceptance criteria:**
- AC-62c.2.1 A tool input/response exceeding the documented byte budget is stored truncated with an explicit marker (e.g. a `…[truncated N bytes]` sentinel or a length field); a test asserts a pathological multi-MB response is persisted within budget.
- AC-62c.2.2 Session-invariant metadata is not repeated on every row; a test asserts the per-event payload no longer carries the invariant fields, and that they remain recoverable for the session.
- AC-62c.2.3 A parity check asserts every field the extractor and recall read is still present after trimming (no silent capability cut), and the recall-quality eval (PRD-027) shows no regression attributable to trimming.

---

## Technical Considerations

- **Buffer placement.** A flush-buffer sits in front of the existing `appendOnlyInsert` call ([`capture-handler.ts:218`](../../../../src/daemon/runtime/capture/capture-handler.ts)). It accumulates `RowValues` and flushes on `max(size, time)`; the multi-row append uses the existing append path's batch form (or a small extension of it).
- **Crash-safety contract (open question).** An in-memory buffer loses un-flushed events if the daemon is killed. Keep the window short (1–2s) so worst-case loss is tiny, or add a durable spill if even that is unacceptable. Decide explicitly; document the loss window.
- **Envelope budget.** A `budgetedStringify` wraps the `JSON.stringify({ event, metadata })` at [`capture-handler.ts:285`](../../../../src/daemon/runtime/capture/capture-handler.ts): walk known large fields (tool input/response), cap each to the budget, stamp a marker. The budget is an env knob.
- **Consumer audit (gating).** Before lifting any metadata field out of the per-row envelope, audit who reads it: the extractor ([`pipeline`](../../../../src/daemon/runtime/pipeline/)), recall ([`memories/recall.ts`](../../../../src/daemon/runtime/memories/recall.ts)), and any replay/skillify path. Trimming a read field is a silent regression; this audit is a prerequisite, not a nicety.
- **PII note.** The persisted envelope is captured tool I/O, a known PII surface. Trimming reduces, but does not eliminate, that surface; the change touches captured-trace data and carries security weight (handoff in the parent index).
- **Flags.** `HONEYCOMB_CAPTURE_BATCH` (+ window/size knobs), `HONEYCOMB_CAPTURE_ENVELOPE_BUDGET_BYTES`. Off ⇒ exact pre-PRD behavior (parent AC-9).

## Files Touched

- **Modified:** [`src/daemon/runtime/capture/capture-handler.ts`](../../../../src/daemon/runtime/capture/capture-handler.ts) (flush buffer + budgeted serializer at `buildRow`/insert), [`src/daemon/storage/writes.ts`](../../../../src/daemon/storage/writes.ts) (multi-row append form, if extended), config provider for the new knobs; optionally [`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts) / the `sessions` catalog for an additive truncation marker via schema healing.
- **New:** a `capture-buffer.ts` + a `budgeted-stringify.ts` (or equivalent) with unit tests.

## Test Plan

- Unit: buffer flushes on size, on time, on shutdown; budgeted serializer caps large fields and marks truncation; small payloads pass through untouched.
- Parity: extractor + recall read the same fields pre/post trim on a fixed session corpus; recall-quality eval (PRD-027) unchanged.
- Live (PRD-031/034): a real session writes batched rows, the daemon restarts cleanly draining the buffer, recall over the captured session is unchanged.

## Risks and Open Questions

- **Risk:** buffer loses events on a hard crash. **Mitigation:** short window; document the loss bound; durable spill only if required. (Parent open question.)
- **Risk:** trimming a field a future consumer needs. **Mitigation:** the consumer audit gates which fields are liftable; keep the truncation marker so truncation is detectable, not silent.
- **Open question:** byte budget value; which metadata fields are truly session-invariant. (Parent open questions.)
