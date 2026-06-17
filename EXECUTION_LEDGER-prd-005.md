# EXECUTION LEDGER — PRD-005 Capture Intake

> Single source of truth for the /the-smoker run on PRD-005. Survives context loss.
> Status legend: OPEN · IN PROGRESS · DONE (implemented + locally proven) · VERIFIED (independently graded) · BLOCKED

**Run scope:** `library/requirements/in-work/prd-005-capture-intake` (index + 005a/005b/005c)
**Branch:** `prd-005-capture-intake` (off `main`, which has merged PRD-001..004 + CI). PR targets `main`.
**Builds on:** PRD-004 daemon (`src/daemon/runtime/server.ts` — the `/api/hooks/*` route group + permission/runtime-path middleware; the `memory_jobs` job queue for per-turn counters), PRD-003c `sessions` catalog (`src/daemon/storage/catalog/sessions-summaries.ts`), PRD-002 storage (`appendOnlyInsert`, `sqlStr`/`eLiteral`, `embeddingColumn`/`assertEmbeddingDim`/`EMBEDDING_DIMS=768`). Live DeepLake wired (`.env.local` + CI secrets).

## Verification posture (defines DONE)
- **005a capture endpoint:** in-process via the PRD-004 `app.request()` harness; the sessions write asserted against the PRD-002 fake transport (one append-only INSERT per event, JSONB message, scope columns, heal-once, counters enqueued). PLUS an opt-in LIVE sessions-write integration test (sessions is append-only → DeepLake serves it consistently, proven by the generic live test).
- **005b embedding attach:** against a FAKE embed client (the real embed daemon is NOT built here — consumed, not built). Assert: enabled→768-dim attached; disabled→null; embed fail/unreachable→null+logged+capture still succeeds; non-768→rejected→null; non-blocking→capture returns without awaiting the embed.
- **005c capture guards:** pure in-process unit tests of the shim-side `capture-gate` module (bypass/plugin/entrypoint/recursion/fail-soft). NO daemon call when skipped.
- Out of scope: the distillation pipeline (PRD-006), the summary/skillify WORKERS (only cued), the embed daemon hosting (PRD embeddings-runtime), real harness shim wiring (PRD-019 — capture-gate is the shared module they'll use).

## Resolved foundational decisions (open questions defaulted, not blocked)
| # | Question | Decision |
|---|---|---|
| D-1 | per-turn counter thresholds | Daemon tracks per-session counters; on a turn-terminating event, bump + when crossed enqueue a summary/skillify job to `memory_jobs` (NOT inline). Defaults: summary every ~20 messages, skillify every ~10 turns. Configurable; the workers themselves are PRD-006/skillify. |
| D-2 | bypass switch for non-env harnesses | env `HONEYCOMB_CAPTURE` primary (`==="false"` disables; any other/unset = enabled); a config/header seam for harnesses without an env channel. |
| D-3 | embedding inline-async vs deferred | **Inline-async fire-and-forget**: capture INSERTs the row immediately with `message_embedding` NULL and returns; the embed is computed without awaiting, then a SINGLE UPDATE attaches it to that row id (a single non-concurrent attach-UPDATE is safe on DeepLake; eventual visibility is fine for recall). On disable/fail → no UPDATE, column stays null. |
| D-4 | embed daemon client contract | A typed client interface (request text → 768-dim vector, with timeout) injected into the capture handler; real impl is the embed daemon (future PRD), a fake drives tests. |
| D-5 | recursion-guard mechanism | An env marker the workers set when they spawn the harness CLI (e.g. `HONEYCOMB_WORKER=1`); the gate suppresses capture when present. (Process-tree/lockfile deferred.) |

Platform: Windows/PowerShell — cross-platform.

## Seam plan (Wave 1 establishes; Wave 2 fills — the proven PRD-004 pattern)
Wave 1 builds the capture route + sessions write + counters AND pre-wires two stubs: (a) an injected `embedClient` seam the capture handler calls non-blocking after INSERT (005b fills), (b) the shim-side `capture-gate` module (005c fills). Wave 2's two Bees fill their own module + test with zero shared-file contention.

---

## AC Ledger (17 granular ACs)

### PRD-005a — Capture Endpoint — Wave 1 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Posted event → one `sessions` row INSERTed with JSONB `message` + a `path` grouping the conversation. | VERIFIED |
| a-AC-2 | Multiple events in a turn → each its own row, never concatenated. | VERIFIED |
| a-AC-3 | Row carries session id, cwd, permission mode, hook event name, agent_id, org, workspace. | VERIFIED |
| a-AC-4 | sessions table missing → daemon creates it + retries the INSERT once. | VERIFIED |
| a-AC-5 | Turn-terminating event → per-turn counters bumped, summary/skillify NOT run inline. | VERIFIED |
| a-AC-6 | Conversation read back → ordered by creation_date, scoped to requesting org/workspace. | VERIFIED |

### PRD-005b — Embedding Attachment — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Embeddings enabled → 768-dim vector computed + written to `message_embedding`. | VERIFIED |
| b-AC-2 | Embedder disabled → column null; event still captured + lexically searchable. | VERIFIED |
| b-AC-3 | Embedder fails/unreachable → failure logged, column null, capture write still succeeds. | VERIFIED |
| b-AC-4 | Embedding in flight → turn completion does NOT wait on the embed call. | VERIFIED |
| b-AC-5 | Returned vector not 768-dim → rejected, column left null. | VERIFIED |

### PRD-005c — Capture Guards — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | `HONEYCOMB_CAPTURE=false` → capture skipped, turn proceeds. | VERIFIED |
| c-AC-2 | Disabled plugin → capture skipped. | VERIFIED |
| c-AC-3 | Non-capture entrypoint → capture skipped. | VERIFIED |
| c-AC-4 | Summary/skillify worker running the CLI → recursion guard suppresses capture of its activity. | VERIFIED |
| c-AC-5 | Capture errors → hook exits cleanly (fail-soft), turn not broken. | VERIFIED |
| c-AC-6 | Any guard skips → no daemon capture request made, no sessions row written. | VERIFIED |

### Index roll-ups (transitive)
| Index AC | Satisfied by | Status |
|---|---|---|
| AC-1 one sessions row per event, JSONB, no concat | a-AC-1, a-AC-2 | VERIFIED |
| AC-2 embedding non-blocking; null on disable/fail + lexical | b-AC-1, b-AC-2, b-AC-3 | VERIFIED |
| AC-3 HONEYCOMB_CAPTURE=false / disabled plugin → skip | c-AC-1, c-AC-2 | VERIFIED |
| AC-4 recursion guard stops worker self-capture | c-AC-4 | VERIFIED |

**Totals:** 17 granular ACs · **17 VERIFIED** · 0 OPEN · 0 BLOCKED — ledger fully VERIFIED, close-out unlocked.

---

## Wave plan
```
Wave 1 (005a capture endpoint + seams) ──► Wave 2 (005b ‖ 005c) ──► Wave 3 (security → quality) ──► Ship
```
- **Wave 1 — Capture endpoint (005a)** · `typescript-node-worker-bee` + `typescript-node-stinger` · **opus**. The `/api/hooks/capture` route on the PRD-004 server, the normalized event contract (user_message/tool_call/assistant_message), one append-only `sessions` INSERT per event (JSONB message, scope, path), heal-once, per-turn counters → `memory_jobs` enqueue (not inline), read-back ordered/scoped. Plus an opt-in LIVE sessions-write test. Pre-wires the `embedClient` seam (005b) + the `capture-gate` shim module stub (005c).
- **Wave 2 — parallel** · 2× `typescript-node-worker-bee`:
  - 005b embedding attach (fake embed client; 768 guard; fail-soft; non-blocking; single attach-UPDATE) — **sonnet**.
  - 005c capture guards (shim-side `capture-gate`: bypass/plugin/entrypoint/recursion/fail-soft) — **sonnet**.
- **Wave 3 — Close-out** · `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). HIGH security relevance: this is the captured-trace/PII surface — SQL injection via a malicious prompt into the JSONB message, org/workspace scope isolation on every row, fail-soft not leaking errors, recursion guard preventing a capture loop (DoS).

Dependency: Wave 1 (route + sessions contract + seams) hard-blocks Wave 2 (005b attaches to the row 005a inserts; both fill Wave-1 seams). 005b/005c independent → parallel.

---

## Watchdog / event log
- PRD-005 moved backlog→in-work (git mv); index status In-Work. Branch `prd-005-capture-intake` off main (PRD-001..004 + CI merged).
- Wave 1 (005a) → `typescript-node-worker-bee` (opus). Capture route `/api/hooks/capture` (behind runtime-path+permission), event contract (zod), one append-only sessions INSERT per event (JSONB message via eLiteral), heal-once, per-turn counters → memory_jobs enqueue (no inline worker), read-back ordered/scoped. +54 tests (241). Created embed-client seam + src/shared/capture-gate stub. LIVE sessions-write test passes.
- Orchestrator verify: ci=0 (241 tests), build/audit:openclaw/audit:sql green; a-AC-1..6 named+unskipped; capture-gate shim-side (src/shared, 0 leak into cli bundle); LIVE integration 7/7 (incl. real sessions write + read-back). → a-AC-1..6 VERIFIED.
- Wave 2 dispatched: 005b embed attach (sonnet) ‖ 005c capture guards (sonnet), each filling its own seam.
- Note for QA: JSONB `message` stores `{event, metadata}` envelope (not bare event) so FR-5 fields without a dedicated column survive — documented design call.
- Wave 2 (parallel): 005b embed-attach (sonnet, 21 tests — EmbedClient/StorageEmbeddingAttacher, HONEYCOMB_EMBEDDINGS toggle, single attach-UPDATE via sqlIdent/serializeFloat4Array, 768 dim guard, fail-soft) ‖ 005c capture-guards (sonnet, 20 tests — bypass/plugin/entrypoint/recursion + fail-soft runCaptureGuarded, no-op-on-skip, ZERO imports).
- Orchestrator verify: ci=0 (282 tests, 24 files), build/audit:openclaw/audit:sql green; 11 b/c AC names present, no skips; capture-gate self-contained (0 real imports, 0 leak into cli/openclaw bundles); embed dim guard present. → b-AC + c-AC + index roll-ups VERIFIED. All 17 ACs VERIFIED.
- Wave 3 close-out dispatched: `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Captured-trace/PII surface — highest security stakes yet.
- `security-worker-bee` (opus): **1 High FIXED** — S-1 unbounded per-session counter Map (attacker-controllable sessionId → memory-exhaustion DoS) → capped 50k + FIFO eviction + 4 regression tests. SQL-injection-via-prompt verified SAFE (eLiteral round-trips; audit:sql teeth on capture path). Medium follow-ups (RECOMMENDED): S-2 embed-URL SSRF (env-only, loopback default), S-3 workspace raw in DeepLake URL path (PRD-002 transport surface), S-4 caller-asserted tenancy headers (the known PRD-004 default-deny-stub auth boundary — real auth policy is a later PRD). Report: `.../reports/2026-06-17-security-report.md`.
- Orchestrator re-verify: counter map bounded (50k+FIFO); ci=0 (286 tests), build/audit:openclaw green; audit:sql flags a planted capture-path prompt-injection bypass (teeth), clean otherwise; npm audit --omit=dev 0 vulns. **No blocking findings.**
- `quality-worker-bee` (sonnet) dispatched.
- `quality-worker-bee` (sonnet): **PASS** — 17/17 ACs + 4 index roll-ups PASS (non-vacuous; incl. adversarial SQL-injection round-trip, embed fail-soft, non-blocking, dim guard, fail-soft no-op-on-skip). Live capture 7/7 (prior run). 3 non-blocking Suggestions. Report: `.../reports/2026-06-17-qa-report.md`.
- Orchestrator assessed S-QA-1 (capture handler not mounted in createDaemon): **consistent deferral, not a gap** — `createDaemon` uses noop stub defaults for ALL services (queue/watcher/runtime-path too); the real-service assembly (incl. capture) is the not-yet-built CLI/startup entrypoint (PRD-020). S-QA-3 (capture-gate barrel export) trivial follow-up for PRD-019. Both gates clean at medium+ → loop terminates.
- **Ship:** committing capture intake + library; PR targets main.
