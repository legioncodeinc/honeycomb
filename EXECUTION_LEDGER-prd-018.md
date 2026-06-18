# EXECUTION LEDGER — PRD-018 Team Skill Sharing

> Orchestrator: `/the-smoker` Bee Army · Branch: `prd-018-team-skill-sharing` · Started 2026-06-18
> Status: **WAVE-2 COMPLETE** — 21/21 ACs VERIFIED; all gates green (ci/build/audit:sql/audit:openclaw/invariant). Hook-assembly wiring deferred (documented §13 CONVENTIONS). Awaiting Wave-3 security→quality close-out.

PRD-018 is the **team-grade hardening layer** on the skillify foundation PRD-016 shipped.
016 already proved: append-only version-bumped publish (`skills-write.ts`), basic `autoPull`
(5s timeout + swallow + disabled-env + unauth-skip), basic symlink fan-out
(`fanOutSymlinks` / `createDefaultAgentRoots`), highest-version-per-id pull read
(`pull-client.ts`). 018 makes it a real team-sharing pipeline.

## Gap analysis (what 016 already has vs what 018 ADDS)

| Sub | Already in 016 | 018 ADDS (the real work) |
|---|---|---|
| **018a** publish/scope | append-only versioned publish; daemon-only insert; scope-on-row (me/team); cross-author→team; highest-version read | scope **config persistence** `~/.honeycomb/state/skillify/config.json` `{scope,team,install}`; `honeycomb skill scope team --users a,b` CLI; legacy **`org`→`team` coercion** on read; `SKILLOPT_CONTRIBUTOR="skillopt"` marker + original-author lineage on cross-author merge; daemon publish/select endpoint seam |
| **018b** auto-pull | autoPull 5s/swallow/disabled/unauth; idempotent skip-if-local-newer; fan-out call | **`decideAction`** policy (write / backup-to-`SKILL.md.bak` / skip / force); **`--dry-run`**; **trusted-table-list early-exit** when `skills` absent; **empty-author local-slot protection**; **pull manifest** (`dirName,name,author,projectKey,remoteVersion,install,installRoot,pulledAt,symlinks`) + `honeycomb skill unpull` + `manifestError` surfacing |
| **018c** fan-out/backfill | per-row fan-out; idempotent existing-link; win32 swallow; path-safety; detect roots | **global-install-only** gating (no fan-out for project pulls); **self-healing stale links** (unlink+recreate when pointing at a different canonical path); **`backfillSymlinks`** over the manifest (closes the `skipped`-path gap so newly-installed agents inherit prior pulls); bounded ~1 lstat/(entry,root) |

## Decisions
- **D-1 Cohesive single-implementer Wave 2.** The three sub-PRDs all edit the SAME 2–3 files
  (`src/daemon-client/skillify/install.ts`, `contracts.ts`, `src/cli/`). Parallel agents would
  race on overlapping files. So Wave 2 is ONE domain agent (`retrieval-worker-bee`, the skillify/
  propagation owner) doing 018a+b+c as one coherent pass, NOT three racing fan-out agents.
- **D-2 Backup is `SKILL.md.bak` next to the canonical file** (FR-3/b-AC-3), not a versioned dir.
- **D-3 Manifest lives on disk** under `~/.honeycomb/state/skillify/pull-manifest.json` (NOT DeepLake;
  matches the watermark/lock state-root convention already in miner.ts/watermark.ts). One record per
  globally-installed pulled entry; `unpull` reverses pull-managed entries only.
- **D-4 Global-install-only fan-out + backfill.** Project-local pulls (`<cwd>/.claude/skills/`) never
  fan out and never backfill (FR-3/c-AC-3/c-AC-5). The `install` field on the pull decides.
- **D-5 Legacy `org` coercion on READ** (not a file migration) — keep old config files working
  (a-AC-3); the in-memory value becomes `team`, the file is rewritten only on the next explicit set.
- **D-6 Daemon-only invariant preserved.** All new pull/manifest/fan-out logic stays in
  `src/daemon-client/skillify/` (a NON-daemon root the `invariant.test.ts` scans) — it reaches the
  `skills` table ONLY through the injected `SkillPullClient`/`DaemonDispatch` seam, never opens DeepLake.
  The new daemon publish/select endpoint lives in `src/daemon/` behind the same seam.
- **D-7 Append-only / version-bumped reads stay poll-convergent** (the live DeepLake lesson): the
  select-newer-for-org-users read takes highest-version-per-(name,author) across `RESOLVE_POLLS`.

## Wave plan
- **Wave 1 — scaffold (typescript-node-worker-bee).** config.ts (scope/team/install persistence + org
  coercion), manifest.ts (record/read/remove types + recordPull/removePull seams), decideAction + backfill
  STUBS with honest contracts, `src/cli/skill.ts` skeleton (`scope`/`unpull` verbs), daemon publish/select
  endpoint seam stub, index barrel exports, CONVENTIONS.md. Plus this ledger's AC matrix pre-filled. No
  behavior change to existing green tests.
- **Wave 2 — implement (retrieval-worker-bee).** Fill 018a (scope config + CLI + coercion + skillopt
  lineage + publish endpoint), 018b (decideAction + dry-run + trusted-table early-exit + empty-author skip +
  manifest + unpull), 018c (global-only gating + stale-link self-heal + backfillSymlinks). AC-named Vitest
  for every AC. A live itest (publish a versioned skill through the daemon → select-newer → assert highest
  version) using the native throwaway-table `resolveTable` seam. Green all gates.
- **Wave 3 — security (opus) → quality (sonnet).** Path-traversal on symlink targets, manifest-driven
  `unlink` safety (never unlink outside detected roots / canonical dir), backup-file write safety, no
  token in logs, the daemon-only invariant, decideAction force-path safety. Then quality AC-by-AC.

## Acceptance-criteria matrix (21 tracked)

### Index ACs
| ID | Criterion | State |
|---|---|---|
| AC-1 | publish → new `v=N+1` row, me/team scope, readers ORDER BY version DESC | **VERIFIED** — `publish-endpoint.test.ts` "a-AC-5 / index-AC-1 select-newer resolves the HIGHEST version per (name, author) via MAX(version)" + "a-AC-1 publish appends a version-bumped row (INSERT) and NEVER an in-place UPDATE" |
| AC-2 | teammate publishes newer → auto-pull writes it within seconds; no-change re-run touches no files | **VERIFIED** — `pull-018.test.ts` "index-AC-2 a teammate's newer skill is written within a pull; a no-change re-run touches no files" |
| AC-3 | global-install pull → symlink in every detected non-Claude root → canonical dir | **VERIFIED** — `pull-018.test.ts` "index-AC-3 a global pull symlinks into every detected non-Claude root → the canonical dir" |

### 018a — publish/version/scope
| ID | Criterion | State |
|---|---|---|
| a-AC-1 | republish at vN → new row vN+1, prior preserved | **VERIFIED** — `publish-endpoint.test.ts` "a-AC-1 publish appends a version-bumped row (INSERT) and NEVER an in-place UPDATE" (+ live `skill-publish-pull-live.itest.ts`) |
| a-AC-2 | `skill scope team --users alice,bob` → publishes carry team scope + contributor list | **VERIFIED** — `skill.test.ts` "a-AC-2 `skill scope team --users alice,bob` persists team scope + the contributor list" |
| a-AC-3 | config with legacy `org` scope → coerced to `team` on read | **VERIFIED** — `config.test.ts` "a-AC-3 a config with the legacy `org` scope is coerced to `team` on read" + "...NOT rewritten on read (D-5)" + `skill.test.ts` "a-AC-3 the CLI scope write migrates a legacy `org` config" |
| a-AC-4 | cross-author merge → row records `skillopt` marker + original author | **VERIFIED** — `publish-endpoint.test.ts` "a-AC-4 a cross-author MERGE stamps the `skillopt` marker + the original author in contributors" |
| a-AC-5 | multi-version reader → takes highest via ORDER BY version DESC | **VERIFIED** — `publish-endpoint.test.ts` "a-AC-5 / index-AC-1 select-newer resolves the HIGHEST version per (name, author) via MAX(version)" (+ live itest) |
| a-AC-6 | any publish → goes through daemon, not direct DeepLake | **VERIFIED** — `publish-endpoint.test.ts` "a-AC-6 every endpoint statement carries the scope (goes through the daemon storage path)" + `invariant.test.ts` (3/3 green) |

### 018b — idempotent auto-pull
| ID | Criterion | State |
|---|---|---|
| b-AC-1 | remote at-or-older than local → skipped, no file written | **VERIFIED** — `pull-018.test.ts` "b-AC-1 remote at-or-older than local → skip" (decideAction) + "b-AC-1 a remote at-or-older than local is skipped and no file is written" (pull) |
| b-AC-2 | `skills` table absent → detect via trusted table list, skip SELECT, no error log | **VERIFIED** — `pull-018.test.ts` "b-AC-2 the `skills` table absent → SELECT skipped, no error, no store query" (+ present-list + fail-open variants) |
| b-AC-3 | remote newer → back up existing to `SKILL.md.bak`, write newer | **VERIFIED** — `pull-018.test.ts` "b-AC-3 a remote newer than local → the existing SKILL.md is backed up to SKILL.md.bak, the newer is written" |
| b-AC-4 | `HONEYCOMB_AUTOPULL_DISABLED=1` or unauth → no pull, no warning | **VERIFIED** — `pull-018.test.ts` "b-AC-4 HONEYCOMB_AUTOPULL_DISABLED=1 → auto-pull does not run" + "b-AC-4 an unauthenticated session → auto-pull skips silently" |
| b-AC-5 | empty-author remote skill → skipped (protect local-mined slot) | **VERIFIED** — `pull-018.test.ts` "b-AC-5 a remote skill with an empty author is skipped (protect the local-mined slot)" |
| b-AC-6 | daemon unreachable → 5s timeout, swallow, session still starts | **VERIFIED** — `pull-018.test.ts` "b-AC-6 the daemon unreachable → 5s timeout, swallow, the call still resolves" + "b-AC-6 a slow store loses the race to the timeout bound" |

### 018c — symlink fan-out + backfill
| ID | Criterion | State |
|---|---|---|
| c-AC-1 | global pull → symlink in each detected root → canonical; re-run no-op for correct links | **VERIFIED** — `pull-018.test.ts` "c-AC-1 a global pull fans a symlink into each other root → the canonical dir" + "c-AC-1 the fanned-out entry is a real symlink to the canonical dir" (CAN_SYMLINK) |
| c-AC-2 | new agent installed after prior pulls → next pull's backfill links every global skill into it | **VERIFIED** — `pull-018.test.ts` "c-AC-2 a newly-installed agent inherits prior pulls via backfill (the skipped-path gap)" (CAN_SYMLINK) + "backfillSymlinks only re-fans GLOBAL manifest entries" |
| c-AC-3 | project-local pull → no fan-out | **VERIFIED** — `pull-018.test.ts` "c-AC-3 a project-local pull never fans out (no symlinks)" + "c-AC-3 a project-local pull records NOTHING in the manifest" |
| c-AC-4 | stale symlink (different canonical path) → unlinked + recreated | **VERIFIED** — `pull-018.test.ts` "c-AC-4 a stale symlink (different canonical path) is unlinked + recreated" (CAN_SYMLINK) |
| c-AC-5 | dry-run → neither fan-out nor backfill touches filesystem | **VERIFIED** — `pull-018.test.ts` "c-AC-5 a dry-run reports the would-write but touches NOTHING on disk" |
| c-AC-6 | symlink already correct → no change on re-run | **VERIFIED** — `pull-018.test.ts` "c-AC-6 a re-run leaves a correct link untouched (idempotent no-op)" (CAN_SYMLINK; asserts unchanged mtime) |

**Status: 21/21 VERIFIED.** All AC-named Vitest tests green under `npm run ci`.

## Watchdog (live lessons / fixes / limitations)

### Gate results (Wave 2 close-out, 2026-06-18)
- `npm run ci` → **exit 0** — 1178 passed, 4 skipped (1182), 103 files (typecheck + jscpd + vitest + audit:sql).
- `npm run build` → **exit 0** — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed-daemon bundle.
- `npm run audit:openclaw` → **exit 0** — no findings.
- `npm run audit:sql` → **exit 0** — 139 files scanned, every interpolation escaped.
- `tests/daemon/storage/invariant.test.ts` → **3/3 green** — the daemon-only invariant holds; all new pull/manifest/config/decideAction logic is under `src/daemon-client/skillify/`, the publish endpoint under `src/daemon/`.
- jscpd → 0.58% duplicated tokens (threshold 7). One flagged clone: `publish-endpoint.ts` `buildSelectNewerSql` vs `pull-client.ts` `buildLatestSkillsSql` — INTENTIONAL: the daemon-side and thin-client SQL builders cannot share a module (daemon-only invariant forbids the thin client importing the daemon endpoint). Well under threshold.

### Implementation notes for the watchdog
- **symlinksCreated counts CHANGES only.** The shared `linkInto` primitive returns
  `created | healed | already | non-link | failed`; `fanOutSymlinks` counts only
  `created`+`healed`. This is why running the per-row fan-out AND `backfillSymlinks` in the
  same global pull does NOT double-count — backfill over already-correct links reports 0. A
  prior draft counted "already" links too and inflated the total (caught + fixed in test).
- **`PullDeps.install` defaults to `global`.** The canonical `~/.claude/skills` pull is a
  global install; a project-local pull opts in with `install: "project"`. This keeps the
  016c tests (which call `pull({client, roots})`) green while honoring D-4 global-only gating.
- **`decideAction` treats an unreadable local version (`null` with a present file) as
  backup-write** — a garbled local SKILL.md never blocks a newer remote.
- **trusted-table early-exit is fail-OPEN** — a `null` table list (could-not-determine)
  proceeds with the SELECT, so a transient list failure never silently disables pulls forever.
- **`unpull` / stale-link `unlink` safety floor:** both go through `linkState`, which only
  acts on a path that is a SYMLINK resolving (via `readlinkSync` + `resolve()` equality) to
  OUR canonical dir. A non-symlink, or a link pointing elsewhere, is left untouched — never a
  followed-out delete of a real directory.

### DeepLake live-behavior note (for the orchestrator's live run)
- The live itest `tests/integration/skill-publish-pull-live.itest.ts` (gated on
  `HONEYCOMB_DEEPLAKE_TOKEN`, native throwaway-table `ci_skills_<runid>`, DROP in afterAll)
  publishes v1→v2 through `createSkillPublishEndpoint` and asserts `selectNewerForOrgUsers`
  resolves the HIGHEST version (v2) **poll-convergently** (`RESOLVE_POLLS=8`). NOT run locally
  (no creds) — the orchestrator runs it. Expect the same append-only / under-report-never-
  over-report behavior `skills-write-live` already proved on the `skills` shape; the
  select-newer self-join is the same MAX(version)-per-(name,author) shape `pull-client.ts`
  uses, so no new live risk is introduced beyond what 016b already verified.
