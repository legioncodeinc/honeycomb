# Security Audit — PRD-042 Sync Page (write surface)

- **Date:** 2026-06-22
- **Auditor:** security-worker-bee
- **Scope:** the PRD-042 sync-page diff (working tree, uncommitted) — the daemon-side write surface for skills + agents.
- **Files in scope:**
  - NEW `src/daemon/runtime/dashboard/asset-install-target.ts` (skill-dir / agent-file install target)
  - NEW `src/daemon/runtime/dashboard/sync-api.ts` (`fetchAssetSyncView` + `createSyncActionApi`)
  - NEW `src/daemon/runtime/dashboard/sync-mount.ts` (`mountSyncApi`)
  - MOD `src/daemon/runtime/assemble.ts`, `src/dashboard/web/wire.ts`, `src/dashboard/web/pages/sync.tsx`, `src/dashboard/web/panels.tsx`
  - Tests + the gated live itest
- **Ordering:** Run BEFORE `quality-worker-bee`. No QA report exists for PRD-042 (`reports/` did not exist until this audit created it). Ordering is correct — no inversion.

## Executive summary

Audited the PRD-042 write surface against the six-point threat checklist (path traversal, SQL injection, secret/blob/PII leakage, tenancy + write-authz, append-only/no-destructive-UPDATE, XSS). Found and **remediated in-session 1 Critical and 1 High**, plus 1 Low hardening. The cross-tenant guard, append-only write discipline, secret-omission, and XSS posture were all verified clean.

The headline fix is a **Critical path-traversal**: the asset-name sanitizer mirrored `skillify/install-target.ts` and shared its latent bug — a pure-dot name (`.`, `..`) survived the character-class replace unchanged and, left as a live path component, escaped the `.claude/{skills,agents}/` root. On a skill `disable`/`demote` it would `rmSync` the parent `.claude/` directory recursively. Because the name here originates from substrate/request data (unlike the trusted-miner source in skillify), this was reachable from the page's action surface.

The second fix is a **High broken-function-level-authorization**: the page disables the Demote control for non-authors (`authoredByMe`), but the daemon `/api/diagnostics/sync/demote` endpoint did **not** independently enforce author-only — a crafted POST could let any workspace member tombstone (retract for the whole Team) an artifact they did not author. The disabled UI is not a security control; the daemon now enforces author-only fail-closed.

No reduced-coverage flag — the entire diff is inside the Stinger's target stack.

## Findings by severity

| Severity | Count |
|---|---|
| Critical | 1 (fixed) |
| High | 1 (fixed) |
| Medium | 0 |
| Low | 1 (fixed, <5 lines) |
| **Total** | **3** |

---

### CRITICAL-1 — Path traversal via pure-dot asset name → escapes `.claude/` root; recursive delete of parent dir on remove

- **Category:** OWASP A01 (Broken Access Control) / A05 path traversal; Stinger vibe-coding pattern "string-gate path bypass".
- **Location:** `src/daemon/runtime/dashboard/asset-install-target.ts:140` (`sanitizeSegment`), reached via `pathFor` → `write`/`remove`/`read`/`exists`, driven by `createSyncActionApi.pull`/`enable`/`disable` in `sync-api.ts` from a request/substrate-supplied `name`.
- **Vulnerable code (before):**
  ```ts
  export function sanitizeSegment(name: string): string {
      const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
      return cleaned === "" ? "untitled-asset" : cleaned;
  }
  ```
- **Why it is exploitable:** `.` and `-` are in the allow-list, so an all-dots name passes through the replace UNCHANGED. The result is then a live path component:
  - `name = ".."`, skill → `join(root, ".claude/skills", "..", "SKILL.md")` normalizes to `<root>/.claude/SKILL.md` — **writes outside the `skills/` root**.
  - `remove("skill", install, "..")` → `rmSync(join(root, ".claude/skills", ".."), { recursive: true, force: true })` resolves to `<root>/.claude/` and **recursively deletes the entire `.claude` directory** (all skills, all agents, settings).
  - `name = "."` writes/reaps the skills root's own area.
  - Verified empirically: `join("…/.claude/skills", "..", "SKILL.md") === "…/.claude/SKILL.md"`.
- **Reachability:** `pull`/`enable`/`disable` pass `req.name` (the page-supplied union-row name, ultimately substrate/discovery-influenceable) straight into the install target. The page sends `name` from the union view-model; a poisoned `synced_assets` row or a crafted POST supplies `..`.
- **Remediation (applied):** reject the empty result AND any all-dots segment (`^\.+$`), collapsing it to the inert `untitled-asset` fallback so a `.`/`..` is never left as a path component. A leading dot on a longer name (`.foo`) is harmless and preserved.
  ```ts
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "untitled-asset";
  return cleaned;
  ```
  JSDoc on the module + function updated to state the dot-rejection guarantee honestly.
- **Regression test:** `tests/daemon/runtime/dashboard/sync-api.test.ts` — `it.each(["..","..","." ,"..."])` proves the write stays strictly under `.claude/{agents,skills}/` and that `remove` does not climb out and reap a sentinel file in the parent `.claude/`.
- **Follow-up (out of scope, flagged):** `src/daemon/runtime/skillify/install-target.ts:74` has the **same latent dot-segment bug** in its `sanitizeSegment`. Its `name` comes from the trusted miner today (not directly attacker-controlled), so it is not currently reachable as a vuln, but it should be hardened identically for defense-in-depth. Recommend a small follow-up task. *(Flagged as a background task.)*

---

### HIGH-1 — Demote authorization enforced only in the UI; daemon endpoint lets a non-author tombstone a Team asset

- **Category:** OWASP A01 Broken Access Control (client-side-only / missing function-level authorization).
- **Location:** `src/daemon/runtime/dashboard/sync-api.ts` `createSyncActionApi.demote` (before fix it called `engine.tombstone` with no authorship check); endpoint `POST /api/diagnostics/sync/demote` in `sync-mount.ts`.
- **Why it is a finding:** PRD-042 OQ-4 / a-OQ-3 resolve the demote-permission question by **disabling the control when not permitted** — the page sets `disabled={!row.authoredByMe}` (`sync.tsx:137`). But the substrate `tombstone` engine is Team-radius by construction (keyed by `org`+`workspace`, audience = any author in the workspace) and performs **no author check**. The new `/sync/demote` endpoint therefore exposed a write path where the *only* guard was the disabled button. A crafted POST (or any non-author workspace member) could tombstone — i.e. retract for the entire Team — an artifact authored by someone else. Threat-checklist #4 explicitly requires the daemon to enforce, not trust the disabled UI.
- **Remediation (applied):** added daemon-side author-only enforcement in `demote`. Before writing the tombstone, read the CURRENT (highest-version) `synced_assets` row poll-guarded via the existing `buildCurrentAssetVersionSql` and confirm its `author` equals the caller's resolved author (`req.scope.author`, which in team/hybrid is the validated Identity's `agentId`, never a body claim). Fail-CLOSED: a missing row, empty author on either side, or non-author → `{ ok: false }` and **no tombstone is written**.
  ```ts
  if (!(await authoredByCaller(storage, scopeOf(req.scope), honeycombId, req.scope.author))) {
      return { ok: false, action: "demote", assetType: req.assetType, honeycombId, state: "", version: 0 };
  }
  ```
  New `authoredByCaller` helper reuses the guarded SQL (`sqlIdent`/`sLiteral`) — no new SQL surface.
- **Regression tests:** `sync-api.test.ts` — "demote is refused (no tombstone written) when the caller is not the author" (bob publishes, alice demote → `ok:false`, zero new INSERTs, row stays live) and "demote still succeeds for the asset's own author" (gate is author-only, not deny-all).
- **Note:** the cross-tenant half of threat #4 was already correct — `resolveActionScope` (`sync-mount.ts`) takes tenancy from the validated Identity in team/hybrid and rejects a body org that disagrees (fail-closed 400), mirroring `mountAssetsApi.resolveScope`. Verified, not changed.

---

### LOW-1 — `buildSyncedAssetsSql` interpolates the table name without `sqlIdent` (consistency/regression hardening)

- **Category:** defensive SQL hygiene (Stinger vibe pattern "missing `sqlIdent` on config table names").
- **Location:** `src/daemon/runtime/dashboard/sync-api.ts` `buildSyncedAssetsSql`.
- **Assessment:** NOT currently exploitable — `SYNCED_ASSETS_TABLE` is a compile-time constant, and `audit:sql` already passes (the constant matches the gate's SCREAMING_SNAKE prebuilt allow-rule). But every sibling builder (`buildCurrentAssetVersionSql`, `buildPullSql`) routes the table through `sqlIdent`; this one was the lone exception. Aligning it removes a future regression footgun if the table name ever becomes config-driven.
- **Remediation (applied, <5 lines):** route the identifier through `sqlIdent` like the sanctioned pattern.
  ```ts
  const tbl = sqlIdent(SYNCED_ASSETS_TABLE);
  return `SELECT * FROM "${tbl}"`;
  ```

---

## Categories checked — clean (no finding)

- **SQL injection (threat #2):** All identifiers via `sqlIdent`, all values via `sLiteral`/`val.str`/`val.text`. `assetType` validated to the closed enum `'skill'|'agent'` via `pickAssetType` against `SYNCED_ASSET_TYPES` before any use; `name`/`honeycombId` reach SQL only as `sLiteral` values inside `buildCurrentAssetVersionSql`. The union read is a static `SELECT *` (now `sqlIdent`-guarded). `npm run audit:sql` clean (203 files).
- **Secret / `native` blob / author / org leakage (threat #3):** The `AssetSyncRow` view-model and `SyncActionResult` carry NO `native` blob, author email/token, or org GUID — `author` is consumed only to derive the `authoredByMe` boolean and is never emitted. `sync.tsx` detail view renders only name/description/state/provenance/scope/harness/tier/style/version. Existing tests assert the served JSON contains no `SECRET-NATIVE`, no `@`-email, no org. Verified.
- **Tenancy / cross-tenant write (threat #4, first half):** `resolveActionScope` takes org/workspace/author from the validated Identity in team/hybrid and fail-closes (400) on a body org mismatch; local mode falls back to `defaultScope`. Scope is never asserted from the request body. Verified clean.
- **Append-only / no destructive UPDATE (threat #5):** promote → `engine.publish` (version-bumped INSERT); demote → `engine.tombstone` (`tombstone='true'` version-bump). No `UPDATE`/`DELETE` path. Test asserts no `DELETE` statement and that prior versions survive. Verified.
- **XSS (threat #6):** `sync.tsx` renders all asset names/descriptions as inert React text children — no `dangerouslySetInnerHTML` anywhere in the page. The activity feed reuses `/api/logs` (method+path+status, no secret) via `formatLogLine`. Verified clean.
- **Prompt injection / pre-tool-use gate / credential file modes / OpenClaw bundle:** not touched by this diff. `npm run audit:openclaw` clean.

## Gate results

| Gate | Result |
|---|---|
| `npm run audit:sql` | **PASS** — 203 files, every interpolation routes through a helper |
| `npm run audit:openclaw` | **PASS** — bundle clean against ClawHub rules |
| `npm run ci` (typecheck + jscpd dup + vitest + audit:sql) | **PASS** — 229 files, 2493 passed, 6 skipped, 0 failed |
| `npm run build` (tsc + esbuild) | **PASS** — all 15 bundles built @ 0.1.0 |
| sync regression suites | **PASS** — `sync-api` 20, `sync-mount` 5, `sync-page` 9 |

The pre-existing `sources/api.test.ts` load-flake did not manifest in this full-suite run; no failures of any kind.

## Files changed (this audit)

| File | Change |
|---|---|
| `src/daemon/runtime/dashboard/asset-install-target.ts` | CRITICAL-1: reject all-dots/empty segment in `sanitizeSegment`; honest JSDoc |
| `src/daemon/runtime/dashboard/sync-api.ts` | HIGH-1: author-only `demote` gate (`authoredByCaller`); LOW-1: `sqlIdent` on union read; `sqlIdent` import |
| `tests/daemon/runtime/dashboard/sync-api.test.ts` | regression tests for pure-dot traversal, non-author demote refusal, author demote success |

No unrelated files staged or deleted; `git status --short` matches the pre-audit snapshot. Nothing under `src/daemon/runtime/assets/` or `assets/` was touched.

## Recommended follow-up

1. **Harden `src/daemon/runtime/skillify/install-target.ts:74`** with the identical all-dots rejection — same latent bug, currently fed by the trusted miner (not exploitable today) but worth closing for defense-in-depth.
