# QA Findings Report — PRD-074 Sessions Prose Column

> **Audited:** 2026-07-05 · **Branch:** `prd-074-sessions-prose-column` · **Head:** `4103d84`
> **Auditor:** quality-worker-bee (Wave 5 of the-smoker run on PRD-074, GLM 5.2)
> **Source plan:** `library/requirements/backlog/prd-074-sessions-prose-column/` (index + 074a + 074b)
> **Authoritative AC ledger:** `library/ledger/EXECUTION_LEDGER-prd-074.md` (14 L-criteria)
> **Ordering:** `security-worker-bee` ran Wave 4 against `4103d84` and returned 0 Critical / 0 High / 0 Medium / 1 Low (documented, out-of-scope per PRD-074b). Report at `library/qa/security/2026-07-05-security-audit-prd-074-sessions-prose-column.md`. This QA report runs after security, in the correct order. No ordering violation. Security report is staged with this commit.

---

## Summary

PRD-074 (Sessions Prose Column — kill the JSONB blob in recall) is **VERIFIED**. All 24 acceptance criteria (7 module-level `m-AC`, 8 catalog-write `a-AC`, 9 tool-format `b-AC`) are implemented at the file:line the PRDs specify AND proven by passing tests I read directly (not the ledger's self-report). The motivating example from the PRD Overview — a captured `Read` of `dashboard.tsx:175-250` — produces `Read → web\pages\dashboard.tsx:175-250\n// 'healthReasons' is no longer polled here…`, single-backslashed, no `{"event":` envelope, no escaped quotes. The `COALESCE(NULLIF(prose, ''), message::text)` swap appears verbatim in BOTH the projection AND the `ILIKE` predicate (kept in sync by hand, intentionally inlined for the SQL-safety audit), so new rows match + return on clean prose while legacy rows fall through to the JSONB cast in the same scan. The hybrid reference candidate at `hybrid-recall.ts` is untouched (scope-clean), and the additive `TEXT NOT NULL DEFAULT ''` column heals idempotently through the existing `withHeal`/`healColumns` path, mirroring PRD-060a exactly.

My own verification commands passed: `npm run typecheck` (exit 0), `npm run audit:sql` (exit 0, 301 files, "every SQL interpolation routes through an escaping helper"), the four PRD-074 test suites + the regression `recall.test.ts` (**92 passed / 0 failed**), and five explicit spot checks the invoker requested (**5 passed / 0 failed**). 13 failures in `tests/hooks/runtime/hook-runtime.test.ts` are **PRE-EXISTING on `main`** (verified by checking out `main` and running the same file — same 13 timeouts, same file). They are unrelated to PRD-074 (no PRD-074 file is touched by that suite) and are documented under Wave-5 notes; they do NOT gate this PRD.

**Overall verdict: PASS. Zero Critical. Zero Warning. Two Suggestion (the `TOOL_PROSE_RESPONSE_CAP` tuning open question + a minor observability nicety), both already documented as follow-ups in the PRD itself.**

---

## Scorecard

| Axis | Status | Notes |
|---|---|---|
| **Completeness** | ✅ PASS | 24/24 ACs implemented. Every L-A..L-X ledger criterion flips DONE → VERIFIED. The two PRD open questions (`TOOL_PROSE_RESPONSE_CAP` tuning, `shortPath` depth) ship as designed: tunable constants, not gaps. |
| **Correctness** | ✅ PASS | The headline fixture produces the exact prose the PRD Overview promised. The COALESCE appears in both projection AND predicate (cannot drift). The `message` JSONB carries full-fidelity content verbatim (the 10 KB `Read` body survives to downstream parsers). `proseForEvent` is pure, synchronous, and degrades cleanly on malformed input (cycles, non-record `input`, missing fields). |
| **Alignment** | ✅ PASS | Column placement matches PRD-074a (between `source_tool` and `creation_date`). Helper placement matches (`event-contract.ts`, sibling to schemas). `hybrid-recall.ts` is in scope-exclusion, confirmed untouched. PRD vocabulary (`prose`, `proseForEvent`, `TOOL_PROSE_RESPONSE_CAP`, `shortPath`) used throughout — no drift. |
| **Gaps** | ✅ PASS | No silent gaps. The legacy-row COALESCE fallback is implemented AND tested (a legacy row with `prose=''` matches on `message::text`). Empty/absent/cyclic response bodies all degrade to "line 1 only" — no crash, no silent corruption. The 13 unrelated `hook-runtime.test.ts` failures pre-exist on `main` (verified) and are out of this PRD's blast radius. |
| **Detrimental patterns** | ✅ PASS | No `console.log`, no `eval`, no unbounded loops, no N+1. The COALESCE is intentionally inlined (not factored) so the SQL-safety audit recognizes each `sqlIdent`-guarded interpolation — this is documented in a code comment, not an anti-pattern. The two COALESCE sites are kept in sync by hand with an explicit warning comment. `JSON.stringify` in `extractResponseBody` is wrapped in `try/catch` for cycles. |

---

## Verification commands (run by me, this audit)

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **exit 0 — clean.** |
| `npm run audit:sql` | **exit 0 — "every SQL interpolation routes through an escaping helper"**, 301 files scanned under `src/daemon`, `src/daemon-client`. |
| `npx vitest run` over the four PRD-074 suites + regression `recall.test.ts` | **5 files, 92 passed / 0 failed.** (`event-contract-prose.test.ts` 30, `sessions-prose-column.test.ts` 7, `recall-sessions-prose.test.ts` 9, `capture-handler-prose.test.ts` 11, `recall.test.ts` 35.) |
| Five explicit spot checks (separate fixture, run during this audit, then removed) | **5 passed / 0 failed.** Headline Read blob, 10 KB Read, legacy-row COALESCE, Windows backslashes, scope-cleanliness smoke. Results reproduced in the "Spot-check results" section below. |
| `git diff main...HEAD --stat -- src/daemon/runtime/memories/hybrid-recall.ts` | **empty** — `hybrid-recall.ts` is NOT in the diff. Scope confirmed clean. |
| Pre-existing-failure baseline (`git checkout main` → `npx vitest run tests/hooks/runtime/hook-runtime.test.ts`) | **13 failed / 10 passed** — the same 13 timeouts the W2/W3 gate hit. **Pre-existing on `main`, NOT a PRD-074 regression.** See "Out-of-scope failures" note below. |

---

## Spot-check results (the five the invoker requested)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | **Screenshot's exact Read blob.** A `CaptureEvent` for a `Read` of `C:\Users\mario\GitHub\the-apiary\hive\src\dashboard\web\pages\dashboard.tsx` `offset:175, limit:75` with `response.file.content = "// 'healthReasons' is no longer polled here — the SHEL…"` → `proseForEvent(event)` starts `Read → web\pages\dashboard.tsx:175-250\n// 'healthReasons'...` | ✅ PASS | `event-contract.ts:285` (`${tool} → ${shortPath(filePath)}${range}`), `:351-355` (`shortPath` last-three-segments), `:358-362` (`detectSeparator` preserves backslash). Test: `event-contract-prose.test.ts:82-91` ("the screenshot's exact Read blob"). Spot-check fixture (this audit) asserted `prose.startsWith("Read → web\\pages\\dashboard.tsx:175-250\n// 'healthReasons'")` → true; `prose` contains `'healthReasons' is no longer polled here`; does NOT contain `{"event":`, `\"kind\"`, or `web\\pages`. |
| 2 | **A 10 KB Read response.** `response.file.content` of 10240 chars → `prose.length <= TOOL_PROSE_RESPONSE_CAP + first-line length` AND `JSON.parse(message).response.file.content.length === 10240`. | ✅ PASS | `event-contract.ts:269` (`truncate(body, TOOL_PROSE_RESPONSE_CAP)`), `:227` (`TOOL_PROSE_RESPONSE_CAP = 500`). Tests: `event-contract-prose.test.ts:217-237` (prose ≤ cap + first-line + ellipsis; prose < 10_000); `capture-handler-prose.test.ts:334-361` (parses `message` JSONB literal out of the INSERT and asserts `responseContent.length === 10_000`). Spot-check fixture reproduced both bounds. |
| 3 | **Legacy row (empty `prose`).** The COALESCE in `buildSessionsArmSql` falls through to `message::text` for a row where `prose = ''`. | ✅ PASS | `recall.ts:413,415` — both the SELECT projection and the `ILIKE` predicate carry `COALESCE(NULLIF(prose, ''), message::text)`. `NULLIF('', '')` evaluates to NULL → COALESCE returns `message::text`. Tests: `recall-sessions-prose.test.ts:60-77` (projection + predicate each carry the COALESCE; exactly two occurrences); `:131-149` (a legacy row with the JSONB envelope still surfaces on the fallback, with the harness receiving the JSONB-cast text); `:151-169` (new + legacy rows surface together in one query). |
| 4 | **Windows backslashes.** `file_path` `C:\foo\bar.tsx` surfaces as `...\bar.tsx` (single backslashes), not `...\\bar.tsx` (escaped doubles). | ✅ PASS | `event-contract.ts:351-362` — `shortPath` splits on `/[\\/]/`, then `detectSeparator` picks the dominant separator (`\\` when backslashes ≥ forward slashes) and re-joins with it. Tests: `event-contract-prose.test.ts:331-347` (Windows `file_path` keeps single backslashes; `not.toContain("web\\\\pages")`), `:349-359` (Bash command path), `:361-371` (last-three-segments joined with `\\`). Spot-check fixture: `proseForEvent({file_path:"C:\\foo\\bar.tsx", offset:5, limit:10}) === "Read → C:\\foo\\bar.tsx:5-15"`; `not.toContain("C:\\\\foo")`. |
| 5 | **Scope cleanliness.** `git diff main...HEAD --stat` does NOT include `src/daemon/runtime/memories/hybrid-recall.ts`. | ✅ PASS | `git diff main...HEAD --stat -- src/daemon/runtime/memories/hybrid-recall.ts` → empty output, exit 0. The 13 changed paths are: `library/ledger/EXECUTION_LEDGER-prd-074.md`, the three PRDs, `capture-handler.ts`, `event-contract.ts`, `recall.ts`, `sessions-summaries.ts`, four new test files, and the regression update to `recall.test.ts`. **`hybrid-recall.ts` is genuinely untouched** (the ADR-0001 / PRD-047a exclusion holds). |

---

## Critical Issues (must fix)

**None.**

---

## Warnings (should fix)

**None.**

---

## Suggestions (consider improving)

### SUG-1 — `TOOL_PROSE_RESPONSE_CAP` (500) is the PRD's own open question, not a code defect

The cap ships as a named, exported constant (`event-contract.ts:227`, `TOOL_PROSE_RESPONSE_CAP = 500 as const`), exactly as `m-AC-5` / `b-AC-5` require. The PRD's Open Questions section explicitly recommends a follow-up measurement pass against a representative session corpus to tune it to the 90th percentile of response sizes per tool kind. The Wave-1 ledger ruling `R1` adopts 500 as the conservative default for first deploy. **No action required for ship** — the constant is tunable without code surgery, and the open question is documented in the PRD index, 074b, and the ledger. Flagging here only so a future tuning PRD has a paper trail.

### SUG-2 — Observability: the prose column is silent on hit-rate by column source

`buildSessionsArmSql` returns a uniform `text` alias whether the COALESCE filled it from `prose` (new row) or `message::text` (legacy row). The row-to-hit mapper (`rowsToRankedArm`) is unchanged by design (the PRD explicitly keeps the COALESCE in SQL, not the mapper). The net effect is that there is no daemon-side signal for "what fraction of sessions hits are still on the JSONB fallback vs. the clean prose column" — useful for deciding when the corpus has turned over enough to drop the COALESCE. This is a **nice-to-have observability seam**, not a requirement; the PRD does not call for metrics. A future PRD that tunes `TOOL_PROSE_RESPONSE_CAP` (SUG-1) could couple in a counter here.

---

## Plan Item Traceability — 24-AC matrix

Legend: **VERIFIED** = implemented at the file:line the PRD specifies AND proven by a test I read directly · **NOT VERIFIED** = gap · **N/A** = not applicable to this PRD's scope.

### Module-level (index, 7 ACs)

| AC | Criterion (abbreviated) | Status | Implementation | Proving test(s) |
|---|---|---|---|---|
| **m-AC-1** | `sessions` gains `prose TEXT NOT NULL DEFAULT ''` via additive heal; heal is additive + idempotent (mirrors PRD-060a a-AC-3) | ✅ VERIFIED | `sessions-summaries.ts:88` (`{ name: "prose", sql: "TEXT NOT NULL DEFAULT ''" }`); validated by `validateColumnDefs` load guard | `sessions-prose-column.test.ts` (a-AC-1 block, 4 tests) + (a-AC-2 block, 3 tests: additive ALTER, legacy diff = exactly `['prose']`, idempotent once present) |
| **m-AC-2** | Lexical `sessions` arm returns `prose` for non-empty, falls back to `message::text` for empty via `COALESCE(NULLIF(prose, ''), message::text)` in projection AND `ILIKE` predicate | ✅ VERIFIED | `recall.ts:413` (projection), `:415` (predicate) | `recall-sessions-prose.test.ts` (L-C1 SQL-shape block, 5 tests; L-C1 end-to-end block, 4 tests); regression update in `recall.test.ts:240-249` |
| **m-AC-3** | Capture handler populates `prose` for every new `sessions` INSERT from the typed `CaptureEvent`; both single + batched paths | ✅ VERIFIED | `capture-handler.ts:582-590` (`["prose", val.str(proseForEvent(event))]` in `buildRow`, used by both single + batched INSERT paths) | `capture-handler-prose.test.ts:226-259` (single + batched paths both carry `prose`) |
| **m-AC-4** | Existing `message` JSONB consumers unchanged | ✅ VERIFIED | `capture-handler.ts:582-590` ships `prose` ALONGSIDE `message` (the JSONB write at `:576-580` is untouched). Static grep: no consumer file (`summaries/worker.ts`, `skillify/miner.ts`, `dashboard/roi-session-writer.ts`, `dashboard/api.ts`) references `prose` | `capture-handler-prose.test.ts:317-383` (parses `message` literal out of INSERT; typed envelope survives verbatim for user_message, tool_call with 10 KB response, assistant_message with usage+model) |
| **m-AC-5** | `tool_call` prose bounded by named, exported constant `TOOL_PROSE_RESPONSE_CAP`, not a magic number | ✅ VERIFIED | `event-contract.ts:227` (`export const TOOL_PROSE_RESPONSE_CAP = 500 as const`); used at `:269` (`truncate(body, TOOL_PROSE_RESPONSE_CAP)`) | `event-contract-prose.test.ts:98-105` (asserts the named constant is a finite positive number equal to 500); `:217-237` (cap bounds the body); `:239-253` (Bash stdout also capped) |
| **m-AC-6** | `user_message` / `assistant_message` `prose` is `event.text` verbatim (no cap, no truncation) | ✅ VERIFIED | `event-contract.ts:239-249` (`proseForEvent` returns `event.text` for those kinds) | `event-contract-prose.test.ts:53-78` (4 tests, including a 5000-char user_message that survives uncapped); `capture-handler-prose.test.ts:386-451` (L-D2 parity block, 4 tests including awkward whitespace + single-quote wire-encoding) |
| **m-AC-7** | All existing recall, capture-handler, heal, dashboard tests remain green; `hybrid-recall.ts` untouched | ✅ VERIFIED | Diff excludes `hybrid-recall.ts` (verified by `git diff main...HEAD --stat`). Regression update to `recall.test.ts:240-249` keeps the per-arm SQL-builder suite aligned with the new COALESCE | `recall.test.ts` (35 tests, all green). **Note:** 13 pre-existing timeouts in `tests/hooks/runtime/hook-runtime.test.ts` are reproduced on `main` and are out of this PRD's blast radius — see "Out-of-scope failures" below |

### PRD-074a — Catalog, Capture Write, Recall Swap (8 ACs)

| AC | Criterion (abbreviated) | Status | Implementation | Proving test(s) |
|---|---|---|---|---|
| **a-AC-1** | `sessions` group gains `prose TEXT NOT NULL DEFAULT ''` in `SESSIONS_COLUMNS`, alongside existing additive columns | ✅ VERIFIED | `sessions-summaries.ts:83-88` (positioned after `source_tool`, before `creation_date`) | `sessions-prose-column.test.ts:27-58` (4 tests: column SQL, positioning, validateColumnDefs passes, reachable via `healTargetFor('sessions')`) |
| **a-AC-2** | Column heals cleanly via `withHeal`/`healColumns`; heal is additive + idempotent (mirrors PRD-060a a-AC-3) | ✅ VERIFIED | Additive shape rendered by `buildAddColumnSql` → `ALTER TABLE "sessions" ADD COLUMN prose TEXT NOT NULL DEFAULT ''` (no `IF NOT EXISTS`, no DROP, no rewrite) | `sessions-prose-column.test.ts:61-95` (3 tests: targeted ALTER; legacy-dataset diff = exactly `['prose']`; idempotent once present) |
| **a-AC-3** | Capture handler populates `prose` for every new `sessions` INSERT from typed `CaptureEvent` (no JSONB re-parse); both single + batched | ✅ VERIFIED | `capture-handler.ts:70` (imports `proseForEvent`); `:582-590` (writes `["prose", val.str(proseForEvent(event))]` in `buildRow`, which both single and batched INSERT paths flow through) | `capture-handler-prose.test.ts:226-305` (4 tests: single, batched, tool_call bounded prose, additive alongside `message`) |
| **a-AC-4** | `user_message`/`assistant_message` → `prose = event.text` verbatim, no cap | ✅ VERIFIED | `event-contract.ts:239-249` | (covered by m-AC-6 evidence above) |
| **a-AC-5** | `tool_call` follows 074b format (file-path-aware line 1 + bounded response); cap is named export `TOOL_PROSE_RESPONSE_CAP` | ✅ VERIFIED | `event-contract.ts:265-270` (`proseForToolCall`); `:278-299` (`toolCallFirstLine`); `:324-341` (`extractResponseBody`); `:269` (cap via `truncate`) | (covered by b-AC block below) |
| **a-AC-6** | Lexical arm returns COALESCE(NULLIF(prose, ''), message::text) in projection AND predicate so legacy rows stay matchable | ✅ VERIFIED | `recall.ts:413,415` | (covered by m-AC-2 evidence above) |
| **a-AC-7** | Every existing `message` JSONB consumer unchanged; each still parses the typed envelope | ✅ VERIFIED | `message` JSONB write preserved verbatim in `buildRow`; no consumer file references `prose` (static-grep confirmed) | (covered by m-AC-4 evidence above) |
| **a-AC-8** | All existing recall, capture-handler, heal, dashboard tests remain green; `hybrid-recall.ts` untouched | ✅ VERIFIED | `hybrid-recall.ts` excluded from diff; regression `recall.test.ts` updated to assert the COALESCE shape | (covered by m-AC-7 evidence above) |

### PRD-074b — The `tool_call` Prose Format (9 ACs)

| AC | Criterion (abbreviated) | Status | Implementation | Proving test(s) |
|---|---|---|---|---|
| **b-AC-1** | `proseForToolCall(event)` exported from `event-contract.ts`; pure, synchronous, no IO | ✅ VERIFIED | `event-contract.ts:265` (`export function proseForToolCall`); no `await`, no IO, no throw paths (cycles caught at `:333-338`) | `event-contract-prose.test.ts:376-410` (3 tests: synchronous string return for every kind; malformed `input` degrades to bare tool name; cyclic response degrades to omit-line-2) |
| **b-AC-2** | `file_path` input → first line `${tool} → ${shortPath}:${range}` when offset+limit present, else `${tool} → ${shortPath}` | ✅ VERIFIED | `event-contract.ts:283-286` (`file_path` branch with `rangeSuffix`); `:306-312` (`rangeSuffix` requires BOTH offset + limit as finite numbers) | `event-contract-prose.test.ts:111-155` (4 tests: full Read shape, Edit without pagination, offset-only, limit-only — all collapse to no-range-suffix correctly) |
| **b-AC-3** | `command` input (no `file_path`) → first line `${tool}: ${truncate(command, 80)}` | ✅ VERIFIED | `event-contract.ts:293-296` (`command` branch, `truncate(command, 80)`) | `event-contract-prose.test.ts:156-175` (2 tests: short command; long command collapses + caps at exactly 80 + ellipsis = 87 chars total) |
| **b-AC-4** | No recognizable target field → first line `${tool}` | ✅ VERIFIED | `event-contract.ts:298` (fallback bare `${tool}`); precedence: `file_path` → `path` → `command` → bare | `event-contract-prose.test.ts:177-211` (3 tests: bare WebSearch; generic `path` field → `${tool} → ${shortPath}`; `file_path` precedence over `path`/`command`) |
| **b-AC-5** | Response line whitespace-collapsed + capped at `TOOL_PROSE_RESPONSE_CAP` (default 500, named export) | ✅ VERIFIED | `event-contract.ts:269` (truncate at cap); `:370-374` (`truncate` collapses `\s+` → single space FIRST, then caps) | `event-contract-prose.test.ts:255-269` (collapse test: 4-space-indented 3-line content collapses to single-spaced); `:303-313` (short response under cap survives unchanged, no `…`); `:98-105` (named constant assertion) |
| **b-AC-6** | `Read` of 10 KB → prose ≤ cap + first-line length (~600 total); full 10 KB survives in `message` JSONB | ✅ VERIFIED | (cap at `event-contract.ts:269`) | `event-contract-prose.test.ts:217-237` (prose body = cap + 1 ellipsis; total ≤ first-line + 1 + cap + 1; prose < 10_000); `capture-handler-prose.test.ts:334-361` (parses `message` JSONB; asserts `responseContent === bigContent` and `.length === 10_000`) |
| **b-AC-7** | `Bash` with multi-KB stdout → bounded prose row | ✅ VERIFIED | `event-contract.ts:331-332` (`response.stdout` extractor branch) | `event-contract-prose.test.ts:239-253` (10 KB stdout → first line `Bash: git log`; body collapses + caps + ellipsis; prose < stdout length) |
| **b-AC-8** | `user_message`/`assistant_message` `prose` is `event.text` verbatim — no cap, no truncation, no transformation | ✅ VERIFIED | `event-contract.ts:239-249` | (covered by m-AC-6 / L-D2 evidence above) |
| **b-AC-9** | Windows path separators in `file_path` preserved as-is (no re-escaping to double-backslashes) | ✅ VERIFIED | `event-contract.ts:351-362` (`shortPath` + `detectSeparator` preserve the dominant separator) | `event-contract-prose.test.ts:331-371` (3 tests: Windows `file_path` keeps single `\\`; Bash command path keeps single `\\`; last-three-segments joined with `\\`) |

**Matrix totals: 24 VERIFIED · 0 NOT VERIFIED · 0 N/A.**

---

## Scope confirmation

- **`hybrid-recall.ts` untouched.** `git diff main...HEAD --stat -- src/daemon/runtime/memories/hybrid-recall.ts` returns empty (exit 0). The hard constraint holds. The PRD's Non-Goal ("No change to the native `deeplake_hybrid_record` reference candidate") is honored. The recall swap is in the LIVE `recallMemories` engine only (the `ILIKE` lexical arm at `recall.ts:413,415`); the `<#>` cosine semantic arm and the unwired hybrid reference candidate are both untouched, exactly as ADR-0001 / PRD-047a require.
- **Backfill: none.** Per PRD Non-Goals and ledger ruling `R6`, legacy rows heal in with `prose = ''` and recall's COALESCE falls through to `message::text` for them. Verified by `recall-sessions-prose.test.ts:131-149` (legacy row still matches on the JSONB fallback).
- **`message` JSONB consumers: unchanged.** Static-grep across `summaries/worker.ts`, `skillify/miner.ts`, `dashboard/roi-session-writer.ts`, `dashboard/api.ts` confirms none reference the new `prose` column. The JSONB write at `capture-handler.ts:576-580` is untouched; the new `prose` write at `:582-590` is additive alongside it.
- **Capture contract: unchanged.** The harness POSTs the same `{event, metadata}` shape; `parseCaptureRequest` and the zod boundary in `event-contract.ts` are unchanged. The prose is derived daemon-side from the typed event after zod validation.

---

## Out-of-scope failures (documented, NOT a PRD-074 regression)

The full `npm run test` gate shows **13 failed / 4393 passed / 12 skipped** across 416 files. The 13 failures are ALL in `tests/hooks/runtime/hook-runtime.test.ts` and are timeouts (5000ms `Test timed out`). I verified by checking out `main` and running the same single file: **same 13 failures / 10 passed**. The failures are pre-existing on `main` and unrelated to PRD-074 — `hook-runtime.test.ts` exercises the Claude Code session-start / pre-tool-use hook plumbing, touches **no** PRD-074 file (no capture-handler, no event-contract, no recall, no sessions catalog), and the PRD-074 changeset neither imports nor is imported by anything in `tests/hooks/runtime/`.

This matches the ledger's Wave-3 note (`L-X1`) that the same suite flaked under heavy parallel load and that `npx vitest run --no-file-parallelism` was the green path on the prior PRD. It does NOT gate PRD-074. Recommended follow-up: file a separate ticket against `hook-runtime.test.ts` for the timeout flakiness (likely CPU-saturation under parallelism, given the prior PRD's `--no-file-parallelism` baseline).

---

## Files changed (alphabetical)

- `library/ledger/EXECUTION_LEDGER-prd-074.md` (A) — the orchestrator's 14-criterion AC ledger + wave plan.
- `library/qa/security/2026-07-05-security-audit-prd-074-sessions-prose-column.md` (A, staged with this commit) — Wave-4 security report (0 Critical/High/Medium, 1 Low documented).
- `library/requirements/backlog/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md` (A) — the index PRD (7 m-ACs).
- `library/requirements/backlog/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md` (A) — catalog/capture/recall sub-PRD (8 a-ACs).
- `library/requirements/backlog/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md` (A) — tool_call prose format sub-PRD (9 b-ACs).
- `src/daemon/runtime/capture/capture-handler.ts` (M) — `buildRow` writes `["prose", val.str(proseForEvent(event))]` alongside `message`.
- `src/daemon/runtime/capture/event-contract.ts` (M) — adds `proseForEvent` / `proseForToolCall` / `TOOL_PROSE_RESPONSE_CAP` + helpers (`shortPath`, `truncate`, `extractResponseBody`, `rangeSuffix`, `recordField`, `detectSeparator`) and the `ToolCallEvent` type alias.
- `src/daemon/runtime/memories/recall.ts` (M) — `buildSessionsArmSql` projection + `ILIKE` predicate both carry `COALESCE(NULLIF(prose, ''), message::text)`.
- `src/daemon/storage/catalog/sessions-summaries.ts` (M) — adds `{ name: "prose", sql: "TEXT NOT NULL DEFAULT ''" }` to `SESSIONS_COLUMNS`.
- `tests/daemon/runtime/capture/capture-handler-prose.test.ts` (A) — 11 tests: write paths + JSONB parity.
- `tests/daemon/runtime/capture/event-contract-prose.test.ts` (A) — 30 tests: every b-AC + verbatim user/assistant prose.
- `tests/daemon/runtime/memories/recall-sessions-prose.test.ts` (A) — 9 tests: COALESCE SQL shape + end-to-end new/legacy surfacing.
- `tests/daemon/runtime/memories/recall.test.ts` (M) — regression: assertions updated from `message::text ILIKE` to the COALESCE shape.
- `tests/daemon/storage/catalog/sessions-prose-column.test.ts` (A) — 7 tests: column shape + additive/idempotent heal.

**Out-of-scope file confirmed NOT in diff:** `src/daemon/runtime/memories/hybrid-recall.ts`.

---

## Close-out

PRD-074 is ship-ready. Every L-A..L-X ledger criterion flips DONE → **VERIFIED**. The implementation matches the PRDs at the file:line level, the tests prove behavior (not shape alone), the SQL-safety audit gate is clean, security ran before QA in the correct order with zero blocking findings, and the one persistent gate flake is pre-existing on `main` and out of this PRD's blast radius. The two Suggestions are documentation/observability seams already named in the PRD's own Open Questions; neither blocks merge.
