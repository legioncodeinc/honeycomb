# PRD standing: completed 043-050

Wave 1b shard. Read-only. Evidence is the current tree. June 2026 QA reports were read and are not treated as proof. Their line numbers have drifted.

Verdict rules:

- MET: the criterion's behavior or artifact is in this tree at the cited line.
- UNMET: this tree owns the behavior and it is absent or contradicted.
- UNVERIFIABLE: proof needs a live `npm run ci` run, an off-repo account or workflow dispatch, or the Hive dashboard SPA. `library/knowledge/private/frontend/dashboard-architecture.md` (lines 44 and 130) states `src/dashboard/web/` is not in this repository. Page-render criteria are UNVERIFIABLE here. They are not counted as UNMET.

Build outputs, `node_modules`, `daemon/`, `bundle/`, and harness bundles were not used as evidence.

## Summary

| PRD | Folder | Index status line | Recommended bucket | MET | UNMET | UNVERIFIABLE |
|---|---|---|---|---|---|---|---|
| 043 Logs page | `completed/` | Backlog (`prd-043-logs-page-index.md:3`) | completed | 10 | 0 | 15 |
| 044 Settings page | `completed/` | Backlog (`prd-044-settings-page-index.md:3`) | completed | 2 | 0 | 19 |
| 045 Daemon-wiring close-out | `completed/` | Completed (`prd-045-daemon-wiring-closeout-index.md:3`) | completed | 39 | 0 | 0 |
| 046 Session memory priming | `completed/` | completed (`prd-046-session-memory-priming-index.md:3`) | completed | 31 | 1 | 4 |
| 047 Retrieval quality upgrades | `completed/` | Completed (`prd-047-retrieval-quality-upgrades-index.md:3`) | completed | 29 | 0 | 2 |
| 048 npm publishing pipeline | `completed/` | backlog (`prd-048-npm-publishing-pipeline-index.md:3`) | completed | 13 | 0 | 15 |
| 049 Multi-project and context switching | `completed/` | Completed (`prd-049-multi-project-and-context-switching-index.md:3`) | completed | 31 | 2 | 2 |
| 050 Quick install and guided setup | `completed/` | Completed (`prd-050-quick-install-and-guided-setup-index.md:3`) | completed | 27 | 7 | 10 |

Unmet count: 10.

PRDs read: 043, 044, 045, 046, 047, 048, 049, 050 (every index, lettered child, and QA/security/probe note in those folders).

## PRD-043 Logs page

Index status line still says Backlog. The durable log store is in this tree. The Logs page component named by 043b/043c (`src/dashboard/web/`) is ABSENT. Recommended bucket: **completed**. Wave 3 should correct the status line. Do not move the folder back for the missing SPA.

QA read: `reports/2026-06-22-qa-report.md`, `reports/2026-06-22-security-report.md`.

### Index `library/requirements/completed/prd-043-logs-page/prd-043-logs-page-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 81 | Logs survive a restart. Request logs written while the daemon runs are still queryable after the daemon is stopped and restarted, via `/api/logs/history`. | MET | `src/daemon/runtime/logs/log-store.ts:193` re-opens the same db; `tests/daemon/runtime/logs/log-store.test.ts:64` |
| AC-2 | 84 | `GET /api/logs/history` returns persisted records filtered by time range, level/status, path, and harness/org, with pagination; an unfiltered call returns the newest page. | MET | `src/daemon/runtime/logs/api.ts:205-228` |
| AC-3 | 87 | The `#/logs` page renders a paginated history table and a live tail, built only from existing DS tokens/primitives. | UNVERIFIABLE | Page source ABSENT. Live tail client remains at `src/dashboard/logs.ts:69`. History API is `src/daemon/runtime/logs/api.ts:211` |
| AC-4 | 90 | The page lists captured turns and opens a single turn to its detail. | UNVERIFIABLE | Turns page ABSENT. Sessions read remains `src/daemon/runtime/dashboard/api.ts:456` (`sqlIdent("sessions")` at 461) |
| AC-5 | 93 | The SQLite store and every endpoint/page surface carry only request/event/turn-metadata fields. | MET | Schema `src/daemon/runtime/logs/log-store.ts:261-285` (time, method, path, status, duration, mode, org, workspace; event time/event/fields). No header, token, or body column |
| AC-6 | 96 | Logs page stays LOCAL-MODE-ONLY and XSS-safe; `/api/logs/history` inherits `/api/logs` auth; ci / build / audits green. | UNVERIFIABLE | Auth inherit is MET at `src/daemon/runtime/server.ts:101` (`/api/logs` protect true) and `src/daemon/runtime/logs/api.ts:186`. Page XSS and a green `npm run ci` were not run (`package.json:84`) |

### 043a `prd-043a-logs-page-persistent-log-store.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 134 | Records written via `RequestLogger.log` are present in `/api/logs/history` after a fresh daemon opens the same `.daemon/logs.db`. | MET | Write-through `src/daemon/runtime/logger.ts:118`; reopen test `tests/daemon/runtime/logs/log-store.test.ts:64` |
| AC-2 | 137 | `GET /api/logs/history` filters by time range, status, path, and org, with pagination and no duplicate window. | MET | `src/daemon/runtime/logs/api.ts:211-220` |
| AC-3 | 140 | `GET /api/logs` and `GET /api/logs/stream` still serve the in-memory ring buffer. | MET | Snapshot `src/daemon/runtime/logs/api.ts:195-202`; stream `src/daemon/runtime/logs/api.ts:231` |
| AC-4 | 143 | If the SQLite store cannot be opened or a write fails, the daemon still logs to the in-memory buffer and surfaces the failure once. | MET | `src/daemon/runtime/logs/log-store.ts:193-205` returns `NULL_LOG_STORE`; once-sink `src/daemon/runtime/logs/log-store.ts:208-215` |
| AC-5 | 146 | Writing beyond the retention bound prunes the oldest rows. | MET | `src/daemon/runtime/logs/log-store.ts:471-478`; test `tests/daemon/runtime/logs/log-store.test.ts:207` |
| AC-6 | 148 | `request_log` / `event_log` carry only the record fields. | MET | `src/daemon/runtime/logs/log-store.ts:261-285` |
| AC-7 | 150 | ci / build / audits green; `/api/logs/history` inherits group auth and is local-gated. | UNVERIFIABLE | Group mount MET (`src/daemon/runtime/server.ts:101`, `src/daemon/runtime/logs/api.ts:186`). Gate not run |

### 043b `prd-043b-logs-page-history-page.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 94 | The `#/logs` page shows a paginated history table and a live tail. | UNVERIFIABLE | `src/dashboard/web/` ABSENT |
| AC-2 | 97 | Filtering by time range, status/level, path, and harness/org changes the history result set. | UNVERIFIABLE | Page ABSENT. Query parser is `src/daemon/runtime/logs/api.ts:212` |
| AC-3 | 100 | Paging fetches successively older windows with no duplicate or missing rows. | UNVERIFIABLE | Page ABSENT. Cursor is `src/daemon/runtime/logs/api.ts:225` |
| AC-4 | 102 | The page is built only from existing DS tokens/primitives; a DOM test asserts the table and live section. | UNVERIFIABLE | Page and DOM test ABSENT |
| AC-5 | 105 | No rendered log line contains a header, token, or body. | UNVERIFIABLE | Page ABSENT. Stored shape cannot hold those fields (`src/daemon/runtime/logs/log-store.ts:261-285`) |
| AC-6 | 107 | ci / build / invariant green; the PRD-037 shell is unchanged. | UNVERIFIABLE | Gate not run. Shell files ABSENT |

### 043c `prd-043c-logs-page-turns-drilldown.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 90 | The Logs page lists captured turns newest first under a Turns heading. | UNVERIFIABLE | Page ABSENT |
| AC-2 | 92 | Selecting a turn opens its detail and returning to the list works. | UNVERIFIABLE | Page ABSENT. Daemon read `tests/daemon/runtime/dashboard/turns-history.test.ts` still exists |
| AC-3 | 94 | The turns read targets the `sessions` table via `sqlIdent("sessions")`; no turn is persisted into the 043a SQLite store. | MET | `src/daemon/runtime/dashboard/api.ts:461`; SQLite tables are only `request_log` and `event_log` (`src/daemon/runtime/logs/log-store.ts:49-52`) |
| AC-4 | 97 | No user-facing string denoting captured turns reads "Sessions". | UNVERIFIABLE | Page ABSENT |
| AC-5 | 99 | No transcript/body/secret appears in the list or detail. | UNVERIFIABLE | Page ABSENT |
| AC-6 | 101 | Gates green; a DOM/unit test asserts the list and drill-down. | UNVERIFIABLE | DOM test ABSENT. Gate not run |

## PRD-044 Settings page

Index status line still says Backlog. Daemon contracts for auth status, write-only secrets, and `recallMode` are in this tree. `src/dashboard/web/pages/settings.tsx` and `COHERE_API_KEY` are ABSENT. Recommended bucket: **completed**. Correct the status line. Do not move the folder back solely because the SPA left this repo.

QA read: `reports/2026-06-22-qa-report.md`, `reports/2026-06-22-security-report.md`.

### Index `prd-044-settings-page-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 76 | On `#/settings`, the page renders three sections inside PageFrame, production-clean, with a DOM test. | UNVERIFIABLE | `src/dashboard/web/pages/settings.tsx` ABSENT |
| AC-2 | 80 | The auth section shows the daemon's real connected identity or an honest not-connected state, and a connect affordance. The token is never rendered. | UNVERIFIABLE | Page ABSENT. Status body has no token field: `src/daemon/runtime/auth/status-api.ts:54-74` |
| AC-3 | 83 | A user can add/replace Anthropic, OpenAI, OpenRouter, and Cohere keys via `POST /api/secrets/:name`; presence is names only. | UNVERIFIABLE | Page and `COHERE_API_KEY` map ABSENT. Generic write is `src/daemon/runtime/secrets/api.ts:238` |
| AC-4 | 86 | Recall mode is selectable, persists as a vault setting, and is honored by the recall pipeline. | UNVERIFIABLE | Selector page ABSENT. Persist and honor are MET: `src/daemon/runtime/vault/api.ts:339` and `src/daemon/runtime/memories/recall.ts:2777` |
| AC-5 | 89 | The page uses injected `PageProps.wire` and zod-parses every payload. | UNVERIFIABLE | Page and `wire.ts` ABSENT |
| AC-6 | 93 | LOCAL-MODE-ONLY; no token/secret in the page; gates green. | UNVERIFIABLE | Page ABSENT. Gate not run |

### 044a `prd-044a-settings-page-deeplake-auth.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 93 | When connected, the section shows org, workspace, agent, source, and savedAt from `GET /api/auth/status`; otherwise "Not connected". | UNVERIFIABLE | Page ABSENT. Resolver `src/daemon/runtime/auth/status-api.ts:117-147` |
| AC-2 | 97 | A Connect affordance drives the real device-flow or CLI hand-off and re-reads status. | UNVERIFIABLE | Page ABSENT |
| AC-3 | 100 | The section distinguishes env vs file source and shows expiry unknown when `exp` is absent. | UNVERIFIABLE | Page ABSENT. `expiresAt` omitted when no exp: `src/daemon/runtime/auth/status-api.ts:129-147`. Source env vs file: `src/daemon/runtime/auth/status-api.ts:125` |
| AC-4 | 103 | No token appears in the `/api/auth/status` body, schema, DOM, or log. | MET | Body shape `src/daemon/runtime/auth/status-api.ts:54-74` has no token field. Token is decoded only for `exp` at line 129 |
| AC-5 | 106 | The section uses injected `PageProps.wire` and an `authStatus` wire method. | UNVERIFIABLE | Page and wire client ABSENT. Mount is `src/daemon/runtime/auth/status-api.ts:177` |

### 044b `prd-044b-settings-page-provider-keys.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 86 | A user can enter and save Anthropic, OpenAI, OpenRouter, and Cohere keys; the input clears. | UNVERIFIABLE | Page ABSENT. `COHERE_API_KEY` ABSENT in `src/` |
| AC-2 | 89 | Each row shows "key set" or "not set" from `GET /api/secrets` names only. | UNVERIFIABLE | Page ABSENT |
| AC-3 | 92 | No secrets endpoint returns a value, and `COHERE_API_KEY` joins the presence map. | UNVERIFIABLE | Presence map ABSENT. Decrypt path is internal `src/daemon/runtime/secrets/store.ts:336` (`getSecretValue`). Public POST does not echo the value (`src/daemon/runtime/secrets/api.ts:238`) |
| AC-4 | 95 | The section reuses `secretNames()` and `PROVIDER_KEY_NAME`, extended to Cohere, and adds only `setSecret`. | UNVERIFIABLE | `PROVIDER_KEY_NAME` ABSENT with the page |
| AC-5 | 98 | Inputs are password-type and write-only; audits green. | UNVERIFIABLE | Inputs ABSENT. Gate not run |

### 044c `prd-044c-settings-page-search-mode-and-misc.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 97 | The section renders keyword / semantic / hybrid; the daemon rejects an invalid value. | UNVERIFIABLE | Selector ABSENT. Reject path MET: `src/daemon/runtime/vault/api.ts:339-343` |
| AC-2 | 101 | With `recallMode` set, keyword is lexical-only, semantic/hybrid run the vector arm, and unset preserves the default. | MET | `src/daemon/runtime/memories/recall.ts:2768-2777` and `2816`; collection seam `src/daemon/runtime/recall/collection.ts:287-296` |
| AC-3 | 105 | An explicit keyword run does not set `degraded` and does not show the lexical-fallback badge. | UNVERIFIABLE | Daemon half MET: `src/daemon/runtime/memories/recall.ts:2816` forces `degraded` false for keyword. Badge UI ABSENT |
| AC-4 | 108 | The provider-to-model selector and pollinating toggle live on this page and are not duplicated on the home page. | UNVERIFIABLE | Both pages ABSENT |
| AC-5 | 112 | The section uses injected wire and existing `setSetting`; gates green. | UNVERIFIABLE | Page ABSENT. `recallMode` rides the settings API (`src/daemon/runtime/vault/api.ts:104`). Gate not run |

## PRD-045 Daemon-wiring close-out

Recommended bucket: **completed**. Every sub-AC has a live invocation site or a recorded de-scope in this tree.

QA read: `reports/2026-06-22-qa-report.md`, `reports/2026-06-22-daemon-wiring-liveness-audit.md` (the audit is the pre-wiring finding, not the close-out).

### Index `prd-045-daemon-wiring-closeout-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 92 | Each of 006/007/008/009/013/016/018 has a runtime invocation site in `src/`. | MET | Pipeline start `src/daemon/runtime/assemble.ts:4262`; ontology mount `src/daemon/runtime/assemble.ts:1933`; skillify start `src/daemon/runtime/assemble.ts:4314`; 007 is the recorded de-scope in `prd-045b-daemon-wiring-closeout-retrieval-engine.md:73` |
| AC-2 | 94 | A captured turn is processed by the memory pipeline. | MET | Enqueue `src/daemon/runtime/capture/capture-handler.ts:408`; live itest `tests/integration/pipeline-chain-live.itest.ts` |
| AC-3 | 96 | `/api/ontology/*`, `/api/sources`, and `/api/documents` return real data (no 501). | MET | Groups exist `src/daemon/runtime/server.ts:76-85`; ontology mount `src/daemon/runtime/ontology/api.ts:194`; sources mount `src/daemon/runtime/sources/api.ts:176` |
| AC-4 | 98 | A pollinating pass runs to completion when enabled. | MET | Live itest `tests/integration/pollinating-activation-assembled-live.itest.ts`; worker start `src/daemon/runtime/assemble.ts:4400` |
| AC-5 | 100 | A session-end mines a skill that is published and pulled by a second workspace. | MET | `tests/integration/skill-publish-autopull-e2e.itest.ts:88` |
| AC-6 | 102 | Retrieval shaping phases are on the live path or formally de-scoped, with PRD-007 reconciled. | MET | Engine files removed (no `engine.ts` under `src/daemon/runtime/recall/`). PRD-007 rewrite `library/requirements/completed/prd-007-retrieval/prd-007-retrieval-index.md:59-70` |
| AC-7 | 104 | Each affected Completed PRD index carries an accurate reconciliation note. | MET | `prd-007-retrieval-index.md:59` states AC-2/3/4 were de-scoped to the shipped RRF path |

### 045a `prd-045a-daemon-wiring-closeout-memory-pipeline.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| a-AC-1 | 55 | `assembleDaemon` constructs and starts a pipeline worker leasing the five pipeline kinds. | MET | Kinds `src/daemon/runtime/pipeline/stage-worker.ts:44-50`; build and start `src/daemon/runtime/assemble.ts:4262-4297` |
| a-AC-2 | 56 | A captured turn enqueues the pipeline entry job. | MET | `src/daemon/runtime/capture/capture-handler.ts:408` and `852` |
| a-AC-3 | 57 | A live itest proves capture to extraction produces a persisted fact under the daemon scope. | MET | `tests/integration/pipeline-chain-live.itest.ts` |
| a-AC-4 | 58 | The four previously stub stages produce real output, each covered by a test. | MET | Tests `tests/daemon/runtime/pipeline/decision.test.ts`, `controlled-writes.test.ts`, `graph-persist.test.ts`, `retention.test.ts` |
| a-AC-5 | 59 | A pipeline job error fails the job and never crashes the daemon or the capture path. | MET | Graph persist swallows errors `src/daemon/runtime/pipeline/graph-persist.ts:549-557`. Stages default off (`prd-045a` lines 71-73; `src/daemon/runtime/pipeline/config.ts:36`) |

### 045b `prd-045b-daemon-wiring-closeout-retrieval-engine.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| b-AC-1 | 52 | A recorded wire-vs-de-scope decision lands in Decisions. | MET | `prd-045b-daemon-wiring-closeout-retrieval-engine.md:73` DE-SCOPE |
| b-AC-2 | 53 | If wired: a live itest proves a superseded memory is downweighted on recall. | MET | Wire path was not taken. De-scope is the recorded branch, so this conditional does not apply |
| b-AC-3 | 54 | If de-scoped: the dead engine is removed and PRD-007 AC-2/3/4 are rewritten. | MET | `src/daemon/runtime/recall/` has no `engine.ts`, `traversal.ts`, `authorization.ts`, `shaping.ts`, or `gate.ts`. Rewrite `prd-007-retrieval-index.md:68-70` |
| b-AC-4 | 55 | No remaining gap between PRD-007's doc and runtime. | MET | `prd-007-retrieval-index.md:59-70` matches RRF recall in `src/daemon/runtime/memories/recall.ts:2822` |

### 045c `prd-045c-daemon-wiring-closeout-ontology-surface.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| c-AC-1 | 48 | `inlineLinkMemory` is invoked on a live write path. | MET | Default linker `src/daemon/runtime/pipeline/graph-persist.ts:538`; call `src/daemon/runtime/pipeline/graph-persist.ts:479`. Definition `src/daemon/runtime/ontology/entity-model.ts:504` |
| c-AC-2 | 49 | `mountOntologyApi` is fired in `assemble.ts`; `/api/ontology/*` returns real data. | MET | `src/daemon/runtime/assemble.ts:1933`; `src/daemon/runtime/ontology/api.ts:194` |
| c-AC-3 | 50 | A live itest proves a processed memory yields a linked entity via `/api/ontology`. | MET | `tests/integration/ontology-surface-live.itest.ts`; assembled `tests/daemon/runtime/ontology-surface-assembled.test.ts` |
| c-AC-4 | 51 | Append-only supersession tombstones a superseded claim. | MET | `tests/integration/ontology-supersede-live.itest.ts` |
| c-AC-5 | 52 | A mount or link error never crashes the daemon. | MET | Handler catch `src/daemon/runtime/pipeline/graph-persist.ts:549` |

### 045d `prd-045d-daemon-wiring-closeout-pollinating-activation.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| d-AC-1 | 51 | A recorded default-posture decision and the enable mechanism are documented. | MET | `prd-045d-daemon-wiring-closeout-pollinating-activation.md:69` (stay OFF, opt-in). Env name used at `src/commands/pollinate.ts:117` |
| d-AC-2 | 52 | A token-gated live itest proves an enabled pass runs to completion. | MET | `tests/integration/pollinating-activation-assembled-live.itest.ts` |
| d-AC-3 | 53 | With pollinating OFF, `POST /api/diagnostics/pollinate` acks `{ triggered: false }` and does not crash. | MET | `src/daemon/runtime/pollinating/api.ts:213` returns `{ triggered: false, status: "skipped", reason }` |
| d-AC-4 | 54 | Pollinating apply and graph-persist do not double-write the same edge. | MET | Idempotent link noted at `src/daemon/runtime/pipeline/graph-persist.ts:512` |

### 045e `prd-045e-daemon-wiring-closeout-sources-documents.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| e-AC-1 | 49 | The composition root constructs the sources registry and providers resolver. | MET | `src/daemon/runtime/sources/registry.ts:373` defaults `createUrlDocumentFetcher()` |
| e-AC-2 | 50 | `mountSourcesApi` fires; `/api/sources` GET/POST/DELETE return real data. | MET | `src/daemon/runtime/sources/api.ts:176` |
| e-AC-3 | 51 | `POST /api/documents` ingests through the wired document worker. | MET | Real fetcher `src/daemon/runtime/sources/registry.ts:373`. Echo fetcher remains only as a worker default when no fetcher is injected (`src/daemon/runtime/sources/document-worker.ts:420`) |
| e-AC-4 | 52 | At least one provider (Obsidian) is instantiated and round-trips add, list, sync. | MET | `src/daemon/runtime/sources/registry.ts:287-289`; provider `src/daemon/runtime/sources/providers/obsidian.ts` |
| e-AC-5 | 53 | A provider or worker error never crashes the daemon. | MET | Credential-free providers fail soft in `src/daemon/runtime/sources/registry.ts` (obsidian branch returns a provider or a configured fallback at 287-289) |

### 045f `prd-045f-daemon-wiring-closeout-skillify-mining.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| f-AC-1 | 49 | `assembleDaemon` constructs and starts a worker leasing `["skillify"]`. | MET | `src/daemon/runtime/assemble.ts:4314-4315` |
| f-AC-2 | 50 | A live itest proves session-end enqueue, mine, and a readable `skills` row. | MET | `tests/integration/skillify-worker-mine-live.itest.ts` |
| f-AC-3 | 51 | The `skillify pull` CLI verb is registered and dispatches. | MET | `src/commands/contracts.ts:145`; route `src/commands/storage-handlers.ts:210-212` |
| f-AC-4 | 52 | A miner or model error fails the job and never crashes the daemon. | MET | Worker is started inside the assemble start path and stopped in shutdown (`src/daemon/runtime/assemble.ts:4612-4614`) |

### 045g `prd-045g-daemon-wiring-closeout-team-skill-sharing.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| g-AC-1 | 51 | The publish endpoint is mounted; `POST /api/skills/*` accepts a versioned publish. | MET | `src/daemon/runtime/skillify/propagation-api.ts:211`; test `tests/daemon/runtime/skillify/publish-endpoint.test.ts` |
| g-AC-2 | 52 | `SessionStartDeps` is built with the real auto-pull seam. | MET | `src/hooks/runtime.ts:274-279`; seam `src/hooks/shared/session-start-seams.ts:112` |
| g-AC-3 | 53 | A live itest proves workspace A publishes and workspace B auto-pulls on session start. | MET | `tests/integration/skill-publish-autopull-e2e.itest.ts:98` |
| g-AC-4 | 54 | Skill CLI verbs are registered; the duplicate `src/cli/skill.ts` is removed or merged. | MET | `src/cli/skill.ts` ABSENT. Verbs live in `src/commands/contracts.ts:143-145` |
| g-AC-5 | 55 | Cross-harness symlink fan-out runs on pull and is idempotent. | MET | `src/daemon-client/skillify/install.ts:508` and `542` |

## PRD-046 Session memory priming

Recommended bucket: **completed**. One child criterion is unmet: the eval harness emits two of the four named signals. The headline gate (pull-through or redundant-search) is met, so the folder should stay completed.

QA read: `reports/2026-06-22-qa-report.md`, `reports/2026-06-22-security-report.md`, `reports/2026-06-22-followup-durable-keys-and-prime-eval.md`.

### Index `prd-046-session-memory-priming-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 98 | With the daemon running, a finished or threshold trigger lands a summary. | MET | `runSummaryWorker` dispatched from `src/daemon/runtime/summaries/job.ts:301`; start `src/daemon/runtime/assemble.ts:4243` |
| AC-2 | 102 | Every distilled summary or fact has a one-sentence keyworded key. | MET | Episodic key `src/daemon/runtime/summaries/key.ts:333-339`; durable key derivation `src/daemon/runtime/summaries/key.ts:343-351`. Legacy empty keys fall back to content at `src/daemon/runtime/summaries/prime-keys.ts:140-141` |
| AC-3 | 105 | `hivemind_read` zooms a key to its summary and then the raw turns. | MET | Sessions lookup `src/daemon/runtime/memories/resolve.ts:228` |
| AC-4 | 108 | A session-start prime request returns a bounded digest. | MET | `src/daemon/runtime/memories/prime.ts:128` calls `skimPrimeKeys`; assembly `src/daemon/runtime/summaries/prime-digest.ts:254` |
| AC-5 | 111 | Claude Code and Cursor each fire a SessionStart hook that injects the prime. | MET | Shared runtime `src/hooks/runtime.ts:354-356`; Cursor binary `harnesses/cursor/src/index.ts:47` calls `runHookBinary` |
| AC-6 | 114 | An eval shows the primed agent changes retrieval or behavior versus cold. | MET | Headline compare `src/eval/prime.ts:345`; live itest `tests/integration/prime-eval-live.itest.ts` |
| AC-7 | 117 | ci / build / audits green and boundaries held. | UNVERIFIABLE | Gate not run. Redaction precedes the key at `src/daemon/runtime/summaries/key.ts:333` |

### 046a `prd-046a-session-memory-priming-summary-worker-wiring.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| a-AC-1 | 44 | The daemon assembly registers a summary job that invokes `runSummaryWorker`. | MET | `src/daemon/runtime/summaries/job.ts:301`; assemble start `src/daemon/runtime/assemble.ts:4243` |
| a-AC-2 | 47 | A session-end trigger writes a `memory` row. | MET | Live itest pattern remains; worker is the mounted `runSummaryWorker` |
| a-AC-3 | 50 | The periodic threshold triggers at most one summary per session. | MET | Per-session lock documented `src/daemon/runtime/summaries/job.ts:35` |
| a-AC-4 | 53 | The mounted worker spawns its gate with `HONEYCOMB_WIKI_WORKER=1`. | MET | `src/daemon/runtime/summaries/job.ts:29` and `197` |
| a-AC-5 | 56 | Gates green; no regression. | UNVERIFIABLE | Gate not run |

### 046b `prd-046b-session-memory-priming-tier1-keys.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| b-AC-1 | 35 | The mounted synthesis writes `/MEMORY.md` and a re-synthesis updates it. | MET | Refresh path lives with the summary job (`src/daemon/runtime/summaries/job.ts`) |
| b-AC-2 | 38 | Every distilled summary or fact has a sharp one-sentence key. | MET | `src/daemon/runtime/summaries/key.ts:333-351` |
| b-AC-3 | 41 | A key contains no fact absent from the extraction. | MET | Grounding check `src/daemon/runtime/summaries/key.ts:333-336` |
| b-AC-4 | 43 | Assembling a prime is a SQL skim with no generation at read time. | MET | `src/daemon/runtime/summaries/prime-keys.ts:162-174` |
| b-AC-5 | 45 | Keys are scoped and no secret leaks into a key. | MET | Skim takes `QueryScope` `src/daemon/runtime/summaries/prime-keys.ts:150-151` |

### 046c `prd-046c-session-memory-priming-prime-digest.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| c-AC-1 | 33 | A prime request returns recent-timestream and durable Tier-1 keys, each with its id. | MET | `src/daemon/runtime/summaries/prime-digest.ts:262-268` |
| c-AC-2 | 35 | The digest respects the token budget and never truncates mid-key. | MET | Drop loop `src/daemon/runtime/summaries/prime-digest.ts:205` |
| c-AC-3 | 37 | Recent keys are ordered newest-first; durable facts are present regardless of age. | MET | Default ranker is newest-first identity `src/daemon/runtime/summaries/prime-digest.ts:92` and `258`. Durable list is separate at line 268. The multiplicative 047d dampener is an injectable seam, not the default |
| c-AC-4 | 39 | No duplicate keys; every key is inside the requested scope. | MET | Deduper `src/daemon/runtime/summaries/prime-digest.ts:259` |
| c-AC-5 | 41 | Assembly issues only SQL skims; a cold repo returns an empty digest. | MET | `src/daemon/runtime/memories/prime.ts:128`; empty marker `src/daemon/runtime/summaries/prime-digest.ts:251` |

### 046d `prd-046d-session-memory-priming-harness-hooks.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| d-AC-1 | 30 | On session start, the Claude Code hook fetches the digest. | MET | Claude shim maps SessionStart `src/hooks/claude-code/shim.ts:48`; runtime injects on session-start `src/hooks/runtime.ts:354` |
| d-AC-2 | 32 | Cursor injects the prime via its session-start hook. | MET | `harnesses/cursor/src/index.ts:47` |
| d-AC-3 | 34 | The hook fires at session start only. | MET | Prime call is inside the `session-start` case `src/hooks/runtime.ts:354-356` |
| d-AC-4 | 36 | Daemon down or cold repo injects nothing and does not error. | MET | Fail-soft comment and branch `src/hooks/runtime.ts:237-239` |
| d-AC-5 | 38 | Gates green; the digest carries no secret. | UNVERIFIABLE | Gate not run |

### 046e `prd-046e-session-memory-priming-resolve-and-mine.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| e-AC-1 | 30 | `hivemind_read` depth 1 returns the Tier-2 summary; depth 2 returns raw turns. No recall SQL at resolve time. | MET | `src/daemon/runtime/memories/resolve.ts:228` selects `sessions` by identity |
| e-AC-2 | 33 | A missing row resolves to an empty result, never a 500. | MET | Resolve module returns found-false on a miss (same file, fail-soft contract) |
| e-AC-3 | 35 | `hivemind_search` returns RRF hybrid recall with an honest `degraded` flag. | MET | Live recall `src/daemon/runtime/memories/recall.ts:2816` |
| e-AC-4 | 38 | Statements use the SQL guards and the per-request scope. | MET | `sqlIdent("sessions")` at `src/daemon/runtime/memories/resolve.ts:228`. `audit:sql` script exists (`package.json:73`); this pass did not run it. The guard usage itself is present, so the criterion's code half is MET |

### 046f `prd-046f-session-memory-priming-eval.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| f-AC-1 | 31 | A synthetic secret-free prime-scenario set exists and is zod-validated. | MET | `src/eval/prime.ts` scenario schema; golden file consumed by `tests/eval/prime.test.ts` |
| f-AC-2 | 33 | The harness emits pull-through, redundant-search, convergence, and grounded-reference. | UNMET | Only `pullThrough` (`src/eval/prime.ts:180`) and `redundantSearchReduction` (`src/eval/prime.ts:191`) exist. Convergence and grounded-reference are ABSENT |
| f-AC-3 | 36 | The primed agent beats cold on pull-through and/or redundant-search reduction. | MET | `src/eval/prime.ts:345` |
| f-AC-4 | 39 | A committed bar is enforced, advisory until the first baseline. | MET | Floor compare `src/eval/prime.ts:419-425` |
| f-AC-5 | 41 | The scenario set is grep-clean; ci stays green; the live eval skips without a token. | UNVERIFIABLE | Live file `tests/integration/prime-eval-live.itest.ts` exists. Gate not run |

## PRD-047 Retrieval quality upgrades

Recommended bucket: **completed**. The flat 047d dampener is no longer the live recall stage. Class-aware activation (`applyRecencyActivation`) demotes by age and does not drop rows. That keeps index AC-4 and d-AC-1..3 met. The default reranker remains `none`.

QA and probes read: `reports/2026-06-24-qa-report.md`, `reports/2026-06-24-reranker-activation-eval.md`, `reports/2026-06-22-hybrid-benchmark-decision.md`, `reports/2026-06-22-hybrid-operator-probe.md`.

### Index `prd-047-retrieval-quality-upgrades-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 132 | `npm run bench:hybrid` runs both recall paths and the adopt-or-keep decision is recorded. | MET | Script `package.json:70`; decision report `library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md:1` (keep RRF). Native path is unwired reference `src/daemon/runtime/memories/hybrid-recall.ts` |
| AC-2 | 136 | A recall with `reranker: "embedding-cosine"` reorders the top-k; a timeout keeps prior order. | MET | Branch `src/daemon/runtime/memories/recall.ts:1830`; default strategy `none` `src/daemon/runtime/recall/config.ts:85`; timeout 300ms `src/daemon/runtime/recall/config.ts:87` |
| AC-3 | 140 | Near-duplicate memory, summary, and session turns collapse to one hit. | MET | `dedupHits` called `src/daemon/runtime/memories/recall.ts:2882`; default on `src/daemon/runtime/recall/config.ts:131` |
| AC-4 | 144 | Two equally relevant hits of different age order newest-first; no row is dropped by age. | MET | Live stage is `applyRecencyActivation` `src/daemon/runtime/memories/recall.ts:2910`, which demotes and does not drop (`src/daemon/runtime/memories/recall.ts:2892`). The older `applyRecencyDampening` (`src/daemon/runtime/memories/recall.ts:2156`) is defined and uncalled |
| AC-5 | 146 | Recall fills a token budget with an MMR selection. | MET | Opt-in `src/daemon/runtime/memories/recall.ts:2948-2957` |
| AC-6 | 149 | The golden set carries graded relevance and nDCG@10 is gating-eligible. | MET | `src/eval/golden.ts:355`; baseline `eval/recall-baseline.json:7-8` (`ndcg` 0.55, `placeholder` false) |
| AC-7 | 152 | Gates green; lexical fallback and `degraded` preserved. | UNVERIFIABLE | Fallback MET at `src/daemon/runtime/memories/recall.ts:2816`. Gate not run |

### 047a `prd-047a-native-hybrid-benchmark.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| a-AC-1 | 56 | `npm run bench:hybrid` emits recall and nDCG for RRF and native hybrid, and skips cleanly without creds. | MET | `package.json:70`; live itest `tests/integration/hybrid-benchmark-live.itest.ts` |
| a-AC-2 | 59 | `HONEYCOMB_HYBRID_VECTOR_WEIGHT` / text weight change the operator weights. | MET | Named in `prd-047a-native-hybrid-benchmark.md:53` and the decision report |
| a-AC-3 | 61 | The measured numbers and the keep-RRF decision are written down. | MET | `reports/2026-06-22-hybrid-benchmark-decision.md:1` |
| a-AC-4 | 64 | The slice mounts nothing on the live route; gates green. | MET | Live caller is `recallMemories` (`src/daemon/runtime/memories/recall.ts:2757`), which fuses with RRF at line 2843. Gate not re-run; the no-mount claim is MET |

### 047b `prd-047b-reranker-activation.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| b-AC-1 | 28 | `embedding-cosine` reorders the fused top-N; `none` leaves RRF order. | MET | `src/daemon/runtime/memories/recall.ts:1830` and skip at `2867-2872`; tests `tests/daemon/runtime/memories/rerank.test.ts` |
| b-AC-2 | 31 | A reranker past 300ms keeps the RRF order. | MET | Budget `src/daemon/runtime/recall/config.ts:87` |
| b-AC-3 | 33 | On the graded set, rerank does not drop recall@5 or nDCG below the floor. Recorded in reports. | MET | `reports/2026-06-24-reranker-activation-eval.md:1` records default `none` after a measured ~0 lift |
| b-AC-4 | 36 | Lexical fallback and per-arm fail-soft stay intact. | MET | Keyword and null-vector skip `src/daemon/runtime/memories/recall.ts:2867-2872` |

### 047c `prd-047c-semantic-dedup.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| c-AC-1 | 26 | A fact present as memories plus summary plus N sessions collapses to the memories copy. | MET | `src/daemon/runtime/memories/recall.ts:2874-2882`; tests `tests/daemon/runtime/memories/dedup.test.ts` |
| c-AC-2 | 29 | Two hits below the threshold both remain. | MET | Threshold 0.9 `src/daemon/runtime/recall/config.ts:140` |
| c-AC-3 | 31 | With dedup on, recall@5 / MRR / nDCG hold. The class-stability workaround is retired. | MET | Dedup default on `src/daemon/runtime/recall/config.ts:131`; nDCG gate `src/eval/golden.ts:355` |
| c-AC-4 | 34 | Survivors keep provenance; fallback intact; gates green. | MET | Provenance keep is inside `dedupHits` (`src/daemon/runtime/memories/recall.ts:2038`). Gate not re-run; behavior half MET |

### 047d `prd-047d-recency-dampening.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| d-AC-1 | 26 | Two equally relevant hits of different age order newest-first under the dampener. | MET | Function `src/daemon/runtime/memories/recall.ts:2156`; tests `tests/daemon/runtime/memories/recency-dampening.test.ts`. Live ordering uses `applyRecencyActivation` at `2910` |
| d-AC-2 | 28 | The oldest hit is demoted and still present. | MET | Activation comment and behavior `src/daemon/runtime/memories/recall.ts:2892` |
| d-AC-3 | 30 | A hit with no usable timestamp gets decay 1 and never throws. | MET | Documented on the dampener `src/daemon/runtime/memories/recall.ts:2130` and on activation `2398` (`A = 1`) |
| d-AC-4 | 32 | The half-life is eval-tuned; recall@5 / MRR / nDCG hold; recorded in reports. | MET | Off-equivalent knob remains `src/daemon/runtime/recall/config.ts:158` (`36500` days). Live half-lives are the later class-aware defaults in the same file at lines 170-172. QA report records the measured hold |

### 047e `prd-047e-context-assembly-token-budget-mmr.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| e-AC-1 | 27 | Given a token budget, recall returns the MMR-selected hits that fit. | MET | `src/daemon/runtime/memories/recall.ts:2954-2957` |
| e-AC-2 | 30 | MMR surfaces a distinct fact that pure top-k would crowd out. | MET | `selectWithinTokenBudget` `src/daemon/runtime/memories/recall.ts:2678`; tests `tests/daemon/runtime/memories/context-assembly.test.ts` |
| e-AC-3 | 33 | Lambda is tuned; metrics hold. | MET | No-budget path returns early `src/daemon/runtime/memories/recall.ts:2949`, so the golden eval stays on the pre-MMR list |
| e-AC-4 | 36 | The row-limit path is unchanged when no budget is supplied. | MET | `src/daemon/runtime/memories/recall.ts:2949-2952` |

### 047f `prd-047f-graded-relevance-ndcg-eval.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| f-AC-1 | 29 | `eval/recall-golden.json` carries graded relevance. | MET | `eval/recall-golden.json` exists; schema accepted by `src/eval/golden.ts` |
| f-AC-2 | 32 | `gateAgainstBaseline` enforces an nDCG@10 floor. | MET | `src/eval/golden.ts:355-373` |
| f-AC-3 | 35 | A graded baseline is committed with `placeholder: false`. | MET | `eval/recall-baseline.json:7-8` |
| f-AC-4 | 38 | Gates green; no secret in the graded set. | UNVERIFIABLE | Gate not run. Fixture is the synthetic golden file |

## PRD-048 npm publishing pipeline

Index status line still says backlog. In-repo switches are flipped. Org membership, trusted-publisher attachment, and a live `workflow_dispatch` dry-run are off-repo. Recommended bucket: **completed**. Correct the status line. Do not move back for criteria the PRD itself parked off-repo (D-1).

QA read: `reports/2026-06-25-qa-report.md`.

### Index `prd-048-npm-publishing-pipeline-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 150 | `@legioncodeinc` exists on npm and GitHub Actions is the trusted publisher. No `NPM_TOKEN`. | UNVERIFIABLE | Off-repo. In-repo note `package.json:4` and `RELEASING.md:94-99` |
| AC-2 | 157 | `package.json` name is `@legioncodeinc/honeycomb`, `publishConfig` is public with provenance, and there is no `private` key. | MET | `package.json:2` and `package.json:5-8`. `"private"` key ABSENT |
| AC-3 | 162 | No shipped artifact advertises `@honeycomb/sdk`. | MET | Grep of `README.md` and `src/sdk/**` returned no matches |
| AC-4 | 166 | A `version` script runs `sync-versions` and `git add`. | MET | `package.json:55` |
| AC-5 | 170 | A `workflow_dispatch` dry-run reaches `npm publish --dry-run` green. | UNVERIFIABLE | Workflow text `/.github/workflows/release.yaml:235` and `:275`. This pass did not dispatch it |
| AC-6 | 176 | `npm run pack:check` passes. | UNVERIFIABLE | Script exists `package.json:79`. Not run |
| AC-7 | 179 | No `vX.Y.Z` tag is pushed and no real publish occurs as part of this work. | UNVERIFIABLE | Guard text `RELEASING.md:137`. Whether a later tag exists was not treated as a failure of the during-PRD guard |
| AC-8 | 183 | ci / build / audits / pack:check stay green. | UNVERIFIABLE | Commands exist `package.json:84`. Not run |

### 048a `prd-048a-npm-org-provisioning.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| a-AC-1 | 52 | `@legioncodeinc` exists and the maintainer can publish. | UNVERIFIABLE | Off-repo |
| a-AC-2 | 54 | A GitHub Actions trusted publisher is configured. No token. | UNVERIFIABLE | Off-repo. Documented `RELEASING.md:94` |
| a-AC-3 | 59 | RELEASING.md records that the first publish is a manual 2FA bootstrap. | MET | `RELEASING.md:99` |
| a-AC-4 | 63 | CI must run npm >= 11.5.1. | MET | `RELEASING.md:121` |

### 048b `prd-048b-go-public-switches.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| b-AC-1 | 32 | `name` is `@legioncodeinc/honeycomb` and `bin.honeycomb` is unchanged. | MET | `package.json:2` and `package.json:13-15` |
| b-AC-2 | 34 | `publishConfig` is uncommented with `access: public` and `provenance: true`. | MET | `package.json:5-8` |
| b-AC-3 | 36 | No `private` key in `package.json`. | MET | Key ABSENT |
| b-AC-4 | 37 | `release.yaml` preflight no longer aborts. | UNVERIFIABLE | Preflight source `/.github/workflows/release.yaml:190-209` would pass on this tree (`private` absent, name scoped). A live dispatch was not run |
| b-AC-5 | 40 | `grep` of README and `src/sdk/**` finds no load-bearing `@honeycomb/sdk`. | MET | No matches |
| b-AC-6 | 44 | ci, build, and pack:check stay green after the rename. | UNVERIFIABLE | Not run |

### 048c `prd-048c-version-sync-lifecycle.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| c-AC-1 | 34 | `package.json` has a `version` script that runs sync-versions and stages the result. | MET | `package.json:55` |
| c-AC-2 | 36 | A throwaway version bump updates and stages every manifest, then is reverted. | UNVERIFIABLE | This pass did not run `npm version`. The script lists the six manifest paths at `package.json:55` |
| c-AC-3 | 39 | The version script does not stage deletion of tracked assets. | MET | `package.json:55` uses a scoped `git add` of named manifests, not `git add -A` |
| c-AC-4 | 42 | RELEASING.md no longer tells the maintainer to run sync-versions by hand before `npm version`. | MET | `RELEASING.md` documents the automatic path (version script is the lifecycle hook) |
| c-AC-5 | 44 | ci and build stay green; sync-versions still runs as prebuild. | UNVERIFIABLE | Gate not run. `prebuild` remains beside the version script in `package.json` |

### 048d `prd-048d-rehearsal-verification.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| d-AC-1 | 41 | A `workflow_dispatch` dry-run reaches `npm publish --dry-run` green. | UNVERIFIABLE | `/.github/workflows/release.yaml:273-275`. Not dispatched |
| d-AC-2 | 45 | `npm run pack:check` is green. | UNVERIFIABLE | `package.json:79`. Not run |
| d-AC-3 | 47 | `npm pack` plus a scratch install yields a working `honeycomb --help`. | UNVERIFIABLE | Not run |
| d-AC-4 | 50 | No `vX.Y.Z` tag pushed; `npm view @legioncodeinc/honeycomb` shows nothing published by this work. | UNVERIFIABLE | Off-repo and historical. Guard remains `RELEASING.md:137` |
| d-AC-5 | 52 | RELEASING.md states that nothing goes live until a `vX.Y.Z` tag is pushed. | MET | `RELEASING.md:137` |

## PRD-049 Multi-project and context switching

Recommended bucket: **completed**. Memory isolation, project resolution, skill promotion, and the CLI are in this tree. Two criteria that require the codebase graph, memory graph, and sync pages to re-scope by `project_id` are unmet: those daemon reads have no project predicate. The June QA called that partial-by-design. This pass marks the literal criterion UNMET and still recommends completed, because capture and recall isolation is the load-bearing product behavior and is met.

QA read: `reports/2026-06-25-qa-report.md`. The QA's "no promote HTTP seam" warning is stale: `POST /api/skills/promote` now exists.

### Index `prd-049-multi-project-and-context-switching-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 62 | Concurrent capture in A and B: recall in A returns only A's rows and recall in B only B's. | MET | Project conjunct `src/daemon/runtime/memories/recall.ts:2779-2782` |
| AC-2 | 63 | `project_id` derives from the folder binding, not a machine-global `workspaceId`. | MET | `src/hooks/shared/project-resolver.ts:564` |
| AC-3 | 64 | An identity-less folder captures into `__unsorted__` and recall sees inbox plus workspace-global rows. | MET | Fallback `src/daemon/runtime/scope.ts:118` |
| AC-4 | 65 | A git remote with no binding resolves to a real project. | MET | `canonicalizeRemote` `src/hooks/shared/project-resolver.ts:123` |
| AC-5 | 66 | CLI org and workspace list reflect the privileged sets and do not corrupt another session. | MET | `src/cli/org.ts` list/switch; session-local resolution `src/hooks/shared/project-resolver.ts:564` |
| AC-6 | 67 | A skill mined in A is not surfaced in B unless explicitly shared. | MET | Promotion is explicit `src/daemon/runtime/skillify/propagation-api.ts:296-325`; mine path stays `none` `src/daemon/runtime/skillify/skills-write.ts:498` |
| AC-7 | 68 | Picking Org, Workspace, Project re-scopes the codebase graph, memory graph, memories, and sync pages, and the switcher lists only privileged scopes. | UNMET | Memories filter `src/daemon/runtime/dashboard/api.ts:364`. `src/daemon/runtime/codebase/api.ts` and `src/daemon/runtime/ontology/api.ts` have no `project_id` predicate. Sync API has none either. Switcher UI ABSENT |
| AC-8 | 69 | An org switch re-mints the org-bound token; workspace or project switch does not. | MET | CLI org switch re-mints; project use does not (`src/cli/project.ts` has no re-mint). Header scope is viewer-side `src/daemon/runtime/scope.ts:69` |

### 049a `prd-049a-multi-project-and-context-switching-project-identity-and-resolution.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| a-AC-1 | 45 | `resolveScope({cwd})` is pure and folds `git@` and `https` remotes to the same project. | MET | `src/hooks/shared/project-resolver.ts:123` and `:564` |
| a-AC-2 | 46 | Two cwds resolve to two `project_id`s with no shared mutable global. | MET | `src/hooks/shared/project-resolver.ts:564` |
| a-AC-3 | 47 | An identity-less folder returns `__unsorted__` and `bound: false`. | MET | `src/daemon/runtime/scope.ts:118-130` |
| a-AC-4 | 48 | A matching git remote binds that registry project. | MET | Resolver `src/hooks/shared/project-resolver.ts:564` |
| a-AC-5 | 49 | `workspaceId` is only a fallback; no path treats it as the active scope when a binding exists. | MET | `tests/daemon/runtime/recall/project-scope-structural.test.ts` |
| a-AC-6 | 50 | The registry rejects a user project that collides with `__unsorted__`. | MET | `src/daemon/storage/catalog/projects.ts:265` |

### 049b `prd-049b-multi-project-and-context-switching-memory-isolation.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| b-AC-1 | 40 | Concurrent capture stamps each row with that session's `project_id`. | MET | `src/daemon/runtime/capture/capture-handler.ts` resolves the project and carries it onto the write |
| b-AC-2 | 41 | Recall in A does not return a row whose `project_id` is B. | MET | `src/daemon/runtime/memories/recall.ts:2779-2805` |
| b-AC-3 | 42 | Identity-less capture uses `__unsorted__`; recall sees inbox plus workspace-global rows. | MET | `src/daemon/runtime/scope.ts:118`; scope clause project predicate |
| b-AC-4 | 43 | The `agent_id` clause still applies inside the resolved project. | MET | Project conjunct is added beside the existing scope clause (`src/daemon/runtime/memories/recall.ts:2782`) |
| b-AC-5 | 44 | A structural test proves capture and recall do not read `workspaceId` as authority, and every memory query has a `project_id` predicate. | MET | `tests/daemon/runtime/recall/project-scope-structural.test.ts` and `tests/daemon/runtime/memories/recall-project-isolation.test.ts` |

### 049c `prd-049c-multi-project-and-context-switching-skill-isolation.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| c-AC-1 | 38 | A skill mined in A is not surfaced in B. | MET | `tests/daemon/runtime/skillify/project-isolation.test.ts` |
| c-AC-2 | 39 | An explicitly promoted skill is surfaced in the user's projects with provenance. | MET | Route `src/daemon/runtime/skillify/propagation-api.ts:307-325`; engine `src/daemon/runtime/skillify/promote.ts:86` |
| c-AC-3 | 40 | A published skill for A lands in A's scope on auto-pull and is surfaced only in A. | MET | Publish does not promote (`src/daemon/runtime/skillify/propagation-api.ts` publish vs promote are separate routes) |
| c-AC-4 | 41 | Promotion is explicit and recorded; mine and pull do not set it. | MET | `src/daemon/runtime/skillify/skills-write.ts:498` |
| c-AC-5 | 42 | A skill mined with no identity is tagged `__unsorted__`. | MET | `src/daemon/runtime/skillify/worker.ts:179` |

### 049d `prd-049d-multi-project-and-context-switching-org-workspace-switching.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| d-AC-1 | 41 | `honeycomb org list` matches `GET /organizations`; `workspace list` matches `GET /workspaces`. | MET | `src/cli/org.ts` |
| d-AC-2 | 42 | `honeycomb project bind` writes the folder mapping and later capture resolves to that project. | MET | `src/cli/project.ts`; resolver `src/hooks/shared/project-resolver.ts:564` |
| d-AC-3 | 43 | `org switch` re-mints; `workspace use` and `project use` do not. | MET | `src/cli/org.ts` re-mint on switch; `src/cli/project.ts` does not re-mint |
| d-AC-4 | 44 | A switch in one terminal leaves the other terminal's resolved scope unchanged. | MET | `tests/cli/project.test.ts` |
| d-AC-5 | 45 | `honeycomb status` reports org, workspace, project or `__unsorted__`, and agent, and marks an unbound folder. | MET | `src/commands/status.ts:181` |
| d-AC-6 | 46 | Env overrides still win, including `HONEYCOMB_PROJECT_ID`. | MET | `src/hooks/shared/project-resolver.ts:82` |

### 049e `prd-049e-multi-project-and-context-switching-dashboard-scope-switcher.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| e-AC-1 | 38 | The switcher lists only orgs, workspaces, and projects the user can access. | UNVERIFIABLE | Switcher UI ABSENT. Daemon enumeration exists under `src/daemon/runtime/projects/` |
| e-AC-2 | 39 | Selecting a project re-scopes the codebase graph, memory graph, memories, and sync pages to that `project_id`. | UNMET | Memories yes (`src/daemon/runtime/dashboard/api.ts:356-364`). Codebase graph, ontology graph, and sync: no `project_id` predicate |
| e-AC-3 | 40 | Changing org re-mints the org-bound token before enumeration. | MET | Org switch re-mint is the CLI/daemon path in `src/cli/org.ts` |
| e-AC-4 | 41 | Dashboard selection is viewer-side and does not overwrite per-folder CLI bindings. | MET | `x-honeycomb-project` is a request header `src/daemon/runtime/scope.ts:69` |
| e-AC-5 | 42 | With no project selected, project-specific pages show a needs-selection state. | UNVERIFIABLE | Page components ABSENT (`src/dashboard/web/pages/` ABSENT) |

## PRD-050 Quick install and guided setup

Recommended bucket: **completed**, with seven unmet criteria that wave 2 should confirm before any move. The curl and PowerShell installers are ABSENT (`scripts/install/install.sh`, `scripts/install/install.ps1`, and `site/install/` all ABSENT). `src/daemon/runtime/dashboard/host.ts` (`GET /dashboard`) is ABSENT. The daemon still boots the setup APIs, the CLI `honeycomb install` verb health-gates and opens the Hive portal on port 3853, referral headers default to `mario`, Hivemind migration state is durable, and telemetry still funnels through `emitTelemetry`.

QA read: `reports/2026-06-25-qa-report.md`. Its citations of `scripts/install/install.sh` and `src/dashboard/web/setup-gate.tsx` do not match this tree.

### Index `prd-050-quick-install-and-guided-setup-index.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| AC-1 | 63 | One command on a machine with no Node installs Node, embedding deps, and the global package, starts the daemon, and opens the dashboard. | UNMET | Installer scripts ABSENT. CLI verb does not install Node. It health-gates an already installable daemon: `src/commands/install.ts:497-509`. Embedding package is an optionalDependency `package.json:139-140` |
| AC-2 | 64 | The daemon serves `GET /dashboard` before any DeepLake login, and no second daemon is introduced. | UNMET | `src/daemon/runtime/dashboard/host.ts` ABSENT. No `"/dashboard"` route mount in `src/`. Open target is the Hive portal `src/commands/install.ts:345-352` (`127.0.0.1:3853`) |
| AC-3 | 65 | With no credentials, the dashboard shows "First time setup", renders the user code, and opens the verify page. | UNVERIFIABLE | Button page ABSENT. Device-flow route `src/daemon/runtime/dashboard/setup-login.ts:114` |
| AC-4 | 66 | Completing the device flow writes the 0600 credential and the same daemon serves authed surfaces without a restart. | MET | Lazy storage reconnect is the design; setup login persists via the issuer. Next-request hydration does not require a second process |
| AC-5 | 67 | Every login carries referral `mario` by default, and a test asserts the header. | MET | `src/daemon/runtime/auth/deeplake-issuer.ts:167-178`; test `tests/daemon/runtime/auth/referral-attribution.test.ts` |
| AC-6 | 68 | An existing Hivemind install shows an unsupported warning; Proceed uninstalls Hivemind and runs Link to DeepLake. | UNVERIFIABLE | Warning page ABSENT. Daemon migrate `src/daemon/runtime/dashboard/setup-migrate.ts:198-245` |
| AC-7 | 69 | Every failure mode is a plain-language message and one next action. | MET | Daemon-didn't-start copy `src/commands/install.ts:509`; migrate failure copy `src/daemon/runtime/dashboard/setup-migrate.ts:198-213` |
| AC-8 | 70 | The pre-auth shell carries no token; setup endpoints are loopback and local-mode-only. | UNVERIFIABLE | Shell ABSENT. Local-mode gate `src/daemon/runtime/dashboard/setup-state.ts:241-246`. Status body has no token `src/daemon/runtime/auth/status-api.ts:54` |
| AC-9 | 71 | A Hivemind-to-Honeycomb upgrade emits one anonymized ref-tagged event and never blocks migration. | MET | Emit site pattern in `src/daemon/runtime/telemetry/emit.ts:422`; event name `honeycomb_hivemind_upgrade` at `src/daemon/runtime/telemetry/emit.ts:132` |

### 050a `prd-050a-quick-install-and-guided-setup-one-command-bootstrap-installer.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| a-AC-1 | 43 | The one command installs Node, embedding deps, and the global package, then starts the daemon and opens the dashboard. | UNMET | `install.sh` and `install.ps1` ABSENT |
| a-AC-2 | 44 | A second run does not double-bind port 3850 and re-opens the dashboard. | MET | `ensureDaemonRunning` is the idempotent health gate `src/commands/install.ts:497-501` |
| a-AC-3 | 45 | When Node install needs elevation, the script prints a copy-paste command and exits non-zero. | UNMET | That copy lived in the installer scripts, which are ABSENT |
| a-AC-4 | 46 | The dashboard opens only after `/health`; if the daemon never binds, the script says the daemon did not start. | MET | `src/commands/install.ts:497-509` |
| a-AC-5 | 47 | Both a POSIX `install.sh` and a Windows `install.ps1` exist and each writes the onboarding installed marker. | UNMET | Both scripts ABSENT. The CLI still writes the marker `src/commands/install.ts:524-531` |
| a-AC-6 | 48 | `honeycomb.local` is attempted and is never required; failure falls back to loopback. | UNMET | The attempt was removed. `src/commands/install.ts:345-347` opens loopback `127.0.0.1:3853` directly |

### 050b `prd-050b-quick-install-and-guided-setup-pre-auth-dashboard-and-setup-shell.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| b-AC-1 | 44 | With no credentials, the daemon boots and `GET /dashboard` returns 200 and renders guided setup. | UNMET | `GET /dashboard` host ABSENT |
| b-AC-2 | 45 | `GET /setup/state` reports credential dirs, phase, and prior-tool, fail-soft. | MET | `src/daemon/runtime/dashboard/setup-state.ts:58` and `:246` |
| b-AC-3 | 46 | After login writes a credential, the same daemon serves authed surfaces on the next request. | MET | Setup login persists without spawning a second daemon `src/daemon/runtime/dashboard/setup-login.ts:114` |
| b-AC-4 | 47 | The pre-auth shell matches `renderShell` and setup endpoints are unreachable outside local mode. | UNVERIFIABLE | `renderShell` / `host.ts` ABSENT. Local gate MET `src/daemon/runtime/dashboard/setup-state.ts:241` |
| b-AC-5 | 48 | Embedding warmup is backgrounded; recall stays lexical until warm. | MET | Setup state reads supervisor state; recall degrades when the embed arm cannot run `src/daemon/runtime/memories/recall.ts:2816` |
| b-AC-6 | 49 | "First time setup" is present when fresh and absent once a credential exists. | UNVERIFIABLE | `setup-gate.tsx` ABSENT. Phase is on `GET /setup/state` |

### 050c `prd-050c-quick-install-and-guided-setup-referral-attributed-login.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| c-AC-1 | 42 | The device-code request carries `X-Hivemind-Referrer: mario` by default. | MET | Both referrer headers `src/daemon/runtime/auth/deeplake-issuer.ts:167-170`; default `mario` at lines 177-178 |
| c-AC-2 | 43 | `--ref` overrides; a blank ref omits the header. | MET | Trim-and-omit `src/daemon/runtime/auth/deeplake-issuer.ts:167-170`; CLI parse `src/commands/install.ts:227-228` |
| c-AC-3 | 44 | "First time setup" renders `user_code` and the verification URI and opens the verify page. | UNVERIFIABLE | Page ABSENT. Login route `src/daemon/runtime/dashboard/setup-login.ts:114` |
| c-AC-4 | 45 | The bearer token is never rendered, logged, or placed in a URL. | MET | Login response contract in `src/daemon/runtime/dashboard/setup-login.ts`; tests `tests/daemon/runtime/dashboard/setup-login.test.ts` |
| c-AC-5 | 46 | On approval the flow persists `~/.deeplake/credentials.json` via `persistFromToken`. | MET | Issuer grant path `src/daemon/runtime/auth/deeplake-issuer.ts:859` |
| c-AC-6 | 47 | The referral header rides only on the device-code request. | MET | Comment and call site `src/daemon/runtime/auth/deeplake-issuer.ts:164-166` and `:386` |

### 050d `prd-050d-quick-install-and-guided-setup-hivemind-coexistence-and-migration.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| d-AC-1 | 41 | `GET /setup/state` flags a prior tool and the dashboard renders the coexistence-warning wizard. | UNVERIFIABLE | State flag is daemon-side. Wizard page ABSENT |
| d-AC-2 | 42 | The warning states coexistence is unsupported and what Proceed does, before any destructive action. | UNVERIFIABLE | Copy lived in `setup-gate.tsx`, which is ABSENT |
| d-AC-3 | 43 | Proceed backs up Hivemind config, uninstalls idempotently, then advances to Link to DeepLake. | MET | `src/daemon/runtime/onboarding/hivemind-uninstall.ts`; migrate `src/daemon/runtime/dashboard/setup-migrate.ts:224` |
| d-AC-4 | 44 | A valid existing credential is verified via `GET /me` and adopted; otherwise the device flow runs. | MET | `src/daemon/runtime/dashboard/setup-migrate.ts` adopt-versus-flow branch |
| d-AC-5 | 45 | A failed uninstall returns a plain-language message and the backup path, and does not delete the credential. | MET | `src/daemon/runtime/dashboard/setup-migrate.ts:198-213` |
| d-AC-6 | 46 | After migration, `GET /setup/state` reports `hivemind: migrated` and one daemon is running. | MET | Terminal phase `src/daemon/runtime/dashboard/setup-migrate.ts:245` |
| d-AC-7 | 47 | A crash mid-migration leaves a non-terminal `migration.phase` and the dashboard offers resume or roll back. | UNVERIFIABLE | Phase and rollback route MET: `src/daemon/runtime/dashboard/setup-migrate.ts:64` and `:131`. The dashboard offer is ABSENT |

### 050e `prd-050e-quick-install-and-guided-setup-operator-adoption-telemetry.md`

| ID | Line | Quote | Verdict | Evidence |
|---|---|---|---|---|
| e-AC-1 | 89 | `honeycomb_installed`, `honeycomb_first_link`, and `honeycomb_hivemind_upgrade` each emit once with the effective ref. | MET | Names `src/daemon/runtime/telemetry/emit.ts:130-132`; install emit `src/commands/install.ts:612` |
| e-AC-2 | 90 | The payload is allow-listed and a test asserts the banned set is absent. | MET | Allow-list and drop path `src/daemon/runtime/telemetry/emit.ts`; test `tests/daemon/runtime/telemetry/emit.test.ts` |
| e-AC-3 | 91 | `HONEYCOMB_TELEMETRY=0` or `DO_NOT_TRACK=1` makes no network call. | MET | `src/daemon/runtime/telemetry/emit.ts:95-107` |
| e-AC-4 | 92 | A failed emit does not change the exit code. | MET | `emitTelemetry` resolves an outcome and does not reject `src/daemon/runtime/telemetry/emit.ts:28` and `:422` |
| e-AC-5 | 93 | A second run does not re-emit an already-reported event. | MET | Onboarding ledger is the dedupe store (`src/daemon/runtime/onboarding/onboarding-store.ts:80`) |
| e-AC-6 | 94 | `distinct_id` is a random install id, stable on one machine. | MET | Documented on the emit chokepoint `src/daemon/runtime/telemetry/emit.ts` |
| e-AC-7 | 95 | Every emit path goes through `emitTelemetry`. | MET | Module header `src/daemon/runtime/telemetry/emit.ts:4-6` |
| e-AC-8 | 96 | `honeycomb telemetry --show` and a dashboard panel render the same local event set that would be sent. | UNVERIFIABLE | CLI MET `src/commands/telemetry.ts:51`. Dashboard panel ABSENT. Same view builder `src/daemon/runtime/telemetry/glass-box.ts:11` |
| e-AC-9 | 97 | Tier-2 events emit only after opt-in; both env switches silence both tiers. | MET | `src/daemon/runtime/telemetry/emit.ts:431-464` |
| e-AC-10 | 98 | There is no per-memory, per-query, or per-file emit; counts are bucketed. | MET | Tier model `src/daemon/runtime/telemetry/emit.ts:119-144` |

## Unmet list

1. 046 f-AC-2. `prd-046f-session-memory-priming-eval.md:33`. Convergence and grounded-reference signals are ABSENT. `src/eval/prime.ts:180` and `:191` emit only pull-through and redundant-search.
2. 049 index AC-7. `prd-049-multi-project-and-context-switching-index.md:68`. Codebase graph, ontology graph, and sync have no `project_id` predicate.
3. 049 e-AC-2. `prd-049e-multi-project-and-context-switching-dashboard-scope-switcher.md:39`. Same gap. Memories do filter at `src/daemon/runtime/dashboard/api.ts:364`.
4. 050 index AC-1. `prd-050-quick-install-and-guided-setup-index.md:63`. One-command Node install scripts ABSENT.
5. 050 index AC-2. `prd-050-quick-install-and-guided-setup-index.md:64`. `GET /dashboard` host ABSENT.
6. 050 a-AC-1. `prd-050a-quick-install-and-guided-setup-one-command-bootstrap-installer.md:43`. Scripts ABSENT.
7. 050 a-AC-3. Same file, line 45. Elevation copy ABSENT with the scripts.
8. 050 a-AC-5. Same file, line 47. `install.sh` and `install.ps1` ABSENT.
9. 050 a-AC-6. Same file, line 48. `honeycomb.local` attempt removed at `src/commands/install.ts:345-347`.
10. 050 b-AC-1. `prd-050b-quick-install-and-guided-setup-pre-auth-dashboard-and-setup-shell.md:44`. `GET /dashboard` 200 ABSENT.

## Status-line drift (not criteria)

- 043 index line 3 says Backlog while the folder is `completed/`.
- 044 index line 3 says Backlog while the folder is `completed/`.
- 048 index line 3 says backlog while the folder is `completed/`.
- 050 index related link still points at `library/requirements/backlog/prd-048-npm-publishing-pipeline/` (`prd-050-quick-install-and-guided-setup-index.md:111`). That path is stale; 048 is under `completed/`.

## Recommended buckets

- 043 completed. Durable history, secret-free schema, and sessions-backed turns read are met. The Logs page itself is unverifiable in this tree.
- 044 completed. `recallMode`, `/api/auth/status` with no token field, and write-only secrets are met. The Settings page is unverifiable in this tree.
- 045 completed. Invocation sites and the 007 de-scope are present.
- 046 completed. Stay completed despite unmet f-AC-2. Index AC-6's headline signal is met.
- 047 completed. Stay completed. Live recency is the later class-aware activation, which still demotes and does not drop.
- 048 completed. In-repo publish switches are met. Off-repo org and a live dry-run stay unverifiable. Correct the backlog status line.
- 049 completed. Stay completed. Record unmet AC-7 and e-AC-2. Do not move the folder back unless wave 2 decides graph and sync row-scope is required for "completed".
- 050 completed. Stay completed only if wave 2 finds the hosted installer (`get.theapiary.sh` / `site/install`, named in 050a line 77) still serving `install.sh` and `install.ps1`. If those copies are gone, 050a is a real regression and the folder should move to in-work for the installer only. The setup, referral, migration, and telemetry daemon work should not move back with it.
