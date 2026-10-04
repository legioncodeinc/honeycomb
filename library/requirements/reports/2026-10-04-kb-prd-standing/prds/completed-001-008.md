# Standing report: completed PRD-001 through PRD-008

Date: 2026-10-04
Shard: Wave 1b, completed 001-008 only
Mode: read-only source check. PRDs, product source, and folders were not edited. Nothing was committed.
Build outputs, node_modules, daemon/, bundle/, and harness bundles were not used as proof.
June 2026 QA reports were read and were not treated as proof. Several cite paths that have since moved, and the PRD-007 QA report describes a five-phase engine the current recall barrel says was removed.

## How a verdict was chosen

MET means the behavior in the quoted criterion is present in current source, with a path and line.
UNMET means the quoted behavior is absent, or the source does the opposite, or a stated default/number does not match.
UNVERIFIABLE was not needed. Every criterion had either a source line or a confirmed absence.
A removed module is ABSENT even when a config knob or an unused pure function remains. The unused function is cited in the why line when it exists.
Index criteria and lettered-child criteria are judged separately. A rewritten index does not retire a child criterion that is still in the child file.

## Summary

| PRD | Criteria | MET | UNMET | Recommended bucket |
| --- | --- | --- | --- | --- |
| PRD-001 | 24 | 24 | 0 | completed |
| PRD-002 | 39 | 39 | 0 | completed |
| PRD-003 | 39 | 37 | 2 | in-work |
| PRD-004 | 32 | 32 | 0 | completed |
| PRD-005 | 21 | 21 | 0 | completed |
| PRD-006 | 33 | 30 | 3 | in-work |
| PRD-007 | 39 | 13 | 26 | in-work |
| PRD-008 | 25 | 22 | 3 | in-work |
| Total | 252 | 218 | 34 | 003, 006, 007, and 008 should leave completed |

## Recommended buckets

- **PRD-001: completed.** All 24 criteria are present in the build, version sync, Biome, jscpd, and bundle-confinement source. The tree-sitter stack is now web-tree-sitter plus tree-sitter-wasms, still external. A value-import walk from the CLI, harness, MCP, and SDK entries does not reach the storage client.
- **PRD-002: completed.** SQL escaping, heal-and-retry-once, version-bumped writes, SELECT-before-INSERT re-verify, and the `<#>` vector query with lexical degrade are in src/daemon/storage. The GPU claim is the adapter emitting the documented tensor operator, not a live GPU run.
- **PRD-003: in-work.** Catalog columns, heal-on-write, and the three memory roles are present. Two 003c criteria are unmet: memory summaries are not UPDATE-or-INSERT by path, and sessions prune tombstones the paired summary instead of retaining it.
- **PRD-004: completed.** Loopback bind, /health and /api/status, permission local-open versus team-deny, the memory_jobs lease/reaper/backoff/purge, the identity file watcher, and the runtime-path 409 claim are in the daemon runtime.
- **PRD-005: completed.** Capture inserts one JSONB sessions row, kicks embed without awaiting it, rejects a non-768 vector, and the shared capture gate skips on HONEYCOMB_CAPTURE=false, a disabled plugin, a non-capture entrypoint, and the worker recursion marker.
- **PRD-006: in-work.** The five pipeline stages, shadow and frozen gates, hash dedup, and non-fatal graph persist are present. Three criteria miss their stated numbers or agent scope: fact cap 4 versus about 20, write confidence default 0.8 versus 0.7, and graph agent_id taken from workspace.
- **PRD-007: in-work.** The rewritten index criteria match live hybrid recall (lexical arms, RRF, QueryScope, degraded flag), and 007a collection is still live for VFS browse. The lettered 007b, 007c, 007d, and 007e criteria mostly describe the five-phase engine removed in PRD-045b. A completed folder cannot hold those unmet criteria.
- **PRD-008: in-work.** The linker, append-only supersede, constraint guard, conflict detector, and dry-run control plane are present. Three criteria are unmet: proposal provenance is discarded on attribute writes, and the strength-times-confidence follow rule has no production traversal caller.

In-work, not backlog: each of those four folders already has a large shipped core. Backlog would describe work that has not started. The unmet criteria are residual or contradicted claims inside an otherwise present implementation.

## QA and security notes read

Each folder has reports/2026-06-17-qa-report.md and reports/2026-06-17-security-report.md. They are historical ledgers, not acceptance criteria. Findings that change a current verdict:

- PRD-001 QA (line 19) says all 20 granular criteria passed and flags a non-AC warning that harness stubs did not enumerate hook types. Current esbuild still emits the harness entry roots. That warning is not an acceptance criterion.
- PRD-001 QA (line 87) asterisked DeepLake confinement because PRD-002 was not wired yet. The storage client now exists, and a value-import walk from CLI, harness, MCP, SDK, and embeddings entries does not reach it. Index AC-2 is MET on that basis.
- PRD-007 QA (line 13) says the five-phase engine is fully implemented and all 35 criteria passed. src/daemon/runtime/recall/index.ts:4-12 says that orchestrator was removed and live recall is recallMemories. The 2026-06-22 index rewrite matches the removal. The child criteria were not rewritten, so they are judged against current source and come out UNMET.
- PRD-008 QA (line 41) warned that attribute writes void proposalId and source. That warning is now an UNMET on 008a AC-3 because the criterion requires provenance back to the proposal and the write still discards it (entity-model.ts:324-325).
- Security reports for 001-008 recorded no unresolved Critical or High at the time they were written. They do not add acceptance criteria.

## Status-line drift (not an acceptance criterion)

Index status lines say Completed. Several lettered children still say Draft in their own headers and in the index sub-feature tables (for example prd-001-monorepo-foundation-index.md:31-33). If a folder stays completed, those status lines should be updated with the move. They were not edited in this shard.

## Unmet criteria

### PRD-003

- **prd-003c-core-data-model-sessions-summaries.md AC-2** (library/requirements/completed/prd-003-core-data-model/prd-003c-core-data-model-sessions-summaries.md:48)
  - Quote: Given a wiki summary or VFS file, when written, then a `memory` row is UPDATE-or-INSERT keyed by `path` with a `summary` body and `summary_embedding`.
  - Verdict: UNMET
  - Source: src/daemon/runtime/summaries/worker.ts:36; src/daemon/runtime/summaries/synthesis.ts:35
  - Why: Summaries write the memory table SELECT-before-INSERT (and a later version-append), and the worker states there is no in-place UPDATE. The criterion asks for UPDATE-or-INSERT by path.
- **prd-003c-core-data-model-sessions-summaries.md AC-6** (library/requirements/completed/prd-003-core-data-model/prd-003c-core-data-model-sessions-summaries.md:52)
  - Quote: Given `sessions` raw events are pruned by retention, when the prune runs, then the derived `memory` summaries are retained.
  - Verdict: UNMET
  - Source: src/daemon/runtime/sessions/prune.ts:5-10
  - Why: The shipped sessions prune tombstones the paired memory summary in the same pass. Retention does not prune sessions while leaving summaries.

### PRD-006

- **prd-006a-memory-pipeline-extraction.md AC-3** (library/requirements/completed/prd-006-memory-pipeline/prd-006a-memory-pipeline-extraction.md:51)
  - Quote: Given an oversized result, when extraction completes, then output is bounded to ~20 facts and ~50 entities with per-fact length limits.
  - Verdict: UNMET
  - Source: src/daemon/runtime/pipeline/config.ts:59; src/daemon/runtime/pipeline/config.ts:61
  - Why: Entities are capped at 50. The default fact cap is 4, not about 20.
- **prd-006c-memory-pipeline-controlled-writes.md AC-1** (library/requirements/completed/prd-006-memory-pipeline/prd-006c-memory-pipeline-controlled-writes.md:50)
  - Quote: Given an ADD proposal, when controlled writes run, then it is written only if fact confidence clears `minFactConfidenceForWrite` (default 0.7), normalized content is non-empty, and the SHA-256 content hash is not already present.
  - Verdict: UNMET
  - Source: src/daemon/runtime/pipeline/config.ts:82; src/daemon/runtime/pipeline/controlled-writes.ts:452
  - Why: The ADD gate, non-empty content check, and content-hash dedup exist. The configured default confidence is 0.8, not 0.7.
- **prd-006d-memory-pipeline-graph-persistence.md AC-5** (library/requirements/completed/prd-006-memory-pipeline/prd-006d-memory-pipeline-graph-persistence.md:52)
  - Quote: Given any graph write, when it commits, then the row carries org, workspace, and agent scope.
  - Verdict: UNMET
  - Source: src/daemon/runtime/pipeline/graph-persist.ts:453; src/daemon/runtime/pipeline/graph-persist.ts:229
  - Why: Org and workspace ride QueryScope. The agent_id column is filled from scope.workspace, and the stage job's agentId is not used.

### PRD-007

- **prd-007b-retrieval-graph-traversal.md AC-1** (library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md:48)
  - Quote: Given a query, when focal resolution runs, then it resolves in order: pinned, checkpoint IDs, project-path, entity FTS tokens, then session-key fallback.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: The five-phase RecallEngine, including the traversal walk and focal resolver, was removed. Config knobs remain. No walk implements the focal order.
- **prd-007b-retrieval-graph-traversal.md AC-2** (library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md:49)
  - Quote: Given the graph is disabled, when traversal runs, then it is skipped and contributes no candidates without error.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: There is no traversal channel on the live recall path to skip. graphEnabled in recall config is unused by a walk.
- **prd-007b-retrieval-graph-traversal.md AC-3** (library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md:50)
  - Quote: Given a focal set, when the walk runs, then it honors caps on aspects, attributes, branching, and total IDs.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: Traversal caps exist only as zod defaults in recall config. No walk honors them.
- **prd-007b-retrieval-graph-traversal.md AC-4** (library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md:51)
  - Quote: Given a low strength-times-confidence edge, when the walk evaluates it, then the edge is not followed.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: edgeClearsThreshold exists and is unit-tested, and it has no production caller. Nothing follows or skips edges during recall.
- **prd-007b-retrieval-graph-traversal.md AC-5** (library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md:52)
  - Quote: Given an active constraint under a focal entity, when caps trim the walk, then the constraint is still surfaced.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No walk surfaces constraints under a cap.
- **prd-007b-retrieval-graph-traversal.md AC-6** (library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md:53)
  - Quote: Given a dense graph, when the timeout fires, then the walk returns collected IDs with the timeout flag rather than failing.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No walk returns a timeout flag.
- **prd-007b-retrieval-graph-traversal.md AC-7** (library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md:54)
  - Quote: Given the walk completes, then it returns IDs with scores and paths, constraints, an entity count, and the timeout flag, and no content was loaded.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No traversal result object (IDs, scores, paths, constraints, entity count, timeout flag) is produced.
- **prd-007c-retrieval-authorization.md AC-1** (library/requirements/completed/prd-007-retrieval/prd-007c-retrieval-authorization.md:47)
  - Quote: Given collected candidate IDs, when authorization runs, then the engine re-queries with the org/workspace partition and the `agent_id` read-policy clause plus caller filters.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No phase re-queries collected candidate IDs. buildScopeClause has no production caller outside its own file.
- **prd-007c-retrieval-authorization.md AC-2** (library/requirements/completed/prd-007-retrieval/prd-007c-retrieval-authorization.md:48)
  - Quote: Given an `isolated` agent, when authorization runs, then only its own non-archived memories survive.
  - Verdict: UNMET
  - Source: src/daemon/runtime/recall/scope-clause.ts:236; src/daemon/runtime/memories/recall.ts:587-590
  - Why: The isolated SQL fragment exists in buildScopeClause. Live recall SQL filters is_deleted and an optional project clause, not agent_id = self.
- **prd-007c-retrieval-authorization.md AC-3** (library/requirements/completed/prd-007-retrieval/prd-007c-retrieval-authorization.md:49)
  - Quote: Given a `group` agent, when authorization runs, then global memories from same-`policy_group` agents plus its own survive, archived excluded.
  - Verdict: UNMET
  - Source: src/daemon/runtime/recall/scope-clause.ts:247-263
  - Why: The group SQL fragment exists in buildScopeClause and is not applied by recallMemories.
- **prd-007c-retrieval-authorization.md AC-4** (library/requirements/completed/prd-007-retrieval/prd-007c-retrieval-authorization.md:50)
  - Quote: Given an unauthorized candidate, when the boundary applies, then it is dropped before any content loads.
  - Verdict: UNMET
  - Source: src/daemon/runtime/memories/recall.ts:588
  - Why: Live lexical arms project content text in the same SELECT as the match. There is no ID-only authorization boundary before content load.
- **prd-007c-retrieval-authorization.md AC-5** (library/requirements/completed/prd-007-retrieval/prd-007c-retrieval-authorization.md:51)
  - Quote: Given a malformed agent id, when authorization runs, then it falls back to `isolated` and returns a structured error context, never a wider policy.
  - Verdict: UNMET
  - Source: src/daemon/runtime/recall/scope-clause.ts:210-217
  - Why: buildScopeClause falls back to isolated on a blank agent id. That function is not called by the live recall path, so a malformed caller is not failed closed there.
- **prd-007c-retrieval-authorization.md AC-7** (library/requirements/completed/prd-007-retrieval/prd-007c-retrieval-authorization.md:53)
  - Quote: Given a VFS browse request, when content is requested, then the same scope clause authorizes rows before any content returns.
  - Verdict: UNMET
  - Source: src/daemon/runtime/vfs/api.ts:372
  - Why: VFS grep reuses collectCandidates. It does not call buildScopeClause before hydrating content.
- **prd-007d-retrieval-shaping.md AC-1** (library/requirements/completed/prd-007-retrieval/prd-007d-retrieval-shaping.md:48)
  - Quote: Given a result with mixed signals, when convolution runs, then no single channel dominates and facet coverage prefers broader-covering results.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: The shaping phase (convolution, facet coverage) was removed with the five-phase engine. Live fusion is RRF, which is a different contract.
- **prd-007d-retrieval-shaping.md AC-3** (library/requirements/completed/prd-007-retrieval/prd-007d-retrieval-shaping.md:50)
  - Quote: Given a superseded claim, when currentness runs, then it is downweighted so the current claim-slot value (by `group_key` + `claim_key`) outranks the value it replaced.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No currentness pass downweights entity_attributes by group_key and claim_key. Live recall excludes is_deleted = 1 and uses highest-version reads elsewhere.
- **prd-007d-retrieval-shaping.md AC-4** (library/requirements/completed/prd-007-retrieval/prd-007d-retrieval-shaping.md:51)
  - Quote: Given a semantic hit sharing no query terms, when gravity dampening runs, then it is penalized.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: gravity dampening is a config default only. No scorer applies it.
- **prd-007d-retrieval-shaping.md AC-5** (library/requirements/completed/prd-007-retrieval/prd-007d-retrieval-shaping.md:52)
  - Quote: Given a result hung off a very high-degree entity, when hub dampening runs, then it is penalized.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: hub dampening is a config default only. No scorer applies it.
- **prd-007d-retrieval-shaping.md AC-6** (library/requirements/completed/prd-007-retrieval/prd-007d-retrieval-shaping.md:53)
  - Quote: Given a decision or constraint memory, when resolution dampening runs, then it is boosted.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: resolutionBoost is a config default only. No scorer boosts decision or constraint memories.
- **prd-007d-retrieval-shaping.md AC-7** (library/requirements/completed/prd-007-retrieval/prd-007d-retrieval-shaping.md:54)
  - Quote: Given shaping completes, then calibrated scores are preserved for the confidence gate and no unauthorized row was introduced.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: There is no shaping phase that preserves calibrated scores for a confidence gate, and live recall does not apply the agent read-policy clause.
- **prd-007e-retrieval-confidence-gate.md AC-1** (library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md:47)
  - Quote: Given shaped results, when the gate runs, then context is injected only if the reranker-calibrated top score clears the minimum.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No injection gate. minInjectionScore is parsed in recall config and has no caller.
- **prd-007e-retrieval-confidence-gate.md AC-2** (library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md:48)
  - Quote: Given the calibrated scores, when the gate decides, then scores are preserved from shaping, not synthesized from rank.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No gate preserves or synthesizes an injection score. Recall returns RRF-ranked hits.
- **prd-007e-retrieval-confidence-gate.md AC-3** (library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md:49)
  - Quote: Given nothing clears the minimum, when the hook returns, then an empty injection is returned as a valid answer, not a failure.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: Recall returns ranked hits with a degraded flag. It does not return an empty injection as a distinct valid answer.
- **prd-007e-retrieval-confidence-gate.md AC-4** (library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md:50)
  - Quote: Given surviving IDs, when they are hydrated, then the same scope filter applies and the caller's limit caps the primary results.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: Hydration is the recall SELECT itself, not a post-gate scope re-query. The caller limit is applied, but not behind the removed gate.
- **prd-007e-retrieval-confidence-gate.md AC-5** (library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md:51)
  - Quote: Given hydration completes, when access is tracked, then only primary results are tracked.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: The confidence gate that hydrated survivors and tracked only primary results is absent. Live recall has no primary-versus-supplementary split.
- **prd-007e-retrieval-confidence-gate.md AC-6** (library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md:52)
  - Quote: Given supplementary cards, when they ride along, then each is marked synthetic and distinguishable from ordinary rows.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: No supplementary synthetic cards are attached by a gate.
- **prd-007e-retrieval-confidence-gate.md AC-7** (library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md:53)
  - Quote: Given a per-agent threshold override, when the gate runs, then that agent's configured minimum is applied.
  - Verdict: UNMET
  - Source: ABSENT
  - Why: The per-agent minimum lives only as the unused minInjectionScore config field.

### PRD-008

- **prd-008a-knowledge-graph-ontology-entity-model.md AC-3** (library/requirements/completed/prd-008-knowledge-graph-ontology/prd-008a-knowledge-graph-ontology-entity-model.md:51)
  - Quote: Given an entity attribute, when stored, then it carries `kind`, `status`, confidence, importance, version lineage, and provenance back to the memory and proposal.
  - Verdict: UNMET
  - Source: src/daemon/runtime/ontology/entity-model.ts:303-325
  - Why: kind, status, confidence, importance, version, and memory_id are written. proposalId and source are explicitly discarded, and entity_attributes has no proposal_id column.
- **prd-008b-knowledge-graph-ontology-dependencies-supersession.md AC-4** (library/requirements/completed/prd-008-knowledge-graph-ontology/prd-008b-knowledge-graph-ontology-dependencies-supersession.md:52)
  - Quote: Given an edge, when traversal evaluates it, then it is followed only when strength times confidence clears the threshold.
  - Verdict: UNMET
  - Source: src/daemon/runtime/ontology/dependencies.ts:293-299
  - Why: The strength-times-confidence predicate exists and is tested. No production traversal evaluates edges, so the follow rule never runs.
- **prd-008-knowledge-graph-ontology-index.md AC-3** (library/requirements/completed/prd-008-knowledge-graph-ontology/prd-008-knowledge-graph-ontology-index.md:53)
  - Quote: Given a loose `related_to` edge, when it is written, then it carries a required reason, and traversal follows it only when strength times confidence clears the threshold.
  - Verdict: UNMET
  - Source: src/daemon/runtime/ontology/dependencies.ts:358; src/daemon/runtime/ontology/dependencies.ts:293
  - Why: A loose related_to write requires a reason. Nothing in production traversal follows or refuses the edge. edgeClearsThreshold has no caller outside tests.

## Full criterion ledger

Removal record used for the absent 007 phases: src/daemon/runtime/recall/index.ts:4-12.

### PRD-001

#### library/requirements/completed/prd-001-monorepo-foundation/prd-001a-monorepo-foundation-workspace-layout.md

- **AC-1** line 48 - MET
  - Quote: Given the workspace, when `tsc` runs, then all packages compile against the shared `tsconfig` and emit to `dist/`.
  - Source: tsconfig.json:8; tsconfig.json:29
- **AC-2** line 49 - MET
  - Quote: Given any source file, when Biome runs, then lint and format rules apply uniformly across every package.
  - Source: biome.json:23-41
- **AC-3** line 50 - MET
  - Quote: Given `npm run typecheck`, when there is a type error in any package, then the command exits non-zero and names the failing file.
  - Source: package.json:58
- **AC-4** line 51 - MET
  - Quote: Given the source tree, when esbuild later enumerates targets, then daemon, each harness, `mcp/`, CLI, and `embeddings/` are independently addressable entry roots.
  - Source: esbuild.config.mjs:121-393
- **AC-5** line 52 - MET
  - Quote: Given a package-level `tsconfig`, when it is inspected, then it extends the root config rather than redefining `strict` or target settings.
  - Source: tsconfig.json:10
- **AC-6** line 53 - MET
  - Quote: Given a new module added under the layout, when it is built, then it compiles with no per-package config and lands at a known `dist/` path.
  - Source: tsconfig.json:29
- **AC-7** line 54 - MET
  - Quote: Given a constant or default duplicated across two packages, when CI runs `jscpd`/lint, then the duplication is flagged for extraction.
  - Source: .jscpd.json:3; package.json:61
#### library/requirements/completed/prd-001-monorepo-foundation/prd-001b-monorepo-foundation-bundling.md

- **AC-1** line 49 - MET
  - Quote: Given compiled `dist/` output, when esbuild runs, then each target emits a self-contained bundle to its declared output directory.
  - Source: esbuild.config.mjs:121-393
- **AC-2** line 50 - MET
  - Quote: Given `tree-sitter` and language grammars, when bundling runs, then they are declared `external` and resolved from `node_modules` at runtime rather than inlined.
  - Source: esbuild.config.mjs:59-71
- **AC-3** line 51 - MET
  - Quote: Given the daemon bundle, when its imports are inspected, then it is the only bundle linking the DeepLake client; harness, CLI, and MCP bundles contain no DeepLake access path.
  - Source: esbuild.config.mjs:84-97; tests/daemon/storage/invariant.test.ts:88
- **AC-4** line 52 - MET
  - Quote: Given the OpenClaw bundle, when `audit:openclaw` scans it, then it contains no raw `process.env` substring and no reachable `node:child_process` exec call.
  - Source: esbuild.config.mjs:241-291; scripts/audit-openclaw-bundle.mjs:34-40
- **AC-5** line 53 - MET
  - Quote: Given any bundle, when its version constant is read, then `__HONEYCOMB_VERSION__` matches the root `package.json` version.
  - Source: esbuild.config.mjs:52-53
- **AC-6** line 54 - MET
  - Quote: Given the CLI bundle, when it is emitted, then `bundle/cli.js` has a Node hash-bang and `0755` permission and runs directly.
  - Source: esbuild.config.mjs:357-367
- **AC-7** line 55 - MET
  - Quote: Given the OpenClaw runtime, when a user sets a tuning knob in `openclaw.json` and restarts, then the value is read from `globalThis.__honeycomb_tuning__` and applied.
  - Source: harnesses/openclaw/src/index.ts:53; esbuild.config.mjs:248-266
#### library/requirements/completed/prd-001-monorepo-foundation/prd-001c-monorepo-foundation-version-release.md

- **AC-1** line 48 - MET
  - Quote: Given a new root version, when the sync script runs, then all scalar plugin manifests and the marketplace metadata and plugin entries are updated to match.
  - Source: scripts/sync-versions.mjs:23-33
- **AC-2** line 49 - MET
  - Quote: Given manifests already at the target version, when the script re-runs, then it performs no file writes (idempotent).
  - Source: scripts/sync-versions.mjs:74-78
- **AC-3** line 50 - MET
  - Quote: Given a bumped root version, when `prebuild` runs ahead of `build`, then every manifest is synced before esbuild emits artifacts.
  - Source: package.json:54
- **AC-4** line 51 - MET
  - Quote: Given a sync run, when it completes, then it logs each `old -> new` transition and a final write/skip count.
  - Source: scripts/sync-versions.mjs:83; scripts/sync-versions.mjs:113
- **AC-5** line 52 - MET
  - Quote: Given the marketplace file, when sync runs, then both `metadata.version` and every `plugins[].version` match the root version.
  - Source: scripts/sync-versions.mjs:87-104
- **AC-6** line 53 - MET
  - Quote: Given a malformed manifest JSON, when sync runs, then it fails with a clear error naming the file rather than writing partial output.
  - Source: scripts/sync-versions.mjs:47-51
#### library/requirements/completed/prd-001-monorepo-foundation/prd-001-monorepo-foundation-index.md

- **AC-1** line 39 - MET
  - Quote: Given a clean checkout, when `npm run build` runs, then `tsc` type-checks the whole monorepo and esbuild emits every target bundle without error.
  - Source: package.json:56
- **AC-2** line 40 - MET
  - Quote: Given the daemon bundle, when its imports are inspected, then it is the only bundle that links the DeepLake client; harness, CLI, and MCP bundles contain no DeepLake access path.
  - Source: esbuild.config.mjs:84-97; src/daemon/index.ts:31; tests/daemon/storage/invariant.test.ts:112-123
- **AC-3** line 41 - MET
  - Quote: Given a bumped version in the root `package.json`, when `prebuild` runs, then every plugin manifest and the marketplace file are updated to match, and re-running makes no further writes.
  - Source: package.json:54; scripts/sync-versions.mjs:59-113
- **AC-4** line 42 - MET
  - Quote: Given `tree-sitter` and its grammars, when a target is bundled, then those modules are marked `external` and resolved from `node_modules` at runtime.
  - Source: esbuild.config.mjs:71

### PRD-002

#### library/requirements/completed/prd-002-deeplake-storage-adapter/prd-002a-deeplake-storage-adapter-client.md

- **AC-1** line 48 - MET
  - Quote: Given daemon startup, when the client initializes, then it connects to the configured DeepLake endpoint and exposes a query interface to other adapter layers.
  - Source: src/daemon/storage/client.ts:455-483
- **AC-2** line 49 - MET
  - Quote: Given a request carrying org/workspace identity, when a query runs, then the resolved org is sent so DeepLake enforces the partition boundary.
  - Source: src/daemon/storage/client.ts:42-44; src/daemon/storage/client.ts:581
- **AC-3** line 50 - MET
  - Quote: Given missing or out-of-range config, when the client initializes, then it rejects with a structured error and the daemon fails closed.
  - Source: src/daemon/storage/config.ts:46-54; src/daemon/storage/config.ts:80-86
- **AC-4** line 51 - MET
  - Quote: Given a query exceeding `HONEYCOMB_QUERY_TIMEOUT_MS`, when it runs, then the client returns a timeout result rather than blocking the worker indefinitely.
  - Source: src/daemon/storage/client.ts:555-558
- **AC-5** line 52 - MET
  - Quote: Given a non-daemon process, when it needs storage, then it calls the daemon on port 3850 and never opens DeepLake itself.
  - Source: src/daemon-client/index.ts:14-36; tests/daemon/storage/invariant.test.ts:112-123
- **AC-6** line 53 - MET
  - Quote: Given `HONEYCOMB_TRACE_SQL` is unset, when queries run, then statements are not logged; when set, then they are.
  - Source: src/daemon/storage/config.ts:114-115; src/daemon/storage/client.ts:549
- **AC-7** line 54 - MET
  - Quote: Given a connection failure versus a query failure, when either occurs, then the client returns distinct typed result kinds.
  - Source: src/daemon/storage/result.ts:25-30
#### library/requirements/completed/prd-002-deeplake-storage-adapter/prd-002b-deeplake-storage-adapter-sql-safety.md

- **AC-1** line 48 - MET
  - Quote: Given a value with quotes, backslashes, or control characters, when `sqlStr` escapes it, then quotes and backslashes are doubled and NUL/control characters are dropped.
  - Source: src/daemon/storage/sql.ts:42-49
- **AC-2** line 49 - MET
  - Quote: Given an identifier, when `sqlIdent` validates it, then it accepts only `^[a-zA-Z_][a-zA-Z0-9_]*$` and throws on anything else.
  - Source: src/daemon/storage/sql.ts:100-104
- **AC-3** line 50 - MET
  - Quote: Given a search term containing `%` or `_`, when `sqlLike` escapes it, then those wildcards are treated as literals rather than pattern operators.
  - Source: src/daemon/storage/sql.ts:77-85
- **AC-4** line 51 - MET
  - Quote: Given a body containing `\n` or other escape sequences, when written via `E'...'`, then the stored bytes match the intended content after round-trip.
  - Source: src/daemon/storage/sql.ts:122-123
- **AC-5** line 52 - MET
  - Quote: Given an injection attempt like `'; DROP TABLE x; --` passed to `sqlStr`, when interpolated, then it is a single inert literal and no second statement executes.
  - Source: src/daemon/storage/sql.ts:42-49
- **AC-6** line 53 - MET
  - Quote: Given a crafted column name like `id; DROP`, when passed to `sqlIdent`, then it throws and the query is never built.
  - Source: src/daemon/storage/sql.ts:100-104
- **AC-7** line 54 - MET
  - Quote: Given a query builder that hand-interpolates a value, when CI lint runs, then the bypass is flagged.
  - Source: scripts/audit-sql-safety.mjs:387-390
#### library/requirements/completed/prd-002-deeplake-storage-adapter/prd-002c-deeplake-storage-adapter-schema-healing.md

- **AC-1** line 49 - MET
  - Quote: Given a write that fails because the table is missing, when the heal path runs, then it creates the table from the column-definition array and retries the write once.
  - Source: src/daemon/storage/heal.ts:13-14; src/daemon/storage/heal.ts:286
- **AC-2** line 50 - MET
  - Quote: Given a write that fails because a column is missing, when the heal path runs, then it reads `information_schema.columns`, diffs against the definition, and adds only the missing columns.
  - Source: src/daemon/storage/heal.ts:124-138
- **AC-3** line 51 - MET
  - Quote: Given a write that fails with a permission error, when error classification runs, then it rethrows unchanged and never issues a create or alter.
  - Source: src/daemon/storage/heal.ts:77-81
- **AC-4** line 52 - MET
  - Quote: Given a heal that still fails the retry, when the second attempt errors, then the adapter rethrows rather than retrying again.
  - Source: src/daemon/storage/heal.ts:310-311
- **AC-5** line 53 - MET
  - Quote: Given a column definition with `NOT NULL` and no `DEFAULT`, when the daemon loads, then the load-time guard rejects it before any write.
  - Source: src/daemon/storage/schema.ts:80-95
- **AC-6** line 54 - MET
  - Quote: Given two workers healing the same missing table concurrently, when both run, then `IF NOT EXISTS` and add-only-missing make the result identical to a single heal.
  - Source: src/daemon/storage/heal.ts:143-149
- **AC-7** line 55 - MET
  - Quote: Given a heal `ALTER` statement, when it is built, then every identifier passes `sqlIdent` validation.
  - Source: src/daemon/storage/schema.ts:161-162
#### library/requirements/completed/prd-002-deeplake-storage-adapter/prd-002d-deeplake-storage-adapter-write-patterns.md

- **AC-1** line 49 - MET
  - Quote: Given a concurrent-edit table, when an edit lands, then the version-bumped primitive INSERTs version N+1 and readers take `ORDER BY version DESC LIMIT 1` as current.
  - Source: src/daemon/storage/writes.ts:188-210; src/daemon/storage/writes.ts:228-249
- **AC-2** line 50 - MET
  - Quote: Given a SELECT-before-INSERT identity key, when two writers race, then the primitive re-verifies after insert so the race is observable rather than silently doubling the row.
  - Source: src/daemon/storage/writes.ts:345-375
- **AC-3** line 51 - MET
  - Quote: Given two rapid edits to a version-bumped table, when both commit, then both versions persist and the highest version reads as current.
  - Source: src/daemon/storage/writes.ts:216-220
- **AC-4** line 52 - MET
  - Quote: Given a `sessions` write, when it lands, then it appends one row and never concatenates an existing one; readers order by `creation_date`.
  - Source: src/daemon/storage/writes.ts:107; src/daemon/storage/writes.ts:383-398
- **AC-5** line 53 - MET
  - Quote: Given a supersede on a version-bumped table, when it runs, then the prior version is marked superseded by appending a new version rather than mutating the old row.
  - Source: src/daemon/storage/writes.ts:221-223; src/daemon/runtime/ontology/supersede.ts:187
- **AC-6** line 54 - MET
  - Quote: Given a primitive writing any value, when the statement is built, then every value passed through `sqlStr`/`sqlLike`/`sqlIdent` with `E'...'` for escape-bearing bodies.
  - Source: src/daemon/storage/writes.ts:66-76
- **AC-7** line 55 - MET
  - Quote: Given a write that fails on a missing column, when the primitive runs, then it heals via PRD-002c and retries once.
  - Source: src/daemon/storage/writes.ts:180; src/daemon/storage/heal.ts:286
#### library/requirements/completed/prd-002-deeplake-storage-adapter/prd-002-deeplake-storage-adapter-index.md

- **AC-1** line 42 - MET
  - Quote: Given any value interpolated into a query, when the adapter builds the statement, then the value is escaped through `sqlStr`/`sqlLike`/`sqlIdent` and no parameterized binding is used.
  - Source: src/daemon/storage/sql.ts:42; scripts/audit-sql-safety.mjs:10-17
- **AC-2** line 43 - MET
  - Quote: Given a write to a table or column that does not exist, when the write fails, then the adapter creates the table or adds only the missing columns and retries the write once.
  - Source: src/daemon/storage/heal.ts:275-311
- **AC-3** line 44 - MET
  - Quote: Given two rapid edits to a concurrent-edit table, when both commit, then the version-bumped append pattern preserves both versions and the highest version reads as current.
  - Source: src/daemon/storage/writes.ts:216-249
- **AC-4** line 45 - MET
  - Quote: Given a query with a 768-dim embedding, when vector search runs, then it executes on the GPU-backed engine against the tensor column and returns scored IDs; when the embedding is null, recall degrades to lexical search.
  - Source: src/daemon/storage/vector.ts:254-281; src/daemon/storage/vector.ts:321-344
#### library/requirements/completed/prd-002-deeplake-storage-adapter/prd-002e-deeplake-storage-adapter-vector-search.md

- **AC-1** line 48 - MET
  - Quote: Given a 768-dim `nomic-embed-text-v1.5` query vector, when vector search runs, then it executes on the GPU-backed engine against the nullable tensor column and returns scored memory IDs.
  - Source: src/daemon/storage/vector.ts:35; src/daemon/storage/vector.ts:254-281
- **AC-2** line 49 - MET
  - Quote: Given a row whose embedding column is null, when search runs, then recall degrades to lexical search rather than failing.
  - Source: src/daemon/storage/vector.ts:321-344; src/daemon/storage/vector.ts:373-375
- **AC-3** line 50 - MET
  - Quote: Given a scoped recall, when vector search runs, then it over-fetches by the configured multiplier so the authorization filter still has candidates.
  - Source: src/daemon/storage/vector.ts:259-260
- **AC-4** line 51 - MET
  - Quote: Given a search result, when it returns, then it carries IDs and normalized scores only and no row content.
  - Source: src/daemon/storage/vector.ts:276-277; src/daemon/storage/vector.ts:347-353
- **AC-5** line 52 - MET
  - Quote: Given org/workspace/agent scope, when vector search runs, then the scoping filter is applied in the same query as the vector match.
  - Source: src/daemon/storage/vector.ts:180-185; src/daemon/storage/vector.ts:278
- **AC-6** line 53 - MET
  - Quote: Given a query vector that is not 768-dim, when search runs, then it is rejected with a structured error.
  - Source: src/daemon/storage/vector.ts:75-76
- **AC-7** line 54 - MET
  - Quote: Given `HONEYCOMB_SEMANTIC_LIMIT`, when set out of range, then it is clamped to a non-negative value before search runs.
  - Source: src/daemon/storage/vector.ts:189-201

### PRD-003

#### library/requirements/completed/prd-003-core-data-model/prd-003a-core-data-model-memories.md

- **AC-1** line 47 - MET
  - Quote: Given a distilled fact, when written, then the `memories` row carries `content_hash`, `confidence`, `importance`, `source_id`, `agent_id`, `visibility`, and a nullable 768-dim `content_embedding`.
  - Source: src/daemon/storage/catalog/memories.ts:50-78
- **AC-2** line 48 - MET
  - Quote: Given any proposal, when processed, then `memory_history` records it with `changed_by` set to `harness`, `pipeline`, or `pipeline-shadow`.
  - Source: src/daemon/storage/catalog/memories.ts:171-176; src/daemon/runtime/pipeline/decision.ts:480
- **AC-3** line 49 - MET
  - Quote: Given two facts with identical `normalized_content`, when the second is proposed, then its `content_hash` matches and the decision stage skips the duplicate INSERT.
  - Source: src/daemon/storage/catalog/memories.ts:59-60; src/daemon/runtime/pipeline/controlled-writes.ts:440
- **AC-4** line 50 - MET
  - Quote: Given embedding is disabled, when a memory is written, then `content_embedding` is `NULL` and recall still returns the row via lexical filters.
  - Source: src/daemon/storage/catalog/memories.ts:78; src/daemon/runtime/pipeline/controlled-writes.ts:470
- **AC-5** line 51 - MET
  - Quote: Given a soft-deleted memory, when retention has not yet purged it, then `is_deleted = 1` and the row is excluded from recall but retained for the audit window.
  - Source: src/daemon/storage/catalog/memories.ts:74; src/daemon/runtime/memories/recall.ts:578-590
- **AC-6** line 52 - MET
  - Quote: Given the `memories` table does not yet exist, when the first INSERT runs, then it is created from the column-definition array and the INSERT is retried once.
  - Source: src/daemon/storage/heal.ts:286; src/daemon/storage/catalog/memories.ts:47
- **AC-7** line 53 - MET
  - Quote: Given shadow mode is active, when the pipeline proposes a write, then `memory_history` records `changed_by = 'pipeline-shadow'` and `memories` is not mutated.
  - Source: src/daemon/runtime/pipeline/decision.ts:480; src/daemon/runtime/pipeline/controlled-writes.ts:422
#### library/requirements/completed/prd-003-core-data-model/prd-003b-core-data-model-knowledge-graph.md

- **AC-1** line 47 - MET
  - Quote: Given a claim attribute, when defined, then `entity_attributes` carries `kind`, `status`, `claim_key`, `group_key`, `version`, and `superseded_by`.
  - Source: src/daemon/storage/catalog/knowledge-graph.ts:135-148
- **AC-2** line 48 - MET
  - Quote: Given a claim edit, when applied, then a new `version` row is INSERTed and the prior row is marked `status = 'superseded'` rather than mutated.
  - Source: src/daemon/runtime/ontology/supersede.ts:187; src/daemon/runtime/ontology/supersede.ts:342
- **AC-3** line 49 - MET
  - Quote: Given a loose link between entities, when stored, then `entity_dependencies` carries `type`, `strength`, `confidence`, and a non-empty `reason` for `related_to`.
  - Source: src/daemon/storage/catalog/knowledge-graph.ts:158-163; src/daemon/runtime/ontology/dependencies.ts:358
- **AC-4** line 50 - MET
  - Quote: Given a graph change, when proposed, then `ontology_proposals` records `operation`, `status`, JSONB `payload`, `confidence`, `rationale`, `evidence`, and `risk_note`.
  - Source: src/daemon/storage/catalog/knowledge-graph.ts:241-259
- **AC-5** line 51 - MET
  - Quote: Given a memory references an entity, when persisted, then a `memory_entity_mentions` row joins `memory_id` to `entity_id`.
  - Source: src/daemon/storage/catalog/knowledge-graph.ts:191-193
- **AC-6** line 52 - MET
  - Quote: Given a reader resolves a claim, when multiple versions exist, then it returns the highest `version` with `status = 'active'`.
  - Source: src/daemon/storage/catalog/knowledge-graph.ts:346-356
- **AC-7** line 53 - MET
  - Quote: Given any ontology table does not exist, when the first write runs, then it is created from its column-definition array and the write retries once.
  - Source: src/daemon/storage/heal.ts:286
#### library/requirements/completed/prd-003-core-data-model/prd-003c-core-data-model-sessions-summaries.md

- **AC-1** line 47 - MET
  - Quote: Given a turn event, when captured, then a `sessions` row is INSERTed with a JSONB `message`, an optional 768-dim `message_embedding`, and a `path` readers concatenate by `creation_date`.
  - Source: src/daemon/storage/catalog/sessions-summaries.ts:36-41; src/daemon/storage/writes.ts:398
- **AC-2** line 48 - UNMET
  - Quote: Given a wiki summary or VFS file, when written, then a `memory` row is UPDATE-or-INSERT keyed by `path` with a `summary` body and `summary_embedding`.
  - Source: src/daemon/runtime/summaries/worker.ts:36; src/daemon/runtime/summaries/synthesis.ts:35
  - Why: Summaries write the memory table SELECT-before-INSERT (and a later version-append), and the worker states there is no in-place UPDATE. The criterion asks for UPDATE-or-INSERT by path.
- **AC-3** line 49 - MET
  - Quote: Given the three memory tables, when inspected, then `sessions` holds raw events, `memory` holds VFS and summaries, and `memories` holds distilled facts, with no overlapping role.
  - Source: src/daemon/storage/catalog/sessions-summaries.ts:216-219
- **AC-4** line 50 - MET
  - Quote: Given a session ends, when the transcript is persisted, then it lands as a `memory` path convention, not a new table.
  - Source: src/daemon/runtime/summaries/worker.ts:90; src/daemon/runtime/summaries/worker.ts:126
- **AC-5** line 51 - MET
  - Quote: Given embedding is disabled, when an event is captured, then `message_embedding` is `NULL` and the row is still recoverable by `path` and lexical filters.
  - Source: src/daemon/storage/catalog/sessions-summaries.ts:41; src/daemon/runtime/capture/capture-handler.ts:884
- **AC-6** line 52 - UNMET
  - Quote: Given `sessions` raw events are pruned by retention, when the prune runs, then the derived `memory` summaries are retained.
  - Source: src/daemon/runtime/sessions/prune.ts:5-10
  - Why: The shipped sessions prune tombstones the paired memory summary in the same pass. Retention does not prune sessions while leaving summaries.
- **AC-7** line 53 - MET
  - Quote: Given the `sessions` or `memory` table does not exist, when the first write runs, then it is created from its column-definition array and the write retries once.
  - Source: src/daemon/storage/heal.ts:286; src/daemon/runtime/capture/capture-handler.ts:320
#### library/requirements/completed/prd-003-core-data-model/prd-003-core-data-model-index.md

- **AC-1** line 41 - MET
  - Quote: Given the catalog, when any table is first written, then it is created from its column-definition array and the heal pass converges it to that definition.
  - Source: src/daemon/storage/catalog/types.ts:98-108; src/daemon/storage/heal.ts:286
- **AC-2** line 42 - MET
  - Quote: Given the three memory tables, when their roles are inspected, then `sessions` holds raw events, `memories` holds distilled facts, and `memory` holds VFS and wiki summaries, with no overlap.
  - Source: src/daemon/storage/catalog/sessions-summaries.ts:216-219
- **AC-3** line 43 - MET
  - Quote: Given an engine table, when a row is written, then it carries `agent_id` and `visibility`; given `codebase`, then the row carries explicit `org_id` and `workspace_id`.
  - Source: src/daemon/storage/catalog/memories.ts:76-77; src/daemon/storage/catalog/product.ts:218-219
- **AC-4** line 44 - MET
  - Quote: Given any embedding column, when defined, then it is a nullable 768-dim `FLOAT4[]` tensor column.
  - Source: src/daemon/storage/vector.ts:35; src/daemon/storage/vector.ts:52
#### library/requirements/completed/prd-003-core-data-model/prd-003d-core-data-model-product-tables.md

- **AC-1** line 47 - MET
  - Quote: Given a skill or rule edit, when written, then it INSERTs version N+1 and readers take `ORDER BY version DESC LIMIT 1`.
  - Source: src/daemon/runtime/skillify/skills-write.ts:136-140; src/daemon/runtime/skillify/skills-write.ts:404
- **AC-2** line 48 - MET
  - Quote: Given a codebase snapshot, when stored, then `codebase` carries the `(org, workspace, repo, user, worktree, commit)` identity plus `snapshot_jsonb` and `snapshot_sha256` for dedup and drift detection.
  - Source: src/daemon/storage/catalog/product.ts:218-231
- **AC-3** line 49 - MET
  - Quote: Given a goal or KPI write, when applied, then it is UPDATE-or-INSERT by logical key with one row per key.
  - Source: src/daemon/runtime/product/keyed-engine.ts:273
- **AC-4** line 50 - MET
  - Quote: Given two identical codebase pushes, when the second runs, then `snapshot_sha256` matches and the SELECT-before-INSERT skips the duplicate row.
  - Source: src/daemon/runtime/codebase/push-pull.ts:166-168
- **AC-5** line 51 - MET
  - Quote: Given a `skills` row, when defined, then it carries `scope`, `author`, `contributors`, `source_sessions`, `trigger_text`, `body`, and `version`.
  - Source: src/daemon/storage/catalog/product.ts:90-98
- **AC-6** line 52 - MET
  - Quote: Given a concurrent codebase push race, when both writers run, then the re-verify after INSERT makes the race observable rather than silently double-writing.
  - Source: src/daemon/runtime/codebase/push-pull.ts:169-171
- **AC-7** line 53 - MET
  - Quote: Given any product table does not exist, when the first write runs, then it is created from its column-definition array and the write retries once.
  - Source: src/daemon/storage/heal.ts:286
#### library/requirements/completed/prd-003-core-data-model/prd-003e-core-data-model-agents-auth-telemetry.md

- **AC-1** line 47 - MET
  - Quote: Given an agent, when defined, then `agents` carries `read_policy` (`isolated`, `shared`, `group`) and a `policy_group`.
  - Source: src/daemon/storage/catalog/tenancy.ts:83-84
- **AC-2** line 48 - MET
  - Quote: Given a remote connector credential, when stored, then `api_keys` holds a hashed key with role, scope, optional permission list, and connector/harness/agent binding.
  - Source: src/daemon/storage/catalog/tenancy.ts:128-136
- **AC-3** line 49 - MET
  - Quote: Given an API key is revoked, when the revocation runs, then `revoked` is advanced and the row is retained for audit rather than deleted in place.
  - Source: src/daemon/runtime/auth/api-keys.ts:285-338
- **AC-4** line 50 - MET
  - Quote: Given telemetry is opt-in and a counter is recorded, then no secret or request body is written to any telemetry table.
  - Source: src/daemon/storage/catalog/tenancy.ts:160-166; src/daemon/runtime/telemetry/redact.ts:59-62
- **AC-5** line 51 - MET
  - Quote: Given the router routes a workload, when history is recorded, then the telemetry row carries model, provider, workload, and outcome with prompt content redacted.
  - Source: src/daemon/storage/catalog/routing-history.ts:19-25; src/daemon/storage/catalog/tenancy.ts:206-210
- **AC-6** line 52 - MET
  - Quote: Given a `group` read policy, when scoping resolves, then `policy_group` bounds which agents share visibility.
  - Source: src/daemon/runtime/recall/scope-clause.ts:247-263
- **AC-7** line 53 - MET
  - Quote: Given any of these tables does not exist, when the first write runs, then it is created from its column-definition array and the write retries once.
  - Source: src/daemon/storage/heal.ts:286

### PRD-004

#### library/requirements/completed/prd-004-daemon-runtime/prd-004a-daemon-runtime-http-server.md

- **AC-1** line 47 - MET
  - Quote: Given daemon startup, when the server binds, then it listens on `127.0.0.1:3850` and honors `HONEYCOMB_PORT`/`HONEYCOMB_HOST`/`HONEYCOMB_BIND`.
  - Source: src/shared/constants.ts:14-17; src/daemon/runtime/config.ts:10-12
- **AC-2** line 48 - MET
  - Quote: Given `/health` is requested, when the daemon is up, then it returns liveness, uptime, version, and coarse pipeline status without a heavy DeepLake query.
  - Source: src/daemon/runtime/server.ts:330-348
- **AC-3** line 49 - MET
  - Quote: Given `/api/status` is requested, when the daemon is up, then it returns resolved config, providers, and tenancy.
  - Source: src/daemon/runtime/server.ts:356-387
- **AC-4** line 50 - MET
  - Quote: Given `team` mode, when a protected route is hit without a valid role permission, then permission middleware rejects the request before the handler runs.
  - Source: src/daemon/runtime/middleware/permission.ts:203; src/daemon/runtime/middleware/permission.ts:269
- **AC-5** line 51 - MET
  - Quote: Given `local` mode, when any route is hit, then it is open and the handler runs without a permission check.
  - Source: src/daemon/runtime/middleware/permission.ts:186
- **AC-6** line 52 - MET
  - Quote: Given a scaffolded route group, when a later module attaches a handler, then it inherits the mounted permission middleware without re-wiring.
  - Source: src/daemon/runtime/server.ts:305-309
- **AC-7** line 53 - MET
  - Quote: Given `HONEYCOMB_BIND` widens the bind for a team deployment, when a remote harness connects, then it reaches the daemon over the configured address.
  - Source: src/daemon/runtime/config.ts:146-148
#### library/requirements/completed/prd-004-daemon-runtime/prd-004b-daemon-runtime-job-queue.md

- **AC-1** line 47 - MET
  - Quote: Given a queued job, when a worker leases it, then no other worker can lease it until the lease expires or it is completed/failed.
  - Source: src/daemon/runtime/services/job-queue.ts:568-603
- **AC-2** line 48 - MET
  - Quote: Given a job that fails repeatedly, when it exceeds its retry bound, then it transitions to `dead` rather than retrying forever.
  - Source: src/daemon/runtime/services/job-queue.ts:117; src/daemon/runtime/services/job-queue.ts:799
- **AC-3** line 49 - MET
  - Quote: Given a worker leases a job and crashes, when the reaper interval elapses, then the stale lease is reclaimed and the job becomes leasable again within its retry bounds.
  - Source: src/daemon/runtime/services/job-queue.ts:854-888
- **AC-4** line 50 - MET
  - Quote: Given a failed job with attempts remaining, when it is retried, then `next_run_at` reflects exponential backoff before it becomes leasable.
  - Source: src/daemon/runtime/services/job-queue.ts:329-334; src/daemon/runtime/services/job-queue.ts:817
- **AC-5** line 51 - MET
  - Quote: Given the daemon restarts, when it boots, then queued jobs resume and leases dangling from the prior process are reaped.
  - Source: src/daemon/runtime/services/job-queue.ts:938-953
- **AC-6** line 52 - MET
  - Quote: Given the `memory_jobs` table does not exist, when the first enqueue runs, then it is created from its column-definition array and the write retries once.
  - Source: src/daemon/runtime/services/job-queue.ts:15; src/daemon/storage/catalog/runtime-jobs.ts:92
- **AC-7** line 53 - MET
  - Quote: Given a completed job, when it ages past the completion window, then retention purges it while dead jobs are retained longer.
  - Source: src/daemon/runtime/services/job-queue.ts:900-928
#### library/requirements/completed/prd-004-daemon-runtime/prd-004c-daemon-runtime-file-watcher.md

- **AC-1** line 47 - MET
  - Quote: Given a change to `agent.yaml`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, or `USER.md`, when the watcher fires, then per-harness copies regenerate (e.g. `~/.claude/CLAUDE.md`), each stamped with a do-not-edit header.
  - Source: src/daemon/runtime/services/harness-sync.ts:69-75; src/daemon/runtime/services/harness-sync.ts:36
- **AC-2** line 48 - MET
  - Quote: Given git sync is enabled, when the workspace changes, then the watcher stages and commits with a timestamped message.
  - Source: src/daemon/runtime/services/git-sync.ts:64-80; src/daemon/runtime/services/git-sync.ts:109
- **AC-3** line 49 - MET
  - Quote: Given a burst of edits within the debounce window, when the watcher settles, then exactly one harness sync and one commit run.
  - Source: src/daemon/runtime/services/file-watcher.ts:235; src/daemon/runtime/services/file-watcher.ts:297-315
- **AC-4** line 50 - MET
  - Quote: Given unchanged canonical files, when harness sync runs, then the copies are byte-identical and no spurious commit is made.
  - Source: src/daemon/runtime/services/harness-sync.ts:207-209; src/daemon/runtime/services/file-watcher.ts:267-269
- **AC-5** line 51 - MET
  - Quote: Given git sync is disabled, when the workspace changes, then harness copies regenerate but no commit is made.
  - Source: src/daemon/runtime/services/file-watcher.ts:262-264
- **AC-6** line 52 - MET
  - Quote: Given a canonical file is removed, when the watcher fires, then the corresponding harness copy is reconciled and the watcher keeps running.
  - Source: src/daemon/runtime/services/harness-sync.ts:92-100; src/daemon/runtime/services/harness-sync.ts:143-145
- **AC-7** line 53 - MET
  - Quote: Given the daemon is up, when it runs, then the watcher service is active for the life of the process.
  - Source: src/daemon/runtime/services/file-watcher.ts:167
#### library/requirements/completed/prd-004-daemon-runtime/prd-004-daemon-runtime-index.md

- **AC-1** line 40 - MET
  - Quote: Given the daemon starts, when `/health` is requested, then it returns liveness, uptime, version, and coarse pipeline status; and `/api/status` returns resolved config and providers.
  - Source: src/daemon/runtime/server.ts:330-397
- **AC-2** line 41 - MET
  - Quote: Given a queued job, when a worker leases it and crashes, then the stale lease is reaped and the job becomes available again within its retry bounds.
  - Source: src/daemon/runtime/services/job-queue.ts:844-888
- **AC-3** line 42 - MET
  - Quote: Given a workspace identity file changes, when the watcher fires, then harness copies regenerate with a do-not-edit header and, if git sync is enabled, a timestamped commit is made.
  - Source: src/daemon/runtime/services/harness-sync.ts:28-36; src/daemon/runtime/services/git-sync.ts:109
- **AC-4** line 43 - MET
  - Quote: Given a session already claimed by the `plugin` path, when the `legacy` path requests the same session, then the daemon returns 409 Conflict.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:247; src/daemon/runtime/middleware/runtime-path.ts:313
#### library/requirements/completed/prd-004-daemon-runtime/prd-004d-daemon-runtime-runtime-path.md

- **AC-1** line 47 - MET
  - Quote: Given a session first touched by the `plugin` path, when the `legacy` path requests the same session, then the daemon returns `409 Conflict`.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:166; src/daemon/runtime/middleware/runtime-path.ts:313
- **AC-2** line 48 - MET
  - Quote: Given a claim whose harness has crashed, when the sweep interval elapses past the TTL, then the stale claim expires and the session can be reclaimed.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:111-112; src/daemon/runtime/middleware/runtime-path.ts:134-139
- **AC-3** line 49 - MET
  - Quote: Given the claiming path requests its own session again, when the request runs, then it proceeds and the claim timestamp refreshes.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:160
- **AC-4** line 50 - MET
  - Quote: Given a request without a valid `x-honeycomb-runtime-path`, when it arrives, then it is rejected before any session-scoped handler runs.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:262-268
- **AC-5** line 51 - MET
  - Quote: Given a duplicated-memory triage, when an operator queries the session, then the active claimed path is reported.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:68; src/daemon/runtime/middleware/runtime-path.ts:175
- **AC-6** line 52 - MET
  - Quote: Given a session whose claim has just expired, when either path touches it, then a fresh claim is recorded for that path.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:170
- **AC-7** line 53 - MET
  - Quote: Given the conflict, when `409` is returned, then no capture write has occurred for that request.
  - Source: src/daemon/runtime/middleware/runtime-path.ts:247

### PRD-005

#### library/requirements/completed/prd-005-capture-intake/prd-005a-capture-intake-capture-endpoint.md

- **AC-1** line 49 - MET
  - Quote: Given a posted event, when the endpoint handles it, then it INSERTs one `sessions` row with a `JSONB` `message` and a `path` that groups the conversation.
  - Source: src/daemon/runtime/capture/capture-handler.ts:676-681
- **AC-2** line 50 - MET
  - Quote: Given multiple events in a turn, when each is captured, then each becomes its own row, never concatenated.
  - Source: src/daemon/runtime/capture/capture-handler.ts:320
- **AC-3** line 51 - MET
  - Quote: Given an event, when the row is written, then it carries session id, cwd, permission mode, hook event name, agent_id, org, and workspace.
  - Source: src/daemon/runtime/capture/capture-handler.ts:644-689
- **AC-4** line 52 - MET
  - Quote: Given the sessions table does not exist, when capture runs, then the daemon creates it and retries the INSERT once.
  - Source: src/daemon/runtime/capture/capture-handler.ts:320
- **AC-5** line 53 - MET
  - Quote: Given a turn-terminating event, when capture completes, then the per-turn counters are bumped without the summary or skillify worker running inline.
  - Source: src/daemon/runtime/capture/turn-counters.ts:168; src/daemon/runtime/capture/capture-handler.ts:818
- **AC-6** line 54 - MET
  - Quote: Given a conversation, when its rows are read back, then they are returned ordered by creation_date and scoped to the requesting org/workspace.
  - Source: src/daemon/storage/writes.ts:398; src/daemon/runtime/capture/capture-handler.ts:418-427
#### library/requirements/completed/prd-005-capture-intake/prd-005b-capture-intake-embedding-attach.md

- **AC-1** line 46 - MET
  - Quote: Given embeddings are enabled, when an event is captured, then a 768-dim vector is computed and written to `message_embedding`.
  - Source: src/daemon/runtime/services/embed-client.ts:67; src/daemon/storage/vector.ts:35
- **AC-2** line 47 - MET
  - Quote: Given the embedder is disabled, when capture runs, then the column is left null and the event is still captured and lexically searchable.
  - Source: src/daemon/runtime/capture/capture-handler.ts:884
- **AC-3** line 48 - MET
  - Quote: Given the embedder fails or is unreachable, when capture runs, then the failure is logged, the column is null, and the capture write still succeeds.
  - Source: src/daemon/runtime/capture/capture-handler.ts:886-888
- **AC-4** line 49 - MET
  - Quote: Given embedding attachment is in flight, when the turn completes, then turn completion does not wait on the embed call.
  - Source: src/daemon/runtime/capture/capture-handler.ts:411; src/daemon/runtime/capture/capture-handler.ts:879
- **AC-5** line 50 - MET
  - Quote: Given a returned vector is not 768-dim, when attachment runs, then it is rejected and the column is left null.
  - Source: src/daemon/runtime/services/embed-client.ts:271-273
#### library/requirements/completed/prd-005-capture-intake/prd-005-capture-intake-index.md

- **AC-1** line 39 - MET
  - Quote: Given a turn event, when capture runs, then exactly one `sessions` row is INSERTed with the event as a `JSONB` `message`, never concatenated into an existing row.
  - Source: src/daemon/runtime/capture/capture-handler.ts:640-681
- **AC-2** line 40 - MET
  - Quote: Given embeddings are enabled, when an event is captured, then a 768-dim vector is attached non-blocking; when disabled or failing, the column is null and the event is still captured and lexically searchable.
  - Source: src/daemon/runtime/capture/capture-handler.ts:411; src/daemon/runtime/capture/capture-handler.ts:873-884
- **AC-3** line 41 - MET
  - Quote: Given `HONEYCOMB_CAPTURE=false` or a disabled plugin, when a turn occurs, then capture is skipped.
  - Source: src/shared/capture-gate.ts:125-130
- **AC-4** line 42 - MET
  - Quote: Given a summary or skillify worker running the harness CLI, when it acts, then the recursion guard prevents its activity from being captured as new turns.
  - Source: src/shared/capture-gate.ts:138-141
#### library/requirements/completed/prd-005-capture-intake/prd-005c-capture-intake-capture-guards.md

- **AC-1** line 47 - MET
  - Quote: Given `HONEYCOMB_CAPTURE=false`, when a turn occurs, then capture is skipped and the turn proceeds.
  - Source: src/shared/capture-gate.ts:125-127
- **AC-2** line 48 - MET
  - Quote: Given a disabled plugin, when a turn occurs, then capture is skipped.
  - Source: src/shared/capture-gate.ts:129-130
- **AC-3** line 49 - MET
  - Quote: Given a non-capture entrypoint, when a turn occurs, then capture is skipped.
  - Source: src/shared/capture-gate.ts:135-136
- **AC-4** line 50 - MET
  - Quote: Given a summary or skillify worker running the harness CLI, when it acts, then the recursion guard prevents its activity from being captured as new turns.
  - Source: src/shared/capture-gate.ts:138-141
- **AC-5** line 51 - MET
  - Quote: Given capture errors, when the hook runs, then the hook exits cleanly rather than breaking the turn.
  - Source: src/shared/capture-gate.ts:160-172
- **AC-6** line 52 - MET
  - Quote: Given any guard skips capture, when the turn completes, then no daemon capture request was made and no sessions row was written.
  - Source: src/shared/capture-gate.ts:153-154

### PRD-006

#### library/requirements/completed/prd-006-memory-pipeline/prd-006a-memory-pipeline-extraction.md

- **AC-1** line 49 - MET
  - Quote: Given a raw memory, when extraction runs, then it returns facts (each with confidence 0-1) and entity triples, with chain-of-thought stripped before JSON parsing.
  - Source: src/daemon/runtime/pipeline/extraction.ts:59; src/daemon/runtime/pipeline/extraction.ts:180
- **AC-2** line 50 - MET
  - Quote: Given an oversized input, when extraction runs, then input is capped at ~12,000 characters before the model call.
  - Source: src/daemon/runtime/pipeline/config.ts:49; src/daemon/runtime/pipeline/extraction.ts:314
- **AC-3** line 51 - UNMET
  - Quote: Given an oversized result, when extraction completes, then output is bounded to ~20 facts and ~50 entities with per-fact length limits.
  - Source: src/daemon/runtime/pipeline/config.ts:59; src/daemon/runtime/pipeline/config.ts:61
  - Why: Entities are capped at 50. The default fact cap is 4, not about 20.
- **AC-4** line 52 - MET
  - Quote: Given partially invalid output, when extraction completes, then invalid fields are logged and dropped and partial results are kept rather than failing the job.
  - Source: src/daemon/runtime/pipeline/extraction.ts:180; src/daemon/runtime/pipeline/extraction.ts:341
- **AC-5** line 53 - MET
  - Quote: Given the pipeline is disabled or the extraction provider is `none`, when a job is leased, then extraction does not run.
  - Source: src/daemon/runtime/pipeline/config.ts:96-97; src/daemon/runtime/pipeline/config.ts:358-359
- **AC-6** line 54 - MET
  - Quote: Given a worker crashes mid-job, when the lease goes stale, then the reaper reclaims the job and it is retried.
  - Source: src/daemon/runtime/pipeline/stage-worker.ts:9-13; src/daemon/runtime/services/job-queue.ts:854
#### library/requirements/completed/prd-006-memory-pipeline/prd-006b-memory-pipeline-decision.md

- **AC-1** line 48 - MET
  - Quote: Given an extracted fact with candidates, when the decision stage runs, then it returns add/update/delete/none with a target memory ID, confidence, and reason.
  - Source: src/daemon/runtime/pipeline/decision.ts:144
- **AC-2** line 49 - MET
  - Quote: Given a fact with no candidates, when the stage runs, then it proposes an immediate `add` without a model call.
  - Source: src/daemon/runtime/pipeline/decision.ts:411
- **AC-3** line 50 - MET
  - Quote: Given any proposal, when the stage completes, then the proposal is recorded to `memory_history`.
  - Source: src/daemon/runtime/pipeline/decision.ts:469-480
- **AC-4** line 51 - MET
  - Quote: Given shadow mode, when a proposal is recorded, then it is attributed to the `pipeline-shadow` actor and no memory is written.
  - Source: src/daemon/runtime/pipeline/decision.ts:30-31; src/daemon/runtime/pipeline/decision.ts:480
- **AC-5** line 52 - MET
  - Quote: Given a decision run, when it completes, then no `memories` rows were mutated by this stage.
  - Source: src/daemon/runtime/pipeline/decision.ts:8
#### library/requirements/completed/prd-006-memory-pipeline/prd-006c-memory-pipeline-controlled-writes.md

- **AC-1** line 50 - UNMET
  - Quote: Given an ADD proposal, when controlled writes run, then it is written only if fact confidence clears `minFactConfidenceForWrite` (default 0.7), normalized content is non-empty, and the SHA-256 content hash is not already present.
  - Source: src/daemon/runtime/pipeline/config.ts:82; src/daemon/runtime/pipeline/controlled-writes.ts:452
  - Why: The ADD gate, non-empty content check, and content-hash dedup exist. The configured default confidence is 0.8, not 0.7.
- **AC-2** line 51 - MET
  - Quote: Given an ADD whose content hash already exists, when the stage runs, then the existing memory ID is returned and no duplicate is inserted.
  - Source: src/daemon/runtime/pipeline/controlled-writes.ts:440
- **AC-3** line 52 - MET
  - Quote: Given an UPDATE or DELETE, when the stage runs, then a contradiction check runs, the proposal is flagged for review, and it applies only when `autonomous.allowUpdateDelete` is set, as an append-only version-bumped write.
  - Source: src/daemon/runtime/pipeline/controlled-writes.ts:560-587
- **AC-4** line 53 - MET
  - Quote: Given `shadowMode`, when the stage runs, then no memory is written and proposals are logged only.
  - Source: src/daemon/runtime/pipeline/controlled-writes.ts:422
- **AC-5** line 54 - MET
  - Quote: Given `mutationsFrozen`, when the stage runs, then no memory is written even if shadow mode is off; frozen supersedes shadow.
  - Source: src/daemon/runtime/pipeline/controlled-writes.ts:415
- **AC-6** line 55 - MET
  - Quote: Given any write, when it commits, then embeddings were prefetched beforehand and no network call occurred during the commit.
  - Source: src/daemon/runtime/pipeline/controlled-writes.ts:468-471
#### library/requirements/completed/prd-006-memory-pipeline/prd-006d-memory-pipeline-graph-persistence.md

- **AC-1** line 48 - MET
  - Quote: Given a committed memory, when graph persistence runs, then entities upsert by canonical name, relationships upsert by (source, target, type), and mention links insert-or-ignore.
  - Source: src/daemon/runtime/pipeline/graph-persist.ts:191-196; src/daemon/runtime/pipeline/graph-persist.ts:455-468
- **AC-2** line 49 - MET
  - Quote: Given the same memory is reprocessed, when graph persistence runs again, then no duplicate entities, relationships, or mention links are created.
  - Source: src/daemon/runtime/pipeline/graph-persist.ts:193-214
- **AC-3** line 50 - MET
  - Quote: Given graph persistence fails, when the pipeline continues, then a warning is logged and the facts already written are not reverted.
  - Source: src/daemon/runtime/pipeline/graph-persist.ts:549-556
- **AC-4** line 51 - MET
  - Quote: Given `graph.enabled` or `graph.extractionWritesEnabled` is off, when the pipeline runs, then no graph rows are written.
  - Source: src/daemon/runtime/pipeline/graph-persist.ts:441-445
- **AC-5** line 52 - UNMET
  - Quote: Given any graph write, when it commits, then the row carries org, workspace, and agent scope.
  - Source: src/daemon/runtime/pipeline/graph-persist.ts:453; src/daemon/runtime/pipeline/graph-persist.ts:229
  - Why: Org and workspace ride QueryScope. The agent_id column is filled from scope.workspace, and the stage job's agentId is not used.
#### library/requirements/completed/prd-006-memory-pipeline/prd-006e-memory-pipeline-retention.md

- **AC-1** line 48 - MET
  - Quote: Given retention runs, when the sweep executes, then it purges in order (graph links, embeddings, tombstones, history, completed jobs, dead jobs) within a per-run batch limit.
  - Source: src/daemon/runtime/pipeline/retention.ts:255-275
- **AC-2** line 49 - MET
  - Quote: Given retention is interrupted, when it runs again, then the sweep is idempotent and resumes safely without double-purging.
  - Source: src/daemon/runtime/pipeline/retention.ts:41-42
- **AC-3** line 50 - MET
  - Quote: Given a purged row owns embeddings or vectors, when retention runs, then those vectors are purged with the row and not orphaned.
  - Source: src/daemon/runtime/pipeline/retention.ts:373-403
- **AC-4** line 51 - MET
  - Quote: Given `autonomous.enabled` is off, when the scheduler fires, then retention does not run.
  - Source: src/daemon/runtime/pipeline/retention.ts:214
- **AC-5** line 52 - MET
  - Quote: Given `autonomous.frozen` is set, when retention is running or scheduled, then it halts and performs no further purges.
  - Source: src/daemon/runtime/pipeline/retention.ts:216-218
- **AC-6** line 53 - MET
  - Quote: Given a per-run batch limit, when a sweep reaches it, then the worker stops and yields rather than continuing.
  - Source: src/daemon/runtime/pipeline/retention.ts:227-237
#### library/requirements/completed/prd-006-memory-pipeline/prd-006-memory-pipeline-index.md

- **AC-1** line 60 - MET
  - Quote: Given a raw memory, when extraction runs, then it produces bounded facts (with confidence) and entity triples, dropping invalid fields as warnings rather than failing the job.
  - Source: src/daemon/runtime/pipeline/extraction.ts:23; src/daemon/runtime/pipeline/extraction.ts:180
- **AC-2** line 61 - MET
  - Quote: Given an extracted fact, when the decision stage runs, then it records an add/update/delete/none proposal to `memory_history` with target ID, confidence, and reason.
  - Source: src/daemon/runtime/pipeline/decision.ts:396-411
- **AC-3** line 62 - MET
  - Quote: Given an ADD proposal, when controlled writes run, then it is written only if fact confidence clears the threshold, content is non-empty, and the content hash is not already present.
  - Source: src/daemon/runtime/pipeline/controlled-writes.ts:452; src/daemon/runtime/pipeline/controlled-writes.ts:440
- **AC-4** line 63 - MET
  - Quote: Given `shadowMode` or `mutationsFrozen`, when the pipeline runs, then proposals are logged but no memory is written.
  - Source: src/daemon/runtime/pipeline/controlled-writes.ts:415-422
- **AC-5** line 64 - MET
  - Quote: Given graph persistence fails, when the pipeline continues, then the facts already written are not reverted.
  - Source: src/daemon/runtime/pipeline/graph-persist.ts:528-556

### PRD-007

#### library/requirements/completed/prd-007-retrieval/prd-007a-retrieval-candidate-collection.md

- **AC-1** line 49 - MET
  - Quote: Given a query, when collection runs, then FTS returns BM25-style scores normalized to 0-1 with IDs only and no content.
  - Source: src/daemon/runtime/recall/collection.ts:162-191
- **AC-2** line 50 - MET
  - Quote: Given a query, when the vector channel runs, then it returns GPU similarity over the 768-dim columns and over-fetches for scoped recalls.
  - Source: src/daemon/runtime/recall/collection.ts:16-18; src/daemon/storage/vector.ts:259
- **AC-3** line 51 - MET
  - Quote: Given the embed daemon is off, when collection runs, then the vector channel is skipped and recall returns lexical candidates without error.
  - Source: src/daemon/runtime/recall/collection.ts:19-21
- **AC-4** line 52 - MET
  - Quote: Given write-time hints, when the hints channel runs, then matches are capped so a memory cannot ride in on hints alone.
  - Source: src/daemon/runtime/recall/collection.ts:321
- **AC-5** line 53 - MET
  - Quote: Given multiple channels, when they merge, then they merge by memory ID with the strongest calibrated score winning unless blended.
  - Source: src/daemon/runtime/recall/contracts.ts:213
- **AC-6** line 54 - MET
  - Quote: Given any raw query, when it is prepared, then it is escaped through the SQL helpers and the original natural-language string is preserved for the vector path.
  - Source: src/daemon/runtime/recall/collection.ts:152-158
- **AC-7** line 55 - MET
  - Quote: Given collected candidates, when the phase ends, then per-channel signal provenance is attached and no content row has been loaded.
  - Source: src/daemon/runtime/recall/collection.ts:196; src/daemon/runtime/recall/collection.ts:326
#### library/requirements/completed/prd-007-retrieval/prd-007b-retrieval-graph-traversal.md

- **AC-1** line 48 - UNMET
  - Quote: Given a query, when focal resolution runs, then it resolves in order: pinned, checkpoint IDs, project-path, entity FTS tokens, then session-key fallback.
  - Source: ABSENT
  - Why: The five-phase RecallEngine, including the traversal walk and focal resolver, was removed. Config knobs remain. No walk implements the focal order.
- **AC-2** line 49 - UNMET
  - Quote: Given the graph is disabled, when traversal runs, then it is skipped and contributes no candidates without error.
  - Source: ABSENT
  - Why: There is no traversal channel on the live recall path to skip. graphEnabled in recall config is unused by a walk.
- **AC-3** line 50 - UNMET
  - Quote: Given a focal set, when the walk runs, then it honors caps on aspects, attributes, branching, and total IDs.
  - Source: ABSENT
  - Why: Traversal caps exist only as zod defaults in recall config. No walk honors them.
- **AC-4** line 51 - UNMET
  - Quote: Given a low strength-times-confidence edge, when the walk evaluates it, then the edge is not followed.
  - Source: ABSENT
  - Why: edgeClearsThreshold exists and is unit-tested, and it has no production caller. Nothing follows or skips edges during recall.
- **AC-5** line 52 - UNMET
  - Quote: Given an active constraint under a focal entity, when caps trim the walk, then the constraint is still surfaced.
  - Source: ABSENT
  - Why: No walk surfaces constraints under a cap.
- **AC-6** line 53 - UNMET
  - Quote: Given a dense graph, when the timeout fires, then the walk returns collected IDs with the timeout flag rather than failing.
  - Source: ABSENT
  - Why: No walk returns a timeout flag.
- **AC-7** line 54 - UNMET
  - Quote: Given the walk completes, then it returns IDs with scores and paths, constraints, an entity count, and the timeout flag, and no content was loaded.
  - Source: ABSENT
  - Why: No traversal result object (IDs, scores, paths, constraints, entity count, timeout flag) is produced.
#### library/requirements/completed/prd-007-retrieval/prd-007c-retrieval-authorization.md

- **AC-1** line 47 - UNMET
  - Quote: Given collected candidate IDs, when authorization runs, then the engine re-queries with the org/workspace partition and the `agent_id` read-policy clause plus caller filters.
  - Source: ABSENT
  - Why: No phase re-queries collected candidate IDs. buildScopeClause has no production caller outside its own file.
- **AC-2** line 48 - UNMET
  - Quote: Given an `isolated` agent, when authorization runs, then only its own non-archived memories survive.
  - Source: src/daemon/runtime/recall/scope-clause.ts:236; src/daemon/runtime/memories/recall.ts:587-590
  - Why: The isolated SQL fragment exists in buildScopeClause. Live recall SQL filters is_deleted and an optional project clause, not agent_id = self.
- **AC-3** line 49 - UNMET
  - Quote: Given a `group` agent, when authorization runs, then global memories from same-`policy_group` agents plus its own survive, archived excluded.
  - Source: src/daemon/runtime/recall/scope-clause.ts:247-263
  - Why: The group SQL fragment exists in buildScopeClause and is not applied by recallMemories.
- **AC-4** line 50 - UNMET
  - Quote: Given an unauthorized candidate, when the boundary applies, then it is dropped before any content loads.
  - Source: src/daemon/runtime/memories/recall.ts:588
  - Why: Live lexical arms project content text in the same SELECT as the match. There is no ID-only authorization boundary before content load.
- **AC-5** line 51 - UNMET
  - Quote: Given a malformed agent id, when authorization runs, then it falls back to `isolated` and returns a structured error context, never a wider policy.
  - Source: src/daemon/runtime/recall/scope-clause.ts:210-217
  - Why: buildScopeClause falls back to isolated on a blank agent id. That function is not called by the live recall path, so a malformed caller is not failed closed there.
- **AC-6** line 52 - MET
  - Quote: Given a buggy inner clause, when a cross-workspace ID is present, then the storage partition still prevents it from surfacing.
  - Source: src/daemon/storage/client.ts:42-44; src/daemon/storage/client.ts:581
- **AC-7** line 53 - UNMET
  - Quote: Given a VFS browse request, when content is requested, then the same scope clause authorizes rows before any content returns.
  - Source: src/daemon/runtime/vfs/api.ts:372
  - Why: VFS grep reuses collectCandidates. It does not call buildScopeClause before hydrating content.
#### library/requirements/completed/prd-007-retrieval/prd-007d-retrieval-shaping.md

- **AC-1** line 48 - UNMET
  - Quote: Given a result with mixed signals, when convolution runs, then no single channel dominates and facet coverage prefers broader-covering results.
  - Source: ABSENT
  - Why: The shaping phase (convolution, facet coverage) was removed with the five-phase engine. Live fusion is RRF, which is a different contract.
- **AC-2** line 49 - MET
  - Quote: Given a reranker timeout, when shaping runs, then the original order is kept rather than failing the recall.
  - Source: src/daemon/runtime/memories/recall.ts:1799-1801
- **AC-3** line 50 - UNMET
  - Quote: Given a superseded claim, when currentness runs, then it is downweighted so the current claim-slot value (by `group_key` + `claim_key`) outranks the value it replaced.
  - Source: ABSENT
  - Why: No currentness pass downweights entity_attributes by group_key and claim_key. Live recall excludes is_deleted = 1 and uses highest-version reads elsewhere.
- **AC-4** line 51 - UNMET
  - Quote: Given a semantic hit sharing no query terms, when gravity dampening runs, then it is penalized.
  - Source: ABSENT
  - Why: gravity dampening is a config default only. No scorer applies it.
- **AC-5** line 52 - UNMET
  - Quote: Given a result hung off a very high-degree entity, when hub dampening runs, then it is penalized.
  - Source: ABSENT
  - Why: hub dampening is a config default only. No scorer applies it.
- **AC-6** line 53 - UNMET
  - Quote: Given a decision or constraint memory, when resolution dampening runs, then it is boosted.
  - Source: ABSENT
  - Why: resolutionBoost is a config default only. No scorer boosts decision or constraint memories.
- **AC-7** line 54 - UNMET
  - Quote: Given shaping completes, then calibrated scores are preserved for the confidence gate and no unauthorized row was introduced.
  - Source: ABSENT
  - Why: There is no shaping phase that preserves calibrated scores for a confidence gate, and live recall does not apply the agent read-policy clause.
#### library/requirements/completed/prd-007-retrieval/prd-007e-retrieval-confidence-gate.md

- **AC-1** line 47 - UNMET
  - Quote: Given shaped results, when the gate runs, then context is injected only if the reranker-calibrated top score clears the minimum.
  - Source: ABSENT
  - Why: No injection gate. minInjectionScore is parsed in recall config and has no caller.
- **AC-2** line 48 - UNMET
  - Quote: Given the calibrated scores, when the gate decides, then scores are preserved from shaping, not synthesized from rank.
  - Source: ABSENT
  - Why: No gate preserves or synthesizes an injection score. Recall returns RRF-ranked hits.
- **AC-3** line 49 - UNMET
  - Quote: Given nothing clears the minimum, when the hook returns, then an empty injection is returned as a valid answer, not a failure.
  - Source: ABSENT
  - Why: Recall returns ranked hits with a degraded flag. It does not return an empty injection as a distinct valid answer.
- **AC-4** line 50 - UNMET
  - Quote: Given surviving IDs, when they are hydrated, then the same scope filter applies and the caller's limit caps the primary results.
  - Source: ABSENT
  - Why: Hydration is the recall SELECT itself, not a post-gate scope re-query. The caller limit is applied, but not behind the removed gate.
- **AC-5** line 51 - UNMET
  - Quote: Given hydration completes, when access is tracked, then only primary results are tracked.
  - Source: ABSENT
  - Why: The confidence gate that hydrated survivors and tracked only primary results is absent. Live recall has no primary-versus-supplementary split.
- **AC-6** line 52 - UNMET
  - Quote: Given supplementary cards, when they ride along, then each is marked synthetic and distinguishable from ordinary rows.
  - Source: ABSENT
  - Why: No supplementary synthetic cards are attached by a gate.
- **AC-7** line 53 - UNMET
  - Quote: Given a per-agent threshold override, when the gate runs, then that agent's configured minimum is applied.
  - Source: ABSENT
  - Why: The per-agent minimum lives only as the unused minInjectionScore config field.
#### library/requirements/completed/prd-007-retrieval/prd-007-retrieval-index.md

- **AC-1** line 67 - MET
  - Quote: Given a query, when recall runs, hybrid candidate collection executes the lexical arms (BM25/ILIKE over `memories`/`memory`/`sessions`, each a guarded per-arm query that fails soft) and  -  when an embed client is available and the query embeds to a 768-dim vector  -  the semantic `<#>` cosine arm over `content_embedding`/`message_embedding`; the arms are fused by reciprocal-rank fusion and deduped by `source+id` (`memories/recall.ts:565`). *(007a candidate collection also remains live behind the VFS browse seam, `recall/collection.ts` via `vfs/api.ts`.)*
  - Source: src/daemon/runtime/memories/recall.ts:573-591; src/daemon/runtime/memories/recall.ts:770
- **AC-2** line 68 - MET
  - Quote: Given a recall request, tenancy is enforced by the storage-partition `QueryScope` (org/workspace) carried on every `storage.query` call: a request reads only within its resolved tenant, resolved fail-closed from `x-honeycomb-*` headers before the engine runs (`memories/api.ts:296-318`). The canonical inner-ring read-policy chokepoint `buildScopeClause` (`recall/scope-clause.ts`) is retained and proven by the PRD-011a/011e suites + the live `recall-authz-live.itest.ts`. *(De-scoped: the five-phase authorization re-query that pruned a wide candidate pool before content load  -  there is no separate candidate-pool/content-load split on the live path.)*
  - Source: src/daemon/storage/client.ts:42-44; src/daemon/runtime/memories/recall.ts:50-54
- **AC-3** line 69 - MET
  - Quote: Given a superseded or forgotten memory, the current value outranks/replaces the stale one via the append-only highest-version + soft-delete model (`is_deleted = 0` on the recall arms, highest-version reads in `memories/reads.ts`) and PRD-008 supersession-on-read of `entity_attributes` (`ontology/supersede.ts`, `buildHighestActiveVersionSql`). *(De-scoped: a dedicated shaping "currentness" downweight phase  -  redundant with the read models above, and it operated on `entity_attributes`, a table the live recall arms do not even search.)*
  - Source: src/daemon/runtime/memories/recall.ts:560-590; src/daemon/runtime/ontology/supersede.ts:187
- **AC-4** line 70 - MET
  - Quote: Given a query, recall returns the RRF-ranked hits ordered by fused score with an honest `degraded` flag (true when the semantic arm did not run); raw ranked recall is the contract every consumer (MCP `memory_search`/`hivemind_search`, SDK `recall()`, dashboard, CLI) reads (`{ hits, sources, degraded }`). *(De-scoped: a confidence/injection gate returning `{ injected, hits[] }` with an empty-injection answer  -  no consumer wanted an inject/empty decision; raw ranked recall is preferred.)*
  - Source: src/daemon/runtime/memories/recall.ts:217; src/daemon/runtime/memories/recall.ts:446

### PRD-008

#### library/requirements/completed/prd-008-knowledge-graph-ontology/prd-008a-knowledge-graph-ontology-entity-model.md

- **AC-1** line 49 - MET
  - Quote: Given new memory content, when the inline linker runs, then it scans for proper nouns and links to entities that already exist for the agent, creating nothing and calling no model.
  - Source: src/daemon/runtime/ontology/entity-model.ts:412; src/daemon/runtime/ontology/entity-model.ts:518-520
- **AC-2** line 50 - MET
  - Quote: Given the linker runs, when it executes, then it performs no network I/O and is safe to run right after the memory commit.
  - Source: src/daemon/runtime/ontology/entity-model.ts:495
- **AC-3** line 51 - UNMET
  - Quote: Given an entity attribute, when stored, then it carries `kind`, `status`, confidence, importance, version lineage, and provenance back to the memory and proposal.
  - Source: src/daemon/runtime/ontology/entity-model.ts:303-325
  - Why: kind, status, confidence, importance, version, and memory_id are written. proposalId and source are explicitly discarded, and entity_attributes has no proposal_id column.
- **AC-4** line 52 - MET
  - Quote: Given an aspect, when retrieval confirms it, then its weight rises, and when it goes stale, its weight decays toward a floor.
  - Source: src/daemon/runtime/ontology/entity-model.ts:352-366
- **AC-5** line 53 - MET
  - Quote: Given a claim value, when stored, then it lives in an addressable `group_key`/`claim_key` slot under its aspect.
  - Source: src/daemon/runtime/ontology/entity-model.ts:314-315
- **AC-6** line 54 - MET
  - Quote: Given any write, when it executes, then it is scoped by org, workspace, and `agent_id` and never links across the agent boundary.
  - Source: src/daemon/runtime/ontology/entity-model.ts:119; src/daemon/runtime/ontology/entity-model.ts:518
- **AC-7** line 55 - MET
  - Quote: Given any interpolated name, key, or value, when a statement is built, then it is escaped through the SQL helpers.
  - Source: src/daemon/runtime/ontology/entity-model.ts:303-319
#### library/requirements/completed/prd-008-knowledge-graph-ontology/prd-008b-knowledge-graph-ontology-dependencies-supersession.md

- **AC-1** line 49 - MET
  - Quote: Given a new attribute in the same entity/aspect/group/claim slot, when supersession runs, then the conflicting sibling is marked superseded (status and `superseded_by` advanced via the append-only version-bumped path), not deleted or mutated.
  - Source: src/daemon/runtime/ontology/supersede.ts:187; src/daemon/runtime/ontology/supersede.ts:342
- **AC-2** line 50 - MET
  - Quote: Given concurrent edits, when supersession runs, then no claim attribute is mutated in place and full version history remains on disk.
  - Source: src/daemon/runtime/ontology/supersede.ts:23
- **AC-3** line 51 - MET
  - Quote: Given a loose `related_to` edge, when written, then it carries type, strength, confidence, and a required reason.
  - Source: src/daemon/runtime/ontology/dependencies.ts:358
- **AC-4** line 52 - UNMET
  - Quote: Given an edge, when traversal evaluates it, then it is followed only when strength times confidence clears the threshold.
  - Source: src/daemon/runtime/ontology/dependencies.ts:293-299
  - Why: The strength-times-confidence predicate exists and is tested. No production traversal evaluates edges, so the follow rule never runs.
- **AC-5** line 53 - MET
  - Quote: Given a constraint, when a conflicting value arrives, then the constraint is not auto-superseded.
  - Source: src/daemon/runtime/ontology/dependencies.ts:420-421
- **AC-6** line 54 - MET
  - Quote: Given a conflict, when detection runs, then it uses lexical overlap plus negation and antonym signals with an optional LLM fallback.
  - Source: src/daemon/runtime/ontology/dependencies.ts:234-280
- **AC-7** line 55 - MET
  - Quote: Given any write, when a statement is built, then values are escaped through the SQL helpers and the write goes through the daemon.
  - Source: src/daemon/runtime/ontology/dependencies.ts:358
#### library/requirements/completed/prd-008-knowledge-graph-ontology/prd-008c-knowledge-graph-ontology-control-plane.md

- **AC-1** line 49 - MET
  - Quote: Given a bounded explicit operation, when submitted, then it applies directly and writes an applied proposal row with evidence copied onto the resulting attribute and dependency rows.
  - Source: src/daemon/runtime/ontology/control-plane.ts:388
- **AC-2** line 50 - MET
  - Quote: Given a broad, risky, or generated batch change, when submitted, then it enters the pending review queue instead of applying.
  - Source: src/daemon/runtime/ontology/control-plane.ts:413-416
- **AC-3** line 51 - MET
  - Quote: Given any structural change, when graph rows change, then raw source artifacts and transcripts are never rewritten.
  - Source: src/daemon/runtime/ontology/control-plane.ts:277; src/daemon/runtime/ontology/control-plane.ts:284
- **AC-4** line 52 - MET
  - Quote: Given a supersede operation, when applied, then it uses the append-only version-bumped path, not an in-place update.
  - Source: src/daemon/runtime/ontology/control-plane.ts:336-338
- **AC-5** line 53 - MET
  - Quote: Given an epistemic assertion, when stored, then it carries a predicate, content, speaker, confidence, evidence, and status, and does not auto-promote into ontology truth.
  - Source: src/daemon/runtime/ontology/control-plane.ts:453-460
- **AC-6** line 54 - MET
  - Quote: Given a proposal, when recorded, then it carries operation, status, `jsonb` payload, confidence, rationale, evidence, risk note, and source provenance.
  - Source: src/daemon/runtime/ontology/contracts.ts:252; src/daemon/storage/catalog/knowledge-graph.ts:255-259
- **AC-7** line 55 - MET
  - Quote: Given a CLI invocation (e.g. `stream apply --dry-run`), when run, then it is scoped by org/workspace/agent and reports the planned change without mutating on dry-run.
  - Source: src/cli/ontology.ts:171-180; src/daemon/runtime/ontology/control-plane.ts:542
#### library/requirements/completed/prd-008-knowledge-graph-ontology/prd-008-knowledge-graph-ontology-index.md

- **AC-1** line 51 - MET
  - Quote: Given new memory content, when the inline linker runs, then it links proper nouns to existing agent entities synchronously, creating nothing, calling no model, and doing no network I/O.
  - Source: src/daemon/runtime/ontology/entity-model.ts:504-520
- **AC-2** line 52 - MET
  - Quote: Given a conflicting claim in the same entity/aspect/group/claim slot, when supersession runs, then the new attribute is appended with a fresh version and the prior sibling is marked superseded rather than mutated in place.
  - Source: src/daemon/runtime/ontology/supersede.ts:187; src/daemon/runtime/ontology/supersede.ts:342
- **AC-3** line 53 - UNMET
  - Quote: Given a loose `related_to` edge, when it is written, then it carries a required reason, and traversal follows it only when strength times confidence clears the threshold.
  - Source: src/daemon/runtime/ontology/dependencies.ts:358; src/daemon/runtime/ontology/dependencies.ts:293
  - Why: A loose related_to write requires a reason. Nothing in production traversal follows or refuses the edge. edgeClearsThreshold has no caller outside tests.
- **AC-4** line 54 - MET
  - Quote: Given a deliberate structural change, when it is submitted, then bounded explicit operations apply directly with an applied proposal row, while risky or broad changes enter the pending review queue.
  - Source: src/daemon/runtime/ontology/control-plane.ts:148-162
