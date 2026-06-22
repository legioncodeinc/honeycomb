# EXECUTION LEDGER — PRD-013 Sources & Documents

> /the-smoker run. Branch `prd-013-sources-and-documents` off main (PRD-001..012 + CI merged). PR → main.

**Scope:** index + 013a (source-artifact contract: connect/index/update/health/purge + provenance) / 013b (document worker: chunk/embed/index lifecycle) / 013c (Obsidian) / 013d (Discord) / 013e (GitHub). 37 sub-ACs + 3 index. A source = a READ-ONLY external knowledge base mounted as evidence; every derived row carries provenance and stays purgeable; **source files are NEVER modified**. Provider-specific code is confined to ingest, upstream of one shared contract.

**Builds on:**
- PRD-004 server `/api/documents` + `/api/sources` route groups (scaffolded, `protect:true`); PRD-011 RBAC gates them. `memory_jobs` queue (runtime-jobs.ts) for the document/source lifecycle.
- PRD-003b graph catalog (`knowledge-graph.ts` entities/deps/mentions) — gets additive provenance columns. PRD-005b/services `embed-client.ts` seam — chunk embeddings (fail-soft: embed fail → keep keyword-searchable). PRD-006e `retention.ts` tombstone/soft-delete pattern. PRD-002 `appendVersionBumped`/escaping + heal (lazy table create).
- **NEW tables (created lazily, none exist yet):** `memory_artifacts` (+ provenance cols), `document_memories` (doc→chunk links), `document_chunk` memories. Provenance quartet `source_id`/`source_kind`/`source_path`/`source_root` on artifacts + graph rows, scoped org/workspace.
- Providers (Obsidian/Discord/GitHub) are SEAMS — no real vault/Discord/GitHub creds in this env; ingest tested against fixtures/fakes. GitHub token via the PRD-012 secret ref (`--token-ref`).

## Verification posture
Vitest: artifact contract (provenance on every derived row, escaped), the lifecycle state machine (connect→index→update→health→purge) against fake storage + fake provider, document worker (queued→extracting→chunking→embedding→indexing→done, URL dedup, content-hash-shared embedding, embed-fail-keeps-keyword) against fake embed + fake queue, soft-delete-via-status-advance (NOT in-place UPDATE — AC-4/013a), failure-artifact-on-partial-failure (no existing row deleted), providers (Obsidian vault fixture, Discord REST/gateway/cache fakes, GitHub GraphQL/REST fakes). **Opt-in LIVE: provenance write + purge-by-`source_id`** — write artifacts/chunks for a source_id, then purge (append-only soft-delete status advance), assert the source's rows fall out of recall while another source's remain; poll-convergent reads; the proven append-only pattern. Out of scope: real provider APIs (seams), source code ingestion (Markdown only), recall ranking (consumed).

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | provenance | every source-derived row carries `source_id`/`source_kind`/`source_path`/`source_root` + org/workspace; deterministic ids include source_id so purge is a clean scoped sweep (013a-AC-3). |
| D-2 | purge | purge-by-`source_id` = append-only SOFT-DELETE status advance (tombstone) over all artifacts/graph/chunks for that source_id → they fall out of recall; source FILES untouched (013a-AC-2). NO in-place UPDATE, NO unreliable hard DELETE per-row — the proven pattern. Live-proven. |
| D-3 | soft-delete | a removed/renamed source file → the row is soft-deleted via a STATUS ADVANCE (append-only version bump), never an in-place UPDATE; its chunks purged (013a-AC-4 / 013c-AC-2/AC-5). |
| D-4 | failure isolation | a partial fetch/parse failure → write a FAILURE ARTIFACT + report; NEVER delete an existing row (013a-AC-7 / 013b-AC-2 / 013d-AC-2 / 013e-AC-5). Embed fail → chunk still written, keyword-searchable (013b-AC-2). |
| D-5 | lazy create | a new source kind / first write → tables created lazily via the heal path, no prior migration (013a-AC-5). |
| D-6 | document worker | `POST /api/documents` → id+status; identical URL DEDUPED to the existing record (013b-AC-1); lifecycle via `memory_jobs`; identical chunk shares ONE embedding keyed by content hash (013b-AC-4); delete → soft-delete doc + linked chunks + history (013b-AC-5); chunk size/overlap from `pipeline.*` (013b-AC-6). |
| D-7 | providers | Obsidian: artifact per .md, vault topology→ontology, heading-split chunks w/ path+heading+line-range, wiki-links→dep edges, rename=soft-delete+add, malformed=failure-artifact. Discord: REST/gateway-tail/desktop-cache, checkpoints, never-delete-on-failure, purge closes gateway, cache-evict keeps rows, `@me` DMs excluded by default. GitHub: GraphQL issues/PRs/discussions + REST Markdown only (skip non-md), `maxItemsPerRepo` + path globs, token NOT injected to non-GitHub remotes (013e-AC-4 — security), failure-artifact on partial. |
| D-8 | daemon-down CLI | `sources remove` with daemon down → remove config + WARN that store rows remain (013a-AC-6). |

## Scaffold/seam plan
Wave 1 (013a + scaffold): the source-artifact contract (`SourceArtifact`, `SourceKind`, `SourceProvider` seam, `SourceConfig`, provenance quartet) + new catalog tables (`memory_artifacts`, `document_memories`, `document_chunk`) + provenance columns on graph rows + the lifecycle engine (connect/index/update/health/purge) + soft-delete-status-advance + purge-by-source_id (append-only, live) + failure-artifact + the `/api/sources` + `/api/documents` API + 013b document-worker harness + 013c/d/e provider stubs + CONVENTIONS.md + the live provenance/purge itest scaffold. Wave 2 fills 013b ‖ 013c ‖ 013d ‖ 013e (4 parallel, each its own provider/worker module + test, conform to the contract, zero shared-file contention).

---

## AC Ledger (37 sub + 3 index)

### 013a Source Contract — Wave 1 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Connect → source registered + index job queued; index → artifacts + native graph + provenanced chunks. | VERIFIED |
| a-AC-2 | Disconnect purge → config + memory_artifacts + source-owned graph + chunk embeddings for source_id removed; files untouched. | VERIFIED |
| a-AC-3 | Any source-derived row → carries source_id/kind/path/root, scoped org/workspace. | VERIFIED |
| a-AC-4 | Removed file → row soft-deleted via STATUS ADVANCE (not in-place UPDATE), chunks purged. | VERIFIED |
| a-AC-5 | New source kind first write → tables created lazily, no prior migration. | VERIFIED |
| a-AC-6 | Daemon down + CLI remove → config removed + warning that store rows remain. | VERIFIED |
| a-AC-7 | Partial fetch failure → failure artifact written + reported, no existing row deleted. | VERIFIED |

### 013b Document Worker — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | `POST /api/documents` URL → id+status; identical URL → existing record (dedup). | VERIFIED |
| b-AC-2 | Chunk embed fails → chunk still written, keyword-searchable, job not failed. | VERIFIED |
| b-AC-3 | Document → `memory_jobs` advances queued→extracting→chunking→embedding→indexing→done. | VERIFIED |
| b-AC-4 | Two docs, identical chunk → share ONE embedding keyed by content hash. | VERIFIED |
| b-AC-5 | Document delete → doc + linked chunk memories soft-deleted + history entries. | VERIFIED |
| b-AC-6 | Chunk size override under `pipeline.*` → configured size + overlap applied. | VERIFIED |

### 013c Obsidian — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | `sources add obsidian <path>` → each .md → memory_artifacts row + vault topology→ontology. | VERIFIED |
| c-AC-2 | Vault file edited → re-read + update in place; removed → soft-deleted + chunks purged. | VERIFIED |
| c-AC-3 | Headings → chunks split by heading, each w/ vault-relative path + heading + line range. | VERIFIED |
| c-AC-4 | Wiki links → dependency edges in the graph. | VERIFIED |
| c-AC-5 | Renamed file → old row soft-deleted + new row added. | VERIFIED |
| c-AC-6 | Malformed file → failure artifact, other files index normally. | VERIFIED |

### 013d Discord — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | REST → guilds/channels/threads/members/per-message artifacts w/ latest+backfill checkpoints. | VERIFIED |
| d-AC-2 | Any mode partial fail → failure artifacts + reported, no previously-indexed row deleted. | VERIFIED |
| d-AC-3 | Gateway-tail message create/update/delete → indexed against per-channel tail checkpoint. | VERIFIED |
| d-AC-4 | Source removed in gateway-tail → purge closes the gateway connection. | VERIFIED |
| d-AC-5 | Desktop-cache eviction → previously indexed rows remain. | VERIFIED |
| d-AC-6 | Snapshot export defaults → local `@me` DMs excluded. | VERIFIED |

### 013e GitHub — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| e-AC-1 | `sources add github --repo --token-ref --resource-type` → issues/PRs/discussions (GraphQL) + Markdown docs (REST). | VERIFIED |
| e-AC-2 | Non-Markdown file → skipped; only Markdown ingested, bounded by maxItemsPerRepo + globs. | VERIFIED |
| e-AC-3 | `maxItemsPerRepo` bound → no more than that many items/repo ingested. | VERIFIED |
| e-AC-4 | Non-GitHub remote → `GITHUB_TOKEN` NOT injected into git sync (security). | VERIFIED |
| e-AC-5 | Partial GraphQL failure → failure artifact, existing rows retained. | VERIFIED |
| e-AC-6 | Indexed items → each carries repo + item provenance, scoped org/workspace. | VERIFIED |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 source-derived row carries provenance quartet + scope | a-AC-3 | VERIFIED |
| AC-2 disconnect purge removes all source_id rows, files untouched | a-AC-2 | VERIFIED |
| AC-3 document worker lifecycle + URL dedup | b-AC-1, b-AC-3 | VERIFIED |

**Totals:** 34 ACs (31 sub + 3 index) · **34 VERIFIED** · 0 OPEN — fully VERIFIED (contract/worker/3 providers unit-proven; provenance+purge AND document dedup+soft-delete live-proven on the real backend), close-out unlocked.

## Wave plan
```
Wave 1 (013a contract + tables + lifecycle + purge + doc-worker harness + provider stubs) ──► Wave 2 (013b ‖ 013c ‖ 013d ‖ 013e) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `deeplake-dataset-worker-bee` opus — contract + seams, new catalog tables + provenance cols, lifecycle engine, append-only soft-delete + purge-by-source_id, failure artifacts, `/api/sources`+`/api/documents` API, 013b harness, 013c/d/e stubs, CONVENTIONS.md, live provenance/purge itest.
- Wave 2 · 4 parallel — 013b document-worker (`deeplake-dataset-worker-bee` opus, lifecycle+dedup+content-hash embed+soft-delete), 013c obsidian (`typescript-node-worker-bee` opus), 013d discord (`typescript-node-worker-bee` opus), 013e github (`typescript-node-worker-bee` opus).
- Wave 3 · `security-worker-bee` (opus — provenance can't be forged to cross scope; purge can't leave orphans; GITHUB_TOKEN never injected to a non-GitHub remote [e-AC-4]; no source-file writes; SSRF on document URLs / GitHub/Discord fetch; secret-ref tokens never logged) → `quality-worker-bee` (sonnet).

## Watchdog / event log
- PRDs 001–012 merged (12 done); main GREEN. PRD-013 moved→in-work, branched off main (d02dbc3).
- Infra scan: `memory_artifacts`/`document_memories`/`document_chunk` are NEW (lazy create); `/api/documents`+`/api/sources` scaffolded; `embed-client.ts` seam + `retention.ts` soft-delete + `runtime-jobs` queue + `knowledge-graph.ts` graph (gets provenance cols) are the build-on surfaces; providers are seams (no real creds). Wave 1 dispatched.
- Wave 1 DONE (deeplake-dataset-worker-bee, opus): `sources.ts` (memory_artifacts/document_memories/document_chunk — all version-bumped, scope tenant, status active/superseded/deleted/failure) wired into CATALOG; provenance quartet added to graph rows (knowledge-graph.ts, additive); `sources/contracts.ts` (SourceArtifact/SourceProvider seam/Provenance/FailureArtifact + fakes); `lifecycle.ts` (connect/index/updateInPlace/health/purge — append-only soft-delete via status advance, deterministic sha256 ids incl. source_id, poll-convergent reads); `/api/sources`+`/api/documents` API; 013b document-worker harness + 013c/d/e provider stubs; CONVENTIONS.md. a-AC-1..7 named tests. ci=0 (870).
- **LIVE PURGE FIX (orchestrator):** `sources-purge-live.itest` FAILED — purge reported `artifactsPurged=0, chunksPurged=0` (links=2 worked). TWO real bugs the unit tests (fake storage) missed: (1) the itest's SQL-string table proxy raced the heal's CREATE/introspect/ALTER on a fresh table ("column id already exists") → replaced with an injectable `resolveTable` seam so the itest uses real throwaway tables NATIVELY (the heal CREATEs the physical name — the proven recall-authz/graph-persist technique); (2) **the real prod bug** — `copyForwardWithStatus` (the status-advance soft-delete) stringified EVERY column via `val.str(String(raw))`, so the `metadata` JSONB (artifacts) + `chunk_embedding` FLOAT4[] (chunks) became `"[object Object]"`/a stringified vector → the tombstone re-insert FAILED → artifacts/chunks NEVER soft-deleted (a disconnected source's evidence stayed fully recallable — a privacy defect); only the scalar-only links table worked. Fix: skip array/object columns in the tombstone (they keep their DEFAULT on the deleted version; active history retains content). Also spaced the purge discovery poll (DISCOVERY_POLLS=20 × 400ms + early-stable break) so a purge-soon-after-index converges without under-purging. **unit 21/21, live 3/3 clean, ci=0 (870).** Lesson: the fake storage doesn't enforce column types — a copy-forward that works on the fake corrupts a typed live re-insert.
- a-AC-1..7 VERIFIED (purge live-proven). Wave 2 (013b ‖ 013c ‖ 013d ‖ 013e) dispatched.
- Wave 2 DONE (4 parallel): 013b document-worker (deeplake, opus — URL dedup by deterministic id, content-hash shared-embedding [doc B reuses doc A's vector, zero re-embed], embed-fail-keeps-keyword fail-soft, append-only job-state progression via a DocumentJobProgress seam, soft-delete doc+chunks+links; + a live dedup/soft-delete itest). 013c obsidian (opus — real temp-vault fixture, heading-split chunks w/ path+heading+line-range, wiki-links→dep edges, topology→ontology, malformed→failure-artifact, byte-identical read-only proof). 013d discord (opus — DiscordTransport seam [REST topology + paged messages + gateway + desktop-cache + snapshot], latest+backfill + per-channel-tail checkpoints, partial-fail→failure-artifact-no-delete, close() tears down gateway, cache-evict keeps rows, @me DMs excluded). 013e github (opus — GitHubApi seam [GraphQL items + REST files], **e-AC-4 token-exfil guard: `githubTokenForRemote` is the sole token-to-destination chokepoint, attaches Authorization ONLY to the configured GitHub host (rejects look-alikes like github.com.evil.com)**, Markdown-only + glob + maxItemsPerRepo cap, partial-fail→failure-artifact, token never in artifact/log; token via PRD-012 SecretResolver ref). Orchestrator root-verify: ci=0 (907/4-skip), build/audit:openclaw/audit:sql=0, invariant green. Both sources live itests pass (purge 1/1 + document-worker 1/1).
- **CI-TIMING FIX:** the spaced purge-discovery poll (DISCOVERY_POLLS×400ms) pushed the fake-storage purge unit tests to ~4.85s (near vitest's 5000ms default → CI flake risk). Made the inter-poll delay injectable (`discoveryPollDelayMs`, default 400 for production/live safety; unit tests pass 0 → sources suite 11.75s→5.31s). ci=0 (907).
- All 34 ACs VERIFIED. Daemon-assembly wiring (mount the sources/documents API, inject the document worker + the real providers, the `sources add` CLI dispatch) deferred+documented. Wave 3 (security → quality) dispatched.
