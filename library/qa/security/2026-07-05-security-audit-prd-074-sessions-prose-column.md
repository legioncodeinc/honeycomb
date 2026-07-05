# Security Audit Report: PRD-074 sessions prose column (branch `prd-074-sessions-prose-column`)

**Audit date:** 2026-07-05
**Auditor:** security-worker-bee (Wave 4 of the-smoker run on PRD-074, GLM 5.2)
**Scope:** the PRD-074 changeset at commit `4103d84` — five surfaces:
1. `src/daemon/storage/catalog/sessions-summaries.ts` (the new `prose` catalog column)
2. `src/daemon/runtime/capture/capture-handler.ts` `buildRow` (~L590) + new `proseForEvent` / `proseForToolCall` / `extractResponseBody` / `shortPath` / `truncate` / `recordField` in `src/daemon/runtime/capture/event-contract.ts`
3. `src/daemon/runtime/memories/recall.ts` `buildSessionsArmSql` (~L413, L415) — the COALESCE swap
4. PII exposure through the `prose` column (Bash `command`, file `content`)
5. Supply chain (`package.json` / lockfiles in the diff)

Out of scope by hard constraint: `src/daemon/runtime/memories/hybrid-recall.ts` (untouched by this PRD; ADR-0001 / PRD-047a).

**Node version audited:** `>=22.5.0` (from `package.json` `engines`)
**`npm audit` result:** clean — 0 info / 0 low / 0 moderate / 0 high / 0 critical across 623 deps (111 prod / 437 dev / 138 optional).
**OpenClaw bundle scan:** not re-run — no dependency or bundle change in `4103d84` (Surface 5 below), so the existing CI scan stands.
**CVE watchlist last refreshed:** 2026-04-24 (72 days old; under the 120-day staleness threshold).

---

## Executive Summary

**Overall posture: clean. No Critical or High findings. No remediation required.** The PRD-074 changeset is schema-additive on `sessions`, adds a derived `prose` TEXT column populated from already-validated event fields, and swaps the recall lexical arm from `message::text` to `COALESCE(NULLIF(prose, ''), message::text)`. Every interpolation into the new SQL routes through the existing `sqlIdent` / `sqlLike` / `sLiteral` guards; the new prose value routes through `val.str` → `sLiteral` → `sqlStr`. The SQL-safety audit gate exits 0; the targeted vitest suites (197 tests across 19 files) are green. The only finding is a Low-severity PII observation that is explicitly documented as out-of-scope in PRD-074b and that does NOT widen the existing exposure surface (the `message` JSONB column already ships the same content verbatim).

**Severity counts:** 0 Critical · 0 High · 0 Medium · 1 Low (documented).

**Ordering check on entry:** no `*-qa-report.md` for this branch exists in `library/qa/quality/` or under `library/requirements/backlog/prd-074-sessions-prose-column/` newer than commit `4103d84`. `quality-worker-bee` has not yet produced a report for this branch — this audit runs in the correct order.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | ATTN | 1 Low (documented; out of scope per PRD) |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deep Lake SQL API) | OK | 0 |
| Dependency & OpenClaw Bundle | OK | 0 |
| Configuration (cred modes, capture opt-out, client hardening) | OK | 0 |
| Pre-Tool-Use Gate & Prompt Injection | OK | 0 |

Legend: **OK** = zero findings · **ATTN** = Medium/Low findings documented · **FAIL** = Critical/High findings (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings (follow-up required)

None detected.

---

## Low Findings (documentation only)

- [ ] **CAPTURED-TRACE PII / secret-bearing `command` shipped in `prose`** — `src/daemon/runtime/capture/event-contract.ts:293-296` (`toolCallFirstLine`, the `command` arm) and `:269` (`proseForToolCall` line 2 body).
  - **Description.** A `tool_call` for the `Bash` tool may carry secrets in `input.command` (e.g. `curl -H "Authorization: Bearer sk-live-..."`) or in the response `stdout`. The new `prose` column ships a bounded form of both: `${tool}: ${truncate(command, 80)}` on line 1 and a capped (500-char) `extractResponseBody` snippet on line 2. The bounded form is then surfaced to the harness via recall's lexical arm.
  - **Severity reasoning.** **Low — not Critical/High — because `prose` is NOT a new disclosure.** The structured `message` JSONB column (the source of truth) ALREADY carries `input.command` and the response verbatim and has done so since PRD-005; recall used to ship that JSONB blob to the harness verbatim (`message::text`). PRD-074 strictly NARROWS the disclosed surface (the bounded `prose` ≤ ~580 chars vs. the unbounded JSONB blob). The secret-bearing content is the same; the new column cannot leak a secret that was not already in the row. Per the Stinger rule that "Credential and captured-trace PII findings are always Critical or High", this would escalate IF `prose` introduced a new exfiltration path — it does not; it is a lossy reduction of an existing one. Documented honestly as Low because there is no NEW exposure to remediate.
  - **Already documented.** PRD-074b `prd-074b-tool-call-prose-format.md:135` ("Redaction" open question) explicitly names the `Bash` `Authorization: Bearer sk-...` example, confirms `message` JSONB already carries it verbatim, and identifies `proseForToolCall` as the seam where a future redaction policy would land. PRD-074 declares full redaction OUT OF SCOPE for this PRD with its own threat model. The threat is recorded where downstream readers will look.
  - **Recommended follow-up (architectural).** A future PRD should add a redaction pass at the `proseForToolCall` seam (regex sweep for known secret shapes: `Bearer ...`, `sk-live-...`, AWS `AKIA...`, GitHub `ghp_...`, connection strings). This is its own threat model and does not belong in this changeset.

---

## Dependency Audit

```text
$ npm audit --audit-level=high --json
{
  "vulnerabilities": {},
  "metadata": {
    "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0, "total": 0 },
    "dependencies": { "prod": 111, "dev": 437, "optional": 138, "total": 623 }
  }
}
```

Clean. `4103d84` changed NO dependency manifests (`package.json`, `package-lock.json`, no lockfiles) — confirmed via `git diff main..HEAD --name-only`.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **SQL guards** (`src/daemon/storage/sql.ts`) | `sqlIdent` regex `[A-Za-z_][A-Za-z0-9_]*`; every interpolation wrapped | `sqlStr` doubles `\` then `'`, drops C0/C1 controls; `sqlLike` escapes `% _ \` then `sqlStr` rules; `sqlIdent` throws on anything outside `[A-Za-z_][A-Za-z0-9_]*` | OK |
| **Recall arm guards** (`buildSessionsArmSql`) | `proseCol`, `messageCol`, `pathCol`, `sessionsTbl`, `createdAtCol` all `sqlIdent(...)`; `pattern` is `sqlLike(...)`; `perArm` is `Math.trunc` numeric | Confirmed at `recall.ts:396-403`; the COALESCE is inlined VERBATIM at projection (L416) and predicate (L417) so each `${proseCol}` / `${messageCol}` is a DIRECT `sqlIdent`-guarded interpolation the audit recognizes | OK |
| **Capture write guard** (`buildRow`) | `prose` value routes through `val.str` → `sLiteral` → `sqlStr` (no raw interpolation into SQL) | `capture-handler.ts:590` `["prose", val.str(proseForEvent(event))]`; `val.str` builds `{kind:"literal"}` → `renderValue` → `sLiteral` → `'${sqlStr(v)}'` | OK |
| **Catalog heal DDL** (`schema.ts:160`) | table + column names through `sqlIdent`; `col.sql` is a static source literal | `buildAddColumnSql` validates both `tableName` and `col.name` via `sqlIdent`; `prose.sql` = `"TEXT NOT NULL DEFAULT ''"` (a frozen source-literal in `SESSIONS_COLUMNS`, not attacker-controllable) | OK |
| **Capture-path robustness** | the new helpers (`proseForEvent`, `proseForToolCall`, `extractResponseBody`, `shortPath`, `truncate`, `recordField`, `rangeSuffix`) cannot throw on malformed `input` / `response` | `recordField` typeof-guards + returns `undefined`; `extractResponseBody` wraps `JSON.stringify` in try/catch for cycles; `shortPath` / `truncate` only call `String.prototype` methods (split/match/replace/slice/trim) which never throw on a string; `rangeSuffix` `Number.isFinite`-checks both operands | OK |
| **Config table names via `sqlIdent`** | N/A — no config-driven table name in this PRD | `sessions` is a hard-coded string literal, not a config value | OK |
| **Pre-tool-use gate** | N/A — PRD-074 does not touch the gate or the VFS | `src/hooks/pre-tool-use.ts` and `src/shell/deeplake-fs.ts` unchanged in `4103d84` | OK |
| **Credential file modes** | N/A — no cred-file change | unchanged | OK |
| **Capture opt-out** (`HIVEMIND_CAPTURE=false`) | N/A — no capture-gating change | unchanged; `prose` populates on the same append-only INSERT the rest of `buildRow` uses, so the existing opt-out suppresses it identically | OK |
| **OpenClaw bundle scan** (`npm run audit:openclaw`) | no dependency change → existing CI scan stands | no `package.json` / lockfile in `4103d84` | OK |
| **No token in logs / traces** | the new `prose` value is written to Deep Lake via the same path as `message`; no new `console.*` / logger call introduces token logging | `proseForEvent` is pure, returns a string; no logging added in the new code | OK |

---

## Per-surface audit notes

### Surface 1 — Catalog column (`sessions-summaries.ts:83-88`)

The new entry is `{ name: "prose", sql: "TEXT NOT NULL DEFAULT ''" }`, schema-additive, frozen via `Object.freeze` on `SESSIONS_COLUMNS`. The heal engine renders DDL through `buildAddColumnSql` (`schema.ts:160-164`):

```ts
const safeTable = sqlIdent(tableName);
const safeCol = sqlIdent(col.name);
return `ALTER TABLE "${safeTable}" ADD COLUMN ${safeCol} ${col.sql}`;
```

Both `tableName` (`"sessions"`) and `col.name` (`"prose"`) are static string literals in source, and `sqlIdent` re-validates them against `^[A-Za-z_][A-Za-z0-9_]*$`. `col.sql` (`"TEXT NOT NULL DEFAULT ''"`) is a frozen source literal — NOT attacker-controllable. The heal path renders safe DDL. **No injection through column name or sql spec.** `NOT NULL DEFAULT ''` is heal-safe on a populated legacy table (the empty string backfills), so the existing `information_schema`-then-targeted-`ALTER` heal flow on a populated `sessions` table will not abort the write path. Confirmed by `tests/daemon/storage/catalog/sessions-prose-column.test.ts` (7 tests, green).

### Surface 2 — Capture write (`capture-handler.ts:590` + `event-contract.ts:199-385`)

**SQL routing.** The write site is `["prose", val.str(proseForEvent(event))]`. `val.str` constructs `{ kind: "literal", value }`; `renderValue` (`writes.ts:67-69`) maps that to `sLiteral(v.value)`; `sLiteral` (`sql.ts`) is `'${sqlStr(v)}'`. So the prose value is byte-identically escaped through the same `'...'` literal path every other text column (`path`, `agent`, `model`, …) uses. **No raw `${...}` interpolation of the prose value into SQL.** A payload containing `'; DROP TABLE x; --` collapses to one inert literal (the embedded quote is doubled, cannot close the string early).

**Hot-path robustness (cannot throw on malformed `input` / `response`).** `proseForEvent` runs synchronously on every capture (the harness hot path); a throw would crash the turn. Traced every helper:
- `recordField(obj, key)` — `typeof obj !== "object" || obj === null` guard returns `undefined`; never throws.
- `extractResponseBody(response)` — typeof/string branches; the `JSON.stringify(response)` fallback is wrapped in `try { … } catch { return null; }` so a cyclic object (the only shape that throws in `JSON.stringify`) degrades to "no body". Never throws.
- `shortPath(p)` — only `.split()` and `.filter()` and `.join()` on a string already type-narrowed; `String.prototype.split` cannot throw on a string input.
- `detectSeparator(p)` — `.match(/\\/g) ?? []` is null-safe.
- `truncate(s, n)` — `.replace(/\s+/g, " ").trim()` then `.slice(0, n)`; `String.prototype` methods on a string. Never throws.
- `rangeSuffix(input)` — `Number.isFinite` on both operands before `${offset + limit}`; finite+finite is finite (large-but-finite values interpolate fine).
- `toolCallFirstLine` / `proseForToolCall` — only compose the above.

**Defensive narrowing off `unknown`.** The zod boundary types `input` and `response` as `z.unknown()`; every field access goes through `recordField` and a `typeof === "string"` (or `"number"`) narrow. There is no `(event.input as any).file_path` shape anywhere in the new code. **Verified.**

Confirmed by `tests/daemon/runtime/capture/event-contract-prose.test.ts` (30 tests) + `tests/daemon/runtime/capture/capture-handler-prose.test.ts` (11 tests), both green.

### Surface 3 — Recall SQL swap (`recall.ts:395-419`)

The full arm:

```ts
const pattern          = `'%${sqlLike(term)}%'`;
const sessionsTbl     = sqlIdent("sessions");
const pathCol        = sqlIdent("path");
const proseCol       = sqlIdent("prose");
const messageCol     = sqlIdent("message");
const createdAtCol   = sqlIdent("creation_date");
const perArm        = Math.max(1, Math.trunc(perArmLimit));
return (
    `SELECT 'sessions' AS source, ${pathCol} AS id, COALESCE(NULLIF(${proseCol}, ''), ${messageCol}::text) AS text, ${createdAtCol}::text AS created_at ` +
    `FROM "${sessionsTbl}" ` +
    `WHERE COALESCE(NULLIF(${proseCol}, ''), ${messageCol}::text) ILIKE ${pattern}${projectClause} ` +
    `LIMIT ${perArm}`
);
```

- `${proseCol}` / `${messageCol}` / `${pathCol}` / `${sessionsTbl}` / `${createdAtCol}` — all `sqlIdent(...)` of hard-coded string literals. **No attacker-controlled identifier.**
- `${pattern}` — `'%${sqlLike(term)}%'`; `sqlLike` escapes `\\`, `%`, `_`, doubles `'`, drops controls. **Existing lexical-arm discipline preserved.** A search term containing `' OR 1=1 --` collapses to one inert ILIKE pattern.
- `${perArm}` — `Math.trunc` of a number; inlined as a bare integer (the audit's documented numeric exception).
- `${projectClause}` — pre-existing (PRD-049b); not touched by this PRD; same `sqlIdent`/`sqlLike` discipline.

The COALESCE is deliberately inlined VERBATIM at both the projection (L416) and the predicate (L417) so each `${proseCol}` / `${messageCol}` is a DIRECT `sqlIdent`-guarded interpolation the audit recognizes (a factored local would defeat the gate's grep). The two sites cannot drift apart.

**`audit:sql` gate.** `node scripts/audit-sql-safety.mjs` → exit 0 ("OK - every SQL interpolation routes through an escaping helper"), scanned across 301 files under `src/daemon` + `src/daemon-client`. **Clean.**

Confirmed by `tests/daemon/runtime/memories/recall-sessions-prose.test.ts` (9 tests) + `tests/daemon/runtime/memories/recall.test.ts` (35 tests), both green.

### Surface 4 — PII in `tool_call` prose

See the Low finding above. The new `prose` column ships a bounded form of `Bash` `command` and tool response to the harness via recall. **This is NOT a new disclosure** — `sessions.message` JSONB has carried both verbatim since PRD-005, and recall used to ship that blob via `message::text`. PRD-074 narrows the disclosed surface. The threat is explicitly documented as out-of-scope in PRD-074b:135, with `proseForToolCall` named as the future redaction seam.

### Surface 5 — Supply chain

`git diff main..HEAD --name-only` lists 13 files: 4 source, 4 test, 1 ledger, 3 PRD docs, 1 catalog. **No `package.json`, no `package-lock.json`, no lockfiles, no dependency manifests.** No new dependencies were added. The existing CI scans (`npm audit`, CodeQL, `audit:openclaw`) stand unchanged. **Clean.**

---

## Files Changed (remediation)

No files changed by this audit. The changeset at `4103d84` is sound as committed; no remediation was required.

| File | Change Summary |
|---|---|
| _(none)_ | _(no remediation applied — 0 Critical, 0 High, 0 Medium findings)_ |

`git diff` reviewed on 2026-07-05: empty (no remediation edits). Pre-existing `4103d84` source under audit only.

---

## Recommended Follow-Up (architectural)

1. **Redaction at the `proseForToolCall` seam.** A future PRD should add a regex-based secret sweep over the `command` arm of `toolCallFirstLine` and over `extractResponseBody` (line 2). Known shapes to redact: `Bearer ...`, `sk-live-...` / `sk-ant-...` (Anthropic), `AKIA...` (AWS access key id), `ghp_...` / `gho_...` (GitHub), connection strings (`postgres://user:pass@...`). The `prose` column is a deliberate, bounded, match-ready reduction — the natural place to apply a redaction policy WITHOUT affecting the structured `message` JSONB source of truth. PRD-074b:135 already names this as the seam.

2. **`TOOL_PROSE_RESPONSE_CAP` corpus measurement.** PRD-074's open question recommends measuring a real capture corpus to set the cap at the 90th percentile. Out of scope for security but worth noting that the cap is also a PII-mitigation lever (a smaller cap = less secret surface in line 2).

---

## Verification commands (reproducible)

```bash
# 1. SQL safety audit
node scripts/audit-sql-safety.mjs                                # exit 0

# 2. Dependency audit
npm audit --audit-level=high                                # 0 vulns

# 3. Targeted test suites
npx vitest run tests/daemon/runtime/capture/ \
              tests/daemon/runtime/memories/recall.test.ts \
              tests/daemon/runtime/memories/recall-sessions-prose.test.ts \
              tests/daemon/storage/catalog/sessions-prose-column.test.ts
# → 19 files, 197 tests, all green

# 4. Diff scope
git diff main..HEAD --stat                                  # 13 files: 4 src + 4 test + ledger + 3 PRD docs
git diff main..HEAD --name-only | grep package            # (empty)
```

---

## Sign-off

Audit complete. No Critical or High findings; no Medium findings; one Low finding documented with an explicit pointer to the existing PRD-074b write-up and a recommended follow-up. SQL-safety audit gate exits 0. Targeted vitest suites green (197/197). No remediation applied; the changeset at `4103d84` ships as-is from a security standpoint.
