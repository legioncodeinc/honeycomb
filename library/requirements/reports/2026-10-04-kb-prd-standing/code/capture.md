# Wave 2 code standing: capture

Shard date: 2026-10-04. Read-only against source. No knowledge docs, PRDs, or product source were edited.

Inputs: `knowledge/ai-capture-pipeline.md`, `knowledge/ai-lifecycle-graph.md`, and the PRD slices for 005, 006, 008, 009, 016, 058, 079, and 080.

Walked: `src/daemon/runtime/capture/`, `pipeline/`, `summaries/`, `pollinating/`, skillify callers (`src/daemon/runtime/skillify/` plus `capture/attach.ts` and `capture/capture-handler.ts`), and `src/daemon/storage/catalog/memories.ts`. Cited lines outside that walk were opened only to check a wave 1 claim. `node_modules` and build outputs were skipped.

A doc edit is CONFIRM when the cited behavior is still wrong in the current tree. A move back to in-work is CONFIRM only when a still-required criterion is absent. A criterion a later decision replaced stays completed and is not a move ground.

## Counts

| Verdict | Count | What |
|---|---|---|
| CONFIRM | 78 | 70 knowledge edits (42 capture-pipeline + 28 lifecycle-graph) and 8 PRD bucket calls |
| OVERTURN | 4 | Four wave 1 UNMET marks that are superseded and must not reopen a completed PRD |
| UNVERIFIABLE | 0 | |

Page action for every file in both knowledge shards stays REVISE. None is REMOVE. No new page.

## PRD bucket calls

| PRD | Wave 1 call | Verdict | Move ground |
|---|---|---|---|
| 005 | stay completed | CONFIRM | Capture insert, non-blocking embed, 768 reject, and the four capture-gate skips are on the live path. |
| 006 | move to in-work | CONFIRM | 006d AC-5 only. Fact-cap and confidence UNMETs are overturned below. |
| 008 | move to in-work | CONFIRM | 008a AC-3 only. Traversal UNMETs are overturned below. |
| 009 | move to in-work | CONFIRM | Compact trigger, captured transcript, identity load, and the graph-query tool are absent on the dispatched path. |
| 016 | move to in-work | CONFIRM | Live stop path ignores the env cadence and session-end does not run skillify. |
| 058 | stay in-work | CONFIRM | Dashboard health, confirmed-useful reinforcement, confidence-exponent ranking, and operator reversal are absent. |
| 079 | stay completed | CONFIRM | Outbox, drain, dead-letter, and shed are in `capture-outbox.ts` and wired from the capture handler. |
| 080 | stay completed | CONFIRM | `memory_outbox`, deferred ack, redrive, and `onCommitted` are wired. |

### PRD-005 stay completed: CONFIRM

- One JSONB `sessions` row, `message_embedding` omitted from the INSERT: `src/daemon/runtime/capture/capture-handler.ts:676` and `:682`.
- Embed is kicked and not awaited: `capture-handler.ts:879` through `:892`. A null vector leaves the column null: `:884`.
- Non-768 reject lives on the embed client the kick calls: `src/daemon/runtime/services/embed-client.ts:271`.
- Gate skips on `HONEYCOMB_CAPTURE=false`, a disabled plugin, a non-capture entrypoint, and the worker marker: `src/shared/capture-gate.ts:123` through `:141`.

### PRD-006 move to in-work: CONFIRM

Still-required absence, 006d AC-5 ("the row carries org, workspace, and agent scope"):

- `QueryScope` is org plus optional workspace. It has no agent field: `src/daemon/storage/client.ts:42`.
- The pipeline job does carry `agentId`: `src/daemon/runtime/pipeline/stage-worker.ts:72`. Fan-out writes that id: `src/daemon/runtime/pipeline/fan-out.ts:66`.
- Graph persist ignores the job agent and stamps `agent_id` from `scope.workspace`: `src/daemon/runtime/pipeline/graph-persist.ts:453`. The handler at `:548` does not pass `job.scope.agentId`. Entity ids are hashed from that workspace string: `graph-persist.ts:128`.

Two agents in one workspace therefore share graph rows. No later PRD replaces this criterion. That absence is enough to move the folder to in-work.

### Overturned PRD-006 UNMETs (superseded, stay completed for these criteria)

- OVERTURN 006a AC-3 as a move ground. The cap is 4, not about 20, because ISS-025 replaced 20 with 4 on purpose: `src/daemon/runtime/pipeline/config.ts:53` and `:59`. Entities stay at 50: `config.ts:61`. The bound exists. Do not reopen the PRD to restore 20.
- OVERTURN 006c AC-1 as a move ground. The confidence gate exists and the default is 0.8 because ISS-025 replaced 0.7: `config.ts:78` and `:82`. Do not reopen the PRD to restore 0.7.

The knowledge pages should still be revised to the live numbers (MEM-2, MEM-3). That is a doc edit, not a PRD move.

### PRD-008 move to in-work: CONFIRM

Still-required absence, 008a AC-3 (attribute provenance back to the proposal):

- `writeAttribute` stores `memory_id` and then discards `proposalId` and `source`: `src/daemon/runtime/ontology/entity-model.ts:307` and `:322` through `:325`.
- `supersede.ts:276` discards `proposalId` the same way.
- The control plane threads a proposal id into that provenance and then documents that `entity_attributes` has no `proposal_id` column, deferred to a future heal: `src/daemon/runtime/ontology/control-plane.ts:262` through `:274` and `:328` through `:331`.
- Catalog grep of `src/daemon/storage/catalog/knowledge-graph.ts` finds no `proposal_id` column.

The proposal row exists. The attribute row does not carry the proposal. The PRD criterion still requires that link, and no later PRD drops it.

### Overturned PRD-008 UNMETs (superseded, stay completed for these criteria)

- OVERTURN 008b AC-4 and the traversal half of index AC-3 as move grounds. `edgeClearsThreshold` is real and uncalled outside its own file: `src/daemon/runtime/ontology/dependencies.ts:293`. Its comment names PRD-007b traversal as the caller. PRD-045b de-scoped that engine and removed `src/daemon/runtime/recall/traversal.ts` (`library/requirements/completed/prd-045-daemon-wiring-closeout/prd-045b-daemon-wiring-closeout-retrieval-engine.md:75`). Traversal knobs remain config-only: `src/daemon/runtime/recall/config.ts:57`. A follow rule with no product walker is a superseded caller, not unfinished 008 work.
- The "required reason" half of index AC-3 is present: `assertDependencyReason` rejects an empty `related_to` reason before the write (`dependencies.ts:360`).

### PRD-009 move to in-work: CONFIRM

All of these are still required by the 009 text and absent on the live path:

- `honeycomb pollinate trigger --compact` posts `{mode:compaction}`: `src/commands/pollinate.ts:147`. Dispatch uses that verb: `src/commands/dispatch.ts:359`. The live route ignores the body and calls `checkAndEnqueuePollinating` with no mode: `src/daemon/runtime/pollinating/api.ts:291`. Threshold still applies: `trigger.ts:393`. `src/cli/pollinate.ts:157` would enqueue compaction, and nothing in `src/` imports it onto the verb.
- Counter subtracts the threshold instead of resetting to zero. FR-5 and AC-2 say zero (`prd-009a-pollinating-loop-trigger.md:38` and `:48`). Code: `trigger.ts:407`. The comment calls the subtract FR-5. The PRD text does not. This criterion was not replaced by a later PRD.
- Identity files, prior sessions, and `MEMORY.md` are empty on the production source: `incremental.ts:124`. The worker builds the incremental strategy with only `maxInputTokens`: `pollinating/worker.ts:290`. No transcript write on this path.
- `createGraphQueryTool` is defined at `incremental.ts:374` and has no caller. `loadPayload` only pastes the tool names into the prompt: `incremental.ts:481`. `ModelClient.complete` is one text completion: `src/daemon/runtime/pipeline/model-client.ts:71`.
- `entity.merge` is outside `DIRECT_APPLY`: `src/daemon/runtime/ontology/control-plane.ts:101`. A merge is queued, not applied, so prior rows are not advanced on that path.

### PRD-016 move to in-work: CONFIRM

- Live counters are `new TurnCounters(deps.counterConfig)` and assembly does not pass `counterConfig`: `capture-handler.ts:270`, `assemble.ts:1373`. Default is 10: `turn-counters.ts:61`. The count uses modulo and does not reset: `turn-counters.ts:149`.
- `skillifyEveryNTurns` reads `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`: `src/daemon/runtime/skillify/miner.ts:715`. `skillifyEveryTurns:` appears only in a comment at `miner.ts:741`. `evaluateTrigger` at `miner.ts:745` has no production caller (export is `skillify/index.ts:78`).
- Session-end enqueues a `summary` job with `triggerKind: "final"` and does not enqueue skillify: `src/daemon/runtime/capture/attach.ts:274` through `:284`.

Mining, append-only skill rows, the watermark file, install targets, and `/api/skills/pull` are present. They do not satisfy the trigger criterion.

### PRD-058 stay in-work: CONFIRM

Not backlog and not archive: recency, conflict projection, and the reverify tick run. Not completed. Re-checked absences:

- Recall records usefulness 0 and kind `recall`: `assemble.ts:1078`. `last_reinforced_at` advances only for `reinforce`: `src/daemon/runtime/memories/access-log.ts:178`. `gradeUsefulness` has no production caller: defined at `usefulness-grader.ts:201`, only called from `gradeRecallBatch` in the same file (`:246`).
- Calibration stamps `C` and does not reorder: `src/daemon/runtime/memories/recall.ts:2574`. `confidenceExponent` is passed at `assemble.ts:1617` and declared informational at `memories/api.ts:316`. It is not a score factor.
- `reverseSupersession` is exported (`memories/index.ts:140`) and has no route or CLI caller under `src/`.
- `assembleHealth` is defined at `lifecycle-health.ts:62` and is not called from `src/dashboard/`. Settings renders the static flag table: `src/dashboard/views.ts:95` and `:121`. No `lifecycle-panel.tsx`.
- ACT-R replaces Stage 1 only for hits the access log returns. `memory` and `sessions` stay on Stage 1: `assemble.ts:1089`, `recall.ts:2908`.

### PRD-079 stay completed: CONFIRM

- Attempts 10, age 24h, rows 10_000, drain 200: `src/daemon/runtime/capture/capture-outbox.ts:108`, `:121`, `:124`, `:126`.
- Capture handler enqueues on append failure and kicks a drain after success: `capture-handler.ts:387` and `:527`.
- Drain route: `capture-drain-api.ts:81`.
- The natural Deep Lake degraded window was not observed in this tree. That clause stays unverified as a live run and is not a reason to move the folder.

### PRD-080 stay completed: CONFIRM

- Sibling caps match: `src/daemon/runtime/pipeline/memory-outbox.ts:114`, `:127`, `:130`, `:132`.
- A transient commit defers: `controlled-writes.ts:513`.
- `onCommitted` is wired to `memoryFormation.record`: `assemble.ts:3271`, called from `memory-outbox.ts:633`.
- Same live-window note as 079. Do not move the folder for it.

## Knowledge edits: ai-capture-pipeline.md

42 defects. All CONFIRM. Page REVISE stands. Do not delete any of the six pages.

### session-capture.md

- CAP-1 CONFIRM. Mermaid puts the optional embed on the insert path (`session-capture.md:45`). `buildRow` omits `message_embedding` (`capture-handler.ts:682`). `kickEmbed` runs after the row is built and is not awaited (`capture-handler.ts:879`).
- CAP-2 CONFIRM. The doc says a message or time threshold (`session-capture.md:99`). `recordMessage` is a modulo on message count only (`turn-counters.ts:130`). `PERIODIC_TRIGGER_REASONS` includes `"hours"` (`summaries/contracts.ts:76`) and no capture path sets that reason. No `HONEYCOMB_SUMMARY_EVERY_HOURS` under `src/`.

### skillify-pipeline.md

- SKL-1 CONFIRM. The hook posts a skillify intent. The live session-end handler ignores intents and enqueues summary only (`attach.ts:274`). `evaluateTrigger` (`miner.ts:745`) has no production caller. The live cue is `tryStopCounterTrigger` (`capture-handler.ts:828`).
- SKL-2 CONFIRM. The config table says default 20 (`skillify-pipeline.md:135`). The constant is 10 (`turn-counters.ts:61`). The prose at `skillify-pipeline.md:29` already says 10.
- SKL-3 CONFIRM. `skillifyEveryNTurns` reads the env (`miner.ts:715`). Assembly does not pass `counterConfig` (`assemble.ts:1373`), so the handler keeps the constant (`capture-handler.ts:270`).
- SKL-4 CONFIRM. `extractPairs` is exported from `miner.ts:404`. There is no `src/skillify/extractors/`.
- SKL-5 CONFIRM. `buildGatePrompt` renders exchanges only (`miner.ts:425`). No 30000-character skills cap under `src/daemon/runtime/skillify/`.
- SKL-6 CONFIRM. No `verdict.json` under `src/`. `parseVerdictStdout` reads the first stdout token (`miner.ts:597`). The prompt is fed on stdin (`miner.ts:585`).
- SKL-7 CONFIRM. Default gate spec is `{ command: "claude", args: ["--print"] }` (`skillify/worker.ts:231`). No per-agent matrix in the skillify worker.
- SKL-8 CONFIRM. `author IN (...)` is added only when `teamAuthors` is non-empty (`miner.ts:176`). The live worker calls `mine` without a team list (`skillify/worker.ts:340`).
- SKL-9 CONFIRM. The store keeps the earlier date (`watermark.ts:105`). The fetch predicate is `creation_date > watermark` (`miner.ts:167`), so rows older than that date are excluded.
- SKL-10 CONFIRM. Grep of `src/` finds none of `HONEYCOMB_SKILLS_TABLE`, `HONEYCOMB_SKILLIFY_WORKER`, `HONEYCOMB_CURSOR_MODEL`, `HONEYCOMB_HERMES_PROVIDER`, `HONEYCOMB_HERMES_MODEL`, or `skillify.log`. The table name is the constant `SKILLS_TABLE` at `skills-write.ts:76`.
- SKL-11 CONFIRM. `createFsInstallTarget` still has a project mode (`install-target.ts:32` and `:44`). The live worker always passes `"global"` (`skillify/worker.ts:367`).

### memory-pipeline.md

- MEM-1 CONFIRM. Capture enqueues `memory_extraction` directly (`capture-handler.ts:852`). `inlineLinkMemory` runs inside graph persist after the triples (`graph-persist.ts:479`), and that call is skipped when there are no triples (`graph-persist.ts:448`).
- MEM-2 CONFIRM. Doc says about 20 facts (`memory-pipeline.md:44`). Code default is 4 (`config.ts:59`). Entity cap 50 holds (`config.ts:61`). Input cap 12000 holds (`config.ts:49`).
- MEM-3 CONFIRM. Doc says default 0.7 (`memory-pipeline.md:52`). Code default is 0.8 (`config.ts:82`).
- MEM-4 CONFIRM. No `hints` table under `src/daemon/storage/catalog/`. `PipelineConfigSchema` has no hints field (`config.ts:184`). `emptyHintSource` is the stand-in (`src/daemon/runtime/recall/collection.ts:86`).
- MEM-5 CONFIRM. Schema default of `extractionWritesEnabled` is false (`config.ts:149`). With neither env nor vault set, the resolved gate follows the memory master switch (`config.ts:492`), and that switch defaults off (`config.ts:186`). The doc says default on (`memory-pipeline.md:101`).
- MEM-6 CONFIRM. No `embeddings` catalog table. `memories` carries `content_embedding` (`src/daemon/storage/catalog/memories.ts:78` area; the column is on that table). `vector.ts` stores `FLOAT4[]` on the same tables. `embeddings_tombstones` in `retention.ts:158` nulls a column. It is not a table.

### distillation-and-tier1-keys.md

- DIS-1 CONFIRM. The gate already emits extraction, then summary, then key (`summaries/key.ts:11`). The worker writes `key` on the memory row (`summaries/worker.ts:236`).
- DIS-2 CONFIRM. The barrel header calls 017b an honest stub (`summaries/index.ts:9`). It does not say `notImplemented`. `notImplemented` is still exported (`index.ts:23`, defined at `contracts.ts:350`). `synthesizeMemoryIndex` is implemented (`synthesis.ts:478`) and exported (`index.ts:152`).
- DIS-3 CONFIRM. The summary job worker is built in assembly (`assemble.ts:2589`) and writes keys (`summaries/worker.ts:236`). The "once the worker is wired" sentence is behind the code.

### wiki-summary-workers.md

- WIK-1 CONFIRM. Generated overviews point at `~/.apiary/honeycomb/memory/` (`src/daemon-client/vfs/index-gen.ts:32`). The sentence still says `~/.honeycomb/memory/`.
- WIK-2 CONFIRM. `summary_embedding` is written (`worker.ts:232`). Semantic arms are `memories.content_embedding`, `sessions.message_embedding`, and `hive_graph_versions.embedding` (`recall.ts:1375`). `embeddingColumnFor` returns null for `memory` (`recall.ts:1700`).
- WIK-3 CONFIRM. No `src/hooks/capture.ts`. No `maybeTriggerPeriodicSummary` under `src/`. Live bump is `TurnCounters.recordMessage` (`turn-counters.ts:130`) from `capture-handler.ts:825`.
- WIK-4 CONFIRM. Summary state is the lock root (`worker.ts:331` area, `<sessionId>.lock`). Counters are the in-memory map (`turn-counters.ts:91`) and the module says they reset on restart (`turn-counters.ts:12`). No sidecar JSON of `{ lastSummaryAt, lastSummaryCount, totalCount }`.
- WIK-5 CONFIRM. No `HONEYCOMB_SUMMARY_EVERY_N_MSGS` or `HONEYCOMB_SUMMARY_EVERY_HOURS` under `src/`. Live default is 20 (`turn-counters.ts:59`). No hours check runs.
- WIK-6 CONFIRM. Event fetch is `path = sLiteral(session.path)` and `ORDER BY creation_date ASC` (`worker.ts:170`). No `LIKE`.
- WIK-7 CONFIRM. No `JSONL offset` under `src/`. An existing real summary row skips the write (`worker.ts:297` area).
- WIK-8 CONFIRM. No `buildClaudeInvocation` or `summary.md` under `src/daemon/runtime/summaries/`. Spawner is `child_process.spawn` with the prompt on stdin (`worker.ts:474`). Agent args are `-p` or `exec -` only (`summaries/job.ts:153`).
- WIK-9 CONFIRM. `EmbedClient.embed` takes one string (`embed-client.ts:82`). The worker calls `embed(markdown)` (`worker.ts:735` area).
- WIK-10 CONFIRM. `writeSummary` inserts only when no real row exists and the comment says never an in-place UPDATE (`worker.ts:280` and `:297`).
- WIK-11 CONFIRM. No `finalizeSummary` under `src/`.
- WIK-12 CONFIRM. Transient statuses are 429, 500, 502, 503, 504 (`src/daemon/storage/client.ts:179`). 401 and 403 are non-transient (`client.ts:368`). Backoff ceiling is 1000 ms (`client.ts:188`). Attempts are 4 (`client.ts:182`).
- WIK-13 CONFIRM. `summaryCliSpecFor` args are `-p` or `exec -` (`summaries/job.ts:153`). The model and provider env names in the doc table are absent from `src/`.
- WIK-14 CONFIRM. No `wiki.log` under `src/`. The job worker emits `summary.worker.completed` (`summaries/job.ts:406`).

### session-priming-architecture.md

- PRM-1 CONFIRM. Claude Code registers a `UserPromptSubmit` hook with `--honeycomb-recall` (`harnesses/claude-code/hooks/hooks.json:20`). `runUserPromptRecall` injects `additionalContext` (`src/hooks/shared/user-prompt-recall.ts:15`). The prime itself is still once per session start.
- PRM-2 CONFIRM. `prime-digest.ts:21` says the PRD-047d dampener is not built. `prime-digest.ts:36` says semantic dedup composes in later. `renderPrime` calls `assemblePrimeDigest` with no semantic deduper (`src/daemon/runtime/memories/prime.ts:129`).
- PRM-3 CONFIRM. The skim selects `key` ordered by date (`prime-keys.ts:79`). It is not a lexical match. `prime.ts:17` states there is no embed client and no vector call at read time.
- PRM-4 CONFIRM. `hivemind_read` and `hivemind_search` exist (`mcp/src/tools.ts:108` and `:116`). `hivemind_index` is absent. The browse tool is `honeycomb_index` (`mcp/src/tools.ts:99`).
- PRM-5 CONFIRM. No `src/cli/install-cursor.ts`. Cursor hooks are installed by `src/connectors/cursor.ts`.
- PRM-6 CONFIRM. Codex has a connector (`src/connectors/codex.ts`). Hermes maps `on_session_start` (`src/hooks/hermes/shim.ts:34`) and OpenClaw maps `before_agent_start` (`src/hooks/openclaw/shim.ts:47`). Neither has a file under `src/connectors/`. pi maps only `agent_end` and `session_shutdown` (`src/hooks/pi/shim.ts:28`) and the header says recall is on demand via `AGENTS.md` (`shim.ts:7`).

## Knowledge edits: ai-lifecycle-graph.md

28 defects. All CONFIRM. Page REVISE stands for all eight files. Do not delete any of them. No new page.

- D-01 CONFIRM. Scoring status still says PRD-055 (`memory-lifecycle-scoring.md:3`). PRD-055 in this tree is fleet enrollment. Lifecycle code is PRD-058: `src/daemon/runtime/memories/lifecycle-config.ts:2` and `library/requirements/in-work/prd-058-memory-lifecycle/`.
- D-02 CONFIRM. Config prose calls `a = 1` the identity (`memory-lifecycle-config.md:27`). Code says `1.0` is raw activation and `0` is neutral (`lifecycle-config.ts:64`). Recall multiplies by `A^activationExponent` (`recall.ts:2887`). Half-lives are 180 / 45 / 10 (`src/daemon/runtime/recall/config.ts:180`), so `a = 1` reorders by age.
- D-03 CONFIRM. As-built says the install default demotes nothing and, two lines later, that recency bites (`memory-lifecycle-as-built.md:52` and `:54`). Same code as D-02.
- D-04 CONFIRM. The page lists five memories columns. Catalog also has `access_compacted_at` and `access_compacted_id` (`memories.ts:123` and `:132`).
- D-05 CONFIRM. The page says compaction folds into `access_count`. Code says compaction does not add to `access_count` (`access-log.ts:286`). The counter increments on append (`access-log.ts:181`).
- D-06 CONFIRM. Production `recordAccess` writes usefulness 0 (`assemble.ts:1078`). `gradeUsefulness` has no production caller (`usefulness-grader.ts:201`).
- D-07 CONFIRM. Calibration never reorders (`recall.ts:2574`). `confidenceExponent` does not enter the score product (`memories/api.ts:316`).
- D-08 CONFIRM. `activationSource` is injected (`assemble.ts:1562`). The same file says `memory` and `sessions` hits have no access log (`assemble.ts:1089`). ACT-R runs only when that source returns a row (`recall.ts:2908`).
- D-09 CONFIRM. The doc cites `controlled-writes.ts:503` and `:610`, and `assemble.ts:1544` and `:1551`. The calls are `controlled-writes.ts:511` and `:634`, and `assemble.ts:2914` and `:2955`. The hook still exists. The line numbers do not.
- D-10 CONFIRM. No `src/dashboard/web/pages/lifecycle-panel.tsx`. Flag table is `src/dashboard/views.ts:95`.
- D-11 CONFIRM. `assembleHealth` is `lifecycle-health.ts:62`. The CLI recomputes the product inline (`src/commands/memory.ts:353`). No dashboard caller.
- D-12 CONFIRM. The only production `inlineLinkMemory` call found is graph persist (`graph-persist.ts:479`), skipped when there are no triples (`graph-persist.ts:448`). It is not the controlled-write commit.
- D-13 CONFIRM. Graph writer sets `agentId` to `scope.workspace ?? "default"` (`graph-persist.ts:453`). Org and workspace still ride the storage partition.
- D-14 CONFIRM. Traversal knobs are parsed in `recall/config.ts:58` and `:297`. No other `src` file walks focal entities. Recall sources stay `memories`, `memory`, `sessions`, and `hive_graph_versions` (`recall.ts` semantic and lexical arms).
- D-15 CONFIRM. No community, louvain, or cluster walker under `src/daemon`.
- D-16 CONFIRM. `confirmAspectWeight` and `decayAspectWeight` are `entity-model.ts:357` and `:368`. Call sites under `src/` are those definitions. Tests call them. Recall does not.
- D-17 CONFIRM. `runOntologyCommand` is `src/cli/ontology.ts:166`. Live verbs go through `src/commands/storage-handlers.ts` onto `/api/ontology/<sub>`. Mounted routes do not include `pipeline explain`, `merge-plan`, or `stream apply`. `ontology.ts:174` refuses a live `stream apply` without `--dry-run`.
- D-18 CONFIRM. No `WITH RECURSIVE` under `src/daemon`. GraphRAG remains unbuilt. Substrate that does exist: `content_embedding` on the graph catalog, and `RRF_K = 60` at `recall.ts:238`.
- D-19 CONFIRM. The worker leases a `pollinating` job and calls `runner.runPass` (`pollinating/worker.ts:22`). Identity source returns empty files (`incremental.ts:124`). No session-start hook and no transcript write on this path.
- D-20 CONFIRM. `createGraphQueryTool` has no caller (`incremental.ts:374`). The prompt names the tool (`incremental.ts:481`). Completion is one text call (`model-client.ts:71`).
- D-21 CONFIRM. Ack statuses `enqueued` and `running` exist (`pollinating/api.ts:210` and `:225`). A third, `below-threshold`, returns `triggered: true` (`api.ts:214`). The doc omits it.
- D-22 CONFIRM. `tests/integration/pollinating-consolidation-live.itest.ts:26` is `describe.skipIf` unless both `HONEYCOMB_DEEPLAKE_TOKEN` and `ANTHROPIC_API_KEY` are set, and `:30` keeps it out of `npm run ci`. This tree does not record a passing live run. Revise the page so it does not state that result as observed here.
- D-23 CONFIRM. Targets and policies require `id`, not `name` (`src/daemon/runtime/inference/config.ts:86` and `:96`). Capabilities are `chat | streaming | vision | tools` (`inference/contracts.ts:111`). Live workload tokens are `memory_extraction`, `memory_decision`, `memory_pollinating` (`model-client.ts:38`). `taskClass`, `session_synthesis`, and `interactive` are absent under `src/`.
- D-24 CONFIRM. `routeMain` is `src/cli/route.ts:464`. Production `src/` does not import that module. Callers are `tests/cli/route.test.ts`. `mountInferenceGateway` (`inference/gateway.ts:103`) is not called from `assemble.ts`.
- D-25 CONFIRM. No `rateLimit` or concurrency cap under `src/daemon/runtime/inference`. Body clamp and redaction sit on the unmounted gateway (`gateway.ts:252` and `:491`).
- D-26 CONFIRM. `PortkeyFallbackModelClient.complete` catches every error (`void err`) and calls the provider client (`inference/model-client-factory.ts:550`). There is no transport-only filter. A later provider failure can still propagate from the second call.
- D-27 CONFIRM. `PortkeyHealth` includes `no_model` (`src/daemon/runtime/health.ts:134`). Assembly sets it when the gateway is on and `activeModel` is empty (`assemble.ts:4177`). The closed list on the page omits it.
- D-28 CONFIRM. No `Portkey` string under `src/dashboard`. Vault keys exist (`src/daemon/runtime/vault/api.ts:105`, `vault/catalog.ts:88`).

## Holds

Wave 1 LEAVE rows were not re-litigated as edits. Spot checks that still match, and should stay:

- Capture outbox defaults and `HONEYCOMB_CAPTURE_OUTBOX`: `capture-outbox.ts:108` through `:129`.
- Pipeline master switch defaults off: `pipeline/config.ts:186`.
- Summary final trigger names and the session-end enqueue: `summaries/contracts.ts:71`, `attach.ts:281`.
- Pollinating defaults `enabled: false`, threshold 100000, max input 128000: `pollinating/config.ts:35` and `:57`.
- `effectiveStalenessExponent` returns 0 unless posture is `execute`: `lifecycle-config.ts:337`.

## Writer notes

- Apply the 70 CONFIRMED doc edits. Do not delete the pages.
- `git mv` PRD-006, PRD-008, PRD-009, and PRD-016 from `completed/` to `in-work/`. Update index status lines in the same move.
- Leave PRD-005, PRD-079, and PRD-080 in `completed/`. Leave PRD-058 in `in-work/`.
- Do not treat ISS-025 (fact cap 4, confidence 0.8) or the PRD-045b traversal de-scope as unfinished work. Those four UNMET marks are OVERTURNED.
