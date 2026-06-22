# Security Audit — PRD-035 (Dashboard Data Fixes) + PRD-036 (Skill/Asset Discovery)

- **Date:** 2026-06-22
- **Auditor:** `security-worker-bee` (paired Stinger: `security-stinger`)
- **Branch:** `legion/unruffled-robinson-230bc4`
- **Scope:** the PRD-035 + PRD-036 implementation diff only (dashboard data fixes + local skill/asset discovery)
- **Companion report:** the same content is filed under `library/requirements/in-work/prd-036-skill-asset-discovery/reports/2026-06-22-security-report.md` (this audit covers both PRDs).

---

## Executive Summary

**Result: CLEAN. No Critical or High findings. No code remediation required.**

The diff adds three new aggregate/union SQL builders (`buildEstimatedSavingsSql`, `buildTeamSkillCountSql`, the rewritten `fetchSkillSyncView`), a new read-only filesystem scanner (`installed-assets.ts`) with a `GET /api/diagnostics/installed-assets` endpoint, pure graph-layout math, and view-model/render changes. Every threat-checklist item was examined against the live code:

1. **SQL injection** — every new/changed query routes identifiers through `sqlIdent` and the only literals (`'skill'`, `'false'`) through `sLiteral`. No request-controlled value is interpolated into any new statement. `npm run audit:sql` is clean (195 files scanned).
2. **Path traversal / symlink escape in the scanner** — structurally closed: the scanner gates on `Dirent.isDirectory()` / `isFile()` with `withFileTypes:true`, which report `false` for symlinks, so a symlinked skill dir or agent file is silently skipped and can never be followed out of the configured roots. Roots are server-controlled (`process.cwd()`); no request input reaches the scan.
3. **Secret / credential / PII exposure** — no token, JWT, org-id, credential, or captured-trace content enters any new view-model. The skill-sync union emits only `{name, scope, syncState}`. The org is partition-scoped and redacted in logs by the storage layer.
4. **Prompt injection via frontmatter** — skill/agent descriptions are extracted by pure regex (one key, no YAML eval) and rendered as inert React text nodes (no `dangerouslySetInnerHTML`, no exec sink). Treated as data.
5. **Tenancy / fail-closed** — the new KPI fetchers run through the unchanged `resolveScopeOrLocalDefault` (header → local default → 400). The savings and team-skill aggregates carry the per-request `scope` and are org-partitioned exactly like the existing memory/session counts. The filesystem scan is intentionally tenancy-independent (local disk, not storage) and sits behind the `protect: true` diagnostics group.

**Ordering check:** No `*-qa-report.md` exists for PRD-035 or PRD-036. `security-worker-bee` ran before `quality-worker-bee` as required — no ordering inversion.

**Verification:** `npm run audit:sql` clean; `npm run ci` green (211 test files, 2312 tests passed, 7 skipped; typecheck + jscpd + vitest all pass). `git diff` confirms no audit-introduced changes — the working tree contains only the PRD-035/036 implementation.

---

## Findings by Severity

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 |

---

## Threat-Checklist Walkthrough

### 1. SQL injection into the DeepLake API — **None detected**

The new query builders in `src/daemon/runtime/dashboard/api.ts`:

- `buildEstimatedSavingsSql()` (`api.ts:227-231`): `SELECT SUM(LENGTH(${col})) AS chars FROM "${tbl}"` where `tbl = sqlIdent("memories")` and `col = sqlIdent("content")`. Both are static literals validated by `sqlIdent` (`^[a-zA-Z_][a-zA-Z0-9_]*$`, throws otherwise). No value interpolated.
- `buildTeamSkillCountSql()` (`api.ts:241-250`): identifiers via `sqlIdent(SYNCED_ASSETS_TABLE)` / `sqlIdent("honeycomb_id")` / `sqlIdent("asset_type")` / `sqlIdent("tombstone")`; the two compared values via `sLiteral("skill")` and `sLiteral(TOMBSTONE_FALSE)`. `SYNCED_ASSETS_TABLE` and `TOMBSTONE_FALSE` are static catalog constants (`"synced_assets"`, `"false"`), not request data.
- `fetchSkillSyncView()` substrate read (`api.ts:368-375`): all-identifier projection via `sqlIdent`, no interpolated value.

The only literal carrying request-derived data anywhere in the file is the pre-existing `sLiteral(scope.org)` in `fetchGraphView` (`api.ts:300`) — properly escaped and unchanged by this diff. `scripts/audit-sql-safety.mjs` passes.

**Evidence:** `src/daemon/runtime/dashboard/api.ts:227-250`, `:368-375`; guards in `src/daemon/storage/sql.ts:80-114`.

### 2. Path traversal / unsafe FS in the scanner — **None detected**

`src/daemon/runtime/dashboard/installed-assets.ts`:

- **Roots are server-controlled, not request-controlled.** The endpoint handler (`api.ts:501-503`) calls the cached `scanInstalledAssets()` with no arguments; `projectRoot` defaults to `process.cwd()` and `includeGlobal` defaults to `false`. No request body, query param, or header feeds the scan path. The threat-checklist requirement ("cannot be driven to scan an attacker-chosen path") is met — roots are injectable only in-process for tests.
- **Symlink escape is structurally impossible.** `collectSkills` gates on `entry.isDirectory()` (`installed-assets.ts:194`) and `collectAgents` on `entry.isFile()` (`:211`). With `readdir(..., {withFileTypes:true})`, a symlink reports `isDirectory()===false` and `isFile()===false` (verified empirically in this audit), so a symlinked skill dir / agent file fails the type gate and is skipped. The scanner cannot follow a link outside the tree.
- **Name sanitization.** `sanitizeName` (`:315-317`) reduces map keys / displayed names to `[A-Za-z0-9._-]`, collapsing `/`, `\`, and `..`. The raw `entry.name` used in `join()` comes from `readdir` (a real single path segment that cannot contain a separator), so the join stays within the root.
- **Fail-soft.** Any unexpected error degrades to an empty inventory (`:138-141`); ENOENT/ENOTDIR/EACCES/EPERM are treated as "contributes nothing" (`:180-184`). No 500, no path leak via error.

**Evidence:** `src/daemon/runtime/dashboard/installed-assets.ts:106-142`, `:191-220`, `:315-317`; endpoint at `src/daemon/runtime/dashboard/api.ts:498-504`.

### 3. Secret / credential / PII exposure in rendered payloads — **None detected**

- The skill-sync union (`fetchSkillSyncView`, `api.ts:363-405`) emits `SkillSyncRow { name, scope, syncState }` only — no path, no description, no token.
- The KPI view (`fetchKpisView`, `api.ts:198-218`) emits numeric counts only.
- The dashboard wire client (`src/dashboard/web/wire.ts`) does **not** consume `/api/diagnostics/installed-assets` — there is no fetcher or schema for it, so the inventory's `paths` field never reaches the rendered UI in this diff.
- No token / JWT / org-id / credential is added to any view-model. Org id is display-only in settings (unchanged) and redacted in storage logs (`redactToken(scope.org)`).

See Low-1 for the absolute-path field present in the (UI-unconsumed) inventory endpoint payload.

**Evidence:** `src/dashboard/contracts.ts:154-175`; `src/dashboard/web/wire.ts:32-47` (no installed-assets endpoint); `src/daemon/runtime/dashboard/api.ts:198-218`, `:382-404`.

### 4. Prompt-injection / untrusted content — **None detected**

`extractDescription` (`installed-assets.ts:280-307`) is pure string surgery: a frontmatter regex pulls the single `description:` key (or first `#` heading); no YAML parser, no tag evaluation. The result is rendered through React text interpolation everywhere it surfaces (`{s.name}`, `<text>{n.label}</text>`, etc. in `panels.tsx`) — React escapes by default, and there is no `dangerouslySetInnerHTML` / `eval` / `new Function` in any touched file. A poisoned `SKILL.md` description is treated strictly as inert data.

**Evidence:** `src/daemon/runtime/dashboard/installed-assets.ts:280-307`; `src/dashboard/web/panels.tsx` (all interpolation is JSX text); grep for render/exec sinks returned no real matches.

### 5. Tenancy / fail-closed — **None detected**

- The KPI and skill-sync handlers resolve scope via `resolveScopeOrLocalDefault` (`api.ts:424-425`) and 400 when no org resolves (`:433`, `:487`). Unchanged precedence: header always wins; local-default fallback fires only in local mode; the cross-tenant guard in `scope.ts:54-62` (a forged `x-honeycomb-org` that disagrees with the validated token org → `null` → deny) is untouched.
- The new aggregates pass `scope` to `selectRows` → `storage.query(sql, scope)`, which stamps `org: scope.org` on the request (`client.ts:432`). The savings and team-skill counts are therefore org-partitioned identically to the existing memory/session counts. Local-only disk skills cannot inflate the team-skill KPI (it counts only non-tombstone `synced_assets` rows).
- The installed-assets scan is intentionally tenancy-independent (a local filesystem walk, not a storage read) and is served behind the `protect: true` diagnostics group (`server.ts:94`), so it still requires authentication/RBAC even though it needs no org header. This is documented and intentional; for a local-mode loopback dashboard it does not cross a tenant boundary.

**Evidence:** `src/daemon/runtime/scope.ts:54-91`; `src/daemon/runtime/dashboard/api.ts:424-490`; `src/daemon/storage/client.ts:381-438`; `src/daemon/runtime/server.ts:94`.

---

## Low Findings (documented, not fixed)

### Low-1 — Absolute on-disk paths in the (UI-unconsumed) installed-assets endpoint payload

`GET /api/diagnostics/installed-assets` returns `LocalAssetInventory`, whose `DiscoveredAsset.paths` carries absolute on-disk paths rooted at `process.cwd()` (e.g. `C:\Users\<user>\...\.claude\skills\<name>\SKILL.md`). On a developer machine this discloses the OS username to any caller that can reach the endpoint.

**Why Low, not High:** (a) the endpoint sits behind the authenticated/RBAC `protect: true` diagnostics group — not anonymously reachable; (b) the dashboard is a local-mode loopback thin client; (c) the field is not a credential and not captured-trace content (the never-downgrade rule does not apply); (d) the current dashboard wire client does not consume this endpoint, so the paths are not rendered anywhere in this diff. This is path/username-disclosure hygiene, not a tenant or credential exposure.

**Recommendation (for the record, optional):** when PRD-036b/PRD-042 begin consuming this endpoint in the UI, prefer to expose repo-relative paths (or omit `paths` from the served payload and keep it in-process for the union) so the served inventory carries no absolute home path. Re-audit when that wiring lands.

**Evidence:** `src/dashboard/contracts.ts:309-311` (`paths` field); `src/daemon/runtime/dashboard/api.ts:498-504`, `:516-525` (endpoint returns the full inventory).

---

## Categories Checked — Quick Index

| Category | Result |
|---|---|
| SQL injection (new aggregates + union) | None detected |
| `sqlIdent` on config/table identifiers | All present |
| Request-controlled value in SQL | None |
| Path traversal (scanner) | None — roots server-controlled |
| Symlink escape (scanner) | None — type-gate skips symlinks |
| Asset-name sanitization | Present (`sanitizeName`) |
| Token / JWT / org-id in payloads | None |
| Credential exposure | None |
| Captured-trace PII in view-models | None |
| Prompt injection via frontmatter | None — data-only, regex extraction |
| XSS / `dangerouslySetInnerHTML` / exec | None |
| Tenancy / org partitioning of new reads | Preserved |
| Fail-closed on missing org | Preserved (400) |
| Endpoint auth (diagnostics group) | `protect: true` inherited |
| Absolute path disclosure | Low-1 (documented) |

---

## Verification Artifacts

| Check | Result |
|---|---|
| `npm run audit:sql` | OK — every SQL interpolation routes through an escaping helper (195 files) |
| `npm run ci` (tsc + jscpd + vitest) | Green — 211 test files, 2312 passed, 7 skipped |
| `git diff` after audit | Only PRD-035/036 implementation changes; no audit-introduced edits |
| `.cursor/rules` Unicode scan | Clean — no zero-width / bidi Unicode |
| `npm audit` (high+) | Only pre-existing low/moderate advisories; none introduced by this diff (out of scope) |

---

## Remediations Applied

**None.** No Critical or High finding was identified; the single Low finding is documented for the record per the severity rubric (Low = document only). The implementation diff ships unmodified by this audit.

## Items Left for the Record

- **Low-1** (absolute paths in the installed-assets endpoint payload) — documented above with an optional recommendation to revisit when PRD-036b/042 wire the endpoint into the UI.

## Recommendation

Proceed to `quality-worker-bee`. No security blockers.
