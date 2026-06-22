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
| 042 | Sync (skills + agents view/promote/control) | tbd | OPEN |
| 043 | Logs (SQLite persistence + history + turns) | tbd | OPEN |
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
