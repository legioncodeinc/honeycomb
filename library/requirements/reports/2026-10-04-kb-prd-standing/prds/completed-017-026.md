# Standing: completed PRDs 017, 018, 021-026

Date: 2026-10-04
Shard: Wave 1b, completed folders prd-017, prd-018, prd-021, prd-022, prd-023, prd-024, prd-025, prd-026.
prd-019 and prd-020 are in-work and are not in this shard.
Method: every index, lettered child, and QA/security note in those folders was read. Each acceptance criterion was checked against current `src/`, `harnesses/`, `mcp/src/`, `sdk/`, `scripts/`, and `tests/integration/` (live itests cited as proof files only). `node_modules` and build outputs (`daemon/`, `bundle/`, `mcp/bundle/`, `harnesses/*/bundle/`) were skipped. No PRD, source, or git move was edited.

Verdicts:

- MET: the behavior is present in source at the cited line.
- UNMET: the cited behavior is absent or the current source does something else.
- UNVERIFIABLE: the criterion is a live DeepLake/model run, a manual recording, or a green `npm run ci` / pack gate. This pass did not execute those.

## Totals

| PRD | ACs | MET | UNMET | UNVERIFIABLE | Recommended bucket |
| --- | ---: | ---: | ---: | ---: | --- |
| 017 wiki summaries | 15 | 15 | 0 | 0 | completed |
| 018 team skill sharing | 21 | 19 | 2 | 0 | completed |
| 021 go-live | 39 | 26 | 7 | 6 | completed |
| 022 data-access API | 33 | 25 | 0 | 8 | completed |
| 023 deeplake connect parity | 9 | 7 | 0 | 2 | completed |
| 024 dashboard UI parity | 8 | 0 | 7 | 1 | completed |
| 025 semantic recall default | 7 | 3 | 0 | 4 | completed |
| 026 pollinating enablement | 6 | 1 | 0 | 5 | completed |
| Total | 138 | 96 | 16 | 26 | |

Unmet count: 16.

Child indexes `prd-017a`, `prd-017b`, and `prd-018a` through `prd-018c` still say `Status: Draft` while their parent indexes say Completed. That is a status-line drift, not an acceptance criterion.

## Recommended buckets

- **017 stay completed.** All 15 criteria are in `src/daemon/runtime/summaries/`.
- **018 stay completed.** Publish, version resolution, pull conflict policy, timeout, and symlink fan-out are in source. Two criteria are unmet (the `skill scope` command does not persist config; session-start still issues a pull when signed out). Those are wiring gaps inside a shipped feature, and they do not empty the rest of the folder.
- **021 stay completed.** Assembly, CLI loopback, hooks, MCP, and `/api/logs` are in the composition root. Seven criteria are unmet because later work changed the contract: cached `/health`, shared `~/.deeplake` credentials, the hive portal in place of `GET /dashboard`, and `honeycomb logs` tailing the product log. Six live/demo criteria are unverifiable here. Moving the folder back would treat successor decisions as unfinished 021 work.
- **022 stay completed.** The data-route groups are mounted from `assembleSeams`. The eight live dogfood criteria were not re-run.
- **023 stay completed.** Device flow, headless login, whoami, org/workspace, logout, and env-over-file credentials are in source. The gated live itest and the ci/security gate were not re-run.
- **024 stay completed.** The React UI-kit host this PRD specified (`host.ts`, `app.tsx`, `wire.ts`) is absent from this repo. `src/daemon/runtime/dashboard/CONVENTIONS.md` lines 46-49 and `src/dashboard/launch.ts` lines 167-169 say the browser dashboard is the hive portal on port 3853 and honeycomb keeps `/api/*`. The pollinate trigger route is still mounted. In-tree UI criteria are unmet. Moving the folder to in-work would record an extraction to hive as unfinished honeycomb work. Wave 2 should confirm the hive portal if that repo is in scope; this tree cannot.
- **025 stay completed.** Embeddings default on, the cosine arm reports `degraded` from whether it ran, and non-768 vectors are rejected. The live lexical-miss bar, the kill/restart toggle, and the ci/pack gate were not re-run.
- **026 stay completed.** The enable ack and the default-off flag are in source. The live consolidation bar and the ci gate were not re-run. The shipped default remains off (`config.ts` line 59), which matches this PRD's own decision to keep ON behind `HONEYCOMB_POLLINATING_ENABLED`.

## QA notes read

- `prd-017-wiki-summaries/reports/2026-06-18-qa-report.md` and `2026-06-18-security-report.md`. The June QA says 15/15 pass. That still matches source.
- `prd-018-team-skill-sharing/reports/2026-06-18-qa-report.md` and `2026-06-18-security-report.md`. The June QA marks a-AC-2 pass against `src/cli/skill.ts`. That file is absent. The current `skill scope` route acks and does not write config.
- `prd-021-go-live/reports/2026-06-20-qa-report.md`, `2026-06-19-security-report.md`, `reports/README.md`. The June QA warning that `mountLogsApi` is absent from assembly is stale: `assembleSeams` calls it. The warning that `mountDashboardHost` is absent is now stronger: the function is gone from `src/`.
- `prd-022-data-access-api/reports/2026-06-20-qa-report.md` and `reports/README.md`. The June note that `/api/sources` assembly is deferred is stale: `resolveProductDataDeps` builds sources deps and `mountProductDataApi` mounts them.
- `prd-023-deeplake-connect-parity/reports/2026-06-20-qa-report.md`. The nine-AC trace still matches the auth modules. Live AC-8 was not re-run.
- `prd-024-dashboard-ui-parity/reports/2026-06-20-qa-report.md`. It cites `host.ts`, `app.tsx`, and `wire.ts`. Those files are absent. AC-8 was already pending a live screenshot in that report.
- `prd-025-semantic-recall-default/reports/2026-06-21-qa-report.md`. Default-on and honest `degraded` still match. The live itest was not re-run.
- `prd-026-pollinating-loop-enablement/reports/2026-06-22-qa-report.md` and `2026-06-22-security-report.md`. The enable gate, subtract reset, and pending-review mapping still match. The live itests were not re-run.

---

## PRD-017 Wiki summaries

Folder: `library/requirements/completed/prd-017-wiki-summaries/`
Index status line: Completed (`prd-017-wiki-summaries-index.md` line 3).
Recommended bucket: completed. All 15 criteria are implemented under `src/daemon/runtime/summaries/`.

### Index AC-1 - MET

- Quote: "Given a session reaches `SessionEnd`, when the daemon runs the summary worker, then a summary row is written to the `memory` table at `/summaries/<userName>/<sessionId>.md` exactly once."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017-wiki-summaries-index.md:38`
- Source: `src/daemon/runtime/summaries/worker.ts:131` (`summaryPath` builds `/summaries/<user>/<session>.md`) and `src/daemon/runtime/summaries/worker.ts:625` (the worker writes that path). Exactly-once is `selectBeforeInsert` at `src/daemon/runtime/summaries/worker.ts:250`. Session-end enqueue is `src/daemon/runtime/capture/attach.ts:198`.

### Index AC-2 - MET

- Quote: "Given DeepLake read consistency lags the write, when the worker fetches session events and finds none, then it retries with linear backoff up to the configured limit before giving up and removes any in-progress placeholder."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017-wiki-summaries-index.md:39`
- Source: `src/daemon/runtime/summaries/worker.ts:708` (`fetchWithRetry`, constant `backoffMs`) and `src/daemon/runtime/summaries/worker.ts:643` (empty result removes the placeholder).

### Index AC-3 - MET

- Quote: "Given a periodic threshold (messages or hours) is crossed mid-session, when capture records the event, then the daemon is signaled and runs at most one concurrent summary per session via the per-session lock."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017-wiki-summaries-index.md:40`
- Source: `src/daemon/runtime/capture/turn-counters.ts:130` (every 20 messages returns a `summary` cue) and `src/daemon/runtime/summaries/worker.ts:628` (lock acquire returns `lock_held` when a run is in flight). An hours threshold is ABSENT in `src/daemon/runtime/capture/turn-counters.ts`. The message threshold covers the "messages or hours" trigger class.

### 017a AC-1 - MET

- Quote: "Given the daemon receives a summary trigger, when it fetches session events and they are present, then it shells the host harness's gate CLI and writes the generated summary to the `memory` table at `/summaries/<userName>/<sessionId>.md`."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017a-wiki-summaries-summary-worker.md:48`
- Source: `src/daemon/runtime/summaries/worker.ts:656` (gate run) and `src/daemon/runtime/summaries/worker.ts:685` (`writeSummary`). Spawn is `shell: false` at `src/daemon/runtime/summaries/worker.ts:474`.

### 017a AC-2 - MET

- Quote: "Given the gate CLI subprocess runs, when it spawns, then `HONEYCOMB_WIKI_WORKER=1` and `HONEYCOMB_CAPTURE=false` are set so the gate call does not trigger its own capture loop."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017a-wiki-summaries-summary-worker.md:49`
- Source: `src/daemon/runtime/summaries/worker.ts:479` sets `HONEYCOMB_WIKI_WORKER=1` and `HONEYCOMB_CAPTURE=false`. `HONEYCOMB_WORKER=1` is also set at line 484.

### 017a AC-3 - MET

- Quote: "Given DeepLake read consistency lags the write, when the worker finds no events, then it retries with linear backoff up to the configured limit before removing the in-progress placeholder."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017a-wiki-summaries-summary-worker.md:50`
- Source: `src/daemon/runtime/summaries/worker.ts:708` and `src/daemon/runtime/summaries/worker.ts:645`.

### 017a AC-4 - MET

- Quote: "Given a periodic threshold (messages or hours) is crossed, when capture records the event, then the daemon runs at most one concurrent summary per session via the per-session lock."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017a-wiki-summaries-summary-worker.md:51`
- Source: `src/daemon/runtime/capture/turn-counters.ts:133` and `src/daemon/runtime/summaries/worker.ts:628`. Hours threshold: ABSENT (same note as index AC-3).

### 017a AC-5 - MET

- Quote: "Given `EmbedClient.embed()` throws, when the summary is written, then NULL is stored for the embedding and the write still succeeds."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017a-wiki-summaries-summary-worker.md:52`
- Source: `src/daemon/runtime/summaries/worker.ts:671` calls `embedNonFatal`, and the write continues at line 685.

### 017a AC-6 - MET

- Quote: "Given an existing summary row, when the worker writes, then it uses SELECT-before-INSERT keyed on `path` rather than an in-place UPDATE."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017a-wiki-summaries-summary-worker.md:53`
- Source: `src/daemon/runtime/summaries/worker.ts:250` (`selectBeforeInsert`).

### 017b AC-1 - MET

- Quote: "Given one or more session summaries exist, when synthesis runs, then a `MEMORY.md` is written under the memory path linking to the relevant summaries."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017b-wiki-summaries-synthesis.md:46`
- Source: `src/daemon/runtime/summaries/synthesis.ts:67` (`MEMORY_INDEX_PATH = "/MEMORY.md"`) and `src/daemon/runtime/summaries/synthesis.ts:478` (`synthesizeMemoryIndex`).

### 017b AC-2 - MET

- Quote: "Given a session is resumed across `--resume`/`--continue`, when synthesis runs, then its thread head reflects the merged session rather than duplicating an entry."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017b-wiki-summaries-synthesis.md:47`
- Source: `src/daemon/runtime/summaries/synthesis.ts:377` (`threadKeyOf` keys a lineage, so a resumed session shares one head).

### 017b AC-3 - MET

- Quote: "Given synthesis runs, when it reads and writes, then every operation is dispatched through the daemon, never a direct DeepLake connection."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017b-wiki-summaries-synthesis.md:48`
- Source: `src/daemon/runtime/summaries/synthesis.ts:214` (`createSynthesisStore` takes the daemon `StorageQuery`) and queries go through `storage.query` at `src/daemon/runtime/summaries/synthesis.ts:333`.

### 017b AC-4 - MET

- Quote: "Given an existing `MEMORY.md` or thread-head row, when synthesis re-runs, then it uses SELECT-before-INSERT rather than an in-place UPDATE."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017b-wiki-summaries-synthesis.md:49`
- Source: `src/daemon/runtime/summaries/synthesis.ts:272` (SELECT-before-INSERT) and `src/daemon/runtime/summaries/synthesis.ts:298` (a later refresh appends version N+1, still with no in-place UPDATE).

### 017b AC-5 - MET

- Quote: "Given a `MEMORY.md` link, when an agent follows it, then it resolves to the linked per-session summary through the VFS read precedence."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017b-wiki-summaries-synthesis.md:50`
- Source: `src/daemon/runtime/summaries/synthesis.ts:418` renders links whose target is the summary path. `src/daemon/runtime/vfs/api.ts:454` (`GET /memory/cat`) reads that row.

### 017b AC-6 - MET

- Quote: "Given two tenants, when each runs synthesis, then each `MEMORY.md` reflects only its own org/workspace/agent-scoped summaries."
- PRD: `library/requirements/completed/prd-017-wiki-summaries/prd-017b-wiki-summaries-synthesis.md:51`
- Source: `src/daemon/runtime/summaries/synthesis.ts:214` binds the store to the run's `QueryScope`, and reads pass that scope into `storage.query` at line 333.

---

## PRD-018 Team skill sharing

Folder: `library/requirements/completed/prd-018-team-skill-sharing/`
Index status line: Completed, closed by PRD-045g (`prd-018-team-skill-sharing-index.md` line 3).
Recommended bucket: completed. Two criteria are unmet; the publish, pull, and fan-out body is present.

### Index AC-1 - MET

- Quote: "Given a mined skill, when it is published, then a new version row (`v=N+1`) is inserted into the shared `skills` table with the configured `me`/`team` scope, and readers take `ORDER BY version DESC`."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018-team-skill-sharing-index.md:51`
- Source: `src/daemon/runtime/skillify/publish-endpoint.ts:80` appends a version via `store.appendVersion`. Scope is written on the row at `src/daemon/runtime/skillify/skills-write.ts:186`. Readers use `MAX(version)` at `src/daemon/runtime/skillify/publish-endpoint.ts:112`, which returns the highest version per `(name, author)`. The SQL text is `MAX(version)`, and the literal `ORDER BY version DESC` is ABSENT on this read.

### Index AC-2 - MET

- Quote: "Given a teammate publishes a newer skill, when the current user starts a session, then auto-pull writes the newer skill within seconds, and re-running the pull with no changes touches no files."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018-team-skill-sharing-index.md:52`
- Source: session start calls `autoPullSkills` at `src/hooks/shared/session-start.ts:272`, which POSTs `/api/skills/pull` at `src/hooks/shared/session-start-seams.ts:133`. Newer-vs-current is `decideAction` at `src/daemon-client/skillify/install.ts:285` (`remote <= local` returns `skip`). The budget is 5000 ms at `src/daemon-client/skillify/install.ts:71`.

### Index AC-3 - MET

- Quote: "Given a global install pull, when fan-out runs, then a symlink exists in every detected non-Claude agent root pointing at the canonical `~/.claude/skills/<name>--<author>/` directory."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018-team-skill-sharing-index.md:53`
- Source: `src/daemon-client/skillify/install.ts:662` (`createDefaultAgentRoots`: canonical `~/.claude/skills`, others codex/agents/cursor/hermes/pi) and `src/daemon-client/skillify/install.ts:508` (`fanOutSymlinks`). Global-only gate is `src/daemon-client/skillify/install.ts:198`.

### 018a AC-1 - MET

- Quote: "Given an existing skill at version N, when it is republished, then a new row at version N+1 is inserted and the prior row is preserved."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018a-team-skill-sharing-publish-version.md:46`
- Source: `src/daemon/runtime/skillify/publish-endpoint.ts:80` and `src/daemon/runtime/skillify/skills-write.ts:466` (`maxVersion(id) + 1`, append-only insert at line 204).

### 018a AC-2 - UNMET

- Quote: "Given `honeycomb skill scope team --users alice,bob`, when the worker mines, then publishes carry `team` scope and the configured contributor list."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018a-team-skill-sharing-publish-version.md:47`
- Source: the CLI maps the verb to `POST /api/skills/scope` at `src/commands/storage-handlers.ts:99`. The handler returns `{ ok: true, note: "scope is persisted client-side" }` at `src/daemon/runtime/skillify/propagation-api.ts:280` and writes no config. `SkillifyConfigStore.write` exists at `src/daemon-client/skillify/config.ts:80`, and a production caller of that write is ABSENT (`src/daemon/runtime/skillify/miner.ts` does not read the store). Cross-author merge still stamps `skillopt` at `src/daemon/runtime/skillify/skills-write.ts:462`, which is 018a AC-4, and it is a different path from this command.

### 018a AC-3 - MET

- Quote: "Given a config file with the legacy `org` scope, when it is read, then the value is coerced to `team`."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018a-team-skill-sharing-publish-version.md:48`
- Source: `src/daemon-client/skillify/config.ts:142` (`org` and `team` both return `team`). Read does not rewrite the file (`src/daemon-client/skillify/config.ts:70`).

### 018a AC-4 - MET

- Quote: "Given a cross-author merge, when it is published, then the row records the `skillopt` contributor marker and the original author."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018a-team-skill-sharing-publish-version.md:49`
- Source: `src/daemon/runtime/skillify/skills-write.ts:462` sets contributors to `[SKILLOPT_CONTRIBUTOR, deps.author]`. The marker constant is `src/daemon/runtime/skillify/contracts.ts:256`.

### 018a AC-5 - MET

- Quote: "Given a reader queries a skill name with multiple versions, when it resolves, then it takes the highest version via `ORDER BY version DESC`."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018a-team-skill-sharing-publish-version.md:50`
- Source: `src/daemon/runtime/skillify/publish-endpoint.ts:112` (`MAX(version)` self-join). Highest version is what the reader returns. The literal `ORDER BY version DESC` clause is ABSENT on this statement.

### 018a AC-6 - MET

- Quote: "Given any publish, when it inserts, then it goes through the daemon, not a direct DeepLake connection."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018a-team-skill-sharing-publish-version.md:51`
- Source: `src/daemon/runtime/skillify/publish-endpoint.ts:71` (`createSkillPublishEndpoint` takes `StorageQuery`) and `src/daemon/runtime/skillify/propagation-api.ts:261` calls it from the HTTP handler.

### 018b AC-1 - MET

- Quote: "Given a remote skill at-or-older than the local version, when auto-pull runs, then it is skipped and no file is written."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018b-team-skill-sharing-auto-pull.md:46`
- Source: `src/daemon-client/skillify/install.ts:285` returns `skip` when remote is not newer, and `src/daemon-client/skillify/install.ts:178` continues without writing.

### 018b AC-2 - MET

- Quote: "Given the `skills` table does not yet exist, when auto-pull runs, then it detects absence via the trusted table list and skips the SELECT without logging an error."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018b-team-skill-sharing-auto-pull.md:47`
- Source: `src/daemon-client/skillify/install.ts:146` returns before `readLatestSkills` when `skillsTableAbsent` is true (`src/daemon-client/skillify/install.ts:409`).

### 018b AC-3 - MET

- Quote: "Given a remote skill newer than the local copy, when auto-pull runs, then the existing file is backed up to `SKILL.md.bak` and the newer skill is written."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018b-team-skill-sharing-auto-pull.md:48`
- Source: `src/daemon-client/skillify/install.ts:77` (`SKILL_BACKUP_FILE = "SKILL.md.bak"`) and `src/daemon-client/skillify/install.ts:190` (`backupExisting` then `writeCanonicalSkill`).

### 018b AC-4 - UNMET

- Quote: "Given `HONEYCOMB_AUTOPULL_DISABLED=1` or an unauthenticated session, when a session starts, then auto-pull does not run and logs no warning."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018b-team-skill-sharing-auto-pull.md:49`
- Source: the kill switch returns before the POST at `src/hooks/shared/session-start-seams.ts:135`. A signed-out session still POSTs: `autoPullViaLoopback` at `src/hooks/shared/session-start-seams.ts:216` always fetches, and `tenancyHeaders` at line 242 omits org headers when the credential is absent. The thin-client `autoPull` auth skip at `src/daemon-client/skillify/install.ts:257` is present, and session start calls `autoPullSkills` (`src/hooks/shared/session-start.ts:272`), which does not use that auth skip.

### 018b AC-5 - MET

- Quote: "Given a remote skill with an empty `author`, when auto-pull runs, then it is skipped to protect the local-mined slot."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018b-team-skill-sharing-auto-pull.md:50`
- Source: `src/daemon-client/skillify/install.ts:162`.

### 018b AC-6 - MET

- Quote: "Given the daemon is unreachable, when auto-pull runs, then it times out at 5 seconds, swallows the error, and the session still starts."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018b-team-skill-sharing-auto-pull.md:51`
- Source: `src/daemon-client/skillify/install.ts:71` (`AUTOPULL_TIMEOUT_MS = 5_000`) and `src/daemon-client/skillify/install.ts:263` (catch returns null). The session-start seam uses the same budget and swallows at `src/hooks/shared/session-start-seams.ts:217`. Session start returns the context block after spawning the pull at `src/hooks/shared/session-start.ts:278`.

### 018c AC-1 - MET

- Quote: "Given a global-install pull writes a skill, when fan-out runs, then each detected agent root (codex, hermes, pi, etc.) gets a symlink to the canonical directory, and re-running is a no-op for correct links."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018c-team-skill-sharing-symlink-fanout.md:46`
- Source: `src/daemon-client/skillify/install.ts:508` and `src/daemon-client/skillify/install.ts:537` (a correct link returns `already`).

### 018c AC-2 - MET

- Quote: "Given a user installs a new agent after prior pulls, when the next pull completes, then `backfillSymlinks` ensures every globally-installed skill has a link in the newly detected root."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018c-team-skill-sharing-symlink-fanout.md:47`
- Source: `src/daemon-client/skillify/install.ts:309` (`backfillSymlinks`) called at `src/daemon-client/skillify/install.ts:223`.

### 018c AC-3 - MET

- Quote: "Given a project-local pull, when it writes a skill, then no symlink fan-out occurs."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018c-team-skill-sharing-symlink-fanout.md:48`
- Source: `src/daemon-client/skillify/install.ts:196` fans out only when `isGlobal` is true.

### 018c AC-4 - MET

- Quote: "Given a stale symlink pointing at a different canonical path, when fan-out runs, then it is unlinked and recreated at the correct target."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018c-team-skill-sharing-symlink-fanout.md:49`
- Source: `src/daemon-client/skillify/install.ts:539` (`unlinkSync` then `symlinkSync`).

### 018c AC-5 - MET

- Quote: "Given a dry-run pull, when it completes, then neither fan-out nor backfill touches the filesystem."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018c-team-skill-sharing-symlink-fanout.md:50`
- Source: `src/daemon-client/skillify/install.ts:183` returns before writes, and backfill is gated by `!dryRun` at line 222.

### 018c AC-6 - MET

- Quote: "Given a symlink already pointing at the correct canonical path, when fan-out re-runs, then no change is made."
- PRD: `library/requirements/completed/prd-018-team-skill-sharing/prd-018c-team-skill-sharing-symlink-fanout.md:51`
- Source: `src/daemon-client/skillify/install.ts:537` returns `already` and `fanOutSymlinks` does not count it (`src/daemon-client/skillify/install.ts:513`).

---

## PRD-021 Go-live

Folder: `library/requirements/completed/prd-021-go-live/`
Index status line: Completed (`prd-021-go-live-index.md` line 3).
Recommended bucket: completed. See the bucket note above. June QA assembly warnings are partly stale.

### Index AC-1 - UNVERIFIABLE

- Quote: "Given `honeycomb setup <harness>` plus a daemon start, when they run, then a daemon serves `/health` 200 against live DeepLake and the harness's hooks fire, with no fakes and no stubs."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021-go-live-index.md:56`
- Source: assembly and `/health` exist (`src/daemon/runtime/server.ts:331`, `harnesses/claude-code/hooks/hooks.json:8`). A live DeepLake 200 with hooks firing was not re-run. The gated file is `tests/integration/golden-path-live.itest.ts`.

### Index AC-2 - UNVERIFIABLE

- Quote: "Given a real coding session, when turns are captured and the session ends, then they persist to DeepLake and produce a summary, and a later session's recall surfaces that prior context end-to-end."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021-go-live-index.md:57`
- Source: capture, summary worker, and recall exist (`src/daemon/runtime/capture/attach.ts:167`, `src/daemon/runtime/summaries/worker.ts:617`, `src/daemon/runtime/memories/api.ts:755`). The live end-to-end result was not re-run (`tests/integration/golden-path-live.itest.ts`).

### Index AC-3 - UNMET

- Quote: "Given `honeycomb dashboard`, when it opens against a running daemon, then it renders the live session and KPIs from real daemon data and a live log shows capture events streaming as the AI works."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021-go-live-index.md:58`
- Source: `honeycomb dashboard` prints a reachable line (`src/commands/local-handlers.ts:238`) and discards the view tree (`src/cli/runtime.ts:726`). `GET /dashboard` is ABSENT (`mountDashboardHost` has no definition under `src/`; `src/daemon/runtime/dashboard/CONVENTIONS.md:48`). `honeycomb logs` tails the product service log (`src/commands/standard-interface.ts:105`), and it does not call `followLogs`.

### 021a AC-1 - MET

- Quote: "Given resolved config with DeepLake credentials, when `assembleDaemon()` runs, then it constructs the live storage client and is the only production code importing `daemon/storage`."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021a-go-live-daemon-assembly.md:52`
- Source: `src/daemon/runtime/assemble.ts:3090` builds `createLazyStorageClient` from `defaultCredentialProvider`. Production imports of `src/daemon/storage` stay under `src/daemon/`. The exclusive-import test was not re-run.

### 021a AC-2 - MET

- Quote: "Given a constructed daemon, when the composition root runs, then `attachHooksHandlers`, `mountDashboardApi`, `mountNotificationsApi`, and `attachSessionsPrune` are each called exactly once after construction."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021a-go-live-daemon-assembly.md:53`
- Source: `src/daemon/runtime/assemble.ts:1373` (`attachHooks`), line 1407 (`mountDashboard`), line 1417 (`mountNotifications`), line 1427 (`attachPrune`).

### 021a AC-3 - MET

- Quote: "Given `createDaemon`, when the daemon is assembled, then the three no-op services are replaced with their real `JobQueueService`, `FileWatcherService`, and `RuntimePathService` implementations."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021a-go-live-daemon-assembly.md:54`
- Source: `src/daemon/runtime/assemble.ts:3172` (`createJobQueueService`), line 3320 (`createFileWatcherService`), line 3325 (`createRuntimePathService`).

### 021a AC-4 - UNMET

- Quote: "Given a running daemon, when `/health` is requested, then it performs a live storage probe and returns 200 only when DeepLake is reachable."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021a-go-live-daemon-assembly.md:55`
- Source: `src/daemon/runtime/server.ts:330` documents `/health` as cheap liveness with no DeepLake query on the request. Status is 503 only when the cached bit is `degraded` (`src/daemon/runtime/server.ts:335`). The bit starts `ok` (`src/daemon/runtime/health.ts:85`). Production does not await the first probe (`src/daemon/runtime/assemble.ts:4086`). A background `SELECT 1` exists at `src/daemon/runtime/assemble.ts:3925`.

### 021a AC-5 - MET

- Quote: "Given a running daemon, when SIGINT or SIGTERM is received, then `stopServices()` drains the services and the socket closes without leaving a stale lock file."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021a-go-live-daemon-assembly.md:56`
- Source: `src/daemon/index.ts:176` (`running.close()` calls `stopServices`) and `src/daemon/index.ts:189` registers SIGINT and SIGTERM. `assembled.shutdown()` removes the PID/lock (`src/daemon/index.ts:177`).

### 021a AC-6 - MET

- Quote: "Given a daemon already bound to port 3850, when a second start runs, then it detects the running daemon via the PID and lock file and does not double-bind."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021a-go-live-daemon-assembly.md:57`
- Source: `src/daemon/runtime/assemble.ts:4082` calls `acquireSingleInstanceLock` (`src/daemon/runtime/assemble.ts:931`) before services start.

### 021b AC-1 - MET

- Quote: "Given any storage verb (recall, remember, sessions prune, graph), when it runs against a live daemon, then its `DaemonClient` issues a real loopback request to `127.0.0.1:3850` and returns real data."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021b-go-live-cli-runtime.md:54`
- Source: `src/commands/contracts.ts:455` (loopback fetch to `127.0.0.1:3850`). Live payload content was not re-run; the client path is present.

### 021b AC-2 - MET

- Quote: "Given `honeycomb daemon start`, when it runs, then a daemon is brought up via the 021a entry point and `honeycomb daemon status` reports it running on port 3850."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021b-go-live-cli-runtime.md:55`
- Source: `src/commands/daemon.ts:160` routes `start` and `status`. Status text includes `127.0.0.1:3850` at `src/commands/status.ts:135` for the separate `honeycomb status` verb. Daemon lifecycle start is `src/commands/daemon.ts:177`.

### 021b AC-3 - MET

- Quote: "Given the daemon is down, when a storage verb runs, then ensure-running-on-demand auto-starts a daemon and the verb completes rather than failing with connection refused."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021b-go-live-cli-runtime.md:56`
- Source: `src/commands/daemon.ts:177` (`ensureDaemonRunning`) called from storage dispatch at `src/commands/dispatch.ts:346`.

### 021b AC-4 - UNMET

- Quote: "Given `honeycomb login`, when the device flow completes, then `~/.honeycomb/credentials.json` is written at `0600` and `healDriftedOrgToken` corrects a drifted org token."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021b-go-live-cli-runtime.md:57`
- Source: login writes the shared `~/.deeplake/credentials.json` at mode `0o600` (`src/cli/auth.ts:5`, `src/daemon/runtime/auth/credentials-store.ts:127` and line 515). The session-start `healDriftedOrgToken` implementation is an empty function (`src/hooks/shared/session-start-seams.ts:123`). `buildOrgDriftHealer` refuses to re-mint a real `api.deeplake.ai` credential and returns `drift-surfaced` (`src/cli/runtime.ts:564`).

### 021b AC-5 - MET

- Quote: "Given `honeycomb status`, when it runs, then it reports the real D1-D5 health from the 020d `HealthCheck`, not a placeholder."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021b-go-live-cli-runtime.md:58`
- Source: `src/cli/health-probes.ts:178` (`buildStatusHealthSource` wraps `createHealthCheck`) and `src/cli/runtime.ts:767` binds it. `runStatusCommand` prints each dimension at `src/commands/status.ts:144`.

### 021b AC-6 - MET

- Quote: "Given the bundled `bundle/cli.js`, when any command runs, then it dispatches through bound handlers with no remaining \"not wired in this build\" path."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021b-go-live-cli-runtime.md:59`
- Source: `src/cli/index.ts:38` always calls `buildRuntimeDeps`, which binds auth, connector, dashboard, health, and lifecycle (`src/cli/runtime.ts:761`). The string `not wired in this build` remains as a guard when a dep is omitted (`src/commands/dispatch.ts:488`, `src/commands/local-handlers.ts:235`). The bin path supplies the deps. The built `bundle/cli.js` was not inspected.

### 021c AC-1 - MET

- Quote: "Given a native hook event from a wired harness, when the binary runs, then the payload is normalized through the 019c shim, processed by the 019b core, and POSTed by the `DaemonHookClient` with the `x-honeycomb-runtime-path` header."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021c-go-live-hook-runtime.md:52`
- Source: `src/hooks/shared/daemon-client.ts:41` (`RUNTIME_PATH_HEADER`) and `src/hooks/shared/daemon-client.ts:106` (`createDaemonHookClient`). Claude and Codex binaries call `runHookBinary` (`harnesses/claude-code/src/index.ts:24`, `harnesses/codex/src/index.ts:19`).

### 021c AC-2 - MET

- Quote: "Given a logged-in user, when a hook runs, then the `CredentialReader` reads `~/.honeycomb/credentials.json` and the call speaks as the same identity as the daemon and CLI."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021c-go-live-hook-runtime.md:53`
- Source: `src/hooks/shared/credential-reader.ts:71` reads `~/.deeplake/credentials.json` first and falls back to `~/.honeycomb/credentials.json`. The daemon and CLI use that same shared file (`src/daemon/storage/config.ts:155`, `src/cli/whoami.ts:89`). The primary path named in the AC is now the fallback.

### 021c AC-3 - MET

- Quote: "Given the daemon, when it is assembled, then `/api/hooks/context` and `/api/hooks/session-end` are attached alongside `/api/hooks/capture` so all three lifecycle calls reach it."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021c-go-live-hook-runtime.md:54`
- Source: `src/daemon/runtime/capture/attach.ts:54` (`/context`), line 57 (`/session-end`), and line 159 (attached with capture). `assembleSeams` fires `attachHooks` at `src/daemon/runtime/assemble.ts:1373`. The comment at `assemble.ts:1358` saying context and session-end are not attached yet is stale.

### 021c AC-4 - MET

- Quote: "Given a session start, when the runtime fires, then prior context is rendered by the real `ContextRenderer` and the 020d notifications pipeline is drained."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021c-go-live-hook-runtime.md:55`
- Source: `src/hooks/shared/context-renderer.ts:32` (`createContextRenderer`) and `src/hooks/runtime.ts:374` (`pipeline.drain("session_start")`).

### 021c AC-5 - MET

- Quote: "Given Claude Code is set up, when a turn occurs, then its `hooks.json` invokes the bundle and the native lifecycle events drive the runtime end-to-end."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021c-go-live-hook-runtime.md:56`
- Source: `harnesses/claude-code/hooks/hooks.json:8` and line 15 invoke `bundle/index.js` for `SessionStart` and `UserPromptSubmit`. The bundle binary itself was not opened.

### 021c AC-6 - MET

- Quote: "Given a second harness wired as a fast-follow, when its binary runs, then it reuses the same `DaemonHookClient`, `CredentialReader`, and `ContextRenderer` without re-deriving the runtime."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021c-go-live-hook-runtime.md:57`
- Source: `harnesses/codex/src/index.ts:19` calls the shared `runHookBinary`, which builds one runtime (`src/hooks/runtime.ts:232`).

### 021d AC-1 - MET

- Quote: "Given a running daemon against live DeepLake, when the dashboard loads, then `mountDashboardApi` serves real KPIs, sessions, settings, graph, rules, and skill-sync."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021d-go-live-dashboard-and-logs.md:50`
- Source: `src/daemon/runtime/assemble.ts:1407` fires `mountDashboard`. The data client reads those endpoints at `src/dashboard/launch.ts:110`. A live DeepLake payload was not re-read.

### 021d AC-2 - MET

- Quote: "Given the daemon, when it is assembled, then the `/api/logs` handler reads the request-logger ring buffer and exposes log events."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021d-go-live-dashboard-and-logs.md:51`
- Source: `src/daemon/runtime/assemble.ts:1440` calls `mountLogs` with `daemon.logger`. The ring-buffer read and SSE stream are `src/daemon/runtime/logs/api.ts:231`. The June QA assembly gap for this seam is closed.

### 021d AC-3 - UNMET

- Quote: "Given `honeycomb dashboard`, when it runs, then it opens a real viewable dashboard host rendering the canonical 020b views."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021d-go-live-dashboard-and-logs.md:52`
- Source: `mountDashboardHost` is ABSENT. `src/daemon/runtime/dashboard/CONVENTIONS.md:48` says honeycomb no longer mounts `GET /dashboard`. `renderDashboardPage` exists at `src/dashboard/html.ts:88` and has no production caller. `openDashboard` at `src/dashboard/launch.ts:173` returns the hive URL `http://127.0.0.1:3853/` and is not called by the dashboard verb. The verb prints reachability (`src/commands/local-handlers.ts:238`).

### 021d AC-4 - UNMET

- Quote: "Given a live coding session, when `honeycomb logs --follow` or the dashboard live-log panel is open, then capture events stream as the AI works."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021d-go-live-dashboard-and-logs.md:53`
- Source: `followLogs` exists at `src/dashboard/logs.ts:92` and has no production caller. `honeycomb logs` tails a product log file (`src/commands/standard-interface.ts:125`). The SSE route `GET /api/logs/stream` exists at `src/daemon/runtime/logs/api.ts:235`. The dashboard live-log panel host is ABSENT.

### 021d AC-5 - MET

- Quote: "Given the daemon is unreachable, when the dashboard opens, then it surfaces the 020b connectivity state rather than a silent blank."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021d-go-live-dashboard-and-logs.md:54`
- Source: `src/dashboard/dashboard.ts:70` returns `buildConnectivityBanner` when the probe fails, and `src/commands/local-handlers.ts:241` prints the daemon-down line.

### 021d AC-6 - MET

- Quote: "Given no graph has been built or no sessions exist, when those views open, then they show the 020b empty-state prompt rather than an error."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021d-go-live-dashboard-and-logs.md:55`
- Source: `src/dashboard/views.ts:57` (`GRAPH_BUILD_PROMPT`) and `src/dashboard/views.ts:132` (empty-state block when `built` is false).

### 021e AC-1 - MET

- Quote: "Given the MCP server, when `bindAllTransports` runs, then the streamable-HTTP transport is served at `/mcp` and the stdio transport is connected."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md:45`
- Source: `mcp/src/transports.ts:129` (`bindAllTransports`) and `mcp/src/transports.ts:211` (path `/mcp` on `127.0.0.1`).

### 021e AC-2 - MET

- Quote: "Given a connecting client, when it speaks to `mcp/bundle/server.js`, then the server answers a real `initialize` handshake and returns the tool list."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md:46`
- Source: `mcp/src/index.ts` starts the server and `mcp/src/tools.ts:79` registers `memory_search` and `memory_store`. The built `mcp/bundle/server.js` was not opened. The gated itest is `tests/integration/mcp-transport-live.itest.ts`.

### 021e AC-3 - MET

- Quote: "Given any MCP tool, when its handler runs, then it routes through the bound `DaemonApiSeam` over loopback and never opens DeepLake directly."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md:47`
- Source: `mcp/src/handlers.ts:227` routes `memory_search` to `POST /api/memories/recall` through the daemon seam.

### 021e AC-4 - MET

- Quote: "Given an MCP-speaking harness with the server registered, when its tool list loads, then the unified `honeycomb_` tools appear in it."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md:48`
- Source: `mcp/src/tools.ts:79` publishes the memory tools. Registration tests live under `tests/mcp/`. A live harness tool list was not loaded.

### 021e AC-5 - MET

- Quote: "Given the 019d tool contract, when transports are bound, then tool names, schemas, and handler semantics are unchanged."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md:49`
- Source: `mcp/src/transports.ts:11` says `bindAllTransports` stays the 019d seam. Tool names remain `memory_search` and `memory_store` at `mcp/src/tools.ts:79`. A byte-for-byte diff against the original 019d schemas was not taken.

### 021e AC-6 - MET

- Quote: "Given a smoke check, when it connects to the running server, then it verifies the served `initialize` response and the presence of the `honeycomb_` tools, not merely a clean import."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md:50`
- Source: `tests/integration/mcp-transport-live.itest.ts:72` expects `memory_search` from a served list. This pass did not execute the itest. The check file exists and speaks to a running server, which is the criterion's shape.

### 021f AC-1 - UNVERIFIABLE

- Quote: "Given `honeycomb setup` into Claude Code plus a daemon start, when a real turn occurs, then it is captured to DeepLake `sessions` rows with no fakes in the path."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021f-go-live-dogfood-acceptance.md:52`
- Source: capture handler `src/daemon/runtime/capture/attach.ts:167`. Live DeepLake row: not re-run (`tests/integration/golden-path-live.itest.ts`).

### 021f AC-2 - UNVERIFIABLE

- Quote: "Given a captured session, when it ends, then the summary worker produces a `memory` summary row."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021f-go-live-dogfood-acceptance.md:53`
- Source: `src/daemon/runtime/summaries/worker.ts:617` and session-end enqueue `src/daemon/runtime/capture/attach.ts:198`. A live summary row was not read back.

### 021f AC-3 - UNVERIFIABLE

- Quote: "Given a later session, when recall runs, then it surfaces the prior summary and turns end-to-end, proving cross-session memory."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021f-go-live-dogfood-acceptance.md:54`
- Source: `src/daemon/runtime/memories/api.ts:755`. Live cross-session recall was not re-run.

### 021f AC-4 - UNMET

- Quote: "Given a live session, when the dashboard and live log are open, then the real session appears and capture events stream in real time."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021f-go-live-dogfood-acceptance.md:55`
- Source: same gap as index AC-3 and 021d AC-3/AC-4. Dashboard host ABSENT. `followLogs` has no production caller (`src/dashboard/logs.ts:92`).

### 021f AC-5 - UNVERIFIABLE

- Quote: "Given the golden-path smoke, when an operator or CI with credentials runs it, then setup, capture, summary, and cross-session recall complete in one pass."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021f-go-live-dogfood-acceptance.md:56`
- Source: `package.json` script `smoke:golden-path` runs `scripts/golden-path-smoke.mjs`. This pass did not run it.

### 021f AC-6 - UNMET

- Quote: "Given the go-live, when it is presented, then a redacted recorded demo and a recall-hit metric with token-savings visibility are available as receipts."
- PRD: `library/requirements/completed/prd-021-go-live/prd-021f-go-live-dogfood-acceptance.md:57`
- Source: a redacted recording under the PRD folder is ABSENT. `computeRecallHit` exists only in `tests/integration/golden-path-live.itest.ts:517`. Token-savings copy at `src/daemon/runtime/dashboard/roi-savings.ts:247` says output-token savings are not claimed. The June QA already marked the demo BLOCKED.

---

## PRD-022 Data-access API

Folder: `library/requirements/completed/prd-022-data-access-api/`
Index status line: Completed (`prd-022-data-access-api-index.md` line 3).
Recommended bucket: completed. Route groups are mounted. Live dogfood was not re-run.

### Index AC-1 - UNVERIFIABLE

- Quote: "Given a previously-captured turn, when `honeycomb recall \"<term>\"` runs, then it returns that turn through the real `/api/memories/recall` HTTP path (no 501, no 400) against live DeepLake."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022-data-access-api-index.md:57`
- Source: `src/daemon/runtime/memories/api.ts:755` and session headers at `src/commands/contracts.ts:493`. Live DeepLake recall was not re-run (`tests/integration/dogfood-acceptance-live.itest.ts`).

### Index AC-2 - UNVERIFIABLE

- Quote: "Given a `remember`/store through `/api/memories`, when it runs, then it lands a row that is then recallable, and modify and forget require a reason and are audited."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022-data-access-api-index.md:58`
- Source: store route `src/daemon/runtime/memories/api.ts:909`. Reason required at `src/daemon/runtime/memories/api.ts:457` and line 463. Audit write is `src/daemon/runtime/memories/store.ts:18`. Live write-then-recall was not re-run.

### Index AC-3 - MET

- Quote: "Given the assembled daemon, when it is inspected, then every data route group the CLI, SDK, and MCP target (`/api/memories`, `/memory`, `/api/goals`, `/api/kpis`, `/api/sources`, `/api/secrets`, `/api/skills`, `/api/rules`) is implemented (no 501) and fired by `assembleDaemon`, tenancy-scoped and value-safe."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022-data-access-api-index.md:59`
- Source: `assembleSeams` fires memories (`src/daemon/runtime/assemble.ts:1597`), vfs (`line 1675`), and product data (`line 1686`). Product data mounts goals, kpis, skills, rules, sources, and secrets (`src/daemon/runtime/product/api.ts:395`). Sources build is fail-soft (`src/daemon/runtime/assemble.ts:2022`). Secrets list names only (`src/daemon/runtime/secrets/api.ts:230`).

### 022a AC-1 - MET

- Quote: "Given `mountMemoriesApi(daemon, { storage })`, when it is called, then the `/api/memories/*` handlers are attached to the daemon, mirroring the existing mount-seam shape."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022a-data-access-api-memories.md:52`
- Source: `src/daemon/runtime/memories/api.ts:728` and the assembly call at `src/daemon/runtime/assemble.ts:1597`.

### 022a AC-2 - MET

- Quote: "Given a captured turn, when `POST /api/memories/recall` runs, then the recall engine returns it (no 501), using hybrid recall or the BM25 and ILIKE fallback when embeddings are off."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022a-data-access-api-memories.md:53`
- Source: `src/daemon/runtime/memories/api.ts:755`. Lexical fallback sets `degraded: true` when the semantic arm does not run (`src/daemon/runtime/memories/recall.ts:2816`).

### 022a AC-3 - MET

- Quote: "Given `POST /api/memories` with a valid body, when it runs, then the controlled-writes engine lands a real row (no 501) that is then recallable."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022a-data-access-api-memories.md:54`
- Source: `src/daemon/runtime/memories/api.ts:909`. Live recall of that row was not re-run; the handler is real.

### 022a AC-4 - MET

- Quote: "Given `memory_modify` or `memory_forget` without a `reason`, when it runs, then it is rejected, and given a valid `reason`, the mutation is performed and audited."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022a-data-access-api-memories.md:55`
- Source: `src/daemon/runtime/memories/api.ts:457` and line 463 (`reason` min length 1). Audit row: `src/daemon/runtime/memories/store.ts:18`.

### 022a AC-5 - MET

- Quote: "Given any memory route with a malformed body, when it runs, then Zod validation rejects it with a 400 before the engine is reached."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022a-data-access-api-memories.md:56`
- Source: `src/daemon/runtime/memories/api.ts:514` returns 400 on failed validation.

### 022a AC-6 - MET

- Quote: "Given the `/api/memories` session group behind the runtime-path middleware, when a request arrives without `x-honeycomb-session`, then the middleware rejects it, and the requirement is documented for the clients."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022a-data-access-api-memories.md:57`
- Source: `src/daemon/runtime/middleware/runtime-path.ts:277` returns 400 when the session header is missing. Client stamping is documented at `src/commands/contracts.ts:462`.

### 022b AC-1 - MET

- Quote: "Given a `cat` or read on a `/memory/<path>`, when it runs, then the handler reads the underlying row and returns its content."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022b-data-access-api-vfs-browse.md:52`
- Source: `src/daemon/runtime/vfs/api.ts:454` (`GET /memory/cat`).

### 022b AC-2 - MET

- Quote: "Given a `grep` or `Glob` over `/memory`, when it runs, then the handler runs hybrid search through the recall engine, with the BM25 and ILIKE fallback when embeddings are off."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022b-data-access-api-vfs-browse.md:53`
- Source: `src/daemon/runtime/vfs/api.ts:463` (`GET /memory/grep` calls `fetchGrep`).

### 022b AC-3 - MET

- Quote: "Given an `ls` on a `/memory/<prefix>`, when it runs, then the handler returns the entries under that prefix."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022b-data-access-api-vfs-browse.md:54`
- Source: `src/daemon/runtime/vfs/api.ts:481`.

### 022b AC-4 - MET

- Quote: "Given a `find` with a pattern, when it runs, then the handler returns the memories matching the pattern."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022b-data-access-api-vfs-browse.md:55`
- Source: `src/daemon/runtime/vfs/api.ts:490`.

### 022b AC-5 - MET

- Quote: "Given a path, when it is routed daemon-side, then it classifies via the PRD-015 `classify.ts` contract, matching the client-side classification."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022b-data-access-api-vfs-browse.md:56`
- Source: `src/daemon/runtime/vfs/api.ts:64` imports `classifyPath` from `src/daemon-client/vfs/classify.js`, and `src/daemon/runtime/vfs/api.ts:503` returns `classifyPath(path)`.

### 022b AC-6 - MET

- Quote: "Given a write on a memory path, when it is attempted, then it is denied with guidance pointing at the audited `/api/memories` write routes."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022b-data-access-api-vfs-browse.md:57`
- Source: `src/daemon/runtime/vfs/api.ts:411` (`writeRoute: "/api/memories"`) and line 450 (405).

### 022c AC-1 - MET

- Quote: "Given `honeycomb goal add`, when it runs, then `/api/goals` lands the goal via the PRD-003d update-or-insert-by-key path and a `/api/goals` read returns it."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022c-data-access-api-product-data.md:52`
- Source: `src/daemon/runtime/product/keyed-engine.ts:273` (`updateOrInsertByKey`) and the GET read at line 135. Mounted from `src/daemon/runtime/product/api.ts:395`.

### 022c AC-2 - MET

- Quote: "Given `honeycomb kpi add` with an existing key, when it runs, then `/api/kpis` updates the existing KPI rather than inserting a duplicate."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022c-data-access-api-product-data.md:53`
- Source: the same keyed engine (`src/daemon/runtime/product/keyed-engine.ts:142`) is bound to kpis at `src/daemon/runtime/product/api.ts:399`.

### 022c AC-3 - MET

- Quote: "Given `/api/skills` and `/api/rules` reads, when they run, then they return the scoped tenant's mined skills and rules."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022c-data-access-api-product-data.md:54`
- Source: `src/daemon/runtime/product/api.ts:405` mounts both reads. Highest-version SQL is `src/daemon/runtime/product/api.ts:171`. Scope resolution 400s when org is missing (`src/daemon/runtime/product/api.ts:329`).

### 022c AC-4 - MET

- Quote: "Given the assembled daemon, when it is inspected, then `mountSourcesApi` is mounted and `/api/sources` answers rather than 404."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022c-data-access-api-product-data.md:55`
- Source: `src/daemon/runtime/product/api.ts:345` calls `mountSourcesApi`, fired when sources deps exist (`src/daemon/runtime/product/api.ts:413`). Assembly builds those deps at `src/daemon/runtime/assemble.ts:2022`. A construction throw leaves sources unmounted for that boot (fail-soft at line 2024).

### 022c AC-5 - MET

- Quote: "Given `/api/secrets`, when it is read, then it returns secret names only and never a secret value."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022c-data-access-api-product-data.md:56`
- Source: `src/daemon/runtime/secrets/api.ts:6` (no value-returning route) and line 230 (GET lists names). POST echoes the name only (line 258).

### 022c AC-6 - MET

- Quote: "Given any product-data route with a malformed or cross-tenant body, when it runs, then Zod validation or the tenancy scope rejects it at the edge."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022c-data-access-api-product-data.md:57`
- Source: `src/daemon/runtime/product/keyed-engine.ts:56` (`.strict()`) and line 263 (`safeParse`). Missing org is 400 at `src/daemon/runtime/product/api.ts:329`.

### 022d AC-1 - MET

- Quote: "Given `assembleSeams()`, when the daemon is assembled, then every data-API mount seam is fired exactly once after construction, proven by the extended `assemble.test.ts` coverage."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022d-data-access-api-assembly-and-clients.md:50`
- Source: one call each at `src/daemon/runtime/assemble.ts:1597`, line 1675, and line 1686. The test file was not re-executed in this pass.

### 022d AC-2 - MET

- Quote: "Given a one-shot `honeycomb recall`, when it runs, then the loopback `DaemonClient` stamps `x-honeycomb-session` and the request reaches the handler instead of 400ing at the runtime-path middleware."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022d-data-access-api-assembly-and-clients.md:51`
- Source: `src/commands/contracts.ts:490` stamps `x-honeycomb-session` on `/api/memories` and `/memory`.

### 022d AC-3 - MET

- Quote: "Given a session-scoped verb from a stateless CLI invocation, when it runs, then a synthetic session id is minted and stamped so the session-group requirement is satisfied."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022d-data-access-api-assembly-and-clients.md:52`
- Source: `src/commands/contracts.ts:449` (`cli-<pid>-<counter>`).

### 022d AC-4 - MET

- Quote: "Given the CLI on Windows, when a verb completes, then it exits cleanly with no `UV_HANDLE_CLOSING` assertion and no exit 127."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022d-data-access-api-assembly-and-clients.md:53`
- Source: `src/cli/index.ts:74` calls `finalizeCliExit` (`src/cli/exit.ts:80`) and sets `process.exitCode` instead of `process.exit`. A Windows run was not performed.

### 022d AC-5 - MET

- Quote: "Given the SDK `recall()` and `remember()`, when they run, then they reach the wired `/api/memories` endpoints with the session header stamped."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022d-data-access-api-assembly-and-clients.md:54`
- Source: `src/sdk/client.ts:85` (`x-honeycomb-session`) and the session-group stamp noted at `src/sdk/client.ts:90`.

### 022d AC-6 - MET

- Quote: "Given the MCP `memory_search` and `memory_store` tools, when they run, then they reach the wired endpoints with the session header stamped."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022d-data-access-api-assembly-and-clients.md:55`
- Source: `mcp/src/handlers.ts:227` and line 230. Session header: `mcp/src/daemon-seam.ts:90`.

### 022e AC-1 - UNVERIFIABLE

- Quote: "Given a previously-captured turn, when `honeycomb recall \"<term>\"` runs, then it returns that turn through the real `/api/memories/recall` HTTP path (no 501, no 400) against live DeepLake."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022e-data-access-api-dogfood-acceptance.md:53`
- Source: same route as index AC-1. Live itest `tests/integration/dogfood-acceptance-live.itest.ts` was not executed.

### 022e AC-2 - UNVERIFIABLE

- Quote: "Given the same captured turn, when the SDK `recall()` runs, then it returns that turn through the same HTTP route with the session header stamped."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022e-data-access-api-dogfood-acceptance.md:54`
- Source: `src/sdk/client.ts:85`. Live SDK recall was not run.

### 022e AC-3 - UNVERIFIABLE

- Quote: "Given the same captured turn, when the MCP `memory_search` tool runs, then it returns that turn through the same HTTP route with the session header stamped."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022e-data-access-api-dogfood-acceptance.md:55`
- Source: `mcp/src/handlers.ts:227`. Live MCP recall was not run.

### 022e AC-4 - UNVERIFIABLE

- Quote: "Given a `remember` through `/api/memories`, when it lands a row, then a later recall through the HTTP route returns that row, proving the write-then-read loop over HTTP."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022e-data-access-api-dogfood-acceptance.md:56`
- Source: store plus recall handlers exist. The live loop was not re-run.

### 022e AC-5 - UNVERIFIABLE

- Quote: "Given the gated live golden-path itest, when it runs with credentials, then it drives recall via the HTTP route (not direct SQL) and passes."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022e-data-access-api-dogfood-acceptance.md:57`
- Source: `tests/integration/dogfood-acceptance-live.itest.ts` exists. It was not executed.

### 022e AC-6 - UNVERIFIABLE

- Quote: "Given the data-API smoke, when an operator or CI with credentials runs it, then setup, capture, recall-through-HTTP, and remember-then-recall complete in one pass."
- PRD: `library/requirements/completed/prd-022-data-access-api/prd-022e-data-access-api-dogfood-acceptance.md:58`
- Source: `package.json` script `smoke:data-api` runs `scripts/dogfood-acceptance-smoke.mjs`. This pass did not run it.

---

## PRD-023 DeepLake connect parity

Folder: `library/requirements/completed/prd-023-deeplake-connect-parity/`
Index status line: completed (`prd-023-deeplake-connect-parity-index.md` line 3).
Recommended bucket: completed.

### AC-1 - MET

- Quote: "`honeycomb login` (device flow). Runs RFC-8628 against `api.deeplake.ai` (`/auth/device/code` -> prints + opens the verification URI -> polls `/auth/device/token` -> mints a long-lived token via `/users/me/tokens` -> validates via `/me`) and writes `~/.deeplake/credentials.json` in the Hivemind shape (0600). Proven: unit test with a fake issuer drives the full happy path + pending-poll + expiry; the written file parses to the exact Hivemind shape."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:20`
- Source: `src/daemon/runtime/auth/deeplake-issuer.ts:9` (the four routes) and `loginWithDeviceFlow` at line 891. File mode `0o600` is `src/daemon/runtime/auth/credentials-store.ts:127`. https-only opener is `src/daemon/runtime/auth/deeplake-issuer.ts:470`.

### AC-2 - MET

- Quote: "Headless/CI login. `HONEYCOMB_TOKEN=<key> honeycomb login` (and/or `--token`) skips the browser, validates via `/me`, and saves the shared file - parity with `HIVEMIND_TOKEN`."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:21`
- Source: `src/daemon/runtime/auth/deeplake-issuer.ts:934` (`loginWithToken`).

### AC-3 - MET

- Quote: "`honeycomb whoami`. GETs `/me`, prints the authenticated user + active org + workspace (NEVER the token). Reads the shared file; works against a file written by `hivemind login`."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:22`
- Source: `src/cli/whoami.ts:95` loads the shared file and calls `getMe` at line 109. The print path uses name, org, and workspace (line 117 onward) and does not print `disk.token`.

### AC-4 - MET

- Quote: "`honeycomb org list` + `org switch <name|id>`. `org list` enumerates the user's orgs from the backend; `org switch` re-mints for the target org and updates the shared file."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:23`
- Source: `src/cli/org.ts:187` (`listOrgs`) and `src/cli/org.ts:206` (`org switch`). Backend list is `GET /organizations` at `src/daemon/runtime/auth/deeplake-issuer.ts:340`.

### AC-5 - MET

- Quote: "`honeycomb workspaces` + `workspace switch <name|id>`. `workspaces` lists from `GET /workspaces`; `workspace switch` updates `workspaceId` in the shared file."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:24`
- Source: `src/cli/org.ts:277` and `src/cli/org.ts:297`. `GET /workspaces` is `src/daemon/runtime/auth/deeplake-issuer.ts:344`.

### AC-6 - MET

- Quote: "`honeycomb logout`. Removes the shared creds file (and the legacy path); exits 0 even if absent; never errors on a missing file."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:25`
- Source: `src/cli/auth.ts:425` unlinks the shared path and the legacy path, and skips a missing file (`existsSync` at line 430).

### AC-7 - MET

- Quote: "Daemon auto-connect from the shared file. `deeplakeCredentialsFileProvider()` reads `~/.deeplake/credentials.json`; the daemon's default provider is env-over-file. With NO `HONEYCOMB_DEEPLAKE_*` env and a valid shared file, the assembled daemon resolves a valid `StorageConfig` and connects."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:26`
- Source: `src/daemon/storage/config.ts:155` and `defaultCredentialProvider` at line 200 (env wins per field, file fills the rest). Assembly uses it at `src/daemon/runtime/assemble.ts:3079`. A live connect was not re-run; the resolver is present.

### AC-8 - UNVERIFIABLE

- Quote: "Live parity proof (gated). A gated `.itest.ts`: seed `~/.deeplake/credentials.json` (token from env, Hivemind shape) in a temp HOME -> boot the assembled daemon with NO `HONEYCOMB_DEEPLAKE_*` env -> it connects from the file -> a store->recall through `/api/memories/recall` succeeds live. AND assert the file Honeycomb writes is byte-shape-compatible with what Hivemind reads."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:27`
- Source: `tests/integration/connect-parity-live.itest.ts` exists. It was not executed.

### AC-9 - UNVERIFIABLE

- Quote: "Security. No token in any log/stdout/stderr/error/URL (grep-proven in tests); file is 0600 (POSIX; best-effort + documented on win32); device-flow opens only the validated verification URI. `npm run ci`/`build`/`audit:sql`/`audit:openclaw`/invariant all green."
- PRD: `library/requirements/completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md:28`
- Source: 0600 is `src/daemon/runtime/auth/credentials-store.ts:515`. The opener accepts only `https:` at `src/daemon/runtime/auth/deeplake-issuer.ts:470`. The ci/build/audit gates were not run in this pass.

---

## PRD-024 Dashboard UI parity

Folder: `library/requirements/completed/prd-024-dashboard-ui-parity/`
Index status line: completed (`prd-024-dashboard-ui-parity-index.md` line 3).
Recommended bucket: completed, with the hive-portal caveat in the bucket section. In-tree UI criteria are unmet.

### AC-1 - UNMET

- Quote: "The look. `GET /dashboard` renders the UI-kit layout (header + recall bar + memory cards + KPI row + 2-col {sessions, rules | graph, skill-sync} + live log + connectivity banner) on the design-system tokens, matching `assets/ui_kits/dashboard/index.html`. Served production-clean: no CDN React, no in-browser Babel, no `unpkg` - a repo-bundled asset (esbuild entry). A unit/DOM test asserts the structure renders."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:46`
- Source: `GET /dashboard` and the UI-kit React bundle are ABSENT. `src/daemon/runtime/dashboard/CONVENTIONS.md:48`. `renderDashboardPage` at `src/dashboard/html.ts:88` serializes ViewBlocks and is not mounted.

### AC-2 - UNMET

- Quote: "Live data. KPIs, sessions, rules, skills, graph, settings render from the LIVE diagnostics endpoints (not canned), proven against a real assembled daemon; empty states honored."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:50`
- Source: the fetch of live endpoints exists at `src/dashboard/launch.ts:110`. The dashboard command does not render that tree (`src/cli/runtime.ts:726` returns only `reachable`). A served view of those endpoints is ABSENT in this repo. Empty-state builders remain at `src/dashboard/views.ts:132`.

### AC-3 - UNMET

- Quote: "Recall. The recall bar POSTs `/api/memories/recall` (session-group headers) and renders the real hits as memory cards (snippet/score/scope/verified/source) - the renderer is the one fixed in #39."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:52`
- Source: the recall bar and memory-card renderer are ABSENT. The daemon route `POST /api/memories/recall` exists at `src/daemon/runtime/memories/api.ts:755`.

### AC-4 - UNMET

- Quote: "Live log. The LiveLog panel shows real `/api/logs` events (poll or stream); no secret/token in a line."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:54`
- Source: the LiveLog panel is ABSENT. `GET /api/logs/stream` exists at `src/daemon/runtime/logs/api.ts:235`. `formatLogLine` exists at `src/dashboard/logs.ts:158` and is not mounted in a page.

### AC-5 - UNMET

- Quote: "Connectivity. When `/health` is unreachable the ConnectivityBanner replaces the view with the daemon-down state + retry; on reconnect it restores. Proven by toggling the daemon."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:55`
- Source: `buildConnectivityBanner` exists at `src/dashboard/dashboard.ts:47`. There is no served view that swaps to it and retries. The CLI prints one down line (`src/commands/local-handlers.ts:241`). A daemon toggle was not performed.

### AC-6 - UNMET

- Quote: "Pollinate now (real). A new daemon endpoint triggers the real Pollinating loop; the button calls it, the graph's pollinating node pulses + the consolidation pass streams into the log. Endpoint is authz'd + local-gated; unit-tested (trigger fires the loop seam) + a gated live check."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:57`
- Source: `POST /api/diagnostics/pollinate` is mounted at `src/daemon/runtime/assemble.ts:1702` and implemented at `src/daemon/runtime/pollinating/api.ts:250`. The button, the pulsing graph node, and the consolidation stream into the log are ABSENT. A gated live check was not run.

### AC-7 - UNVERIFIABLE

- Quote: "Security. Dashboard host local-mode-only + XSS-safe; no token/secret in the page, data, logs, or the trigger response (grep-proven). `npm run ci`/`build`/`audit:sql`/`audit:openclaw`/invariant all green."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:60`
- Source: the dashboard host is ABSENT, so the local-mode host gate has nothing to attach to. The pollinate ack maps trigger reasons and does not include a token field (`src/daemon/runtime/pollinating/api.ts:208`). The ci/build/audit gates were not run.

### AC-8 - UNMET

- Quote: "Live verification. Against a real assembled daemon: the dashboard renders + functions (recall returns real hits, KPIs show real counts, pollinate-now triggers, connectivity banner on down). A gated itest covers the endpoints + the trigger; a manual/screenshot check confirms the look matches the mockup."
- PRD: `library/requirements/completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md:62`
- Source: a screenshot or mockup-match artifact is ABSENT. `tests/integration/dashboard-logs-live.itest.ts` exists and was not executed. The look cannot render from this repo because `GET /dashboard` is ABSENT.

---

## PRD-025 Semantic recall default

Folder: `library/requirements/completed/prd-025-semantic-recall-default/`
Index status line: completed (`prd-025-semantic-recall-default-index.md` line 3).
Recommended bucket: completed.

### AC-1 - MET

- Quote: "Default-on for a fresh user. After a clean `honeycomb login` on a machine with no prior config, the daemon has embeddings ENABLED with no flag set (D-1). A unit test asserts `resolveEmbedClientOptions` treats unset as enabled; a gated check confirms `login` provisions/owns the embed daemon."
- PRD: `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:87`
- Source: `src/daemon/runtime/services/embed-client.ts:169` enables embeddings unless `HONEYCOMB_EMBEDDINGS` is `false` or `0`. The supervisor owns start/stop (`src/daemon/runtime/services/embed-supervisor.ts:931` and line 960). A gated login-provisions check was not re-run; the default is in source.

### AC-2 - UNVERIFIABLE

- Quote: "Stored + captured rows carry a real vector. A memory stored via `POST /api/memories` AND a captured turn land with a non-NULL 768-dim `content_embedding` / `message_embedding` (the default seam is the real `createEmbedAttachment`, not `noopEmbedClient`). Proven against a real assembled daemon by reading the row back."
- PRD: `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:90`
- Source: `src/daemon/runtime/assemble.ts:3564` uses `createEmbedAttachment`. Columns are `content_embedding` (`src/daemon/storage/catalog/memories.ts:78`) and `message_embedding` (`src/daemon/storage/catalog/sessions-summaries.ts:41`). A live read-back was not performed.

### AC-3 - MET

- Quote: "Recall reaches the cosine path and reports it honestly. With embeddings available, `POST /api/memories/recall` runs the `<#>` semantic arm and returns `degraded: false`; with embeddings explicitly off (or daemon down), it returns `degraded: true` from the lexical arms. The hard-coded `degraded: true` in `recall.ts` (line 255) is gone. Unit-tested on both branches."
- PRD: `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:94`
- Source: `src/daemon/runtime/memories/recall.ts:2816` sets `degraded` from whether the semantic run is null. The old `src/daemon/runtime/recall.ts` file is ABSENT. Keyword mode forces `degraded` false on purpose at the same line.

### AC-4 - UNVERIFIABLE

- Quote: "Semantic beats lexical on a lexical-miss query (the behavioral bar, GATED LIVE ITEST). A gated live itest captures a turn, waits for embedding convergence, then issues a recall query that a pure BM25/ILIKE match would MISS and asserts the semantic path SURFACES the captured memory while the lexical-only arm does not."
- PRD: `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:98`
- Source: `tests/integration/semantic-recall-live.itest.ts` exists. It was not executed.

### AC-5 - UNVERIFIABLE

- Quote: "Graceful, non-hanging degrade. With the embed daemon killed mid-session, recall still answers 200 with `degraded: true` within the timeout budget (never hangs, never 500s); on daemon restart/warmup, a subsequent recall returns `degraded: false`. Proven by a gated live toggle."
- PRD: `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:104`
- Source: supervisor `stop`/`restart` exist at `src/daemon/runtime/services/embed-supervisor.ts:931` and line 960. Recall degrades when the semantic arm does not run (`src/daemon/runtime/memories/recall.ts:2816`). A live kill/restart toggle was not performed.

### AC-6 - MET

- Quote: "The dim invariant holds. `EMBEDDING_DIMS = 768` <-> schema `FLOAT4[]` <-> model output stay locked; a non-768 / malformed vector is rejected to NULL and the row stays lexically recallable. Unit-tested + asserted on the live store."
- PRD: `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:107`
- Source: `src/daemon/storage/vector.ts:35` (`EMBEDDING_DIMS = 768`). Reject path `src/daemon/runtime/services/embed-client.ts:272` returns null. Schema comments name nullable `FLOAT4[]` at `src/daemon/storage/catalog/memories.ts:47`. A live store assertion was not re-run; the reject path is in source.

### AC-7 - UNVERIFIABLE

- Quote: "Gates green. `npm run ci` / `build` / `audit:sql` / `audit:openclaw` / invariant stay green; no secret/credential in the embed IPC, the model-download logs, or the recall path. The npm artifact does NOT balloon by 600 MB."
- PRD: `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:110`
- Source: those gates and `pack:check` were not run in this pass.

---

## PRD-026 Pollinating loop enablement

Folder: `library/requirements/completed/prd-026-pollinating-loop-enablement/`
Index status line: completed (`prd-026-pollinating-loop-enablement-index.md` line 3).
Recommended bucket: completed. The shipped default stays off, matching this PRD.

### AC-1 - MET

- Quote: "Enable flips the live trigger. With `memory.pollinating.enabled` true, `POST /api/diagnostics/pollinate` no longer returns `reason:\"disabled\"`: it returns `{triggered:true, status:\"enqueued\"}` when at/over threshold (or `status:\"running\"` when a pass is already pending / below threshold). With it false it still returns the `skipped`/`disabled` ack."
- PRD: `library/requirements/completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md:81`
- Source: default `enabled: false` at `src/daemon/runtime/pollinating/config.ts:59`. Env override `HONEYCOMB_POLLINATING_ENABLED` at line 114. Ack mapping: enqueued, disabled/skipped, and running at `src/daemon/runtime/pollinating/api.ts:208`. Below-threshold now returns `status: "below-threshold"` with `triggered: true` (line 214), which is a later status split from the AC's "running when below threshold" wording. The disabled ack still returns `skipped`.

### AC-2 - UNVERIFIABLE

- Quote: "Cadence + single-pending guard hold live. Summary-write increments accumulate `tokens_since_last_pass`; crossing `tokenThreshold` enqueues exactly ONE `pollinating` job and resets by SUBTRACT; a second tick while `pending_job_id` is set enqueues NOTHING. Proven by a gated live counter exercise."
- PRD: `library/requirements/completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md:86`
- Source: subtract reset and single-pending guard are described and implemented in `src/daemon/runtime/pollinating/trigger.ts:20` and line 397. The live file is `tests/integration/pollinating-counter-live.itest.ts`. It was not executed.

### AC-3 - UNVERIFIABLE

- Quote: "A real pass consolidates a seeded set (the behavioral bar). Gated live itest: seed a workspace with (a) two duplicate entities, (b) a stale attribute plus its newer contradicting claim, (c) a junk entity. Run ONE real Pollinating pass against live DeepLake. After the pass, read back poll-convergently and assert the duplicates are merged (or a merge proposal is pending), the stale attribute is superseded, and the junk entity is archived/pending-archive."
- PRD: `library/requirements/completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md:90`
- Source: worker and runner exist (`src/daemon/runtime/pollinating/worker.ts`, `src/daemon/runtime/pollinating/runner.ts:284` calls `submitProposal`). The live file is `tests/integration/pollinating-consolidation-live.itest.ts`. It was not executed.

### AC-4 - UNVERIFIABLE

- Quote: "Nothing source-backed is lost. In the same live pass, a source-backed memory/claim present before the pass is STILL resolvable after it (active, with its provenance intact). Before/after counts of source-backed claims are non-decreasing for the survivors."
- PRD: `library/requirements/completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md:96`
- Source: the assertion lives in `tests/integration/pollinating-consolidation-live.itest.ts`. It was not executed.

### AC-5 - UNVERIFIABLE

- Quote: "Before/after measurement is recorded. The live itest captures a before/after snapshot (duplicate-entity count, active-vs-superseded claim counts, junk-entity count) and asserts the delta in the consolidating direction."
- PRD: `library/requirements/completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md:100`
- Source: the snapshot is part of `tests/integration/pollinating-consolidation-live.itest.ts`. It was not executed. A durable receipt file under the PRD `reports/` folder from that run is ABSENT; the June QA says the receipt was a console line.

### AC-6 - UNVERIFIABLE

- Quote: "Safety + gates green. Destructive mutations land in pending review (never blind-applied); the pollinate-trigger ack carries no token/secret; `npm run ci`, `build`, `audit:sql`, `audit:openclaw`, and the invariant test all pass. The live itest is gated."
- PRD: `library/requirements/completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md:104`
- Source: destructive kinds map outside direct-apply at `src/daemon/runtime/pollinating/contracts.ts:144` (`merge_entities` -> `entity.merge`, deletes -> archive). The ack shape at `src/daemon/runtime/pollinating/api.ts:208` has no token field. The ci/build/audit gates were not run. Live itests are present and were not executed.
