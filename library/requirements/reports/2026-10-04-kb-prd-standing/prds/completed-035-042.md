# Standing: completed PRDs 035-042

- Date: 2026-10-04
- Shard: `library/requirements/completed/` prd-035 through prd-042
- Tree: read-only. No PRD edits, no source edits, no commits, no folder moves.
- SPA rule: `src/dashboard/web/` is absent (0 files). `src/dashboard/web/main.tsx` is ABSENT. No `*.tsx` anywhere in this repo. `src/dashboard/web/graph-layout.ts` is ABSENT. `src/daemon/runtime/dashboard/host.ts` is ABSENT. June 2026 QA reports cite those paths; this pass does not treat a QA PASS as MET.
- Verdicts: MET means this repo's source shows the behavior. UNMET means this repo contradicts the criterion or the only in-repo user-facing surface fails it. UNVERIFIABLE means the proof file is ABSENT (often the Hive SPA) or a gate was not re-run, and this tree does not itself disprove the claim.
- Counts: 8 PRDs, 189 acceptance criteria. MET 38. UNMET 7. UNVERIFIABLE 144.

## Recommended buckets

| PRD | Folder today | Index status line | Recommended bucket | Why |
|---|---|---|---|---|
| 035 | completed | Completed (children still say Backlog) | in-work | KPI/panel still say "Sessions" in `src/dashboard/views.ts`. Graph widget SPA is ABSENT. Daemon savings math is MET. |
| 036 | completed | Completed | in-work | Scanner, union, and team-skill count are in the daemon. `SkillSyncPanel` and this checkout's `.claude/skills` are ABSENT, so the headline "27 skills on the panel" is not shown here. |
| 037 | completed | Backlog | in-work | Every shell criterion names `src/dashboard/web/` (`main.tsx`, router, sidebar, registry). That tree is ABSENT. |
| 038 | completed | Backlog | in-work | Home zones, recall center, and harness strip are SPA criteria. Those files are ABSENT. |
| 039 | completed | Backlog | in-work | `GET /api/diagnostics/harnesses` is MET. The page is ABSENT. c-AC-4 is UNMET: Hermes MCP and OpenClaw contracted-tools flags are omitted on purpose. |
| 040 | completed | Backlog | in-work | Memories page, forms, and watch UI are ABSENT. Daemon CRUD and compact/pollinate routes exist, but the criteria are the page. |
| 041 | completed | Backlog | in-work | `GET /api/graph` and `GET /api/diagnostics/memory-graph` are MET. `layout(...)`, `GraphCanvas`, and `#/graph` are ABSENT. |
| 042 | completed | Backlog | in-work | Promote/pull/demote engine is largely MET. The list union never emits `pulled` (UNMET). The Sync page is ABSENT. |

A later Hive check can overturn any UNVERIFIABLE SPA row back to MET. It cannot overturn an UNMET row without a source change or a PRD text change.

## QA notes read

- 035: no QA report. Security note only: `library/requirements/completed/prd-035-dashboard-data-fixes/reports/2026-06-22-security-report.md`. Not used as a verdict.
- 036: no QA report. Security note only: `library/requirements/completed/prd-036-skill-asset-discovery/reports/2026-06-22-security-report.md`. Not used as a verdict.
- 037 QA `reports/2026-06-22-qa-report.md`: PASS, cites `src/dashboard/web/app.tsx`. That file is ABSENT now.
- 038 QA `reports/2026-06-22-qa-report.md`: PASS, cites `kpi-band` / `wire.harnesses()`. SPA ABSENT now.
- 039 QA `reports/2026-06-22-qa-report.md`: PASS-WITH-FINDINGS. Warning a-AC-3 (production `installed` always false) is superseded: `assemble.ts:3581-3588` now calls `detectInstalledHarnesses()` on the real assembly path.
- 040 QA `reports/2026-06-22-qa-report.md`: PASS, cites DOM tests. Those `*.tsx` tests are ABSENT now.
- 041 QA `reports/2026-06-22-qa-report.md`: PASS, cites `graph-layout.ts` and `src/dashboard/web/pages/graph.tsx`. Both ABSENT now. Daemon memory-graph tests remain.
- 042 QA `reports/2026-06-22-qa-report.md`: PASS-WITH-FINDINGS. W-1 (enable wrote an empty body) is fixed in `sync-api.ts:578-595`. W-2 (activity feed polls `/api/logs` instead of SSE) cannot be re-checked: `sync.tsx` is ABSENT. QA arithmetic says 24 ACs; the documents contain 29.

Security reports under 037-042 were not re-scored. They are not acceptance criteria.

---

## PRD-035 Dashboard data fixes

Index: `library/requirements/completed/prd-035-dashboard-data-fixes/prd-035-dashboard-data-fixes-index.md` (Status: Completed). Children still say Backlog. Recommended bucket: **in-work**.

### Index

1. Quote: "AC-1 - Turns, not Sessions. The KPI reads "Turns", the panel is titled "Turns", and no user-facing string that means "captured turns" still says "Sessions"."
   - PRD: `prd-035-dashboard-data-fixes-index.md:68`
   - Verdict: UNMET
   - Source: `src/dashboard/views.ts:63` (`Sessions: ${view.sessionCount}`) and `src/dashboard/views.ts:79` (panel title `"Sessions"`). `src/dashboard/web/app.tsx` ABSENT. `src/dashboard/web/panels.tsx` ABSENT.

2. Quote: "AC-2 - Real savings. The "Est. savings" KPI shows a real, non-zero, explainable number when recall/capture data exists, and 0 only when there genuinely is no data."
   - PRD: `prd-035-dashboard-data-fixes-index.md:71`
   - Verdict: UNVERIFIABLE
   - Source: KPI tile `src/dashboard/web/app.tsx` ABSENT. Daemon value is real: `src/daemon/runtime/dashboard/api.ts:244-253` and `api.ts:313-320`. Test `tests/daemon/runtime/dashboard/api.test.ts:393-420`.

3. Quote: "AC-3 - Graph renders. A built graph draws ALL its nodes and edges (no node silently skipped)."
   - PRD: `prd-035-dashboard-data-fixes-index.md:74`
   - Verdict: UNVERIFIABLE
   - Source: `src/dashboard/web/panels.tsx` ABSENT. `layout` export ABSENT. `GET /api/graph` does return nodes: `src/daemon/runtime/codebase/api.ts:335-347`.

4. Quote: "AC-4 - Graph is interactive. Clicking a node selects it and surfaces its detail (id / kind / label and its neighbors)."
   - PRD: `prd-035-dashboard-data-fixes-index.md:76`
   - Verdict: UNVERIFIABLE
   - Source: `src/dashboard/web/panels.tsx` ABSENT.

5. Quote: "AC-5 - Empty state preserved. When graph.built is false the widget still shows the honeycomb graph build prompt."
   - PRD: `prd-035-dashboard-data-fixes-index.md:78`
   - Verdict: UNVERIFIABLE
   - Source: widget ABSENT. Prompt string exists for the text view: `src/dashboard/views.ts:57` and `views.ts:132`. `built: false` payload: `src/daemon/runtime/codebase/api.ts:346`.

6. Quote: "AC-6 - No regressions / gate green. npm run ci passes; the existing PRD-024 dashboard DOM tests are updated for the new labels."
   - PRD: `prd-035-dashboard-data-fixes-index.md:80`
   - Verdict: UNVERIFIABLE
   - Source: DOM tests under `src/dashboard/web/` ABSENT. `npm run ci` not re-run.

### 035a Sessions to Turns

File: `prd-035a-dashboard-data-fixes-sessions-turns-rename.md`.

1. Quote: "AC-1 - GET /dashboard shows a KPI labeled "Turns" (not "Sessions")."
   - PRD: `prd-035a-dashboard-data-fixes-sessions-turns-rename.md:89`
   - Verdict: UNMET
   - Source: `src/dashboard/views.ts:63`. SPA `src/dashboard/web/app.tsx` ABSENT. `host.ts` ABSENT, so nothing in this tree serves a Turns KPI.

2. Quote: "AC-2 - The captured-turns panel is titled "Turns", with "N captured" eyebrow and a "No turns captured yet." empty state."
   - PRD: `prd-035a-dashboard-data-fixes-sessions-turns-rename.md:90`
   - Verdict: UNMET
   - Source: `src/dashboard/views.ts:79` title `"Sessions"`. `src/dashboard/web/panels.tsx` ABSENT.

3. Quote: "AC-3 - The count value is unchanged from today (still the sessions-table row count); only the label/field naming changes."
   - PRD: `prd-035a-dashboard-data-fixes-sessions-turns-rename.md:92`
   - Verdict: MET
   - Source: `src/daemon/runtime/dashboard/api.ts:297-302` (`turnCount: sessionCount` from `COUNT(*)` on `sessions`). Test `tests/daemon/runtime/dashboard/api.test.ts:132-133`.

4. Quote: "AC-4 - The DeepLake sessions table name is untouched (fetchKpisView / fetchSessionsView still sqlIdent("sessions"))."
   - PRD: `prd-035a-dashboard-data-fixes-sessions-turns-rename.md:94`
   - Verdict: MET
   - Source: `src/daemon/runtime/dashboard/api.ts:290` `sqlIdent("sessions")`.

5. Quote: "AC-5 - A grep over the dashboard web sources finds no remaining user-facing "Sessions"/"session" string that denotes captured turns."
   - PRD: `prd-035a-dashboard-data-fixes-sessions-turns-rename.md:96`
   - Verdict: UNVERIFIABLE
   - Source: web sources ABSENT. Related defect outside that grep root: `src/dashboard/views.ts:63` and `:79`.

6. Quote: "AC-6 - The PRD-024 dashboard DOM/unit tests are updated to assert the "Turns" label/title and still pass; npm run ci is green."
   - PRD: `prd-035a-dashboard-data-fixes-sessions-turns-rename.md:98`
   - Verdict: UNVERIFIABLE
   - Source: web DOM tests ABSENT. ci not re-run.

### 035b Est. savings

File: `prd-035b-dashboard-data-fixes-est-savings-metric.md`.

1. Quote: "AC-1 - With recall/capture data present, the "Est. savings" KPI shows a real, non-zero number (proven against an assembled daemon with seeded data)."
   - PRD: `prd-035b-dashboard-data-fixes-est-savings-metric.md:97`
   - Verdict: MET
   - Source: `tests/daemon/runtime/dashboard/api.test.ts:393-400` (4000 chars / 4 = 1000). Formula is the corpus proxy, not turn-attributed recall: `api.ts:244-248`. Browser tile ABSENT.

2. Quote: "AC-2 - With no data (empty memory/sessions), the KPI shows 0 - and 0 is reached only by the genuinely-empty path, not a hardcode."
   - PRD: `prd-035b-dashboard-data-fixes-est-savings-metric.md:99`
   - Verdict: MET
   - Source: `api.ts:319-320` (`toNum` of NULL SUM). Test `api.test.ts:403-410`. No `estimatedSavings: 0` stub remains in `fetchKpisView`.

3. Quote: "AC-3 - The number is explainable: the formula is documented at the computation site and a reader can trace KPI value to formula to source query."
   - PRD: `prd-035b-dashboard-data-fixes-est-savings-metric.md:101`
   - Verdict: MET
   - Source: `api.ts:226-253`, `api.ts:307-320`, `api.ts:347-352` (`SUM(LENGTH(content)) / CHARS_PER_TOKEN`).

4. Quote: "AC-4 - The added query is a single cheap aggregate through the storage seam with guarded SQL; fetchKpisView still returns promptly (no per-row N+1)."
   - PRD: `prd-035b-dashboard-data-fixes-est-savings-metric.md:103`
   - Verdict: MET
   - Source: `api.ts:347-352` one `SUM`. Identifiers via `sqlIdent`. `selectRows` at `api.ts:214-216`.

5. Quote: "AC-5 - On a storage error the savings value is 0 (fail-soft), and no handler throws."
   - PRD: `prd-035b-dashboard-data-fixes-est-savings-metric.md:105`
   - Verdict: MET
   - Source: `api.ts:214-216` non-ok returns `[]`. Test `api.test.ts:413-420`.

6. Quote: "AC-6 - A daemon-side vitest asserts: (a) non-zero from seeded data, (b) 0 from empty data, (c) 0 on a forced storage error; npm run ci is green."
   - PRD: `prd-035b-dashboard-data-fixes-est-savings-metric.md:106`
   - Verdict: MET
   - Source: `api.test.ts:392-421` covers (a)(b)(c). ci not re-run; the tests are present.

### 035c Graph widget

File: `prd-035c-dashboard-data-fixes-graph-render-interactivity.md`. All seven criteria require `GraphCanvas` in `src/dashboard/web/panels.tsx`.

1. Quote: "AC-1 - A built graph draws ALL its nodes and ALL its edges; for a snapshot of N nodes / M edges, N node marks and M edge lines are present."
   - PRD: `:106`
   - Verdict: UNVERIFIABLE
   - Source: `src/dashboard/web/panels.tsx` ABSENT. `layout` ABSENT.

2. Quote: "AC-2 - Node ids that are real file paths / symbols (not the six legacy keys) render correctly."
   - PRD: `:108`
   - Verdict: UNVERIFIABLE
   - Source: `panels.tsx` ABSENT. Hardcoded `NODE_POS` remains only in `assets/_ds_bundle.js:793` (design bundle, not the product widget).

3. Quote: "AC-3 - Clicking a node surfaces its detail (id, kind, label, neighbors)."
   - PRD: `:110`
   - Verdict: UNVERIFIABLE
   - Source: `panels.tsx` ABSENT.

4. Quote: "AC-4 - Clicking the selected node / clicking away clears the selection."
   - PRD: `:112`
   - Verdict: UNVERIFIABLE
   - Source: `panels.tsx` ABSENT.

5. Quote: "AC-5 - The built: false empty state still shows honeycomb graph build."
   - PRD: `:113`
   - Verdict: UNVERIFIABLE
   - Source: widget ABSENT. Text-view prompt: `src/dashboard/views.ts:57`.

6. Quote: "AC-6 - The "N nodes / M edges" header equals the drawn counts."
   - PRD: `:114`
   - Verdict: UNVERIFIABLE
   - Source: `panels.tsx` ABSENT.

7. Quote: "AC-7 - A DOM/unit test drives GraphCanvas with a fake built GraphWire and asserts nodes, edges, click, and empty state; npm run ci is green."
   - PRD: `:115`
   - Verdict: UNVERIFIABLE
   - Source: GraphCanvas test ABSENT. ci not re-run.

---

## PRD-036 Skill and asset discovery

Index: `library/requirements/completed/prd-036-skill-asset-discovery/prd-036-skill-asset-discovery-index.md` (Status: Completed). Recommended bucket: **in-work** until the panel is visible. Daemon discovery can stay.

`.claude/skills` and `.claude/agents` are ABSENT in this checkout (gitignored local tooling). The real-repo tests skip when those dirs are missing (`installed-assets.test.ts:207-208`).

### Index

1. Quote: "AC-1 - Discovery finds the real skills. Run against this repo, the daemon discovery pass returns the 27 skills under .claude/skills/ plus the agents under .claude/agents/."
   - PRD: `prd-036-skill-asset-discovery-index.md:67`
   - Verdict: UNVERIFIABLE
   - Source: `.claude/skills` ABSENT. `.claude/agents` ABSENT. Scanner exists: `src/daemon/runtime/dashboard/installed-assets.ts:106`. Temp-dir proof: `tests/daemon/runtime/dashboard/installed-assets.test.ts:65`.

2. Quote: "AC-2 - The panel shows the union. SkillSyncPanel lists local installed skills with state local and team-synced skills with their existing state. A skill that is both appears once."
   - PRD: `:70`
   - Verdict: UNVERIFIABLE
   - Source: `src/dashboard/web/panels.tsx` ABSENT. Union fetcher: `src/daemon/runtime/dashboard/api.ts:718-759`. Test `api.test.ts:568`.

3. Quote: "AC-3 - The KPI is correct and defined. The Team skills KPI reflects a documented count (D-3: team-shared skills), proven by a test."
   - PRD: `:73`
   - Verdict: MET
   - Source: `api.ts:255-260` and `api.ts:375-383` (`COUNT(DISTINCT honeycomb_id)` on non-tombstone `synced_assets` skills). Test `api.test.ts:816-825`.

4. Quote: "AC-4 - Additive, no regressions. The synced_assets substrate and the skillify install/publish path are unchanged. npm run ci stays green."
   - PRD: `:76`
   - Verdict: UNVERIFIABLE
   - Source: scanner is read-only (`installed-assets.ts:11-12`). ci not re-run. No diff was taken against PRD-033 writers.

5. Quote: "AC-5 - Backbone ready for PRD-042. The discovery output shape and the union view-model are a stable contract the Sync page can consume for both skills and agents."
   - PRD: `:79`
   - Verdict: MET
   - Source: `src/dashboard/contracts.ts:400-420` (`DiscoveredAsset`, skills and agents). `sync-api.ts:211-226` unions both kinds from `scanInstalledAssets`.

### 036a Local scanner

File: `prd-036a-skill-asset-discovery-local-scanner.md`.

1. Quote: "a-AC-1 - Finds this repo's skills. Pointed at this repo's project root, the scanner returns the 27 skills under .claude/skills/."
   - PRD: `:125`
   - Verdict: UNVERIFIABLE
   - Source: `.claude/skills` ABSENT. Skip-if test `installed-assets.test.ts:210`. Temp detection `installed-assets.test.ts:65`.

2. Quote: "a-AC-2 - Finds agents. It returns the agent files under .claude/agents/ as assetType: "agent"."
   - PRD: `:127`
   - Verdict: UNVERIFIABLE
   - Source: `.claude/agents` ABSENT. Agent rule `installed-assets.ts:22-24`. Temp test `installed-assets.test.ts:77`.

3. Quote: "a-AC-3 - Extraction. Each DiscoveredAsset carries name, description, scope, sourceHarnesses, paths, assetType."
   - PRD: `:128`
   - Verdict: MET
   - Source: `installed-assets.test.ts:85-93`.

4. Quote: "a-AC-4 - Dedupe. A skill installed under two harness roots appears once with both harnesses in sourceHarnesses and both paths."
   - PRD: `:130`
   - Verdict: MET
   - Source: `installed-assets.ts:28-30`. Test `installed-assets.test.ts:126-134`.

5. Quote: "a-AC-5 - Fail-soft. A missing/empty root yields an empty contribution, no throw; an unreadable file is skipped."
   - PRD: `:132`
   - Verdict: MET
   - Source: `installed-assets.ts:12-17` and `:106-107`. Test `installed-assets.test.ts:151`.

6. Quote: "a-AC-6 - Injectable + tested. Roots are injectable; a Vitest suite drives temp dirs."
   - PRD: `:134`
   - Verdict: MET
   - Source: `installed-assets.ts:77-88`. Test `installed-assets.test.ts:169`.

### 036b Union view

File: `prd-036b-skill-asset-discovery-union-view.md`.

1. Quote: "b-AC-1 - Union rendered. fetchSkillSyncView returns the union; SkillSyncPanel lists local skills as local and synced skills with their existing shared/synced/pulled state."
   - PRD: `:93`
   - Verdict: UNVERIFIABLE
   - Source: panel ABSENT. Fetcher MET: `api.ts:718-759`. Test `api.test.ts:556`.

2. Quote: "b-AC-2 - No double-count. A skill present both on disk and in the substrate appears exactly once, with the substrate state (not local)."
   - PRD: `:96`
   - Verdict: MET
   - Source: `api.ts:750-755` (`merged.has(key)` skips the local row). Test `api.test.ts:568`.

3. Quote: "b-AC-3 - Local-only honesty. In this repo (empty skills table, 27 disk skills) the panel shows ~27 local rows instead of 0."
   - PRD: `:98`
   - Verdict: UNVERIFIABLE
   - Source: panel ABSENT. `.claude/skills` ABSENT.

4. Quote: "b-AC-4 - Synced unchanged. A workspace with existing synced rows and no extra local skills renders exactly as before."
   - PRD: `:100`
   - Verdict: UNVERIFIABLE
   - Source: panel ABSENT. Substrate-first merge: `api.ts:737-747`. Test `api.test.ts:590`.

5. Quote: "b-AC-5 - Contract + tone. SkillSyncRow.syncState documents local; SYNC_TONE has a local tone; SkillRowSchema passes local through. npm run ci green."
   - PRD: `:102`
   - Verdict: UNVERIFIABLE
   - Source: contract documents `local` at `src/dashboard/contracts.ts:262-268`. `SYNC_TONE` and `SkillRowSchema` live in `src/dashboard/web/wire.ts` ABSENT. ci not re-run.

6. Quote: "b-AC-6 - Fail-soft. A discovery failure degrades to the substrate-only view; the panel never crashes or 500s."
   - PRD: `:104`
   - Verdict: MET
   - Source: `api.ts:734` `scan().catch(...)` returns empty inventory. Test `api.test.ts:603`.

### 036c Team skills KPI

File: `prd-036c-skill-asset-discovery-kpi-correctness.md`.

1. Quote: "c-AC-1 - Defined count. The Team skills KPI counts team-shared skills (shared/synced), documented in code, sourced from that count - never an incidental skills.length."
   - PRD: `:72`
   - Verdict: MET
   - Source: `api.ts:255-260`, `api.ts:375-383`. Test `api.test.ts:816-825`.

2. Quote: "c-AC-2 - Honest in this repo. In this repo (27 local skills, empty/zero shared) the KPI reads the true team-shared count (e.g. 0) while the panel lists the 27 local skills."
   - PRD: `:75`
   - Verdict: UNVERIFIABLE
   - Source: KPI-zero path tested `api.test.ts:828`. Panel and `.claude/skills` ABSENT.

3. Quote: "c-AC-3 - Reflects sharing. When skills are shared to the team, the KPI increments to match; pulled/local skills do not inflate it."
   - PRD: `:78`
   - Verdict: MET
   - Source: count is `synced_assets` non-tombstone skills only (`api.ts:381-382`). Test `api.test.ts:816-825`.

4. Quote: "c-AC-4 - Tested. A test asserts the KPI count against a fixture with a mix of local/shared/pulled skills. npm run ci green."
   - PRD: `:80`
   - Verdict: MET
   - Source: `api.test.ts:815-834`. ci not re-run.

---

## PRD-037 Dashboard nav shell

Index: `library/requirements/completed/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md` (Status line still says Backlog). Recommended bucket: **in-work**.

Every criterion below needs the SPA. Shared source: `src/dashboard/web/main.tsx` ABSENT, `src/dashboard/web/` ABSENT, no `*.tsx` in the repo. QA 2026-06-22 PASS is not MET.

### Index (`prd-037-dashboard-nav-shell-index.md`)

1. Quote: "AC-1 - Seven destinations render. GET /dashboard renders the left-nav shell with all seven nav items."
   - PRD: `:87`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/main.tsx` ABSENT.

2. Quote: "AC-2 - Active-route highlight. The nav item matching the current route is visually highlighted."
   - PRD: `:90`. Verdict: UNVERIFIABLE. Source: sidebar ABSENT.

3. Quote: "AC-3 - Client-side navigation, no reload. Clicking a nav item swaps the content region without a full page reload."
   - PRD: `:92`. Verdict: UNVERIFIABLE. Source: router ABSENT.

4. Quote: "AC-4 - Deep-linking works. Loading or refreshing /dashboard#/graph lands on that page; an unknown route falls back to Dashboard."
   - PRD: `:94`. Verdict: UNVERIFIABLE. Source: hash router ABSENT.

5. Quote: "AC-5 - Dashboard parity preserved. The current monolithic content renders intact on the Dashboard route."
   - PRD: `:96`. Verdict: UNVERIFIABLE. Source: `app.tsx` ABSENT.

6. Quote: "AC-6 - Daemon-down banner at the shell. When /health is unreachable the ConnectivityBanner replaces the content region."
   - PRD: `:98`. Verdict: UNVERIFIABLE. Source: shell ABSENT. Text-page connectivity exists only as `src/dashboard/html.ts:85-86`, which is not the nav shell.

7. Quote: "AC-7 - Registry contract is documented + plug-in proven. A single route registry maps route to page component to nav label."
   - PRD: `:100`. Verdict: UNVERIFIABLE. Source: registry module ABSENT.

8. Quote: "AC-8 - Collapsible / responsive. The sidebar collapses without breaking the content region."
   - PRD: `:103`. Verdict: UNVERIFIABLE. Source: sidebar ABSENT.

9. Quote: "AC-9 - Security + gate unchanged. Shell stays LOCAL-MODE-ONLY + XSS-safe; a DOM/unit test asserts the shell; npm run ci / build / invariant all green."
   - PRD: `:105`. Verdict: UNVERIFIABLE. Source: shell ABSENT. ci not re-run.

### 037a Sidebar (`prd-037a-dashboard-nav-shell-sidebar.md`)

All UNVERIFIABLE. Source: sidebar component ABSENT.

1. Quote: "AC-1 - The sidebar renders the honeycomb mark + honeycomb wordmark + the org/workspace sub-line." PRD: `:71`. Verdict: UNVERIFIABLE. Source: sidebar component ABSENT.
2. Quote: "AC-2 - All seven nav items render from the registry." PRD: `:73`. Verdict: UNVERIFIABLE. Source: sidebar component ABSENT.
3. Quote: "AC-3 - The nav item matching activeRoute is highlighted with the honey accent." PRD: `:75`. Verdict: UNVERIFIABLE. Source: sidebar component ABSENT.
4. Quote: "AC-4 - Clicking a nav item calls onNavigate(route) and the sidebar does not itself mutate location.hash." PRD: `:78`. Verdict: UNVERIFIABLE. Source: sidebar component ABSENT.
5. Quote: "AC-5 - The daemon-health pill renders in the sidebar footer with the live daemonUp state." PRD: `:80`. Verdict: UNVERIFIABLE. Source: sidebar component ABSENT.
6. Quote: "AC-6 - Collapsed/responsive: toggling collapsed renders an icon-only rail." PRD: `:82`. Verdict: UNVERIFIABLE. Source: sidebar component ABSENT.
7. Quote: "AC-7 - Every color/spacing/font value is an existing var(--...) token." PRD: `:84`. Verdict: UNVERIFIABLE. Source: sidebar component ABSENT.

### 037b Router (`prd-037b-dashboard-nav-shell-router.md`)

All UNVERIFIABLE. Source: `useHashRoute` ABSENT.

1. Quote: "AC-1 - useHashRoute() returns the route parsed from location.hash and re-renders on hashchange." PRD: `:89`. Verdict: UNVERIFIABLE. Source: `useHashRoute` ABSENT.
2. Quote: "AC-2 - Clicking a nav item swaps the content outlet with NO full reload." PRD: `:91`. Verdict: UNVERIFIABLE. Source: `useHashRoute` ABSENT.
3. Quote: "AC-3 - Deep-linking: loading /dashboard#/graph mounts that route's page." PRD: `:94`. Verdict: UNVERIFIABLE. Source: `useHashRoute` ABSENT.
4. Quote: "AC-4 - An unknown hash (e.g. #/nope) falls back to the Dashboard route." PRD: `:96`. Verdict: UNVERIFIABLE. Source: `useHashRoute` ABSENT.
5. Quote: "AC-5 - DashboardPage renders the current monolithic content intact." PRD: `:97`. Verdict: UNVERIFIABLE. Source: `useHashRoute` ABSENT.
6. Quote: "AC-6 - The /health poll + daemon-down swap live at the Shell." PRD: `:100`. Verdict: UNVERIFIABLE. Source: `useHashRoute` ABSENT.
7. Quote: "AC-7 - No new daemon route and no new dependency; app.js is still the single bundle." PRD: `:103`. Source also: dashboard bundle entry not found under `src/dashboard/web/`. ci not re-run. Verdict: UNVERIFIABLE. Source: `useHashRoute` ABSENT.

### 037c Registry (`prd-037c-dashboard-nav-shell-registry.md`)

All UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.

1. Quote: "AC-1 - PageFrame renders an optional eyebrow + a title + a content body capped at the preserved readable max-width." PRD: `:77`. Verdict: UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.
2. Quote: "AC-2 - ROUTES lists the seven static entries in nav order." PRD: `:79`. Verdict: UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.
3. Quote: "AC-3 - matchRoute(hash) resolves each of the seven hashes and an unknown hash to Dashboard." PRD: `:81`. Verdict: UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.
4. Quote: "AC-4 - The documented hydration pattern (or usePoll helper) lets a page fetch-on-mount + poll + clean up." PRD: `:83`. Verdict: UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.
5. Quote: "AC-5 - The registry supports a dynamic entry." PRD: `:86`. Verdict: UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.
6. Quote: "AC-6 - Adding a page is ONE registry entry + one component." PRD: `:88`. Verdict: UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.
7. Quote: "AC-7 - The "how to add a page" contract is documented (module doc-comment + a knowledge-base note)." PRD: `:91`. Knowledge pages were not treated as the registry module. The module doc-comment is ABSENT with the SPA. Verdict: UNVERIFIABLE. Source: `PageFrame` / `ROUTES` / `matchRoute` ABSENT.

---

## PRD-038 Dashboard home

Index: `library/requirements/completed/prd-038-dashboard-home/prd-038-dashboard-home-index.md` (Status line: Backlog). Recommended bucket: **in-work**.

Daemon inputs the page would bind are present (`turnCount`, `estimatedSavings`, `teamSkillCount`, `GET /api/diagnostics/harnesses`, `POST /api/memories/recall`, `GET /api/logs`). The page that arranges them is ABSENT. QA PASS is not MET.

### Index

1. Quote: "AC-1 - The home reads as zones. The Dashboard route (#/) renders as three clearly-delineated AREAS."
   - PRD: `:75`. Verdict: UNVERIFIABLE. Source: home page ABSENT.

2. Quote: "AC-2 - KPIs sit in a defined top band. The four headline KPIs (Memories, Turns, Est. savings, Team skills) render in the top band."
   - PRD: `:78`. Verdict: UNVERIFIABLE. Source: `kpi-band` ABSENT. Values exist on `KpisView` (`src/dashboard/contracts.ts:56-79`).

3. Quote: "AC-3 - Recall works from the center. The recall bar POSTs /api/memories/recall via the wire client and renders the hits as MemoryCards."
   - PRD: `:81`. Verdict: UNVERIFIABLE. Source: center area ABSENT. Route exists: `src/daemon/runtime/memories/api.ts:750`.

4. Quote: "AC-4 - Installed harnesses shown. The harness area shows which harnesses honeycomb is currently wired into."
   - PRD: `:84`. Verdict: UNVERIFIABLE. Source: strip ABSENT. Endpoint: `src/daemon/runtime/dashboard/harness-api.ts:58-59`.

5. Quote: "AC-5 - Short-tail live stream. The harness area renders a short-tail live stream from /api/logs."
   - PRD: `:87`. Verdict: UNVERIFIABLE. Source: strip ABSENT.

6. Quote: "AC-6 - Dynamic per-harness KPI tiles. Per-harness KPI tiles render DYNAMICALLY based on what is installed."
   - PRD: `:90`. Verdict: UNVERIFIABLE. Source: render path ABSENT.

7. Quote: "AC-7 - Reuse, no fork; gate green. The page reuses the existing wire client, panels, and primitives. npm run ci passes."
   - PRD: `:93`. Verdict: UNVERIFIABLE. Source: page ABSENT. ci not re-run.

8. Quote: "AC-8 - Security posture inherited. The home page stays LOCAL-MODE-ONLY + XSS-safe; no token/secret appears in the KPI band, recall results, harness tiles, or live-stream lines."
   - PRD: `:97`. Verdict: UNVERIFIABLE. Source: page ABSENT.

### 038a KPI band (`prd-038a-dashboard-home-kpi-band.md`)

All UNVERIFIABLE. Source: home page ABSENT.

1. Quote: "AC-1 - Three named areas exist." PRD: `:73`. Verdict: UNVERIFIABLE. Source: home page ABSENT.
2. Quote: "AC-2 - KPIs sit in the top band." PRD: `:76`. Verdict: UNVERIFIABLE. Source: home page ABSENT.
3. Quote: "AC-3 - Corrected values surface. The Turns tile is labeled "Turns" (not "Sessions")." PRD: `:79`. Related contradiction: `src/dashboard/views.ts:63` still says Sessions, but that is not the 038 home tile. Verdict: UNVERIFIABLE. Source: home page ABSENT.
4. Quote: "AC-4 - Reuse + tokens only." PRD: `:82`. Verdict: UNVERIFIABLE. Source: home page ABSENT.
5. Quote: "AC-5 - Gate green." PRD: `:84`. Verdict: UNVERIFIABLE. Source: home page ABSENT.

### 038b Recall center (`prd-038b-dashboard-home-recall-center.md`)

All UNVERIFIABLE. Source: recall-area ABSENT. Daemon recall route is `src/daemon/runtime/memories/api.ts:750`.

1. Quote: "AC-1 - Recall in the center area." PRD: `:75`. Verdict: UNVERIFIABLE. Source: recall-area ABSENT. Daemon recall route is `src/daemon/runtime/memories/api.ts:750`.
2. Quote: "AC-2 - Recall works from the home page. Submitting a query POSTs /api/memories/recall via wire.recall." PRD: `:78`. Verdict: UNVERIFIABLE. Source: recall-area ABSENT. Daemon recall route is `src/daemon/runtime/memories/api.ts:750`.
3. Quote: "AC-3 - MemoryCards render the hit shape." PRD: `:81`. Verdict: UNVERIFIABLE. Source: recall-area ABSENT. Daemon recall route is `src/daemon/runtime/memories/api.ts:750`.
4. Quote: "AC-4 - Lexical-fallback badge carries over." PRD: `:83`. Verdict: UNVERIFIABLE. Source: recall-area ABSENT. Daemon recall route is `src/daemon/runtime/memories/api.ts:750`.
5. Quote: "AC-5 - Reuse + tokens + no secret." PRD: `:86`. Verdict: UNVERIFIABLE. Source: recall-area ABSENT. Daemon recall route is `src/daemon/runtime/memories/api.ts:750`.

### 038c Harness strip (`prd-038c-dashboard-home-harness-strip.md`)

All UNVERIFIABLE. Source: harness-area ABSENT. Telemetry endpoint is MET separately under 039a.

1. Quote: "AC-1 - Wired-in harnesses shown." PRD: `:93`. Verdict: UNVERIFIABLE. Source: harness-area ABSENT. Telemetry endpoint is MET separately under 039a.
2. Quote: "AC-2 - Short-tail live stream." PRD: `:97`. Verdict: UNVERIFIABLE. Source: harness-area ABSENT. Telemetry endpoint is MET separately under 039a.
3. Quote: "AC-3 - Dynamic per-harness KPI tiles." PRD: `:100`. Verdict: UNVERIFIABLE. Source: harness-area ABSENT. Telemetry endpoint is MET separately under 039a.
4. Quote: "AC-4 - At-a-glance scope, not the deep page." PRD: `:103`. Verdict: UNVERIFIABLE. Source: harness-area ABSENT. Telemetry endpoint is MET separately under 039a.
5. Quote: "AC-5 - Reuse + tokens + no secret." PRD: `:106`. Verdict: UNVERIFIABLE. Source: harness-area ABSENT. Telemetry endpoint is MET separately under 039a.

---

## PRD-039 Harnesses page

Index: `library/requirements/completed/prd-039-harnesses-page/prd-039-harnesses-page-index.md` (Status line: Backlog). Recommended bucket: **in-work**.

### Index

1. Quote: "AC-1 - All six, always. The Harnesses page and the 039a endpoint report ALL SIX harnesses."
   - PRD: `:87`. Verdict: UNVERIFIABLE. Source: page ABSENT. Endpoint half MET: `src/daemon/runtime/dashboard/harness-registry.ts:56-70` and `harness-api.ts:11-12`.

2. Quote: "AC-2 - Real signals only. Every per-harness field (installed, active, lastSeen, turnsCaptured) is derived from a real signal."
   - PRD: `:90`. Verdict: MET. Source: `harness-api.ts:22-27` and `:303-314`. Test `tests/daemon/runtime/dashboard/harness-api.test.ts:140-188`.

3. Quote: "AC-3 - One data source, two consumers. The 039a endpoint is the SINGLE source the Harnesses page and PRD-038's home harness strip read."
   - PRD: `:94`. Verdict: UNVERIFIABLE. Source: both consumers ABSENT. Endpoint is mounted once: `src/daemon/runtime/assemble.ts:1853-1876`.

4. Quote: "AC-4 - Overview page dynamic. #/harnesses renders per-harness KPI cards + an installed/active matrix."
   - PRD: `:96`. Verdict: UNVERIFIABLE. Source: `#/harnesses` page ABSENT.

5. Quote: "AC-5 - Per-harness sub-page + live stream. Clicking a harness opens #/harnesses/cursor."
   - PRD: `:99`. Verdict: UNVERIFIABLE. Source: detail route ABSENT.

6. Quote: "AC-6 - Harness-specific capabilities are real. The capability descriptors reflect actual divergences from the shims (Cursor agents + workspace_roots; Claude Code six-event lifecycle, no agents panel)."
   - PRD: `:102`. Verdict: UNVERIFIABLE. Source: "shows no agents panel" is the page, ABSENT. Descriptor examples for Cursor and Claude are present: `harness-registry.ts:131-145` and test `harness-api.test.ts:340-364`. Hermes/OpenClaw omission is scored on c-AC-4.

7. Quote: "AC-7 - Registered in the shell. The page mounts inside the PRD-037 nav shell at #/harnesses."
   - PRD: `:105`. Verdict: UNVERIFIABLE. Source: shell ABSENT.

8. Quote: "AC-8 - Security + gate unchanged. npm run ci / build / audit:sql / audit:openclaw / invariant all green."
   - PRD: `:108`. Verdict: UNVERIFIABLE. Source: page ABSENT. ci not re-run. Response shape carries no secret field: `harness-api.ts:29-33`.

### 039a Registry telemetry (`prd-039a-harnesses-page-registry-telemetry.md`)

1. Quote: "a-AC-1 - All six, always. GET /api/diagnostics/harnesses returns exactly the six canonical harnesses every call."
   - PRD: `:95`. Verdict: MET. Source: `harness-registry.ts:70`. Test `harness-api.test.ts:151-158`.

2. Quote: "a-AC-2 - Activity is real. turnsCaptured = COUNT(*) and lastSeen = MAX(creation_date) over sessions GROUP BY agent."
   - PRD: `:97`. Verdict: MET. Source: `harness-api.ts:23-26`. Test `harness-api.test.ts:140-148`.

3. Quote: "a-AC-3 - Installed reflects wiring. installed is true for a harness whose hooks/identity targets are present and false otherwise, independent of capture activity."
   - PRD: `:100`. Verdict: MET. Source: injected set proven `harness-api.test.ts:172-188`. Production resolver `assemble.ts:3581-3588` calls `detectInstalledHarnesses` (`harness-detect.ts:131-139`). June QA "always false" finding is superseded.

4. Quote: "a-AC-4 - One backbone. The endpoint is the single source; a test drives app.request("/api/diagnostics/harnesses") and asserts the shape, the six names, and the derived active flag."
   - PRD: `:103`. Verdict: MET. Source: `harness-api.ts:4-10`. Active flag test `harness-api.test.ts:162-169`.

5. Quote: "a-AC-5 - Guarded + fail-soft + secure. SQL is built only with sqlIdent/sLiteral; a non-ok storage result returns all six with zeroed activity."
   - PRD: `:105`. Verdict: MET. Source: `harness-api.ts:22-27`. Test `harness-api.test.ts:191`.

### 039b Overview (`prd-039b-harnesses-page-overview.md`)

All UNVERIFIABLE. Source: `#/harnesses` page ABSENT.

1. Quote: "b-AC-1 - Six cards from live data." PRD: `:73`. Verdict: UNVERIFIABLE. Source: `#/harnesses` page ABSENT.
2. Quote: "b-AC-2 - Installed/active matrix." PRD: `:75`. Verdict: UNVERIFIABLE. Source: `#/harnesses` page ABSENT.
3. Quote: "b-AC-3 - Honest, dynamic states." PRD: `:77`. Verdict: UNVERIFIABLE. Source: `#/harnesses` page ABSENT.
4. Quote: "b-AC-4 - Drill-in. Clicking a card routes to #/harnesses/<name>." PRD: `:81`. Verdict: UNVERIFIABLE. Source: `#/harnesses` page ABSENT.
5. Quote: "b-AC-5 - DS-only + production-clean + secure." PRD: `:83`. Verdict: UNVERIFIABLE. Source: `#/harnesses` page ABSENT.

### 039c Detail (`prd-039c-harnesses-page-detail.md`)

1. Quote: "c-AC-1 - Per-harness route. Each harness has a detail route #/harnesses/<name>."
   - PRD: `:96`. Verdict: UNVERIFIABLE. Source: route ABSENT.

2. Quote: "c-AC-2 - Live stream, reused. The detail page shows that harness's live activity via the existing /api/logs SSE stream filtered to the harness."
   - PRD: `:98`. Verdict: UNVERIFIABLE. Source: detail page ABSENT.

3. Quote: "c-AC-3 - Capability descriptor drives panels. Cursor shows an Agents panel; Claude Code shows none."
   - PRD: `:100`. Verdict: UNVERIFIABLE. Source: panels ABSENT. Descriptor has Cursor `agents` and Claude omits them: `harness-registry.ts:115-116`, test `harness-api.test.ts:347-354`.

4. Quote: "c-AC-4 - Capabilities are real. The descriptors reflect the actual shim divergences (runtime path, context channel, host CLI, lifecycle events, Cursor agents, Hermes MCP registration, OpenClaw contracted tools)."
   - PRD: `:103`. Verdict: UNMET. Source: `harness-registry.ts:137-139` sets `hermes: {}` and `openclaw: {}`. Test locks the omission: `harness-api.test.ts:376-377` expects `mcpRegistration` and `contractedTools` to be undefined. Cursor agents and Claude lifecycle are present (`harness-api.test.ts:347-364`), so this is a partial miss, not a missing endpoint.

5. Quote: "c-AC-5 - DS-only + production-clean + secure. A DOM/unit test renders the Cursor detail and the Claude Code detail."
   - PRD: `:107`. Verdict: UNVERIFIABLE. Source: DOM test ABSENT. ci not re-run.

---

## PRD-040 Memories page

Index: `library/requirements/completed/prd-040-memories-page/prd-040-memories-page-index.md` (Status line: Backlog). Recommended bucket: **in-work**.

The page is ABSENT. These daemon routes exist and are what the page would call. They do not render `#/memories`:

- list/get/store/modify: `src/daemon/runtime/memories/api.ts:22-27` and `:936`, `:1046`, `:1056`
- widened read model: `src/daemon/runtime/memories/reads.ts:60-83` (`visibility`, `version`, `hasEmbedding`)
- compact: `src/daemon/runtime/maintenance/compact-api.ts:68`
- pollinate: `src/daemon/runtime/pollinating/api.ts:77`

### Index

1. Quote: "AC-1 - The page lives in the shell. GET /dashboard#/memories renders the Memories page inside the PRD-037 shell."
   - PRD: `:67`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/main.tsx` ABSENT.

2. Quote: "AC-2 - Browse + search + view (040a). The page lists memories, search filters them, and opening a memory shows its full content + metadata."
   - PRD: `:71`. Verdict: UNVERIFIABLE. Source: page ABSENT. APIs cited above.

3. Quote: "AC-3 - Add + edit (040b). A user can add a memory and edit an existing one; an edit creates a NEW version."
   - PRD: `:73`. Verdict: UNVERIFIABLE. Source: Add/Edit forms ABSENT. `POST /api/memories/:id/modify` exists at `memories/api.ts:1056`.

4. Quote: "AC-4 - Compact + pollinate + watch (040c)."
   - PRD: `:75`. Verdict: UNVERIFIABLE. Source: page controls ABSENT. Compact and pollinate routes exist (paths above). Watch UI ABSENT.

5. Quote: "AC-5 - Security + gate. The page is LOCAL-MODE-ONLY + XSS-safe. npm run ci / build / audit:sql / audit:openclaw / invariant all green."
   - PRD: `:77`. Verdict: UNVERIFIABLE. Source: page ABSENT. ci not re-run.

### 040a Browse (`prd-040a-memories-page-browse-search-view.md`)

All UNVERIFIABLE. Source: `#/memories` page ABSENT.

1. Quote: "AC-1 - The page lists memories. On #/memories, the page hydrates from GET /api/memories." PRD: `:82`. Verdict: UNVERIFIABLE. Source: `#/memories` page ABSENT.
2. Quote: "AC-2 - Search filters them. Typing a query POSTs /api/memories/recall." PRD: `:85`. Verdict: UNVERIFIABLE. Source: `#/memories` page ABSENT.
3. Quote: "AC-3 - A detail view renders. Clicking a memory opens a detail view that calls GET /api/memories/:id." PRD: `:89`. Read-model fields the detail wants are on `MemoryRecord` (`reads.ts:75-83`) but the view is ABSENT. Verdict: UNVERIFIABLE. Source: `#/memories` page ABSENT.
4. Quote: "AC-4 - Thin client, reused wire. The page uses the injected PageProps.wire." PRD: `:92`. `wire.ts` ABSENT. Verdict: UNVERIFIABLE. Source: `#/memories` page ABSENT.
5. Quote: "AC-5 - Security. Memory content renders as escaped text (no dangerouslySetInnerHTML)." PRD: `:95`. Page ABSENT. Verdict: UNVERIFIABLE. Source: `#/memories` page ABSENT.

### 040b Add and edit (`prd-040b-memories-page-add-edit.md`)

All UNVERIFIABLE. Source: forms ABSENT. Daemon modify route: `memories/api.ts:1056`.

1. Quote: "AC-1 - A user can add a memory. The Add form POSTs /api/memories." PRD: `:90`. Verdict: UNVERIFIABLE. Source: forms ABSENT. Daemon modify route: `memories/api.ts:1056`.
2. Quote: "AC-2 - A user can edit a memory. The Edit form POSTs /api/memories/:id/modify with a required reason." PRD: `:93`. Verdict: UNVERIFIABLE. Source: forms ABSENT. Daemon modify route: `memories/api.ts:1056`.
3. Quote: "AC-3 - Edits create a new version, not a hard-update." PRD: `:95`. Verdict: UNVERIFIABLE. Source: forms ABSENT. Daemon modify route: `memories/api.ts:1056`.
4. Quote: "AC-4 - UI reflects the persisted value (re-read, not optimistic)." PRD: `:98`. Verdict: UNVERIFIABLE. Source: forms ABSENT. Daemon modify route: `memories/api.ts:1056`.
5. Quote: "AC-5 - Honest failure. A rejected write surfaces the failure and leaves the UI showing the unchanged persisted memory." PRD: `:101`. Verdict: UNVERIFIABLE. Source: forms ABSENT. Daemon modify route: `memories/api.ts:1056`.
6. Quote: "AC-6 - Security + gate. Write bodies carry only content + reason." PRD: `:103`. Verdict: UNVERIFIABLE. Source: forms ABSENT. Daemon modify route: `memories/api.ts:1056`.

### 040c Compact, pollinate, watch (`prd-040c-memories-page-compact-pollinate-watch.md`)

All UNVERIFIABLE. Source: page controls ABSENT.

1. Quote: "AC-1 - Compact invokes the real pipeline + honest summary." PRD: `:95`. Route: `compact-api.ts:276`. Verdict: UNVERIFIABLE. Source: page controls ABSENT.
2. Quote: "AC-2 - Pollinate invokes the real loop + honest ack." PRD: `:99`. Route: `pollinating/api.ts:250`. Verdict: UNVERIFIABLE. Source: page controls ABSENT.
3. Quote: "AC-3 - Watch shows live memory activity. Toggling Watch starts a poll of /api/logs filtered to memory routes." PRD: `:102`. Verdict: UNVERIFIABLE. Source: page controls ABSENT.
4. Quote: "AC-4 - Acks/summaries are state-only." PRD: `:105`. Verdict: UNVERIFIABLE. Source: page controls ABSENT.
5. Quote: "AC-5 - Security + gate." PRD: `:108`. Verdict: UNVERIFIABLE. Source: page controls ABSENT.

---

## PRD-041 Graph page

Index: `library/requirements/completed/prd-041-graph-page/prd-041-graph-page-index.md` (Status line: Backlog). Recommended bucket: **in-work**.

`GET /api/graph` is owned by `src/daemon/runtime/codebase/api.ts:335-347`. `layout(...)` and `GraphCanvas` are ABSENT. QA cites `graph-layout.ts` and `pages/graph.tsx`; both ABSENT.

### Index

1. Quote: "AC-1 - Codebase graph page renders. The #/graph route renders the full codebase graph from GET /api/graph with a real interactive layout, reusing GraphCanvas + layout(...)."
   - PRD: `:69`. Verdict: UNVERIFIABLE. Source: page and `layout` ABSENT. `GET /api/graph`: `codebase/api.ts:341-347`.

2. Quote: "AC-2 - Empty state honored full-page. When GraphView.built is false, the page shows the honeycomb graph build prompt."
   - PRD: `:73`. Verdict: UNVERIFIABLE. Source: page ABSENT. `built: false` payload: `codebase/api.ts:346`. Prompt string: `src/dashboard/views.ts:57`.

3. Quote: "AC-3 - Memory graph foundation. A documented memory/knowledge-graph view-model and a daemon endpoint exist, plus a Codebase / Memory toggle; the SAME canvas renders both."
   - PRD: `:75`. Verdict: UNVERIFIABLE. Source: toggle and canvas ABSENT. View-model `src/dashboard/contracts.ts:183-237`. Endpoint `api.ts:1394` `GET /api/diagnostics/memory-graph`.

4. Quote: "AC-4 - Security + gate unchanged."
   - PRD: `:79`. Verdict: UNVERIFIABLE. Source: page ABSENT. ci not re-run.

### 041a Codebase graph (`prd-041a-graph-page-codebase-graph.md`)

All UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.

1. Quote: "AC-1 - Loading /dashboard#/graph renders the FULL codebase graph." PRD: `:139`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.
2. Quote: "AC-2 - Pan and zoom work." PRD: `:142`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.
3. Quote: "AC-3 - Clicking a node opens a detail panel." PRD: `:144`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.
4. Quote: "AC-4 - Kind filters reflect the snapshot's real kinds." PRD: `:147`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.
5. Quote: "AC-5 - Searching by id/label locates and focuses/selects the matching node." PRD: `:150`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.
6. Quote: "AC-6 - With GraphView.built false, the page shows the full-page honeycomb graph build empty-state." PRD: `:151`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.
7. Quote: "AC-7 - Security + gate: a DOM/unit test drives the page; npm run ci / build / audit:sql / audit:openclaw green." PRD: `:153`. Verdict: UNVERIFIABLE. Source: `src/dashboard/web/pages/graph.tsx` ABSENT. `layout` ABSENT.

### 041b Memory graph (`prd-041b-graph-page-memory-graph.md`)

1. Quote: "AC-1 - A named, documented memory-graph view-model exists, GraphView-shaped, and the existing GraphCanvas renders it unchanged."
   - PRD: `:129`. Verdict: UNVERIFIABLE. Source: view-model MET at `contracts.ts:183-237`. `GraphCanvas` ABSENT.

2. Quote: "AC-2 - A daemon read endpoint serves the memory-graph view-model and returns the honest { built: false } empty state when no knowledge graph exists."
   - PRD: `:132`. Verdict: MET. Source: `api.ts:561-581` and mount `api.ts:1392-1398`. Tests `api.test.ts:610-699`.

3. Quote: "AC-3 - The Graph page shows a Codebase / Memory toggle; switching to Memory fetches the memory-graph endpoint and renders it on the same canvas."
   - PRD: `:136`. Verdict: UNVERIFIABLE. Source: toggle ABSENT.

4. Quote: "AC-4 - With an empty memory graph, the Memory view shows an honest "no memory graph yet" empty state."
   - PRD: `:139`. Verdict: UNVERIFIABLE. Source: page copy ABSENT. Daemon empty state is `{ built: false, nodes: [], edges: [] }` plus a reason: `api.ts:579-581`.

5. Quote: "AC-5 - The PRD documentation and the view-model's doc comment explicitly enumerate NOW vs DEFERRED, and the implementation contains no stub that fakes a populated graph."
   - PRD: `:141`. Verdict: MET. Source: `contracts.ts:192-208`. Empty path does not invent nodes: `api.ts:575-581`. `built: true` only when entity rows exist: `api.ts:583`.

6. Quote: "AC-6 - Security/gate: local-mode-only + XSS-safe, no token/secret; npm run ci / build / audit:sql / audit:openclaw green."
   - PRD: `:144`. Verdict: UNVERIFIABLE. Source: page ABSENT. ci not re-run. Response grep test: `api.test.ts:797-805`.

---

## PRD-042 Sync page

Index: `library/requirements/completed/prd-042-sync-page/prd-042-sync-page-index.md` (Status line: Backlog). Recommended bucket: **in-work**.

Action engine: `src/daemon/runtime/dashboard/sync-api.ts`. Mount: `sync-mount.ts`. Page `sync.tsx` ABSENT. Live itest file exists (`tests/integration/sync-page-actions-live.itest.ts`) and was not executed.

`unionFor` (`sync-api.ts:243-306`) assigns `state: "shared"` for substrate rows (`:264`) and `state: "local"` for disk-only rows (`:293`). It never assigns `"pulled"`. Pull's action result does (`:545`).

### Index

1. Quote: "AC-1 - The page exists and lists the union. #/sync lists every skill and agent from the installed-union-synced view-model, each with its honest state badge (local / pulled / shared) - no double-count."
   - PRD: `:78`. Verdict: UNMET. Source: page ABSENT. List union never emits `pulled`: `sync-api.ts:264` and `:293`. Dedupe itself is implemented (`:282-289`).

2. Quote: "AC-2 - Detail view is honest. Selecting a skill or agent opens a detail view showing provenance, scope, source harness, tier/style, and current version - never a secret/native-blob leak."
   - PRD: `:83`. Verdict: UNVERIFIABLE. Source: detail view ABSENT. Action results omit native: test `sync-api.test.ts:250-258`.

3. Quote: "AC-3 - Promote publishes for real. Promoting a local skill or agent publishes a version-bumped row into synced_assets, and the row's state flips to shared on a poll-convergent read-back."
   - PRD: `:86`. Verdict: MET. Source: `sync-api.ts:507-529` (`engine.publish`, then `readBackCurrent`). Test `sync-api.test.ts:161-176` asserts no UPDATE. Live file `sync-page-actions-live.itest.ts:121` (not run).

4. Quote: "AC-4 - Control actions invoke the real pipelines. Pull, demote (tombstone), and enable/disable each call the real skillify/substrate seam and reflect the persisted result on a converged read."
   - PRD: `:90`. Verdict: MET. Source: `sync-api.ts:532-602`. Tests `sync-api.test.ts:179-248`. Enable now reads the current native (`:578-595`); the June QA empty-body warning is fixed in this tree. UI affordance ABSENT.

5. Quote: "AC-5 - Agents are symmetric. Every list/detail/promote/control capability that works for skills works identically for agents, proven by the same tests parameterized over both asset types."
   - PRD: `:93`. Verdict: MET. Source: one engine `sync-api.ts:501-505`. `describe.each(["skill","agent"])` at `sync-api.test.ts:160`.

6. Quote: "AC-6 - Activity + state are honest. The page shows recent sync events and the current per-scope sync state, reusing /api/logs + SSE."
   - PRD: `:95`. Verdict: UNVERIFIABLE. Source: feed UI ABSENT. June QA W-2 said the page polled `/api/logs` instead of SSE. That file is gone, so the finding is not re-proven and not cleared.

7. Quote: "AC-7 - Security + gate unchanged. npm run ci / build / audit:sql / audit:openclaw / invariant all green."
   - PRD: `:98`. Verdict: UNVERIFIABLE. Source: page ABSENT. ci not re-run. SQL for the current-version read goes through guarded helpers (`sync-api.ts:435-436`).

8. Quote: "AC-8 - Live verification. Against a real assembled daemon: a local skill promotes to shared, a teammate-published skill pulls, a demote tombstones, and the activity feed shows those events."
   - PRD: `:102`. Verdict: UNVERIFIABLE. Source: itest file `tests/integration/sync-page-actions-live.itest.ts:121-203` covers promote/pull/demote and was not run. DOM test and feed assertion ABSENT.

### 042a Skills (`prd-042a-sync-page-skills-view-promote-control.md`)

1. Quote: "a-AC-1 - Skills list = the union. The skills view lists every skill, each with its state badge (local/pulled/shared); a skill both local and in synced_assets appears once."
   - PRD: `:55`. Verdict: UNMET. Source: `sync-api.ts:264` and `:293` never set `pulled`. Dedupe: `:282-289`. Page ABSENT.

2. Quote: "a-AC-2 - Detail view. Selecting a skill opens a detail view with name, description, provenance, scope, source harness, tier/style, current version, and state - no native blob / author email / org GUID."
   - PRD: `:57`. Verdict: UNVERIFIABLE. Source: detail view ABSENT.

3. Quote: "a-AC-3 - Promote publishes for real. Promoting a local skill calls createSkillPublishEndpoint.publish (a version-bumped row, never an in-place UPDATE); on a poll-convergent read-back the skill's state is shared."
   - PRD: `:59`. Verdict: MET. Source: the call is `engine.publish` via `createAssetSyncApi` (`sync-api.ts:515-529`), not the literal `createSkillPublishEndpoint.publish` symbol. Test asserts version-bumped INSERT and no UPDATE: `sync-api.test.ts:161-176`.

4. Quote: "a-AC-4 - Pull works. Pulling a shared skill installs it to the harness skills dir, and the row shows pulled."
   - PRD: `:62`. Verdict: MET. Source: `sync-api.ts:532-545` returns `state: "pulled"`. Test `sync-api.test.ts:179-202`. Caveat: the next `fetchAssetSyncView` list still labels that row `shared` (`sync-api.ts:264`).

5. Quote: "a-AC-5 - Demote tombstones. Demoting writes a fresh version with tombstone='true'; on the converged read the skill no longer presents as live shared."
   - PRD: `:64`. Verdict: MET. Source: `sync-api.ts:548-575`. Test `sync-api.test.ts:205-229`.

6. Quote: "a-AC-6 - Enable/disable invokes the real seam and reflects the persisted result, never a UI-only flip."
   - PRD: `:66`. Verdict: MET. Source: `sync-api.ts:578-602` (enable rewrites the current native; disable calls `installTarget.remove`). Test `sync-api.test.ts:265-285`. Page control ABSENT.

7. Quote: "a-AC-7 - In-flight, then converged. Each action shows an in-flight state and only confirms success after the poll-convergent read-back."
   - PRD: `:68`. Verdict: UNVERIFIABLE. Source: in-flight UI ABSENT. Daemon read-back: `sync-api.ts:402-427`.

8. Quote: "a-AC-8 - Security + gate. Local-mode-only, XSS-safe, no secret/blob/email in the page or any action response."
   - PRD: `:70`. Verdict: UNVERIFIABLE. Source: page ABSENT. Action JSON omits native/email/org: `sync-api.test.ts:250-258`. ci not re-run.

### 042b Agents (`prd-042b-sync-page-agents-view-promote-control.md`)

1. Quote: "b-AC-1 - Agents list = the union. The agents view lists every agent with state badges; an agent both local and in synced_assets appears once."
   - PRD: `:52`. Verdict: UNMET. Source: same `unionFor` (`sync-api.ts:224` and `:264`). A pulled agent is labeled `shared`, not `pulled`. Dedupe is implemented.

2. Quote: "b-AC-2 - Detail view. Selecting an agent opens a detail view - no secret/blob/author-email rendered."
   - PRD: `:54`. Verdict: UNVERIFIABLE. Source: detail view ABSENT.

3. Quote: "b-AC-3 - Promote publishes a real agent row. Promoting a local agent writes a version-bumped synced_assets row with asset_type='agent'; on a poll-convergent read-back the agent is shared."
   - PRD: `:56`. Verdict: MET. Source: `sync-api.ts:515-529` keyed by `assetType`. Test `sync-api.test.ts:160-176` (`describe.each` includes agent).

4. Quote: "b-AC-4 - Pull works. Pulling a shared agent installs it under .claude/agents/ and the row shows pulled."
   - PRD: `:59`. Verdict: MET. Source: `sync-api.ts:543-545` and install target used by `installTarget.write`. Test `sync-api.test.ts:179-202` for `agent`. Same list-relabel caveat as a-AC-4.

5. Quote: "b-AC-5 - Demote tombstones. Demoting writes a fresh agent version with tombstone='true'."
   - PRD: `:61`. Verdict: MET. Source: `sync-api.ts:548-575`. Test `sync-api.test.ts:205`.

6. Quote: "b-AC-6 - Symmetry proven. The list/detail/promote/pull/demote/enable-disable tests are parameterized over both asset types, one engine not a fork."
   - PRD: `:63`. Verdict: MET. Source: `sync-api.test.ts:160`. Mount test `sync-mount.test.ts:76-86`.

7. Quote: "b-AC-7 - Security + gate."
   - PRD: `:66`. Verdict: UNVERIFIABLE. Source: page ABSENT. ci not re-run.

### 042c Activity (`prd-042c-sync-page-activity-and-state.md`)

All UNVERIFIABLE. Source: activity feed UI ABSENT.

1. Quote: "c-AC-1 - Activity feed renders real events from /api/logs, newest first." PRD: `:54`. Verdict: UNVERIFIABLE. Source: activity feed UI ABSENT.
2. Quote: "c-AC-2 - Live follow. New sync events stream into the feed via /api/logs/stream (SSE)." PRD: `:57`. June QA W-2 said this was a poll. Page now ABSENT, so that finding is historical, not re-checked. Verdict: UNVERIFIABLE. Source: activity feed UI ABSENT.
3. Quote: "c-AC-3 - Per-scope state summary." PRD: `:59`. Verdict: UNVERIFIABLE. Source: activity feed UI ABSENT.
4. Quote: "c-AC-4 - Honest, converged state." PRD: `:62`. Verdict: UNVERIFIABLE. Source: activity feed UI ABSENT.
5. Quote: "c-AC-5 - Security + gate. No token/secret/native blob/author-email in any event line." PRD: `:65`. Verdict: UNVERIFIABLE. Source: activity feed UI ABSENT.
6. Quote: "c-AC-6 - Live verification. Against a real assembled daemon: promote a skill and a pull both appear in the feed." PRD: `:68`. Itest covers convergence of promote/pull/demote, not the feed, and was not run. Verdict: UNVERIFIABLE. Source: activity feed UI ABSENT.

---

## UNMET list (7)

1. 035 index AC-1 - `views.ts:63` and `:79` still say Sessions.
2. 035a AC-1 - GET /dashboard does not show a Turns KPI in this tree.
3. 035a AC-2 - captured-turns panel title is still "Sessions".
4. 039c c-AC-4 - Hermes `mcpRegistration` and OpenClaw `contractedTools` are undefined (`harness-registry.ts:137-139`, test `harness-api.test.ts:376-377`).
5. 042 index AC-1 - union list never emits `pulled` (`sync-api.ts:264`, `:293`).
6. 042a a-AC-1 - same pulled-badge gap for skills.
7. 042b b-AC-1 - same pulled-badge gap for agents.
