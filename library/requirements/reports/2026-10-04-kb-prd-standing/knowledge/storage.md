# Storage knowledge standing (2026-10-04)

Shard: `library/knowledge/private/storage/` only. Branch `legion/kb-sotu-and-prd-lifecycle`. No live DeepLake probe was run. A missing probe artifact is not a false claim. Historical timings stay labeled REPORTED. Defects below are claims about current code that disagree with `src/daemon/storage` or with a path the note names.

## Coverage

| File | Lines | What it is |
|---|---|---|
| `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md` | 159 | 2026-07-10 session findings: hosted measurements, then the PRD-077/078/079 client changes, then open issues |
| `library/knowledge/private/storage/deeplake-vendor-report-2026-07-12.md` | 219 | 2026-07-12 vendor letter. Latency, concurrency, and asks. No daemon architecture beyond the reproduction commands |
| `library/knowledge/private/storage/deeplake-battle-test-vendor-evidence-2026-07-12.md` | 223 | Same-day battle test. Same numbers, plus the them-vs-us classifier and the PRD-079/080 mapping |

All three files were read in full. No other markdown lives in this directory.

Page actions: revise the findings note and the battle-test discriminator paragraph. Leave both measurement bodies. Do not remove any of the three files.

## REPORTED measurements (LEAVE)

These are dated probe results. Do not rewrite them because a fresh live run was not made, and do not treat a missing `.stress-report/` JSON or a missing `dist/` tree as a false claim.

- Findings s1.1-s1.4: no `CREATE INDEX ... USING vector` / `USING hnsw` (400), `deeplake_index` BM25-only, `<#>` 2.4-2.6s on about 2,004 rows, COUNT about 433ms, warm appends about 1.3-2.1s, `CREATE TABLE` 9s to timeout, post-CREATE `relation does not exist`, `deeplake.woke` / cold recall 40s-25min, reads 2.3s-40s. Workspace under test: `apiary`. Findings `deeplake-recall-and-capture-findings-2026-07-10.md:11-28`.
- Findings s2 and s6: `injectedRefs: []`, recall p50 about 40s / max about 25min, armsMs 73,273 to 3,012, the disproved theories (health flood, retry storm, parser bug, scoring bug, write serialization). Findings `:36-45` and `:113-126`.
- Findings s3 close-out numbers: 4,844 tests, PR #281 / #287 / #289, commits `9340a6c`, `0e1a198`, `1249f85`, `8dcdee9`, `1b0774f`, `dcfdfcf`, `b0713ae`, `99c7a18`. Findings `:74`, `:91`, `:154-158`. The parenthetical "~537 lines" at `:68` is the 079a snapshot, not a current line count.
- Vendor report F1-F7 and the battle-test s3 tables: point-lookup p50 about 0.54-0.55s, max 3.65s; INSERT p50 about 0.54s, max 4.2s; `CREATE TABLE ... USING deeplake` 6727/7385/9711/7108 ms; concurrency 1/4/8/16 error rates 0% / 20% / 0% / 63%; throughput 1.4-3.0 ops/s; identical 16-way burst p95 7.1s then 10/16 timeouts at 30s; 60s sweep killed; probe setup 400 on a non-existent `org` column; write-read convergence clean in those runs (F7). Workspace under test: `honeycomb`, org redacted `****eda2`. Vendor `deeplake-vendor-report-2026-07-12.md:54-170`. Battle `deeplake-battle-test-vendor-evidence-2026-07-12.md:80-163`. Client build note `dist/` at v0.12.2, installed daemon v0.9.0: battle `:216-217`.
- The two reports do not contradict each other. Findings measured fresh-`CREATE` visibility lag. The vendor letter's F7 measured write-then-read on an already-visible throwaway table and explicitly declines to file a defect. Both stay REPORTED.
- Calling `CREATE TABLE ... USING deeplake` an "index build" is the vendor letter's and `scripts/deeplake-probe.mjs:48-51` label for that DDL. It is not a claim that `CatalogTable` has an index field. Leave it.

Reproduction entry points still exist, so the how-to-run lines are not absent: `package.json` script `deeplake:stress`, `scripts/deeplake-stress.mjs`, `tests/integration/deeplake-stress-live.itest.ts`, `scripts/deeplake-probe.mjs`. Vendor `:194-199`. Battle `:43-56` and `:192-206`.

## Defects

### D1. Open issue still says cwd receives `.daemon/` and `.secrets/`

- Quote: "The daemon writes `.daemon/`/`.secrets/` into `process.cwd()` when `HONEYCOMB_WORKSPACE` is unset (`assemble.ts:1950-1952`), violating ADR-0003"
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:109`
- Also: appendix "`workspaceBaseDirCandidate:1950`" at `:150`
- Grounding: `src/daemon/runtime/assemble.ts:2071-2073` (`workspaceBaseDirCandidate` still returns `process.cwd()` when the env is blank, but it is not at 1950-1952). `src/daemon/runtime/assemble.ts:1998-2004` and `:2112-2113` and `:2815` put `.secrets/` on `resolveVaultBaseDir()` which is `honeycombStateDir()`, not cwd. `src/daemon/runtime/assemble.ts:2128-2129` and `:3178-3179` put `local-queue.db` on `resolveLocalQueueBaseDir()` / `honeycombStateDir()`. `src/shared/fleet-root.ts:103-105` is `<fleetRoot>/honeycomb`, default `~/.apiary/honeycomb`. What still follows the workspace dir, and therefore cwd when the env is unset: `agent.yaml` at `assemble.ts:2166`, and `.daemon/logs.db` at `assemble.ts:3039-3041`.
- Verdict: STALE
- Action: REVISE. Keep the historical "scattered state during the July investigation" sentence. The open-issue line should say vault and the queue are on the fleet state root, and that logs plus `agent.yaml` still use the workspace dir. Fix the line anchor to `assemble.ts:2071`.

### D2. "Every statement is bounded by 10s"

- Quote: "`DEFAULT_QUERY_TIMEOUT_MS = 10_000` (`storage/config.ts:24`). Every statement (read or write) is bounded by 10s via an `AbortController` in `client.runAttempt`."
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:31`
- Grounding: the constant and the abort are real. `src/daemon/storage/config.ts:23-24` and `:32-39` (default 10_000, clamp up to 600_000). `src/daemon/storage/config.ts:114` reads `HONEYCOMB_QUERY_TIMEOUT_MS`. `src/daemon/storage/client.ts:548` uses `opts.timeoutMs ?? this.config.queryTimeoutMs`. `src/daemon/storage/client.ts:554` is the `AbortController` inside `runAttempt`.
- Verdict: STALE
- Action: REVISE the second sentence to "default 10s, overridable by `HONEYCOMB_QUERY_TIMEOUT_MS` and per-call `timeoutMs`". The same 10s-as-a-hard-cap wording shows up again at findings `:99` and `:134`; those are session narrative and can stay if D5 is tightened.

### D3. Unsafe-write short-circuit cited at `client.ts:477`

- Quote: "Captures were already single-attempt (`unsafe-write` short-circuit, `client.ts:477`, since PRD-062)."
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:121`
- Grounding: the behavior holds. The return is `src/daemon/storage/client.ts:497` (`if (retryability === "unsafe-write") return this.attemptOnce(...)`). Lines 473-477 are the `maxAttempts` comment, not the short-circuit. Capture also passes `maxAttempts: 1` at `src/daemon/runtime/capture/capture-handler.ts:101`.
- Verdict: STALE
- Action: REVISE the line number to `client.ts:497`. Leave the conclusion (captures were already single-attempt).

### D4. `<#>` score anchor `vector.ts:242`

- Quote: "`src/daemon/storage/vector.ts` (`buildVectorSearchSql`, `<#>` score norm `:242`, `cosineSimilarity` `:137`, `deeplakeCosineScore`, `readEmbeddingCell`)."
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:144`
- Grounding: `cosineSimilarity` starts at `src/daemon/storage/vector.ts:137` (HOLDS). `deeplakeCosineScore` is `vector.ts:308-310`. `readEmbeddingCell` is `vector.ts:115`. The score expression `((1 + (emb <#> vec)) / 2)` is `vector.ts:274`, not 242. Line 242 is the end of the `VectorSearchArgs` comment. The corrected cosine comment is `vector.ts:265-273` (the old "negative inner product" wording is gone).
- Verdict: STALE
- Action: REVISE `:242` to `:274`. Leave `:137`.

### D5. Strategic write bullet still says memories are dropped

- Quote: "Writes - flapping hosted latency -> appends time out past the 10s statement bound -> memories dropped."
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:134`
- Grounding: section 5 of the same file (`:106`) already marks the drop resolved by PRD-079, and `:136` says the outbox keeps the capture. Current capture enqueues on any non-ok append: `src/daemon/runtime/capture/capture-handler.ts:385-391` and `:495-509`. The storage client returns a `timeout` result; it does not drop the row by itself. `src/daemon/storage/client.ts:461-464`.
- Verdict: STALE
- Action: REVISE the bullet to past tense for the pre-outbox session, and point at the outbox for the current path. Leave the latency sentence as REPORTED backend behavior.

### D6. Dashboard contention listed as not yet addressed

- Quote: "Hive dashboard polling competes on the read client; a recall-dedicated read lane (or a saner poll cadence) is the follow-up."
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:110`
- Grounding: the shared read client is still one `Semaphore(5)` for recall, dashboard, heal, and prime. `src/daemon/runtime/assemble.ts:3092-3094`. `MAX_CONCURRENT_QUERIES = 5` at `src/daemon/storage/client.ts:175`. A separate in-process fast-recall lane already exists and is documented as not sharing the dashboard recall pool: `src/daemon/runtime/memories/recall.ts:137-160` (`recallFastMaxConcurrency`, default 8, `src/daemon/runtime/memories/amplification-config.ts:72`). That lane does not split the storage read client. Both still take permits from it.
- Verdict: STALE
- Action: REVISE. Say the fast-recall pool is already separate, and that dashboard polls still share the read `StorageClient` semaphore. Do not delete the contention note.

### D7. Battle-test says every transient is retried and outboxed, and every genuine error is thrown and never outboxed

- Quote: "These are retried and (post PRD-079/080) routed to the durable outbox." and "These are thrown, never silently retried." and "classify it as genuine -> throw, never route it to the retry/outbox path."
- Doc: `library/knowledge/private/storage/deeplake-battle-test-vendor-evidence-2026-07-12.md:61-65` and `:156-160`
- Grounding: classification of the status set holds. `src/daemon/storage/client.ts:179` (`429, 500, 502, 503, 504`) and `:371-374` (`connection_error` and `timeout` are transient; a `query_error` is transient only when `status` is in that set). A 400 is not transient. What does not hold:
  - `isTransientResult` does not retry and does not enqueue. `src/daemon/storage/client.ts:371`.
  - An INSERT / unsafe-write is not retried. `src/daemon/storage/client.ts:496-497`. `query()` does not throw for a query error; it returns a `QueryResult`. `src/daemon/storage/client.ts:461-464`.
  - Capture enqueues on any non-ok append, including a genuine 400. `src/daemon/runtime/capture/capture-handler.ts:385-391`.
  - Controlled writes do match the narrower story: transient goes to the memory outbox, genuine throws. `src/daemon/runtime/pipeline/controlled-writes.ts:715-717` and `:519-521`.
- Verdict: FALSE
- Action: REVISE the discriminator paragraph so it states the status split (that part holds), then says unsafe writes are single-attempt, capture outboxes every non-ok append, and only the controlled-write path throws on a genuine error. Leave the July status histograms.

### D8. Local index entry shape omits `memoryType`

- Quote: "`id -> {Float32Array(768), content, createdAt, projectId, isDeleted}`, content stored inline"
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:57`
- Grounding: those fields exist. `src/daemon/runtime/memories/local-vector-index.ts:57-67`. The current entry also has `memoryType` (`:68-69`, comment ISS-006). Cold-build-only and "078b/c not built" still match `:39-42` and the absence of a write-through call under `src/daemon`.
- Verdict: HOLE
- Action: REVISE with one clause for `memoryType`. Leave the 078b/c open issue (it still holds).

### D9. Private storage notes never mention the Postgres transport

- Quote: "hosted Activeloop, `USING deeplake` tables over the SQL-over-HTTP transport"
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:3`. The vendor letter and the battle test likewise name only `https://api.deeplake.ai` and `HttpDeepLakeTransport`.
- Grounding: HTTP is still the non-postgres path. `src/daemon/storage/transport.ts:74-93`. A second transport is selected when the endpoint is `postgres://` or `postgresql://`: `src/daemon/storage/index.ts:207-211` constructs `PgDeepLakeTransport`. `src/daemon/storage/pg-transport.ts:1-15` says `pg_deeplake` speaks `USING deeplake`, `<#>`, and `deeplake_index` BM25 and that the transport does not rewrite SQL. The hosted-HTTP sentence is not false for the July probes. The hole is that this directory, read as the private storage set, does not name that branch. A sibling already states it: `library/knowledge/public/guides/self-hosting.md:45-58`.
- Verdict: HOLE
- Action: ADD a one-line cross-link from the findings appendix to `pg-transport.ts` and the public self-hosting guide. Do not rewrite the vendor letter into an architecture page.

### D10. Appendix transport line says "no keep-alive" as if the source disables it

- Quote: "`src/daemon/storage/transport.ts` (bare `fetch`, no keep-alive)"
- Doc: `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:143`
- Grounding: the call is a bare `fetch` with no custom dispatcher and no `keepalive: false`. `src/daemon/storage/transport.ts:83-93`. The source does not configure an agent, and it also does not turn keep-alive off. Node's global `fetch` is undici, which pools connections unless told not to. This was not re-probed live.
- Verdict: STALE
- Action: REVISE to "bare `fetch`, no custom agent". Do not claim a measured connection-reuse result.

## Claims that still hold (LEAVE)

Checked against current code. Not defects.

- Catalog has no index field. `src/daemon/storage/catalog/types.ts:80-95` (`CatalogTable` is name, columns, pattern, embeddingColumns, scope). `src/daemon/storage/schema.ts:110-114` renders `CREATE TABLE ... USING deeplake` and emits no `CREATE INDEX`. Findings `:13`.
- `<#>` score is documented as cosine, and `deeplakeCosineScore` delegates to `cosineSimilarity`. `src/daemon/storage/vector.ts:265-273` and `:308-310`. The July correction landed. Findings `:17-18`.
- Read client default concurrency 5, write client default 3, `maxConcurrency` threaded through both factories. `src/daemon/storage/client.ts:175`, `src/daemon/storage/index.ts:247-253` and `:311-315`, `src/daemon/runtime/assemble.ts:3090-3108`, `src/daemon/runtime/memories/amplification-config.ts:61`. Findings `:52`.
- `HONEYCOMB_LOCAL_ANN_INDEX` defaults on. Cold-build on boot only. 078b write-through and 078c HNSW are not in `local-vector-index.ts`. `amplification-config.ts:48`, `assemble.ts:3135-3157`, `local-vector-index.ts:39-42`. Findings `:57` and `:108`. PRD folder is still `library/requirements/in-work/prd-078-local-ann-recall-index/` with 078b/078c marked Draft in that index. That PRD status is outside this shard; the knowledge sentence matches the module.
- Capture outbox: table in `local-queue.db`, defaults 10 attempts, 24h, 10_000 active rows, drain cap 200, `dead` status, `NULL_CAPTURE_OUTBOX`, `HONEYCOMB_CAPTURE_OUTBOX`. `src/daemon/runtime/capture/capture-outbox.ts:94`, `:108`, `:115`, `:121`, `:124-126`, `:129`, `:373`. Health `deadLettered`: `src/daemon/runtime/health.ts:429`. Drain route: `src/daemon/runtime/capture/capture-drain-api.ts:75`. CLI: `src/commands/capture.ts`. Mechanism test: `tests/daemon/runtime/capture/capture-outbox-a-ac-8-mechanism.test.ts`. PRD-079 directory: `library/requirements/completed/prd-079-durable-capture-retry-queue/`. Findings `:68-91`.
- `memories` has no `org` / `workspace` columns. Scope is `agent`. `src/daemon/storage/catalog/memories.ts:45-47` and `:181-188`. Battle `:150-151`.
- Sibling links resolve: `library/knowledge/private/operations/observability-and-degradation.md`, `library/knowledge/private/ai/session-capture.md`. Findings `:72` and `:88`.
- `src/daemon/storage/config.ts:15-16` still says "Single shared connection", and `src/daemon/storage/client.ts:403` still says the daemon holds a single shared client. Those are code comments. The findings note's two-client description matches `assemble.ts:3090-3108`. Do not revise the note to match the comments.

## Counts

- Files read: 3 knowledge notes, plus the storage and runtime files cited above.
- Defects: 10 (D1-D10). Verdicts: FALSE 1, STALE 7, HOLE 2, HOLDS 0 in the defect list.
- Actions: REVISE 9, ADD 1, LEAVE 0 in the defect list. No REMOVE.
- REPORTED measurement blocks: leave all of them.
