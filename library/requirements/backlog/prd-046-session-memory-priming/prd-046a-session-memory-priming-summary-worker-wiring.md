# PRD-046a — Wire + trigger the summary worker in the live daemon

> Status: backlog · Parent: PRD-046 · Wave: W0 · Type: S
> Goal: make PRD-017's already-built per-session summary worker actually run on a live daemon, so
> Tier-2 `memory` summaries land on real triggers. This is the foundational unblock — every later
> slice (keys, prime) depends on summaries existing.

## Why
PRD-017 (wiki-summaries) is `Completed`: the 017a summary worker is a full, QA-passed implementation
(`runSummaryWorker` in `src/daemon/runtime/summaries/worker.ts`) that, given a trigger + session
events, runs the host-CLI gate and writes a `memory` summary row at `/summaries/<userName>/<sessionId>.md`
(with `summary` + `description` + a non-fatal embedding, SELECT-before-INSERT exactly-once,
per-session lock, secret-redaction). But it is **not wired into the live daemon** — a verified
deferred-assembly gap:

- `runSummaryWorker` is invoked **nowhere** in `src` outside its own module.
- `server.ts` / `assemble.ts` mount no summary job.
- The 017 QA report + CONVENTIONS document this explicitly: "the summary worker (the `memory_jobs`
  job that runs `runSummaryWorker` on a trigger) and the hook signal (the final + periodic triggers)
  are mounted by the daemon-assembly step… Wave 1 does NOT edit `server.ts`." Same honest posture as
  PRD-008–016.

So summaries do not actually get produced today. This slice mounts the job and wires the triggers.

## What (scope)
- **Mount the summary worker job** in the daemon assembly (the `memory_jobs` registry / the same
  seam other deferred-assembled jobs use), so the daemon dispatches to `runSummaryWorker` with the
  real `SummaryWorkerDeps` (storage, embed client, the gate CLI spawner, the file session lock).
- **Wire the triggers** the worker already declares in `summaries/contracts.ts`:
  - the FINAL triggers (`FINAL_TRIGGER_EVENTS` — session end / `--resume`/`--continue` close) →
    summarize the just-ended session;
  - the PERIODIC trigger (`PERIODIC_TRIGGER_REASONS` — the turn-counter periodic threshold) →
    summarize a long-running session before it ends.
- **Honor the worker's existing safety env** on the spawned gate subprocess
  (`HONEYCOMB_WIKI_WORKER=1`, `HONEYCOMB_CAPTURE=false`, `HONEYCOMB_WORKER=1` recursion-guard) so the
  summary pass never re-enters the capture loop.
- **Reuse, do not re-implement.** No change to summarization logic, the write path, or the schema; this
  is pure assembly + trigger wiring.

Synthesis (017b `/MEMORY.md`) mounting + its write-once refresh fix are handled in **046b** (which
reuses synthesis output for the Tier-1 keys), to keep this slice to the single foundational concern.

## Acceptance criteria
- **a-AC-1 — The job is mounted.** The daemon assembly registers a summary job that invokes
  `runSummaryWorker`; grep proves `runSummaryWorker` is now called from the assembly, not only defined.
  Unit-tested at the assembly seam with a fake worker.
- **a-AC-2 — Final trigger produces a summary.** A simulated session-end trigger drives the worker to
  write a `memory` row at `/summaries/<userName>/<sessionId>.md`. Verified live (poll-convergent
  read-back) in a gated itest; skips cleanly without a token.
- **a-AC-3 — Periodic trigger fires once.** The turn-counter periodic threshold triggers at most one
  concurrent summary per session (the worker's existing per-session lock holds end-to-end through the
  live wiring). Unit-tested.
- **a-AC-4 — No capture re-entry.** The mounted worker spawns its gate with `HONEYCOMB_WIKI_WORKER=1`
  + `HONEYCOMB_CAPTURE=false` + the recursion guard, verified on the live-assembled path (not just the
  module env constants).
- **a-AC-5 — Gates green; no regression.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw`
  stay green; the assembly change touches only the job-mount seam; the no-direct-connection invariant
  holds.

## Risks / Out of scope
- **Risk — trigger duplication.** A final + a periodic trigger could both fire for one session.
  Mitigated by the worker's existing per-session lock (a-AC-3) — re-use it, do not add a second
  mechanism.
- **Risk — gate cost / latency on a live daemon.** The gate CLI runs the host agent; mounting it means
  real subprocess cost on triggers. Keep it the background/fire-and-forget posture the worker already
  assumes; never block a user turn on summarization.
- **Out of scope — synthesis (`/MEMORY.md`) wiring + refresh** (→ 046b), **Tier-1 key generation**
  (→ 046b), **the prime** (→ 046c/046d).

## Dependencies
- PRD-017 (`Completed`) — `runSummaryWorker`, `SummaryWorkerDeps`, `FINAL_TRIGGER_EVENTS`,
  `PERIODIC_TRIGGER_REASONS`, the env constants, all in `src/daemon/runtime/summaries/`.
- The daemon assembly + job registry (`src/daemon/runtime/assemble.ts`, `server.ts`, the `memory_jobs`
  / job-queue seam used by the other deferred-assembled jobs).
- DeepLake eventual consistency — the live AC-2 read-back polls to convergence.
