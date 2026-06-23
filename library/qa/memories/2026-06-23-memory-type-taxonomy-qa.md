# QA Report: Memory-Type Taxonomy (closed 6-value `type` set)

**Plan document:** standalone audit (no PRD folder; companion to `library/qa/memories/2026-06-23-memory-type-taxonomy-security.md`)
**Audit date:** 2026-06-23
**Base branch:** `main` (merge-base `5cbfe22`)
**Head:** `feat/memory-type-taxonomy` (working tree; implementation uncommitted)
**Auditor:** quality-worker-bee
**Order check:** `security-worker-bee` ran first → PASS, zero findings. Ordering correct; this QA runs second as required.

## Summary

**Verdict: PASS-WITH-FINDINGS.** All six surfaces of the closed taxonomy (single source, server gate, dashboard dropdown, MCP enum, CLI flag, back-compat scoping) are REAL, wired, and behavior-test-locked — not no-ops. The whole DoD gate is green: typecheck, dup (0.72%), 2876 tests, `audit:sql`, `audit:openclaw`, and `build` all pass. Drift-guarding works: I empirically mutated the MCP enum and confirmed the parity suite fails on exactly that surface. The findings are two Warnings and three Suggestions — none block ship. The one substantive finding: the parity test's **daemon** assertion (`memory-types-parity.test.ts:67-75`) reconstructs an enum from the source rather than importing the daemon's real `StoreBodySchema`, so that single assertion does NOT guard daemon drift — though a sibling suite (`type-taxonomy.test.ts`) does catch it, so coverage is intact end-to-end.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All four user-facing surfaces + single source + back-compat present and wired. |
| Correctness   | ✅ | Gate fail-closed, token lands in INSERT, omitted→`fact`, unknown→400 naming the set. Verified live. |
| Alignment     | ✅ | Vocabulary, single-source discipline, zod-major split (v4 app / v3 MCP) all match the stated design. |
| Gaps          | ⚠️ | Parity test's daemon assertion is a re-derivation, not a real-surface guard (caught elsewhere). |
| Detrimental   | ✅ | No injection, no dup-floor breach, no scope leak; autonomous pipeline left unconstrained by design. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Parity test's daemon assertion does not guard the real daemon schema**, `tests/shared/memory-types-parity.test.ts:67-75`

  The suite's docstring claims it "asserts the daemon enum" so "the four surfaces cannot drift." The CLI, MCP-enum, and MCP-guidance assertions genuinely drive the real surfaces (`isMemoryType`, `TOOL_SPECS`, `memoryTypeGuidance`). The daemon assertion does not: it reconstructs `zV3.enum(MEMORY_TYPES)` from the shared source rather than importing `StoreBodySchema` from `api.ts`. I proved this empirically — hardcoding the daemon's `StoreBodySchema` to `.enum(["fact","convention"])` left this parity test fully GREEN (5/5). Daemon drift IS caught, but by a different file (`type-taxonomy.test.ts`, 4 failures on the same mutation). Recommend the parity test import and assert the real `StoreBodySchema` (e.g. drive `StoreBodySchema.safeParse({content:"x", type})` for each of the six + a reject) so the single file lives up to its "every surface" claim.

  ```ts
  // lines 67-75 — reconstructs, never references the daemon's StoreBodySchema:
  const enumSchema = zV3.enum(MEMORY_TYPES);
  for (const t of MEMORY_TYPES) expect(enumSchema.safeParse(t).success).toBe(true);
  ```

- [ ] **Parity test does not assert the dashboard surface at all**, `tests/shared/memory-types-parity.test.ts` (whole file)

  The docstring lists "the dashboard Add-memory dropdown (renders `MEMORY_TYPES`)" as one of the four surfaces the suite proves draw from one source, but there is no dashboard assertion in the file (the dropdown is covered only by `memories-page.test.tsx`). Same shape as the daemon gap: end-to-end coverage exists, but the parity file's "one source feeds EVERY surface" promise is two-of-four short. Either trim the docstring's claim or add the two missing assertions so the parity file is the genuine single-file drift tripwire it advertises.

## Suggestions (consider improving)

- [ ] **`StoreMemoryRequest.type` is `string`, not `MemoryType`**, `src/daemon/runtime/memories/store.ts:81`

  The field is typed `readonly type?: string` with a comment "defaults to `'fact'`". The runtime enum gate in `api.ts` makes this safe (an out-of-set value can't reach `storeMemory` via the API), but typing it `MemoryType` would push the closed set into the type system and document intent at the signature. Low value since the daemon test already locks the runtime behavior.

- [ ] **MCP `toStoreBody` re-checks `type` as a bare non-empty string**, `mcp/src/handlers.ts:146`

  `if (typeof args.type === "string" && args.type.length > 0) body.type = args.type;` forwards any non-empty string; it relies on the strict tool schema having already enum-validated `type`, and on the daemon's gate as defense-in-depth (both real). Correct as written — noting only that the membership re-check is implicit, not explicit, at this seam.

- [ ] **Dashboard `<select>` `title` double-casts**, `src/dashboard/web/pages/memories.tsx:391`

  `title={MEMORY_TYPE_DESCRIPTIONS[type as keyof typeof MEMORY_TYPE_DESCRIPTIONS]}` casts the `string`-typed `type` state to a key. Since `type` only ever holds a `MEMORY_TYPES` token (the `<select>` can't produce anything else), typing the state as `MemoryType` would drop the cast. Cosmetic.

## Plan Item Traceability

| #   | Plan Requirement | Status | Implementation Location | Notes |
|-----|------------------|--------|--------------------------|-------|
| 1   | Single source `MEMORY_TYPES` (6 tokens) + descriptions + `DEFAULT_MEMORY_TYPE` | ✅ | `src/shared/memory-types.ts:37-82`, re-exported `src/shared/index.ts:12-19` | Pure (no zod), `as const` tuple feeds both zod majors. |
| 1a  | All four surfaces draw from the source (no copy-pasted lists) | ✅ | imports in `api.ts:51`, `tools.ts:25`, `storage-handlers.ts:21`, `memories.tsx:33-37` | Confirmed; `dup` shows no taxonomy clones. |
| 1b  | Parity test asserts daemon + MCP-enum + CLI + LLM-guidance equal the six; fails on drift | ⚠️ | `tests/shared/memory-types-parity.test.ts` | MCP-enum/CLI/guidance are REAL guards (proven by mutation). Daemon assertion re-derives, doesn't import `StoreBodySchema`; dashboard not asserted. See Warnings. |
| 2   | Server gate: accepts each of six → token in INSERT | ✅ | `api.ts:156-165` (`StoreBodySchema`) → `store.ts:171` (`factType`) → `controlled-writes.ts:557` | Test-locked `type-taxonomy.test.ts:63-77`. |
| 2a  | Defaults to `fact` when omitted; DDL `TEXT NOT NULL DEFAULT 'fact'` unchanged (no migration) | ✅ | `controlled-writes.ts:557` (`args.input.factType ?? "fact"`) | Test `type-taxonomy.test.ts:79-90`; no schema migration in diff. |
| 2b  | Rejects unknown type with 400 naming the valid set, BEFORE any write | ✅ | `api.ts:159-163` (`error: () => ...`), `:340-341` (`safeParse` → `zodError`) | Test `type-taxonomy.test.ts:92-107` asserts 400 + no INSERT reached. |
| 3   | Dashboard Add-memory `type` is a `<select>` of the six, default `fact`, descriptions per option | ✅ | `memories.tsx:386-399` | DOM-proven `memories-page.test.tsx`: exactly six options, default `fact`. |
| 3a  | Submitting passes the chosen token through the existing add path | ✅ | `memories.tsx:340-361,712-721` (`onAdd` → `wire.addMemory`) | Test asserts `addMemory({content, type:"decision"})`. |
| 4   | MCP `memory_store` optional `type` enum w/ when-to-use description, built from source (zod/v3) | ✅ | `tools.ts:37-40,66` (`memoryTypeArg` w/ `.describe(memoryTypeGuidance())`) | Parity-tested; mutation proved drift fails the suite. The user's priority surface — graded explicitly below. |
| 4a  | Handler threads `type` to the write | ✅ | `handlers.ts:142-148` (`toStoreBody`), `:179` (`memory_store`) | Forwards `type` verbatim; daemon re-validates (defense in depth). |
| 5   | CLI `remember --type` validates against enum (unknown→rejected pre-daemon; valid→body, stripped from content) | ✅ | `storage-handlers.ts:120-145` (`buildRememberRequest`, `rememberTypeError`), `:283-289` (pre-dispatch gate, exit 2) | Tests in `storage-handlers.test.ts`: strip, reject (no daemon call), all six accepted. |
| 5a  | `--help`/summary lists the valid tokens | ✅ | `src/commands/contracts.ts:80` (verb summary) + `memoryTypeGuidance()` in the reject message | Summary enumerates all six tokens. |
| 6   | Back-compat: legacy/free-form rows keep their value and still display (write-time validation only) | ✅ | `memory-types.ts:23-29` (doc), `memories.tsx:136,209` (`record.type || "fact"` render), gate is write-only | No row-rewrite path in the diff. |
| 6a  | Gate scoped to user-facing writes; autonomous extraction (`fan-out.ts` free-form `fact_type`) left unconstrained — honest, documented | ✅ | `fan-out.ts:159` (`fact_type: decision.fact.type`, enqueued directly), documented `memory-types.ts:23-29` + `api.ts:144-154` | Verified: autonomous path bypasses the API zod gate by construction. Intentional, not an accidental gap. Test `type-taxonomy.test.ts:110-123` proves the internal path still yields `fact`. |
| NG-1 | Whether the taxonomy should ALSO constrain autonomous LLM extraction | 🟦 | n/a (out of scope) | **Product decision, flagged for the user** — NOT a defect of this change. The autonomous pipeline writing free-form `fact_type` is a deliberate scoping line; constraining it is a separate, future decision. |

Status key: ✅ met · ⚠️ met with a finding · ❌ not met · 🟦 out of scope / deferred.

## Files Changed

- `library/qa/memories/2026-06-23-memory-type-taxonomy-qa.md` (A) — this report.
- `mcp/src/handlers.ts` (M) — `toStoreBody` threads the optional `type` onto the `/api/memories` store body.
- `mcp/src/tools.ts` (M) — adds `memoryTypeArg` (zod/v3 enum from `MEMORY_TYPES` + `.describe(memoryTypeGuidance())`); wires it onto `memory_store`.
- `src/commands/contracts.ts` (M) — `remember` verb summary now lists the six valid `--type` tokens.
- `src/commands/storage-handlers.ts` (M) — `buildRememberRequest` strips the `--type` pair from content + adds the token to the body; `rememberTypeError` rejects an unknown type before dispatch (exit 2).
- `src/daemon/runtime/memories/api.ts` (M) — `StoreBodySchema.type` enum gate over `MEMORY_TYPES` with a set-naming 400; threads `type` into `storeMemory`.
- `src/dashboard/web/pages/memories.tsx` (M) — Add-memory `<select>` of the six (default `fact`, per-option description titles); `onAdd` forwards the token.
- `src/shared/index.ts` (M) — re-exports the taxonomy from the barrel.
- `src/shared/memory-types.ts` (A) — the single source: `MEMORY_TYPES`, `MemoryType`, `DEFAULT_MEMORY_TYPE`, `MEMORY_TYPE_DESCRIPTIONS`, `isMemoryType`, `memoryTypeGuidance`.
- `tests/commands/storage-handlers.test.ts` (M) — CLI taxonomy suite (strip, reject-before-dispatch, all six, one-dispatch).
- `tests/dashboard/web/memories-page.test.tsx` (M) — dropdown suite (exactly six, default `fact`, submits chosen token).
- `tests/daemon/runtime/memories/type-taxonomy.test.ts` (A) — server gate suite (six accepted + token in INSERT, omit→`fact`, unknown→400, internal path unbroken).
- `tests/shared/memory-types-parity.test.ts` (A) — parity suite (source, CLI guard, MCP enum, MCP guidance; daemon assertion re-derived — see Warnings).
