# Standing report, 2026-10-04

Branch `legion/kb-sotu-and-prd-lifecycle`, parent `756bacb`. This file records the doc commit that follows. Product source, tests, and bundles were not edited. `library/notes/` was not edited. Claims below are the code reports in `library/requirements/reports/2026-10-04-kb-prd-standing/code/` and the git reports in `library/requirements/reports/2026-10-04-kb-prd-standing/git/`, checked against `git status` on this working tree. Moves that a report did not confirm are not in this commit.

## What changed

### Knowledge revisions

68 tracked files under `library/knowledge/private/` are dirty, plus the new ADR below. Writers applied rows a code report marked confirmed. Pages were corrected in place. No private page was deleted.

| Area | Files | What the confirmed rows correct |
|---|---|---|
| `ai/` | 18 | Capture omits the embed from the insert and kicks it after. Skillify default is 10 turns, and session-end enqueues summary, not skillify. Retrieval, hybrid-benchmark numbers, lifecycle scoring (PRD-058, not PRD-055), and the pipeline caps match the live code. |
| `architecture/` | 14 | Narratives plus the ADR status lines. `load-bearing-boundaries.md` is in the dirty set. |
| `auth/`, `multi-tenant/`, `security/`, `standards/` | 7 | Role name is `member`, not `operator`. Scope, secrets, and trust sentences follow the mounted routes. |
| `data/`, `storage/` | 7 | Schema and storage sentences, including the sessions prune that tombstones the paired summary. |
| `frontend/`, `dashboard/` | 5 | Hive owns the browser UI on port 3853. This repo keeps `/api/*` and has no `src/dashboard/web/` SPA. |
| `integrations/` | 3 | MCP production entry is stdio. The daemon `/mcp` group is an empty scaffold that returns 501. |
| `operations/` | 9 | CLI dispatch, install handoff to the hosted script, local-queue default, doctor package location, telemetry, and ROI. |
| `overview.md` | 1 | Embeddings default on unless `HONEYCOMB_EMBEDDINGS` is `false` or `0`. An undeclared or `single_machine` install defaults the local SQLite queue on. |
| `collaboration/`, `infrastructure/`, `sources/` | 4 | Asset sync, release/version sync, and source CLI routes. |

`overview.md` still labels Deep Lake as GPU-backed in the merger paragraph, the mermaid node, and the key-components table. The embeddings code report overturned deleting those labels. The substrate paragraph already says hosted GPU use was not re-probed and names the loopback embedder on port 3851.

`retrieval.md` does not link `prior-art-owls-roost-crosswalk.md`. The recall code report confirmed a three-tier backlink and overturned adding the prior-art backlink, because that page does not point at retrieval.

### ADR-0012

New file: `library/knowledge/private/architecture/adr/0012-mcp-stdio-child-and-daemon-scaffold.md`.

Status: Accepted, 2026-10-04. The git product log marked this the only candidate (`git/decisions-product.md`, section 5). Locking commit `c3b587db0dd84cc2891da6f7bc763d1b972001f1` (2026-06-20). Decision: a harness speaks MCP by spawning `node mcp/bundle/server.js` over stdio; `serveHttp` defaults to false and binds loopback only when set; the daemon `/mcp` group stays a protected scaffold and returns 501. PRD-019 stays in-work. The ADR is not a reason to complete that folder.

The README index adds the 0012 row.

### ADR status lines

Bodies of already accepted ADRs were not reopened. Status lines and the README table only:

- ADR-0002, ADR-0003, ADR-0005: Superseded by the queen copies (relocated 2026-07-03).
- ADR-0004: Superseded by queen ADR-0004 (relocated 2026-07-03); queen runtime topology later superseded by queen ADR-0010.
- ADR-0006: Accepted (evolved by ADR-0009). The body, including the "not superseded" clause, stays.
- ADR-0010: Proposed. The corpus-length proxy is still the live savings path in `src/daemon/runtime/dashboard/api.ts`. Accepted would claim that retirement already shipped.
- ADR-0011 stays Proposed. No body edit.

No local ANN ADR. The architecture git log rejected one (`git/decisions-architecture.md`). The why is already in PRD-078 and `ai/retrieval.md`. No embeddings ADR. The same log rejected one because PRD-025 D-1 already records default-on. ADR-0009 was not duplicated. The local-queue code report says the same.

### Status-line edits that landed

- The 13 folders moved from `completed/` to `in-work/` have index status In Work.
- PRD-051, PRD-052, PRD-054, and PRD-055 indexes say Archived, above the existing MOVED stub.
- PRD-066 index, 066a through 066f, the upgrade support notes, and the release-notes draft now say In Work. The index Related line cites ADR-0009. 066e AC-8 and AC-9 were rewritten to the ADR-0009 rule: undeclared or `single_machine` defaults the local queue on; declared `fleet` or `multi_device` stays on the shared queue unless it opts in.
- PRD-077 stays in `completed/`. Index status is Completed. The sub-PRD table and 077a and 077b status lines are Completed. They were Backlog and Draft.

### Status lines a code report asked for that this tree left alone

These were confirmed edits and were not applied. A later pass can fix the line without moving the folder:

- PRD-078 index still says Backlog (in-work, Phase 1 dispatched).
- PRD-037, PRD-038, PRD-040, PRD-043, and PRD-044 indexes still say Backlog while the folders stay in `completed/`.
- PRD-064 index still says Backlog while the folder stays in `in-work/`.
- PRD-065 index still says In Work while the folder stays in `completed/`.
- PRD-073 index still says Backlog while the folder stays in `completed/`.
- PRD-076a, PRD-076b, and PRD-076c still say Draft. The 076 index already says Completed.

### PRD moves

Completed to in-work. Each move has a still-required criterion the code report found absent:

| PRD | Why it left completed |
|---|---|
| 006 | 006d AC-5: graph persist stamps `agent_id` from the workspace, not the job agent. |
| 008 | 008a AC-3: attribute rows drop proposal provenance. No `proposal_id` column. |
| 009 | Compaction mode is ignored, the counter subtracts instead of resetting to zero, identity files stay empty, graph tools have no caller, and `entity.merge` is queued rather than applied. |
| 010 | `mountInferenceGateway` exists and production assembly never mounts it, so `/v1` hits the 501 scaffold. |
| 011 | Scope clause is unused by memory recall, dispatched `status` does not print tenancy, and API-key create, revoke, and rate limit are unwired. |
| 012 | Assembly omits `execRunner`, so secret exec, Bitwarden, and 1Password routes are 501 stubs. |
| 013 | Daemon-down CLI remove does not warn that store rows remain. |
| 016 | Live trigger is a modulo of 10. `evaluateTrigger` has no production caller. Session-end does not enqueue skillify. |
| 029 | The lexical-fallback badge on the dashboard recall bar is absent. Daemon `degraded` can stay met inside this folder. |
| 032 | Settings does not load or write vault provider, model, and pollinating. |
| 035 | `src/dashboard/views.ts` still paints Sessions. The contract already says Turns. |
| 039 | Hermes and OpenClaw capability flags (`mcpRegistration`, `contractedTools`) are empty objects. Page absence is not the reason. |
| 042 | The sync list union never assigns `pulled`. A pull action can return that state, and the next list read labels the row `shared`. |

Backlog to archive. Each folder is a MOVED stub with no honeycomb implementation (`code/auth-secrets.md`):

- PRD-051 repository health and knowledge drift (Hive PRD-015, still Backlog there).
- PRD-052 join repository to Hive (Hive PRD-016, still Backlog there).
- PRD-054 fleet observation control plane (Queen PRD-007, still Backlog there).
- PRD-055 fleet control enrollment and mint authority (Queen PRD-008, still Backlog there).

Not moved, and not a miss against the confirmed list:

- PRD-059 and PRD-061 stay in `backlog/`. `code/daemon-runtime.md` says they were not judged. No code report confirmed archive.
- PRD-053, PRD-056, and PRD-057 stay in `backlog/`. The auth shard said they were outside its archive confirm.
- PRD-081 stays in `backlog/`. `code/daemon-runtime.md` confirmed that stay.
- PRD-067, PRD-068, PRD-069, and PRD-070 stay in `archive/`.
- PRD-077 stays in `completed/`.

### Reports in this commit

- `library/requirements/reports/2026-10-04-kb-prd-standing/` (knowledge shards, PRD shards, code standing, git decision logs, and this file).
- `library/requirements/reports/knowledge-true-up/` stays as the earlier input. It is not the master record.

## What stayed unmet

PRDs left in `in-work/` and why. The first 13 were moved by this pass. The last six were already in `in-work/` and a code report said to leave them there.

- PRD-006, 008, 009, 010, 011, 012, 013, 016, 029, 032, 035, 039, 042: the absences in the move table above.
- PRD-019: three connectors are wired (Claude Code, Codex, Cursor). Still absent: the wider harness install set, hook shims for Hermes, pi, and OpenClaw from the harness entries, MCP `secret_exec` redaction, graph tools gated off `graphBuilt` (production never sets it), and `session_search` removed from the tool list. 019e being met does not complete the parent. ADR-0012 does not complete it either.
- PRD-020: dispatched `status` prints service and `/health` and does not call `health.evaluate()`. Live session-start heal is an empty function, and the runtime healer refuses a real `api.deeplake.ai` credential. The credential write target is `~/.deeplake/credentials.json`, with `.honeycomb` as a read-only legacy fallback.
- PRD-058: recency, conflict projection, and the reverify tick run. Confirmed-useful reinforcement, confidence-exponent ranking, operator reversal, and the lifecycle health panel are absent.
- PRD-064: the honeycomb service unit is in this tree (`com.legioncode.honeycomb`). Watchdog, ladder, Doctor telemetry, blessed auto-update, and the `doctor` CLI stay unverifiable because `doctor/` is absent. That does not archive or complete the folder.
- PRD-066: stays in-work for the still-required rows in `code/local-queue.md` C12 through C21. Idempotency keys, recall-read categorization, sleep/wake and outage dogfood, upgrade smoke that does not prove memory rows or recall, the idle-read proof missing from the release gate, the open 10-minute poll-lease and poll-reaper window, a ledger with no cost implication, and no test that a transient Deep Lake outage keeps retryable local work. AC-8 and AC-9 are no longer code gaps. They were rewritten to ADR-0009. The 22 execution gates (typecheck, packaged smokes, live proofs) were not re-run and are not evidence for completed.
- PRD-078: phase 078a is in source and defaults on. a-AC-3 is unmet because the heavy semantic arm still calls SQL `<#>` search. a-AC-7 is unmet because `qa/` contains only `.gitkeep`. 078b and 078c (write-through, watermark, RAM cap, HNSW) are absent. The status line was not updated off Backlog.

## Recommendations rejected

Code or git reports overturned these. They were not applied.

- PRD-007 stays completed. PRD-045b de-scoped the five-phase `RecallEngine`. Do not move it back to in-work, and do not flip 007b through 007e from Draft to Completed.
- PRD-002 stays completed. No still-required criterion checked in `code/storage-catalog.md` is absent.
- PRD-003 stays completed. In-place summary UPDATE was replaced by PRD-017a SELECT-before-INSERT. Prune tombstones the paired summary because PRD-020a requires that. Do not reopen 003 to restore the old retain-summaries rule.
- PRD-050 stays completed. The hosted install scripts returned HTTP 200. Absence of `scripts/install/` and `src/daemon/runtime/dashboard/host.ts` in this checkout is not a demotion. The CLI health gate and the Hive portal open are live.
- PRD-024 stays completed. The UI kit moved to Hive with the portal. Archive would mark shipped work withdrawn. Missing `host.ts` is not unfinished honeycomb UI.
- PRD-036, PRD-037, PRD-038, PRD-040, and PRD-041 stay completed. A missing SPA (`src/dashboard/web/main.tsx` and the page files) is not a reopen. The same rule left PRD-027, PRD-043, and PRD-044 completed. Their Backlog status lines were not corrected in this commit.
- PRD-065 stays completed. Absence of `doctor/` is a repo boundary, not an absent honeycomb criterion, and not a withdrawal.
- GPU-backed Deep Lake labels in `overview.md` stay. The local embedder being CPU does not erase the store and billing labels in `vector.ts` and `roi-billing.ts`.
- The prior-art backlink on `retrieval.md` was not added.
- ISS-025 numbers are not unfinished PRD-006 work. The fact cap is 4 and the confidence default is 0.8 on purpose. Those UNMET marks do not restore 20 or 0.7. The folder still moved for 006d AC-5.
- PRD-008 traversal (`edgeClearsThreshold` with no walker) is not unfinished 008 work. PRD-045b removed the traversal engine. The folder still moved for attribute provenance.
- PRD-011b AC-2 is unmet on the production path (the real-backend healer refuses to re-mint, and dispatched status never calls it). That adds an unmet. It does not pull the folder back to completed. The in-work move still stands.
- PRD-066e AC-8 and AC-9 are stale text against ADR-0009, not missing code. The sentences were rewritten. They do not by themselves keep the folder in-work, and they do not complete it.
- 019c AC-1 stays unmet, but not because no harness produces summary rows. The hook spawn is a no-op, and the daemon session-end path still enqueues a summary job.
- The `renderContext` revise stands. The citation that the function is absent under `src/hooks/` does not. It is defined in `src/hooks/normalize.ts`.
- Git rejects, so no ADR: embeddings default-on, local ANN index, per-turn recall injection, the `member` role name, the Hive portal on 3853, and the unbound-project capture gate. Each why is already in a PRD, an existing ADR, or a knowledge page.
- ADR-0009 was not copied into a second local-queue ADR.

## Out of scope

`AGENTS.md` still calls embeddings opt-in (the embeddings directory row, and the note that embeddings are opt-in with a lexical fallback). `src/daemon/runtime/services/embed-client.ts` defaults them on. That file is outside `library/` and was left unchanged. `overview.md` in this commit already states the default-on rule.
