# Source Provenance and Transplant Map

> Category: Report | Version: 1.0 | Date: June 2026 | Status: Active

The bridge between the Honeycomb PRDs and the code that already exists. For every module it says what to reuse, what to adapt, what to treat as a reference, and what is net-new, so an implementer knows where to start instead of writing from scratch.

**Related:**
- [`../backlog/README.md`](../backlog/README.md)
- [`../../knowledge/private/data/deeplake-storage.md`](../../knowledge/private/data/deeplake-storage.md)
- [`../../knowledge/private/architecture/system-overview.md`](../../knowledge/private/architecture/system-overview.md)

---

## Source locations (verified June 17 2026)

| Source | Path | What is actually on disk |
|---|---|---|
| otherhive engine | `C:\Users\mario\GitHub\honeycomb\otherhive-v1\` | Full source. `platform/core` (78 migrations, ingest, fts), `platform/daemon` (HTTP, pipeline, workers, auth, MCP), `platform/daemon-rs` (Rust parity), `platform/native`, `surfaces/*`, `integrations/*`, `libs/*`, `plugins/core/secrets`. |
| hivemind product | `C:\Users\mario\GitHub\hivemind\` | Full source. `src/` has `deeplake-api.ts`, `deeplake-schema.ts`, `embeddings/`, `graph/` (extract, render, push/pull, vfs), `hooks/`, `notifications/`, `dashboard/`, `cli/`, `commands/`; plus `harnesses/*`, `embeddings/embed-daemon.js`, `esbuild.config.mjs`. |
| hivemind mirror | `C:\Users\mario\GitHub\honeycomb\hivemind-v1\` | Partial mirror: library, harness shells, a stray `src/deeplake-api.ts`. Do NOT treat as the hivemind source of truth. Use `C:\Users\mario\GitHub\hivemind\`. |

## The core finding

otherhive is a SQLite monolith. `withWriteTx` appears 418 times across 114 files; the engine's atomicity is welded to SQLite transactions that DeepLake does not provide. Porting it wholesale means rewriting transaction boundaries everywhere (memory-routes 22, repair-actions 17, knowledge-graph 15, document-worker 13, worker 12, summary-worker 12, and ~100 more).

hivemind is already DeepLake-native. Its `deeplake-api.ts` client, `deeplake-schema.ts`, append-only and SELECT-before-INSERT write patterns, schema healing, embeddings, codebase graph, and VFS are all built for DeepLake's quirks (no parameterized queries, the UPDATE-coalescing trade-off).

## Strategy

Foundation from hivemind, intelligence from otherhive, with as little otherhive code carried as possible.

- Use hivemind's DeepLake-native code as the substrate and product layer: storage client, schema patterns, embeddings, codebase graph, VFS, skillify, notifications, dashboard, capture hooks, CLI.
- Reimplement otherhive's memory engine DeepLake-native, using otherhive's source as the algorithm reference, not as code to port: the pipeline, hybrid retrieval and ranking, the knowledge-graph ontology and supersession, the pollinating loop, the model and provider router, and agent scoping.
- The daemon is mostly net-new. hivemind is hooks-direct with no daemon; otherhive's daemon is SQLite-coupled. Build a daemon shell that wraps hivemind's `deeplake-api` as the only client and hosts the reimplemented engine and workers, using otherhive's daemon structure as a reference.

Classification legend: **reuse** (lift with light edits), **adapt** (lift and modify), **reference** (read for design, write fresh), **net-new** (no direct source).

## Per-module map

| PRD | Module | hivemind source | otherhive source | Classification |
|---|---|---|---|---|
| 001 | monorepo-foundation | `esbuild.config.mjs`, harness build | `repo.map.yaml`, package layout | adapt + net-new layout |
| 002 | deeplake-storage-adapter | `src/deeplake-api.ts`, `deeplake-schema.ts`, `embeddings/sql.ts`, `graph/deeplake-push|pull.ts` | none (SQLite, discard) | reuse / adapt hivemind |
| 003 | core-data-model | `deeplake-schema.ts` column-def pattern | `platform/core/src/migrations/*` (schema shape) | net-new defs, reference otherhive |
| 004 | daemon-runtime | none (hooks-direct) | `platform/daemon/src` routes, job queue, watcher | net-new + reference otherhive |
| 005 | capture-intake | `src/hooks/*` (capture, session-*, pre-tool-use), `embeddings/client.ts` | `ai/session-capture` design | adapt hivemind |
| 006 | memory-pipeline | none | `platform/daemon/src/pipeline/*` (extraction, decision, worker, retention) | reimplement, reference otherhive |
| 007 | retrieval | `embeddings/*` vector path, `graph/vfs-handler` | `memory-search.ts`, ranking, dampening | reimplement (reference otherhive) + reuse hivemind vectors |
| 008 | knowledge-graph-ontology | none (codebase graph is different) | `knowledge-graph.ts`, `ontology-*.ts`, `pipeline/supersession.ts` | reimplement, reference otherhive |
| 009 | pollinating-loop | none | `pipeline/pollinating*.ts` | reimplement, reference otherhive |
| 010 | model-provider-router | host-CLI gate pattern in `hooks/*/wiki-worker` | `inference-router` and model catalog | reimplement, reference otherhive |
| 011 | tenancy-and-auth | `commands/auth-*`, org header in `deeplake-api`, credential file | `auth/api-keys.ts`, modes/RBAC, agent scope clause | adapt both, reimplement scope on DeepLake |
| 012 | secrets | none | `plugins/core/secrets`, daemon secrets routes | reimplement, reference otherhive |
| 013 | sources-and-documents | ingest helpers | `ingest/*` parsers (reuse), source providers + document worker | reuse otherhive parsers + reimplement lifecycle |
| 014 | codebase-graph | `src/graph/*` (extract, render, push/pull, snapshot) | none | reuse / adapt hivemind |
| 015 | virtual-filesystem | `graph/vfs-handler.ts`, deeplake-fs, `hooks/pre-tool-use.ts`, goal-paths | none | reuse / adapt hivemind |
| 016 | skillify | `src/skillify/*`, `cli/skillify-spec.ts` | none | reuse / adapt hivemind |
| 017 | wiki-summaries | `hooks/*/wiki-worker.ts`, `spawn-wiki-worker` | `pipeline/summary-worker.ts`, synthesis | adapt hivemind + reference otherhive |
| 018 | team-skill-sharing | skillify pull, symlink fan-out, collaboration | none | reuse / adapt hivemind |
| 019 | harness-integrations | `harnesses/*`, `src/hooks/{codex,cursor,hermes,pi}` | `integrations/*`, `libs/connector-base`, `libs/sdk` | reuse / adapt both |
| 020 | surfaces | `src/cli`, `src/commands`, `src/dashboard`, `src/notifications` | `surfaces/cli`, `surfaces/dashboard` | adapt both + net-new cursor ext |

## Reuse vs reimplement at a glance

Direct DeepLake-native reuse or adapt from hivemind: 002, 014, 015, 016, 018, plus large parts of 005, 011, 019, 020. This is where the code already exists and works on DeepLake.

Reimplement from otherhive as reference (the memory intelligence): 006, 007, 008, 009, 010, 012, and the source lifecycle half of 013. These are otherhive's strength and the reason for the merge, but they ride on SQLite transactions and must be rewritten on the storage adapter, not ported.

Net-new shell: 004 (the daemon) and the unified monorepo in 001.

Pure-logic reuse from otherhive (low coupling, safe to lift): the `platform/core/src/ingest/*` parsers (chat, discord, slack, markdown, pdf, code, git) used by 013.

## Risks and notes

The transaction rewrite is the single biggest risk and lands in 006, 007, 008. Treat otherhive's `withWriteTx` closures as design notes for what must be atomic, then express that atomicity with the DeepLake patterns (append-only version bumps, SELECT-before-INSERT, content-hash dedup) from 002.

The daemon does not exist in either codebase in the form Honeycomb needs. 004 is genuinely net-new and is on the critical path right behind 002 and 003.

`platform/daemon-rs` (Rust parity) and `platform/native` (vector accel) are out of scope for the first build; note them and move on.

## What this unblocks

With sources located and mapped, the remaining prep before coding is: assemble the monorepo by bringing the reuse and adapt files into the Honeycomb tree (per 001), and write IRDs for the reimplement-heavy modules (006, 007, 008) that bind each otherhive reference to its DeepLake-native target. After that, an implementer can work module by module against the PRDs with a known starting point for each.
