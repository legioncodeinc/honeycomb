# QA Report: Extraction-Type Binding (autonomous pipeline → closed 6-type taxonomy)

**Audit type:** standalone, change-scoped (uncommitted diff on `feat/extraction-type-binding`)
**Audit date:** 2026-06-23
**Base:** `main` @ `2375c1c` (merge-base = HEAD; branch carries no commits, all work is in the working tree)
**Head:** `feat/extraction-type-binding` (4 modified files + 1 new test, uncommitted)
**Auditor:** quality-worker-bee
**Order check:** PASS — `security-worker-bee` ran first (`library/qa/memories/2026-06-23-extraction-type-binding-security.md`, verdict PASS, zero findings). A casing fix landed AFTER that security pass; this audit verifies the code as it now stands and does NOT re-run a security audit.

## Summary

The change binds the autonomous memory-extraction pipeline to the closed six-token taxonomy (`fact/convention/preference/decision/gotcha/reference`, single-sourced in `src/shared/memory-types.ts`) by making `FactSchema.type` a `z.string().min(1).transform(normalizeMemoryType)` — coercing rather than rejecting, so a stray model `type` is never dropped. All five requirement items are implemented, real (not no-op), and test-locked; the casing fix the security report flagged as residual risk is genuinely covered both directly and through `parseFact`. The four DoD gates (`ci`, `build`, `audit:sql`, `audit:openclaw`) are green.

**Verdict: PASS.** No Critical, no Warning. One Suggestion (non-blocking).

## Scorecard

| Axis | Status | Notes |
|---|---|---|
| Completeness | PASS | All 5 verification items present in code + tests; `normalizeMemoryType` exported via barrel (`index.ts`). |
| Correctness | PASS | Normalize order, idempotency, min(1)-before-transform, closed codomain all behave as specified and proven by tests. |
| Alignment | PASS | Single-source discipline held: prompt + contract both draw from `MEMORY_TYPES`/`memoryTypeGuidance()`; write seam unchanged. |
| Gaps | PASS | No fact-dropping regression; empty/missing/non-string `type` still fails the fact; no other field loosened. |
| Detrimental patterns | PASS | The a-AC-2 prompt-length test rewrite is an honest fix (measures real header), not a weakening of the content cap. |

## Critical Issues (must fix)

None detected.

## Warnings (should fix)

None detected.

## Suggestions (consider improving)

**S-1 — `normalizeMemoryType` whitespace/casing handling is correct but the synonym fold does not trim its own lookup the same way.** `contracts.ts:74-76`. Branch 2 trims+lowercases (`raw.trim().toLowerCase()`) before the canonical re-check, but the branch-3 synonym lookup reuses that same `lower` value, so `"  rule  "` correctly folds to `convention`. This is fine. The only residual edge: a synonym key emitted with *internal* punctuation (e.g. `"pre-ference"`, `"url:"`) is not folded and falls to the `fact` floor — acceptable by design (the prompt does the real work; the fold is a thin net), but if recall classification fidelity later matters, `retrieval-worker-bee` could widen `TYPE_SYNONYMS`. Not a defect against this plan; codomain stays closed and no fact is dropped. No action required for ship.

## Plan Item Traceability

| # | Requirement (from brief) | Implementation | Test lock | Status |
|---|---|---|---|---|
| 1 | `FactSchema.type` = `z.string().min(1).transform(normalizeMemoryType)`; normalizes, never drops | `contracts.ts:114` (schema), `contracts.ts:72-77` (normalizer) | `contracts.test.ts:30-38` (six verbatim), `:40-59` (off-enum kept), `:81-93` (empty/missing/non-string fails) | PASS |
| 1a | Normalize order: canon kept → casing/whitespace canon → synonym fold → `fact` floor | `contracts.ts:73` (branch1 `isMemoryType(raw)`), `:74-75` (branch2 lower canon), `:76` (synonym `??` default) | `contracts.test.ts:66-78` (canon-first + casing), `:41-64` (synonym + floor) | PASS |
| 1b | Idempotent (decision stage re-parses) | `contracts.ts:73` returns canon unchanged on second pass | `contracts.test.ts:95-110` (twice==once for six + strays; re-parse stable) | PASS |
| 1c | Parsed `Fact.type` codomain is exactly the six (parity-style assertion against `MEMORY_TYPES`) | by construction: every branch returns a `MEMORY_TYPES` member | `contracts.test.ts:113-147` (every produced output `isMemoryType`; all six reachable; `FactSchema` emits only taxonomy tokens) | PASS |
| 2 | Casing fix genuinely covered: `"Decision"`→`decision` (not `fact` floor) via `normalizeMemoryType` AND `parseFact` | `contracts.ts:74-75` (the post-security casing branch) | `contracts.test.ts:71-78` (`normalizeMemoryType("Decision")`→`decision`, `"GOTCHA"`, `"  Convention "`; plus `parseFact({type:"Decision"})`→`decision`) | PASS |
| 3 | Extraction prompt instructs the six + embeds `memoryTypeGuidance()`/`MEMORY_TYPES` from the single source; JSON hint reads closed set | `extraction.ts:36` (import from source), `:235-251` (`buildExtractionPrompt` uses `MEMORY_TYPES.join("|")` + `memoryTypeGuidance()`) | `extraction.test.ts:284-296` (prompt contains every token, the verbatim guidance block, and `one of fact|...|reference`) | PASS |
| 4 | E2E: off-enum/garbage `type` → fan-out `memory_decision` whose forwarded `type` is a valid token; write seam `fan-out.ts:159`→`controlled-writes.ts:557` unchanged, inherits it | `fan-out.ts:159` `fact_type: decision.fact.type` (unchanged vs main); `controlled-writes.ts:557` `["type", val.str(args.input.factType ?? "fact")]` (unchanged vs main) | `extraction.test.ts:319-349` (`type:'banana'`→enqueued `fact_type:'fact'`, `isMemoryType` true), `:351-376` (`'rule'`→`'convention'` end-to-end) | PASS |
| 5 | a-AC-2 prompt-length test rewritten to measure real header (`12_000 + buildExtractionPrompt("").length`), not a magic constant; honest, not a weakening | `extraction.test.ts:126-127` | self-asserting: still caps `seenPromptLength` (content-cap invariant intact). Prior main was `12_000 + 500` (magic) — confirmed via `git show main:` | PASS |

### Verification notes

- **Item 5 honesty check (detrimental-pattern axis).** The prior assertion on `main` was `expect(seenPromptLength).toBeLessThanOrEqual(12_000 + 500)`. The rewrite is `const headerLength = buildExtractionPrompt("").length; expect(seenPromptLength).toBeLessThanOrEqual(12_000 + headerLength)`. The bound is still an upper cap on the prompt the model sees (the content-cap invariant), and it now tracks the template automatically as the taxonomy guidance grows. This is a strengthening of the test's accuracy, not a loosening — it removes a brittle magic number that would silently break (or, worse, falsely pass with slack) when the header changed. Confirmed not a no-op.
- **Casing fix vs security residual risk.** The security report's Residual Risk #1 explicitly flagged that `"Decision"` would land on the `fact` floor. The post-security casing branch (`contracts.ts:74-75`) closes exactly that gap, and `contracts.test.ts:71-78` locks it both ways (direct normalizer + `parseFact`). The fix is real and covered.
- **No-fact-dropping guarantee.** `min(1)` runs before `.transform`, so empty/missing/non-string `type` still fails the fact (`contracts.test.ts:81-93`) — the resilient floor applies only to non-empty strings, exactly as specified. The off-enum kept-not-dropped behavior is proven at `contracts.test.ts:40-64` and end-to-end at `extraction.test.ts:319-349`.
- **Single-source / no-drift.** Both the contract (`TYPE_SYNONYMS` targets) and the prompt draw from `src/shared/memory-types.ts`; the shared parity test (`tests/shared/memory-types-parity.test.ts`) and the pipeline parity block (`contracts.test.ts:113-147`) jointly assert nothing escapes the closed six.

## DoD Gate Results

| Command | Result | Evidence |
|---|---|---|
| `npm run ci` (typecheck + jscpd dup + vitest) | PASS | 256 test files, **2899 passed / 6 skipped**, exit 0. The `sources/api.test.ts` load-flake did not surface this run; targeted re-run below confirms the new suites are real. |
| `npm run build` (`tsc && esbuild`) | PASS | All 15 bundles built @ 0.1.0 (1 daemon + 1 dashboard-web + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon). |
| `npm run audit:sql` | PASS | 213 files; every SQL interpolation routes through an escaping helper. |
| `npm run audit:openclaw` | PASS | OpenClaw bundle clean against ClawHub static-analysis rules. |
| Targeted suites (isolation) | PASS | `vitest run contracts.test.ts extraction.test.ts` → **35 passed** (19 + 16). Tests are real, not no-ops. |

## Files Changed

| File | Change | Verdict |
|---|---|---|
| `src/daemon/runtime/pipeline/contracts.ts` | Adds `normalizeMemoryType` (4-branch normalizer incl. casing/whitespace canon) + `TYPE_SYNONYMS`; `FactSchema.type` → `z.string().min(1).transform(normalizeMemoryType)`. The load-bearing change. | Correct, well-documented, idempotent, closed codomain. |
| `src/daemon/runtime/pipeline/extraction.ts` | `buildExtractionPrompt` enumerates the six tokens via `MEMORY_TYPES` + `memoryTypeGuidance()` from the single source. | Correct; prompt cannot drift from the gate. |
| `src/daemon/runtime/pipeline/index.ts` | Barrel: adds `normalizeMemoryType` export. | Correct; enables the contracts test to drive the real function. |
| `tests/daemon/runtime/pipeline/contracts.test.ts` (new) | 19 tests: six-verbatim, off-enum-kept, casing fix (direct + `parseFact`), empty/missing/non-string fail, idempotency, parity. | Drives the real contract; a future loosening fails here. |
| `tests/daemon/runtime/pipeline/extraction.test.ts` (modified) | Adds prompt-taxonomy + off-enum→fan-out E2E tests; rewrites the a-AC-2 prompt-length bound to the measured header. | Honest fix; E2E proves the write seam inherits a valid token. |

## Write seam — unchanged confirmation

Both seam files are byte-identical to `main` (`git diff --stat main` empty for each):
- `fan-out.ts:159` — `fact_type: decision.fact.type` forwards the normalized `Fact.type` into the `memory_controlled_write` payload.
- `controlled-writes.ts:557` — `["type", val.str(args.input.factType ?? "fact")]` writes the inherited token (which is now guaranteed one of the six before it arrives).

The binding is enforced upstream at the contract; the seam correctly inherits it without modification.

## Recommendation

**PASS — ship.** No Medium-or-higher blocker. All five verification items are implemented, real, and test-locked; the post-security casing fix is genuinely covered; the prompt-length test rewrite is an honest accuracy improvement; the write seam is unchanged and inherits a guaranteed-valid taxonomy token. The single Suggestion (S-1, synonym-fold breadth) is a non-blocking recall-quality matter for `retrieval-worker-bee`, not a defect against this plan.
