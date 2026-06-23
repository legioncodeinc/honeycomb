# Skillify conventions (PRD-016) — READ BEFORE FILLING A WAVE-2 STUB

Wave 1 (016b skills-writes + the contracts/seams) established these. Wave 2
(016a trace miner ‖ 016c skill install) follows them **verbatim**. The whole point of
the seam wiring is that a Wave-2 Bee edits **only its own module + its own test file**
and never touches the contracts, the `skills-write.ts` / `watermark.ts` path, the
catalog, or `server.ts`.

---

## 1. The thesis (every rule descends from this)

- **Mine recurring session patterns → crystallize a reusable `SKILL.md` → propagate to
  the team.** The local half (session-end, 016a) mines + gates; 016b writes; the collab
  half (session-start, 016c) pulls + fans out.
- **A skill is APPEND-ONLY, VERSION-BUMPED.** Every edit is a NEW version row; the
  ACTIVE skill is the HIGHEST version per `(name, author)`. (See §2.)
- **The hook SIGNALS the daemon; the daemon owns the ONLY DeepLake connection.** No hook
  and no thin-client code opens DeepLake. 016b runs INSIDE the daemon and writes through
  the daemon's own storage path (`SkillStore`); 016a's trigger and 016c's pull signal
  the daemon over port 3850. (See §4.)

## 2. Append-only, version-bumped — the non-negotiable mechanic

**b-AC-1 LITERALLY requires "a new version row, never an in-place UPDATE."** A skills
edit is NEVER a mutate of the prior row:

> read the current MAX(version) for the skill's logical id (`<name>--<author>`) → INSERT
> a fresh row at version N+1. The prior version stays on disk.

The ACTIVE skill for a logical id is its **highest-version row**, resolved
**poll-convergently** (`SkillStore.readActive` / `maxVersion` poll `RESOLVE_POLLS`
times). The reasons are the same ones `memory_jobs`, `ontology/supersede.ts`,
`sources/lifecycle.ts`, and `pipeline/graph-persist.ts` all hit and solved live:

- An **in-place UPDATE** on this backend coalesces rapid writes and serves reads from
  segments of differing freshness that flap non-monotonically — a by-id `SET` can never
  converge.
- Versions only ever INCREASE and a higher version is never fictitious, so resolving by
  `MAX(version)` across a bounded poll union converges monotonically to the durable
  current skill.

`SkillStore` (in `skills-write.ts`) has **NO `update` method** by construction. **Do not
add an in-place UPDATE anywhere in this subsystem.** A second KEEP for the same
`(name, author)` lands version N+1; the prior is retained (assert NO UPDATE was emitted,
like the sources / ontology tests).

## 3. The logical id is `<name>--<author>`

Every version of a skill by the same author shares the id `skillLogicalId(name, author)`
(`<name>--<author>`). A re-KEEP bumps the same chain; a cross-author MERGE records under
the **target's** id so the bump accrues on the original chain (and promotes scope
`me`→`team`). The id format mirrors the 016c install dir
(`~/.claude/skills/<name>--<author>/`). Never derive the chain key without BOTH halves.

## 4. Daemon-only storage (b-AC-6 / c-AC-6)

Every `skills` read/write goes through the **`SkillStore` seam** — in production
`createSkillStore(storage, scope)` over the daemon-side `StorageQuery`; in tests a fake
recording store. The worker NEVER opens DeepLake. The thin-client invariant
(`tests/daemon/storage/invariant.test.ts`) keeps this honest: skillify lives under
`src/daemon/`, and 016a's hook trigger + 016c's pull are thin clients that signal the
daemon. **Do not import `createStorageClient` / anything under `daemon/storage` except
the pure `sql.ts` helpers** in any thin-client code 016a/016c add.

## 5. The catalog is final (`catalog/product.ts` — the `skills` table)

The `skills` table **already exists** and is `pattern: "version-bumped"`, `scope:
"agent"`. Its columns (single-sourced, final — Wave 2 does NOT change one):

`id / name / project_key / scope / install / author / contributors / source_sessions /
description / trigger_text / body / version / agent_id / visibility / created_at /
updated_at`

016b maps onto it: the logical id → `id`; the creator → `author` **and** `agent_id`;
provenance → `source_sessions` (JSON array as TEXT) + `version` + `scope`; the
crystallized markdown body → `body`. `created_by` in the frontmatter is the `author`.
The first write **lazily heals** the table via the 002d write primitives' `withHeal`
wrapper — no prior migration.

## 6. SQL safety (FR-5)

Every dynamic fragment routes through the 002b helpers: `sqlIdent` (identifiers),
`sLiteral` / `eLiteral` (values via the `val.*` constructors). `skills-write.ts` never
hand-quotes a value, and every append goes through the heal-aware `appendOnlyInsert`
(→ guarded `buildInsert`). `npm run audit:sql` scans `src/daemon` and fails CI on a raw
interpolation. A new query helper follows the same rule.

## 7. The gate-CLI shell-out — no API key (016a)

The gate model is **shelled out to the host agent's CLI** (Claude Code / Codex / …),
which already holds the user's auth — **no API key is held by the daemon**. 016a fills
the real shell-out behind the `GateCli` seam as a `spawn` with an **args array, never a
shell string**, so a mined transcript can never command-inject. The 120s timeout →
abort-no-verdict + lock-released-in-`finally` is 016a's. 016b never calls the gate — it
receives the already-computed `GateVerdict`.

## 8. Where each Wave-2 Bee writes

| Sub-PRD | Module (edit this) | Test file (edit this) | Must NOT touch |
|---------|--------------------|-----------------------|----------------|
| 016a trace miner | `miner.ts` (fill the stubbed functions) | `tests/daemon/runtime/skillify/miner.test.ts` | `skills-write.ts`, `watermark.ts`, `contracts.ts`, `catalog/product.ts`, `server.ts` |
| 016c skill install | `install.ts` (fill the stubbed functions) | `tests/daemon/runtime/skillify/install.test.ts` | `skills-write.ts`, `watermark.ts`, `contracts.ts`, the catalog |

016a **consumes** 016b: it hands the verdict + mined session ids to `writeSkill` and the
oldest mined date to the watermark store. 016c **consumes** 016b: a pull reads the
highest-version skills via the SAME read path 016b writes. Neither re-implements the
append-only row or the highest-version read.

## 9. The seams Wave 2 inherits (pinned contracts)

- `MinedPair` — one extracted prompt/answer exchange (`sessionId` / `sessionDate` /
  `prompt` / `answer`). 016a produces; 016b reads only the ids/dates.
- `GateVerdict` — `{ decision: KEEP | MERGE | SKIP, name?, description?, triggerText?,
  body?, target?, targetAuthor? }`. 016a produces; 016b acts.
- `Skill` — the row shape mirroring the `skills` table; logical id `<name>--<author>`.
- `SkillProvenance` — `source_sessions` / `version` / `createdBy` / `scope`.
- `GateCli` — `{ run(prompt): Promise<GateVerdict> }`. The host-CLI shell-out (016a).
  Fake via `createFakeGateCli(verdict)`.
- `SkillInstallTarget` — `{ write(install, name, markdown), read(install, name) }`. The
  local SKILL.md filesystem seam (injectable base dir for tests, b-AC-5). Real impl:
  `createFsInstallTarget({ projectDir, globalDir })`.
- `SkillStore` — `{ maxVersion(id), readActive(id), appendVersion(skill) }`. The
  append-only daemon storage path (b-AC-6). NO `update` by construction. Real impl:
  `createSkillStore(storage, scope, resolveTable?)`.
- `WatermarkStore` — `{ read(projectKey), advance(projectKey, minedDates) }`. Advances
  to the OLDEST mined date (b-AC-2). Real impl: `createWatermarkStore(baseDir?)`.

## 10. Live-test isolation (the proven technique)

The opt-in live itest (`tests/integration/skills-write-live.itest.ts`) appends two
versions of a skill to the REAL backend and asserts the highest-version read returns v2,
**poll-convergent**. Isolation is **native throwaway tables**: inject `resolveTable` into
`createSkillStore` so the heal CREATEs a per-run `ci_skills_<runid>` table directly —
**NOT a SQL-string proxy** (which races the heal's CREATE/introspect/ALTER and corrupts a
fresh table). `queryTimeoutMs: 120_000`; DROP the table in `afterAll`. Do NOT run it
locally (no creds) — the orchestrator runs it.

## 11. Daemon-assembly + hook wiring — LIVE by PRD-045f

The skillify **worker** and **hook signal** are wired as of PRD-045f (2026-06-22):

- `buildSkillifyWorker` is called at `assemble.ts:1283`; start at `:1617-1618`;
  stop at `:1694-1696`. The worker leases `["skillify"]` (`worker.ts:187`).
- The session-end stop-counter trigger signals the daemon via
  `src/hooks/shared/session-end.ts` → `POST /api/hooks/session-end` intent `"skillify"`.
- `skillify pull` CLI verb is registered in `contracts.ts:88`; dispatch routes to
  `POST /api/skills/pull` via `storage-handlers.ts:114`.

The seam contracts below remain authoritative for anyone editing the miner, install, or
propagation modules.

## 12. PRD-018 team-skill-sharing hardening (the 018a/b/c layer)

PRD-018 hardens the COLLAB half into a real team-sharing pipeline. The new modules and
where they live (all thin-client EXCEPT the daemon publish endpoint):

| Module | Home | What it owns |
|--------|------|--------------|
| `config.ts` | `daemon-client/skillify` | 018a scope/team/install persistence at `~/.honeycomb/state/skillify/config.json`; **legacy `org`→`team` coercion on READ** (in-memory, file rewritten only on explicit set — D-5). Filesystem-only. |
| `manifest.ts` | `daemon-client/skillify` | 018b pull manifest at `~/.honeycomb/state/skillify/pull-manifest.json` — one record per globally-installed pulled skill; the source of truth for `unpull` + `backfillSymlinks`. Filesystem-only. |
| `install.ts` (extended) | `daemon-client/skillify` | 018b `decideAction` (write / backup-`SKILL.md.bak` / skip / force), `--dry-run`, trusted-table early-exit, empty-author skip, manifest record + `manifestError` surfacing, `unpullSkill`; 018c global-install-only fan-out gating (D-4), self-healing stale links, `backfillSymlinks`. |
| `publish-endpoint.ts` | `daemon/runtime/skillify` | 018a daemon-side publish (append-only, reuses `createSkillStore`) + `selectNewerForOrgUsers` (highest-version-per-id, poll-convergent — D-7). **Reaches DeepLake → daemon-only.** |
| `src/cli/skill.ts` | `cli` | `honeycomb skill scope <me|team> [--users …] [--install …]` + `skill unpull <name>--<author>`. Thin client, injected seams, mirrors `org.ts` / `skillify.ts`. |

Cross-author MERGE lineage (a-AC-4): `skills-write.ts`'s `mergeSkill` stamps the
`SKILLOPT_CONTRIBUTOR = "skillopt"` marker + the original (merging) author into the row's
`contributors` (`Skill.contributors` carries it; `contributorsFor` records it verbatim).

**The daemon-only invariant holds:** the thin-client modules reach the `skills` table ONLY
through the injected `SkillPullClient` / `TrustedTableList` seams; the publish endpoint is the
sole DeepLake-touching 018 module and lives under `src/daemon/`. The symlink/backup logic is
factored into ONE `linkInto` primitive + a `backupExisting` helper (no copy-paste — jscpd).

## 13. PRD-045g team-skill-sharing wiring — LIVE

The PRD-018 hook wiring is complete as of PRD-045g (2026-06-22):

- **Auto-pull at session start:** `SessionStartDeps` is built with the real `autoPull`
  seam injected at `runtime.ts:191` (`createSessionStartSeams`). The pull is
  time-budgeted (5 s abort), has a kill-switch, and is fail-soft.
- **Publish endpoint mounted:** `mountSkillPropagationApi` (`skillify/propagation-api.ts`)
  is fired at `assemble.ts:908` via `seams.mountSkillPropagation`; `POST /api/skills`
  publish returns `{published, version}` (no 501).
- **CLI deduplication:** the duplicate `src/cli/skill.ts` and `src/cli/skillify.ts`
  were deleted; `skill` + `skillify` verbs now live in the unified `VERB_TABLE` →
  `buildSkillRequest`.
- **Cross-harness fan-out:** `POST /api/skills/pull` → real pull engine →
  `fanOutSymlinks` into agent roots; re-pull is idempotent (`decideAction` writes 0).

All 21 PRD-018 ACs are DONE/VERIFIED. The "deferred" posture above is historical
context only — do not treat it as current state.
