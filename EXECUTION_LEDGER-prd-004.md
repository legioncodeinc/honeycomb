# EXECUTION LEDGER — PRD-004 Daemon Runtime

> Single source of truth for the /the-smoker run on PRD-004. Survives context loss.
> Status legend: OPEN · IN PROGRESS · DONE (implemented + locally proven) · VERIFIED (independently graded) · BLOCKED

**Run scope:** `library/requirements/in-work/prd-004-daemon-runtime` (index + 004a..004d)
**Branch:** `prd-004-daemon-runtime` (off `main`, which has merged PRD-001/002/003 + CI). PR targets `main`.
**Builds on:** PRD-002 storage adapter (`src/daemon/storage/`), PRD-003 catalog (`src/daemon/storage/catalog/` + CONVENTIONS.md). The daemon entry `src/daemon/index.ts` is a stub to fill. Live DeepLake is wired (CI secrets + local `.env.local`); the `memory_jobs` queue gets an opt-in live integration test.
**New deps:** Hono + `@hono/node-server` (004a names Hono). Watcher: chokidar or `node:fs.watch` (Bee's call — prefer cross-platform reliability). Git: prefer shelling out to `git` (no dep) over a library.

## Verification posture (defines DONE)
Real runtime code, so verification is mostly **in-process** (no real network/daemon needed): Hono routes via `app.request()`; the queue lease/reaper/backoff against the PRD-002 fake transport (+ an opt-in LIVE `memory_jobs` integration test now that creds work); the watcher against temp dirs + a real temp git repo with vitest fake timers for debounce/sweep; runtime-path middleware in-process. Out of scope: route bodies for capture/pipeline/retrieval/ontology (PRD-005-008), auth policy internals (only middleware wiring), dashboard frontend, real harness-copy destinations (PRD-019 — generate to a documented stub path).

## Resolved foundational decisions (open questions defaulted, not blocked)
| # | Question | Decision |
|---|---|---|
| D-1 | Default bind posture | `127.0.0.1:3850`; team widens explicitly via `HONEYCOMB_BIND` (004a impl note). |
| D-2 | runtime-path claim TTL + sweep | TTL default 4h; sweeper every ~5min (well under TTL). Configurable. |
| D-3 | queue max_attempts / backoff / lease | max_attempts 5; backoff base 1s doubling, cap 5min; lease 5min. Configurable. |
| D-4 | queue/watcher in-process vs separate workers | In-process, daemon-owned (PRD-resolved). |
| D-5 | claim state persistence | In-process map, TTL-bounded, v1 (checkpoint optional). Daemon-only owns any durable persistence. |
| D-6 | watcher debounce window | 500ms default, configurable; one sync + one commit per burst. |

Platform: Windows/PowerShell dev host — cross-platform server bind, fs watch, and git.

## Daemon bootstrap seam (Wave 1 establishes; Wave 2 fills, like PRD-003 stubs)
Wave 1 builds the Hono server + a daemon bootstrap with **pre-wired registration seams** for: a job-queue service, a file-watcher service, and a runtime-path middleware — each a stub module already imported/mounted, so Wave 2's three Bees fill their own module + test with ZERO bootstrap/shared-file contention. Documented in a `src/daemon/runtime/CONVENTIONS.md` (or header).

---

## AC Ledger (28 granular ACs)

### PRD-004a — Hono HTTP Server — Wave 1 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Binds `127.0.0.1:3850`; honors `HONEYCOMB_PORT`/`HOST`/`BIND`. | VERIFIED |
| a-AC-2 | `/health` returns liveness, uptime, version, coarse pipeline status; no heavy DeepLake query. | VERIFIED |
| a-AC-3 | `/api/status` returns resolved config, providers, tenancy. | VERIFIED |
| a-AC-4 | `team` mode: protected route without valid role permission rejected before handler. | VERIFIED |
| a-AC-5 | `local` mode: routes open, handler runs without permission check. | VERIFIED |
| a-AC-6 | A later handler attached to a scaffolded group inherits mounted permission middleware. | VERIFIED |
| a-AC-7 | `HONEYCOMB_BIND` widens bind; remote address reachable (config-level verify). | VERIFIED |

### PRD-004b — Durable Job Queue — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Leased job not leasable by another worker until lease expires/complete/fail. | VERIFIED |
| b-AC-2 | Repeatedly-failing job exceeding retry bound → `dead`, not retried forever. | VERIFIED |
| b-AC-3 | Worker crashes mid-lease → reaper reclaims stale lease, job leasable again within bounds. | VERIFIED |
| b-AC-4 | Failed job with attempts remaining → `next_run_at` reflects exponential backoff. | VERIFIED |
| b-AC-5 | Daemon restart → queued jobs resume, dangling leases reaped. | VERIFIED |
| b-AC-6 | `memory_jobs` first enqueue creates table from ColumnDef array + retries once. | VERIFIED |
| b-AC-7 | Completed job aged past window purged; dead jobs retained longer. | VERIFIED |

### PRD-004c — Identity File Watcher — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | Change to an identity file → per-harness copies regenerate, each with do-not-edit header. | VERIFIED |
| c-AC-2 | Git sync enabled + workspace change → stage + commit with timestamped message. | VERIFIED |
| c-AC-3 | Burst of edits within debounce → exactly one sync + one commit. | VERIFIED |
| c-AC-4 | Unchanged canonical files → byte-identical copies, no spurious commit. | VERIFIED |
| c-AC-5 | Git sync disabled + change → copies regenerate, no commit. | VERIFIED |
| c-AC-6 | Canonical file removed → corresponding harness copy reconciled, watcher keeps running. | VERIFIED |
| c-AC-7 | Daemon up → watcher service active for the life of the process. | VERIFIED |

### PRD-004d — Runtime Path Negotiation — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | Session claimed by `plugin`; `legacy` request for same session → 409 Conflict. | VERIFIED |
| d-AC-2 | Crashed-harness claim past TTL → swept, session reclaimable. | VERIFIED |
| d-AC-3 | Claiming path re-requests own session → proceeds, claim timestamp refreshes. | VERIFIED |
| d-AC-4 | Request without valid `x-honeycomb-runtime-path` → rejected before any session handler. | VERIFIED |
| d-AC-5 | Diagnostics query → reports the active claimed path for a session. | VERIFIED |
| d-AC-6 | Just-expired claim → either path touching it records a fresh claim. | VERIFIED |
| d-AC-7 | On 409, no capture write occurred for that request (fail-closed before handler). | VERIFIED |

### Index roll-ups (transitive)
| Index AC | Satisfied by | Status |
|---|---|---|
| AC-1 /health + /api/status | a-AC-2, a-AC-3 | VERIFIED |
| AC-2 stale lease reaped within retry bounds | b-AC-3 | VERIFIED |
| AC-3 identity change → harness regen + timestamped commit | c-AC-1, c-AC-2 | VERIFIED |
| AC-4 plugin-claimed session → legacy gets 409 | d-AC-1 | VERIFIED |

**Totals:** 28 granular ACs · **28 VERIFIED** · 0 OPEN · 0 BLOCKED — ledger fully VERIFIED (b-AC live-deterministic), close-out unlocked.

---

## Wave plan
```
Wave 1 (004a server + bootstrap seams) ──► Wave 2 (004b ‖ 004c ‖ 004d) ──► Wave 3 (security → quality) ──► Ship
```
- **Wave 1 — HTTP server + bootstrap seams (004a)** · `typescript-node-worker-bee` + `typescript-node-stinger` · **opus**. Hono server on 3850 (config/bind), full route-group scaffold, /health + /api/status, permission middleware (local/team/hybrid), structured logging, the `app.request()` test harness, AND pre-wired registration seams + CONVENTIONS for the queue/watcher/runtime-path so Wave 2 plugs in contention-free. Adds Hono deps.
- **Wave 2 — runtime services (parallel)** · 3× `typescript-node-worker-bee`, each its own module + test:
  - 004b job queue (memory_jobs catalog + lease/complete/fail/dead/backoff/reaper/restart + opt-in live integration test) — **opus** (durable correctness is subtle).
  - 004c file watcher (sync + git + debounce, temp-dir/temp-git tests, fake timers) — **sonnet**.
  - 004d runtime-path middleware (claim map + 409 + sweeper, fail-closed) — **sonnet**.
- **Wave 3 — Close-out** · `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Security real: bind posture / `HONEYCOMB_BIND` exposure, permission middleware, runtime-path fail-closed, git auto-commit must not commit secrets.

Dependency: Wave 1 (server + seams) hard-blocks Wave 2 (004d mounts on the server; all three register via the bootstrap seam). 004b/004c/004d are otherwise independent → parallel.

---

## Watchdog / event log
- PRD-004 moved backlog→in-work (git mv); index status In-Work. Branch `prd-004-daemon-runtime` off main (PRD-001/002/003 + CI merged). Reference: hivemind-v1 has no Hono daemon — greenfield design from the FRs.
- Wave 1 (004a) → `typescript-node-worker-bee` (opus). Hono server + config/bind + /health + /api/status + permission middleware + logger + the 3 wired Wave-2 stubs + runtime/CONVENTIONS.md. +39 tests (157 total). Added hono + @hono/node-server.
- Orchestrator verify: ci=0 (157 tests), build/audit:openclaw green; 7 a-AC named+unskipped; Hono confined to daemon bundle (0 in cli/openclaw/mcp); stubs wired. → a-AC-1..7 VERIFIED.
- Wave 2 dispatched: 3 parallel `typescript-node-worker-bee` — 004b (opus), 004c (sonnet), 004d (sonnet), each filling its pre-wired stub + own test.
- Wave 2 (3 parallel Bees) returned. 004d runtime-path (sonnet, 25 tests) + 004c file-watcher (sonnet) — unit suites green. 004b job-queue (opus) — unit suite green (b-AC-1..7 vs fake transport) + added `catalog/runtime-jobs.ts` (memory_jobs) + live itest.
- Orchestrator verify: full unit gate green (ci=0, 205 tests/19 files, build/audit:sql/audit:openclaw green); all 21 b/c/d AC names present, no real skips. → c-AC + d-AC VERIFIED.
- **Orchestrator ran the LIVE integration suite (.env.local) — caught a real bug:** the 4 generic DeepLake live tests pass, but BOTH `memory_jobs` queue live tests FAIL — `queue.lease()` returns null/undefined immediately after `enqueue()` against real DeepLake (unit/fake-transport masked it). The queue's enqueue→lease round-trip is broken on the real backend (likely the `status='queued' AND next_run_at <= now` ISO-string predicate or a read-after-write gap). **b-AC reopened (live-FAIL).** Dispatching `deeplake-dataset-worker-bee` to debug + fix against live DeepLake without breaking the unit suite.
- First live-fix Bee (deeplake-dataset, opus): found a layered bug — the live test used an UNAUTHORIZED workspace (403 on every memory_jobs query → table never healed → lease null); fixed isolation + 3 queue consistency gaps (by-id UPDATE transitions, latest-write-wins reads, polled reaper). Reported 6/6. BUT orchestrator independent re-run ×4: runs 1/3/4 = 6/6, run 2 = 5/6 — the **reaper (b-AC-3) still flakes ~25% live** because DeepLake's status-index flaps non-monotonically after an UPDATE (the Bee's own diagnosis). The `update-or-insert` queue design is the root cause AND violates PRD-004b FR-6 ("DeepLake append/version patterns").
- **b-AC reopened (architectural):** dispatching `deeplake-dataset-worker-bee` to redesign `memory_jobs` as append-only **version-bumped** (state transitions append version N+1; reads take highest version per job id — the pattern DeepLake serves consistently per the generic live test). Bar: deterministic across many consecutive live runs.
- Version-bump redesign Bee (deeplake-dataset, opus): rewrote `memory_jobs` as append-only version-bumped (transition=append vN+1; reads=monotone-convergent highest-version via bounded poll-union — the only pattern reliable on this backend, which round-robins ALL scans across stale segments). Added `version` col + `version-bumped` pattern. STRENGTHENED the live test (reaped→leasable-again, completed→not-leasable). 9 consecutive clean runs.
- Orchestrator independent verify: unit ci=0 (205 tests); **5/5 consecutive clean live runs (6/6 each)** — reaper flakiness gone. → **b-AC-1..7 + index roll-ups VERIFIED. All 28 ACs VERIFIED.**
- Carry to Wave 3 security: `audit:sql` (`scripts/audit-sql-safety.mjs`) scans only `src/daemon/storage/`; the queue's hand-built SQL now lives in `src/daemon/runtime/services/job-queue.ts` — widen the scan to cover `src/daemon/runtime` and confirm the queue SQL is guarded.
- Wave 3 close-out dispatched: `security-worker-bee` (opus) → `quality-worker-bee` (sonnet).
- `security-worker-bee` (opus): **2 High FIXED** — H-1 `audit:sql` scope gap (widened to `src/daemon/`, added `this.tbl()` safe-method recognizer, teeth proven on runtime path); H-2 file-watcher git auto-commit used `git add -A` (could commit a stray secret to history) → bounded `git add -- <managed identity pathspecs>` + regression test asserting an unrelated `credentials.json` is NOT committed. M-1 (claim-map no hard cap) + I-1 (queue full-table discovery scan scalability) RECOMMENDED. Report: `.../reports/2026-06-17-security-report.md`.
- Orchestrator re-verify: ci=0 (206 tests), build/audit:openclaw=0; audit:sql scans 31 files under src/daemon, clean + teeth (runtime bypass → exit 1); git-sync bounded (no `add -A`). job-queue.ts untouched by security → live determinism (5/5) holds. **No blocking findings.**
- `quality-worker-bee` (sonnet) dispatched.
