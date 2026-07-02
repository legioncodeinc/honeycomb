# PRD-067: Doctor Boot Grace Release Blocker

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S (1-3h)
> **Schema changes:** None. Local Doctor state may gain non-breaking in-memory or file-backed boot metadata, but no DeepLake schema changes.

---

## Overview

Doctor currently begins probing the Honeycomb primary daemon immediately when Doctor starts. That is correct for a warm, already-running daemon, but it is dangerous during cold install and reboot: the primary daemon can take roughly 30 seconds to bind `/health` while it wires storage, services, and embeddings liveness. During that window Doctor can classify the daemon as unreachable and enter remediation before the daemon has had a fair chance to boot. This PRD is the immediate release-blocking fix: add an explicit startup and post-restart grace window so Doctor treats early failures as `booting`, not `dead`, while preserving short per-probe timeouts for genuinely wedged sockets.

This is the first PRD in the boot-experience sequence. It must ship before any public release that installs the Doctor bundle by default.

---

## Goals

- Prevent Doctor from killing, restarting, reinstalling, escalating, or incident-logging a primary daemon that is still inside the expected boot window.
- Add a default 60 second grace from Doctor start, plus the same grace after any Doctor-initiated restart or update restart.
- Keep `probeTimeoutMs` short so a hung health socket is still detected quickly after the grace window expires.
- Make the grace behavior visible in logs and local status without adding network calls, DeepLake reads, or new runtime dependencies.
- Add regression tests that prove initial cold boot, post-restart warmup, and post-grace remediation behavior.

## Non-Goals

- Building the future portal daemon or graphical boot shell. That is PRD-068 and PRD-070.
- Redesigning the full health dashboard. That is PRD-069.
- Increasing the daemon lifecycle start timeout beyond its current 45 second budget.
- Making embeddings warmup block daemon readiness. Embeddings remain background-warmed and observable.
- Adding a new DeepLake table, queue, or managed cloud dependency.
- Changing the primary daemon's `/health` contract except where an already-existing cached health signal is consumed.

---

## Code-grounded current state

| Area | Current code fact | Release risk |
|---|---|---|
| Doctor config | `doctor/src/config.ts` defaults to `probeIntervalMs: 30_000`, `probeTimeoutMs: 2_000`, and `restartCooldownMs: 5_000`. There is no startup grace setting. | A 2 second probe timeout is fine, but without a grace policy the first refused connection is treated as actionable. |
| Supervisor loop | `doctor/src/supervisor.ts` calls `tick()` immediately inside `start()`, then sleeps for `probeIntervalMs`. | A cold primary daemon can be classified unhealthy at time zero. |
| Unhealthy path | `doctor/src/supervisor.ts` sends every non-`ok` classification through incident creation and `heal(...)`. | Early `unreachable-refused`, `unreachable-timeout`, or `degraded` classifications can trigger remediation while boot is still expected. |
| Probe classification | `doctor/src/health-probe.ts` maps refused/reset transport errors to `unreachable-refused`, timeouts to `unreachable-timeout`, and any answered non-OK response to `degraded`. | This is the right classifier, but it needs context from boot timing before remediation fires. |
| Restart rung | `doctor/src/remediation.ts` has only a 5 second cooldown after a Doctor restart. | A daemon that takes roughly 30 seconds to return can be restarted again on the next 30 second tick because the cooldown has expired. |
| Compose wiring | `doctor/src/compose/index.ts` starts the status page, then starts the supervisor loop; the supervisor receives no boot-grace dependency. | Production assembly cannot express "starting" today. |
| CLI lifecycle | `src/cli/runtime.ts` waits up to 45 seconds for daemon `/health`, and `src/commands/daemon.ts` reports "process holds the lock but is not answering /health yet" instead of "failed" when applicable. | The CLI already recognizes slow boot, but Doctor is not aligned with that behavior. |
| Install flow | `src/commands/install.ts` health-gates the primary daemon before opening the dashboard. | Fresh installs are especially exposed: the user sees slow boot while Doctor may already be trying to heal. |
| Daemon boot | `src/daemon/runtime/assemble.ts` can await the first storage health refresh before starting services when storage probing is enabled; embeddings liveness starts before background warmup. | Normal boot can exceed naive watchdog timing, especially first-run model and storage paths. |

---

## Required behavior

### Boot grace

Doctor must compute a grace deadline when the supervisor is constructed or started:

- Default: `60_000` ms.
- Env override: `DOCTOR_STARTUP_GRACE_MS`.
- Invalid values fall back to default, matching the defensive config style in `doctor/src/config.ts`.
- The grace window begins when Doctor starts, not when the first failed probe occurs.

During this window:

- A non-`ok` probe result is recorded as a booting observation, not an unhealthy incident.
- The remediation ladder is not invoked.
- `consecutiveRestartFailures`, `backoffRung`, and `currentRung` are not advanced.
- The incident log is not appended.
- The status page can report `unknown` or `booting`; if `booting` would require a state-file enum migration, prefer an in-memory status provider for the immediate release.

### Post-restart grace

When a remediation rung or update flow successfully kicks a daemon restart, Doctor must start a new grace deadline:

- Default: same value as startup grace, `60_000` ms.
- The existing 5 second restart cooldown remains a short duplicate-action guard, not the boot-readiness policy.
- A failed restart action does not open a post-restart grace. Only a kicked restart or update restart does.

### Degraded during grace

During boot grace, `degraded` should also be non-remediating unless a future code path can prove the daemon has already completed boot and is now failing. For this immediate release, keep the rule simple and safe:

- Any non-`ok` inside grace is `booting`.
- Any non-`ok` after grace follows the existing remediation path.

This intentionally avoids distinguishing storage/schema/embeddings during the first 60 seconds. The priority is preventing the watchdog from fighting normal boot.

### Probe timeout remains small

Do not set `DOCTOR_PROBE_TIMEOUT_MS` to 60 seconds. That would make every hung socket hold the supervisor loop for a minute. The correct design is:

- Keep probe timeout at 2 seconds by default.
- Add a separate grace deadline around the decision to heal.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given Doctor starts and the primary daemon is not yet listening, when the first probe returns `unreachable-refused` inside the first 60 seconds, then Doctor logs a booting observation and does not invoke the remediation ladder. |
| AC-2 | Given Doctor starts and `/health` times out inside the startup grace, when the supervisor tick completes, then no incident is written and restart failure counters remain unchanged. |
| AC-3 | Given Doctor starts and `/health` returns `degraded` inside the startup grace, when the supervisor tick completes, then no remediation runs and no escalation is emitted. |
| AC-4 | Given the startup grace has expired and the primary daemon is still unreachable, when the next tick runs, then the existing unhealthy remediation path runs exactly as it does today. |
| AC-5 | Given a restart rung returns `ok: true`, when the next probe occurs before the post-restart grace expires, then Doctor does not attempt a second restart. |
| AC-6 | Given a restart action returns `false`, when the tick completes, then no post-restart grace is opened and the existing failed-restart/backoff logic applies. |
| AC-7 | Given `DOCTOR_STARTUP_GRACE_MS=90000`, when config resolves, then the supervisor uses a 90 second grace. Given the env value is malformed, zero, or negative, it falls back to 60 seconds. |
| AC-8 | Given the daemon becomes healthy during startup grace, when `/health` returns `ok`, then Doctor records healthy state and resets any stale backoff exactly as the existing healthy path does. |
| AC-9 | Given the status page is running while Doctor is inside grace, when `/status.json` is requested, then the page does not claim a terminal failure or show an escalation caused by the boot window. |
| AC-10 | Given the packaged Honeycomb install starts Doctor and the primary daemon on this machine, when the primary takes about 30 seconds to boot, then Doctor does not restart, reinstall, or escalate during that boot. |
| AC-11 | Given the local status-page port is already bound when `doctor run` starts, when the status page fails to bind, then Doctor logs/swallow the bind failure and the watchdog process remains alive until SIGTERM/SIGINT while still probing/healing the primary daemon. |

---

## Implementation notes

The smallest safe implementation is:

1. Extend `DoctorConfig` in `doctor/src/config.ts` with `startupGraceMs`.
2. Add `startupGraceMs: 60_000` to `DEFAULTS`.
3. Parse `DOCTOR_STARTUP_GRACE_MS` with the existing positive-int parser.
4. Extend `CreateSupervisorDeps` in `doctor/src/supervisor.ts` with `startupGraceMs`.
5. Track a private in-memory `graceUntilMs`.
6. Initialize `graceUntilMs = clock.now() + startupGraceMs` when the supervisor is created or started.
7. Before the unhealthy branch opens an incident, check whether `clock.now() < graceUntilMs`.
8. If inside grace, return the classification after logging `tick.booting` with `kind` and `remainingMs`; do not call `heal`.
9. When `heal` receives a successful restart rung result, set `graceUntilMs = clock.now() + startupGraceMs` along with recording `lastRestartAt`.
10. Wire `startupGraceMs` from `doctor/src/compose/index.ts`.
11. Add `DOCTOR_STATUS_PAGE_PORT` / config support so test runs and operators can move the local page away from a colliding port.
12. Keep the long-running `doctor run` process alive with an explicit referenced handle, cleared on shutdown, so optional status-page bind failure cannot end the watchdog process.

Optional but useful if low-risk:

- Add a non-persistent `supervisor.healthSnapshot()` or `isInGrace()` read seam so the status page can show `booting` without changing `state.json`.
- If a persistent `LastKnownHealth` enum value is added, bump the local state reader defensively so old files continue to merge.

Do not:

- Increase the HTTP probe timeout to 60 seconds.
- Persist a synthetic failed state during grace.
- Treat embeddings warmup as fatal during the boot window.

---

## Files expected to change

| File | Expected change |
|---|---|
| `doctor/src/config.ts` | Add `startupGraceMs`, default, env parsing, comments, tests. |
| `doctor/src/supervisor.ts` | Add grace deadline, skip-heal behavior, post-restart grace, booting log. |
| `doctor/src/compose/index.ts` | Pass `config.startupGraceMs` into the supervisor and optionally expose booting to the status page. |
| `doctor/tests/config.test.ts` | Cover default, env override, malformed fallback. |
| `doctor/tests/supervisor.test.ts` | Cover startup refused/timeout/degraded no-heal, post-grace heal, post-restart grace. |
| `doctor/tests/compose/create-doctor.test.ts` | Cover compose wiring if the test suite already asserts supervisor deps. |
| `scripts/local-queue-packaged-upgrade-smoke.mjs` or packaged smoke harness | Add or preserve a live proof that a slow primary boot does not trigger Doctor remediation. |

---

## Test plan

- Unit: `cd doctor && npm run test -- supervisor.test.ts config.test.ts`.
- Package-level: `cd doctor && npm run ci`.
- Root gate: `npm run typecheck` and the existing smoke suite used for PR #188.
- Live local proof:
  - Install the candidate package globally from `npm pack`.
  - Start Doctor and a deliberately delayed primary daemon, or inject a fake `/health` server that refuses for 30 seconds and then returns `ok`.
  - Verify no `restart-daemon`, reinstall, escalation, or incident append occurs during the first 60 seconds.
  - Verify remediation does occur when the fake server remains down beyond the grace window.

---

## Release gate

This PRD blocks release. A release candidate must not be tagged until:

- All ACs above are satisfied.
- A packaged install or packaged live-proof test demonstrates slow boot without Doctor remediation.
- CI passes on the release branch.
- The final release notes mention that Doctor now observes a startup grace and no longer treats cold boot as daemon death.

---

## Resolved decisions

- [x] **Status page wording:** PRD-067 tracks boot grace internally and avoids state-file churn. If the status page can expose `booting` from in-memory supervisor state without widening the local state schema, it may do so; otherwise PRD-068 owns the richer portal wording.
- [x] **Default boot grace:** Use a 60 second default (`60_000` ms), configurable by `DOCTOR_STARTUP_GRACE_MS`.
- [x] **Post-update restart grace:** Use the same 60 second grace after update-triggered restarts as manual/Doctor-triggered restarts.

---

## Related

- [PRD-064: Doctor Self-Healing Watchdog](../../in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md)
- [PRD-065: Doctor Go-Live and Activation](../prd-065-doctor-go-live/prd-065-doctor-go-live-index.md)
- [PRD-068: Portal Daemon Boot Shell](../prd-068-portal-daemon-boot-shell/prd-068-portal-daemon-boot-shell-index.md)
- [PRD-069: Application Health Dashboard](../prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md)
- [PRD-070: First Browser Load Experience](../prd-070-first-browser-load-experience/prd-070-first-browser-load-experience-index.md)
- `doctor/src/config.ts`
- `doctor/src/supervisor.ts`
- `doctor/src/health-probe.ts`
- `doctor/src/remediation.ts`
- `doctor/src/compose/index.ts`
- `src/cli/runtime.ts`
- `src/commands/install.ts`
