# Security Audit Report: PRD-033 asset-sync-substrate (REOPEN / second the-smoker run)

**Audit date:** 2026-06-25
**Auditor:** security-worker-bee subagent
**Branch:** legion/cranky-sinoussi-0bd999
**Scope (reopen surface, audited fresh):** `src/hooks/shared/{contracts.ts, session-start-seams.ts, session-start.ts}`, `src/daemon-client/assets/install.ts`, `src/daemon-client/skillify/{manifest.ts, index.ts, migrate-manifest.ts}`, `src/daemon/runtime/assets/{registry.ts, index.ts}`; daemon-side `src/daemon/runtime/assets/{api.ts, sync.ts, contracts.ts, device.ts}` reviewed to confirm the F-1 scope guard still governs the new session-start pull.
**Node version audited:** >=22.5.0
**`npm audit` result:** clean (0 vulnerabilities at --audit-level=high)
**OpenClaw bundle scan:** clean (`npm run audit:openclaw` - no findings)
**SQL safety scan:** clean (`npm run audit:sql` - 229 files, every interpolation routes through an escaping helper)
**CVE watchlist last refreshed:** 2026-04-24 (62 days old - within the 120-day window, no escalation)

---

## Executive Summary

The three reopen deltas (R-1 session-start asset auto-pull, R-2 filesystem-SoT registry migration, R-3 non-destructive retract) introduce **zero Critical and zero High findings**. The headline concern - the new UNATTENDED, every-session-start write path (R-1) - is properly jailed: every disk write passes the use-time `resolveContainedDir`/`isSafeSegment` containment guard, the client-supplied tenancy scope is only a hint (the daemon-side F-1 `resolveScope` remains Identity-authoritative and fail-closes a body-org/author that disagrees with the validated token), and a teammate's auto-installed Team skill/agent is squarely within the PRD's sanctioned file-drop threat model (rules/commands - the prompt-injection-bearing types - remain deferred for explicit accept-on-pull). No credential, JWT, org-id, or captured-trace PII is logged, persisted, or transmitted by any changed file.

Two findings are recorded for documentation only: **R-1(b)** the verbatim-blob install runs with no content-hash verification (Low - re-affirms the prior S-1 v2 deferral; with rationale below it is NOT a High because the co-located unsigned hash cannot defend against the only actor that could tamper - a compromised daemon - and the loopback transport is local), and **a Low thin-client hygiene finding**: the asset `contracts.ts` value-import of `SYNCED_ASSET_TYPES` transitively drags `src/daemon/storage/catalog/synced-assets.js` (inert schema constants + the pure `sql.js` helpers) into the hooks bundle. The DeepLake **client** itself (connection/credential/transport) does NOT leak - the D-6 invariant's security purpose holds - but the static invariant test does not follow transitive re-exports, so the catalog constants ride along. No remediation was required in-session; no source files were edited by this audit.

This audit ran on the uncommitted reopen working tree. A prior QA report (`qa/2026-06-21-qa-report.md`) exists from the FIRST run and PREDATES these reopen changes; per the ordering rule, `quality-worker-bee` must be re-run against the reopen surface after this audit lands.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 |
| Authentication & Org RBAC / Scope | OK | 0 (F-1 guard re-verified intact) |
| Injection (Deep Lake SQL API) | OK | 0 (`audit:sql` clean) |
| Dependency & OpenClaw Bundle | OK | 0 |
| Configuration (path jail, kill-switch, fail-soft) | OK | 0 |
| Pre-Tool-Use Gate & Prompt Injection | ATTN | 1 Low (R-1b unverified-blob, accepted/deferred) + 1 Low (thin-client bundle hygiene) |

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

- [ ] **Unverified-blob install (R-1b) - accepted/deferred risk** `src/daemon-client/assets/install.ts:322` (`writeArtifact`) - The pulled `native` blob is written to the harness root VERBATIM, and `asset.contentHash` is recorded into the `.honeycomb-asset.json` marker, with **no recompute-and-compare of sha256 over the received bytes**. `src/daemon/runtime/assets/hashing.ts` provides a `sha256` primitive but it is daemon-side and not invoked by the thin client on install.
  - **Why this is Low, not High (the requested re-evaluation now that install runs unattended on every session start):** The `content_hash` is stored in the SAME `synced_assets` row as the blob, by the same authenticated publisher, and is unsigned. Verifying the received blob against the received hash therefore catches only **loopback (127.0.0.1) transport corruption between daemon and client** - it cannot defend against the threats that matter here: (a) a malicious/compromised daemon can rewrite the blob AND the co-located hash in lockstep (and a compromised daemon already has full local file-write authority - it holds the credential), and (b) a poisoned Team artifact is an authorization question (governed by `audienceMatches` + the F-1 `resolveScope`, both intact), not an integrity-hash question. The change to "unattended every session start" does not change the trust boundary (the daemon was always the writer-of-record; auto-pull on session start is the PRD-018 model the asset variant is wired onto). No credential or captured-trace PII is involved, so the never-downgrade rule does not force a Critical/High classification. This re-affirms the prior run's S-1 v2 deferral.
  - **Recommended follow-up (v2, before any executable/accept-on-pull asset type ships):** recompute sha256 over the received `native` on install and skip the write on a mismatch (a cheap, pure `node:crypto` defense against transport/storage corruption), and pursue publisher signing as the real integrity control once rules/commands/hooks (the prompt-injection-bearing types the PRD already gates behind explicit accept-on-pull) are added.

- [ ] **Thin-client bundle hygiene: catalog constants leak into the hooks bundle** `src/daemon/runtime/assets/contracts.ts:29,33` (value re-export of `SYNCED_ASSET_TYPES` from `../../storage/catalog/synced-assets.js`) - `src/hooks/shared/session-start-seams.ts` -> `daemon-client/assets/index.ts` -> `daemon-client/assets/contracts.ts` -> `daemon/runtime/assets/contracts.ts` transitively pulls `src/daemon/storage/catalog/synced-assets.js`, `catalog/types.js`, `storage/schema.js`, and `storage/sql.js` into the built harness hook bundles (confirmed present in `harnesses/claude-code/bundle/session-start.js`: `SYNCED_ASSETS_TABLE`, `storage/catalog/...`).
  - **Why this is Low, not a D-6 breach:** the DeepLake **client** (the connection/credential/transport - `createDeeplakeClient`, `appendVersionBumped`, `readConverged`, `USING deeplake`) is **absent** from the bundle (verified count 0). What leaked is inert schema **constants** (the `ColumnDef` table definition + the asset-type enum), the pure `sql.js` escaping helpers (explicitly exempted by the invariant as safe), and pure schema validators. None open DeepLake, hold a credential, or dial Activeloop - so the invariant's actual security purpose ("no non-daemon code OPENS DeepLake") is NOT violated. The static invariant test (`tests/daemon/storage/invariant.test.ts`) passes because it text-matches direct import specifiers and does not follow transitive re-exports.
  - **Recommended follow-up (code hygiene, out of security scope - flagged as a background task):** move `SYNCED_ASSET_TYPES`/`SyncedAssetType` to a pure shared module (or have the thin-client `contracts.ts` define the enum by value, mirroring how `manifest.ts` already mirrors the registry-row shape), so the catalog stops riding into the hooks bundle; and harden the invariant test to follow transitive re-exports (e.g. scan built bundles for `storage/catalog`/client symbols, the same way `audit:openclaw` gates `process.env`).

---

## Per-delta audit results

### R-1 - session-start asset auto-pull (the new unattended write path)

- **(a) Write-outside-root / path jail.** PASS. Every write resolves through `resolveContainedDir(root, honeycombId)` (`install.ts:416`), which requires the id to be a single safe segment (`isSafeSegment`, `install.ts:432` - rejects separators, NUL, `.`/`..`, `..`-runs, anything outside `[A-Za-z0-9._-]`) AND the resolved candidate to be a DIRECT child of the resolved root. The id arrives off the loopback wire and is treated as UNTRUSTED and re-validated at use time. A malicious daemon-returned `honeycombId` (`../../etc`, absolute, separators) yields `null` -> the asset is skipped, never written. The new session-start entry path (`session-start-seams.ts:autoPullAssets` -> `buildAssetAutoPullDeps` -> thin-client `autoPull` -> `pullAndInstall`) flows through the SAME guard; it adds no second write path that bypasses it. The `.bak` (`backupExisting`) and retraction (`retract`) are siblings inside the contained `dir` and never escape. Confirmed by `tests/property/path-sanitization.property.test.ts` (4 passing) + `tests/daemon-client/assets/install.test.ts` (22 passing).
- **(b) Unverified native blob.** Recorded as a Low / accepted-deferred finding (see Low Findings).
- **(c) Cross-tenant.** PASS. The daemon-side F-1 guard is intact and authoritative: `resolveScope` (`api.ts:194`) in team/hybrid mode OVERRIDES the body-supplied org/workspace/author with the validated `Identity` (`identity.org`/`workspace`/`agentId`) and fail-closes (400) a body org that disagrees with the token. The Device-tier audience predicate (`contracts.ts:300`) is `asset.author === ctx.author && asset.deviceSet.includes(ctx.deviceId)`, where `ctx.author` is the authenticated `identity.agentId` - so a victim cannot pull another user's Device-tier artifact even if the session-start client sends a forged/over-broad author. The session-start scope construction (`buildAssetScope`, `session-start-seams.ts:199`) is only a hint; it sends NO privileged/over-broad scope (it falls back to `local`/`default`/device.label sentinels, all clamped by the daemon).
- **(d) Prompt-injection / arbitrary content.** PASS (within sanctioned threat model). v1 syncs ONLY `skill` and `agent` types (`api.ts:pickAssetType`), which the PRD index (line 35) explicitly treats as file-drops; rules and commands "carry prompt-injection risk and will need explicit accept-on-pull when added" and are deliberately NOT in v1. R-1 did not widen the asset-type set or add an executable type - it wired the existing skill/agent auto-pull onto the session-start seam (the PRD-018 auto-pull model). Blast radius is unchanged from what the PRD sanctioned.
- **(e) Thin-client invariant.** PASS on the security property (no DeepLake CLIENT leak), with a Low hygiene caveat (catalog constants leak - see Low Findings). `device.ts` (the deep-imported leaf) imports only node builtins; the assets/skillify barrels export only filesystem-only modules.

### R-2 - filesystem SoT migration (registry.json)

- **(a) Path safety of every FS op.** PASS. `manifest.ts` writes confined to `<baseDir>/registry.json` via atomic temp+rename (`writeAllRows`, `manifest.ts:96`); `migrate-manifest.ts` only reads candidate legacy paths and renames the found one to `*.migrated` (`breadcrumb`, `migrate-manifest.ts:103`). No untrusted manifest field (`installRoot`/`symlinks`/`dirName`) drives an FS path in these modules - they only marshal row data.
- **(b) Malicious/garbled registry row driving unpull/backfill outside managed roots.** PASS. The destructive ops live in `daemon-client/skillify/install.ts` and were not changed by R-2, but they consume the now-registry-backed rows. `unpullSkill` (`install.ts:365`) re-validates `installRoot`+`dirName` through `resolveContainedCanonicalDir` (`install.ts:639`) at use time before any `rmSync` - an unsafe record refuses the delete and drops the poisoned entry. Symlink removal (`unlinkIfOurs`, `install.ts:586`) only unlinks a path that is a true symlink resolving to OUR canonical dir (no follow-out delete of a real directory). `backfillSymlinks` (`install.ts:309`) passes through the same containment guard. A garbled row round-tripped through the registry cannot drive a delete/unlink outside the managed roots.
- **(c) Idempotent / never loses a registered-asset row.** PASS. The fold is keyed by `honeycombId` with registry-rows-win (`migrate-manifest.ts:77` - only legacy ids not already present are added; never clobbers); the legacy file is breadcrumbed to `*.migrated` so the fold never re-runs (and a re-fold is a no-op once rows are present). Registered-asset rows (no `pulledManifest` block) are preserved verbatim and never returned by the manifest surface (`rowToEntry` returns `null` for them). Confirmed by `tests/daemon-client/skillify/migrate-manifest.test.ts` (8 passing).
- **(d) No `daemon/storage` import from `daemon-client`.** PASS for the CLIENT (the shape is agreed BY VALUE in `manifest.ts`, which deliberately does NOT import `daemon/runtime/assets/registry.ts`). The daemon-side `registry.ts` zod schema (`PulledManifestSchema`) is additive + optional; pre-R-2 entries stay valid. (The transitive catalog-constant leak in the Low hygiene finding is a separate, pre-existing path via the asset contracts, not introduced by `manifest.ts`/`migrate-manifest.ts`.)

### R-3 - retraction now leaves files in place

- PASS, no new issue. `retract` (`install.ts:367`) now removes ONLY the contained `.honeycomb-asset.json` marker (inside the already-jailed `dir`), never the live file - strictly less destructive. The raised concern (an unmanaged-but-present file silently re-adopted/overwritten, losing user edits without a `.bak`) does NOT materialize: after retract the marker is gone, so `readLocalMarker` returns `null` (`localVersion=null`); a subsequent re-publish hits `decideInstall` with `localExists=true, localVersion=null` -> `remoteNewer=true`, `hashDivergent` true (localHash null) -> returns `"backup-write"`, which calls `backupExisting` (`.bak`) BEFORE the overwrite. User edits are preserved to `.bak`.

### Cross-cutting checks (catalog sweep on the changed files)

- **Token/credential exposure:** NONE. No changed file logs, persists, or transmits a token. `HookCredential.token` ("Never logged") is never read by the session-start asset path - `buildAssetScope`/`tenancyHeaders` read only `org`/`workspace`/`actor`; the loopback client sends only `x-honeycomb-org/workspace/actor` (no `Authorization`). No `console.*`/`logger.*` in any changed file.
- **Captured-trace PII:** NONE. The reopen surface moves artifact blobs (skills/agents) and local bookkeeping; it touches no `sessions`/`memory` row.
- **SQL injection:** NONE. `buildPullSql` (`sync.ts:288`) routes the table through `sqlIdent` and the only value (`style`) through `sLiteral`; writes go through `appendVersionBumped`. `audit:sql` clean.
- **Prototype pollution:** NONE. Registry/manifest rows are merged as ARRAY elements (`[...existing, ...additions]`), read field-by-field by name, never spread into a prototype-bearing object via `Object.assign`/`{...row}` with attacker keys. All `JSON.parse` sites are try/catch-wrapped and coerce defensively.
- **ReDoS:** NONE. `isSafeSegment`/`isSafeDirSegment` regexes are linear, no catastrophic backtracking.

---

## Dependency Audit

```text
npm audit --audit-level=high  ->  found 0 vulnerabilities
```

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **Install path jail** (`resolveContainedDir`/`isSafeSegment`) | untrusted id re-validated at use time; direct-child-of-root only | confirmed `install.ts:416,432`; off-wire id rejected -> skip | OK |
| **F-1 cross-tenant guard** (`resolveScope`) | team/hybrid overrides body org/workspace/author with validated Identity; disagreeing org -> 400 | confirmed `api.ts:194-224`; intact, governs the new session-start pull | OK |
| **Device-tier audience** (`audienceMatches`) | keyed on authenticated author + device set | confirmed `contracts.ts:300`; author = `identity.agentId` | OK |
| **unpull / backfill removal jail** (`resolveContainedCanonicalDir`) | use-time re-validation before `rmSync`; symlink-only unlink resolving to our dir | confirmed `install.ts:365,586,639`; unchanged + governs registry-backed rows | OK |
| **SQL guards** | `sqlIdent` + `sLiteral` on every fragment | `audit:sql` clean (229 files) | OK |
| **OpenClaw bundle scan** | clean | `audit:openclaw` clean (1 file) | OK |
| **No token in logs / scope / headers** | token never read by the session-start asset path | confirmed; only org/workspace/actor stamped | OK |
| **Thin-client D-6 (DeepLake CLIENT not in hooks bundle)** | no connection/credential/transport in bundle | client symbols count 0; catalog CONSTANTS present (Low hygiene finding) | OK (with Low caveat) |

---

## Files Changed (remediation)

None. This audit found no Critical or High finding, so no source file was edited. The two Low findings are documentation-only (R-1b) and a hygiene follow-up flagged as a background task. `git diff` confirms the working tree contains only the-smoker's reopen implementation (and build-regenerated `harnesses/*/bundle` artifacts from the gate `npm run build`); no `.env`, `~/.deeplake/credentials.json`, other-PRD ledgers, or harness config dirs were touched by this audit.

---

## Gate Results (run from repo root after the audit)

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS (tsc --noEmit, no errors) |
| `npx vitest run` (full suite) | 3264 passed, 7 skipped, 2 FAILED |
| ...the 2 failures | `tests/daemon/runtime/secrets/exec.test.ts` (b-AC-5 runaway-kill partial-output) - **pre-existing timing flakes, unrelated to PRD-033** (untouched by this branch; PASS 16/16 in isolation). NOT a regression from the reopen. |
| Reopen-surface targeted tests | PASS 67/67 (install 22, session-start-seams 10, session-start 16, migrate-manifest 8, sync 7, path-sanitization 4) |
| Thin-client invariant test (`tests/daemon/storage/invariant.test.ts`) | PASS 3/3 |
| `npm run build` | PASS (1 daemon + 1 dashboard-web + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon @ 0.1.0) |
| `npm run audit:sql` | PASS (clean - 229 files) |
| `npm run audit:openclaw` | PASS (clean - 1 file) |

---

## Recommended Follow-Up (architectural / out of this session's scope)

1. **Content-hash verification on install (v2 prerequisite for executable/accept-on-pull asset types).** Recompute sha256 over the received `native` blob in `writeArtifact` and skip the write on mismatch; pursue publisher signing as the real integrity authority before rules/commands/hooks (the prompt-injection-bearing, explicitly-deferred types) are added. (R-1b - accepted-deferred this run.)
2. **Stop the catalog constants riding into the hooks bundle.** Relocate `SYNCED_ASSET_TYPES`/`SyncedAssetType` to a pure shared module (or define by value in the thin-client `contracts.ts`), and harden `tests/daemon/storage/invariant.test.ts` to follow transitive re-exports / scan built bundles for `storage/catalog` symbols. (Low hygiene - flagged as a background task to the typescript-node surface.)
3. **Ordering note.** Re-run `quality-worker-bee` against the reopen surface - the existing `qa/2026-06-21-qa-report.md` predates these reopen changes and is stale.
