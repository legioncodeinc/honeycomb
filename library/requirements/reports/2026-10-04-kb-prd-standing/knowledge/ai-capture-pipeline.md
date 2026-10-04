# Wave 1a knowledge defects: AI capture and pipeline

Shard date: 2026-10-04. Branch working tree, read-only. Source checked under `src/` only. Build outputs and `node_modules` were not used.

Page action for every file in this shard: REVISE. None is REMOVE. No sibling in this shard already states the corrected mechanism in place of a whole page.

Defect count below is FALSE + STALE + HOLE only. HOLDS entries are checked claims a later writer should leave alone.

## Coverage

| Path | Read |
|---|---|
| library/knowledge/private/ai/session-capture.md | yes |
| library/knowledge/private/ai/skillify-pipeline.md | yes |
| library/knowledge/private/ai/memory-pipeline.md | yes |
| library/knowledge/private/ai/distillation-and-tier1-keys.md | yes |
| library/knowledge/private/ai/wiki-summary-workers.md | yes |
| library/knowledge/private/ai/session-priming-architecture.md | yes |
| library/knowledge/private/ai/pollinating-loop.md | no (header only; maintenance loop, not this shard) |
| library/knowledge/private/ai/three-tier-memory-strategy.md | no (header only; strategy parent, not this shard) |
| library/knowledge/private/ai/retrieval.md | no |
| library/knowledge/private/ai/hybrid-sql-vector-rationale.md | no |
| library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md | no |
| library/knowledge/private/ai/memory-lifecycle-scoring.md | no |
| library/knowledge/private/ai/memory-lifecycle-config.md | no |
| library/knowledge/private/ai/memory-lifecycle-as-built.md | no |
| library/knowledge/private/ai/knowledge-graph-ontology.md | no |
| library/knowledge/private/ai/graphrag-followon.md | no |
| library/knowledge/private/ai/prior-art-owls-roost-crosswalk.md | no |
| library/knowledge/private/ai/portkey-gateway.md | no |
| library/knowledge/private/ai/model-provider-router.md | no |

Mandatory checks:

- `wiki-summary-workers.md` says `summary_embedding` powers semantic recall. FALSE. The column is written; semantic recall does not query it.
- `wiki-summary-workers.md` says periodic checks live in `src/hooks/capture.ts`. ABSENT. The live counter is `src/daemon/runtime/capture/turn-counters.ts`, called from `capture-handler.ts`.
- `memory-pipeline.md` names an `embeddings` table. ABSENT from the catalog. Embeddings are `FLOAT4[]` columns, chiefly `memories.content_embedding`.

## session-capture.md

Page action: REVISE.

### CAP-1

- Quote: "Optional 768-dim embedding" then "Single INSERT via daemon -> sessions" (mermaid, embed before insert).
- Doc: library/knowledge/private/ai/session-capture.md:45
- Grounding: src/daemon/runtime/capture/capture-handler.ts:682 (`message_embedding` omitted from `buildRow`; comment says 005b attaches it later) and src/daemon/runtime/capture/capture-handler.ts:873 (`kickEmbed` is fire-and-forget after the row is built, not part of the INSERT).
- Verdict: STALE
- Action: REVISE

### CAP-2

- Quote: "the summary worker on a message or time threshold"
- Doc: library/knowledge/private/ai/session-capture.md:99
- Grounding: src/daemon/runtime/capture/turn-counters.ts:130 (message count only, modulo `summaryEvery`). `PERIODIC_TRIGGER_REASONS` includes `"hours"` at src/daemon/runtime/summaries/contracts.ts:76, but no capture path sets that reason. Grep of `src/` found no `HONEYCOMB_SUMMARY_EVERY_HOURS` and no elapsed-time check.
- Verdict: STALE
- Action: REVISE

### Holds

- Bound-project gate and inbox default off. Doc: session-capture.md:29. Grounding: src/daemon/runtime/assemble.ts:1385 and src/daemon/runtime/capture/capture-config.ts:109 (`resolveInboxCaptureEnabled` is off unless `true`/`1`). Verdict: HOLDS. Action: LEAVE.
- `HONEYCOMB_CAPTURE=false` disables capture. Doc: session-capture.md:95. Grounding: src/shared/capture-gate.ts:125. Verdict: HOLDS. Action: LEAVE.
- One row per event, `message` JSONB, batched flush by scope then column signature, 15-column base plus 0 to 4 usage columns. Doc: session-capture.md:37 and session-capture.md:57. Grounding: src/daemon/runtime/capture/capture-handler.ts:676 (`buildRow` emits 15 columns before `usageColumns`) and src/daemon/runtime/capture/capture-handler.ts:977 (`groupBufferedRows`). Current base still counts 15 because `message_embedding` is omitted and `prose` / `model` / `source_tool` are inside the 15. Verdict: HOLDS. Action: LEAVE.
- Capture outbox: `local-queue.db`, `INSERT OR IGNORE`, `Semaphore(3)`, max attempts 10, max age 24h, max rows 10k, backoff 5s to 5min, `HONEYCOMB_CAPTURE_OUTBOX` default on, `POST /api/diagnostics/capture-drain`. Doc: session-capture.md:69. Grounding: src/daemon/runtime/capture/capture-outbox.ts:121, src/daemon/runtime/capture/capture-outbox.ts:124, src/daemon/runtime/capture/capture-outbox.ts:468, src/daemon/runtime/capture/capture-drain-api.ts:45. Verdict: HOLDS. Action: LEAVE.
- `MAX_SESSION_TURNS` is 2000. `buildSessionsConcatSql` is in `src/daemon-client/vfs/read.ts`. `readAppendOrdered` is in `src/daemon/storage/writes.ts`. Doc: session-capture.md:85. Grounding: src/daemon/storage/sql.ts:172, src/daemon-client/vfs/read.ts:143, src/daemon/storage/writes.ts:383. Verdict: HOLDS. Action: LEAVE.
- `message_embedding` is a nullable 768-dim column; a failed embed leaves it null. Doc: session-capture.md:91. Grounding: src/daemon/storage/catalog/sessions-summaries.ts:41 and src/daemon/runtime/services/embed-client.ts:82 (`embed(text)` returns null on failure). Verdict: HOLDS. Action: LEAVE.
- Credentials reload is mtime-gated. Doc: session-capture.md:33. Grounding: src/daemon/storage/live-reload.ts:1 and src/daemon/runtime/assemble.ts:4731. Verdict: HOLDS. Action: LEAVE.
- Named capture files exist: `src/daemon/runtime/capture/{attach,capture-config,capture-handler,gated-captures}.ts` and `src/hooks/shared/{capture,session-start}.ts`. Doc: session-capture.md:29. Verdict: HOLDS. Action: LEAVE.

## skillify-pipeline.md

Page action: REVISE. The prose default of 10 and the config-table default of 20 disagree with each other. The code constant is 10, and the live capture path does not read the env var.

### SKL-1

- Quote: "The first is local and happens at the end of every session" and "the session-end trigger fires unconditionally through `src/hooks/shared/session-end.ts`, which posts to `/api/hooks/session-end` with the `"skillify"` intent."
- Doc: library/knowledge/private/ai/skillify-pipeline.md:21 and library/knowledge/private/ai/skillify-pipeline.md:27
- Grounding: the hook does post `intents: ["mark-ended", "record-usage", "skillify"]` at src/hooks/shared/session-end.ts:112. The live daemon handler ignores intents and enqueues a `summary` job only (src/daemon/runtime/capture/attach.ts:274). `evaluateTrigger` (the unconditional `sessionEnd` branch) is defined at src/daemon/runtime/skillify/miner.ts:745 and has no production caller. The live skillify cue is only `tryStopCounterTrigger` on a turn-terminating capture (src/daemon/runtime/capture/capture-handler.ts:827).
- Verdict: FALSE
- Action: REVISE

### SKL-2

- Quote: "`HONEYCOMB_SKILLIFY_EVERY_N_TURNS` | `20` | Stop-counter threshold"
- Doc: library/knowledge/private/ai/skillify-pipeline.md:135
- Grounding: src/daemon/runtime/capture/turn-counters.ts:61 (`DEFAULT_SKILLIFY_EVERY_TURNS = 10`). The same doc's prose at skillify-pipeline.md:29 says default 10, which matches the constant.
- Verdict: FALSE
- Action: REVISE

### SKL-3

- Quote: "checking `TurnCounters` against `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`"
- Doc: library/knowledge/private/ai/skillify-pipeline.md:27
- Grounding: `skillifyEveryNTurns` reads the env at src/daemon/runtime/skillify/miner.ts:715, but production `attachHooks` does not pass `counterConfig` (src/daemon/runtime/assemble.ts:1373). `capture-handler.ts:270` therefore constructs `new TurnCounters(undefined)` and keeps the constant 10. Grep of `src/` shows `skillifyEveryTurns:` only in tests.
- Verdict: STALE
- Action: REVISE

### SKL-4

- Quote: "`extractPairs()` (from `src/skillify/extractors/`)"
- Doc: library/knowledge/private/ai/skillify-pipeline.md:51
- Grounding: ABSENT. `extractPairs` is exported from src/daemon/runtime/skillify/miner.ts:404.
- Verdict: FALSE
- Action: REVISE

### SKL-5

- Quote: "The worker builds a gate prompt containing the existing project skills (capped at 30,000 characters) and the extracted pairs."
- Doc: library/knowledge/private/ai/skillify-pipeline.md:56
- Grounding: `buildGatePrompt` renders only the exchanges (src/daemon/runtime/skillify/miner.ts:425). No 30000-character skills cap exists in `src/daemon/runtime/skillify/`.
- Verdict: FALSE
- Action: REVISE

### SKL-6

- Quote: "The worker reads the verdict from the file the model was asked to write (`verdict.json` in the run's temp dir), or falls back to parsing the stdout if the model printed JSON instead."
- Doc: library/knowledge/private/ai/skillify-pipeline.md:75
- Grounding: ABSENT `verdict.json`. `parseVerdictStdout` reads the first stdout line for `KEEP` / `MERGE` / `SKIP` (src/daemon/runtime/skillify/miner.ts:597). The prompt is fed on stdin (src/daemon/runtime/skillify/miner.ts:514).
- Verdict: FALSE
- Action: REVISE

### SKL-7

- Quote: the per-agent gate table (`claude -p ... --model haiku`, `codex exec --dangerously-bypass-approvals-and-sandbox`, `cursor-agent --print ...`, `hermes -z ...`).
- Doc: library/knowledge/private/ai/skillify-pipeline.md:69
- Grounding: the daemon worker's default spec is `{ command: "claude", args: ["--print"] }` (src/daemon/runtime/skillify/worker.ts:231). There is no per-agent matrix in the skillify worker.
- Verdict: STALE
- Action: REVISE

### SKL-8

- Quote: "`scope=me`: filtered to `author = <userName>`" and "`scope=team` ... filtered to `author IN (<team>)`"
- Doc: library/knowledge/private/ai/skillify-pipeline.md:45
- Grounding: the fetcher adds `author IN (...)` only when `teamAuthors` is non-empty (src/daemon/runtime/skillify/miner.ts:176). The live worker calls `mine({ projectKey, triggerSessionId })` with no team list (src/daemon/runtime/skillify/worker.ts:340). The SQL also has no `agent_id` predicate.
- Verdict: STALE
- Action: REVISE

### SKL-9

- Quote: "Setting it to the oldest means the next run re-sees the same batch ... but also picks up any older sessions it missed."
- Doc: library/knowledge/private/ai/skillify-pipeline.md:119
- Grounding: the store does keep the oldest mined date (src/daemon/runtime/skillify/watermark.ts:105). The fetch predicate is `creation_date > watermark` (src/daemon/runtime/skillify/miner.ts:167), so rows older than that date are excluded, not recovered.
- Verdict: FALSE
- Action: REVISE

### SKL-10

- Quote: "`HONEYCOMB_SKILLS_TABLE` | `skills`", "`HONEYCOMB_SKILLIFY_WORKER`", "`HONEYCOMB_CURSOR_MODEL`", "`HONEYCOMB_HERMES_PROVIDER`", "`HONEYCOMB_HERMES_MODEL`", and "Logs write to `~/.claude/hooks/skillify.log`."
- Doc: library/knowledge/private/ai/skillify-pipeline.md:136 and library/knowledge/private/ai/skillify-pipeline.md:143
- Grounding: ABSENT. Grep of `src/` found none of those env names and no `skillify.log`. The table name is the constant `SKILLS_TABLE = "skills"` at src/daemon/runtime/skillify/skills-write.ts:76. `HONEYCOMB_AUTOPULL_DISABLED` does exist (src/daemon-client/skillify/install.ts:68).
- Verdict: FALSE
- Action: REVISE

### SKL-11

- Quote: "`install=project`: `<cwd>/.claude/skills/<name>/SKILL.md`" as the KEEP write path, presented as the worker's behavior.
- Doc: library/knowledge/private/ai/skillify-pipeline.md:81
- Grounding: `createFsInstallTarget` still supports both modes (src/daemon/runtime/skillify/install-target.ts:5). The live job worker always passes `"global"` (src/daemon/runtime/skillify/worker.ts:367).
- Verdict: STALE
- Action: REVISE

### Holds

- Stop-counter lives in the daemon, in-memory, reset on restart. Doc: skillify-pipeline.md:29. Grounding: src/daemon/runtime/capture/turn-counters.ts:12 and src/daemon/runtime/capture/capture-handler.ts:823. Verdict: HOLDS. Action: LEAVE.
- Watermark file is `<projectKey>/watermark.json` under `honeycombStateDir()/state/skillify`, with legacy `~/.honeycomb/state/skillify`. Doc: skillify-pipeline.md:31. Grounding: src/daemon/runtime/skillify/watermark.ts:38 and src/shared/fleet-root.ts:103. Verdict: HOLDS. Action: LEAVE.
- `projectKey` is the session path, or the session id when the path is empty. Doc: skillify-pipeline.md:31. Grounding: src/daemon/runtime/skillify/worker.ts:326. Verdict: HOLDS. Action: LEAVE.
- Last 10 sessions, pair cap 2000, batch cap 40000, gate timeout 120000 ms, KEEP floor of 3 exchanges, lock released in `finally`. Doc: skillify-pipeline.md:43 and skillify-pipeline.md:75. Grounding: src/daemon/runtime/skillify/miner.ts:58, src/daemon/runtime/skillify/miner.ts:60, src/daemon/runtime/skillify/miner.ts:64, src/daemon/runtime/skillify/miner.ts:66. Verdict: HOLDS. Action: LEAVE.
- `skills` table is append-only; a missing MERGE target falls back to `writeNewSkill`. Doc: skillify-pipeline.md:90. Grounding: src/daemon/storage/catalog/product.ts:286 and src/daemon/runtime/skillify/skills-write.ts:449. Verdict: HOLDS. Action: LEAVE.
- Auto-pull timeout 5s and symlink fan-out. Doc: skillify-pipeline.md:127. Grounding: src/daemon-client/skillify/install.ts:71 (`AUTOPULL_TIMEOUT_MS = 5_000`) and src/daemon-client/skillify/install.ts:662. The live roots also include `~/.codex/skills` and `~/.cursor/skills`, which the doc omits. That omission is not a false list of the three roots it does name. Verdict: HOLDS. Action: LEAVE.
- `buildSkillifyWorker` is started from assemble. Doc: skillify-pipeline.md:27. Grounding: src/daemon/runtime/assemble.ts:4314. Verdict: HOLDS. Action: LEAVE.

## memory-pipeline.md

Page action: REVISE.

### MEM-1

- Quote: mermaid stage order "Inline entity links (synchronous)" before "Extraction (LLM)".
- Doc: library/knowledge/private/ai/memory-pipeline.md:33
- Grounding: `inlineLinkMemory` runs after a memory commit, from graph persistence (src/daemon/runtime/pipeline/graph-persist.ts:386 and src/daemon/runtime/ontology/entity-model.ts:486). Capture enqueues `memory_extraction` directly (src/daemon/runtime/capture/capture-handler.ts:852).
- Verdict: FALSE
- Action: REVISE

### MEM-2

- Quote: "output is bounded to roughly 20 facts and 50 entities"
- Doc: library/knowledge/private/ai/memory-pipeline.md:44
- Grounding: src/daemon/runtime/pipeline/config.ts:59 (`DEFAULT_MAX_FACTS = 4`, comment "ISS-025: 20 -> 4") and src/daemon/runtime/pipeline/config.ts:61 (`DEFAULT_MAX_ENTITIES = 50`). The 12000-character input cap in the same sentence holds (`DEFAULT_INPUT_CHAR_CAP = 12_000` at config.ts:49).
- Verdict: STALE
- Action: REVISE

### MEM-3

- Quote: "`minFactConfidenceForWrite` (default 0.7)"
- Doc: library/knowledge/private/ai/memory-pipeline.md:52
- Grounding: src/daemon/runtime/pipeline/config.ts:82 (`DEFAULT_MIN_FACT_CONFIDENCE = 0.8`, comment "ISS-025: 0.7 -> 0.8").
- Verdict: STALE
- Action: REVISE

### MEM-4

- Quote: "indexes them in the hints table" and flag row "`hints.enabled` | Run prospective hint generation at write time."
- Doc: library/knowledge/private/ai/memory-pipeline.md:66 and library/knowledge/private/ai/memory-pipeline.md:104
- Grounding: ABSENT. No `hints` table in `src/daemon/storage/catalog/`. No `hints` field on `PipelineConfigSchema` (src/daemon/runtime/pipeline/config.ts:184). `emptyHintSource` says the writer is a future PRD (src/daemon/runtime/recall/collection.ts:85).
- Verdict: FALSE
- Action: REVISE

### MEM-5

- Quote: "`graph.extractionWritesEnabled` | Let background extraction persist entity triples. Default on."
- Doc: library/knowledge/private/ai/memory-pipeline.md:102
- Grounding: schema default is false (src/daemon/runtime/pipeline/config.ts:149). The resolved gate follows the memory master switch when neither env nor vault is set (src/daemon/runtime/pipeline/config.ts:487), and that master switch defaults off (config.ts:186).
- Verdict: STALE
- Action: REVISE

### MEM-6

- Quote: "Memory rows, embeddings | `memories`, `embeddings`, vector tensor table | content hash"
- Doc: library/knowledge/private/ai/memory-pipeline.md:116
- Grounding: ABSENT `embeddings` table. Catalog tables are spread in src/daemon/storage/catalog/index.ts:46 and include `memories` (src/daemon/storage/catalog/memories.ts:183) with column `content_embedding` (memories.ts:78). Controlled writes set that column (src/daemon/runtime/pipeline/controlled-writes.ts:1021). `vector.ts:4` stores tensors as `FLOAT4[]` columns on the same tables, not a separate tensor table. Retention step name `embeddings_tombstones` (src/daemon/runtime/pipeline/retention.ts:158) nulls the column on tombstoned rows; it is not a table.
- Verdict: FALSE
- Action: REVISE

### Holds

- Local queue is the default; path is `honeycombStateDir()` then `.daemon/local-queue.db`, not cwd. Doc: memory-pipeline.md:25. Grounding: src/daemon/runtime/assemble.ts:2128 and src/daemon/runtime/services/local-job-queue.ts:22. Verdict: HOLDS. Action: LEAVE.
- `describeProbeFailure`, `redactProbedHash`, `classifyFailure`, `isTransientResult`, `commitControlledWrite`, `memory_outbox`, `runMemoryRedrive`, `POST /api/diagnostics/memory-redrive`, `honeycomb memory redrive`. Doc: memory-pipeline.md:56. Grounding: src/daemon/runtime/pipeline/controlled-writes.ts:693, src/daemon/runtime/pipeline/memory-outbox.ts:91, src/daemon/runtime/pipeline/memory-redrive-api.ts:44, src/commands/memory.ts:48. Outbox defaults match the doc (attempts 10, age 24h, rows 10k, drain 200, backoff 5s to 5min) at memory-outbox.ts:127. Verdict: HOLDS. Action: LEAVE.
- Pipeline master switch defaults off. `BoolFlag` trims. Doc: memory-pipeline.md:70 and memory-pipeline.md:76. Grounding: src/daemon/runtime/pipeline/config.ts:186 and src/shared/bool-flag.ts:32. Verdict: HOLDS. Action: LEAVE.
- Graph tables named in the produce-table (`entities`, `entity_dependencies`, `memory_entity_mentions`) exist. Doc: memory-pipeline.md:117. Grounding: src/daemon/storage/catalog/knowledge-graph.ts:90, knowledge-graph.ts:169, knowledge-graph.ts:191. Verdict: HOLDS. Action: LEAVE.
- `src/daemon/runtime/services/{lease-coordinator,job-queue,hybrid-job-queue,local-queue-diagnostics}.ts` exist, and `discoverIds` is still the lease scan (src/daemon/runtime/services/job-queue.ts:668). Doc: memory-pipeline.md:76. Verdict: HOLDS. Action: LEAVE.

## distillation-and-tier1-keys.md

Page action: REVISE. The quality bar and the good/bad key examples are design text, not code claims. The wiring status is behind the worker.

### DIS-1

- Quote: "the change this strategy asks for is the prompt discipline (structured-extraction-first) layered on top, plus the extra key-derivation step."
- Doc: library/knowledge/private/ai/distillation-and-tier1-keys.md:92
- Grounding: the live gate already emits `{ extraction, summary, key }` in that order (src/daemon/runtime/summaries/key.ts:11 and src/daemon/runtime/summaries/worker.ts:649). The worker writes `key` on the `memory` row (worker.ts:236).
- Verdict: STALE
- Action: REVISE

### DIS-2

- Quote: "the `notImplemented` reference lingering in `summaries/index.ts`'s header comment is stale; the file body exports the real `synthesizeMemoryIndex` / `synthesizeThreadHeads`."
- Doc: library/knowledge/private/ai/distillation-and-tier1-keys.md:108
- Grounding: the header does not say `notImplemented`. It still calls 017b "an honest stub" (src/daemon/runtime/summaries/index.ts:9). `notImplemented` is still a live export (index.ts:23, defined at src/daemon/runtime/summaries/contracts.ts:350). The real functions are exported (index.ts:152) and implemented (src/daemon/runtime/summaries/synthesis.ts:478 and synthesis.ts:552). The "not a stub" half holds. The "header comment says notImplemented" half does not.
- Verdict: STALE
- Action: REVISE

### DIS-3

- Quote: "the natural home for Tier-2 + key derivation once the worker is wired live."
- Doc: library/knowledge/private/ai/distillation-and-tier1-keys.md:133
- Grounding: the summary job worker is built in assemble and writes keys now (src/daemon/runtime/summaries/job.ts:66 and src/daemon/runtime/summaries/worker.ts:680). Section 5 of the same doc already says the wiring gap is closed, so this sentence contradicts that section.
- Verdict: STALE
- Action: REVISE

### Holds

- Tier-1 `key` column exists on `memory` and on `memories`. Doc: distillation-and-tier1-keys.md:47. Grounding: src/daemon/storage/catalog/sessions-summaries.ts:115 and src/daemon/storage/catalog/memories.ts:58. Verdict: HOLDS. Action: LEAVE.
- Prime skims `key` with SQL, no generation at read time. Doc: distillation-and-tier1-keys.md:123. Grounding: src/daemon/runtime/summaries/prime-keys.ts:79 and src/daemon/runtime/memories/prime.ts:17. Verdict: HOLDS. Action: LEAVE.
- Summary path `/summaries/<userName>/<sessionId>.md` and `/MEMORY.md` refresh. Doc: distillation-and-tier1-keys.md:106 and distillation-and-tier1-keys.md:118. Grounding: src/daemon/runtime/summaries/worker.ts:91 and src/daemon/runtime/summaries/synthesis.ts:67. Verdict: HOLDS. Action: LEAVE.
- PRD-017 index path cited in the related list exists at library/requirements/completed/prd-017-wiki-summaries/prd-017-wiki-summaries-index.md. Verdict: HOLDS. Action: LEAVE.
- `src/eval/prime.ts` measures pull-through as set membership of a target ref, not an LLM judge. Doc: distillation-and-tier1-keys.md:149 (pull-through as a bar). Grounding: src/eval/prime.ts:27. The doc does not claim the metric is already the production dashboard. Verdict: HOLDS. Action: LEAVE.

## wiki-summary-workers.md

Page action: REVISE. This page still describes the pre-daemon hook worker (sidecar JSON, `src/hooks/capture.ts`, `verdict` files, per-agent CLI flags). The daemon worker replaced that path. Do not delete the page: the summary worker, the `memory` row, the lock file, and the non-fatal embed are real.

### WIK-1

- Quote: "That document is what shows up when you `Grep` across `~/.honeycomb/memory/` or follow links from `~/.honeycomb/memory/index.md`."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:19
- Grounding: generated overviews now point at `~/.apiary/honeycomb/memory/` (src/daemon-client/vfs/index-gen.ts:32). The legacy `~/.honeycomb/memory/` shape is still recognized (index-gen.ts:29). The virtual index filename is still `index.md` (src/daemon-client/vfs/read.ts:31). The canonical synthesized wiki index inside the `memory` table is `/MEMORY.md` (src/daemon/runtime/summaries/synthesis.ts:67), which this sentence does not mention.
- Verdict: STALE
- Action: REVISE

### WIK-2

- Quote: "Summaries also carry a `summary_embedding` vector (768-dim `nomic-embed-text-v1.5`) so semantic recall can promote a session even when the search terms do not match the exact words used at the time."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:21
- Grounding: the column exists and is written (src/daemon/storage/catalog/sessions-summaries.ts:107, src/daemon/runtime/summaries/worker.ts:232). Semantic arms are `memories.content_embedding`, `sessions.message_embedding`, and `hive_graph_versions.embedding` only (src/daemon/runtime/memories/recall.ts:1375). `embeddingColumnFor` returns null for source `"memory"` (recall.ts:1700). Lexical recall does search `memory.summary` (recall.ts:599). `src/daemon/storage/vector.ts:6` still names `memory.summary_embedding` in a module comment; the recall engine does not query it.
- Verdict: FALSE
- Action: REVISE

### WIK-3

- Quote: "The periodic threshold check lives inside `maybeTriggerPeriodicSummary()` in `src/hooks/capture.ts`."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:33
- Grounding: ABSENT. No `src/hooks/capture.ts`. No symbol `maybeTriggerPeriodicSummary` under `src/`. Capture hooks live at `src/hooks/shared/capture.ts` and do not count summary thresholds. The live bump is `TurnCounters.recordMessage` (src/daemon/runtime/capture/turn-counters.ts:130) called from src/daemon/runtime/capture/capture-handler.ts:825, which enqueues a `summary` cue.
- Verdict: FALSE
- Action: REVISE

### WIK-4

- Quote: "the function bumps a per-session counter in `~/.claude/hooks/summary-state/<sessionId>.json`" and "A sidecar JSON ... tracks `{ lastSummaryAt, lastSummaryCount, totalCount }`."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:33 and library/knowledge/private/ai/wiki-summary-workers.md:37
- Grounding: ABSENT. The summary-state directory is the lock root only (`<sessionId>.lock`, src/daemon/runtime/summaries/worker.ts:331). Counters are the in-memory map in turn-counters.ts:91, which resets on restart (turn-counters.ts:12).
- Verdict: FALSE
- Action: REVISE

### WIK-5

- Quote: "`HONEYCOMB_SUMMARY_EVERY_N_MSGS` (default 50) OR elapsed time ... `HONEYCOMB_SUMMARY_EVERY_HOURS` (default 2)" and the same pair in the config table.
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:31 and library/knowledge/private/ai/wiki-summary-workers.md:148
- Grounding: ABSENT env names in `src/`. Live default is `DEFAULT_SUMMARY_EVERY_MESSAGES = 20` (src/daemon/runtime/capture/turn-counters.ts:59). No hours threshold is evaluated. Final session-end enqueue is separate (src/daemon/runtime/capture/attach.ts:281, `triggerKind: "final"`).
- Verdict: FALSE
- Action: REVISE

### WIK-6

- Quote: `WHERE path LIKE '/sessions/%<sessionId>%'` built through `sqlLike`.
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:52
- Grounding: `createSessionEventFetcher` uses `path = sLiteral(session.path)` and `ORDER BY creation_date ASC` (src/daemon/runtime/summaries/worker.ts:170). No `LIKE`.
- Verdict: FALSE
- Action: REVISE

### WIK-7

- Quote: "reads the embedded `**JSONL offset**: N` marker to know how many events the previous summary already covered."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:62
- Grounding: ABSENT. Grep of `src/` found no `JSONL offset`. `runSummaryWorker` summarizes the fetched events and, if a real summary row already exists, skips the write (src/daemon/runtime/summaries/worker.ts:297).
- Verdict: FALSE
- Action: REVISE

### WIK-8

- Quote: `buildClaudeInvocation` plus `execFileSync`, and "The gate CLI writes the generated markdown to a temp file (`summary.md`)."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:69 and library/knowledge/private/ai/wiki-summary-workers.md:76
- Grounding: ABSENT `buildClaudeInvocation` and `summary.md` under `src/daemon/runtime/summaries/`. The spawner is `child_process.spawn` with the prompt on stdin (src/daemon/runtime/summaries/worker.ts:474). The gate returns stdout JSON parsed by `parseSummaryGate` (worker.ts:662). Agent selection is `summaryCliSpecFor` (src/daemon/runtime/summaries/job.ts:153): `claude -p`, `codex exec -`, `cursor-agent -p`, `hermes -p`, `pi -p`.
- Verdict: FALSE
- Action: REVISE

### WIK-9

- Quote: "`EmbedClient.embed(text, \"document\")`"
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:80
- Grounding: `EmbedClient.embed(text: string)` takes one argument (src/daemon/runtime/services/embed-client.ts:82). The worker calls `embed(markdown)` (src/daemon/runtime/summaries/worker.ts:735).
- Verdict: FALSE
- Action: REVISE

### WIK-10

- Quote: "it checks for an existing row and either rewrites it or inserts a new one."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:86
- Grounding: `writeSummary` inserts only when no real (non-placeholder) row exists, and the comment says never an in-place UPDATE (src/daemon/runtime/summaries/worker.ts:280 and worker.ts:297).
- Verdict: FALSE
- Action: REVISE

### WIK-11

- Quote: "`finalizeSummary(sessionId, jsonlLines)` to record the new baseline count."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:88
- Grounding: ABSENT. Grep of `src/` found no `finalizeSummary`.
- Verdict: FALSE
- Action: REVISE

### WIK-12

- Quote: "The daemon's `query()` helper retries on HTTP 401, 403, 429, 500, 502, and 503, with exponential backoff up to 30 seconds plus jitter."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:122
- Grounding: transient statuses are 429, 500, 502, 503, 504 (src/daemon/storage/client.ts:179). 401 and 403 are non-transient (client.ts:368). Backoff ceiling is 1000 ms (client.ts:188), 4 attempts (client.ts:182).
- Verdict: FALSE
- Action: REVISE

### WIK-13

- Quote: the per-agent gate table (`claude -p ... --model`, `codex exec --dangerously-bypass-approvals-and-sandbox`, `cursor-agent --print --model ... --force`, `hermes -z ... --yolo`, `pi --print --provider ...`).
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:134
- Grounding: src/daemon/runtime/summaries/job.ts:153 (`summaryCliSpecFor` args are `-p` or `exec -` only). Config rows for `HONEYCOMB_CURSOR_MODEL`, `HONEYCOMB_HERMES_PROVIDER`, `HONEYCOMB_HERMES_MODEL`, `HONEYCOMB_PI_PROVIDER`, `HONEYCOMB_PI_MODEL` are ABSENT from `src/`.
- Verdict: STALE
- Action: REVISE

### WIK-14

- Quote: "Worker activity logs to `~/.claude/hooks/wiki.log`."
- Doc: library/knowledge/private/ai/wiki-summary-workers.md:159
- Grounding: ABSENT. Grep of `src/` found no `wiki.log`. The job worker emits structured events such as `summary.worker.completed` (src/daemon/runtime/summaries/job.ts:177).
- Verdict: FALSE
- Action: REVISE

### Holds

- Final trigger names `Stop`, `SessionEnd`, `session_shutdown`. Doc: wiki-summary-workers.md:31. Grounding: src/daemon/runtime/summaries/contracts.ts:71. The live session-end route enqueues `triggerKind: "final"` (src/daemon/runtime/capture/attach.ts:281). The hook's `summarySpawn` defaults to a no-op (src/hooks/runtime.ts:474), so the daemon enqueue is the real final trigger. Verdict: HOLDS for the event names and the daemon enqueue. Action: LEAVE the final-trigger row after the periodic row is corrected.
- Lock file `~/.claude/hooks/summary-state/<sessionId>.lock`, released in `finally`. Doc: wiki-summary-workers.md:35. Grounding: src/daemon/runtime/summaries/worker.ts:355 and worker.ts:695. Verdict: HOLDS. Action: LEAVE.
- Event-fetch retries default 5 and linear backoff 1500 ms. Doc: wiki-summary-workers.md:56. Grounding: src/daemon/runtime/summaries/contracts.ts:137. Verdict: HOLDS. Action: LEAVE.
- Placeholder `description = 'in progress'` is removed when no events arrive, and a real summary is not deleted by that guard. Doc: wiki-summary-workers.md:58 and wiki-summary-workers.md:120. Grounding: src/daemon/runtime/summaries/worker.ts:93 and worker.ts:272. Verdict: HOLDS. Action: LEAVE.
- Path `/summaries/<userName>/<sessionId>.md`, `description` excerpt, null embedding on embed failure, subprocess env `HONEYCOMB_WIKI_WORKER=1` and `HONEYCOMB_CAPTURE=false`. Doc: wiki-summary-workers.md:83 and wiki-summary-workers.md:124. Grounding: src/daemon/runtime/summaries/worker.ts:91, worker.ts:733, worker.ts:479. Verdict: HOLDS. Action: LEAVE.
- `HONEYCOMB_CAPTURE=false` disables capture. Doc: wiki-summary-workers.md:157. Grounding: src/shared/capture-gate.ts:125. The same row's claim that this also disables summary generation is only true insofar as there are no new events to summarize. Verdict: HOLDS for the capture flag. Action: LEAVE.

## session-priming-architecture.md

Page action: REVISE.

### PRM-1

- Quote: "Nothing is auto-injected after the prime."
- Doc: library/knowledge/private/ai/session-priming-architecture.md:65
- Grounding: Claude Code registers a second `UserPromptSubmit` hook with `--honeycomb-recall` (harnesses/claude-code/hooks/hooks.json:20). That maps to `user_prompt_recall` (src/hooks/claude-code/shim.ts:66) and `runUserPromptRecall` injects `additionalContext` on the turn (src/hooks/shared/user-prompt-recall.ts:15). The prime itself is still once per session-start (src/hooks/runtime.ts:355).
- Verdict: FALSE
- Action: REVISE

### PRM-2

- Quote: "the prime composes with the same PRD-047c semantic dedup and PRD-047d recency dampening the recall pipeline uses: the recent list is age-weighted, the durable list deliberately ages slowly"
- Doc: library/knowledge/private/ai/session-priming-architecture.md:125
- Grounding: `assemblePrimeDigest` defaults to `identityRecencyRanker` and `normalizedTextDeduper`. The file says the richer PRD-047d dampener is not built and PRD-047c semantic dedup "composes in here later" (src/daemon/runtime/summaries/prime-digest.ts:21 and prime-digest.ts:36). `renderPrime` calls `assemblePrimeDigest(keys, budget ?? {})` with no semantic deduper (src/daemon/runtime/memories/prime.ts:129).
- Verdict: FALSE
- Action: REVISE

### PRM-3

- Quote: "cheap lexical+recency SQL (Tier-1 keys)"
- Doc: library/knowledge/private/ai/session-priming-architecture.md:191
- Grounding: the skim selects the `key` column ordered by date (src/daemon/runtime/summaries/prime-keys.ts:79). It is not a lexical match. `prime.ts:17` states there is no embed client and no vector call at read time.
- Verdict: STALE
- Action: REVISE

### PRM-4

- Quote: "`hivemind_search` / `hivemind_read` / `hivemind_index`"
- Doc: library/knowledge/private/ai/session-priming-architecture.md:201
- Grounding: `hivemind_read` and `hivemind_search` exist (mcp/src/tools.ts:108 and mcp/src/tools.ts:116). `hivemind_index` is ABSENT. The browse tool is `honeycomb_index` (mcp/src/tools.ts:99).
- Verdict: FALSE
- Action: REVISE

### PRM-5

- Quote: "wired by Honeycomb's `src/cli/install-cursor.ts`"
- Doc: library/knowledge/private/ai/session-priming-architecture.md:203
- Grounding: ABSENT. Cursor hooks are installed by `src/connectors/cursor.ts` (`configPath` is `~/.cursor/hooks.json`, cursor.ts:100). Session-start timeout in that connector is still 10 (cursor.ts:74), unlike the Claude Code 30s budget.
- Verdict: FALSE
- Action: REVISE

### PRM-6

- Quote: "additional harnesses (Codex, Hermes, pi, OpenClaw) follow the same shape, the same prime endpoint, the same MCP tools, a per-host SessionStart entry."
- Doc: library/knowledge/private/ai/session-priming-architecture.md:206
- Grounding: Codex uses the shared hook runtime, including `runSessionStart` (harnesses/codex/src/index.ts:11). Hermes and OpenClaw shims map a session-start event (src/hooks/hermes/shim.ts:34, src/hooks/openclaw/shim.ts:47) but have no connector under `src/connectors/` (only claude-code, cursor, codex). pi has no session-start event: `PI_EVENT_MAP` is only `agent_end` and `session_shutdown` (src/hooks/pi/shim.ts:28), and the pi comment says recall is on-demand via a static `AGENTS.md` block (shim.ts:7).
- Verdict: STALE
- Action: REVISE

### Holds

- `GET /api/memories/prime` is registered inside `mountMemoriesApi` before `/:id`. `mountMemoriesPrimeApi` remains. Doc: session-priming-architecture.md:111. Grounding: src/daemon/runtime/memories/api.ts:1024 and src/daemon/runtime/memories/prime.ts:183. Verdict: HOLDS. Action: LEAVE.
- Digest assembler files `src/daemon/runtime/summaries/prime-digest.ts` and `prime-keys.ts` exist. Doc: session-priming-architecture.md:123. Verdict: HOLDS. Action: LEAVE.
- `hivemind_read` is a deterministic resolve, not a search. Doc: session-priming-architecture.md:135. Grounding: src/daemon/runtime/memories/resolve.ts:6. `hivemind_search` posts to recall (mcp/src/handlers.ts:309) and recall is `src/daemon/runtime/memories/recall.ts`. Verdict: HOLDS. Action: LEAVE.
- Session-start hook fetches the prime once and `backgroundPull` detaches skill, asset, and graph pulls. Doc: session-priming-architecture.md:154 and session-priming-architecture.md:171. Grounding: src/hooks/shared/session-start.ts:272. Verdict: HOLDS. Action: LEAVE.
- Claude Code SessionStart timeout is 30 in `harnesses/claude-code/hooks/hooks.json:10` and `src/connectors/claude-code.ts:97`. Doc: session-priming-architecture.md:168. Verdict: HOLDS. Action: LEAVE.
- Prime renderer timeout was widened past 2s. Current constant is 5000 ms. Doc: session-priming-architecture.md:180. Grounding: src/hooks/shared/prime-renderer.ts:52. Verdict: HOLDS. Action: LEAVE.
- `src/eval/prime.ts` exists and compares primed vs cold behavior without an LLM judge. Doc: session-priming-architecture.md:226. Grounding: src/eval/prime.ts:1. Verdict: HOLDS. Action: LEAVE.

## Defect count

42 defects: CAP 2, SKL 11, MEM 6, DIS 3, WIK 14, PRM 6.

No REMOVE. Every page action is REVISE.
