# QA Report — Dashboard graph-edges + harness-turns (Item 1 & Item 2)

- **Branch:** `fix/dashboard-graph-edges-and-harness-turns`
- **Auditor:** quality-worker-bee (quality-stinger)
- **Date:** 2026-06-23
- **Scope:** the two dashboard-truthfulness fixes (uncommitted working tree) — Item 1 (graph "0 edges" + `/api/graph` route collision), Item 2 (harness turns = 0 / capture attribution). No single PRD; a two-item bug-fix branch verified against the stated expected outcomes.
- **Ordering:** correct. `security-worker-bee` ran first → PASS, zero remediations, one non-blocking Low (L-1), report at `library/qa/dashboard/2026-06-23-graph-edges-harness-turns-security.md`. No QA report for this branch predated this audit.
- **Verdict:** **PASS**

---

## Summary

Both fixes are real, complete, correct, and locked by behavior-asserting tests. Item 1 replaces the field-name bug (`rec.edges`, a key that never existed in the NetworkX node-link snapshot) with a typed mapper over the `Snapshot` contract that reads `links` (`source`/`target`/`relation`) → `edges` (`from`/`to`/`kind`); `GET /api/graph` is now served by a single owner (`mountGraphApi`) reading the freshest LOCAL snapshot, and the dashboard seam's duplicate handler plus dead `fetchGraphView`/`parseSnapshot` are removed. Item 2 stamps the canonical harness token into `meta.agent` at the shim seam for all six harnesses (including both OpenClaw paths), keeps the harness-provenance `agent` distinct from the per-user `agentId`/`author`, and proves the Harnesses page GROUP BY attributes seeded turns correctly. `npm run ci`, `build`, `audit:sql`, and `audit:openclaw` are all green (253 files / 2855 tests pass, 6 skipped; no `sources/api.test.ts` flake surfaced). No Medium+ findings; nothing blocks merge.

---

## Scorecard

| Axis | Status | Notes |
|---|---|---|
| Completeness | PASS | Both items fully implemented: typed mapper, single-owner route, dead-code removal, six-harness stamp, column split, GROUP BY attribution. |
| Correctness | PASS | Mapper reads `links` (not `edges`); local-snapshot read is consistent with `POST /build` write; `agent`/`agentId` split correct; GROUP BY keyed on `agent` matches `shim.harness`. |
| Alignment | PASS | Wire contracts (`GraphView {built,nodes,edges}`, `HookSessionMeta`) unchanged; behavior matches every stated expected outcome. |
| Gaps | PASS | eventCount:0 deferral is honest and unrelated to the harness page; non-retroactive backfill is stated and acceptable. No gap in this fix. |
| Detrimental Patterns | PASS | No dead code left behind; no `any` at new boundaries (tsc clean); no SQL-safety regression; tests are real, not no-ops. |

---

## Critical Issues (must fix)

None.

---

## Warnings (should fix)

None.

---

## Suggestions (consider improving)

- **S-1 (carried from security L-1, defense-in-depth, non-blocking).** `defaultGraphBaseDir` sanitizer (`src/daemon/runtime/codebase/api.ts:108`) keeps `.` in the allowlist, so a `repo` of `..` would survive; mirrored at `snapshot.ts:198` (`defaultCacheDir`). Not request-reachable today (`identity.repo` is daemon-local: git origin slug / cwd basename), so this is hardening, not a vulnerability. If addressed, fix BOTH helpers in lockstep so the read dir and write dir stay in agreement (collapse a sanitized `.`/`..` key to `"default"`, the same fallback the empty-repo case uses). Suitable for a separate follow-up change — does not block merge.

---

## Item 1 — graph "0 edges" + `/api/graph` route collision

**Expected outcome:** the Graph view returns the full `{built, nodes[], edges[]}` with NON-EMPTY edges, and there is exactly ONE `GET /api/graph` handler.

| Check | Result | Evidence |
|---|---|---|
| Typed mapper reads `links` → `edges` (not the old `rec.edges`) | PASS | `api.ts:159-171` `snapshotToGraphView(snapshot: Snapshot)`: `snapshot.links.map((l) => ({ from: l.source, to: l.target, kind: l.relation }))`; nodes from `snapshot.nodes`. Typed over the `Snapshot` contract (`contracts.ts:532` `Snapshot.links: SnapshotLink[]` with `source`/`target`/`relation`, `contracts.ts:472`), not a loose `any` read — the field-name bug cannot silently recur. |
| Non-empty links → non-empty edges; zero links → empty edges | PASS | `api.test.ts` unit suite: `snapshotWith([{source,target,relation:"imports"}])` → `edges` length 1 `{from,to,kind:"imports"}`; `snapshotWith([])` → `edges == []`, nodes still map (label falls back to `id`). |
| `GET /api/graph` returns full view from freshest LOCAL snapshot | PASS | `api.ts:277-285` `group.get("/")` → `loadFreshestLocalSnapshot(baseDir)` (`api.ts:119-147`, reads `<baseDir>/snapshots/`, the dir `writeSnapshotAtomic` writes at `api.ts:207`). Same local copy `POST /build` writes → re-read immediate, no DeepLake eventual-consistency wait. |
| `built:false` empty state preserved | PASS | `api.ts:282-283`: `snapshot === null ? { built:false, nodes:[], edges:[] } : snapshotToGraphView(...)`. Test `before` asserts `built:false` + empty `nodes`/`edges`. |
| Double-registration genuinely resolved (one handler) | PASS | Dashboard side: `api.test.ts:166-180` — with ONLY `mountDashboardApi` fired, `/api/graph` returns 501 (no handler claims it). Codebase side: `api.test.ts` collision test fires `mountDashboardApi` THEN `mountGraphApi`, and `/api/graph` returns the full nodes+edges view (the single owner wins, no flap). `DASHBOARD_GROUPS.graph` registration removed (`dashboard/api.ts`). |
| Dead `fetchGraphView`/`parseSnapshot` removed | PASS | Both functions + the `SnapshotGraph` interface deleted from `dashboard/api.ts` (diff). No `src/` references remain (grep: only doc/comment mentions). `toStr`/`toNum` retained — still used by `fetchKpisView` and cursor helpers (not orphaned). |
| GraphCanvas/graph-page + Build-graph tests still pass; wire contract unchanged | PASS | `GraphView` contract (`dashboard/contracts.ts:128`) `{built, nodes:[{id,label,kind}], edges:[{from,to,kind}]}` untouched. `graph-canvas.test.tsx` (16), `graph-page.test.tsx` (18), `codebase/api.test.ts` build tests all green. |
| Live 0 → 3550 edges locked by tests | PASS | The two-file fixture (`api.test.ts:48-51`, real cross-file `import`/call) drives a genuine build → `edges.length > 0`, with `from`/`to`/`kind` typed assertions and an explicit `not.toHaveProperty("nodeCount"/"edgeCount")` guard that the GET returns the full view, not the counts-only `/build` body. This regression is locked. |

---

## Item 2 — harness turns = 0 (capture attribution)

**Expected outcome:** a turn captured from harness X is attributed to X, so the Harnesses page shows real `turnsCaptured`/`active`/`lastSeen`.

| Check | Result | Evidence |
|---|---|---|
| All SIX harnesses stamp `meta.agent` with their canonical token | PASS | `normalize.ts:120` `createShim.normalize`: `meta: { ...fullMeta, agent: spec.harness, ... }` (stamped AFTER `...fullMeta` → authoritative). The six `spec.harness` values are `claude-code` / `codex` / `cursor` / `hermes` / `pi` / `openclaw` (shim factories). OpenClaw batch path `shim.ts:128` stamps `OPENCLAW_HARNESS = "openclaw"` (`shim.ts:43`); single-event path routes through `createShim.normalize`. |
| Parameterized test proves stamped token == canonical set | PASS | `tests/hooks/harness-identity-stamp.test.ts` (new, 8 tests): drives the REAL `create<Harness>Shim()` factories over native events; `it.each` asserts `input.meta.agent === harness` for each; final test asserts the stamped `Set` EXACTLY equals the canonical six (`expect([...stamped].sort()).toEqual([...THE_SIX].sort())`). Covers both OpenClaw paths. |
| OpenClaw `deriveMeta` sets ONLY `agentId`, no longer clobbers `agent` | PASS | `shim.ts:88` `openclawDeriveMeta`: `if (match) return { ...base, agentId: match[1] }` — `agent` no longer set. `openclaw/shim.test.ts` asserts `meta.agent` is undefined, `meta.agentId === "alice"`, and the batch row carries `agent === "openclaw"` + `agentId === "alice"` (the openclaw/alice split). |
| Capture write records `sessions.agent = <token>` | PASS | `capture-handler.ts:254` `["agent", val.str(meta.agent)]`; distinct from `["author", val.str(meta.agentId)]` (l.253) and `["agent_id", val.str(meta.agentId)]` (l.257). `capture-handler.test.ts` asserts the INSERT SQL contains `claude-code` (agent) AND `alice` (agent_id), plus a parameterized test over all six tokens reaching the column. |
| harness-api GROUP BY reports >0/true/lastSeen for seeded, 0/false/null for unseeded | PASS | `harness-api.ts:129-134` `SELECT agent, COUNT(*) AS n, MAX(creation_date) AS last FROM "sessions" GROUP BY agent` (all idents via `sqlIdent`, no interpolated value). `harness-api.test.ts` (new suite): seeded `claude-code` → `turnsCaptured>0`/`active:true`/non-null `lastSeen`; `pi` (unseeded) → 0/false/null. |
| `name`↔`agent` token-match guard against future rename | PASS | `harness-api.test.ts` seeds rows keyed on `shim.harness` for every `CANONICAL_SHIMS` entry and asserts each maps to that harness's card (matches `harness-api.ts:155-156` `name = shim.harness; byAgent.get(name)`). A drift between page id and stamped token fails this test. The `agent=''` test proves WHY the pre-fix bug zeroed every harness. |
| `agent` zod boundary stays validated | PASS | `HookSessionMetaSchema.agent: z.string().optional()` (`shared/contracts.ts:700`) — validated, NOT `default("")`. The real stamp is upstream (`normalize.ts` always sets `agent: spec.harness`), so live captures are non-empty. Callers go through the shim seam. |
| eventCount:0 deferral is honest and plan-consistent | PASS (noted) | `eventCount: 0` is an explicit placeholder in `fetchSessionsView` (`dashboard/api.ts:371-373`, OQ-3 deferral to a coordinated read change). The Harnesses page `turnsCaptured` comes from harness-api's OWN `COUNT(*) ... GROUP BY agent` (`harness-api.ts:133`), which does NOT read `fetchSessionsView`/`eventCount`. So the deferral is honest — not a gap in this fix. |
| Backfill: existing `agent=""` rows non-retroactive | PASS (noted) | No destructive migration added (correct). Existing `agent=""` rows attribute to no harness (`harness-api.ts:150` skips empty agent; `agent=''` test confirms). NEW captures attribute correctly (parameterized tests). Accepted behavior. |

---

## DoD gates

| Gate | Command | Result |
|---|---|---|
| Full CI | `npm run ci` (typecheck + jscpd dup + vitest + audit:sql) | **PASS** — 253 files / 2855 tests passed, 6 skipped; no `sources/api.test.ts` flake surfaced |
| Build | `npm run build` (`tsc && esbuild`) | **PASS** — tsc clean (no `any` at new boundaries), all bundles built |
| SQL safety | `npm run audit:sql` | **PASS** — 213 files; every interpolation routes through an escaping helper |
| OpenClaw bundle | `npm run audit:openclaw` | **PASS** — 1 file, no findings vs ClawHub rules |
| Changed/new tests in isolation | `vitest run` (the 6 touched suites) | **PASS** — 91 tests passed (harness-identity-stamp 8, codebase/api 7, harness-api 15, dashboard/api 38, capture-handler 16, openclaw/shim 7) |

Tests are real and behavior-asserting (assert mapped edge `from`/`to`/`kind` values, build a genuine fixture graph, drive real shim factories, assert INSERT SQL content, exercise the GROUP BY with seeded/unseeded rows) — not no-ops.

---

## Plan Item Traceability

| Item | Requirement | Implementation | Test | Status |
|---|---|---|---|---|
| 1 | Typed `links`→`edges` mapper over `Snapshot` | `codebase/api.ts:159-171` | `codebase/api.test.ts` mapper suite | DONE |
| 1 | `GET /api/graph` full view from local snapshot | `codebase/api.ts:277-285`, `:119-147` | `codebase/api.test.ts` full-view test | DONE |
| 1 | `built:false` empty state preserved | `codebase/api.ts:282-283` | `codebase/api.test.ts` `before` assertion | DONE |
| 1 | Single `GET /api/graph` owner (collision resolved) | `dashboard/api.ts` handler removed; `assemble.ts` step 13 sole owner | `dashboard/api.test.ts:166-180` (501) + `codebase/api.test.ts` collision test | DONE |
| 1 | Dead `fetchGraphView`/`parseSnapshot` removed | `dashboard/api.ts` (deleted) | grep: no `src/` refs | DONE |
| 1 | Wire `GraphSchema` contract unchanged | `dashboard/contracts.ts:128` (untouched) | `graph-canvas`/`graph-page` tests pass | DONE |
| 2 | Six harnesses stamp `meta.agent` = canonical token | `normalize.ts:120`; `shim.ts:128`,`:194` | `harness-identity-stamp.test.ts` (6-param + both OpenClaw paths) | DONE |
| 2 | OpenClaw `agent`/`agentId` split | `shim.ts:88` (`agentId` only) | `openclaw/shim.test.ts` split assertions | DONE |
| 2 | Capture writes `sessions.agent = <token>` | `capture-handler.ts:254` | `capture-handler.test.ts` (agent + parameterized) | DONE |
| 2 | GROUP BY attribution >0/0 split | `harness-api.ts:129-134`,`:146-166` | `harness-api.test.ts` seeded/unseeded | DONE |
| 2 | `name`↔`agent` rename guard | `harness-api.ts:155-156` | `harness-api.test.ts` token-match suite | DONE |
| 2 | `agent` zod boundary validated | `shared/contracts.ts:700` | validated via boundary | DONE |
| 2 | eventCount:0 honest deferral | `dashboard/api.ts:371-373` (placeholder) | independent of harness-api | NOTED (acceptable) |
| 2 | Non-retroactive backfill | no migration added | `agent=''` test | NOTED (acceptable) |

---

## Files Changed

| File | Item | Summary |
|---|---|---|
| `src/daemon/runtime/codebase/api.ts` | 1 | Adds typed `snapshotToGraphView` (`links`→`edges`), `loadFreshestLocalSnapshot`, and the single-owner `GET /api/graph` full-view handler. |
| `src/daemon/runtime/dashboard/api.ts` | 1 | Removes duplicate `/api/graph` handler, `DASHBOARD_GROUPS.graph`, and dead `fetchGraphView`/`parseSnapshot`/`SnapshotGraph`. |
| `src/daemon/runtime/assemble.ts` | 1 | Comments documenting single-owner resolution; `mountDashboard` no longer claims `/api/graph` (step 13 `mountGraph` is sole owner). |
| `src/daemon/runtime/dashboard/CONVENTIONS.md` | 1 | Parity: documents route ownership move; drops stale `fetchGraphView` reference. |
| `src/hooks/normalize.ts` | 2 | Stamps `agent: spec.harness` (authoritative, after `...fullMeta`). |
| `src/hooks/openclaw/shim.ts` | 2 | Adds `OPENCLAW_HARNESS`; `deriveMeta` sets only `agentId`; batch path stamps `agent`. |
| `src/hooks/index.ts` | 2 | Exports `OPENCLAW_HARNESS`. |
| `tests/daemon/runtime/codebase/api.test.ts` | 1 | Full-view GET, mapper unit suite, route-collision (both mounts) tests. |
| `tests/daemon/runtime/dashboard/api.test.ts` | 1 | Asserts dashboard does NOT claim `/api/graph` (501). |
| `tests/daemon/runtime/dashboard/harness-api.test.ts` | 2 | Attribution suite: seeded/unseeded + `name`↔`agent` rename guard + `agent=''`. |
| `tests/daemon/runtime/capture/capture-handler.test.ts` | 2 | Asserts `agent` column written; parameterized over six tokens. |
| `tests/hooks/openclaw/shim.test.ts` | 2 | Asserts `openclaw`/`alice` split. |
| `tests/hooks/harness-identity-stamp.test.ts` | 2 | NEW: six-harness stamp + both OpenClaw paths + exact-set match. |
| `library/qa/dashboard/2026-06-23-graph-edges-harness-turns-security.md` | — | Security report (PASS, L-1 only), produced before this audit. |

---

## Residual risk

Low. Both fixes are behavior-proven against the stated expected outcomes, the full CI/build/audit gates are green, the wire contracts are unchanged, and the regressions (0 edges, 0 turns) are each locked by a dedicated failing-if-reverted test. The only open item is the carried-over Low S-1 (defense-in-depth path sanitizer on a daemon-local, non-request-reachable value) — appropriate for a separate follow-up change, not a merge blocker.
