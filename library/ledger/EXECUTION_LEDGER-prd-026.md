# EXECUTION LEDGER — PRD-026 Pollinating Loop Enablement + Live Validation

> Orchestrator: `/the-smoker` · Branch: `prd-026-pollinating-loop-enablement` · SSOT for AC tracking.
> Mandate: turn the PRD-009 Pollinating loop ON (safely, default stays OFF) and PROVE end-to-end against
> live DeepLake that a real pass consolidates (dups merged, stale superseded, junk pruned) WITHOUT losing
> source-backed memory. **User decision (this run): wire the daemon-resident pollinating WORKER too** — so
> enabling the flag genuinely runs passes through the daemon, not just enqueues jobs that sit forever.

## Phase 0 recon — the load-bearing finding

PRD-009 built the loop and it is REAL: `trigger.ts` (counter + subtract-reset + single-pending guard +
`pendingTerminal` seam), `runner.ts` (full pass lifecycle: model → defensive parse → 008c `submitProposal`
apply → state update), `incremental.ts` + `compaction.ts` (real payload strategies), `api.ts`
(`POST /api/diagnostics/pollinate` already resolves config + builds the real trigger). Enablement is one knob:
`HONEYCOMB_POLLINATING_ENABLED=true`.

**THE GAP:** nothing in the live daemon CONSUMES `pollinating` jobs. `createStageWorker` (the only job-consumer
harness) is never instantiated in `assemble.ts`, and its handler map covers only the 5 PRD-006 pipeline kinds
— `pollinating` is not registered and the runner is a separate harness, not a `StageHandler`. So today the
trigger enqueues a `pollinating` job → it sits in `memory_jobs` with no worker. Per the user's call, this PRD
wires a daemon-resident pollinating worker (gated by `enabled`, default OFF) so "turn it ON" is literally true.

`lease()` has NO kind filter and capture also enqueues `summary`/`skillify` jobs — so the pollinating worker must
lease ONLY `["pollinating"]` (a generic worker would `fail()` foreign kinds and walk legit jobs to dead). The
clean fix: an additive kind filter on `JobQueueService.lease(kinds?)` threaded into `selectLeasable`.

Out (genuinely): auto-increment-on-summary + maintenance-tick auto-trigger ride the PRD-006 summary pipeline,
which is itself not yet wired into the live daemon (the stage worker isn't started). AC-2 is therefore a
trigger-DRIVEN gated exercise (exactly as the PRD's AC-2 specifies — "drives the threshold"). Flagged as a
follow-up, not silently skipped.

## Acceptance criteria

| AC | Source | Criterion (abbrev) | Status | Owner |
|----|--------|--------------------|--------|-------|
| AC-1 | 026 | Enable flips the live trigger: `/api/diagnostics/pollinate` → `{triggered:true,status:"enqueued"}` at/over threshold when enabled; `running` when pending/below; `skipped`+`disabled` when off. Unit-tested on `api.ts`. | OPEN | W1/W2 |
| AC-2 | 026 | Cadence + single-pending guard hold live: crossing threshold enqueues exactly ONE job + subtract-reset; a 2nd tick while `pending_job_id` set enqueues NOTHING. Gated live counter exercise, poll-convergent. | OPEN | W2 |
| AC-3 | 026 | A real pass consolidates a seeded set (behavioral bar): seed dup entities + stale-vs-newer claim + junk entity; run ONE real pass (real `pollinating` model) vs live DeepLake; assert dups merged (or `merge_entities` pending), stale `superseded`/newer `active`, junk archived/pending. Poll-convergent. | OPEN | W2 |
| AC-4 | 026 | Nothing source-backed lost: a source-backed claim present before the pass is STILL resolvable (active, provenance intact) after; before/after source-backed survivor counts non-decreasing. | OPEN | W2 |
| AC-5 | 026 | Before/after measurement recorded: itest captures dup-count / active-vs-superseded / junk-count snapshot + asserts the delta in the consolidating direction (the artifact that licenses flipping the shipped default). | OPEN | W2 |
| AC-6 | 026 | Safety + gates green: destructive ops land in pending review (never blind-applied); pollinate ack carries no token/secret; `npm run ci`, `build`, `audit:sql`, `audit:openclaw`, invariant all pass; live itest gated (skipped in CI). | OPEN | W1/W2/close-out |
| AC-W | user | Daemon pollinating WORKER wired: leases `["pollinating"]` only, selects strategy by `mode` (incremental ‖ compaction/backfill-first-run), runs the runner with real model + 008c apply + state-update + pending clear, completes/fails the job; started in assembly ONLY when `config.enabled` (default OFF). | WIRED (W1c) — `buildGatedPollinatingWorker` in `assemble.ts` builds the real trigger + worker gated on `resolvePollinatingConfig().enabled` (default OFF), starts in `start()` after `startServices()`, stops in `shutdown()`. Unit-proven in `assemble.test.ts` (not-started-when-disabled / started-when-enabled / stopped-on-shutdown / boots-without-config). Live pass = W2. | W1 |
| AC-T | user | Real provider transport (PRD-010 finish): a real Anthropic Messages-API `ProviderTransport` (the only transport today is the fake); `createInferenceRouter` + `RouterModelClient` + `createSecretResolver` wired into assembly; an `agent.yaml` `inference:` block (account→target `claude-sonnet-4-6`→policy→`memory_pollinating` workload); the `ANTHROPIC_API_KEY` stored in the existing machine-bound encrypted `.secrets/` store and referenced as `${ANTHROPIC_API_KEY}`. The router's `executeWithFallback` (010b) is ALREADY filled — only the transport + wiring + config are missing. | WIRED (W1c) — `buildInferenceModelClient({scope, secretsStore, config: agent.yaml path})` wired into the gated worker build in `assemble.ts`; degrades to noop when no config/key (boot-safe). `agent.yaml` created at the WORKSPACE ROOT with the full `inference:` block (anthropic account → `claude-sonnet`/`claude-sonnet-4-6` target `privacy: private` → `pollinating-policy` `mode: strict` → `memory_pollinating` workload `minPrivacyTier: private` `requiredCapabilities: [chat]`), `apiKey: "${ANTHROPIC_API_KEY}"` ref only (no inline key), committed (not gitignored), parse-proven in `inference/agent-yaml.test.ts`. The live model call + key store is the later step (needs the user's key). | W1 |

### Recon facts (for the bees)
- Router execute path (`inference/router.ts` `executeWithFallback`) is COMPLETE: resolves `account.apiKeyRef` via the injected `SecretResolver` and calls `transport.execute({target, apiKey, request})`, with 401→expire-account + 4xx/5xx→next-target fallback. Internal request is OpenAI-shaped (`messages:[{role,content}]`, `maxTokens`, `stream`, `contextTokens`).
- `RouterModelClient` (router.ts) already maps `memory_pollinating` → inference workload `memory_pollinating` and wraps the prompt as a single user message. Daemon assembly currently injects `noopModelClient` — swap to `new RouterModelClient(router)` when inference config is present, else keep noop.
- Real `SecretResolver` = `createSecretResolver(store, scope)` (`secrets/store.ts`); decrypts from the machine-bound `.secrets/` store (NOT env). The Anthropic key is stored there under name `ANTHROPIC_API_KEY` (the smoker stores it from `.env.local` without echoing, once the user adds it).
- Inference config loads via `loadInferenceConfigFromYaml(path)` (`inference/config.ts`): `inference:` block with accounts/targets/policies/workloads; `apiKey` MUST be a `${SECRET_REF}` (inline raw key is rejected). No `agent.yaml` exists yet — Wave 1c creates it + finds the path assembly reads.
- ProviderTransport contract (`inference/contracts.ts`): `execute(call)→ProviderResult{output}` + `stream(call)`. Map provider HTTP status onto a thrown error carrying the status code so the router's fallback sees 401/4xx/5xx (`providerStatus(err)` reads it).

### Follow-up captured (NOT this PRD)
User idea: a local SQLite-backed encrypted credential vault consolidating DeepLake creds (today plaintext in `~/.deeplake/credentials.json`) + provider keys, with a CLI + dashboard provider/model picker (Anthropic / OpenAI / OpenRouter → model list). Worth a dedicated PRD; the existing `.secrets/` store already gives machine-bound encryption for the Anthropic key now. To be authored after PRD-026.

## Wave plan

**Wave 1 — foundational "make it RUN" (serial; `typescript-node-worker-bee`, Opus).** Must land + compile +
unit-green before the live proofs. Owns:
- `services/job-queue.ts` — additive `lease(kinds?: readonly string[])` + `selectLeasable` kind filter (default = all; zero behavior change for existing callers). Extend job-queue unit tests.
- `pollinating/worker.ts` (NEW) — `PollinatingJobWorker` modeled on `stage-worker.ts`: `runOnce()` leases `["pollinating"]`, parses `PollinatingJobPayload`, selects strategy by `mode` (+ `backfillOnFirstRun` → compaction on first run), builds the runner (real `pollinating` ModelClient via the router, real `submitProposal` apply already inside the runner, state-updater = append-only via the trigger's path, pending-terminal clear), runs `runPass`, `complete`/`fail`. `start()/stop()` poll loop. NEVER constructed/started unless `config.enabled`.
- `assemble.ts` — construct + start the pollinating worker under the daemon's resolved scope + storage + model + queue, gated on `resolvePollinatingConfig().enabled`; stop it in the teardown path. Wire the trigger's `pendingTerminal` probe to the queue. NO `server.ts` edit beyond the existing service-start seam.
- `pollinating/worker.test.ts` + queue-filter tests (AC-W, AC-1 handler half) + `index.ts`/CONVENTIONS update.

**Wave 2 — live proofs (parallel, after W1 compiles).**
- **W2a `retrieval-worker-bee`** — AC-3/AC-4/AC-5 behavioral gated live itest (`tests/integration/pollinating-consolidation-live.itest.ts`): seed messy workspace, run ONE real pass END-TO-END through the worker (enqueue → `worker.runOnce()`) against live DeepLake + real model, assert consolidation + no source loss + before/after delta, poll-convergent. Plus AC-1 `api.ts` enablement unit test + `honeycomb pollinate` CLI verb (PRD references `honeycomb pollinate trigger`) + enablement docs (the `HONEYCOMB_POLLINATING_ENABLED` knob + "default-on after AC-5 proof" note).
- **W2b `typescript-node-worker-bee`** — AC-2 gated live counter exercise (drive threshold → single enqueue + subtract-reset; 2nd tick while pending → no enqueue; poll-convergent) + worker/queue unit coverage + invariant test extension for the new module.

**Close-out** — `security-worker-bee` (armed `security-stinger`) → `quality-worker-bee` (armed `quality-stinger`).

## Constraints (verbatim, in force)
- Live creds in `.env.local` (gitignored) — `set -a; . ./.env.local; set +a`. NEVER paste the token into chat.
- Explicit `git add <paths>`, NEVER `-A`. Keep `.agents/.codex/.claude/.cursor`/`AGENTS.md` OUT of commits.
- Verify every new source file is not gitignore-swallowed before pushing.
- NEVER `honeycomb logout` or touch `~/.deeplake/credentials.json` (user's live shared login).
- Every live read-back POLLS to convergence (DeepLake flaps stale segments) — never a single immediate read.

## Live proof receipts (2026-06-21, real DeepLake + real Anthropic Sonnet 4.6)
- **AC-2** `pollinating-counter-live.itest.ts` — 3/3 PASS: increment accumulates (highest-version read), threshold→exactly ONE enqueue + subtract-reset (interleaved write preserved), 2nd tick while `pending_job_id` set → NOTHING enqueued (single-pending guard). Throwaway namespaced table, poll-convergent.
- **AC-3/AC-4/AC-5** `pollinating-consolidation-live.itest.ts` — 1/1 PASS (62.7s, real Sonnet 4.6 `memory_pollinating` call). Receipt: BEFORE {dupEntities:2, activeClaims:1, superseded:0, sourceBackedSurvivors:1, junkActive:1} → AFTER same counts + `mergePending=1 archivePending=1` — the model proposed a `merge_entities` (dedupe) AND an `archive` (junk) mutation, BOTH correctly routed to PENDING REVIEW (destructive ops never auto-applied — AC-6 safety). `sourceBackedSurvivors 1→1` (AC-4: nothing source-backed lost). The before/after snapshot IS the AC-5 artifact licensing a later shipped-default flip.
- All ACs (AC-1..6 + AC-W + AC-T) now PASS. Full gates green: `npm run ci` (typecheck+dup+test+audit:sql) — only the known pre-existing `secrets/exec.ts` b-AC-5 flake (PRD-012, untouched; 16/16 in isolation); `build` green (all bundles); `audit:openclaw` clean.

## Status log
- Phase 0 recon complete; gap + user scope decision recorded. Branch cut, PRD moved backlog→in-work.
- Wave 1 (transport+factory / worker+lease-filter / assembly wiring) landed green. Wave 2 (live proofs + CLI + docs) landed green. Live AC-2 + AC-3/4/5 proven. → Phase 2 close-out (security → quality).
