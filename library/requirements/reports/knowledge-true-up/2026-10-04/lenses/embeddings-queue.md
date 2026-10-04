# Lens: embeddings-queue

Date: 2026-10-04. Repository: honeycomb. Read-only source and knowledge comparison. No install, no process start, no live warmup. Runtime model warmup is UNVERIFIABLE-HERE.

## What the code defaults to

Embeddings feature flag: **on**. With `HONEYCOMB_EMBEDDINGS` unset, `resolveEmbedClientOptions` enables the client. Only an explicit `false` or `0` turns it off. A saved vault setting `embeddings.enabled`, when present and readable, wins over that env default at boot.

Local job queue: **on** for an undeclared topology and for `single_machine`. `HONEYCOMB_LOCAL_QUEUE_ENABLED` unset falls through to `eligibleForDefaultOn`, which is true unless topology is `fleet` or `multi_device`. Drain of shared DeepLake local-kind rows (`HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED`) defaults **off**.

Queue file, production wiring: `<fleetRoot>/honeycomb/.daemon/local-queue.db`. Default fleet root is `~/.apiary` (`APIARY_HOME` if absolute, else `$XDG_STATE_HOME/apiary` on Linux when that variable is an absolute path). So the usual path is `~/.apiary/honeycomb/.daemon/local-queue.db`.

`--experimental-sqlite` is always passed when the CLI spawns the daemon. It is a Node flag for `node:sqlite`, not a product opt-in.

DeepLake hibernation: **on** unless `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` is exactly `false` or `0`.

## Findings

### embeddings-queue-1. Embed daemon entry, model, and dimension. VERIFIED

Source entry is `embeddings/src/index.ts`. esbuild bundles `dist/embeddings/src/index.js` to `embeddings/embed-daemon.js`. The supervisor resolves that bundle and spawns it with `node` and no extra flags.

In source: model id `nomic-ai/nomic-embed-text-v1.5`, `EMBED_DIMS` 768, quantization `q8`, revision `e9b6763023c676ca8431644204f50c2b100d9aab`. The file comment says a revision string of `v1.5` 404s at warmup. Bind defaults are `127.0.0.1` and port `3851`. Schema lock `EMBEDDING_DIMS = 768` is also in `src/daemon/storage/vector.ts`.

The embed process also has an in-memory FIFO (`EMBED_QUEUE_MAX` 32) for `/embed` requests. That queue is not SQLite and is not under the apiary root.

### embeddings-queue-2. Embeddings default on (opt-out), optional package is separate. VERIFIED

`src/daemon/runtime/services/embed-client.ts` `resolveEmbedClientOptions`: unset, `true`, or `1` enables; only `false` or `0` disables. `createEmbedSupervisor` seeds `enabled` from that function unless a caller passes `deps.enabled`. `readBootEmbeddingsEnabled` in `assemble.ts` prefers vault `embeddings.enabled`, then the env default.

`package.json` lists `@huggingface/transformers` under `optionalDependencies`. The embed module loads it only inside `warmup`. A missing optional package does not flip the flag off. Warmup failure is meant to leave recall on the lexical path. Whether a given install actually has the package and a warm model was not run.

### embeddings-queue-3. "Embeddings are opt-in" disagrees with the flag. VERIFIED

`library/knowledge/private/ai/retrieval.md` matches the code: embeddings on by default, `HONEYCOMB_EMBEDDINGS` is opt-out, model `nomic-embed-text-v1.5`, 768-dim.

`library/knowledge/private/overview.md` says embeddings, the distillation pipeline, and cross-device sharing are deliberate opt-in. That sentence bundles three different switches. The embed flag is opt-out. Pipeline stage handlers are a separate opt-in (`library/knowledge/private/ai/memory-pipeline.md`, `HONEYCOMB_PIPELINE_*`).

No file under `library/knowledge/private/ai/` states that the embed flag defaults off. Other "opt-in" lines in that folder are inbox capture, token-budget MMR, pipeline stages, and Portkey.

`AGENTS.md` calls the embed daemon opt-in because of the optional dependency and says recall falls back to BM25/ILIKE when embeddings are off. The fallback behavior matches the client contract. Calling the feature opt-in does not match `resolveEmbedClientOptions`.

### embeddings-queue-4. Model cache is still under `~/.honeycomb`, not apiary. VERIFIED

`modelCacheDir` in `embeddings/src/index.ts` returns `$HOME/.honeycomb/embed-models` unless `HONEYCOMB_EMBED_CACHE_DIR` is set. The local job queue was moved to the apiary fleet root. The embed weight cache was not. `library/ledger/EXECUTION_LEDGER-prd-025.md` still records revision `v1.5`; current source pins the commit SHA above. That ledger line is historical, not the running default.

### embeddings-queue-5. Runtime warmup. UNVERIFIABLE-HERE

`startEmbedDaemon` binds first and calls `warmup` in the background. First-run download, cache reuse, `/health.ready`, and latency were not executed. Source and comments only.

### embeddings-queue-6. Local SQLite queue path under apiary. VERIFIED

`LOCAL_QUEUE_DB_FILE_NAME` is `local-queue.db`. `localQueueDaemonDir` places it in `<baseDir>/.daemon/`. Production `assemble.ts` passes `baseDir: resolveLocalQueueBaseDir()`, which returns `honeycombStateDir()` (`src/shared/fleet-root.ts`): `join(resolveFleetRoot(), PRODUCT_SLUG)` with `PRODUCT_SLUG` `honeycomb`.

`resolveFleetRoot` order: absolute `APIARY_HOME`, else absolute `XDG_STATE_HOME` plus `apiary` on Linux, else `join(home, ".apiary")`. It does not use `process.cwd()`.

`local-job-queue.ts` still falls back to `process.cwd()` only when `baseDir` is omitted. The daemon assembly does not omit it. `library/knowledge/private/operations/local-queue-idle-cost-control.md` describes this production path (`<fleetRoot>/honeycomb/.daemon/local-queue.db`) and matches the code.

`node:sqlite` is loaded with `createRequire` of `node:sqlite`. If the open fails, `persistent` is false and the hybrid router returns the shared DeepLake queue.

### embeddings-queue-7. `--experimental-sqlite` is always on the daemon spawn. VERIFIED

`src/cli/runtime.ts` sets `DAEMON_NODE_FLAGS` to `["--experimental-sqlite"]` and the comment says Node 22 needs it for `node:sqlite` (log store) and Node 24/25 treats it as a no-op. Smoke scripts and vitest fork `execArgv` pass the same flag. The embed child spawn is `spawn(process.execPath, [entry])` and does not add this flag. The embed daemon does not use SQLite.

### embeddings-queue-8. Local queue default-on matches ADR-0009, not the operations flag table. VERIFIED

`resolveHybridJobQueueConfig` (`src/daemon/runtime/services/hybrid-job-queue.ts`): an explicit `HONEYCOMB_LOCAL_QUEUE_ENABLED` wins. Unset uses `resolveLocalQueueTopology().eligibleForDefaultOn`. Unknown and `single_machine` are eligible. `fleet` and `multi_device` are not, unless `HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN` is a truthy flag. `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED` uses a strict boolean parse that is false when unset.

Local kinds: `memory_extraction`, `memory_decision`, `memory_controlled_write`, `memory_graph_persist`, `memory_retention`, `summary`, `skillify`, `pollinating`, `source_index`, `document_ingest`. That list matches ADR-0009.

ADR-0009 (Accepted, 2026-07-05) says the local SQLite queue is the default coordination substrate and DeepLake `memory_jobs` is deprecated for pipeline coordination. Code comments and the boot warning in `assemble.ts` ("Set HONEYCOMB_LOCAL_QUEUE_ENABLED=true (the default)") agree.

`library/knowledge/private/operations/local-queue-idle-cost-control.md` "Flag posture" still says the queue ships opt-in and that every flag unset keeps the shared DeepLake queue. Its table lists `HONEYCOMB_LOCAL_QUEUE_ENABLED` default off, topology `unknown` not eligible for default-on. That table contradicts `resolveHybridJobQueueConfig` and ADR-0009. The same doc's path and kind list are otherwise aligned with the code.

### embeddings-queue-9. ADR-0006 banner and body disagree. VERIFIED

ADR-0006 opens with a banner: evolved by ADR-0009, local queue is now the default, driver is correctness (DeepLake read-after-write version collisions), idle-cost invariants still hold. The status line under that banner still says Proposed, superseded by none. The decision body still describes an interim local queue and a reversible flag, which ADR-0009 keeps as `HONEYCOMB_LOCAL_QUEUE_ENABLED=false`. The operations doc still cites ADR-0006 as locking the opt-in default. Readers who stop at the operations flag table, or at ADR-0006's status line, will think the shared queue is still the out-of-the-box path.

### embeddings-queue-10. Hibernation default matches its doc; the "future queue move" sentence does not. VERIFIED

`envHibernationConfigProvider` enables hibernation unless `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` is `false` or `0`. Idle default in that module's doc comment and in `library/knowledge/private/operations/deeplake-idle-hibernation.md` is 120000 ms. The flag table in that doc matches the provider.

The same hibernation doc's closing section still says moving the job queue off DeepLake, so idle means zero coordination reads by construction, is a separate future PRD. ADR-0009 and `createHybridJobQueueService` already route the pipeline kinds to local SQLite by default. Hibernation remains a second, still-default-on pause of DeepLake-touching timers. Those two mechanisms are both in the tree. The "future PRD" sentence is stale.

### embeddings-queue-11. Two queues, do not merge them. VERIFIED

The apiary SQLite file schedules daemon jobs (`local_job`, plus capture and memory outbox tables in the same file per their module comments). The embed daemon's queue is a process-local FIFO of inference requests, cap 32, shed with HTTP 503. Docs that say "the local queue" mean the SQLite job queue. They do not describe the embed FIFO.

## Doc contradiction summary

| Claim | Where | Code |
|---|---|---|
| Embeddings opt-in | `overview.md`, `AGENTS.md` | Flag default on; package optional |
| Embeddings default on, opt-out | `ai/retrieval.md` | Matches `resolveEmbedClientOptions` |
| Local queue default off, unknown topology not eligible | `operations/local-queue-idle-cost-control.md` flag table | Default on for unknown and single_machine |
| Local queue is the default | ADR-0009 and the ADR-0006 banner | Matches hybrid config |
| Moving jobs off DeepLake is a future PRD | `deeplake-idle-hibernation.md` close | Already default for pipeline kinds |
| Hibernation default on | same hibernation doc flag table | Matches `envHibernationConfigProvider` |
| Queue path under fleet root honeycomb `.daemon/local-queue.db` | local-queue operations doc | Matches `resolveLocalQueueBaseDir` |
