# Security Audit — PRD-040 Memories Page

- **Auditor:** `security-worker-bee`
- **Date:** 2026-06-22
- **Scope:** the PRD-040 memories-page working-tree diff (uncommitted) — the additive read-model widen, the dashboard wire methods, the new `memories.tsx` page, and the tests.
- **Branch:** `main`
- **Verdict:** PASS — no Critical or High findings. No remediation required.

---

## Executive Summary

This audit covers the PRD-040 memories-page change set: a browse/search/view + add/edit/forget +
compact/pollinate/watch surface that consumes the **existing** `/api/memories/*` CRUD, `/api/diagnostics/{compact,pollinate}`,
and `/api/logs` endpoints (no new route), plus one **additive** widen of the daemon `MemoryRecord` read-model.

The diff is exemplary on every axis the threat checklist names. Every SQL identifier in the widened SELECT
routes through `sqlIdent`; the heavy 768-dim embedding vector is never pulled over the wire (only a derived
`content_embedding IS NOT NULL` presence bit); all memory content renders as escaped React text with no
`dangerouslySetInnerHTML`/`innerHTML`/`eval`; every write goes through the daemon (whose zod gate enforces the
reason requirement); the compaction selector is matched against a server-side allow-list; and no token, secret,
or header rides any list/detail/search/ack/summary/watch line.

**Findings: 0 Critical, 0 High, 0 Medium, 0 Low.** No code was modified — none was needed. The working tree is
byte-identical to its pre-audit state (verified via `git status --short`); nothing under `assets/` or any
unrelated file was touched.

**Ordering note:** no `*-qa-report.md` exists for PRD-040 (the `reports/` directory did not exist before this
audit). The ordering invariant — `security-worker-bee` runs before `quality-worker-bee` — is satisfied. QA may
now run.

**Gate results:**
- `npm run audit:sql` → **clean** ("every SQL interpolation routes through an escaping helper", 200 files scanned).
- `npm run ci` → **green**: 224 test files, 2428 passed, 6 skipped, 0 failed (includes the new
  `memories-page.test.tsx` 18 tests + `wire-memories.test.ts`). The pre-existing `sources/api.test.ts` load-flake
  did not surface this run.

---

## Threat-Checklist Disposition

### 1. SQL injection in the widened read-model — CLEAR

`src/daemon/runtime/memories/reads.ts:104-120` (`SELECT_COLS`): every column identifier routes through
`sqlIdent` (`id`, `type`, `content`, `confidence`, `agent_id`, `is_deleted`, `created_at`, `updated_at`, and the
OQ-1 additions `visibility`, `source_type`, `source_id`, `version`). The derived presence bit is
`` `(${sqlIdent("content_embedding")} IS NOT NULL) AS ${sqlIdent("has_embedding")}` `` — **both** the source
column and the alias pass through `sqlIdent`. No hand-quoted or interpolated identifier exists.

- The table name routes through `sqlIdent("memories")` in both `buildGetSql` (`reads.ts:156`) and `buildListSql`
  (`reads.ts:171`).
- The only request-influenced value, the `:id`, reaches SQL **only** via `sLiteral(id)` (`reads.ts:160`) — the
  canonical single-quoted-literal escaper.
- The `LIMIT` is a clamped integer (`resolveListLimit` → `[1, 500]`, then `Math.max(1, Math.trunc(limit))` at
  `reads.ts:174`) — a bare numeric interpolation, no caller string reaches it.
- **768-dim vector is NOT pulled over the wire:** the SELECT projects only `content_embedding IS NOT NULL`, never
  `content_embedding` itself. Confirmed at `reads.ts:118-119`.
- `npm run audit:sql` is clean across all 200 daemon files — the CI gate independently proves no builder
  hand-interpolates a value.

The `sqlIdent` guard itself (`src/daemon/storage/sql.ts:80-85`) validates against `^[a-zA-Z_][a-zA-Z0-9_]*$`
and **throws** on anything else (no silent sanitize), and `sLiteral`/`sqlStr` (`sql.ts:42-49, 112-114`) double
backslashes then single-quotes so an injection payload collapses to one inert literal.

### 2. Write-path safety (add / edit / forget) — CLEAR

- **`:id` is a path param, never SQL from the page.** The page `encodeURIComponent`s the id into the URL path
  (`src/dashboard/web/wire.ts:701, 717, 721`). It never builds SQL. The daemon receives `:id` as a route param
  and escapes it via `sLiteral` server-side.
- **The page sends only content / type / reason / agent — no SQL identifier.** `addMemory` sends
  `{ content, type?, agentId? }` (`wire.ts:704-711`); `modifyMemory` sends `{ content, reason, agentId? }`
  (`wire.ts:712-718`); `forgetMemory` sends `{ reason }` (`wire.ts:719-722`). No attacker-controlled identifier.
- **Reason-gate is enforced by the daemon (the source of truth).** `src/daemon/runtime/memories/api.ts:120-129`:
  `ModifyBodySchema` and `ForgetBodySchema` both declare `reason: z.string().min(1, "reason is required")`. The
  page additionally pre-validates a non-empty reason client-side (`memories.tsx:171, 176`) to fail fast, but the
  daemon zod gate is authoritative — a forged empty-reason request 400s.
- **No write bypasses the daemon.** The page only ever calls the loopback `wire` methods; it never imports a
  Deep Lake client or touches storage directly. Confirmed by the import list (`memories.tsx:29-39`) — React,
  primitives, page-frame, and wire types only.

### 3. Compaction trigger — CLEAR

- The page sends only an allow-listed table name or none: `compact(table?)` sends `{ table }` only when non-empty,
  else `{}` (`wire.ts:723-728`).
- The daemon matches the selector against a server-side allow-list:
  `src/daemon/runtime/maintenance/compact-api.ts:209-215` (`selectTables`) returns the requested table **only if**
  `COMPACTABLE_VERSION_BUMPED_TABLES.has(sel)`; an unknown / non-compactable name yields the **empty set**, so the
  selector cannot be coerced into reaping an arbitrary table. A missing-but-allow-listed table is probed and
  skipped, never a 500. The selector is the daemon's, not the page's.

### 4. XSS — memory content as inert text — CLEAR

All memory content (from captured traces, possibly markup-bearing) renders as **escaped React text children**:
- List snippet: `memories.tsx:128` (`{record.content}`).
- Detail full content: `memories.tsx:239` (`{record.content}`, `whiteSpace: "pre-wrap"`).
- Detail metadata: `MetaRow` (`memories.tsx:85`), all `{value}` children.
- Search-result content: rendered via `MemoryCard` → `primitives.tsx:403` (`{snippet}`), escaped text.
- Watch lines + compact summary: `{l}` / `{compactLine(t)}` text children (`memories.tsx:381-385, 502`).

There is **no** `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `eval` anywhere in
`src/dashboard/web`. The two grep hits for `dangerouslySetInnerHTML` (`memories.tsx:24, 217`) are both comments
documenting its deliberate absence — verified by reading. A markup-bearing memory renders as literal text and
cannot execute.

### 5. No secret + local-mode + PII — CLEAR

- **No credential is newly surfaced.** The widened read-model adds only a scope tag (`visibility`), provenance
  strings (`sourceType`/`sourceId`), a version number, and a boolean (`hasEmbedding`) — `reads.ts:60-69`,
  mirrored in `MemoryRecordSchema` (`wire.ts:198-212`). None is credential-shaped.
- **The watch filter adds no secret.** `RequestLogRecord` (`src/daemon/runtime/logger.ts:14-36`) carries
  method, path (query-string stripped), status, duration, mode, and resolved org/workspace scope — **never** a
  header, bearer token, or request body (documented and enforced at the logger). The page's watch filter
  (`memories.tsx:73-75, 568`) only `path.startsWith`-filters and `formatLogLine` renders `time + method + path +
  status` (`wire.ts:808-812`) — it introduces no field of its own.
- **Session headers carry no tenant identity or credential.** `DASHBOARD_SESSION_HEADERS` (`wire.ts:473-476`)
  stamps only `x-honeycomb-runtime-path: plugin` and a fixed loopback `x-honeycomb-session: dashboard-web`. The
  app deliberately does **not** send `x-honeycomb-org` (avoids cross-tenant coercion); org comes from the
  daemon's local default scope. The dashboard is local-mode-only (inherited from the shell). Memory content is
  user data, not a credential, and is rendered honestly as the persisted truth.

---

## Catalog Sweep (every category checked)

| Catalog item | Result |
|---|---|
| Missing `sqlIdent` on config/table identifier | None detected — all identifiers guarded |
| Unescaped value into Deep Lake SQL | None detected — only `sLiteral(id)` + numeric `LIMIT` |
| Embedding vector pulled over the wire | None detected — presence bit only |
| String-gate / pre-tool-use path bypass | N/A — diff does not touch the gate or VFS |
| Unscoped `me\|team` query / org coercion | None detected — page omits `x-honeycomb-org`; daemon owns scope |
| XSS / `dangerouslySetInnerHTML` / `eval` | None detected — escaped React text everywhere |
| Token / JWT / org-id leakage to logs/telemetry | None detected — logger redacts by construction; watch adds none |
| Captured-trace PII over-capture / new credential surface | None detected — only scope/provenance/version/boolean added |
| Prompt-injection poisoning path | N/A — diff does not touch recall-injection or skillify |
| Hardcoded secrets / committed credentials | None detected |
| Hallucinated / unused dependencies | None detected — diff adds no imports beyond existing modules |
| Verbose error echoing org/path detail | None detected — failures degrade to safe empty/null states |

---

## Files Changed (by this audit)

**None.** No remediation was required. The working tree is byte-identical to its pre-audit state.

| File | Change |
|---|---|
| (none) | — |

Diff under audit (unmodified by me):

| File | Status | Lines |
|---|---|---|
| `src/daemon/runtime/memories/reads.ts` | modified (additive widen) | +55/−9 region |
| `src/dashboard/web/wire.ts` | modified (6 wire methods + schemas) | +184 |
| `src/dashboard/web/pages/memories.tsx` | modified (full page) | +819 |
| `tests/dashboard/web/registry.test.tsx` | modified (route assertion) | +7 |
| `tests/dashboard/web/memories-page.test.tsx` | new (untracked) | — |
| `tests/dashboard/web/wire-memories.test.ts` | new (untracked) | — |

---

## Medium / Low for the record

None. Every Medium/Low category in the catalog was checked and came back clean (see the sweep table). The page's
defensive posture — zod `.catch()` on every wire field, re-read-never-optimistic after writes, honest empty
states, confirm-gated destructive actions, and the daemon-as-source-of-truth discipline — leaves no hygiene
residue worth recording.

---

## Recommendation

Ship. The diff introduces no Critical, High, Medium, or Low security finding. `quality-worker-bee` may now run
against this branch — the security pass is complete and the working tree is unchanged, so the QA report will not
be invalidated by any pending fix.
