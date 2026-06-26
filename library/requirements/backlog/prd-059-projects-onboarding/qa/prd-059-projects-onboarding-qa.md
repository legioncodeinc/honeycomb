# QA Report: PRD-059 Projects Onboarding (+ IRD-122 / IRD-123)

**Plan documents:**
- `library/requirements/backlog/prd-059-projects-onboarding/prd-059-projects-onboarding-index.md` (+ sub-PRDs 059a/b/c/d)
- `library/issues/backlog/ird-122-dashboard-scope-switcher-viewer-only/ird-122-dashboard-scope-switcher-viewer-only-index.md`
- `library/issues/backlog/ird-123-gate-capture-until-first-project-bind/ird-123-gate-capture-until-first-project-bind-index.md`
- Ledger: `library/ledger/EXECUTION_LEDGER-prd-059.md` (34 ACs)

**Audit date:** 2026-06-26
**Base branch:** `main`
**Head:** `feat/prd-059-projects-onboarding-impl` @ `dc1888b`
**Auditor:** quality-worker-bee
**Order check:** PASS — `security-worker-bee` ran first (found + fixed one HIGH symlink-traversal in `fs/browse`; the fix `dc1888b` is the HEAD commit and is covered by a regression test). Quality runs after security, as required.

## Summary

**Overall verdict: PASS.** All 34 acceptance criteria across PRD-059a/b/c/d, IRD-122, and IRD-123 are genuinely implemented and each is traced to code plus a passing, behavior-asserting test (not a stub, mock-in-production, or TODO). The four required gates are green: `npm run typecheck` (exit 0), `npm run dup` (0.51% < 7), `npm run audit:sql` (clean — every interpolation routes through an escaping helper), and the targeted `vitest` run over the 059 surfaces (42 files / 390 tests passing). The first-run capture gate is wired ON in production (`assemble.ts:736`) and the security symlink fix is present and tested. The only findings are two non-blocking documentation-drift warnings (stale code comments that under-describe shipped behavior) plus the pre-existing `hook-runtime` flake, which is out of scope per the brief (reproduced on a clean baseline).

**Result: 34 VERIFIED / 0 PARTIAL / 0 FAIL. No merge blockers.**

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All 34 ACs implemented + tested; daemon routes mounted in production (`assemble.ts:1721/1738/1757`), gate ON (`assemble.ts:736`). |
| Correctness   | ✅ | Capture gate asserts INSERT absence (real SQL artifact); switch-persist re-mints before save; counts fail-soft; symlink guard compares real paths. |
| Alignment     | ✅ | Vocabulary, file locations, and design-fork "leans" match the plans (per-device gate, daemon-served browse, org/workspace persist + project view-filter). |
| Gaps          | ✅ | Implied behaviors covered: fail-soft reads, daemon-down CTA + CLI fallback, no-flash gating, reserved-inbox rejection, tenancy guards. |
| Detrimental   | ✅ | No security smell, no scope creep, no dead code. Two stale comments (doc drift) noted as Warnings. |

## Gate Results

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npm run typecheck` | ✅ exit 0 |
| Duplication | `npm run dup` | ✅ 451 (0.51%) clones, threshold 7 |
| SQL safety | `npm run audit:sql` | ✅ scanned 232 files — "every SQL interpolation routes through an escaping helper" |
| 059 tests | `npx vitest run tests/daemon/runtime/projects tests/dashboard/web tests/hooks/shared` | ✅ 42 files / 390 tests passed |

Pre-existing flake (OUT OF SCOPE, not a 059 defect): `tests/hooks/runtime/hook-runtime.test.ts` times out 13 tests at the default 5s vitest timeout; reproduced on a clean baseline with all 059 changes stashed. It is a slow-loopback-I/O timeout, not a 059 regression. File a separate infra issue to raise `--test-timeout` or de-flake.

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Stale "daemon does NOT yet aggregate / honest dash" comments contradict shipped Wave-3 behavior**, `src/dashboard/web/pages/projects.tsx:11-14`, `:79-89`, `:133-135`

  The module/function header comments say the per-project state fields (bound paths, git remote, last capture, memory/session counts) "render as an honest '—'" because "the Wave-1 daemon does NOT yet aggregate" them. That was true at Wave 1, but Wave 3 (`scope-enumeration-api.ts` + `project-counts.ts`) now serves those fields and the page renders the real values (lines 136-141; the `projects-page.test.tsx` "renders the REAL per-project state … not placeholders" case asserts `12 / 4`, `github.com/acme/api`, the bound path, and `never`). The code is correct; only the comments are wrong. Documentation drift, not a functional gap — refresh the comments so they don't mislead the next reader.

  ```tsx
  // projects.tsx:79-83 (stale): "render as an honest '—' (the Wave-1 registry read serves
  // name + boundLocally only — the per-project aggregates are a deferred daemon read ...)"
  // Reality: MetaCell renders project.boundPaths / project.remote / humanizeCapture / counts.
  ```

- [ ] **Inline comment claims FolderPicker is "not reused" in the import flow, but a sibling FolderSelect is used**, `src/dashboard/web/pages/projects.tsx:298-301`

  The `ImportModal` doc comment says "`FolderPicker` in select-only mode is not reused — instead the user picks the folder here," and a later block (lines 326-329) describes intercepting the picker's bind. The actual implementation uses a separate `FolderSelect` component (lines 431-506) for the step-2 folder choice. The behavior is correct and tested (d-AC-1/d-AC-2 via `bindExistingProject`), but the narrative comment describes an approach that was not taken — minor doc drift worth a one-line cleanup.

## Suggestions (consider improving)

- [ ] **Consider raising the `hook-runtime` suite timeout in the shared vitest config**, `tests/hooks/runtime/hook-runtime.test.ts`

  Out of scope for 059, but the 13-test timeout flake is a standing papercut for anyone running the hooks suite. A per-file `--test-timeout` bump (or splitting the slow loopback-I/O cases) would make the suite green deterministically. Track as a separate infra issue.

## IRD Resolution Status

- **IRD-123 (gate capture until first project bind):** ✅ RESOLVED. Implemented as PRD-059a. The capture handler no-ops on a closed gate with a clean `{ ok: true, gated: true }` ack (`capture-handler.ts:203-205`), the gate is a pure local-cache read (`hasBoundProjectOnDisk`, no DeepLake), the once-per-session notice fires from the session-start seam, and the gate is wired ON in production. 123-AC-1..5 == a-AC-1..5, all VERIFIED.
- **IRD-122 (dashboard scope switcher viewer-only):** ✅ RESOLVED. Org/workspace selections now POST the daemon persist routes (`scope-switch-api.ts`: org re-mints + `saveDiskCredentials`, workspace persists `workspaceId`), the project dropdown is explicitly relabeled "project · view filter" with a caption, and every switch surfaces `switchFeedback` so no change is a silent no-op. 122-AC-1..4 all VERIFIED.

## Plan Item Traceability

| #        | Plan Requirement (abbrev) | Status | Implementation Location | Evidence (test) |
|----------|---------------------------|--------|-------------------------|-----------------|
| M-AC-1   | Zero bound projects → no row, "bind to start" prompt | ✅ VERIFIED | `capture-handler.ts:203-205,326-341`; `session-start.ts:43-45,131-142` | `capture-first-run-gate.test.ts`; `onboarding-notice.test.ts` |
| M-AC-2   | Zero-state → dashboard "Pick a folder to start" CTA | ✅ VERIFIED | `needs-project.tsx:75-122`; `app.tsx:65-86` | `first-run-cta.test.tsx` |
| M-AC-3   | Pick folder → absolute path bound, capture begins, appears | ✅ VERIFIED | `onboarding-api.ts:299-312`; `folder-picker.tsx:153-168` | `onboarding-api.test.ts`; `folder-picker.test.tsx` |
| M-AC-4   | Projects page lists sourced projects + Add | ✅ VERIFIED | `pages/projects.tsx:568-647`; `registry.tsx` | `projects-page.test.tsx` |
| M-AC-5   | Import existing registry project → bind same project_id | ✅ VERIFIED | `onboarding-api.ts:315-327`; `pages/projects.tsx:303-424` | `projects-page.test.tsx`; `onboarding-api.test.ts` |
| M-AC-6   | Switcher persists real scope change or labeled view-filter | ✅ VERIFIED | `scope-switch-api.ts`; `scope-context.tsx:257-315,434-454` | `scope-switch-persist.test.tsx` |
| a-AC-1   | Zero projects → no sessions/memory/memory_jobs row, no job | ✅ VERIFIED | `capture-handler.ts:196-205` | `capture-first-run-gate.test.ts` (asserts INSERT absent + 0 enqueued) |
| a-AC-2   | Suppressed → one "bind a project" notice per session | ✅ VERIFIED | `session-start.ts:131-142,179-190` | `onboarding-notice.test.ts` |
| a-AC-3   | Gate resolves from local store, no DeepLake call | ✅ VERIFIED | `project-resolver.ts:649-662` (`hasBoundProjectOnDisk`) | `onboarding-notice.test.ts` (disk-backed); `capture-first-run-gate.test.ts` (0 requests) |
| a-AC-4   | After first bind → capture proceeds + persists | ✅ VERIFIED | `capture-handler.ts:330-341` | `capture-first-run-gate.test.ts` (201 + 'proj-api') |
| a-AC-5   | ≥1 project → unbound folder hits `__unsorted__` inbox | ✅ VERIFIED | `capture-handler.ts:343-356`; `project-resolver.ts:598-601` | `capture-first-run-gate.test.ts` (inbox fallback) |
| b-AC-1   | Zero projects → CTA is primary dashboard content | ✅ VERIFIED | `app.tsx:74-83` (gated on `projectsHydrated`, no flash) | `first-run-cta.test.tsx` |
| b-AC-2   | Picker enumerated by daemon (loopback), absolute path | ✅ VERIFIED | `onboarding-api.ts:283-296`; `folder-picker.tsx` | `onboarding-api.test.ts` (real absolute path) |
| b-AC-3   | Git folder → name pre-filled from canonical remote | ✅ VERIFIED | `onboarding-api.ts:153-166` (`suggestProjectId`) | `onboarding-api.test.ts` (projectId 'api' from remote) |
| b-AC-4   | Confirm → bind written, gate opens, advances to Projects | ✅ VERIFIED | `onboarding-api.ts:299-312`; `needs-project.tsx:78-85` | `onboarding-api.test.ts`; `first-run-cta.test.tsx` |
| b-AC-5   | Daemon down/local-off → plain message + CLI fallback | ✅ VERIFIED | `folder-picker.tsx:130-186` (`CLI_BIND_HINT`); `onboarding-api.ts:284` (team 404) | `folder-picker.test.tsx`; `onboarding-api.test.ts` (team mode) |
| c-AC-1   | Projects list + state (paths, remote, counts, last capture) | ✅ VERIFIED | `scope-enumeration-api.ts:266-322`; `project-counts.ts`; `pages/projects.tsx:133-141` | `scope-enumeration-api.test.ts`; `project-counts.test.ts`; `projects-page.test.tsx` (real values) |
| c-AC-2   | `__unsorted__` inbox shown distinctly with size | ✅ VERIFIED | `project-counts.ts:120-121` (`''`→inbox fold); `pages/projects.tsx:203-214` | `project-counts.test.ts`; `projects-page.test.tsx` (inbox size 9) |
| c-AC-3   | Add a project (top-right) runs folder-pick→bind | ✅ VERIFIED | `pages/projects.tsx:224-255,618-626` | `projects-page.test.tsx` (+Add menu, picker reveal) |
| c-AC-4   | Unbind → folder binding removed, registry+data untouched | ✅ VERIFIED | `onboarding-api.ts:330-341,424-433`; `pages/projects.tsx:98-113` | `onboarding-api.test.ts` (registry intact); `projects-page.test.tsx` |
| c-AC-5   | Open project → other surfaces re-scope | ✅ VERIFIED | `pages/projects.tsx:591-596` (`setScope`) | `projects-page.test.tsx` (persists to scope/localStorage) |
| d-AC-1   | Import lists registry projects without local binding | ✅ VERIFIED | `scope-enumeration-api.ts:276-315` (`?unbound=1`); `pages/projects.tsx:313-324` | `scope-projects-import-filter.test.ts`; `projects-page.test.tsx` |
| d-AC-2   | Select registry project + folder → binds same project_id | ✅ VERIFIED | `onboarding-api.ts:315-327` (`bind-existing`) | `onboarding-api.test.ts` (binds 'existing-api', no remote) |
| d-AC-3   | Imported project recall includes other-device memories | ✅ VERIFIED | bind-to-existing writes shared `project_id` (`onboarding-api.ts:325`); recall is the existing 049 scope path (no new code) | `onboarding-api.test.ts` (shared id proven); inherits 049 recall (verified prior) |
| d-AC-4   | Git-remote match surfaced as suggestion (hint only) | ✅ VERIFIED | `onboarding-api.ts:79-80,252` (git marker); `:153-166` (`suggestProjectId`) | `onboarding-api.test.ts` (isGitRepo + suggestion) |
| 122-AC-1 | Org/workspace switch persists via daemon, or view-only | ✅ VERIFIED | `scope-switch-api.ts`; `scope-context.tsx:257-303` | `scope-switch-persist.test.tsx` |
| 122-AC-2 | Org change persists → re-mints org-bound token | ✅ VERIFIED | `scope-switch-api.ts:167-214` (re-mint before save) | `scope-switch-api.test.ts` |
| 122-AC-3 | Project dropdown clearly a view filter | ✅ VERIFIED | `scope-context.tsx:437-454` (label + caption) | `scope-switch-persist.test.tsx` (view filter + hint) |
| 122-AC-4 | No switcher change is a silent no-op | ✅ VERIFIED | `scope-context.tsx:108,260-312,459-477` (`switchFeedback`) | `scope-switch-persist.test.tsx` (persisted/view/error) |
| 123-AC-1 | Zero projects → no capture rows/jobs (== a-AC-1) | ✅ VERIFIED | (== a-AC-1) `capture-handler.ts:196-205` | `capture-first-run-gate.test.ts` |
| 123-AC-2 | One "bind a project" notice per session (== a-AC-2) | ✅ VERIFIED | (== a-AC-2) `session-start.ts:131-142` | `onboarding-notice.test.ts` |
| 123-AC-3 | Gate from local store, no network (== a-AC-3) | ✅ VERIFIED | (== a-AC-3) `project-resolver.ts:649-662` | `onboarding-notice.test.ts` |
| 123-AC-4 | After first bind → capture proceeds (== a-AC-4) | ✅ VERIFIED | (== a-AC-4) `capture-handler.ts:330-341` | `capture-first-run-gate.test.ts` |
| 123-AC-5 | ≥1 project → inbox fallback resumes (== a-AC-5) | ✅ VERIFIED | (== a-AC-5) `capture-handler.ts:343-356` | `capture-first-run-gate.test.ts` |

### Non-Goals (alignment check)

| NG | Non-Goal | Honored? |
|----|----------|----------|
| NG-059a | Do not remove the `__unsorted__` inbox; gate is first-run-only | ✅ Inbox fallback resumes after first bind (a-AC-5). |
| NG-059b | No auto-scan for repos; no native OS dialog | ✅ Daemon-served browse tree only; user picks explicitly. |
| NG-059c | No destructive registry CRUD; unbind is local-only | ✅ `unbind` removes local binding, registry row untouched (c-AC-4 test). |
| NG-059d | No new-project creation; import is deliberate per-folder | ✅ `bind-existing` requires an explicit `projectId` + folder. |
| NG-122  | No change to cwd-driven project resolution / tenancy model | ✅ Project axis stays viewer-side; only org/workspace persist. |

## Files Changed (PRD-059 implementation surface)

- `src/daemon/runtime/assemble.ts` (M) — wires `firstRunGate: true` on capture (line 736); mounts onboarding + scope-switch APIs under local-mode gate.
- `src/daemon/runtime/capture/attach.ts` (M) — threads `firstRunGate`/`projectsDir` to the capture handler.
- `src/daemon/runtime/capture/capture-handler.ts` (M) — first-run gate predicate + no-op gated ack (a-AC-1/3/4/5).
- `src/daemon/runtime/projects/onboarding-api.ts` (A) — `fs/browse` + `projects/{bind,bind-existing,unbind}`; symlink-traversal guard (security fix).
- `src/daemon/runtime/projects/project-counts.ts` (A) — fail-soft grouped per-project aggregates + inbox fold (c-AC-1/2).
- `src/daemon/runtime/projects/scope-enumeration-api.ts` (M) — enriches `scope/projects` with paths/remote/counts + `?unbound=1` (c-AC-1/2, d-AC-1).
- `src/daemon/runtime/projects/scope-switch-api.ts` (A) — org/workspace persist routes (122-AC-1/2).
- `src/daemon/storage/catalog/memories.ts`, `sessions-summaries.ts` (M) — `buildMemory/SessionCountsByProjectSql` (sqlIdent-only, audit-clean).
- `src/hooks/shared/project-resolver.ts` (M) — `hasBoundProject` / `hasBoundProjectOnDisk` pure local predicate (a-AC-3).
- `src/hooks/shared/session-start.ts` (M) — `BIND_PROJECT_NOTICE` + once-per-session onboarding notice (a-AC-2).
- `src/hooks/shared/contracts.ts` (M) — `OnboardingNoticeGate` seam type.
- `src/dashboard/web/folder-picker.tsx` (A) — daemon-served picker + daemon-down CLI fallback (b-AC-2..5).
- `src/dashboard/web/pages/projects.tsx` (A) — Projects page, +Add menu, import modal, unbind/open (c-AC-1..5, d-AC-1/2 UI). Stale comments (see Warnings).
- `src/dashboard/web/needs-project.tsx` (M) — first-run CTA (b-AC-1).
- `src/dashboard/web/scope-context.tsx` (M) — org/workspace persist via daemon, project view-filter label, `switchFeedback` (122-AC-1/3/4).
- `src/dashboard/web/app.tsx`, `registry.tsx`, `wire.ts` (M) — first-run gating, Projects route, wire methods.
- Tests (A): `capture-first-run-gate.test.ts`, `onboarding-api.test.ts`, `project-counts.test.ts`, `scope-enumeration-api.test.ts`, `scope-projects-import-filter.test.ts`, `scope-switch-api.test.ts`, `onboarding-notice.test.ts`, `first-run-cta.test.tsx`, `folder-picker.test.tsx`, `projects-page.test.tsx`, `scope-switch-persist.test.tsx`.
