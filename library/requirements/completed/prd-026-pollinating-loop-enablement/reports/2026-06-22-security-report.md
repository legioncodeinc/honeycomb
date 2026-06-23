# PRD-026 Pollinating Loop Enablement — Security Close-Out Report

- **Date:** 2026-06-22
- **Branch:** `main` (reconciliation / close-out verification — code already shipped)
- **Auditor:** security-worker-bee (security-stinger)
- **Scope:** ONLY the PRD-026 change set — turning the PRD-009 Pollinating consolidation loop ON via `HONEYCOMB_POLLINATING_ENABLED=true`, the `POST /api/diagnostics/pollinate` trigger ack, the enablement default, the 008c risk-routed mutation path, and the model-call seam. No re-architecture of the loop (PRD-009 owns it).
- **Lenses:** OWASP A01 (broken access control), A07 (auth/identity), A09 (security logging / leakage); captured-trace PII/credential catalog (C2/C5/C6); AI-code failure catalog (missing `sqlIdent`, token-in-logs, unscoped query). Catalog C is Critical/High by construction.
- **Ordering:** `quality-worker-bee` has NOT yet run for this surface — no `*-qa-report.md` for PRD-026 exists, and the only QA reports newer than the last commit (`2026-06-22 03:57`) belong to unrelated PRDs (014, 034). No ordering inversion. QA may run after this report.

## Verdict

**PASS — clean. Zero findings at any severity. No remediation required.** All four security properties the task names hold **by construction** and are test-proven:

1. **No-secret trigger ack** — the `POST /api/diagnostics/pollinate` ack is a closed-enum body `{ triggered, status, reason }`; `reason` can only be one of five fixed literals from the `PollinatingTickReason` enum. A token/secret/org-GUID/header cannot be carried.
2. **Safe-by-default enablement** — `config.ts` defaults `enabled: false` (false-safe). ON requires the explicit `HONEYCOMB_POLLINATING_ENABLED=true`/`1` env flag; any other value resolves to OFF.
3. **Mutation authority** — every mutation routes through `submitProposal` (008c risk router); the runner issues NO direct graph SQL. Destructive ops always land in pending review.
4. **Model-call path** — the API key is never inlined or logged; the runner calls an abstract `ModelClient.complete(workload, prompt)` seam that holds zero provider/key knowledge. All `pollinating_state` SQL is `sLiteral`/`sqlIdent`-guarded.

`npm run ci` (typecheck + jscpd dup + 2325 vitest tests + `audit:sql`) is fully green; the 6 skipped tests are the creds-gated live itests (correctly skipped in CI). No code change was made because nothing was vulnerable — the working tree carries no security diff (minimal blast radius = zero).

## Change set audited

`src/daemon/runtime/pollinating/{config.ts, api.ts, trigger.ts, runner.ts, contracts.ts, incremental.ts, compaction.ts, worker.ts, index.ts}`; the model seam `src/daemon/runtime/pipeline/model-client.ts`; the apply seam `src/daemon/runtime/ontology/control-plane.ts` (`submitProposal`); the daemon wiring in `src/daemon/runtime/assemble.ts` (the `mountPollinateApi` call) and the protected route group in `src/daemon/runtime/server.ts:94`.

## Finding-by-finding analysis (the four named concerns)

### 1. No-secret in the trigger ack — SECRET-FREE BY CONSTRUCTION (AC-6 / PRD-024 D-4)

The ack is built in `pollinating/api.ts` by `ackFor(result)` (`api.ts:166-179`) from a `PollinatingTickResult`. The shape (`PollinateAck`, `api.ts:130-137`) is `{ triggered: boolean, status: "enqueued"|"running"|"skipped", reason?: string }`.

- `status` is a 3-value closed string-literal union — cannot carry a secret.
- `reason` is `result.reason`, which the trigger sets to one of exactly five fixed literals: `PollinatingTickReason = "threshold-met" | "pending" | "pending-cleared" | "disabled" | "below-threshold"` (`trigger.ts:426-431`). Every `return` in `checkAndEnqueuePollinating` (`trigger.ts:365-419`) uses one of these literals verbatim. There is no path where row content, a job id, an org id, a header, or a token flows into `reason`. (The enqueued `jobId` is carried on `PollinatingTickResult.jobId` but `ackFor`'s `enqueued` arm returns `{ triggered: true, status: "enqueued" }` only — `jobId` is **not** placed in the ack body.)
- The 400 fail-closed body (`NO_ORG_BODY`, `api.ts:140`) is a fixed `{ error, reason }` string — no echo of the supplied header value.
- No pollinate log line carries a secret: every `logger.event(...)` in `runner.ts` (lines 209, 217, 241, 246, 285) and `worker.ts` (lines 222, 239, 249) forwards only coarse fields — `mode`, `agentId`, `mutations` (count), `kind`, `operation`, `route`, `status`, `proposalId`, `length` (an integer = `raw.length`), `id`, `attempt`, `reason`. The model `prompt` (which contains summary content) and the raw model output are NEVER logged; `pollinating.parse.invalid` logs `raw.length`, not `raw`.

**Result:** no token, secret, org GUID, or header value in the ack body or any pollinate log line. PRD-024 D-4 (carried into AC-6) holds.

### 2. Safe-by-default enablement — GENUINELY FALSE-SAFE (D-1)

`config.ts:63` declares `enabled: BoolFlag.default(false)`. `BoolFlag` (`config.ts:38-41`) coerces a raw env string to `true` ONLY when it is exactly `"true"` or `"1"` (or already a boolean true); every other value — including `undefined` (flag missing), `"false"`, `"0"`, `"yes"`, garbage — resolves to `false`. The env provider (`config.ts:114-125`) reads `HONEYCOMB_POLLINATING_ENABLED` and nothing else flips the master switch.

A missing flag is therefore OFF (no surprise model spend), and ON requires the explicit, documented env knob. The runtime gate is enforced in `trigger.ts:388`: `if (!this.config.enabled) return { decision: "disabled", ... }` — a disabled loop increments the counter but enqueues NOTHING. The `api.ts` ack maps `disabled` → `{ triggered: false, status: "skipped", reason: "disabled" }`. D-1 holds.

### 3. Mutation authority — ONLY VIA `submitProposal`, NO BLIND-APPLY PATH (D-3)

`runner.ts` is the only thing that applies model-returned mutations, and `applyOne` (`runner.ts:274-297`) routes **every** mutation through `submitProposal(this.storage, this.scope, proposal, actor)` (`runner.ts:284`). The runner issues NO direct graph SQL — confirmed by the module's own SQL-safety note (`runner.ts:45-49`) and by `audit:sql` (197 files, all interpolations escaped). The mapping `MUTATION_KIND_TO_OPERATION` sends destructive kinds (`merge_entities`, `delete_entity`, `delete_attribute`, `supersede_attribute`) to operations outside the direct-apply allow-list, so the control plane's risk router forces them to pending review; only bounded additive ops can direct-apply. The `pollinating_state` counter writes (`trigger.ts`) are append-only via `appendVersionBumped` and never touch the ontology graph. There is no code path by which the loop writes the graph outside the risk-routed apply. D-3 holds.

### 4. Model-call path — API KEY NEVER INLINED OR LOGGED; SQL GUARDED (D-5)

The pollinating pass calls `this.model.complete(POLLINATING_WORKLOAD, payload.prompt)` (`runner.ts:213`), where `POLLINATING_WORKLOAD = "memory_pollinating"`. The `ModelClient` seam (`model-client.ts`) is a "raw text in, raw text out" interface that holds **zero** provider knowledge: no API key, no model name, no `process.env`, no `Authorization` header. A grep of `model-client.ts` and the entire `pollinating/` tree for `ANTHROPIC|api[_-]?key|bearer|authorization|process.env|credentials.json` returns only doc-comment text and LLM-token-budget arithmetic — zero live secret reads. The `${ANTHROPIC_API_KEY}` resolution lives entirely behind the PRD-010 router seam, which is outside PRD-026's surface (correct secret-exec seam, not inlined). Every `pollinating_state`/ontology statement is built with `sLiteral`/`sqlIdent` (`trigger.ts:59-60, 214, 260-263`); the optional `tableName` override is validated through `sqlIdent` (`trigger.ts:214`) so a config-driven identifier cannot inject. D-5 holds.

## General hardening checks

- **Tenancy scope is derived, not attacker-widened.** `resolveTriggerScope` (`api.ts:148-157`) reads `x-honeycomb-org` for the per-request partition and falls back to the daemon's `defaultScope`, failing closed (400) when neither has an org. The scope only PARTITIONS the pollinating counter for the caller's own tenant; it does not let a caller name another org's counter rows, and the agent key is the fixed `"default"` (`api.ts:79`). No cross-tenant read/write path (A01).
- **Route is protected.** `/api/diagnostics/pollinate` rides the `/api/diagnostics` group declared `{ protect: true }` (`server.ts:94`); in team/hybrid an unauthenticated remote is rejected by the group middleware before the handler runs. Open in `local` by design (single-user loopback). A07 holds.
- **Fail-soft, never 500.** An unavailable queue returns a clean `{ triggered: false, status: "skipped", reason: "unavailable" }` (`api.ts:220-223`) — no stack trace, no internal detail leaked (A09).
- **No new dependency.** No `package.json`/`package-lock.json` change in this surface; the npm supply chain is unchanged.

## Gate results

| Gate | Result |
|------|--------|
| `npm run typecheck` (tsc --noEmit) | PASS — no errors |
| `npm run dup` (jscpd) | PASS — under threshold |
| `npm run test` (vitest) | **2325 passed, 6 skipped** (the 6 are creds-gated live itests, correctly skipped in CI) — 213 test files |
| `npm run audit:sql` | OK — 197 files, every SQL interpolation routes through `sLiteral`/`sqlLike`/`sqlIdent` |
| `git status` | No code change from this audit (no remediation needed); only an unrelated execution-ledger file staged |

## Findings by severity

- **Critical:** None detected.
- **High:** None detected.
- **Medium:** None detected.
- **Low:** None detected.
- **Informational:** None requiring action. (Pre-existing dev-dep `npm audit` advisories — esbuild dev-server / tmp symlink — are out of PRD-026 scope: no dependency added by this surface; they belong to dependency-audit-worker-bee.)

## Discipline confirmation

No AC or test weakened. No `git add` performed by this audit. No source file modified (nothing was vulnerable). No new dependency introduced. Every finding category was explicitly checked and recorded.
