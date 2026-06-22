# EXECUTION LEDGER — PRD-016 Skillify

> /the-smoker run. Branch `prd-016-skillify` off main (PRD-001..015 + CI merged). PR → main.

**Scope:** index + 016a (trace miner: trigger + lock + session fetch + pair extraction + gate-CLI) / 016b (skills writes: SKILL.md + append-only version row + watermark) / 016c (skill install: pull + auto-pull + symlink fan-out). 18 sub-ACs + 3 index. Mine recurring session patterns → crystallize a reusable `SKILL.md` → propagate to the team. Local half (session-end): stop-counter → daemon skillify worker → fetch sessions → extract pairs → gate (KEEP/MERGE/SKIP, precision-over-recall) → write skill + append-only row. Collab half (session-start): auto-pull latest skills + symlink fan-out. **Hooks NEVER talk to DeepLake — they signal the daemon, which owns the worker + the only connection.**

**Builds on (a LOT exists):**
- **`skills` table EXISTS** (`product.ts`, `version-bumped`, scope `agent`) with ALL columns: id/name/project_key/scope/install/author/contributors/source_sessions/description/trigger_text/body/**version**/agent_id/visibility/created_at/updated_at. 016b writes append-only version rows; pull reads highest-version-per-(name,author).
- **`turn-counters.ts` EXISTS** (`TurnCounters`, `tryStopCounterTrigger`, `DEFAULT_SKILLIFY_EVERY_TURNS=10`) — 016a's stop-counter trigger. PRD-004 `memory_jobs` worker (the skillify worker is a job). `sessions` table EXISTS (the miner reads). `/api/skills` route group scaffolded. PRD-002 `appendVersionBumped` + escaping (`sqlStr` for the team filter). PRD-011 scope/tenancy.
- The gate model **shells out to the host agent's CLI** (no API key held) — a `GateCli` SEAM (fake in tests). 016c writes under `~/.claude/skills/` + per-agent roots (a `SkillInstallTargets` seam — injectable in tests). DeepLake access ONLY via the daemon (thin-client invariant — hooks signal, daemon owns).

## Verification posture
Vitest: pair extraction (last 10 past watermark, EXCLUDE the trigger session, drop tool-calls/thinking, cap 2000/pair + 40000 total — 016a-AC-1); the gate returns exactly one of KEEP/MERGE/SKIP (KEEP needs ≥3-exchange recurrence + non-obvious + not-already-covered — 016a-AC-2); stop-counter trigger + reset + unconditional session-end (016a-AC-3, reuse TurnCounters); team filter `author IN (<team>)` via `sqlStr` (016a-AC-4); worker LOCK suppresses a concurrent run (016a-AC-5); gate-CLI 120s timeout → abort-no-verdict + lock released in `finally` (016a-AC-6); KEEP → SKILL.md w/ provenance frontmatter + append-only version row, NEVER UPDATE (016b-AC-1); watermark→oldest-mined (016b-AC-2); MERGE-absent → writeNewSkill fallback (016b-AC-3); cross-author merge → scope me→team (016b-AC-4); install=project/global path (016b-AC-5); pull writes `<name>--<author>/SKILL.md` + symlinks to every agent root (016c-AC-1/AC-5); auto-pull skip-if-local-newer + 5s timeout swallowing errors (016c-AC-2); `HONEYCOMB_AUTOPULL_DISABLED=1` skip (016c-AC-3); unauthenticated → skip-silently (016c-AC-4); all dispatch through the daemon (016b-AC-6 / 016c-AC-6). **Opt-in LIVE: a skills append-only version write → highest-version read** (the proven pattern; poll-convergent). Out of scope: the capture pipeline (consumed), the gate model itself (shelled out), cross-org sharing.

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | trigger | reuse `TurnCounters`/`tryStopCounterTrigger`: stop-counter ≥ `HONEYCOMB_SKILLIFY_EVERY_N_TURNS` → reset + run worker; session-end → run unconditionally (016a-AC-3). |
| D-2 | extraction | last 10 in-scope sessions PAST the watermark, EXCLUDING the trigger session; drop tool-calls + thinking; cap 2000 chars/pair, 40000 total (016a-AC-1). |
| D-3 | gate | a `GateCli` SEAM shelling out to the host CLI (no API key); returns exactly KEEP \| MERGE \| SKIP; KEEP only for a non-obvious pattern recurring ≥3 exchanges + not-already-covered; 120s timeout → abort, no verdict, lock released in `finally` (016a-AC-2/AC-6). |
| D-4 | worker lock | a per-project lock suppresses a concurrent run; released in `finally` (016a-AC-5/AC-6). |
| D-5 | skills write | KEEP → `SKILL.md` (provenance frontmatter: source_sessions/version/created_by/scope) + an APPEND-ONLY version row into the EXISTING `skills` table — NEVER an in-place UPDATE; the active skill = highest version per (name,author) (016b-AC-1). |
| D-6 | watermark | after any run, advance the watermark to the OLDEST mined session's date so older missed sessions are re-seen; per-project, on disk (016b-AC-2). |
| D-7 | merge | MERGE whose target is absent locally → fall back to `writeNewSkill` (body preserved) (016b-AC-3); a cross-author merge promotes scope `me`→`team` (016b-AC-4). |
| D-8 | install path | `install=project` → `<cwd>/.claude/skills/`; `install=global` → `~/.claude/skills/` (016b-AC-5). |
| D-9 | pull/auto-pull | pull writes `~/.claude/skills/<name>--<author>/SKILL.md` + symlinks into every detected agent root (016c-AC-1/AC-5); auto-pull at session start: skip if local ≥ remote, 5s timeout swallowing errors (never blocks startup — 016c-AC-2), `HONEYCOMB_AUTOPULL_DISABLED=1` → skip (AC-3), unauthenticated → skip silently (AC-4). |
| D-10 | dispatch | every skills read/write goes THROUGH the daemon, never a direct DeepLake connection (016b-AC-6 / 016c-AC-6 — the hook-signals-daemon invariant). |

## Scaffold/seam plan
Wave 1 (016b + scaffold): skillify contracts (`MinedPair`, `GateVerdict`, `Skill`, `SkillProvenance`, the `GateCli` seam, the `SkillInstall`/`DaemonDispatch` seams) + the `skills`-table write path (append-only version row + read-highest-version-per-(name,author) + SKILL.md writer + MERGE fallback + scope promotion + install path) + reconcile the EXISTING skills table (confirm version-bumped + provenance cols) + 016a/016c stubs + CONVENTIONS.md + the live skills write/read itest. Wave 2 fills 016a (miner: trigger/lock/fetch/extract/gate) ‖ 016c (install: pull/auto-pull/symlink) — both consume 016b's write/read + the contracts.

---

## AC Ledger (18 sub + 3 index)

### 016a Trace Miner — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Last 10 in-scope past watermark → pairs extracted (drop tool/thinking), cap 2000/pair + 40000 total, exclude trigger session. | VERIFIED |
| a-AC-2 | Gate returns exactly KEEP/MERGE/SKIP; KEEP requires ≥3-exchange recurrence. | VERIFIED |
| a-AC-3 | Stop-counter ≥ N → reset + run worker; session-end → unconditional. | VERIFIED |
| a-AC-4 | scope `team` + team list → `author IN (<team>)` escaped via `sqlStr`. | VERIFIED |
| a-AC-5 | Concurrent run in flight → worker lock suppresses the second. | VERIFIED |
| a-AC-6 | Gate CLI > 120s → abort, no verdict, lock released in `finally`. | VERIFIED |

### 016b Skills Writes — Wave 1 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | KEEP → SKILL.md w/ provenance frontmatter + append-only version row (NEVER in-place UPDATE). | VERIFIED |
| b-AC-2 | Any verdict → watermark advances to the oldest mined session's date. | VERIFIED |
| b-AC-3 | MERGE target absent locally → `writeNewSkill` fallback, body preserved. | VERIFIED |
| b-AC-4 | Cross-author merge → row scope promoted `me`→`team`. | VERIFIED |
| b-AC-5 | install=project vs global → SKILL.md under `<cwd>/.claude/skills/` or `~/.claude/skills/`. | VERIFIED |
| b-AC-6 | Any successful write → through the daemon, not a direct DeepLake connection. | VERIFIED |

### 016c Skill Install — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | `skillify pull` → `~/.claude/skills/<name>--<author>/SKILL.md` + symlinks to every other detected agent root. | VERIFIED |
| c-AC-2 | Auto-pull: local ≥ remote → skip; bounded by 5s timeout swallowing errors (never blocks startup). | VERIFIED |
| c-AC-3 | `HONEYCOMB_AUTOPULL_DISABLED=1` → auto-pull does not run. | VERIFIED |
| c-AC-4 | Unauthenticated session → auto-pull skips silently (no warning). | VERIFIED |
| c-AC-5 | Global-install pull → a symlink in each detected agent root → the canonical dir. | VERIFIED |
| c-AC-6 | Any pull → queries the store through the daemon, not a direct DeepLake connection. | VERIFIED |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 stop-counter → reset + worker; session-end unconditional | a-AC-3 | VERIFIED |
| AC-2 gate KEEP only for ≥3-exchange non-obvious not-covered | a-AC-2 | VERIFIED |
| AC-3 KEEP → append-only version row (never UPDATE) + watermark | b-AC-1, b-AC-2 | VERIFIED |

**Totals:** 21 ACs (18 sub + 3 index) · **21 VERIFIED** · 0 OPEN — fully VERIFIED (miner/gate/install unit-proven; skills append-only version write→highest-version read live-proven), close-out unlocked.

## Wave plan
```
Wave 1 (016b skills-writes + contracts + table reconcile + 016a/016c stubs) ──► Wave 2 (016a miner ‖ 016c install) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `deeplake-dataset-worker-bee` opus — skillify contracts + seams (GateCli/SkillInstall/DaemonDispatch), 016b skills-write path (append-only version row + highest-version read + SKILL.md + MERGE fallback + scope promotion + install path), reconcile the existing `skills` table, 016a/016c stubs, CONVENTIONS.md. + opt-in live skills write/read itest.
- Wave 2 · 2 parallel — 016a trace-miner (`retrieval-worker-bee` opus — trigger/lock/fetch/extract/gate-CLI; it owns the skillify loop), 016c skill-install (`typescript-node-worker-bee` opus — pull/auto-pull/symlink fan-out).
- Wave 3 · `security-worker-bee` (opus — the gate CLI shell-out can't be command-injected [no shell, args array]; the symlink fan-out can't traverse out / clobber arbitrary files; skills scope respects tenancy [team filter escaped, no cross-org]; the worker lock can't deadlock / leak; auto-pull skips silently unauthenticated [no token leak]; all DeepLake via the daemon; a mined SKILL.md body can't carry a secret from a transcript) → `quality-worker-bee` (sonnet).

## Watchdog / event log
- PRDs 001–015 merged (15 done); main GREEN incl. gated live job (PRD-015 goal-dispatch held). PRD-016 moved→in-work, branched off main (4b60e23).
- Infra scan: `skills` table EXISTS (product.ts, version-bumped, all provenance cols) — 016b fills it; `turn-counters.ts` EXISTS (stop-counter trigger); `sessions` exists (miner reads); `/api/skills` scaffolded; gate model shells to host CLI (seam); hooks signal the daemon (no direct DeepLake). Wave 1 dispatched.
- Wave 1 DONE (016b, deeplake, opus): skillify contracts + seams (GateCli/SkillInstallTarget/SkillStore/WatermarkStore); `skills-write.ts` — append-only version-bump to the EXISTING skills table (no UPDATE method by construction; highest-version-per-(name,author) read, poll-convergent), SKILL.md w/ provenance frontmatter, MERGE→writeNewSkill fallback, cross-author scope me→team, install project/global path; watermark→oldest; `resolveTable` test-isolation seam. b-AC-1..6 VERIFIED. ci=0 (1075). **Live skills write/read 3/3** (v1→v2 append, highest-version read returns v2). Existing skills table reconciled (no schema change).
- Wave 2 DONE (2 parallel): 016a miner (retrieval, opus — `evaluateTrigger` reuses TurnCounters [stop-counter reset + session-end unconditional], extraction caps 2000/40000 + drop tool/thinking + exclude-trigger, `createHostCliGate` shells `shell:false` args-array [no injection] w/ 120s timeout, KEEP needs ≥3 exchanges, atomic `O_EXCL` worker lock released in `finally`, team filter `author IN` via sLiteral/sqlStr; 9 a-AC tests). 016c install (typescript-node, opus — placed in `src/daemon-client/skillify/` [thin client, dispatches through the daemon via a `SkillPullClient` seam, imports only pure sql.js], `skillify pull` writes `<name>--<author>/SKILL.md` + symlink fan-out to detected agent roots w/ path-safety sanitizer, auto-pull skip-if-local-newer + 5s-timeout-swallow + AUTOPULL_DISABLED + unauth-silent-skip; 19 c-AC tests + CLI). Orchestrator root-verify: ci=0 (1103/4-skip), build/audit:openclaw/audit:sql=0, invariant green (both 016a daemon-side + 016c thin-client clean), skillify suites 46 tests.
- All 21 ACs VERIFIED. Worker/hook-assembly wiring (the daemon job that runs the miner on a Stop signal, the session-start auto-pull hook) deferred+documented. Wave 3 (security → quality) dispatched.
