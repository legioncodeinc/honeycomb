# Deeplake: Recall & Capture Path — Session Findings (2026-07-10)

> **Scope.** A technical record of a single deep investigation + implementation session focused on why per-turn memory recall was injecting nothing and why captures were being dropped, what we measured about the hosted Deeplake (`api.deeplake.ai`, workspace `apiary`) backend, and what we changed **on our side** (the daemon) to work around it. Includes the standing theories about Deeplake's behavior and an honest log of the diagnostic dead-ends that were disproved by measurement.
>
> **TL;DR.** Deeplake, as we use it (hosted Activeloop, `USING deeplake` tables over the SQL-over-HTTP transport), is a **versioned, append-only, columnar store with NO vector-index primitive and intermittently unstable hosted latency.** That makes it structurally slow for semantic reads (brute-force cosine scans) and unreliable for frequent writes (appends time out during backend degradation windows). We made the recall path **bounded, isolated, and fail-soft**, and added an **in-daemon local ANN index** so per-turn semantic recall no longer depends on Deeplake latency. The capture-write reliability gap (dropped memories during degraded windows) was subsequently closed by PRD-079a's **durable retry-later capture outbox** (§3.3), so a transient window no longer costs a memory.

---

## 1. What we measured about Deeplake (ground truth)

All figures are from live, read-only (plus isolated create/drop scratch-table) probes against the production `apiary` workspace, replicating the daemon's `HttpDeepLakeTransport` exactly (`POST {apiUrl}/workspaces/apiary/tables/query`, `Authorization: Bearer`, `X-Activeloop-Org-Id`).

### 1.1 Reads — no vector index; brute-force cosine scans
- **There is no ANN/vector index primitive.** `CREATE INDEX … USING vector` and `USING hnsw` are hard-rejected: `400 "access method \"vector\"/\"hnsw\" does not exist"`. `deeplake_index` exists but is **BM25/text-only** (and hangs on the embedding column). The catalog has no index concept (`catalog/types.ts`, `schema.ts:110-114`).
- Therefore the `<#>` cosine over `memories.content_embedding` (768-dim `FLOAT4[]`) is an **unavoidable brute-force full-column scan**: it re-materializes the entire embedding column each query. Measured server exec **2.4–2.6s for ~2,004 embedded rows** (4 clean runs, no warm-cache speedup — it is I/O/deserialization bound, the dot-product math is sub-ms). A metadata-only `COUNT(ARRAY_LENGTH>0)` on the same predicate is ~433ms (≈5–6× cheaper — it never reads the float payload). **Cost scales linearly with corpus size** (2k = ~2.6s; 100k ≈ ~2 min).

### 1.2 The `<#>` operator IS true cosine similarity
- Measured directly: `content_embedding <#> ARRAY[q]::float4[]` = **+dot**, and it is **scale-invariant** — `op(q) == op(2q)` byte-for-byte — proving it **normalizes both operands**. Stored `content_embedding` magnitudes are already unit (|emb| ∈ [0.9999994, 1.0000003]); the nomic-q8 query vector |q| ≈ 1.0. So `((1 + (emb <#> q))/2) == ((1 + cosine)/2)`, matching the daemon's in-memory `cosineSimilarity` (`vector.ts:137`) to ~2e-8.
- **Correction to prior belief / code comment:** a comment in `buildVectorSearchSql` called `<#>` "negative inner product in pgvector-style." That is **false** for this backend; it is positive-oriented true cosine. A "fix" toward `(1 + (−dot))/2` would silently **invert** the ranking. Corrected in `dcfdfcf`.

### 1.3 Writes — fine when warm, but eventual-consistency + degraded windows
Isolated scratch-table probes (created + dropped; no production data touched):
- **Warm steady-state appends are ~1.3–2.1s round-trip** (server exec 5–130ms), **independent of payload** — a 150KB / 30-row batch completed in 2.1s. So write cost is **not** payload-bound and **not** per-table serialized in steady state.
- **`CREATE TABLE` is expensive and variable: 9s → 12.5s → >25s (timeout)** across three runs minutes apart — direct evidence of backend flapping.
- **Eventual consistency is real:** immediately after a successful `CREATE`, `INSERT`s returned `400 "relation does not exist"` for several seconds before the table became visible. (Applies to newly-created tables; the established `sessions` table already exists, so this specific symptom does not hit captures — but it demonstrates the backend is not read-after-write consistent.)

### 1.4 The backend flaps / hibernates
- The workspace emits `deeplake.woke` — it **hibernates** and cold-wakes, during which everything blocks (cold recall observed at 40s–25min historically, matching the original BUG-17 latencies).
- Latency is **highly variable**: reads 2.3s–40s, `CREATE` 9s–>25s across the same session. This is server-side (hosted Activeloop), not our client.

### 1.5 The per-statement timeout
- `DEFAULT_QUERY_TIMEOUT_MS = 10_000` (`storage/config.ts:24`). Every statement (read or write) is bounded by 10s via an `AbortController` in `client.runAttempt`. When a degraded window pushes an append past 10s, it returns a `timeout` result.

---

## 2. Why per-turn recall was injecting nothing (the original symptom)

`injectedRefs: []` in every `~/.honeycomb/recall-sessions/<id>.json`; `request_log` showed `/api/memories/recall` p50 ≈ 40s / max ≈ 25min against the renderer's 2.5s timeout. Root causes, in order of discovery:

1. **The per-turn hot path ran the full heavy dashboard engine** (`recallMemories`): ~10–15 Deeplake round-trips per recall (IDs-then-hydrate semantic arms + dedup + rerank + lifecycle), all sharing one process-wide `Semaphore(5)` with dashboard polls and capture writes. Under Deeplake's ~1.5–4.6s/query latency + contention, this ballooned to the measured 40s+ and the 25-min tail.
2. **The shared `Semaphore(5)` was the real bottleneck.** Every Deeplake op — recall arms, capture writes, dashboard, heal — funneled through one 5-slot cap. Capture writes (and dashboard reads) starved the recall arms.
3. **Even after a "fast lane," recall could still hang** because the deadline bounded query *execution*, not the wait for a pool slot, and it returned *empty* on deadline-cut (discarding results that were already available).
4. **The semantic query itself (2.6s) exceeds the 3s per-turn budget** even uncontended — because there is no vector index. No client-side change fixes that; it requires moving vector search off Deeplake.
5. **Project-scope degradation:** a turn whose cwd is unresolvable narrows to the `__unsorted__` inbox (PRD-049b D8), which admits ~1 of ~2,004 rows.

---

## 3. What we changed on our side (the fixes)

### 3.1 PRD-077 — per-turn recall fast path (branch `feat/prd-077-per-turn-recall-fast-path`, PR #281)
- **B — capture single-attempt (`maxAttempts:1`).** Additive `QueryOptions.maxAttempts`; capture appends attempt once. (Hardening; captures were already single-attempt via the `unsafe-write` short-circuit, so this makes the fail-soft cap statement-shape-independent and closes duplicate-append risk.)
- **B2 — read/write `StorageClient` split.** The single shared client + `Semaphore(5)` was the starvation point. We now build **two** in-process clients: a **read** client (`Semaphore(5)`: recall, dashboard, heal, prime) and a dedicated **write** client (`Semaphore(3)`: capture appends only). `maxConcurrency` threaded through `createStorageClient`/`createLazyStorageClient`; `writeMaxConcurrency` knob (default 3). Writes can no longer consume read slots. Regression guard: "a saturated write client cannot starve reads."
- **A — bound `recallFast` by its deadline.** The arms run as per-arm settle-in-place slots raced against an `AbortSignal.timeout` sentinel; on deadline the recall returns whatever completed (partial), never hangs. Live-verified: `recall.timing armsMs` dropped **73,273 → 3,012**.

### 3.2 PRD-078 — local ANN recall index (branch `feat/prd-078-local-ann-recall-index`)
The core architectural response to §1.1 (no vector index): move vector search **into the daemon**.
- **078a — in-daemon `LocalVectorIndex`.** `id → {Float32Array(768), content, createdAt, projectId, isDeleted}`, **content stored inline** so the fast path needs zero Deeplake round-trips. Cold-built on boot by paging embedded `memories` (off the hot path; recall falls back to `<#>` until ready). `recallFast`'s `memories` semantic arm reads from RAM (flat cosine, sub-100ms) with the `<#>` SQL as fallback. `((1+cos)/2)` norm + 049b project scope + `ScoredId`/row shape preserved → RRF/recency byte-identical. Kill-switch flag `HONEYCOMB_LOCAL_ANN_INDEX` (default on).
- **078a-fix — partial fusion on deadline.** With the local memories arm instant but the 6 still-unindexed Deeplake arms (sessions/hive semantic + lexical) hitting the 3s deadline, A was discarding the instant local hits. Now the deadline path fuses the local-index rows + any settled arms. `annHits` added to `recall.timing`.
- **Parser DRY + observability.** `readEmbeddingCell` promoted to `vector.ts` as the single on-wire parser (shared by the rerank fetch and the cold-build). New `recall.index.built {loaded,skipped,pages,ms}` event so index population is visible (distinguishes "index empty" from "scope narrow").
- **`<#>`-parity hardening.** Named `deeplakeCosineScore` scorer as the single source of the on-wire scoring semantics; live-grounded parity test with a baked oracle; corrected the false `<#>` comment.

**Live result:** the local index returns the **identical top-5 ranking to Deeplake's `<#>`**, scores identically (both true cosine), sub-100ms, cloud-independent — the first real per-turn injection of the session. What it can return is bounded only by what is actually stored (see §5).

### 3.3 PRD-079a: durable retry-later capture queue (branch `feat/prd-079-durable-capture-retry-queue`, PR #287, v0.11.0)

The write-side twin of PRD-078: PRD-078 decoupled per-turn *reads* from Deeplake latency; this decouples *captures* from Deeplake *availability*. It is the fix §5 prescribed for the last open backend-health gap (captures dropped during degraded windows), so that gap is now closed on our side.

- **`capture_outbox`, a durable local outbox.** Instead of dropping a timed-out append, the capture path persists the failed row to a dedicated `capture_outbox` table *inside* the home-anchored `local-queue.db` (`~/.apiary/honeycomb/.daemon/`, reusing PR #285's fleet anchoring and the `local-job-queue` SQLite/trusted-root helpers, kept out of the pipeline job queue's payload guard). New subsystem in `src/daemon/runtime/capture/capture-outbox.ts` (~537 lines).
- **Enqueue-on-failure, not drop.** The `flushBatch` and immediate-path failure branches now enqueue `{row, scope}` keyed by the deterministic `makeRowId` id (`INSERT OR IGNORE`, so replay is idempotent). It never throws into the hot path, and the happy path is byte-unchanged.
- **Background drainer.** An unref'd loop re-appends via `appendOnlyInsertMany` on the dedicated **write** client (`Semaphore(3)`, PRD-077 B2, so drains can't starve recall), with bounded exponential backoff (5s base / 5min cap) and a future-row skip so a not-yet-due row never hot-loops. OK deletes the row; a non-ok result bumps `attempts` and pushes `next_attempt_at`.
- **Fail-soft and gated.** Any outbox open / enqueue / drain fault degrades to a no-op (`NULL_CAPTURE_OUTBOX`): capture is never broken and no dangling rejection can kill the daemon. The whole subsystem is behind the `HONEYCOMB_CAPTURE_OUTBOX` kill-switch (default-on).
- **Observability.** `/health` gains a `captureOutbox { pending, retrying }` block and the path emits secret-free `capture.outbox.{enqueued,drained,retry}` events (counts / durations / attempt only). Surfaced from the operator side in [`../operations/observability-and-degradation.md`](../operations/observability-and-degradation.md).

**Verification.** All 7 code ACs re-verified independently at close-out. a-AC-8 (a live degraded-window dogfood) is VERIFIED-by-mechanism: a natural Deeplake degraded window can't be induced on demand, so the end-to-end path is proven by controlled fault-injection through the real capture route (`tests/daemon/runtime/capture/capture-outbox-a-ac-8-mechanism.test.ts`: 201 ack → forced failing append → outbox `pending==1` → recover → drains to `0` with the original id). The natural-window observation is a non-blocking post-merge dogfood. Follow-on scope stays Draft: 079b (dead-letter + recovery-triggered drain) and 079c (max-backlog cap + coalescing).

---

## 4. Standing theories about Deeplake

1. **Deeplake is a versioned, append-only, columnar tensor store, not an OLTP row+vector DB.** It is optimized for large immutable dataset versions and analytical scans, not for (a) low-latency nearest-neighbor search or (b) frequent small transactional writes. Both of our hot paths (per-turn recall, per-turn capture) are exactly what it is worst at.
2. **No ANN index is a hard architectural limit, not a config gap.** The SQL-over-`USING deeplake` surface exposes only equality-lookup (marker-cached) and BM25 (`deeplake_index`). Semantic search is always O(n) brute force. This is why recall latency was fundamentally un-tunable server-side and why the local index was the only path.
3. **Hosted latency is unstable and hibernation-driven.** The workspace sleeps (`deeplake.woke`) and cold-wakes; even awake, per-op latency swings widely (reads 2.3–40s, `CREATE` 9–>25s). Writes fail specifically when a degraded window pushes an append past the 10s statement timeout. This is a hosted-backend health property, outside our client.
4. **Eventual consistency.** Read-after-write is not guaranteed (fresh `CREATE` → transient `relation does not exist`). Any client logic assuming immediate visibility of a just-written row is unsafe.
5. **The write path is fine in steady state.** Warm appends are ~2s and payload-independent; the failures are *windows*, not a constant. So the mitigation is resilience across windows (retry-later), not a rewrite of the write path.

---

## 5. Open issues / not yet addressed

- **Capture-write drops during degraded windows (ADDRESSED by PRD-079a, PR #287, §3.3).** `capture.batch_insert.failed {timeout}` clustered in the backend's bad windows (measured 103 to 251s post-boot, i.e. warm, *not* cold-boot), and on failure the batch was **dropped** (no retry), so memories captured during a degraded window were lost, which capped how good recall could be regardless of the index. This is the "recommended fix: a durable retry-later queue" that PRD-079a shipped: a failed append is now persisted to a durable `capture_outbox` in the existing `local-queue.db` and re-appended by a background drainer when the backend recovers. See §3.3. Remaining hardening (dead-letter, max-backlog cap, coalescing) is Draft as 079b / 079c.
- **Local index freshness (PRD-078b/c, drafted, not built).** 078a cold-builds on boot only. Needs write-through on new `memories`, an `updated_at` watermark pull for fleet writes, lifecycle/activation eviction, and HNSW beyond ~100k vectors/workspace.
- **State-dir bug (C).** The daemon writes `.daemon/`/`.secrets/` into `process.cwd()` when `HONEYCOMB_WORKSPACE` is unset (`assemble.ts:1950-1952`), violating ADR-0003 (neutral `~/.apiary/honeycomb/` root). This scattered state across ≥8 repo dirs and caused stale-log misreads during this investigation. Own branch/IRD.
- **Dashboard read contention (D / BUG-19).** Hive dashboard polling competes on the read client; a recall-dedicated read lane (or a saner poll cadence) is the follow-up.

---

## 6. Diagnostic corrections (theories disproved by measurement)

Recorded honestly because each cost investigation time and each was resolved by grounding rather than reasoning:

| Asserted | Reality (measured) |
|---|---|
| `/health` flooding ~73/sec, daemon overwhelmed | SQL timestamp-format bug in the probe; real cadence is **1/sec** (normal). |
| Capture-write **retry storm** (4× on timeout) starving reads | Captures were **already single-attempt** (`unsafe-write` short-circuit, `client.ts:477`, since PRD-062). Not the cause. |
| Cold-build **mis-parses** the `content_embedding` cell → index near-empty | Cell is a clean `number[768]`; parser was fine; the `annHits:1` was **project-scope degradation to `__unsorted__`** (probe omitted `cwd`). |
| Local index **scoring bug** (0.016 vs 0.875) | 0.016 was the **RRF fusion score** `1/(60+rank)`, not the cosine; 0.875 was the pre-fusion cosine. No bug — the ranking was identical to Deeplake. |
| Deeplake **serializes writes** — second append hangs | A **cold-table / eventual-consistency artifact** of a freshly-`CREATE`d table (the `CREATE` hadn't propagated). Warm appends are ~2s. Retracted. |

The durable through-line: **the real problems were backend-shaped (no vector index; flapping hosted latency), and most of our client-side "bugs" were measurement artifacts or self-inflicted (repeated daemon restarts kept the daemon perpetually cold).**

---

## 7. Strategic implication

Across this session Deeplake was shown to fail, with evidence, at all three of its jobs for this workload:
- **Reads** — no vector index → brute-force scans that worsen linearly with corpus size.
- **Writes** — flapping hosted latency → appends time out past the 10s statement bound → memories dropped.
- **Availability** — the workspace hibernates and cold-wakes (minutes-long blocks).

Our side is now well-defended on both hot paths: recall is bounded/isolated/fail-soft and runs semantic search from an in-daemon index independent of Deeplake latency, and captures survive degraded/hibernation windows via the durable outbox that drains on recovery (§3.3) rather than dropping. Those are client-side defenses against a backend that flaps; the durable answer to the write/availability side (and the removal of the local-index cache-coherence and outbox-drain burden) is a store with **native vector indexing and reliable row-level writes** (pgvector on Postgres/Neon/Supabase, or Qdrant). Deeplake would remain viable only as durable/fleet blob storage behind such a tier; used as the live query+write engine it is a poor fit for a latency-critical per-turn memory loop. This is a deliberate architecture decision for the owner; the local ANN index (D-3) is the pragmatic bridge that unblocks recall today without forcing that decision.

---

## Appendix — key code anchors

- Transport / client: `src/daemon/storage/transport.ts` (bare `fetch`, no keep-alive), `src/daemon/storage/client.ts` (`Semaphore`, `runAttempt`, `maxAttempts`, `queryTimeoutMs`), `src/daemon/storage/config.ts:24` (`DEFAULT_QUERY_TIMEOUT_MS`).
- Vector ops: `src/daemon/storage/vector.ts` (`buildVectorSearchSql`, `<#>` score norm `:242`, `cosineSimilarity` `:137`, `deeplakeCosineScore`, `readEmbeddingCell`).
- Recall engine: `src/daemon/runtime/memories/recall.ts` (`recallMemories`, `recallFast`, `fuseHits`, `runArm`, `applyRecencyActivation`, `SEMANTIC_ARMS`).
- Local index: `src/daemon/runtime/memories/local-vector-index.ts` (`InMemoryLocalVectorIndex`, `coldBuildLocalVectorIndex`, `buildMemoriesColdBuildSql`).
- Capture write: `src/daemon/runtime/capture/capture-handler.ts` (`flushBatch` → `appendOnlyInsertMany`, `capture.batch_insert.failed`, enqueue-on-failure).
- Capture outbox (PRD-079a): `src/daemon/runtime/capture/capture-outbox.ts` (`capture_outbox` table, enqueue, drainer, backoff, `NULL_CAPTURE_OUTBOX` fail-soft), wired in `capture/attach.ts` + `assemble.ts`; `/health captureOutbox` in `src/daemon/runtime/health.ts`; the shared SQLite/trusted-root helpers in `src/daemon/runtime/services/local-job-queue.ts`.
- Composition root: `src/daemon/runtime/assemble.ts` (read/write client split, cold-build wiring, `workspaceBaseDirCandidate:1950`).
- Config knobs: `src/daemon/runtime/memories/amplification-config.ts` (`recallFast*`, `recallHeavyDeadlineMs`, `writeMaxConcurrency`, `localAnnIndex`).

## Appendix — commits (this session)

- PRD-077 (PR #281): B/B2 `9340a6c` (read/write split + single-attempt), A `0e1a198` (deadline-bounded recall).
- PRD-078 (`feat/prd-078-local-ann-recall-index`): `1249f85` (078a index), `8dcdee9` (partial fusion), `1b0774f` (parser DRY + `recall.index.built`), `dcfdfcf` (`<#>` scorer + corrected comment).
- PRD-079a (`feat/prd-079-durable-capture-retry-queue`, PR #287, merged `b0713ae`, released v0.11.0): durable `capture_outbox` + background drainer + `/health captureOutbox` + `capture.outbox.*` events.
