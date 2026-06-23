# Security Audit — Memory-Type Taxonomy

- **Branch:** `feat/memory-type-taxonomy`
- **Date:** 2026-06-23
- **Auditor:** `security-worker-bee`
- **Scope:** The closed 6-value memory-type enum (`fact|convention|preference|decision|gotcha|reference`), single-sourced in `src/shared/memory-types.ts`, wired to four user-facing write surfaces (daemon API, dashboard, MCP tool, CLI).
- **Verdict:** **PASS** (no remediation required)

---

## Executive Summary

This branch is a **contract tightening plus one additive optional parameter** — it *restricts* an
existing free-form `type` field to a closed enum and adds an optional, enum-validated `type` to the
MCP `memory_store` tool. It introduces **no new attack surface, no new datastore, no new harness
protocol, and no credential/PII handling.** Full-fidelity coverage; no reduced-coverage flag needed.

**Ordering:** Correct. No `*-qa-report.md` exists for this branch (`library/qa/` checked) — security
ran before `quality-worker-bee`, as required.

Every audit-focus item from the brief was verified and holds. **Zero Critical, zero High, zero
Medium, zero Low findings.** No code was changed by this audit.

The change is a net security *improvement*: the previous daemon gate accepted any non-empty string
for `type` (`z.string().min(1)`); it now rejects unknown values with a fail-closed 400 that names
the valid set.

---

## Audit-Focus Findings

### 1. Enum gate is fail-closed and cannot be bypassed (PASS)

- `src/daemon/runtime/memories/api.ts:156-165` — `StoreBodySchema.type` is now
  `z.enum(MEMORY_TYPES, …).optional()`. An unknown `type` fails `safeParse`; the route returns
  `zodError(c, …)` → **400, rejected not coerced** (`api.ts:340-341`).
- **No other field relaxed.** The diff changed only the `type` field of `StoreBodySchema`;
  `content` (`min(1)`), `normalizedContent`, and `agentId` validators are byte-identical to `main`.
  Only post-validation `parsed.data.*` fields are spread into `storeMemory` (`api.ts:342-349`), and
  `type` is conditionally spread (omitted ⇒ daemon applies column default `fact`).
- **SQL-injection via `type` is impossible** — two independent guarantees:
  1. The enum gate restricts the value to six hard-coded safe tokens before it can reach SQL.
  2. Defense in depth: even an attacker-supplied value reaching the write would be escaped. The
     value flows `storeMemory` → `controlled-writes.ts:557` `["type", val.str(args.input.factType ?? "fact")]`
     → `writes.ts:71` `renderValue` (`literal` kind) → `sql.ts:112` `sLiteral` → `sql.ts:42` `sqlStr`,
     which escapes `\`, `'`, NUL, and control chars. `npm run audit:sql` confirms every interpolation
     routes through an escaping helper (213 files scanned, clean).
- **Org scoping intact.** The store route still calls `resolveScope(c)` and returns `400 NO_ORG_BODY`
  when absent (`api.ts:338-339`) — the `me|team`/org boundary is unchanged by this branch.

### 2. MCP tool contract — additive, validated, inert (PASS)

- `mcp/src/tools.ts:31-40` — `memoryTypeArg = z.enum(MEMORY_TYPES).describe(…).optional()` built
  from the single-sourced tuple with `zod/v3` (the MCP SDK's zod major). Added to `memory_store`
  (`tools.ts:66`) as an **optional** arg — purely additive; absent ⇒ daemon default.
- **No injection / oversized payload.** `z.enum` constrains input to six short literals; anything
  else is rejected at the tool boundary. No length/regex risk because the value set is closed.
- **Description text is inert.** The `.describe(...)` is a static template literal interpolating only
  `memoryTypeGuidance()` — a function built from the hard-coded tuple + frozen description record
  (`memory-types.ts:57-82`). No untrusted/runtime data enters the string. No prompt-injection vector.
- **Safe degradation.** `mcp/src/handlers.ts:142-147` `toStoreBody` threads `type` only when it is a
  non-empty string; otherwise it is not forwarded. An absent or (in a non-conforming harness)
  invalid `type` is re-validated by the daemon's enum gate — defense in depth holds.
- **No secret/PII exposure** via the tool schema or handler; `type` is a non-sensitive classifier.

### 3. CLI `--type` validation (PASS)

- `src/commands/storage-handlers.ts:131-142` `rememberTypeError` rejects an unknown `--type` with
  **exit code 2 before any daemon dispatch** (`runStorageVerb`, `storage-handlers.ts:281-289`).
- **No shell/arg injection.** The value is parsed by `flagValue` (`storage-handlers.ts:55-60`, plain
  `indexOf`), validated by `isMemoryType`, and placed into a JSON request `body` field
  (`buildRememberRequest`, `storage-handlers.ts:117-124`) — it is body data, never a shell token or
  path. `stripFlagPair` correctly removes the `--type <value>` pair so the token cannot leak into the
  remembered content positional join.

### 4. No regression to the autonomous pipeline (PASS — by design)

- `git diff main --name-only` confirms `fan-out.ts`, `controlled-writes.ts`, `writes.ts`, and
  `sql.ts` are **NOT touched**. The system-write path is unchanged.
- The enum gate is scoped to the four user-facing surfaces only. The autonomous capture pipeline
  (`fan-out.ts` → controlled-writes) enqueues its model-assigned `fact_type` directly and never
  passes through `StoreBodySchema`, so a free-form internal type still defaults/passes via
  `controlled-writes.ts:557` `factType ?? "fact"`. This is by-design back-compat, not a hole. The
  column DDL (`TEXT NOT NULL DEFAULT 'fact'`) is unchanged — no migration.

### 5. Hygiene gates (PASS)

- **`npm run audit:sql`** — clean (213 files; every interpolation through an escaping helper).
- **`npm run audit:openclaw`** — clean (no findings against ClawHub static rules).
- **`npm run build`** (`tsc && esbuild`) — passes; all bundles built. `tsc` clean ⇒ **no `any`** at
  the new boundaries (manual grep for `: any` / `as any` over the five changed source files: none).
- **`npm run ci`** — 255 test files / 2876 tests passed, 6 skipped, **0 failed**. The
  `sources/api.test.ts` load-flake noted in the brief did not surface.
- **No secret on disk / in responses / in logs.** Grep over the changed files for
  `token|secret|password|Bearer|process.env|console.log` surfaced only comments, the pre-existing
  unrelated `secret`-verb routing, and a pre-existing default `console.log` output sink — nothing
  introduced by this branch.

---

## Category Scorecard

| Category | Result |
|---|---|
| SQL injection (Deep Lake, missing `sqlIdent`/unescaped value) | None detected |
| Auth / org RBAC / `me\|team` scope coercion | None detected (scope path unchanged) |
| Credential / token exposure (logs, disk, responses) | None detected |
| Captured-trace PII exposure | None detected (no capture path touched) |
| Prompt injection (recall/skill/tool-description) | None detected (description text inert) |
| Pre-tool-use gate / VFS bypass | N/A (gate not touched) |
| Supply chain / OpenClaw bundle | None detected (audit clean) |
| Insecure deserialization / prototype pollution | None detected (zod-validated boundaries) |
| Input validation at boundaries | Improved (free-string → closed enum, fail-closed) |
| `any`/untyped boundaries | None detected |

---

## Files Changed (this branch — none modified by the audit)

| File | Nature |
|---|---|
| `src/shared/memory-types.ts` (new) | Single source: tuple + descriptions + guards (zod-free) |
| `src/shared/index.ts` | Re-export of the taxonomy module |
| `src/daemon/runtime/memories/api.ts` | `StoreBodySchema.type` → fail-closed enum gate |
| `src/dashboard/web/pages/memories.tsx` | Add-memory `type` free-text → `<select>` of six |
| `mcp/src/tools.ts` | `memory_store` gains optional enum `type` (zod/v3) |
| `mcp/src/handlers.ts` | `toStoreBody` threads optional `type` verbatim |
| `src/commands/contracts.ts` | `remember` summary lists `--type` values |
| `src/commands/storage-handlers.ts` | `--type` validated/stripped before dispatch |
| tests (3 files) | New/updated coverage incl. cross-surface parity |

**Asset/deletion safety:** `git diff --diff-filter=D` → zero deletions; `git status -- assets/` →
empty; no `.scan-output/` staged.

---

## Residual Risk

**None material.** This change reduces the input-validation surface of the user-facing memory-store
path and adds an enum-validated optional parameter to one MCP tool. The only standing observation is
**by-design and out of scope to "fix"**: the autonomous capture pipeline still accepts free-form
`fact_type` (intentional back-compat). That path already routes its value through the same
`val.str` → `sqlStr` escaping guard, so it carries no injection risk.

No follow-up audit required. No dependency/CVE intelligence is implicated by this change.
