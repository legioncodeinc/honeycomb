# PRD-073a: The Per-Session Bound-Project Capture Gate

> **Parent:** [PRD-073](./prd-073-dormant-capture-and-explicit-tenancy-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L (1-2d)
> **Schema changes:** None to Deeplake. One additive capture-config flag (the inbox opt-in, default off).

---

## Goals

Replace the one-shot workspace-level first-run gate with a PER-SESSION bound-project gate: a capture whose cwd resolves to no folder binding writes nothing, forever, not just before the first binding. Make the `__unsorted__` inbox an explicit opt-in (default off). Keep bound-folder capture and existing installs byte-identical in behavior.

## Scope

- **The gate moves from "workspace has any binding" to "THIS session's cwd resolved to a binding".** Today `firstRunGateClosed` (`src/daemon/runtime/capture/capture-handler.ts:555-575`) asks `hasBoundProjectOnDisk` (workspace-level, `src/hooks/shared/project-resolver.ts:649-662`) and, once any binding exists, the handler proceeds and `resolveCaptureProjectId` falls through the resolver ladder to the inbox for an unbound cwd (`project-resolver.ts:598-601`). The new check runs AFTER scope resolution: a `ResolvedScope` with `bound: false` (`project-resolver.ts:434-445`) gates the capture unless the inbox opt-in is on. The resolver itself is unchanged; only the handler's consumption of `bound` changes.
- **The gated ack becomes reasoned.** The current gated ack is `{ ok: true, gated: true, path, enqueued: [] }` (`capture-handler.ts:279-281`). It grows a machine-readable `reason` field: `no_bound_project` (this sub-PRD) or `tenancy_unconfirmed` (073c). Additive; the shim tolerates the old shape.
- **Everything downstream of the gate stays un-forked.** The `sessions` insert, per-turn cue enqueue, and the memory-pipeline entry enqueue (`capture-handler.ts:283-318`) all sit behind the one gate check, so gating capture gates the whole write-producing chain for that event. Skillify mines captured `sessions` rows, so gated sessions never reach the miner; the explicit skillify posture for inbox rows is the parent's flagged decision.
- **The inbox opt-in flag.** A new capture-config value (DEFAULT - confirm before implementation: env `HONEYCOMB_INBOX_CAPTURE`, parsed in `src/daemon/runtime/capture/capture-config.ts`, default off, plus a settings-page toggle in a follow-up). ON restores the PRD-049a inbox path verbatim: `bound: false` scopes to `UNSORTED_PROJECT_ID` and writes proceed.
- **Zero-bindings dormancy.** With no bindings at all, every session is `bound: false`, so with the flag off the daemon performs zero capture-side Deeplake writes while still serving `/health` and the API (parent AC-3). The PRD-059a first-run predicate becomes redundant on this path but is kept as a cheap fast-path short-circuit (no behavior difference).
- **Back-compat.** Sessions in bound folders resolve `bound: true` via the binding or git branch (`project-resolver.ts:564-596`) and capture exactly as today (parent AC-5). The `HONEYCOMB_PROJECT_ID` env override (`project-resolver.ts:82`, honored at `project-resolver.ts:695-698`) still resolves `bound: true` and is never gated.

## Out of scope

- Surfacing (hook exit reason, `/health` slice, counters): 073b.
- The tenancy-confirmed gate input: 073c (this sub-PRD consumes a boolean seam so the two land independently).
- Session-end batch capture uses the same `runCapture` path per event (`src/hooks/shared/capture.ts:110-123`), so it inherits the gate; no separate work.

---

## User stories and acceptance criteria

### US-073a.1 - Unbound folders are silent

**As** the product owner, **I want** a session in an unbound folder to write nothing, **so that** honeycomb never hoards data I did not scope.

- AC-073a.1.1 Given the inbox opt-in is off and a capture resolves `bound: false`, when the handler runs, then no `sessions` / `memory` / `memory_jobs` row is written, no cue or pipeline job is enqueued, no embed fires, and the ack is `{ ok: true, gated: true, reason: "no_bound_project" }`.
- AC-073a.1.2 Given the same workspace ALREADY has other bound projects, when the unbound-cwd capture arrives, then it is still gated (the gate is per session, not first-run).
- AC-073a.1.3 Given zero bindings exist, when any number of captures arrive, then table row counts are unchanged (the parent dogfood step 5 probe).

### US-073a.2 - Bound folders are unchanged

- AC-073a.2.1 Given a cwd under a folder binding (or matching a cached git `remoteSignal`), when a capture arrives, then the row is written with the resolved `projectId` exactly as pre-073 (no new prompt, no new ack field beyond the additive `reason` absence).
- AC-073a.2.2 Given `HONEYCOMB_PROJECT_ID` is set non-empty, when a capture arrives from any cwd, then it captures under the override project (never gated by this sub-PRD).

### US-073a.3 - The inbox is a choice

- AC-073a.3.1 Given the inbox opt-in is ON, when an unbound-cwd capture arrives, then the PRD-049a behavior is restored verbatim: the row lands under `__unsorted__` and pipelines run.
- AC-073a.3.2 Given the flag is unset, when config resolves, then the inbox is OFF (dormant is the default posture).

---

## Technical considerations

- The gate decision needs the RESOLVED scope, so the 059a-style pre-resolution short-circuit (`capture-handler.ts:272-281`) is reordered: resolve first (`resolveCaptureProjectId`, already called at `capture-handler.ts:288`), then gate on `bound`/config. Resolution is a pure local read; no extra IO is added to the hot path.
- `firstRunGate: true` wiring at `src/daemon/runtime/assemble.ts:955` is superseded by the new gate but the deps flag is kept (opt-in for direct-construction unit tests, per the existing doc at `capture-handler.ts:167-171`).
- Fail-open posture is inherited: an unexpected resolver/config throw must not hard-block a bound, set-up user (mirrors `capture-handler.ts:561-563` doc). A throw during the `bound` evaluation falls back to the CURRENT behavior (capture proceeds) and logs.
- jscpd: the gate predicate lives in one place (the handler or a small shared helper beside `hasBoundProject`); the hooks side does NOT duplicate it (the shim learns the reason from the ack, 073b).

## Test plan

- Handler suite: the AC matrix above via direct construction with a seeded temp `projectsDir` (the existing pattern, `capture-handler.ts:151-157`), asserting insert/enqueue counts and ack shapes.
- Config suite: flag parsing (unset off, `"true"`/`"1"` on, garbage off).
- Regression: the full existing 049b/059a capture suites pass unchanged with a bound cwd.
