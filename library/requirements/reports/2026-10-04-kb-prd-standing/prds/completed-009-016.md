# Standing report: completed PRD-009 through PRD-016

Wave 1b shard. Read-only against current source. No PRD or product source was edited. No commit. No folder move.

Method: every acceptance-criterion row in the index and lettered children, plus the QA notes, under `library/requirements/completed/` for PRD-009 through PRD-016. Build outputs and `node_modules` were skipped. A criterion is MET when current source implements the stated behavior on a path production can reach (daemon assembly, CLI dispatch, or the hook that owns that behavior). A function that exists only for tests, or a route the composition root never mounts, is UNMET, and the evidence says ABSENT for the live entry. June 2026 QA PASS lines are context, not the verdict.

## Summary

| PRD | Folder | Criteria | Met | Unmet | Recommended bucket |
|---|---|---:|---:|---:|---|
| 009 | `prd-009-pollinating-loop` | 20 | 14 | 6 | in-work |
| 010 | `prd-010-model-provider-router` | 26 | 14 | 12 | in-work |
| 011 | `prd-011-tenancy-and-auth` | 34 | 21 | 13 | in-work |
| 012 | `prd-012-secrets` | 15 | 8 | 7 | in-work |
| 013 | `prd-013-sources-and-documents` | 34 | 33 | 1 | in-work |
| 014 | `prd-014-codebase-graph` | 28 | 28 | 0 | completed |
| 015 | `prd-015-virtual-filesystem` | 15 | 3 | 12 | in-work |
| 016 | `prd-016-skillify` | 21 | 19 | 2 | in-work |

Criteria: 193. Unmet: 53. Unverifiable: 0.

Child PRD status lines still say Draft while each parent index says Completed. That is a status-line defect for a later librarian. It is not an acceptance criterion.

## Files read

- `library/requirements/completed/prd-009-pollinating-loop/prd-009-pollinating-loop-index.md`
- `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md`
- `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md`
- `library/requirements/completed/prd-009-pollinating-loop/prd-009c-pollinating-loop-compaction-mode.md`
- `library/requirements/completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md`
- `library/requirements/completed/prd-010-model-provider-router/prd-010a-model-provider-router-config-contract.md`
- `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md`
- `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md`
- `library/requirements/completed/prd-010-model-provider-router/prd-010d-model-provider-router-route-cli.md`
- `library/requirements/completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md`
- `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md`
- `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md`
- `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md`
- `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md`
- `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md`
- `library/requirements/completed/prd-012-secrets/prd-012-secrets-index.md`
- `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md`
- `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md`
- `library/requirements/completed/prd-013-sources-and-documents/prd-013-sources-and-documents-index.md`
- `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md`
- `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md`
- `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md`
- `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md`
- `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md`
- `library/requirements/completed/prd-014-codebase-graph/prd-014-codebase-graph-index.md`
- `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md`
- `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md`
- `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md`
- `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md`
- `library/requirements/completed/prd-015-virtual-filesystem/prd-015-virtual-filesystem-index.md`
- `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md`
- `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md`
- `library/requirements/completed/prd-016-skillify/prd-016-skillify-index.md`
- `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md`
- `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md`
- `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md`
- `library/requirements/completed/prd-009-pollinating-loop/reports/2026-06-17-qa-report.md`
- `library/requirements/completed/prd-010-model-provider-router/reports/2026-06-17-qa-report.md`
- `library/requirements/completed/prd-011-tenancy-and-auth/reports/2026-06-17-qa-report.md`
- `library/requirements/completed/prd-012-secrets/reports/2026-06-18-qa-report.md`
- `library/requirements/completed/prd-013-sources-and-documents/reports/2026-06-18-qa-report.md`
- `library/requirements/completed/prd-014-codebase-graph/reports/2026-06-18-qa-report.md`
- `library/requirements/completed/prd-014-codebase-graph/reports/2026-06-22-qa-report.md`
- `library/requirements/completed/prd-015-virtual-filesystem/reports/2026-06-18-qa-report.md`
- `library/requirements/completed/prd-016-skillify/reports/2026-06-18-qa-report.md`

## PRD-009 Pollinating Loop

Recommended bucket: **in-work**.

The token counter, maintenance tick, control-plane apply, and gated worker are in the daemon. Live `honeycomb pollinate trigger --compact` does not force a compaction job, the runner does not capture a transcript or load identity files, and the graph-query tool is never constructed. Hold the folder in in-work until those criteria are on the dispatched path.

QA note: library/requirements/completed/prd-009-pollinating-loop/reports/2026-06-17-qa-report.md claimed the criteria and recorded deferred assembly, an identity-file loader, and a CLI-only `--compact` pending-job gap. Those deferrals are still visible.

### `library/requirements/completed/prd-009-pollinating-loop/prd-009-pollinating-loop-index.md`

#### AC-1

- Quote: Given session-summary writes that push `pollinating_state` past `tokenThreshold`, when the next maintenance tick runs, then a pollinating job is queued and the counter resets.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009-pollinating-loop-index.md:54`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/trigger.ts:397 enqueues one job then subtracts tokenThreshold; tick wired at src/daemon/runtime/assemble.ts:4447; summary writes increment at src/daemon/runtime/assemble.ts:2605

#### AC-2

- Quote: Given a returned mutation set with a destructive op, when it is applied, then the change routes through the ontology control plane with provenance and risky ops land in pending review rather than applying blind.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009-pollinating-loop-index.md:55`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/runner.ts:274 maps each mutation through submitProposal with provenance source pollinating; merge/archive stay out of DIRECT_APPLY at src/daemon/runtime/ontology/control-plane.ts:101

#### AC-3

- Quote: Given `honeycomb pollinate trigger --compact`, when it runs, then the agent loads the full entity graph and emits merge/prune mutations across the whole graph in one pass.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009-pollinating-loop-index.md:56`
- Verdict: UNMET
- Evidence: src/commands/pollinate.ts:147 posts {mode:compaction} to /api/diagnostics/pollinate. src/daemon/runtime/pollinating/api.ts:291 ignores the body and calls checkAndEnqueuePollinating, which still requires tokenThreshold at src/daemon/runtime/pollinating/trigger.ts:393 and defaults mode to incremental. src/cli/pollinate.ts:157 would enqueue compaction regardless of the counter, but src/commands/dispatch.ts:359 dispatches runPollinateVerb, so that module is off the live verb.

### `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md`

#### AC-1

- Quote: Given a session-summary write, when it completes, then `pollinating_state.tokens_since_last_pass` increases by the summary's token count.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md:47`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/trigger.ts:310 adds the summary token count onto tokens_since_last_pass via an append-only version

#### AC-2

- Quote: Given the counter crosses `tokenThreshold`, when the maintenance loop ticks, then exactly one pollinating job is queued and the counter resets to zero.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md:48`
- Verdict: UNMET
- Evidence: src/daemon/runtime/pollinating/trigger.ts:407 sets tokens_since_last_pass to current minus tokenThreshold (floored at 0 in appendVersion). The criterion requires a reset to zero. A counter above the threshold by any surplus stays above zero.

#### AC-3

- Quote: Given a pass already pending for a scope, when the counter crosses the threshold again, then no second job is enqueued until the first reaches a terminal state.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/trigger.ts:372 returns skipped while pendingJobId is non-empty and the job is not terminal

#### AC-4

- Quote: Given `memory.pollinating.enabled: false`, when summaries are written past the threshold, then the counter still grows but no job is queued.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/trigger.ts:388 returns disabled and does not enqueue; incrementPollinatingCounter at trigger.ts:310 still runs when enabled is false

#### AC-5

- Quote: Given a daemon restart between summary writes, when it comes back up, then `tokens_since_last_pass` reflects all writes that committed before the restart.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/trigger.ts:232 reads the highest-version pollinating_state row from storage, so a restart sees committed writes

#### AC-6

- Quote: Given two `agent_id`s under the same workspace, when summaries are written, then each scope accumulates its own counter independently.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009a-pollinating-loop-trigger.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/trigger.ts:139 derives the row id from agentId, so two agents under one workspace are separate counters

### `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md`

#### AC-1

- Quote: Given a queued pass, when it starts, then it loads identity files, new summaries since the last pass, a graph snapshot, and the `POLLINATING.md` task prompt, and captures a transcript.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md:49`
- Verdict: UNMET
- Evidence: Incremental load of summaries and a changed-graph snapshot is at src/daemon/runtime/pollinating/incremental.ts:460. The production identity source is defaultPollinatingIdentitySource at incremental.ts:124, which returns identityFiles: []. POLLINATING.md is the in-code string at incremental.ts:110, and the worker does not pass another identitySource (src/daemon/runtime/pollinating/worker.ts:290). No pollinating path writes a session transcript. ABSENT transcript capture.

#### AC-2

- Quote: Given a returned mutation set, when it is applied, then each op routes through the ontology control plane with provenance and destructive ops land in pending review.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/runner.ts:274 submits every mutation through submitProposal with provenance; operations outside DIRECT_APPLY at src/daemon/runtime/ontology/control-plane.ts:101 land in pending review

#### AC-3

- Quote: Given an incremental pass, when payload is assembled, then only post-`last_pass_at` summaries and changed entities/attributes are loaded, with a graph query tool available.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md:51`
- Verdict: UNMET
- Evidence: Post-last_pass_at summaries and changed graph rows load at src/daemon/runtime/pollinating/incremental.ts:223 and incremental.ts:256. createGraphQueryTool at incremental.ts:374 has no caller in src. loadPayload only inserts a sentence claiming the tool exists (incremental.ts:481). The runner calls model.complete with a string (src/daemon/runtime/pollinating/runner.ts:213). ABSENT invocable graph-query tool.

#### AC-4

- Quote: Given a `merge_entities` op, when applied, then prior rows are advanced in status on the append-only path and remain on disk with lineage intact.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md:52`
- Verdict: UNMET
- Evidence: merge_entities maps to entity.merge at src/daemon/runtime/pollinating/contracts.ts:146. entity.merge is outside DIRECT_APPLY (src/daemon/runtime/ontology/control-plane.ts:101), so the runner queues it and does not advance prior rows on the append-only supersede path. claim.supersede does that advance in src/daemon/runtime/ontology/supersede.ts:197, which is a different mutation kind.

#### AC-5

- Quote: Given a successful pass, when it finishes, then `last_pass_at` is updated and `pending_job_id` is cleared.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/runner.ts:305 stamps last_pass_at and clears pending_job_id through recordPassComplete at src/daemon/runtime/pollinating/trigger.ts:335

#### AC-6

- Quote: Given the model call, when routing resolves, then it uses the pollinating workload's stronger target, not the extraction target.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009b-pollinating-loop-session-runner.md:54`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/runner.ts:154 calls workload memory_pollinating; extraction is a separate workload in src/daemon/runtime/pipeline/model-client.ts:38

### `library/requirements/completed/prd-009-pollinating-loop/prd-009c-pollinating-loop-compaction-mode.md`

#### AC-1

- Quote: Given `backfillOnFirstRun: true` and no prior pass, when pollinating first runs, then it enters compaction mode and walks the full graph instead of the incremental payload.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009c-pollinating-loop-compaction-mode.md:46`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/compaction.ts:340 enters compaction when backfillOnFirstRun is true and last_pass_at is empty; the worker selects that strategy at src/daemon/runtime/pollinating/worker.ts:301 and loads the full graph at compaction.ts:385

#### AC-2

- Quote: Given `honeycomb pollinate trigger --compact`, when it runs, then a full-graph compaction pass is queued regardless of the token counter state.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009c-pollinating-loop-compaction-mode.md:47`
- Verdict: UNMET
- Evidence: Same live gap as index AC-3. src/commands/pollinate.ts:147 forwards --compact, and src/daemon/runtime/pollinating/api.ts:291 does not read mode and does not bypass the token counter.

#### AC-3

- Quote: Given a large graph, when compaction assembles input, then recent summaries are sampled and total input stays within `maxInputTokens`.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009c-pollinating-loop-compaction-mode.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/pollinating/compaction.ts:288 samples summaries so assembled input stays within maxInputTokens

#### AC-4

- Quote: Given a compaction pass completes, when the next pass runs, then it operates in incremental mode against the post-compaction `last_pass_at`.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009c-pollinating-loop-compaction-mode.md:49`
- Verdict: MET
- Evidence: A finished pass writes last_pass_at at src/daemon/runtime/pollinating/runner.ts:310. The next selection uses shouldEnterCompaction, which is false once last_pass_at is non-empty (src/daemon/runtime/pollinating/compaction.ts:341), so the worker takes the incremental strategy (src/daemon/runtime/pollinating/worker.ts:286)

#### AC-5

- Quote: Given compaction-emitted destructive mutations, when applied, then they route through the ontology control plane and land in pending review like any pass.
- PRD: `library/requirements/completed/prd-009-pollinating-loop/prd-009c-pollinating-loop-compaction-mode.md:50`
- Verdict: MET
- Evidence: Compaction uses the same runner apply path as any pass: src/daemon/runtime/pollinating/runner.ts:274 and DIRECT_APPLY at src/daemon/runtime/ontology/control-plane.ts:101

## PRD-010 Model Provider Router

Recommended bucket: **in-work**.

Config parsing and the routing engine run on the live model-client path. The HTTP gateway is never mounted, the live `route` verb posts under `/api/inference/routes` while the handlers are declared at `/api/inference`, pin is absent from the router, and routing history defaults to a no-op store. Hold the folder in in-work.

QA note: library/requirements/completed/prd-010-model-provider-router/reports/2026-06-17-qa-report.md claimed the criteria and recorded a deferred gateway mount, CLI registration, and pin-store endpoints. The gateway and pin are still off the production entry points.

### `library/requirements/completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md`

#### AC-1

- Quote: Given an `inference:` block, when the daemon loads it, then accounts, targets, policies, and workloads parse and secret references resolve without exposing raw keys in any dump or log.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md:40`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/config.ts:201 parses the inference block and resolves cross-references; apiKey stays a ${SECRET_REF} (config.ts:71) and dumpInferenceConfig prints only the reference (config.ts:224). The factory builds the router from that config at src/daemon/runtime/inference/model-client-factory.ts:383

#### AC-2

- Quote: Given an inference request whose top candidate fails a privacy, capability, or context gate, when routing runs, then that target is blocked and selection proceeds among the surviving candidates by policy mode.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md:41`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:311 blocks a candidate that fails privacy, capability, or context, then selectByMode at router.ts:346 orders the survivors

#### AC-3

- Quote: Given a target that returns a 4xx or 5xx, when the request executes, then the router tries the next allowed target in the chain and records the attempt sequence.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md:42`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:398 records a failed attempt and continues to the next allowed target on 4xx/5xx, including 401 after marking the account expired

#### AC-4

- Quote: Given an existing OpenAI client pointed at the daemon, when it calls `POST /v1/chat/completions`, then it receives routed inference, including streaming.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md:43`
- Verdict: UNMET
- Evidence: POST /v1/chat/completions streaming is implemented at src/daemon/runtime/inference/gateway.ts:212. mountInferenceGateway is called only from tests/daemon/runtime/inference/gateway.test.ts:203. ABSENT production mount in src/daemon/runtime/assemble.ts

### `library/requirements/completed/prd-010-model-provider-router/prd-010a-model-provider-router-config-contract.md`

#### AC-1

- Quote: Given an `inference:` block with accounts, targets, policies, and workloads, when the daemon parses it, then each section validates and cross-references resolve (a workload names a real policy, a policy names real targets).
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010a-model-provider-router-config-contract.md:47`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/config.ts:118 validates accounts, targets, policies, and workloads; resolveCrossRefs at config.ts:129 requires a workload policy and policy targets to exist

#### AC-2

- Quote: Given an account with `apiKey: ${SECRET_REF}`, when config is dumped, then the resolved key never appears and only the reference is shown.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010a-model-provider-router-config-contract.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/config.ts:171 stores apiKey as apiKeyRef and dumpInferenceConfig at config.ts:224 emits that reference only

#### AC-3

- Quote: Given a workload that names a non-existent policy, when the daemon parses config, then parsing fails with an error identifying the dangling reference.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010a-model-provider-router-config-contract.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/config.ts:162 pushes `workload "<name>" references unknown policy "<policy>"` and parseInferenceConfig throws InferenceConfigError at config.ts:212

#### AC-4

- Quote: Given a target with an inline raw API key, when the daemon parses config, then it is rejected in favor of a secret reference.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010a-model-provider-router-config-contract.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/config.ts:47 rejects any credential that is not exactly ${NAME}

#### AC-5

- Quote: Given a valid block, when parsing completes, then targets expose their privacy tier and capabilities to the routing engine.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010a-model-provider-router-config-contract.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/contracts.ts:172 puts privacyTier and capabilities on each target; dumpInferenceConfig surfaces them at src/daemon/runtime/inference/config.ts:227

### `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md`

#### AC-1

- Quote: Given a candidate target with too low a privacy tier, a missing capability, or too small a context window, when gates run, then it is blocked outright.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:311 drops a target whose privacy tier, capabilities, or context window fail the workload gates

#### AC-2

- Quote: Given a policy in `strict` mode, when selection runs, then targets are tried in the explicit chain order; in `automatic` candidates are scored, and in `hybrid` scored within an allowlist.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:346 keeps strict chain order, scores automatic survivors, and scores hybrid survivors only inside the allowlist

#### AC-3

- Quote: Given a missing or expired account, when resolution runs, then that target degrades out of the candidate set and other survivors remain eligible.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:280 drops a target whose account is missing or present in expiredAccounts and keeps the other survivors

#### AC-4

- Quote: Given a target that returns 5xx, when it fails, then the engine tries the next allowed target and appends both to the recorded attempt sequence.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:398 appends a failed attempt and walks the next allowed target; exhaustion throws RoutingExhaustedError at router.ts:412 carrying the attempt sequence

#### AC-5

- Quote: Given a 401 from a target, when it returns, then the engine marks that account expired in-memory and degrades it for subsequent requests in the same process lifetime.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:400 adds the account id to the in-memory expiredAccounts set, which later requests treat as ineligible at router.ts:285

#### AC-6

- Quote: Given an explain request, when it runs, then the engine returns the routing decision without executing inference.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010b-model-provider-router-routing-engine.md:54`
- Verdict: MET
- Evidence: src/daemon/runtime/inference/router.ts:117 explain returns the routing decision and does not call the transport

### `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md`

#### AC-1

- Quote: Given the native API, when a client calls `POST /api/inference/explain`, then it returns the routing decision without executing the request.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md:49`
- Verdict: UNMET
- Evidence: Handler exists at src/daemon/runtime/inference/gateway.ts:118. ABSENT production mount: mountInferenceGateway is only invoked from tests/daemon/runtime/inference/gateway.test.ts:203

#### AC-2

- Quote: Given the gateway, when a client calls `POST /v1/chat/completions` with streaming, then routed inference streams back over SSE.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md:50`
- Verdict: UNMET
- Evidence: SSE branch exists at src/daemon/runtime/inference/gateway.ts:219. ABSENT production mount of mountInferenceGateway

#### AC-3

- Quote: Given a stock OpenAI client pointed at the daemon, when it lists models via `GET /v1/models`, then it receives the routable targets and can complete a chat call.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md:51`
- Verdict: UNMET
- Evidence: GET /v1/models exists at src/daemon/runtime/inference/gateway.ts:199 and chat completions at gateway.ts:212. ABSENT production mount of mountInferenceGateway

#### AC-4

- Quote: Given an active stream, when `DELETE /api/inference/requests/:id` is called, then the stream is cancelled.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md:52`
- Verdict: UNMET
- Evidence: DELETE /api/inference/requests/:id exists at src/daemon/runtime/inference/gateway.ts:184 and calls router.cancel. ABSENT production mount of mountInferenceGateway

#### AC-5

- Quote: Given an oversized request body, when it hits any surface, then it is clamped within limits and the provider error, if any, is redacted before return.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md:53`
- Verdict: UNMET
- Evidence: Body clamp and redacted errors exist at src/daemon/runtime/inference/gateway.ts:258 and gateway.ts:491. ABSENT production mount of mountInferenceGateway

#### AC-6

- Quote: Given telemetry on, when `GET /api/inference/history` is called, then it returns route and fallback decisions with secrets and bodies stripped.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010c-model-provider-router-gateway-api.md:54`
- Verdict: UNMET
- Evidence: GET /api/inference/history exists at src/daemon/runtime/inference/gateway.ts:167. The live factory passes noopRoutingHistoryStore unless history is injected (src/daemon/runtime/inference/model-client-factory.ts:387). createRoutingHistoryStore has no production caller. ABSENT mounted history route and ABSENT live DeepLake telemetry writes

### `library/requirements/completed/prd-010-model-provider-router/prd-010d-model-provider-router-route-cli.md`

#### AC-1

- Quote: Given a configured router, when `honeycomb route explain` runs, then it prints the routing decision for a workload without executing inference.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010d-model-provider-router-route-cli.md:47`
- Verdict: UNMET
- Evidence: src/cli/route.ts:313 can print an explain decision, and that module has no importer under src/commands or src/cli/runtime.ts. The live verb table sends route to /api/inference/routes (src/commands/storage-handlers.ts:43) and buildStorageRequest posts /api/inference/routes/explain (storage-handlers.ts:229). The gateway explain route is /api/inference/explain (src/daemon/runtime/inference/gateway.ts:118) and is not mounted.

#### AC-2

- Quote: Given telemetry enabled, when `honeycomb route status` runs, then it shows recent route and fallback sequences with secrets and request bodies redacted.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010d-model-provider-router-route-cli.md:48`
- Verdict: UNMET
- Evidence: src/cli/route.ts status printer is off the dispatcher, same as AC-1. Live GET would be /api/inference/routes/status. History lives at GET /api/inference/history (gateway.ts:167), unmounted, and the factory uses the no-op store (model-client-factory.ts:387).

#### AC-3

- Quote: Given `honeycomb route pin <workload> <target>`, when a request for that workload routes, then it resolves to the pinned target until unpinned.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010d-model-provider-router-route-cli.md:49`
- Verdict: UNMET
- Evidence: src/cli/route.ts:382 writes a pin through an injected seam. The inference router has no pin field (no match in src/daemon/runtime/inference/router.ts). ABSENT pin on the live route verb and ABSENT pin in the router.

#### AC-4

- Quote: Given `honeycomb route test`, when it runs, then it reports the serving target and the full attempt sequence.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010d-model-provider-router-route-cli.md:50`
- Verdict: UNMET
- Evidence: src/cli/route.ts implements route test against injected deps and is not dispatched. ABSENT live `honeycomb route test` attempt-sequence report.

#### AC-5

- Quote: Given a stored telemetry row, when inspected directly in DeepLake, then it contains no secret value and no request body.
- PRD: `library/requirements/completed/prd-010-model-provider-router/prd-010d-model-provider-router-route-cli.md:51`
- Verdict: UNMET
- Evidence: toRedactedEvent at src/daemon/runtime/inference/contracts.ts:570 copies only route fields, and DeeplakeRoutingHistoryStore.record at src/daemon/runtime/inference/history-store.ts:138 writes that event. Production buildInferenceModelClient uses noopRoutingHistoryStore (model-client-factory.ts:387). ABSENT stored DeepLake telemetry row on the live path.

## PRD-011 Tenancy and Auth

Recommended bucket: **in-work**.

Deployment-mode gates, RBAC, the credentials file, and workspace search_path isolation are live. Agent read-policy clauses are never applied to a memory query, the rate limiter is never mounted, API-key create and revoke have no production caller, and dispatched `honeycomb status` prints service health rather than org, workspace, and agent. Hold the folder in in-work.

QA note: library/requirements/completed/prd-011-tenancy-and-auth/reports/2026-06-17-qa-report.md claimed 34/34. This standing treats an unused clause builder and an unmounted rate limiter as unmet even where a unit test covers the function.

### `library/requirements/completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md`

#### AC-1

- Quote: Given two workspaces in one org, when a recall runs in workspace A, then no row, partition, or index from workspace B is reachable even if the API filter were omitted.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md:42`
- Verdict: MET
- Evidence: src/daemon/storage/client.ts:547 sends the call workspace on every query, and src/daemon/storage/pg-transport.ts:156 sets search_path to that workspace schema before the SQL runs, so omitting a SQL filter still stays inside workspace A

#### AC-2

- Quote: Given a CLI login, when the user approves in the browser, then the daemon mints a long-lived org-bound token and the CLI saves `credentials.json` at mode `0600`.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md:43`
- Verdict: MET
- Evidence: Device-flow completion persists through saveCredentials at src/daemon/runtime/auth/credentials-store.ts:486, which writes credentials.json at mode 0600 (FILE_MODE at credentials-store.ts:127) and the directory at 0700

#### AC-3

- Quote: Given `team` mode, when a request arrives without a valid Bearer token or API key, then it gets `401`; with a token but insufficient permission, `403`.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md:44`
- Verdict: MET
- Evidence: src/daemon/runtime/middleware/permission.ts:205 returns 401 when team mode has no bearer or API key (unauthorized at permission.ts:264). A validated identity that fails the policy returns 403 at permission.ts:244

#### AC-4

- Quote: Given an `isolated` agent, when it recalls, then only its own non-archived memories are returned per the compiled scope clause.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md:45`
- Verdict: UNMET
- Evidence: buildScopeClause can emit an isolated non-archived predicate at src/daemon/runtime/recall/scope-clause.ts:236. Grep of src shows no caller of buildScopeClause besides its definition and the re-export in recall/index.ts. ABSENT application on a recall query.

### `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md`

#### AC-1

- Quote: Given a request, when it reaches DeepLake, then the resolved org is sent and the workspace is part of the storage path so cross-workspace reads are impossible.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md:48`
- Verdict: MET
- Evidence: src/daemon/storage/client.ts:547 puts org and workspace on the storage request, and src/daemon/storage/pg-transport.ts:149 treats the workspace as its own schema via search_path

#### AC-2

- Quote: Given two workspaces in one org, when a recall runs in workspace A with its API filter deliberately removed, then no row, partition, or index from workspace B is reachable.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md:49`
- Verdict: MET
- Evidence: Same partition as index AC-1: src/daemon/storage/pg-transport.ts:156 sets search_path from the request workspace before SQL, so a missing API filter does not open workspace B

#### AC-3

- Quote: Given `honeycomb org switch acme`, when it runs, then a fresh org-bound token is re-minted and saved; `honeycomb workspace use backend` updates the credentials file only.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md:50`
- Verdict: MET
- Evidence: src/cli/org.ts:243 re-mints on org switch and saveDiskCredentials persists it. workspace use is aliased to workspaceSwitch at org.ts:379, which updates the file and states that no token is re-minted (org.ts:341)

#### AC-4

- Quote: Given `HONEYCOMB_ORG_ID` and `HONEYCOMB_WORKSPACE_ID` set, when any command runs, then those values override the credentials file.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/credentials-store.ts:619 reads HONEYCOMB_ORG_ID and HONEYCOMB_WORKSPACE_ID and uses them ahead of the file at credentials-store.ts:631. An org override that disagrees with the verified token throws TenancyIntegrityError at credentials-store.ts:623

#### AC-5

- Quote: Given a credentials file edited to claim a different `orgId` than the JWT, when a request arrives, then the daemon rejects it rather than honoring the file.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/credentials-store.ts:611 throws TenancyIntegrityError when the file orgId disagrees with the verified token org

#### AC-6

- Quote: Given `honeycomb status`, when it runs while logged in, then it prints org id, org name, workspace, and agent, and never prints the bearer token.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md:53`
- Verdict: UNMET
- Evidence: Dispatched `honeycomb status` is the local verb at src/commands/contracts.ts:212 and prints service status from src/commands/standard-interface.ts:206. That body has product, process, and health, and no org, workspace, or agent lines. src/cli/org.ts:349 prints those identity fields and omits the token, and runStatusCommand at src/commands/status.ts:122 also prints org and workspace without agent. Neither function is called from dispatch. ABSENT live identity status line.

### `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md`

#### AC-1

- Quote: Given the device flow, when the user approves in the browser, then the CLI polls, receives a long-lived org-bound token, and writes `credentials.json` at mode `0600` (directory `0700`).
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/device-flow.ts saves through saveCredentials. src/daemon/runtime/auth/credentials-store.ts:463 writes ~/.deeplake/credentials.json at 0600 and the directory at 0700, stamping savedAt from the clock

#### AC-2

- Quote: Given a token whose org claim disagrees with the active org, when a session starts, then the daemon re-mints and realigns org name and workspace, logging a warning and continuing on failure.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/device-flow.ts:195 re-mints and realigns when the token org disagrees with the active org, logs a warning that omits the token, and continues on failure (device-flow.ts:231)

#### AC-3

- Quote: Given a missing or malformed `credentials.json`, when `loadCredentials` runs, then it returns `null` and the CLI prompts the user to log in.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/credentials-store.ts:453 returns null when no credentials file loads. Call sites such as src/cli/org.ts:353 print "Not logged in. Run `honeycomb login`."

#### AC-4

- Quote: Given a successful login, when the credential is written, then `savedAt` is the current timestamp regardless of any value passed in.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/credentials-store.ts:496 overwrites savedAt with clock.now and ignores any value on the input

#### AC-5

- Quote: Given `HONEYCOMB_TOKEN` is set, when a command runs, then the env token is used and the file is not read for the token.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/credentials-store.ts:455 returns the HONEYCOMB_TOKEN env value and does not use the file token when that env var is set

#### AC-6

- Quote: Given `honeycomb logout` with no existing file, when it runs, then it prints "Not logged in." and returns success, not an error.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md:53`
- Verdict: MET
- Evidence: src/cli/auth.ts:440 prints "Not logged in." when logout removes nothing and returns exit code 0 (auth.ts:441). Dispatch sends logout to this path (src/cli/runtime.ts:509)

### `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md`

#### AC-1

- Quote: Given `hybrid` mode with no available socket peer info, when a request arrives, then it fails closed and requires a token rather than trusting the `Host` header.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md:47`
- Verdict: MET
- Evidence: src/daemon/runtime/middleware/permission.ts:194 trusts hybrid only when socketPeer.isTrustedLocalPeer says so. The default probe is noSocketPeer, so a missing peer signal requires a token. Host is not consulted.

#### AC-2

- Quote: Given a `readonly` role, when it calls a write route, then it gets `403`; the `admin` role passes all permission and scope checks.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/rbac.ts:96 omits readonly from the write set, so a write route is forbidden. rbac.ts:259 allows admin through every gate

#### AC-3

- Quote: Given `team` mode, when a request arrives without a valid Bearer token or API key, then it gets `401`.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/middleware/permission.ts:205 returns 401 in team mode when bearer and API key are both absent

#### AC-4

- Quote: Given `local` mode, when any request arrives on localhost, then it has full access and no token is required.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/middleware/permission.ts:187 calls next immediately in local mode, with no token check

#### AC-5

- Quote: Given a token scoped to `project=alpha`, when a request targets `project=beta`, then it gets `403` unless the role is `admin`.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/rbac.ts:237 denies a non-admin identity whose project binding differs from the request project hint

#### AC-6

- Quote: Given an `agent`-role connector, when it calls a connectors-admin or token route, then it gets `403`.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/auth/rbac.ts:98 limits connectorsAdmin to admin and member. Agent is absent from that set, and /api/connectors and token routes are connectorsAdmin or admin (rbac.ts:123)

### `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md`

#### AC-1

- Quote: Given a created API key, when it is returned, then the plaintext is printed once and only a scrypt-salted hash is stored in the `api_keys` table.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md:48`
- Verdict: UNMET
- Evidence: createApiKey at src/daemon/runtime/auth/api-keys.ts:140 returns plaintext once and stores scryptHashSecret. Grep of src shows no caller of createApiKey besides that definition. ABSENT production create-and-print path.

#### AC-2

- Quote: Given a caller exceeding its sliding-window limit on an expensive route, when the next request arrives, then it gets `429` with a `Retry-After` header.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md:49`
- Verdict: UNMET
- Evidence: createRateLimitMiddleware sets 429 and Retry-After at src/daemon/runtime/auth/rate-limit.ts:204. Grep of src shows no caller of createRateLimitMiddleware besides the definition. ABSENT mounted limiter.

#### AC-3

- Quote: Given a connector key with default permissions, when it calls an admin route, then it gets `403`.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md:50`
- Verdict: UNMET
- Evidence: DEFAULT_KEY_ROLE is agent at src/daemon/runtime/auth/api-keys.ts:64, and agent is forbidden on admin and connectorsAdmin routes (src/daemon/runtime/auth/rbac.ts:98). The default applies only inside createApiKey, which has no production caller. ABSENT issued connector key.

#### AC-4

- Quote: Given a revoked key, when it is presented on the next request, then it is rejected while other keys continue to work.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md:51`
- Verdict: UNMET
- Evidence: The authenticator rejects a revoked row at src/daemon/runtime/auth/api-keys.ts:261, and revokeKey appends a higher version with revoked=1 at api-keys.ts:305. Grep of src shows no caller of revokeKey besides that definition. ABSENT product path that revokes a key.

#### AC-5

- Quote: Given `local` mode, when many requests arrive, then no rate limit is applied.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md:52`
- Verdict: UNMET
- Evidence: src/daemon/runtime/auth/rate-limit.ts:195 skips the limiter when mode is local. The middleware is never mounted (same absence as AC-2). Local mode also bypasses auth at src/daemon/runtime/middleware/permission.ts:187, which is a different mechanism than a mounted limiter that no-ops.

#### AC-6

- Quote: Given a key bound to `project=alpha`, when a request targets `project=beta`, then it is denied.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011d-tenancy-and-auth-api-keys-rate-limit.md:53`
- Verdict: MET
- Evidence: A key record can carry a project binding, and src/daemon/runtime/auth/rbac.ts:237 denies a non-admin identity when the request project differs. The API-key authenticator is constructed in src/daemon/runtime/assemble.ts:1028 and is the live team/hybrid authenticator.

### `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md`

#### AC-1

- Quote: Given an agent's `read_policy` and `policy_group`, when a memory query runs, then the clause builder emits the matching WHERE fragment with values escaped via the DeepLake string helpers.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md:47`
- Verdict: UNMET
- Evidence: buildScopeClause emits a WHERE fragment with sLiteral escaping at src/daemon/runtime/recall/scope-clause.ts:205. No memory-query caller exists in src. ABSENT use on a running query.

#### AC-2

- Quote: Given recall's candidate channels (FTS, vector, traversal), when they return IDs, then the scope clause authorizes those IDs before any content-bearing stage loads, so a strong vector hit cannot leak content past the policy.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md:48`
- Verdict: UNMET
- Evidence: Recall contracts describe an authorize-before-content phase (src/daemon/runtime/recall/contracts.ts:7). The recall directory has no authorize module, and buildScopeClause is unused. ABSENT ID authorization before a content load.

#### AC-3

- Quote: Given an `isolated` agent, when it recalls, then only its own non-archived memories are returned.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md:49`
- Verdict: UNMET
- Evidence: The isolated clause is own agent_id AND not archived at src/daemon/runtime/recall/scope-clause.ts:236. ABSENT caller from recall.

#### AC-4

- Quote: Given a `shared` agent, when it recalls, then it sees workspace-global memories plus its own, with archived excluded.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md:50`
- Verdict: UNMET
- Evidence: The shared clause is global OR own, archived excluded, at src/daemon/runtime/recall/scope-clause.ts:240. ABSENT caller from recall.

#### AC-5

- Quote: Given a `group` agent, when it recalls, then it sees global memories from agents in the same `policy_group` plus its own, with archived excluded.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md:51`
- Verdict: UNMET
- Evidence: The group clause is same-policy_group globals OR own at src/daemon/runtime/recall/scope-clause.ts:247. ABSENT caller from recall.

#### AC-6

- Quote: Given a malformed or missing read policy, when a query runs, then the builder falls back to `isolated`.
- PRD: `library/requirements/completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md:52`
- Verdict: UNMET
- Evidence: An unknown or blank policy falls back to isolated at src/daemon/runtime/recall/scope-clause.ts:221. ABSENT caller from a query.

## PRD-012 Secrets

Recommended bucket: **in-work**.

The machine-bound names-only store is mounted and does not return values. `secret_exec` exists in exec.ts, and the live secrets API returns 501 because assembly never passes an exec runner. Bitwarden and 1Password stay a seam. Hold the folder in in-work.

QA note: library/requirements/completed/prd-012-secrets/reports/2026-06-18-qa-report.md claimed 15/15 and recorded deferred daemon assembly for exec. Assembly still omits execRunner.

### `library/requirements/completed/prd-012-secrets/prd-012-secrets-index.md`

#### AC-1

- Quote: Given a stored secret, when the `.secrets/` store is copied to a different machine, then the value cannot be decrypted because the key is machine-bound.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012-secrets-index.md:38`
- Verdict: MET
- Evidence: src/daemon/runtime/secrets/crypto.ts:57 derives the XSalsa20-Poly1305 key from the machine id. Decrypt returns ok:false when the key does not match (crypto.ts:136). The store is mounted from src/daemon/runtime/assemble.ts:2003

#### AC-2

- Quote: Given any API, SDK, MCP, or dashboard surface, when an agent attempts to read a secret value, then only the name is available and no value-returning endpoint exists.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012-secrets-index.md:39`
- Verdict: MET
- Evidence: src/daemon/runtime/secrets/api.ts:230 lists names and has no GET /:name value route. SDK surfaces redacted exec output only (src/sdk/client.ts:370). MCP secret tools are secret_list and secret_exec (mcp/src/tools.ts:136) and handlers do not return a stored value (mcp/src/handlers.ts:54)

#### AC-3

- Quote: Given a `secret_exec` job whose command prints a secret, when output returns, then every secret value in stdout/stderr is replaced with `[REDACTED]`.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012-secrets-index.md:40`
- Verdict: UNMET
- Evidence: RollingRedactor replaces values with [REDACTED] at src/daemon/runtime/secrets/exec.ts:303. assemble builds SecretsApiDeps without execRunner (src/daemon/runtime/assemble.ts:2003). mountSecretsApi then registers the 501 stub at src/daemon/runtime/secrets/api.ts:224. ABSENT live exec redaction.

### `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md`

#### AC-1

- Quote: Given a stored secret, when written, then it lands as `crypto_secretbox_easy` ciphertext with a random nonce in `$HONEYCOMB_WORKSPACE/.secrets/` at mode `0600`.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/secrets/crypto.ts:85 encrypts with a random nonce via xsalsa20poly1305 (the crypto_secretbox_easy construction). The store writes the record at mode 0600 (src/daemon/runtime/secrets/store.ts:388, SECRET_FILE_MODE at store.ts:69) under the workspace secrets dir

#### AC-2

- Quote: Given the API, when an agent lists secrets, then it receives names only and there is no value-returning endpoint.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/secrets/api.ts:231 GET /api/secrets returns names. There is no value-returning GET handler in that module

#### AC-3

- Quote: Given a `.secrets/` directory copied to another host, when the daemon there tries to decrypt, then decryption fails because the machine-bound key differs.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/secrets/crypto.ts:104 returns ok:false with reason auth_failed when the Poly1305 tag fails under a different machine key

#### AC-4

- Quote: Given any secret operation, when it completes, then an NDJSON audit event is appended under `.daemon/` with sensitive fields redacted.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/secrets/store.ts:392 appends an NDJSON event to .daemon/secrets-audit.ndjson. The event fields are op, scope, outcome, and name, not the secret value

#### AC-5

- Quote: Given an attempt to read a secret value through SDK, MCP, dashboard, or plugin diagnostics, when made, then no decrypted value is ever returned.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md:52`
- Verdict: MET
- Evidence: The secrets HTTP module exposes no decrypting read (src/daemon/runtime/secrets/api.ts:160). The SDK redacts (src/sdk/client.ts:386). MCP lists names and posts exec (mcp/src/handlers.ts:317)

#### AC-6

- Quote: Given two agents under one workspace, when one lists secrets, then it sees only secrets in its own scope.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012a-secrets-secrets-store.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/secrets/store.ts:433 puts agentId in the directory segment, and listSecretNames reads only that scope directory (store.ts:286)

### `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md`

#### AC-1

- Quote: Given a `secret_exec` request, when it is submitted, then it queues a job (202), spawns the subprocess with resolved secrets in env, and enforces the timeout (5 min default, 30 max).
- PRD: `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md:47`
- Verdict: UNMET
- Evidence: createSecretExecRunner queues, spawns, and clamps timeout to 5 minutes default and 30 minutes max (src/daemon/runtime/secrets/exec.ts:55 and exec.ts:57). Live POST /api/secrets/exec is the 501 stub at src/daemon/runtime/secrets/api.ts:224 because execRunner is omitted at src/daemon/runtime/assemble.ts:2003

#### AC-2

- Quote: Given a command that emits a secret value to stdout or stderr, when output returns, then every occurrence is replaced with `[REDACTED]` before the caller sees it.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md:48`
- Verdict: UNMET
- Evidence: Replacement with [REDACTED] is at src/daemon/runtime/secrets/exec.ts:303. ABSENT on the live route, which returns 501 (api.ts:224)

#### AC-3

- Quote: Given a queued job id, when `GET /api/secrets/exec/:jobId` is called, then the caller sees job status and redacted output but never a raw secret.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md:49`
- Verdict: UNMET
- Evidence: getStatus returns a redacted view at src/daemon/runtime/secrets/exec.ts:484. Live GET /api/secrets/exec/:jobId is the 501 stub at src/daemon/runtime/secrets/api.ts:225

#### AC-4

- Quote: Given a Bitwarden or 1Password reference, when an exec job resolves it, then the value is pulled from the vault by reference and not duplicated into `.secrets/`.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md:50`
- Verdict: UNMET
- Evidence: exec.ts:528 resolves vaultRefs through VaultProvider at use time and does not write them into .secrets. The only VaultProvider constructor in src is createFakeVaultProvider (src/daemon/runtime/secrets/contracts.ts:276). Bitwarden and 1Password routes are 501 stubs when no runner is injected (api.ts:226). ABSENT real vault provider and ABSENT live exec route.

#### AC-5

- Quote: Given a job exceeding the timeout, when it is killed, then it returns a terminal status with redacted partial output and no raw credential.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md:51`
- Verdict: UNMET
- Evidence: Timeout kill and redacted partial output are implemented in src/daemon/runtime/secrets/exec.ts around the awaitChildWithTimeout path (exec.ts:553). ABSENT live route (api.ts:224)

#### AC-6

- Quote: Given concurrent exec requests beyond the pool size, when submitted, then excess jobs queue rather than overwhelming the host.
- PRD: `library/requirements/completed/prd-012-secrets/prd-012b-secrets-secret-exec.md:52`
- Verdict: UNMET
- Evidence: src/daemon/runtime/secrets/exec.ts:403 queues work when active jobs are at poolSize. ABSENT live route (api.ts:224)

## PRD-013 Sources and Documents

Recommended bucket: **in-work**.

Source lifecycle, the document worker, and the Obsidian, Discord, and GitHub providers are built from daemon assembly. The daemon-down CLI remove path that drops local config and warns that store rows remain is absent. One absent criterion is enough to hold the folder in in-work.

QA note: library/requirements/completed/prd-013-sources-and-documents/reports/2026-06-18-qa-report.md claimed 34/34 and recorded deferred assembly. Assembly now builds the sources deps. The daemon-down CLI warning is still absent.

### `library/requirements/completed/prd-013-sources-and-documents/prd-013-sources-and-documents-index.md`

#### AC-1

- Quote: Given a connected source, when a row is derived from it, then that row carries `source_id`, `source_kind`, `source_path`, and `source_root` and is scoped to org and workspace.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013-sources-and-documents-index.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/lifecycle.ts:700 writes source_id, source_kind, source_path, source_root, org_id, and workspace_id on each derived artifact row. buildSourcesApiDeps is used from src/daemon/runtime/assemble.ts:2023

#### AC-2

- Quote: Given a source disconnect, when purge runs, then all artifacts, graph rows, and chunk embeddings for that `source_id` are removed and the source files are left untouched.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013-sources-and-documents-index.md:54`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/lifecycle.ts:562 soft-deletes artifacts, chunks, and doc links for that source_id by appending status deleted (softDelete at lifecycle.ts:355) and closes the provider. Source files are not in that path. Removal is the append-only status advance, not a SQL DELETE.

#### AC-3

- Quote: Given a document submitted to `POST /api/documents`, when the worker runs, then it advances queued -> extracting -> chunking -> embedding -> indexing -> done, and an identical URL is deduplicated to the existing record.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013-sources-and-documents-index.md:55`
- Verdict: MET
- Evidence: DurableDocumentWorker.ingest advances extracting, chunking, embedding, indexing, done at src/daemon/runtime/sources/document-worker.ts:514. Identical URL returns the existing row at document-worker.ts:434. The worker is constructed in buildSourcesApiDeps (src/daemon/runtime/sources/registry.ts:374)

### `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md`

#### AC-1

- Quote: Given a connect, when it completes, then the source is registered and an index job is queued; index produces artifacts, native graph rows, and provenanced chunks.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md:50`
- Verdict: MET
- Evidence: Connect registers the source and index writes artifacts through the lifecycle append path (src/daemon/runtime/sources/lifecycle.ts:576) including graph provenance and chunks

#### AC-2

- Quote: Given a disconnect, when purge runs, then config, `memory_artifacts` rows, source-owned graph rows, and chunk embeddings for that `source_id` are removed and source files are untouched.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/lifecycle.ts:562 removes config via registry.remove, soft-deletes artifact, chunk, and link rows for the source_id, and does not delete source files

#### AC-3

- Quote: Given any source-derived row, when inspected, then it carries `source_id`, `source_kind`, `source_path`, `source_root` and is scoped to org and workspace.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/lifecycle.ts:700 writes the provenance quartet plus org_id and workspace_id

#### AC-4

- Quote: Given a removed file on a connected source, when the watcher fires, then the row is soft-deleted via a status advance (not an in-place UPDATE) and its chunks are purged.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/lifecycle.ts:349 advances status to deleted by appending a version and then purges that artifact's chunks (lifecycle.ts:529)

#### AC-5

- Quote: Given a new source kind written for the first time, when index runs, then tables are created lazily without a prior migration.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md:54`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/lifecycle.ts:341 appends through appendOnlyInsert, which is the heal-aware lazy create path

#### AC-6

- Quote: Given the daemon is down, when the CLI removes a source, then config is removed and a warning is emitted that store rows remain.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md:55`
- Verdict: UNMET
- Evidence: Live `sources` is the generic storage verb (src/commands/storage-handlers.ts:44) and talks to the daemon. ABSENT a daemon-down branch that deletes local source config and warns that store rows remain. No such warning string exists under src.

#### AC-7

- Quote: Given a partial fetch failure, when index continues, then a failure artifact is written and reported and no existing row is deleted.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013a-sources-and-documents-source-contract.md:56`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/lifecycle.ts:599 writeFailureArtifact appends a failure row and the comment states it never deletes an existing row. Providers yield those artifacts and keep scanning (src/daemon/runtime/sources/providers/discord.ts:539, src/daemon/runtime/sources/providers/github.ts:183)

### `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md`

#### AC-1

- Quote: Given `POST /api/documents` with a URL, when submitted, then it returns an id and status; an identical URL returns the existing record rather than re-ingesting.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md:46`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/document-worker.ts:434 returns the existing document id when the URL hash already has a non-deleted row; a miss returns a new id and queued status (document-worker.ts:451). POST /api/documents is mounted from the sources deps

#### AC-2

- Quote: Given a chunk whose embedding fails, when the worker continues, then the chunk is still written and stays keyword-searchable rather than failing the job.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md:47`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/document-worker.ts:561 caches a null embedding on failure and still writes the chunk so it stays keyword-searchable

#### AC-3

- Quote: Given a document, when it is processed, then its `memory_jobs` row advances through queued, extracting, chunking, embedding, indexing, done.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/document-worker.ts:76 lists the states, and ingest advances them in order at document-worker.ts:514 through document-worker.ts:552

#### AC-4

- Quote: Given two documents containing an identical chunk, when both are embedded, then the chunk shares one embedding keyed by content hash.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/document-worker.ts:565 embeds once per content_hash and reuses an existing document_chunk embedding for that hash

#### AC-5

- Quote: Given a document delete, when it runs, then the document and all linked chunk memories are soft-deleted and history entries are written.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md:50`
- Verdict: MET
- Evidence: DELETE /api/documents/:id calls the lifecycle soft-delete of the document and linked chunks (src/daemon/runtime/sources/api.ts:296) via the append-only status advance, which is the history row

#### AC-6

- Quote: Given a chunk size override under `pipeline.*`, when chunking runs, then the configured size and overlap are applied.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013b-sources-and-documents-document-worker.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/document-worker.ts:197 chunks with the resolved pipeline chunkSize and chunkOverlap

### `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md`

#### AC-1

- Quote: Given `honeycomb sources add obsidian /path/to/Vault`, when indexing runs, then each Markdown file becomes a `memory_artifacts` row and the vault topology is mounted into the ontology.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md:46`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/obsidian.ts indexes each Markdown file into a memory_artifacts-shaped artifact and emits vault topology triples (obsidian.ts:416)

#### AC-2

- Quote: Given a vault file edited on disk, when the watcher fires, then the source re-reads and updates in place; a removed file is soft-deleted with its chunks purged.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md:47`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/obsidian.ts:488 re-indexes added and modified paths and soft-deletes removed paths through lifecycle.updateInPlace, which purges chunks

#### AC-3

- Quote: Given a file with headings, when chunking runs, then chunks split by heading and each carries vault-relative path plus heading and line range.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/obsidian.ts:155 splits on ATX headings and chunk metadata carries path, heading, and line range (obsidian.ts:400)

#### AC-4

- Quote: Given wiki links between notes, when indexing runs, then they become dependency edges in the graph.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/obsidian.ts:199 extracts [[wiki]] targets and records them as depends_on graph triples (obsidian.ts:123)

#### AC-5

- Quote: Given a renamed file, when the watcher fires, then the old row is soft-deleted and a new row is added.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/obsidian.ts:530 reports a rename as one removed path and one added path, and the lifecycle soft-deletes the old row and adds the new one

#### AC-6

- Quote: Given a malformed file, when indexing runs, then a failure artifact is written and other files index normally.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013c-sources-and-documents-obsidian.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/obsidian.ts:643 yields failureArtifact for a malformed file and noteArtifact for the others in the same loop

### `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md`

#### AC-1

- Quote: Given REST mode, when indexing runs, then guilds, channels, threads, members, and per-message artifacts are pulled with latest and backfill checkpoints, refreshing forward and backfilling within bounds.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md:46`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/discord.ts REST mode pulls guilds, channels, threads, members, and messages with latest and backfill checkpoints (discord.ts:484 and discord.ts:520)

#### AC-2

- Quote: Given any sync mode, when a fetch partially fails, then failures are written as source-owned failure artifacts and reported, and no previously indexed row is deleted.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md:47`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/discord.ts:539 yields a failure artifact for a partial channel failure and returns from that channel only, leaving prior rows in place

#### AC-3

- Quote: Given gateway-tail mode, when a message create/update/delete event arrives, then it is indexed against the per-channel tail checkpoint.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md:48`
- Verdict: MET
- Evidence: Gateway-tail events are indexed against the per-channel tail checkpoint (src/daemon/runtime/sources/providers/discord.ts:614 opens the gateway only in gateway-tail mode)

#### AC-4

- Quote: Given the source is removed in gateway-tail mode, when purge runs, then the gateway connection is closed.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md:49`
- Verdict: MET
- Evidence: Purge calls provider.close (src/daemon/runtime/sources/lifecycle.ts:568). The discord provider close awaits gateway.close (src/daemon/runtime/sources/providers/discord.ts:645)

#### AC-5

- Quote: Given desktop-cache mode, when the cache evicts entries, then previously indexed rows remain.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/discord.ts:591 states that a desktop-cache miss emits no removal, so previously indexed rows remain

#### AC-6

- Quote: Given a snapshot export, when it runs with defaults, then local `@me` DMs are excluded.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013d-sources-and-documents-discord.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/discord.ts:306 defaults excludeAtMeDmsOnExport to true, and the export loop skips guild id @me (discord.ts:604)

### `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md`

#### AC-1

- Quote: Given `honeycomb sources add github --repo Org/Repo --token-ref GITHUB_TOKEN --resource-type issues --resource-type docs`, when indexing runs, then issues/PRs/discussions are pulled over GraphQL and selected Markdown docs over REST.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md:46`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/github.ts:498 pulls issues when resourceTypes includes issues, over the GraphQL transport, and docs over REST, using the token ref rather than an inline token (github.ts:248)

#### AC-2

- Quote: Given doc ingestion, when a non-Markdown file is encountered, then it is skipped; only Markdown is ingested, bounded by `maxItemsPerRepo` and path globs.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md:47`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/github.ts:341 skips non-Markdown paths, and the cap is maxItemsPerRepo (github.ts:495) with Markdown globs (github.ts:334)

#### AC-3

- Quote: Given a `maxItemsPerRepo` bound, when indexing runs, then no more than that many items per repo are ingested.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/github.ts:495 stops yielding once yielded reaches maxItemsPerRepo

#### AC-4

- Quote: Given a non-GitHub remote, when git sync runs, then `GITHUB_TOKEN` is not injected into it.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/sources/providers/github.ts:86 returns undefined for any remote whose host is not the configured GitHub host, so the token is not attached

#### AC-5

- Quote: Given a partial GraphQL failure, when indexing continues, then a failure artifact is written and existing rows are retained.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md:50`
- Verdict: MET
- Evidence: Partial GraphQL failures are collected as failure artifacts (src/daemon/runtime/sources/providers/github.ts:183) and existing rows are not deleted by that path

#### AC-6

- Quote: Given indexed items, when inspected, then each carries repo and item provenance scoped to org and workspace.
- PRD: `library/requirements/completed/prd-013-sources-and-documents/prd-013e-sources-and-documents-github.md:51`
- Verdict: MET
- Evidence: GitHub artifacts go through the same provenanceRow writer (src/daemon/runtime/sources/lifecycle.ts:700), which stores repo path provenance plus org_id and workspace_id

## PRD-014 Codebase Graph

Recommended bucket: **completed**.

Extractors, the stable snapshot hash, atomic snapshot write, push/pull drift handling, and the local graph query surface are in source, and assemble mounts the graph API. No criterion in this slice was absent. Leave the folder in completed.

QA note: library/requirements/completed/prd-014-codebase-graph/reports/2026-06-18-qa-report.md claimed 28/28 with deferred wiring. library/requirements/completed/prd-014-codebase-graph/reports/2026-06-22-qa-report.md says POST /api/graph/build is mounted. This standing agrees the criteria are present.

### `library/requirements/completed/prd-014-codebase-graph/prd-014-codebase-graph-index.md`

#### AC-1

- Quote: Given identical source content on two different worktrees or branches, when both are built, then they produce the same `snapshot_sha256` because the volatile `observation` fields are excluded from the hash.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014-codebase-graph-index.md:40`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/hash.ts:124 hashes stableProjection, which strips observation (hash.ts:80). Two builds of the same content share that hash

#### AC-2

- Quote: Given an unresolved call site, when resolution runs, then an edge is emitted only for a high-confidence named or namespace import; default imports, barrels, and dynamic imports are skipped.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014-codebase-graph-index.md:41`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/resolve.ts:241 emits a calls edge only for a named import or a namespace import, and drops default imports, bare specifiers, barrels, and dynamic import

#### AC-3

- Quote: Given a build for a `(org, workspace, repo, user, worktree, commit)` whose existing row has a different `snapshot_sha256`, when push runs, then it logs a `drift` warning and refuses to overwrite.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014-codebase-graph-index.md:42`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/push-pull.ts:207 logs push-drift and returns kind drift without writing over the stored hash. POST /api/graph/build calls pushSnapshot (src/daemon/runtime/codebase/api.ts:255) and mountGraph is called from src/daemon/runtime/assemble.ts:1846

#### AC-4

- Quote: Given a built snapshot, when an agent reads `graph/impact/<pattern>`, then it returns the transitive dependents (blast radius) of the matching symbol.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014-codebase-graph-index.md:43`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/query.ts impact walk returns transitive dependents (query.ts section starting at the impact renderer, dependents set). handleGraphVfs dispatches graph/impact at query.ts:140

### `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md`

#### AC-1

- Quote: Given a source file, when `extractFile` runs, then it routes by extension to the right extractor and returns a `FileExtraction` with nodes, edges, parse errors, and TS cross-file inputs.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/extract.ts:264 routes by languageForFile and returns a FileExtraction with nodes, edges, parse errors, and the TS cross-file inputs the extractor records

#### AC-2

- Quote: Given an unchanged file on rebuild, when the cache is consulted, then the prior `FileExtraction` is reused by content sha256, and a renamed/copied file rewrites `source_file`, edge id prefixes, and module labels to the current path.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/cache.ts:143 reuses an entry only when schema version and content sha match. Rename rewrite of source_file, edge id prefixes, and module labels is rewriteExtraction at cache.ts:195

#### AC-3

- Quote: Given a repo with a `.gitignore`, when discovery runs, then ignored files are excluded via git ls-files and `.d.ts` files are excluded.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/discovery.ts prefers git ls-files so .gitignore applies, and isSourceCandidate excludes .d.ts at discovery.ts:119

#### AC-4

- Quote: Given a malformed file, when extraction runs, then parse errors are reported and the file is skipped without aborting the build.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/extract.ts:277 turns a grammar or extractor failure into parseErrors for that file and returns a FileExtraction instead of throwing out of the build

#### AC-5

- Quote: Given an extractor-output change, when `CACHE_SCHEMA_VERSION` is bumped, then old entries are ignored and re-extracted.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/cache.ts:143 returns null when the stored schemaVersion is not CACHE_SCHEMA_VERSION (cache.ts:50), so old entries are re-extracted

#### AC-6

- Quote: Given no git available, when discovery runs, then the manual walk skips dotfiles and ignored directory names.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014a-codebase-graph-extractors.md:54`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/discovery.ts:171 skips names that start with a dot, and the manual walk skips the ignored directory-name set documented at discovery.ts:47

### `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md`

#### AC-1

- Quote: Given unresolved calls, imports, and heritage, when resolution runs, then only high-confidence matches emit edges and ambiguous cases are dropped, not guessed.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/resolve.ts:241 emits edges only for high-confidence named or namespace matches and returns null (dropped) for ambiguous cases

#### AC-2

- Quote: Given two builds of identical content, when `computeSnapshotSha256` runs, then both yield the same hash because only stable fields are hashed and `observation` is excluded.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/hash.ts:124 excludes observation, so two snapshots with the same stable fields share computeSnapshotSha256

#### AC-3

- Quote: Given a default import or bare specifier call site, when the calls pass runs, then no edge is emitted for it.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/resolve.ts:257 returns null for a bare call that is not a named import, which covers default imports and bare specifiers

#### AC-4

- Quote: Given a relative import resolving to a repo file, when the imports pass runs, then the edge is repointed to the real module node; an unresolvable specifier keeps its `external:` target.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/resolve.ts:228 repoints a relative import that resolves to a repo file and returns the original link, keeping the external: target, when it does not

#### AC-5

- Quote: Given a fully resolved edge set, when `annotateNodeDegrees` runs, then `fan_in`, `fan_out`, and `is_entrypoint` reflect cross-file edges.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/degrees.ts:30 sets fan-in and fan-out from cross-file edges and derives is_entrypoint from exported nodes with fan-in 0

#### AC-6

- Quote: Given a crash during write, when recovery occurs, then the snapshot file is either the prior version or the new one, never partial.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014b-codebase-graph-resolution-snapshot.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/snapshot.ts:291 writes a temp file in the same directory and renameSync to the final name, so a crash leaves the previous final file

### `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md`

#### AC-1

- Quote: Given an existing row with a matching `snapshot_sha256`, when push runs, then it is a no-op (`already-current`); a differing hash logs `drift` and refuses to overwrite.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/push-pull.ts:205 returns already-current on a matching snapshot_sha256 and returns drift without overwrite when the hash differs (push-pull.ts:217)

#### AC-2

- Quote: Given a pulled payload, when it is validated, then its recomputed stable-field hash must match the claimed `snapshot_sha256` or the payload is refused so a corrupt row never poisons the local cache.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/push-pull.ts:490 recomputes computeSnapshotSha256 and returns refused hash-mismatch when it differs from the claimed snapshot_sha256

#### AC-3

- Quote: Given no auth, no commit context, or `HONEYCOMB_GRAPH_PUSH=0`, when a build completes, then push is skipped silently.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/push-pull.ts:186 returns skipped for missing auth, missing commit, or HONEYCOMB_GRAPH_PUSH=0 (push-pull.ts:146) without throwing

#### AC-4

- Quote: Given a push failure, when it occurs, then it logs without blocking the build and the local snapshot remains authoritative.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/api.ts:255 treats push failure as best-effort after writeSnapshotAtomic, so the local snapshot remains the copy that was just written

#### AC-5

- Quote: Given more than one row after insert, when push re-selects, then it reports `inserted-with-duplicate-race`.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/push-pull.ts:230 returns inserted-with-duplicate-race when the post-insert select sees more than one row

#### AC-6

- Quote: Given an older commit checked out locally, when pull runs, then it pulls rather than reporting "local newer".
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014c-codebase-graph-push-pull.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/push-pull.ts:471 skips with local-newer only when the local snapshot commit equals HEAD. A different (older) checkout falls through and pulls

### `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md`

#### AC-1

- Quote: Given a built snapshot, when an agent reads `graph/find/<pattern>`, then it returns ranked substring matches with numbered handles and a fuzzy fallback on no match.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/query.ts:293 ranks substring hits and, on no hit for a single token, falls through to the Levenshtein helper and numbers handles

#### AC-2

- Quote: Given `graph/impact/<pattern>`, when it renders, then it returns transitive dependents, and `graph/neighborhood/<file>` returns a file's symbols plus their cross-file neighbors.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md:50`
- Verdict: MET
- Evidence: graph/impact walks transitive dependents and graph/neighborhood lists a file's symbols plus cross-file neighbors (src/daemon/runtime/codebase/query.ts impact and neighborhood sections, dispatched at query.ts:140)

#### AC-3

- Quote: Given a prior `find/`, when an agent reads `show/<N>`, then the handle resolves to the right node and is re-validated against the current snapshot.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/query.ts:411 re-validates a numbered handle against the current snapshot before rendering show

#### AC-4

- Quote: Given a one-character typo in a single-token pattern, when `find/` runs, then the Levenshtein fallback returns the intended node.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/query.ts:306 runs levenshtein (query.ts:677) when a single-token pattern has no substring hit

#### AC-5

- Quote: Given any endpoint, when it renders, then `handleGraphVfs` makes zero network calls and reads only the local snapshot.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md:53`
- Verdict: MET
- Evidence: handleGraphVfs at src/daemon/runtime/codebase/query.ts:148 takes an already loaded snapshot and performs no fetch. The VFS graph tier loads that snapshot from the local loader (src/daemon-client/vfs/read.ts:113)

#### AC-6

- Quote: Given a node with no resolved incoming edges, when `show/` renders, then the caveat that "Incoming (0)" is not proof of dead code is shown.
- PRD: `library/requirements/completed/prd-014-codebase-graph/prd-014d-codebase-graph-query-surface.md:54`
- Verdict: MET
- Evidence: src/daemon/runtime/codebase/query.ts:122 defines the Incoming (0) caveat and show renders it at query.ts:445

## PRD-015 Virtual Filesystem

Recommended bucket: **in-work**.

classifyPath is on the live `/memory/classify` route, and hook reads go through the daemon. The read-precedence chain, virtual index, session EPERM, and the 10-write / 200 ms goal buffer live only inside DeepLakeFs, which production never constructs. The live write path is a blanket deny. Hold the folder in in-work.

QA note: library/requirements/completed/prd-015-virtual-filesystem/reports/2026-06-18-qa-report.md claimed 15/15 and recorded deferred hook assembly. The live hook uses the daemon browse routes, and DeepLakeFs remains test-only.

### `library/requirements/completed/prd-015-virtual-filesystem/prd-015-virtual-filesystem-index.md`

#### AC-1

- Quote: Given a `cat` of a memory path, when it resolves, then content comes from the cache, pending buffer, sessions concatenation, or a direct SQL read, dispatched through the daemon.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015-virtual-filesystem-index.md:38`
- Verdict: UNMET
- Evidence: resolveRead implements cache, pending buffer, sessions concatenation, and SQL summary, in that order after the graph and index tiers (src/daemon-client/vfs/read.ts:66). The only caller is DeepLakeFs.read (src/daemon-client/vfs/fs.ts:93). new DeepLakeFs appears only in tests. The live hook uses daemon GET /memory/cat (src/daemon/runtime/vfs/api.ts:14), which reads the memory summary and does not consult cache, pending buffer, or sessions concatenation.

#### AC-2

- Quote: Given a path, when `classifyPath` runs, then a valid goal/kpi shape routes to the structured table and any malformed shape falls back to the generic `memory` table.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015-virtual-filesystem-index.md:39`
- Verdict: MET
- Evidence: src/daemon-client/vfs/classify.ts:94 returns goal or kpi for a valid shape and memory otherwise. The live daemon route GET /memory/classify calls that same function (src/daemon/runtime/vfs/api.ts:503)

#### AC-3

- Quote: Given a write to a session path, when attempted, then it is rejected with `EPERM` because sessions are an append-only event log.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015-virtual-filesystem-index.md:40`
- Verdict: UNMET
- Evidence: DeepLakeFs throws EPERM for a session-path mutation (src/daemon-client/vfs/contracts.ts:255). Production never constructs DeepLakeFs. The live hook denies every memory-mount write (src/hooks/shared/pre-tool-use.ts:124) and the daemon answers write verbs on /memory with 405 (src/daemon/runtime/vfs/api.ts:450). ABSENT live EPERM on a session path.

### `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md`

#### AC-1

- Quote: Given a read, when it resolves, then precedence is graph bridge, then virtual `index.md`, then cache, then pending buffer, then sessions concatenation, then a direct SQL `summary` read.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md:49`
- Verdict: UNMET
- Evidence: The precedence list is implemented at src/daemon-client/vfs/read.ts:66 and is reached only from DeepLakeFs, which has no production constructor. ABSENT that chain on the live cat path.

#### AC-2

- Quote: Given a `/graph/` path, when read, then it delegates to `handleGraphVfs` against the local snapshot with zero network calls, rendering `no-graph` as the body rather than throwing.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md:50`
- Verdict: UNMET
- Evidence: src/daemon-client/vfs/read.ts:113 delegates /graph/ to handleGraphVfs and returns a no-graph body when the local snapshot is missing. That function runs only inside DeepLakeFs. ABSENT on the live hook, which uses /memory/cat.

#### AC-3

- Quote: Given a path, when `classifyPath` runs, then a valid goal/kpi shape returns its kind and any malformed shape returns `memory`.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md:51`
- Verdict: MET
- Evidence: src/daemon-client/vfs/classify.ts:106 returns the goal or kpi kind for a valid shape and memory for a malformed shape. Live classify uses it (src/daemon/runtime/vfs/api.ts:503)

#### AC-4

- Quote: Given a write, `cp`, or `mv` targeting a session path, when attempted, then it is rejected with `EPERM`.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md:52`
- Verdict: UNMET
- Evidence: Session write, cp, and mv throw EPERM inside DeepLakeFs (src/daemon-client/vfs/fs.ts session guard). ABSENT production DeepLakeFs. Live writes are a blanket deny (src/hooks/shared/pre-tool-use.ts:124 and src/daemon/runtime/vfs/api.ts:450).

#### AC-5

- Quote: Given no `/index.md` row, when the mount root is read, then `generateVirtualIndex` returns a two-section table capped at 50 rows each with a truncation notice.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md:53`
- Verdict: UNMET
- Evidence: generateVirtualIndex caps each section at 50 and adds a truncation notice (src/daemon-client/vfs/index-gen.ts:35 and index-gen.ts:101). The only caller is resolveRead (src/daemon-client/vfs/read.ts:80), which is DeepLakeFs-only. ABSENT live mount-root index.

#### AC-6

- Quote: Given any read or write, when it reaches storage, then the SQL is dispatched through the daemon on port 3850, never opened directly.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015a-virtual-filesystem-intercept-dispatch.md:54`
- Verdict: MET
- Evidence: The live pre-tool hook builds no SQL and calls the daemon VFS routes (src/hooks/shared/pre-tool-use.ts:13). Those routes run inside the daemon, the only storage client. DeepLakeFs, if constructed, is also required to use DaemonDispatch and not a DeepLake connection (src/daemon-client/vfs/contracts.ts:10, port 3850).

### `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md`

#### AC-1

- Quote: Given several quick writes, when they enqueue, then they coalesce and flush at 10 pending or after a 200 ms debounce, serialized so two flushes never interleave, with rejected rows re-queued.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md:48`
- Verdict: UNMET
- Evidence: src/daemon-client/vfs/write-buffer.ts:102 flushes at 10 pending writes, debounces at 200 ms (write-buffer.ts:104), serializes flushes (write-buffer.ts:259), and re-queues rejects (write-buffer.ts:288). The buffer is constructed only by DeepLakeFs (src/daemon-client/vfs/fs.ts:73), which production does not construct. Live writes are denied before a buffer exists.

#### AC-2

- Quote: Given `rm` on a goal path, when it runs, then the goal is soft-closed (status flipped to `closed`, row preserved) rather than deleted, and `rm` on an already-closed goal is a no-op.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md:49`
- Verdict: UNMET
- Evidence: src/daemon-client/vfs/write-buffer.ts:394 soft-closes a goal by setting status closed and no-ops when it is already closed. ABSENT on the live write path, which 405s (src/daemon/runtime/vfs/api.ts:450)

#### AC-3

- Quote: Given `mv` between goal paths, when only the status differs, then the transition succeeds, and when `goal_id` or `owner` differs, then it fails with `EPERM`.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md:50`
- Verdict: UNMET
- Evidence: src/daemon-client/vfs/write-buffer.ts:409 allows a goal mv only when status differs and throws EPERM when goal_id or owner differs. ABSENT on the live path.

#### AC-4

- Quote: Given a flush with embeddings disabled, when rows are written, then the embed hop is skipped and NULL is written for the vector columns.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md:51`
- Verdict: UNMET
- Evidence: src/daemon-client/vfs/write-buffer.ts:432 writes SQL NULL for the vector column when no embedder is injected. ABSENT on the live path.

#### AC-5

- Quote: Given `appendFile` on an existing file, when it runs, then it issues a SQL-level concat and invalidates the cache rather than reading the body back first.
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md:52`
- Verdict: UNMET
- Evidence: src/daemon-client/vfs/write-buffer.ts:320 issues summary = summary || E'...' and invalidates the cache for appendFile. ABSENT on the live path.

#### AC-6

- Quote: Given a goal or kpi write, when it flushes, then it routes through SELECT-before-INSERT keyed by `goal_id` (or `goal_id, kpi_id`).
- PRD: `library/requirements/completed/prd-015-virtual-filesystem/prd-015b-virtual-filesystem-batching-goals-kpis.md:53`
- Verdict: UNMET
- Evidence: Goal and kpi flushes SELECT before INSERT keyed by goal_id or goal_id plus kpi_id (src/daemon-client/vfs/write-buffer.ts:345 and write-buffer.ts:367). ABSENT on the live path.

## PRD-016 Skillify

Recommended bucket: **in-work**.

Mining, append-only skill rows, the oldest-session watermark, install paths, and pull with symlinks are on the worker and `/api/skills/pull`. The live stop counter uses a hardcoded 10, does not read HONEYCOMB_SKILLIFY_EVERY_N_TURNS, and does not reset, and session-end enqueues a summary job only. Hold the folder in in-work.

QA note: library/requirements/completed/prd-016-skillify/reports/2026-06-18-qa-report.md claimed 21/21 and recorded deferred worker and session-start wiring. The worker and session-start pull now start. The session-end skillify trigger and the env cadence are still absent from the live stop path.

### `library/requirements/completed/prd-016-skillify/prd-016-skillify-index.md`

#### AC-1

- Quote: Given the stop-counter reaches `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`, when a Stop event fires, then the counter resets and the daemon runs the skillify worker; session-end fires the worker unconditionally.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016-skillify-index.md:50`
- Verdict: UNMET
- Evidence: Stop handling enqueues a skillify job when turns modulo the counter is 0 (src/daemon/runtime/capture/turn-counters.ts:146) from the capture handler (src/daemon/runtime/capture/capture-handler.ts:828). The counter increments and does not reset. attachHooks does not pass skillifyEveryTurns from skillifyEveryNTurns (src/daemon/runtime/capture/attach.ts:168), so HONEYCOMB_SKILLIFY_EVERY_N_TURNS is unread on the live path; the default is 10 (turn-counters.ts:61). Session-end enqueues a summary job only (src/daemon/runtime/capture/attach.ts:274). evaluateTrigger sessionEnd:true (src/daemon/runtime/skillify/miner.ts:751) is called only from tests. ABSENT unconditional session-end skillify run.

#### AC-2

- Quote: Given a mined pattern, when the gate returns KEEP, then it recurred across at least three exchanges, is non-obvious, and is not already covered; otherwise it is SKIP or MERGE.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016-skillify-index.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/miner.ts:452 downgrades KEEP unless the batch spans at least KEEP_MIN_EXCHANGES (3, miner.ts:66). The prompt also requires non-obvious and not already covered (miner.ts:430). Other decisions are MERGE or SKIP (miner.ts:76)

#### AC-3

- Quote: Given a successful local write, when the daemon records to the `skills` table, then it inserts a new version row (never an in-place UPDATE) and advances the watermark to the oldest mined session.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016-skillify-index.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/skills-write.ts:404 appends version N+1 through the store and does not update in place. The worker then advances the watermark from mined session dates (src/daemon/runtime/skillify/worker.ts:372) using the oldest date (src/daemon/runtime/skillify/watermark.ts:98). The worker is started from src/daemon/runtime/assemble.ts:4314

### `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md`

#### AC-1

- Quote: Given the last 10 in-scope sessions past the watermark, when mining runs, then pairs are extracted (tool calls and thinking dropped), capped at 2,000 chars/pair and 40,000 total, excluding the triggering session.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/miner.ts:58 fetches 10 sessions, drops tool_call events (miner.ts:391), strips thinking (miner.ts:255), caps a pair at 2000 chars (miner.ts:60) and the batch at 40000 (miner.ts:62), and excludes the triggering session id (miner.ts:173)

#### AC-2

- Quote: Given the gate prompt, when the model responds, then it returns exactly one of KEEP, MERGE, or SKIP, with KEEP requiring recurrence across at least three exchanges.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/miner.ts:460 returns one of KEEP, MERGE, or SKIP and downgrades KEEP below three exchanges

#### AC-3

- Quote: Given the stop-counter reaches `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`, when a Stop event fires, then the counter resets and the daemon runs the worker; session-end fires it unconditionally.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md:50`
- Verdict: UNMET
- Evidence: Same gap as index AC-1. evaluateTrigger implements the env-named counter and unconditional session-end (src/daemon/runtime/skillify/miner.ts:745) and has no production caller. The live stop path ignores HONEYCOMB_SKILLIFY_EVERY_N_TURNS and session-end does not enqueue skillify.

#### AC-4

- Quote: Given scope `team` with a team list, when candidates are fetched, then they filter to `author IN (<team>)` with values escaped via `sqlStr`.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/miner.ts:176 adds author IN (...) only when a team author list is present, and each author goes through sLiteral, which is the sqlStr path

#### AC-5

- Quote: Given a concurrent run is already in flight for the project, when a new trigger arrives, then the worker lock suppresses the second run.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/miner.ts:806 returns lock_held when acquire fails, so a second run for the same project does not proceed

#### AC-6

- Quote: Given the gate CLI exceeds 120 seconds, when it times out, then the run aborts without writing a verdict and the lock is released in `finally`.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016a-skillify-trace-miner.md:53`
- Verdict: MET
- Evidence: GATE_TIMEOUT_MS is 120000 (src/daemon/runtime/skillify/miner.ts:64). runGate rejects on timeout (miner.ts:466) before a verdict is returned, and mine releases the lock in finally (miner.ts:821)

### `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md`

#### AC-1

- Quote: Given a KEEP verdict, when the worker writes, then a `SKILL.md` is created with provenance frontmatter and an append-only version row is inserted into the `skills` table (never an in-place UPDATE).
- PRD: `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md:48`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/skills-write.ts:394 renders SKILL.md with provenance frontmatter and appendVersion inserts the next version. The store is StorageQuery-backed (skills-write.ts:171)

#### AC-2

- Quote: Given any verdict, when the run finishes, then the watermark advances to the date of the oldest mined session so older missed sessions are re-seen.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md:49`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/watermark.ts:98 sets the watermark to the earlier of the current mark and the oldest mined session date, including after SKIP because the worker always calls advance (src/daemon/runtime/skillify/worker.ts:370)

#### AC-3

- Quote: Given a MERGE verdict whose target is absent locally, when the worker writes, then it falls back to `writeNewSkill` and the body is preserved.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md:50`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/skills-write.ts:447 calls writeNewSkill when the MERGE target has no local body

#### AC-4

- Quote: Given a cross-author merge, when the row is recorded, then its scope is promoted from `me` to `team`.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md:51`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/skills-write.ts:456 sets scope to team when targetAuthor differs from the merging author, and me otherwise

#### AC-5

- Quote: Given `install=project` versus `install=global`, when KEEP writes, then the `SKILL.md` lands under `<cwd>/.claude/skills/` or `~/.claude/skills/` respectively.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md:52`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/install-target.ts:26 uses .claude/skills under cwd for project and under homedir for global (install-target.ts:44)

#### AC-6

- Quote: Given any successful write, when the row is inserted, then it goes through the daemon, not a direct DeepLake connection.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016b-skillify-skills-writes.md:53`
- Verdict: MET
- Evidence: src/daemon/runtime/skillify/skills-write.ts:102 builds the store on StorageQuery, the daemon storage client, and the worker is constructed inside the daemon (src/daemon/runtime/assemble.ts:3003)

### `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md`

#### AC-1

- Quote: Given a `skills` row, when `honeycomb skillify pull` runs, then it writes `~/.claude/skills/<name>--<author>/SKILL.md` and symlinks into every other detected agent's skill root.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md:46`
- Verdict: MET
- Evidence: src/daemon-client/skillify/install.ts writes ~/.claude/skills/<name>--<author>/SKILL.md and fanOutSymlinks into the other detected roots (install.ts:197). POST /api/skills/pull is mounted (src/daemon/runtime/skillify/propagation-api.ts:275) and the live CLI posts there (src/commands/storage-handlers.ts:109)

#### AC-2

- Quote: Given auto-pull at session start, when the local version is at or newer than remote, then the file is skipped, and the call is bounded by a 5-second timeout that swallows errors so a slow store never blocks startup.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md:47`
- Verdict: MET
- Evidence: src/daemon-client/skillify/install.ts:291 skips when remoteVersion is less than or equal to the local version. autoPull bounds the call at AUTOPULL_TIMEOUT_MS 5000 (install.ts:71) and swallows errors (install.ts:265). Session start uses that same timeout (src/hooks/shared/session-start-seams.ts:117 and session-start-seams.ts:216)

#### AC-3

- Quote: Given `HONEYCOMB_AUTOPULL_DISABLED=1`, when a session starts, then auto-pull does not run.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md:48`
- Verdict: MET
- Evidence: src/hooks/shared/session-start-seams.ts:135 returns immediately when HONEYCOMB_AUTOPULL_DISABLED is 1, and the client helper does the same (src/daemon-client/skillify/install.ts:254)

#### AC-4

- Quote: Given an unauthenticated session, when auto-pull would run, then it skips silently without a warning.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md:49`
- Verdict: MET
- Evidence: src/daemon-client/skillify/install.ts:256 returns null with no warning when auth.isAuthenticated is false. The live session-start pull also emits no warning: a missing credential sends no scope headers and errors are swallowed (src/hooks/shared/session-start-seams.ts:229 and session-start-seams.ts:242)

#### AC-5

- Quote: Given a global-install pull, when fan-out runs, then a symlink exists in each detected agent root pointing at the canonical directory.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md:50`
- Verdict: MET
- Evidence: src/daemon-client/skillify/install.ts:501 creates a directory symlink in each non-canonical detected agent root pointing at the canonical skill directory

#### AC-6

- Quote: Given any pull, when it queries the store, then it goes through the daemon, not a direct DeepLake connection.
- PRD: `library/requirements/completed/prd-016-skillify/prd-016c-skillify-skill-install.md:51`
- Verdict: MET
- Evidence: src/daemon-client/skillify/pull-client.ts:41 reads skills through DaemonDispatch. The mounted pull route uses the daemon storage client (src/daemon/runtime/skillify/propagation-api.ts:78)

