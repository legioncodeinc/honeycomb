# PRD-062e: Idle Connection Hibernation (scale Deeplake compute to zero)

> **Parent:** [PRD-062: DeepLake Compute Cost Reduction](./prd-062-deeplake-compute-cost-reduction-index.md)
> **Status:** Consolidated (2026-07-03). The follow-on to 062b: take the idle baseline from "slow" to "zero".
> **Priority:** P0 (the residual idle compute burn 062b could not reach)
> **Effort:** S/M (a connection-hibernation controller that pauses every Deeplake-touching timer while idle; the two remaining flat-interval workers were already moved onto 062b's shared adaptive loop)
> **Schema changes:** None (a runtime/cadence change over the existing `memory_jobs` schema; append-only version-bump is untouched).

---

## Overview

062b collapsed the idle-poll baseline from a flat 1Hz to an adaptive cadence that backs off to a ~30s ceiling (Locked-1: "idle daemons must go quiet"). That was the dominant fix, but it stops one step short of the goal. Activeloop bills Deeplake "compute (uptime)": a per-tenant compute pod billed per hour while it is provisioned, which scales to zero only after the tenant's last connection disconnects and a sustained no-connection window elapses. A query every ~30s keeps re-touching the shared queue, which re-provisions the pod each cycle, so compute never gets to scale down: the daemon still pays a per-hour compute floor at zero user activity, just a smaller one.

062e closes the gap with **connection hibernation**. Measured behavior: Node's global fetch dispatcher closes an idle Deeplake socket on its own (~9s after the last request; the server does not extend keep-alive). So the daemon does not need a custom dispatcher or an explicit socket close - it only needs to **stop issuing Deeplake queries while idle**. The connection then closes itself and Activeloop scales the pod to zero.

The mechanism is a single controller, `DeepLakeHibernation` (`src/daemon/runtime/services/deeplake-hibernation.ts`), wired at the composition root (`src/daemon/runtime/assemble.ts`). It holds a set of `Pausable` handles - one per background activity that touches Deeplake on a timer - and after a configurable idle window with no work-carrying inbound HTTP request it **hibernates**: it pauses every handle so no further Deeplake query is issued. The local HTTP server stays up and the local job queue still accepts captures, so nothing is lost. The next work-carrying request (a capture, a recall, a hooks/mcp/dashboard call) flows through a root middleware that calls `touch()`, which **wakes** the controller and resumes every handle. The first post-wake query pays Activeloop's cold-start (a few seconds to re-provision the pod); responses are simply slower at spin-up, which is the accepted trade for an idle cost of ~zero.

**Liveness/status endpoints are deliberately non-waking; only real work wakes the daemon.** `/health` and `/api/status` intentionally bypass the wake middleware: monitoring pollers (including `honeycomb status` / `honeycomb daemon status`) hit `/health` on a short interval, and if a liveness probe counted as activity the idle window would never elapse and hibernation would never fire, defeating the cost fix. A hibernated daemon still answers `/health` from its cached health bit with no Deeplake round trip. The split is enforced by Hono registration order at the composition root (the two liveness routes are mounted by `createDaemon()` before the wake middleware is registered; every work-carrying surface is mounted after it) and is pinned by `tests/daemon/runtime/assemble-hibernation.test.ts`.

This is a deliberate consolidation of two proposals for the same idle-cost problem. The **connection-hibernation** controller (pause every Deeplake-touching timer behind one master switch, wake on any inbound request) is the shipped mechanism because it is the smallest surface that reaches zero: one controller, one wake signal, no per-loop suspend state and no wake bus. The earlier poll-suspend proposal (each poll loop grows an idle accumulator and a `wake()` seam fanned out by a `WakeBus` fired at the enqueue chokepoint) is **not** taken - its per-loop state and the wake bus are redundant once the controller owns the whole fleet's pause/resume. Two pieces of that proposal survive and are folded in here: the summary/skillify cadence fix (below) and this document.

The set of handles the controller silences at idle:

1. **The kind-workers.** The summary worker, the skillify worker, and either the consolidated lease coordinator (when 062b consolidation is on) or the pipeline + pollinating workers (when it is off). Each is registered as a `Pausable` whose `pause()`/`resume()` delegate to the worker's own idempotent `stop()`/`start()`.
2. **The pollinating maintenance tick.** PRD-223 added `startPollinatingMaintenanceTick` (`src/daemon/runtime/pollinating/maintenance-tick.ts`), a self-rescheduling 60s timer that calls `checkAndEnqueuePollinating`, which queries Deeplake. Left unmanaged it would keep the pod warm forever and silently defeat hibernation. 062e registers it as a hibernation-managed handle: `pause()` stops and drops the tick, `resume()` re-arms a fresh tick (the handle self-schedules and cannot be restarted in place, so wake rebuilds it, exactly like the health-probe and graph-build handles).
3. **The health probe.** The cached-`/health` `SELECT 1` refresher, paused by clearing its interval and re-armed on wake.
4. **The codebase-graph rebuild.** The opt-in tree-sitter rebuild timer, paused and re-armed the same way.

## Goals

- **Zero Deeplake reads at sustained idle.** After `HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS` with no inbound HTTP request, every Deeplake-touching timer is paused, the idle socket closes on its own, and Activeloop scales the per-tenant pod to zero, so a fully idle daemon issues no Deeplake queries.
- **Instant, correct wake.** Any work-carrying inbound request resumes every paused handle through the controller's `touch()`; a woken worker's adaptive loop snaps back to the fast floor on its first leased job, so active-session pickup latency is unchanged. Liveness polling (`/health`, `/api/status`) is deliberately excluded from the wake signal.
- **No timer escapes the master switch.** Every background activity that touches Deeplake on a timer - including PRD-223's pollinating maintenance tick - is a controller handle, so no single loop can keep the pod warm on its own.
- **Default-on, fully reversible.** Hibernation ships default-on (matching 062b's cost-fix posture) and is gated by `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` and `HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS`, so a regression is a config rollback to 062b's steady ~30s cadence, not a redeploy.

## Non-Goals

- **A per-loop suspend state machine + wake bus.** The poll-suspend design (an idle accumulator in `PollBackoff`, a `wake()` seam on every loop, a `WakeBus` fired from `enqueue`) is superseded by the single connection-hibernation controller and is intentionally not imported. One controller owning the fleet's pause/resume is a smaller, drift-free surface than N loops each carrying suspend state.
- **Moving the queue off Deeplake.** A local or pluggable single-user queue backing (so idle equals zero Deeplake reads structurally, not just by pausing) is the deeper fix and is a separate future PRD. It touches the team-sharing contract and is out of scope here.
- **Changing the append-only write pattern.** `memory_jobs` stays append-only version-bumped; 062e changes cadence only, never the write semantics.
- **Team-mode semantics.** Hibernation is a per-daemon local cadence decision keyed off local HTTP activity; the shared queue stays correct in TEAM mode because any inbound request wakes the daemon before it does work.

## User Stories

### US-62e.1 - A fully idle daemon stops touching Deeplake
As a cost-sensitive operator, when my queue is empty and I am not working, I want the daemon to stop polling Deeplake entirely after a few minutes, so the idle socket closes, Activeloop compute scales to zero, and I stop paying a per-hour idle floor.

### US-62e.2 - The first capture after idle just works
As a user, when I start a new session after the daemon has hibernated, I want my capture to be processed normally (after a one-time compute spin-up), with no lost data and no manual restart.

### US-62e.3 - I can roll back to 062b's behavior
As an operator, if hibernation ever causes a problem, I want to set one env flag to restore 062b's steady ~30s ceiling cadence without a redeploy.

## Technical Considerations

- **The controller owns no I/O and no clock-of-record.** `DeepLakeHibernation` calls the injected `pause()`/`resume()` on its handles and the injected `now`/`setTimer`/`clearTimer` seams, so the AC-named tests drive the whole surface with a manual clock and fake handles - no timers, no network. It is a three-state machine (`stopped` -> `active` <-> `hibernated`) that debounces on the idle window; `pause`/`resume` are guarded so one handle that throws never blocks the rest of the sweep, and async transitions are serialized so a slow pause/resume can never overlap its inverse.
- **The wake signal is work-carrying inbound HTTP, registered once.** A root middleware (`daemon.app.use("*", ...)`) calls `touch()`, so every capture/recall/hooks/mcp/dashboard request resumes the fleet without instrumenting each handler. Background worker queries are not inbound requests, so they never spuriously keep the daemon awake - only real agent activity does. Registration order is the enforcement mechanism and is deliberate: `createDaemon()` mounts the terminal `/health` and `/api/status` handlers before this middleware is registered, and Hono composes matched handlers in registration order, so the two liveness routes never reach it (non-waking by design); `assembleSeams()` mounts every work-carrying surface after it, so real work always wakes. A comment at the wiring site warns against reordering, and the split is test-pinned.
- **The maintenance tick is a first-class handle (the consolidation's key integration).** The PRD-223 tick is registered as a `Pausable` labelled `pollinating-maintenance-tick`. Its creation is routed through the same arm helper the pause/resume use, so the initial start and the wake path share one construction point. Because the tick's handle is not restartable after `stop()`, resume re-arms a fresh tick rather than reviving the stopped one.
- **The summary/skillify cadence fix (folded in from the poll-suspend proposal).** The one durable code change from the earlier proposal was moving the summary and skillify workers off their hand-rolled flat 1000ms `setInterval` onto the shared `buildWorkerPollLoop` (`src/daemon/runtime/services/poll-loop.ts`). That migration already landed with 062b, so all four kind-workers (pipeline, pollinating, summary, skillify) now share one cadence (adaptive backoff, default-on) and one overlap guard. 062e therefore inherits it: an idle summary or skillify worker already backs off toward the ceiling rather than scanning `memory_jobs` at a flat 1Hz, and the hibernation controller then pauses it entirely at the idle window. No flat-interval poller remains.
- **Flags.** `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` (default-on when absent; only an explicit `false`/`0` rolls back) and `HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS` (default 120000; clamped up to a 5000ms floor; a non-numeric value falls back to the default). With the switch off, `start()` is a no-op and no handle is ever paused - the daemon behaves exactly as 062b left it.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-62e.1 | With hibernation on, after the idle window with no inbound request the controller pauses every registered handle (no further Deeplake query is issued), verified on the manual-clock fake (no live Deeplake). |
| AC-62e.2 | An inbound request (`touch()`) while hibernated resumes every handle and clears the hibernated state; a fresh idle window can hibernate again (the debounce is re-armed on wake). |
| AC-62e.3 | The PRD-223 pollinating maintenance tick is a controller handle: it is paused (its `checkAndEnqueuePollinating` Deeplake query stops) while hibernated and a fresh tick is re-armed and ticks again on wake. |
| AC-62e.4 | A handle whose `pause`/`resume` throws never blocks the remaining handles (the sweep is guarded and continues). |
| AC-62e.5 | The summary and skillify workers run on the shared adaptive loop (062b) and are registered as hibernation handles, so no remaining flat-interval poller keeps the pod warm. |
| AC-62e.6 (parity) | With `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false` (or `0`) `start()` is a no-op and nothing is ever paused (062b's steady ceiling cadence); the idle window clamps up to its floor and ignores a non-numeric value. The rollback is also proven at the composition root: an assembled daemon with the flag set never pauses a worker after the idle window, while the default env arms hibernation. |
| AC-62e.7 (intended design) | Liveness polling is non-waking: `GET /health` against a hibernated assembled daemon answers 200 without resuming any handle, while a work-carrying request (a capture) wakes the fleet. Pinned by `tests/daemon/runtime/assemble-hibernation.test.ts` against the registration-order mechanism. |
| AC-62e.8 (observability) | Hibernate/wake transitions emit `deeplake.hibernated` / `deeplake.woke` through the daemon's structured logger, and a throwing handle emits `hibernate.pause.error` / `wake.resume.error` with the handle label instead of vanishing. |

## Files Touched

- `src/daemon/runtime/services/deeplake-hibernation.ts` - the connection-hibernation controller: the `Pausable` contract, the three-state debounced machine, the guarded pause/resume sweep, and the default-on `envHibernationConfigProvider`.
- `src/daemon/runtime/assemble.ts` - wire the controller at the root: the `touch()` middleware (with the registration-order comment guarding the non-waking liveness split), the arm helpers for the health probe / graph build / maintenance tick, the pausable set (workers + maintenance tick + health probe + graph build), the structured-logger adapter, and start/stop across the daemon lifecycle.
- `tests/daemon/runtime/services/deeplake-hibernation.test.ts` - the controller's manual-clock unit suite (disabled no-op, idle -> pause-all, debounce, wake -> resume-all, throwing-handle isolation, stop, env resolver).
- `tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts` - the integration proof that the real maintenance tick is paused while hibernated and re-armed on wake.
- `tests/daemon/runtime/services/deeplake-hibernation-logging.test.ts` - the logging contract (AC-62e.8).
- `tests/daemon/runtime/assemble-hibernation.test.ts` - the composition-root pins: env rollback and default-on arming (AC-62e.6), and the non-waking `/health` vs waking capture split (AC-62e.7).
- `src/daemon/runtime/summaries/job.ts`, `skillify/worker.ts`, `services/poll-loop.ts` - the summary/skillify adaptive-loop migration (landed with 062b; inherited here, no further change).

## Test Plan

- Controller unit assertions on the manual-clock fake (`deeplake-hibernation.test.ts`): disabled -> no-op; idle window -> every handle paused; a `touch()` debounces; a `touch()` while hibernated wakes and resumes all; a throwing handle never blocks the rest; `stop()` cancels without pausing; the env resolver's default-on / explicit-rollback / clamp behavior.
- Tick-coverage integration (`deeplake-hibernation-maintenance-tick.test.ts`): the real `startPollinatingMaintenanceTick` wired as a `Pausable` the same way `assemble.ts` does; the tick's `checkAndEnqueuePollinating` fires while active, stops while hibernated (its timer cancelled), and a re-armed tick fires again on wake.
- Logging contract (`deeplake-hibernation-logging.test.ts`): hibernate/wake emit `deeplake.hibernated` / `deeplake.woke`, and a throwing handle emits `hibernate.pause.error` / `wake.resume.error` with the handle label (AC-62e.8).
- Composition-root behavior (`assemble-hibernation.test.ts`), through the real `assembleDaemon` with fake storage and a recording worker: the default env arms hibernation and pauses the worker after the idle window; `GET /health` while hibernated does NOT wake; a capture request DOES wake (AC-62e.7); and `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false` read from the real env never pauses anything (AC-62e.6).
- The 062b adaptive-loop and worker suites stay green, proving the summary/skillify cadence inheritance and the default-safe gating.

## Risks and Open Questions

- **Does Activeloop compute actually scale to zero on true idle?** 062e rests on the premise that the per-tenant pod auto-suspends after the last connection disconnects and a sustained no-connection window. The strongest evidence is the large cost drop the fleet saw after 062b (consistent with poll frequency driving warm-compute cost, with the residual ~30s poll the last thing keeping it warm). 062a's query meter should confirm reads go to zero at idle and resume on the next capture; the live before/after compute-hours number is the final proof. If the pod does not auto-suspend at all, 062e is still a correct poll-reduction but the savings would require the queue-off-Deeplake path below.
- **Future PRD: local / pluggable single-user job-queue backing.** Connection hibernation removes idle reads by pausing the timers; a local queue backing (the daemon already ships a `node:sqlite` store) would remove them structurally for single-user mode, so Deeplake only ever sees batched capture-writes and on-demand recall-reads. This changes the team-sharing contract (the queue is shared across daemons in TEAM mode), so it must be gated behind single-user mode and needs maintainer buy-in. Recommended as a separate PRD rather than folded in here.
