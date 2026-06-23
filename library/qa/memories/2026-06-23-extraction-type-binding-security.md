# Security Audit: Extraction-Type Binding (FactSchema.type → closed taxonomy)

**Audit type:** standalone, change-scoped (uncommitted diff on `feat/extraction-type-binding`)
**Audit date:** 2026-06-23
**Base branch:** `main` (last commit `2375c1c` — closed-taxonomy taxonomy work, PR #91)
**Head:** `feat/extraction-type-binding` (working tree; implementation uncommitted)
**Auditor:** security-worker-bee
**Verdict:** **PASS** — zero Critical, zero High, zero Medium, zero Low. No remediation required.

## Order check

PASS — ordering correct, no inversion.

The repo contains `library/qa/memories/2026-06-23-memory-type-taxonomy-qa.md` (a `quality-worker-bee` report), but it belongs to a **different, already-merged** branch (`feat/memory-type-taxonomy`, PR #91 — the server-validated enum + dashboard dropdown + MCP work). It was committed as part of that merged work (`2375c1c`), not produced against the current `feat/extraction-type-binding` diff. No `quality-worker-bee` has run against *this* change. `security-worker-bee` runs first as required; `quality-worker-bee` may run after.

## Scope

Change-scoped audit of the 4-file (+1 new test) diff that binds the autonomous extraction pipeline to the closed six-token memory taxonomy (`fact`/`convention`/`preference`/`decision`/`gotcha`/`reference`, single-sourced in `src/shared/memory-types.ts`):

- `src/daemon/runtime/pipeline/contracts.ts` — new `normalizeMemoryType(raw)`; `FactSchema.type` changed `z.string().min(1)` → `z.string().min(1).transform(normalizeMemoryType)`.
- `src/daemon/runtime/pipeline/extraction.ts` — prompt enumerates the six tokens via `MEMORY_TYPES` + `memoryTypeGuidance()`.
- `src/daemon/runtime/pipeline/index.ts` — barrel export of `normalizeMemoryType`.
- `tests/daemon/runtime/pipeline/contracts.test.ts` (new), `extraction.test.ts` (modified).

This is an internal pipeline restriction with **no new external attack surface**: no new datastore, no new harness protocol, no auth/credential code, no SQL construction, no new untrusted-data sink. Full Stinger fidelity applies; coverage is not degraded.

## Scorecard

| Category | Result | Evidence |
|---|---|---|
| SQL injection via `type` | None detected | `type` written via `val.str(...)` → `sLiteral` → `sqlStr` (`controlled-writes.ts:557`, `src/daemon/storage/sql.ts:112,42`); `npm run audit:sql` clean (213 files). Codomain is six `[a-z]` tokens — no quote/control chars even reach the escaper. |
| Missing `sqlIdent` on config identifier | None detected | Diff adds no table/column identifier interpolation. |
| ReDoS / unbounded work in `normalizeMemoryType` | None detected | No regex in the transform; `trim()`+`toLowerCase()`+frozen-object lookup, all O(n) on an already length-capped input (`contracts.ts:78-81`). |
| Closed-codomain / coercion safety | None detected | Every return is a `MEMORY_TYPES` member: branch-1 `isMemoryType(raw)`, branch-2 `TYPE_SYNONYMS` value (all six), branch-3 `DEFAULT_MEMORY_TYPE`. Parity test `contracts.test.ts:104-138` asserts no escape. |
| Idempotency (re-parse stability) | None detected | A token returns via branch 1 unchanged; tested `contracts.test.ts:86-101` (twice == once for all six + strays). `fan-out.ts:159` → decision re-parse is stable. |
| Prompt injection (new surface) | None detected | Only static single-source text interpolated into the instruction block (`MEMORY_TYPES.join("|")`, `memoryTypeGuidance()`). Untrusted `cappedText` is unchanged by this diff and remains after a `MEMORY:` label, below the instructions (`extraction.ts:235-253`). |
| Captured-trace PII / secret handling | None detected | This diff touches only the `type` token classification; content/PII handling, redaction, and capture opt-out paths are untouched. |
| Token/credential exposure to logs | None detected | No `console.*`, no credential/token/secret handling in the changed lines. |
| `any` at the boundary | None detected | `normalizeMemoryType(raw: string): MemoryType`; `FactSchema.type` resolves to `MemoryType`. No `any`/`as any` introduced. |
| Other field validation relaxed | None detected | Only `type` changed, and it was **tightened** (free-form string → closed-set coercion). `content`, `confidence`, entities unchanged. `min(1)` still guards empty/missing `type` before normalize. |

## Findings

**Critical:** None detected.
**High:** None detected.
**Medium:** None detected.
**Low:** None detected.

## Detailed verification of the three audit-focus claims

1. **`normalizeMemoryType` cannot be abused.** Confirmed. (a) No ReDoS / unbounded work — the synonym fold is a frozen-record lookup, the membership test is `Array.includes`, the input is the already length-capped fact `type`; there is no regex and no superlinear path. (b) Closed codomain — every branch returns one of the six tokens; proven by the parity test (`contracts.test.ts:104-138`) and by construction. (c) Idempotent — a normalized token re-enters via branch 1 and returns unchanged, so the decision stage's `readFacts → parseFact` re-parse (fed by `fan-out.ts:159` `fact_type: decision.fact.type`) does not move the token; tested at `contracts.test.ts:86-101`. (d) A malicious/garbage model `type` (huge string, control chars, injection-looking) is coerced to `fact` (or a synonym) **before** it ever reaches SQL; and even the hypothetical raw value would be inert through `val.str` → `sLiteral` → `sqlStr`, which doubles quotes/backslashes and strips C0 controls (`sql.ts:42-49`). No SQL injection via `type`.

2. **Prompt change introduces no new injection surface.** Confirmed. The only values interpolated into the instruction portion are `MEMORY_TYPES.join("|")` and `memoryTypeGuidance()` — both derived purely from the single source `src/shared/memory-types.ts` (no user/captured data). The untrusted `cappedText` was already present in the prompt before this diff and is unchanged; it remains positioned after the instructions beneath a `MEMORY:` label. Extracted-content (PII/secret-in-captured-text) handling is untouched by this diff.

3. **No collateral loosening.** Confirmed. The write seam (`fan-out.ts:159` → `controlled-writes.ts:557` `val.str(...)`) is unchanged and now inherits a coerced-valid token. No other field's validation was relaxed; no secret/PII written to disk, responses, or logs; `audit:sql` clean; no `any` at the boundary.

## DoD gate (all green)

| Command | Result |
|---|---|
| `npm run audit:sql` | PASS — 213 files, every interpolation routes through an escaping helper. |
| `npm run audit:openclaw` | PASS — bundle clean against ClawHub static-analysis rules. |
| `npm run ci` (typecheck + dup + vitest) | PASS — 256 files, 2898 passed / 6 skipped. (`sources/api.test.ts` load-flake did not surface this run.) |
| `npm run build` (`tsc && esbuild`) | PASS — all 15 bundles built @ 0.1.0. |

## Files changed by this audit

None. No Critical/High findings → no remediation. `git status` shows exactly the 4 expected files plus the new `contracts.test.ts`; `git diff --diff-filter=D` empty; nothing staged under `assets/` or `.scan-output/`.

## Residual risk

- **Low — non-canonical-casing token never reaches the synonym fold.** A canonical token uppercased (e.g. `"FACT"`) fails the case-sensitive `isMemoryType` branch, is not a `TYPE_SYNONYMS` key (those are the synonyms, not the six), and therefore falls to the `fact` floor — *correct* for `FACT` (which is `fact`), but a model emitting `"Decision"` lands on `fact` rather than `decision`. This is a **recall/quality** characteristic of the resilient floor, not a security issue (codomain stays closed, no fact dropped). Out of security scope; flagged for `retrieval-worker-bee` if classification fidelity matters.
- **None security-relevant.** The change strictly narrows the `type` codomain and adds no new sink, secret path, or untrusted interpolation.

## Recommendation

Ship. `quality-worker-bee` may now run to verify implementation-against-plan.
