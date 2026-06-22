# EXECUTION LEDGER — /the-smoker (dashboard pages 038–044)

**Scope:** build the 7 routed pages on top of the merged PRD-037 nav-shell. **Started:** 2026-06-22 · **Base:** `main` (b09fa5f, 037 merged via #70).
**Authorized:** orchestrator merges every PR (squash + delete branch) once VERIFIED + CI-green — no user gate.
**Status:** OPEN · IN PROGRESS · DONE · VERIFIED · BLOCKED

## Strategy

Each page = its own `pages/<name>.tsx` + its own daemon endpoint(s) + ONE registry entry (replacing its `ComingSoon` placeholder) + additive `contracts.ts`/`wire.ts`. The shared files (`registry.tsx`, `api.ts`, `contracts.ts`, `wire.ts`) are additive-edit contention points → **sequential, merge-each-before-next** keeps every page off the latest main (zero conflicts), and the merge-authorization makes it fully autonomous. Each page is ONE coherent bee (its sub-PRDs are mutually referential).

## Sequence (dependency-ordered)

```
037 (merged #70) ──► 039 (harness telemetry backbone) ──► 038 (home; consumes 039a)
                                                       └─► 040, 041, 042, 043, 044 (independent pages, any order)
```
- 041 ← already-shipped 035c GraphCanvas + 014 graph-build · 042 ← already-shipped 036 discovery · 043 adds SQLite.
- Lifecycle: 037 moved in-work→completed (folded into the 039 branch).

All bees: `typescript-node-worker-bee` / **opus** (dashboard React + daemon endpoints; DS-token fidelity; production-clean bundle). Close-out: `security-worker-bee` → `quality-worker-bee` per page.

## Page status

| PRD | Page | ACs | Status |
|---|---|---|---|
| 039 | Harnesses (telemetry + overview + detail) | 23 (8+5+5+5) | ✅ VERIFIED · merged #72 |
| 038 | Dashboard home (KPI areas + recall + harness strip) | 23 (8+5+5+5) | ✅ VERIFIED — shipping |
| 040 | Memories (add/edit/compact/dream/watch/search) | 21 (5+5+6+5) | ✅ VERIFIED — shipping |
| 041 | Graph (full codebase graph + memory-graph foundation) | 17 (4+7+6) | ✅ VERIFIED — shipping |
| 042 | Sync (skills + agents view/promote/control) | 24 (8+8a+7b+6c) | ✅ VERIFIED — shipping |
| 043 | Logs (SQLite persistence + history + turns) | 25 (6+7a+6b+6c) | ✅ VERIFIED — shipping |
| 044 | Settings (DeepLake auth + API keys + search mode) | tbd | OPEN |

## PRD-039 ledger (23 ACs)

| ID | Criterion | Status |
|---|---|---|
| 039a-AC1..5 | endpoint returns 6 always / real activity (COUNT+MAX over sessions.agent) / installed from wiring / one backbone / guarded+fail-soft+secure | OPEN |
| 039b-AC1..5 | 6 KPI cards from live data / installed-active matrix / honest dynamic states / drill-in to detail / DS-only+secure | OPEN |
| 039c-AC1..5 | per-harness route / reused /api/logs SSE filtered / capability descriptor drives panels / capabilities real (Cursor agents vs Claude none) / DS-only+secure | OPEN |
| 039-AC1..8 | (index) all-six / real-signals / one-source-two-consumers / dynamic overview / sub-page+stream / real capabilities / registered in shell / security+gate | OPEN |
| 039-SEC | security-worker-bee: no-secret in endpoint/page/routes/stream; local-only; guarded SQL | OPEN |
| 039-QA | quality-worker-bee: verified vs PRD-039 (index + a/b/c) | OPEN |
| 039-CI | `npm run ci` + GitHub Actions green | OPEN |

## Event log

- Setup: merged #70 (037), synced main, working tree verified complete (asset-deletion safeguard). Branch `feat/prd-039-harnesses-page`; 037 moved in-work→completed. Read PRD-039 end-to-end. Dispatching the 039 bee.
- **039 impl returned DONE** (one bee): `mountHarnessApi` → `GET /api/diagnostics/harnesses` (six always, real COUNT/MAX over `sessions.agent`, fail-soft); `harness-registry.ts` (canonical six derived from shims + capability descriptors folded server-side); overview page (6 cards + matrix) + per-harness detail (`/api/logs` SSE filtered + descriptor-driven panels: Cursor agents vs Claude none); `AGENT_DOT` extended to six; dynamic registry entries. Wired into `assembleDaemon()` step 14. **Orchestrator verify:** gate green, modules present, no deletions/asset touches.
- **Close-out — security (opus): PASS** (0 Crit/High/Med, 1 pre-existing Low). Guarded SQL, no secret in endpoint/page/routes/stream, crafted `#/harnesses/<script>`→Unknown fallback, tenancy fail-closed, no per-request side-effects. → 039-SEC VERIFIED.
- **Close-out — quality (opus): PASS-WITH-FINDINGS, 22/23.** One Warning: a-AC-3 mechanism correct + unit-proven but production threaded an EMPTY install set → live `installed` all-false.
- **a-AC-3 FIXED** (focused bee): `detectInstalledHarnesses()` grounded in real connector markers (`src/connectors/claude-code.ts`/`cursor.ts` configPath/pluginRoot, + codex/hermes/pi/openclaw install conventions), cheap `existsSync`-only + fail-soft + injectable roots; threaded into the REAL production assembly (gated to real-storage so unit tests keep their injected path). New tests prove the live endpoint reports true `installed` per on-disk wiring. → a-AC-3 closed, **23/23 ACs VERIFIED**.
- **Final gate:** `npm run ci` green — 221 files, 2383 passed, 6 skipped, 0 failed; typecheck + audit:sql clean. → Phase 3 Ship.

## PRD-042 ledger (24 ACs — sync page)

| ID | Criterion | Status |
|---|---|---|
| 042-AC1..8 | (index) union list / honest detail (no native/email/GUID) / promote real+poll-convergent / control real (pull·demote·enable·disable) / skill·agent symmetry / activity+state honest / registered in shell / local-only+XSS-safe+gate | ✅ VERIFIED |
| 042a-AC1..8 | skills: list·detail·promote·pull·demote·enable·disable + in-flight→converged (no optimistic flip) | ✅ VERIFIED |
| 042b-AC1..7 | agents: same engine keyed by `asset_type` (parameterized, not a fork) | ✅ VERIFIED |
| 042c-AC1..6 | activity feed follows `/api/logs/stream` SSE (backfill→tail) / per-scope summary from the SAME union view | ✅ VERIFIED |
| 042-SEC | security-worker-bee: **PASS after remediation** — CRIT path-traversal (`..` asset name → escape + recursive `.claude/` delete) fixed; HIGH demote authz UI-only → daemon enforces author-only; LOW missing sqlIdent. Guarded SQL, no secret in endpoint/page/responses, local-only. | ✅ VERIFIED |
| 042-QA | quality-worker-bee: **PASS-WITH-FINDINGS 24/24** — 2 non-blocking Warnings (W-1 enable no UI+empty native; W-2 feed poll≠SSE) both CLOSED by a focused fix bee (enable re-installs from substrate current version via the sanitized install-target + Enable button; feed now backfills then follows the SSE stream). Re-verified green. | ✅ VERIFIED |
| 042-CI | `npm run ci` (2499 passed, 6 skipped; the lone fail is the pre-existing `sources/api.test.ts` load-flake — 7/7 in isolation) + build + audit:sql + audit:openclaw all green | ✅ VERIFIED |

- Setup: branch `feat/prd-042-sync-page` off main; 041 moved in-work→completed (staged). 042 moved backlog→in-work. Read PRD-042 index+a/b/c end-to-end.
- **042 impl returned DONE** (one bee): `sync-api.ts` (ONE generic asset-action engine keyed by `asset_type` over PRD-033c `createAssetSyncApi` + the PRD-036 union view) + `sync-mount.ts` (`GET /api/diagnostics/assets` + `POST /api/diagnostics/sync/{promote,pull,demote,enable,disable}`) + `asset-install-target.ts` (path-sanitized skill-dir/agent-file target); `sync.tsx` (skills/agents tabs + detail + actions + activity feed); wired into `assembleDaemon()` step 15.
- **Close-out — security (opus): PASS after remediation** (3 findings all fixed in place — see 042-SEC). Re-ran audit:sql/openclaw/ci/build green. Flagged out-of-scope follow-up: `skillify/install-target.ts:74` has the identical latent dot-segment bug (trusted-input-only, not exploitable; defense-in-depth).
- **Close-out — quality (opus): PASS-WITH-FINDINGS, 24/24** — 2 non-blocking Warnings → both CLOSED by a focused fix bee (see 042-QA). Independently re-verified: sync suites 41/41, full ci green (flake isolated), build + both audits clean, deletion/asset safeguard clean. → Phase 3 Ship.
- **042 SHIPPED:** PR #76 merged squash+delete (main `e71f423`); CI all-green (CodeQL, Analyze ×3, Quality gate 22.x/24.x, Secret gate, Windows smoke). Lifecycle: 042 in-work→completed (on the 043 branch).

## PRD-043 ledger (25 ACs — logs page; driver decision: `node:sqlite`)

User decision (OQ-1): **`node:sqlite` (built-in)** over `better-sqlite3` — zero native dep, aligned with the repo's no-native-deps posture. Cost paid: engines `>=22.0.0`→`>=22.5.0`, `--experimental-sqlite` threaded via vitest `poolOptions.forks.execArgv` (both configs) + the daemon spawn (`DAEMON_NODE_FLAGS`, no-op on 24/25), fail-soft if the module is unavailable.

| ID | Criterion | Status |
|---|---|---|
| 043a-AC1..7 | durable SQLite store: survives restart / filter+paginate `/api/logs/history` / write-through no-regression / fail-soft / bounded retention / no-secret schema / gate | ✅ VERIFIED |
| 043b-AC1..6 | history page: history+live in one view (shared `LogRow`) / filters refetch / cursor paginate / DS+prod-clean / no-secret / gate | ✅ VERIFIED |
| 043c-AC1..6 | turns drill-down: list+detail / DeepLake-sourced via `sqlIdent("sessions")` (additive paging, eventual-consistency tolerant) / "Turns" labeling / metadata-only / gate | ✅ VERIFIED |
| 043-AC1..6 | (index) logs survive restart / queryable filters / page shows historical+live / turns browsable+drill / no-secret / security+gate | ✅ VERIFIED |
| 043-SEC | security-worker-bee: **PASS, zero remediations** — bound params throughout, regex-validated status class, escaped LIKE, fail-closed cursor decode, secret-free-by-construction schema, hardcoded spawn flag, history inherits `/api/logs` auth+local-gate. | ✅ VERIFIED |
| 043-QA | quality-worker-bee: **PASS-WITH-FINDINGS 25/25** — one Warning W-1 (path `LIKE` missing `ESCAPE '\'` → `escapeLikePrefix` dead, `_`/`%` over-match). **FIXED in-branch** (added `ESCAPE '\'`) + regression test (literal `_` no longer a wildcard). S-1/S-2 are plan-sanctioned deferrals (event_log UI, real eventCount). | ✅ VERIFIED |
| 043-CI | `npm run ci` (2546 passed, 6 skipped; lone flake `sources/api.test.ts` 7/7 isolation) + build + audit:sql + audit:openclaw green | ✅ VERIFIED |

- Setup: branch `feat/prd-043-logs-page` off main (`e71f423`). Read PRD-043 index+a/b/c end-to-end. **Surfaced OQ-1 (the one outward-facing dependency fork in the run) to the user → `node:sqlite`.** Resolved OQ-2..5 + 043b/c OQs (retention 100k rows+30d, prune-on-write+startup sweep, one logs.db/two tables, event_log persisted/UI-deferred, stacked live-tail+history keep-separate, additive paged sessions read).
- **043 impl returned DONE** (one bee): `log-store.ts` (`node:sqlite` behind a seam, retention, cursor codec, fail-soft) + write-through `logger.ts` + `GET /api/logs/history` + `logs.tsx` (history table + collapsible live tail + Turns drill-down, shared `LogRow`) + additive paged `fetchSessionsView` + flag plumbing (engines, vitest execArgv, daemon spawn). Registry `/logs` was pre-wired by 037 (zero registry edit). Orchestrator verify: 64 focused + full ci green, deletion/asset safeguard clean.
- **Close-out — security (opus): PASS, zero remediations.** All 7 focus items clean.
- **Close-out — quality (opus): PASS-WITH-FINDINGS, 25/25** — W-1 fixed in-branch + regression. Re-verified: store suite 16/16, full ci green (audit:sql ran ⇒ vitest all-pass), audit:openclaw clean. → Phase 3 Ship.
