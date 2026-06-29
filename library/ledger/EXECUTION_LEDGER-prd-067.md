# Execution Ledger: PRD-067 HiveDoctor Boot Grace Release Blocker

> **PRD:** `library/requirements/backlog/prd-067-hivedoctor-boot-grace-release-blocker/prd-067-hivedoctor-boot-grace-release-blocker-index.md`
> **Smoker run started:** 2026-06-29
> **Mode:** Ship implementation with full local verification.

---

## Wave Plan

| Wave | Owner | Scope | Exit Criteria |
|---|---|---|---|
| 0 | Main Codex | Read PRD-067, extract ACs, inspect Hivedoctor config/supervisor/compose tests, write this ledger. | Ledger contains 100 percent of PRD-067 ACs. |
| 1 | Main Codex | Implement boot grace in `hivedoctor/src/config.ts`, `hivedoctor/src/supervisor.ts`, `hivedoctor/src/compose/index.ts`, plus focused tests. | Focused Hivedoctor tests pass and ACs are `DONE`. |
| 2 | Main Codex | Functional local testing: delayed-health proof and package-level Hivedoctor gate. | Evidence proves boot grace suppresses remediation during cold boot and allows remediation after grace. |
| 3 | Main Codex | Security close-out after implementation. Subagents were not spawned because this turn did not explicitly request parallel agents. | Runtime audit, publish/package check, and diff hygiene pass. |
| 4 | Main Codex | QA review against PRD-067 and ledger. | All in-scope ACs verified; out-of-scope discoveries listed separately for user decision. |

---

## Acceptance Criteria Ledger

| ID | Source | Criterion | Status | Owner | Verification Evidence |
|---|---|---|---|---|---|
| AC-1 | PRD-067 | Given HiveDoctor starts and the primary daemon is not yet listening, when the first probe returns `unreachable-refused` inside the first 60 seconds, then HiveDoctor logs a booting observation and does not invoke the remediation ladder. | DONE | Main Codex | `tests/supervisor.test.ts` AC-1 asserts `tick.booting`, no restart, no warning, no incident, counters unchanged. Focused command passed: `npx vitest run tests/config.test.ts tests/supervisor.test.ts tests/supervisor-escalation.test.ts tests/compose/create-hivedoctor.test.ts` (44 tests). |
| AC-2 | PRD-067 | Given HiveDoctor starts and `/health` times out inside the startup grace, when the supervisor tick completes, then no incident is written and restart failure counters remain unchanged. | DONE | Main Codex | `tests/supervisor.test.ts` AC-2 asserts `unreachable-timeout` inside grace does not call restart, writes no incident, leaves failure/backoff counters at 0. Focused suite passed. |
| AC-3 | PRD-067 | Given HiveDoctor starts and `/health` returns `degraded` inside the startup grace, when the supervisor tick completes, then no remediation runs and no escalation is emitted. | DONE | Main Codex | `tests/supervisor.test.ts` AC-3 asserts degraded/schema migration inside grace has no restart, no `tick.unhealthy`, and no incident/escalation record. Focused suite passed. |
| AC-4 | PRD-067 | Given the startup grace has expired and the primary daemon is still unreachable, when the next tick runs, then the existing unhealthy remediation path runs exactly as it does today. | DONE | Main Codex | `tests/supervisor.test.ts` AC-4 advances fake clock to 60s, then verifies the restart rung runs and an incident records `restart-daemon` succeeded. Focused suite passed. |
| AC-5 | PRD-067 | Given a restart rung returns `ok: true`, when the next probe occurs before the post-restart grace expires, then HiveDoctor does not attempt a second restart. | DONE | Main Codex | `tests/supervisor.test.ts` AC-5 verifies one successful restart re-arms grace and a following unreachable tick does not call restart again or add a second incident. Focused suite passed. |
| AC-6 | PRD-067 | Given a restart action returns `false`, when the tick completes, then no post-restart grace is opened and the existing failed-restart/backoff logic applies. | DONE | Main Codex | `tests/supervisor.test.ts` AC-6 verifies failed restart does not open grace: a second tick calls restart again, writes a second incident, and increments consecutive failures to 2. Focused suite passed. |
| AC-7 | PRD-067 | Given `HIVEDOCTOR_STARTUP_GRACE_MS=90000`, when config resolves, then the supervisor uses a 90 second grace. Given the env value is malformed, zero, or negative, it falls back to 60 seconds. | DONE | Main Codex | `tests/config.test.ts` verifies default 60s, 90000 override, malformed fallback, zero fallback, and negative fallback. Focused suite passed. |
| AC-8 | PRD-067 | Given the daemon becomes healthy during startup grace, when `/health` returns `ok`, then HiveDoctor records healthy state and resets any stale backoff exactly as the existing healthy path does. | DONE | Main Codex | `tests/supervisor.test.ts` AC-8 pre-seeds stale unreachable/backoff state, returns `ok` inside grace, and verifies state is `ok`, rung 1, counters reset. Focused suite passed. |
| AC-9 | PRD-067 | Given the status page is running while HiveDoctor is inside grace, when `/status.json` is requested, then the page does not claim a terminal failure or show an escalation caused by the boot window. | DONE | Main Codex | `tests/compose/create-hivedoctor.test.ts` AC-9 drives a graceful boot tick, starts status page on port 0, fetches `/status.json`, and verifies health is `unknown` with `escalation: null`. Focused suite passed. |
| AC-10 | PRD-067 | Given the packaged Honeycomb install starts HiveDoctor and the primary daemon on this machine, when the primary takes about 30 seconds to boot, then HiveDoctor does not restart, reinstall, or escalate during that boot. | DONE | Main Codex | `tests/supervisor.test.ts` AC-10 simulates 30s delayed boot with no restart/incidents. Package-built live proof against `hivedoctor/dist/src/compose/index.js` used real TCP health probing: first `unreachable-refused`, 30s later `ok`, `restartCount: 0`, `incidentLines: 0`, `lastKnownHealth: ok`. |
| AC-11 | PRD-067 | Given the local status-page port is already bound when `hivedoctor run` starts, when the status page fails to bind, then HiveDoctor logs/swallow the bind failure and the watchdog process remains alive until SIGTERM/SIGINT while still probing/healing the primary daemon. | DONE | Main Codex | `tests/cli/run-watchdog.test.ts` verifies `run` remains unsettled with an occupied status port until in-process `SIGTERM`, then exits cleanly. Package-built proof against `hivedoctor/bundle/cli.js` used `HIVEDOCTOR_STATUS_PAGE_PORT` pointed at an occupied port plus 30s delayed primary health: saw `status-page.bind_failed`, child stayed alive through boot, `incidentLines: 0`, `lastKnownHealth: ok`. |

---

## Out-of-Scope Discoveries

1. `OOS-1` from `library/requirements/backlog/prd-067-hivedoctor-boot-grace-release-blocker/qa/out-of-scope-discoveries.md` was accepted into PRD-067 as AC-11 on 2026-06-29.

---

## Close-Out

Implementation complete and locally verified.

Evidence:

- `npm run typecheck` in `hivedoctor`: passed.
- Focused PRD-067 suite: `npx vitest run tests/config.test.ts tests/supervisor.test.ts tests/supervisor-escalation.test.ts tests/compose/create-hivedoctor.test.ts`: 4 files, 44 tests passed.
- Focused AC-11 suite: `npx vitest run tests/config.test.ts tests/cli/run-watchdog.test.ts tests/supervisor.test.ts tests/compose/create-hivedoctor.test.ts`: 4 files, 43 tests passed.
- `npm run ci` in `hivedoctor`: 49 files, 486 tests passed.
- `npm run build` in `hivedoctor`: passed, built `bundle/cli.js @ 0.1.8`.
- `npm run pack:check` in `hivedoctor`: passed, 5 files, no forbidden patterns, no source leak, bin present.
- `npm audit --omit=dev --audit-level=high` in `hivedoctor`: found 0 vulnerabilities.
- `git diff --check`: passed.
- Package-built live proof: compiled HiveDoctor assembly + real TCP probe + delayed fake primary health; no restart, no incident, final state `ok`.
- Package-built occupied-status-port proof: `bundle/cli.js run --no-auto-update` with `HIVEDOCTOR_STATUS_PAGE_PORT` pointed at an occupied port stayed alive through a 30s delayed primary boot, logged bind failure, wrote no incidents, and recorded final state `ok`.
