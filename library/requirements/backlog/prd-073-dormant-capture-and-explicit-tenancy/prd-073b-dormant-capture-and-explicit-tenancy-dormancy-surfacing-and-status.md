# PRD-073b: Dormancy Surfacing on /health, Status, and the Hook Exit Path

> **Parent:** [PRD-073](./prd-073-dormant-capture-and-explicit-tenancy-index.md)
> **Status:** Draft
> **Priority:** P0 (a gate without surfacing is a silent drop, which the parent forbids)
> **Effort:** M (4-8h)
> **Schema changes:** None. Additive fields on existing health/status bodies and hook results.

---

## Goals

Make the dormant states impossible to mistake for breakage or for capture: an operator (or the hive dashboard, or a probing doctor) can always answer "is honeycomb capturing right now, and if not, exactly why". Nectar PRD-019 AC-1 sets the bar: a machine-readable reason on `/health`, never a silent no-op.

## Scope

- **The `/health` reasons block gains the dormancy reasons.** `/health` already layers an additive, mode-gated `reasons` block over the coarse body (`src/daemon/runtime/server.ts:336-352`; the full detail rides the protected `/api/diagnostics/health`, `src/daemon/runtime/diagnostics-health.ts:39,67`). This sub-PRD adds two structured reasons, present while their condition holds:
  - `capture_dormant_no_project`: zero folder bindings exist (parent AC-3), with the guidance string "no active project; bind one in the Hive dashboard".
  - `capture_blocked_tenancy_unconfirmed`: the credential has no confirmed tenancy (073c).
  Neither degrades the 503 gate: a dormant daemon is HEALTHY (status 200, `pipeline: ok`); dormancy is a reason entry, not a degradation, matching nectar's dormant-but-healthy posture.
- **`/api/status` carries the same two facts** in its tenancy/config section (`src/daemon/runtime/server.ts:355-359`), so the dashboard and CLI status verbs read one coherent story.
- **Hook exit reason.** The daemon's gated ack (073a: `reason: "no_bound_project" | "tenancy_unconfirmed"`) is threaded through the shim result: `runCapture` today collapses any non-conflict daemon response to `{ ok: true }` (`src/hooks/shared/capture.ts:97-99`); it will surface `{ ok: true, reason: <gated reason> }` when the ack says `gated: true`, matching the existing skip-reason shape the gate path already uses (`capture.ts:86-89`). Harness shims log/exit with the reason exactly as they do for `HONEYCOMB_CAPTURE=false` skips today.
- **Session-start notice alignment.** The existing once-per-session `BIND_PROJECT_NOTICE` (`src/hooks/shared/session-start.ts:43-45`, gate at `:53-74`) keys on the workspace-level `hasBoundProjectOnDisk`. It is extended to the per-session contract: the notice also renders when THIS session's cwd is unbound while the inbox opt-in is off (the copy gains the cwd-specific variant: "this folder is not bound to a project"). Still once per session, still fail-soft-suppressed.
- **Observability counter.** A process-local gated-captures counter beside the dropped-events counter (`src/daemon/runtime/capture/dropped-events.ts:19-24` is the pattern), readable on the health detail, so the dogfood probe (parent test plan step 5 and 8) can assert "N captures were gated" instead of inferring from absence.

## Out of scope

- The gate decisions themselves (073a, 073c).
- The hive dashboard header tenancy display and onboarding copy (the parallel hive PRD; it reads `/api/auth/status` and the reasons added here).
- Doctor probe changes: doctor's registry contract (doctor ADR-0002) reads `/health` liveness and is unaffected; a dormant daemon stays green.

---

## User stories and acceptance criteria

### US-073b.1 - The operator can see why nothing is captured

- AC-073b.1.1 Given zero bindings, when `/health` is read in local mode, then the body is 200/`ok` and `reasons` contains `capture_dormant_no_project` with the bind-guidance string; binding one project clears it on the next read.
- AC-073b.1.2 Given tenancy is unconfirmed (073c state), when `/health` is read, then `reasons` contains `capture_blocked_tenancy_unconfirmed`; confirming clears it.
- AC-073b.1.3 Given team/hybrid mode, when the public `/health` is read, then the coarse body is unchanged and the dormancy reasons ride only the protected diagnostics surface (the PRD-029 public/detail split is preserved).

### US-073b.2 - The hook never lies

- AC-073b.2.1 Given a gated capture, when the shim returns, then the result carries the gate reason (`no_bound_project` / `tenancy_unconfirmed`), and no shim path reports a plain success for a gated event.
- AC-073b.2.2 Given a session in an unbound cwd (inbox off), when session-start runs, then the bind notice renders exactly once for that session with the cwd-specific copy.

### US-073b.3 - Gating is countable

- AC-073b.3.1 Given N gated captures since boot, when the health detail is read, then the gated-captures counter reads N, partitioned by reason.

---

## Technical considerations

- The reasons block is additive and already tolerated by clients (PRD-029 contract); no body version bump.
- The zero-bindings probe is the existing pure local read (`hasBoundProjectOnDisk`); computing it on each health read is acceptable (no Deeplake call), but a short TTL memo is fine if profiling asks for it.
- The shim change is shape-additive on `HookResult` (`reason` already exists on the skip path), so old daemons + new hooks and new daemons + old hooks both degrade gracefully (old hook simply reports plain `ok: true`).
- No em/en dashes, no new state files; counters are process-local (reset on restart, like dropped-events).

## Test plan

- Health suite: reason presence/absence matrix across bindings x tenancy x mode (local vs team public body).
- Shim suite: gated ack threads the reason; old-shape ack (no `reason`) still reports plain ok.
- Session-start suite: cwd-specific notice renders once; bound cwd renders none.
- Counter suite: increments per gated event by reason; never throws.
