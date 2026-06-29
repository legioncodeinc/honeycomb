# PRD-066f Publish Readiness Ledger

> **Status:** No-go
> **Date:** 2026-06-29
> **Machine:** Windows development workstation at `C:\Users\mario\GitHub\honeycomb`
> **Branch:** `legion/fix-golden-path-ci-workspace`

## Summary

This ledger records the PRD-066f publish-readiness execution pass. The release candidate is not
publish-ready. The package path now proves zero idle DeepLake poll/reaper reads in short windows and
the default diagnostics path no longer performs a shared DeepLake count, but the required 10-minute
installed-package proof repeatedly found a long-idle resource runaway before the proof could complete.

## Current Go / No-Go

**No-go as of 2026-06-29 11:05 America/New_York.**

Reasons:

- The 10-minute installed-package live proof does not complete reliably.
- Long idle runs eventually drive the daemon process to high CPU and high memory before diagnostics
  can finish.
- Aikido remains a blocking PR check on PR #188 and the MCP feed still requires sign-in to inspect
  details.
- `npm publish --dry-run --provenance --access public` is blocked because version `0.1.10` is already
  published; a bumped candidate version or explicit waiver is required for final rehearsal.

## Evidence Ledger

| Lane | Evidence Item | Command Or Scenario | Expected Result | Actual Result | Artifact / Receipt | Status | Residual Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Typecheck | `npm run typecheck` | Pass | Passed after latest fixes | `tsc --noEmit` exited 0 | Pass | None observed |
| 1 | Focused PRD-066 tests | `npx vitest run tests/daemon/runtime/assemble.test.ts tests/daemon/runtime/services/poll-loop.test.ts tests/daemon/runtime/summaries/job.test.ts tests/daemon/runtime/skillify/worker.test.ts tests/daemon/runtime/services/local-queue-diagnostics.test.ts` | Pass | Passed: 5 files, 70 tests | Validates assembly, diagnostics, poll loop idempotency, summary worker, skillify worker | Pass | Full suite should be rerun before final push |
| 1 | Full test suite | `npm run test` | Pass | Passed earlier after property timeout fix | 380 files, 4191 passed, 12 skipped, about 18.44s | Pass | Must rerun after the latest long-idle fixes |
| 1 | Full CI | `npm run ci` | Pass | Passed earlier after property timeout fix | Typecheck, dup, tests, audit; `jscpd` reported 32 clones but exited 0 | Pass | Must rerun after latest edits |
| 2 | Pack check | `npm run pack:check` | Pass | Passed | `pack-check OK - 62 files, no forbidden patterns, all required runtime files present` | Pass | Rerun after final fixes |
| 2 | Built upgrade smoke | `npm run smoke:local-queue-upgrade` | Pass | Passed | First boot `/health` 503 after 1356ms; second boot `/health` 503 after 2217ms | Pass | Setup 503 is expected no-creds behavior |
| 2 | Packaged upgrade smoke | `npm run smoke:local-queue-packaged-upgrade` | Pass | Passed after hard-failing previous-package fallback | `@legioncodeinc/honeycomb@0.1.10 -> candidate tarball`; previous fixture boot and candidate boots returned expected 503 | Pass | Uses already-published 0.1.10 as previous fixture |
| 2 | Packaged live proof, short | `npm run smoke:local-queue-packaged-live-proof` | Idle zero poll reads and active recall reads | Passed repeatedly | Latest: `idle_poll_reads=0 active_poll_reads=0 recall_reads_delta=3 total_reads=3`; diagnostics returned in 0-2ms | Pass | Short smoke only |
| 2 | Package proof hardening | Script instrumentation and isolation | Long runs observable and isolated | Added | Logs phase progress, request timeouts, OS-assigned loopback port, and passes `workspaceDir` into installed daemon | Pass | Long proof still exposes runtime runaway |
| 2 | Default-port installed CLI proof, credentialed | Scratch package install with real credentials and default port 3850 | Start/status/stop pass | Passed earlier | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-default-port-creds-73ce4b152a684447a401679403fced3a`; `/health` 200, diagnostics 200, stop passed | Pass | Default CLI path still reported local queue disabled without explicit env flag |
| 2 | Default-port installed CLI proof, no-creds | Scratch install with isolated profile/default port | Setup mode without crash | Passed with warning | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-default-port-92509c96912c41919abfc4f278dbd5b4`; `/health` 503, stop passed | Warn | CLI status copy still treats setup 503 as not answering |
| 3 | Fresh no-creds diagnostics | Installed package, isolated profile/workspace, cleared `HONEYCOMB_DEEPLAKE_*` | No eager DeepLake auth; diagnostics reachable; no secret leakage | Passed earlier | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-nocreds-7b485b83662e4cfa9a733e937b468611`; diagnostics 200; secret log hits empty | Pass | Same setup-status UX warning |
| 4 | Rollback flag after local DB exists | Seed local queue DB, start with `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` | Shared path active, local work preserved, warning surfaced | Passed earlier | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-rollback-b1dc30740f1348a6af24cb652649142e`; queued 1; local work will not process while disabled | Pass | Warning must stay in release notes |
| 5 | 10-minute idle live proof | Installed package, real credentials, local queue enabled, no shared drain | Zero idle coordination reads and stable process | Failed | Multiple runs reached high CPU/high memory before completion; latest final run PID 77264 reached about 388 CPU seconds and 1.67 GB working set before diagnostics completed | Fail | Release blocker |
| 5 | Active memory proof after long idle | Recall after 10-minute idle | Legitimate reads only | Not completed | Long idle proof did not reach stable recall phase | Blocked | Release blocker |
| 6 | Deterministic restart/lease/retry tests | `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts tests/daemon/runtime/services/poll-loop.test.ts tests/daemon/runtime/services/job-queue-source-labels.test.ts tests/daemon/runtime/services/poll-backoff.test.ts` | Pass | Passed: 4 files, 35 tests | Covers persistence, expired lease reclaim, stale lease completion rejection, retry backoff/exhaustion, poll-loop containment | Pass | Does not replace live restart/sleep/outage dogfood |
| 6 | Restart/sleep/outage live dogfood | Manual/live dogfood scenarios | Pass | Not run to completion | Deferred because lane 5 is already red | Blocked | Run after long-idle runaway is fixed |
| 7 | CodeRabbit | Review current PR #188 | No blocking issues | Latest CodeRabbit status context is success, but actionable comments were found and fixed locally | PR comments included previous-package fallback, openExistingOnly migration, diagnostics cleanup/topology fallback, upgrade-smoke health timeout/kill wait, startup cleanup | Warn | Needs push/re-review to confirm resolved |
| 7 | Aikido | Current PR #188 branch scan | No blocking criticals | Failing check on GitHub; MCP issue feed requires sign-in | PR #188 check `Aikido Security: check code` failed; Aikido MCP returned sign-in required | Fail | Release blocker |
| 7 | PRD-048d rehearsal | `npm publish --dry-run --provenance --access public` | Dry-run reaches publish step without publishing | Failed at version guard | Npm reported `You cannot publish over the previously published versions: 0.1.10`; `npm view @legioncodeinc/honeycomb version` returned `0.1.10` | Blocked | Need candidate version bump or explicit waiver |

## Fixes Applied During This Pass

- Reduced the suite-context property timeout by lowering the fixed malicious `dirName` traversal
  property run count to 50.
- Added a 5-second timeout around pending shared-job diagnostics.
- Made local queue diagnostics avoid the expensive shared DeepLake pending-job count by default;
  it now only checks when drain mode is enabled or `HONEYCOMB_LOCAL_QUEUE_DIAGNOSTICS_INCLUDE_SHARED`
  is set.
- Disabled recurring storage health probes in local-queue/no-drain mode, because `SELECT 1` is idle
  DeepLake traffic.
- Hardened packaged live proof logging, request timeouts, workspace isolation, and port allocation.
- Made packaged upgrade smoke hard-fail when the previous package cannot be installed unless fallback
  is explicitly opted in.
- Skipped local DB schema migration in `openExistingOnly` mode.
- Moved summary and skillify workers onto the shared adaptive poll loop and made the poll loop
  idempotent on repeated `start()`.
- Wrapped affected diagnostics tests in `finally` cleanup and added install-topology fallback coverage.
- Added startup-failure cleanup in the live local-queue integration helper.
- Added timeout-bound `/health` polling and post-SIGKILL exit waiting in the built upgrade smoke.

## Open Blockers

1. Diagnose and fix the long-idle CPU/memory runaway before claiming PRD-066 idle-cost readiness.
2. Rerun `npm run test`, `npm run ci`, `npm run pack:check`, packaged upgrade, and packaged live proof
   after that fix.
3. Complete Aikido MCP sign-in and resolve/waive the failing Aikido branch scan.
4. Push the CodeRabbit fixes and trigger/review CodeRabbit again.
5. Bump the package version or explicitly waive the PRD-048d dry-run failure caused by already-published
   `0.1.10`.
6. Decide whether PRD-066 must ship true default-on behavior without `HONEYCOMB_LOCAL_QUEUE_ENABLED=true`.
7. Fix or waive the setup-mode `honeycomb daemon status` wording for reachable `/health` 503.
