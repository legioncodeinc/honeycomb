# PRD-066f Publish Readiness Ledger

> **Status:** Local package gates green; publish hold
> **Date:** 2026-06-29
> **Machine:** Windows development workstation at `C:\Users\mario\GitHub\honeycomb`
> **Branch:** `legion/fix-golden-path-ci-workspace`
> **PR:** <https://github.com/legioncodeinc/honeycomb/pull/188>

## Summary

This ledger records the PRD-066f publish-readiness execution pass. The local package path now proves
zero idle DeepLake poll/reaper reads in short and default-ish installed-package windows, including a
120-second packaged proof with background workers enabled. Full local CI, package checks, bundle
smoke, upgrade smoke, and packaged live proofs are green on this machine. The release remains on
publish hold until external/security gates and release-process gates are cleared.

## Current Go / No-Go

**Publish hold as of 2026-06-29 14:00 America/New_York.**

Reasons:

- PR #188 exists and GitHub CI/CodeQL/CodeRabbit were green before the latest follow-up commit, but
  Aikido remains a publish hold until the remote re-scan confirms the addressed code-quality findings.
- The long 10-minute idle soak was explicitly deferred by the release owner for this checkpoint; the
  latest replacement proof is a 120-second packaged run with background workers enabled.
- `npm publish --dry-run --provenance --access public` is blocked because version `0.1.10` is already
  published; a bumped candidate version or explicit waiver is required for final rehearsal.
- No real npm publish or release tag was performed during this pass.

## Evidence Ledger

| Lane | Evidence Item | Command Or Scenario | Expected Result | Actual Result | Artifact / Receipt | Status | Residual Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Typecheck | `npm run typecheck` | Pass | Passed after latest fixes | `tsc --noEmit` exited 0 | Pass | None observed |
| 1 | Focused PRD-066 tests | `npx vitest run tests/daemon/runtime/assemble.test.ts tests/daemon/runtime/services/poll-loop.test.ts tests/daemon/runtime/summaries/job.test.ts tests/daemon/runtime/skillify/worker.test.ts tests/daemon/runtime/services/local-queue-diagnostics.test.ts` | Pass | Passed: 5 files, 70 tests | Validates assembly, diagnostics, poll loop idempotency, summary worker, skillify worker | Pass | Covered again by subsequent full `npm run ci` |
| 1 | Full test suite | `npm run test` | Pass | Passed after property timeout fix | 380 files, 4194 tests, 12 skipped, about 18.44s | Pass | None observed |
| 1 | Full CI | `npm run ci` | Pass | Passed after latest fixes | Typecheck, dup, tests, audit; `jscpd` reported 32 clones but exited 0 | Pass | `jscpd` clone groups remain existing/threshold-accepted |
| 2 | Pack check | `npm run pack:check` | Pass | Passed on 2026-06-29 after final local package run | `pack-check OK - 62 files, no forbidden patterns, all required runtime files present`; prepack build completed at `0.1.10` | Pass | None observed |
| 2 | Built upgrade smoke | `npm run smoke:local-queue-upgrade` | Pass | Passed | First boot `/health` 503 after 1356ms; second boot `/health` 503 after 2217ms | Pass | Setup 503 is expected no-creds behavior |
| 2 | Packaged upgrade smoke | `npm run smoke:local-queue-packaged-upgrade` | Pass | Passed after hard-failing previous-package fallback | `@legioncodeinc/honeycomb@0.1.10 -> candidate tarball`; previous fixture boot and candidate boots returned expected 503 | Pass | Uses already-published 0.1.10 as previous fixture |
| 2 | Packaged live proof, short | `npm run smoke:local-queue-packaged-live-proof` | Idle zero poll reads and active recall reads | Passed repeatedly | Latest default isolated proof: `idle_poll_reads=0 active_poll_reads=0 recall_reads_delta=3 total_reads=3`; diagnostics returned in 0-2ms | Pass | Short smoke only |
| 2 | Daemon bundle smoke | `npm run smoke:daemon-bundle` | Installed bundle loads without module/runtime import error | Passed | `daemon/index.js loaded without a bundling/module error (survived 3000ms)` | Pass | Smoke verifies load/start surface, not long dogfood behavior |
| 2 | Package proof hardening | Script instrumentation and isolation | Long runs observable and isolated | Added | Logs phase progress, request timeouts, OS-assigned loopback port, and passes `workspaceDir` into installed daemon | Pass | Long proof deferred after timer fixes |
| 2 | Default-port installed CLI proof, credentialed | Scratch package install with real credentials and default port 3850 | Start/status/stop pass | Passed earlier | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-default-port-creds-73ce4b152a684447a401679403fced3a`; `/health` 200, diagnostics 200, stop passed | Pass | Default CLI path still reported local queue disabled without explicit env flag |
| 2 | Default-port installed CLI proof, no-creds | Scratch install with isolated profile/default port | Setup mode without crash | Passed with warning | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-default-port-92509c96912c41919abfc4f278dbd5b4`; `/health` 503, stop passed | Warn | CLI status copy still treats setup 503 as not answering |
| 3 | Fresh no-creds diagnostics | Installed package, isolated profile/workspace, cleared `HONEYCOMB_DEEPLAKE_*` | No eager DeepLake auth; diagnostics reachable; no secret leakage | Passed earlier | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-nocreds-7b485b83662e4cfa9a733e937b468611`; diagnostics 200; secret log hits empty | Pass | Same setup-status UX warning |
| 4 | Rollback flag after local DB exists | Seed local queue DB, start with `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` | Shared path active, local work preserved, warning surfaced | Passed earlier | Base `C:\Users\mario\AppData\Local\Temp\hc-066f-rollback-b1dc30740f1348a6af24cb652649142e`; queued 1; local work will not process while disabled | Pass | Warning must stay in release notes |
| 5 | 10-minute idle live proof | Installed package, real credentials, local queue enabled, no shared drain | Zero idle coordination reads and stable process | Deferred after fixes | Earlier pre-fix runs exposed compounding timer/resource runaway; after timer fixes, release owner explicitly skipped the long idle soak for this checkpoint | Deferred | Required before final publish unless release owner accepts the shorter proof |
| 5 | Packaged live proof with background workers | `HONEYCOMB_PACKAGE_LIVE_IDLE_MS=120000; HONEYCOMB_PACKAGE_LIVE_BACKGROUND_WORKERS=true; npm run smoke:local-queue-packaged-live-proof` | Zero idle coordination reads with summary/pipeline/skillify/pollinating worker startup enabled and active recall still works | Passed | Run `pkg_live_mqzisk5t_119504`; log `C:\Users\mario\AppData\Local\Temp\hc-066-package-live-pkg_live_mqzisk5t_119504.log`; `idle_poll_reads=0 active_poll_reads=0 recall_reads_delta=3 total_reads=3`; heap stabilized around 21.2 MB during idle | Pass | 120-second proof does not replace a 10-minute soak for final publish confidence |
| 5 | Active memory proof after idle | Recall after packaged idle proof | Legitimate reads only | Passed in 120-second background-worker proof | Recall returned 200 after idle; `recall_reads_delta=3`; `active_poll_reads=0` | Pass | Long-idle active phase still deferred |
| 6 | Deterministic restart/lease/retry tests | `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts tests/daemon/runtime/services/poll-loop.test.ts tests/daemon/runtime/services/job-queue-source-labels.test.ts tests/daemon/runtime/services/poll-backoff.test.ts` | Pass | Passed: 4 files, 35 tests | Covers persistence, expired lease reclaim, stale lease completion rejection, retry backoff/exhaustion, poll-loop containment | Pass | Does not replace live restart/sleep/outage dogfood |
| 6 | Restart/sleep/outage live dogfood | Manual/live dogfood scenarios | Pass | Not run to completion | Deferred because the release owner chose the package/PR gate sequence for this checkpoint | Deferred | Run before final publish if the release owner requires laptop resilience proof |
| 7 | GitHub PR / CI | PR #188 | Open PR against `main`; remote CI attached | Passed except Aikido | CI quality gates on Node 22/24, Windows smoke, HiveDoctor, CodeQL, CLA, and Secret gate are green; live DeepLake and stress jobs skipped by workflow policy | Pass | External checks can rerun after the ledger commit |
| 7 | CodeRabbit | Review current PR #188 | No blocking issues | Green on latest observed PR status | CodeRabbit status context is success | Pass | Re-review can attach after final ledger push |
| 7 | Aikido | Current PR #188 branch scan | No introduced security issues and no blocking code-quality findings | SQL table-reference fix applied; remote re-scan pending | Aikido flagged `countPendingSharedLocalJobs` because the diagnostics SQL used `sqlIdent()` and then wrapped the table in another pair of quotes. The follow-up uses the validated bare table identifier directly and adds a regression assertion for `FROM memory_jobs job`. | Pending | Release hold until Aikido confirms the branch scan is green |
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
- Fixed compounding adaptive poll-loop starts so repeated worker `start()` calls do not stack timers.
- Fixed local queue lease coordinator scheduling so repeated `start()` calls reuse the existing timer.
- Restored the disk-backed JSON parser property tests to `NUM_RUNS=1000` while giving those slower
  properties an explicit 15-second timeout.
- Added proof-local query timeout defaults and request-timeout scaling so packaged live proof failures
  are bounded and observable.
- Addressed the latest Aikido code-quality findings by changing rollback diagnostic literal-false
  fields to booleans, redacting env-controlled/package-smoke log output, and simplifying daemon
  local-queue cleanup to an unconditional idempotent stop.
- Applied a second Aikido follow-up after scan `139394193` by separating unset topology from invalid
  env topology values, adding regression coverage for invalid env topology, and replacing the local
  queue diagnostics conditional object spread with a plain optional callback.
- Fixed the concrete Aikido diagnostics SQL finding by changing `FROM "${table}"` and the latest-row
  subquery to use `FROM ${table}` after `sqlIdent()` validation, with test coverage proving the query
  contains `FROM memory_jobs job` and not `FROM "memory_jobs"`.

## Open Blockers

1. Wait for the latest Aikido branch re-scan on PR #188 and resolve or waive any remaining findings.
2. Decide whether the deferred 10-minute installed-package soak is required before final publish, or
   whether the 120-second background-worker package proof is accepted for this checkpoint.
3. Bump the package version or explicitly waive the PRD-048d dry-run failure caused by already-published
   `0.1.10`.
4. Decide whether PRD-066 must ship true default-on behavior without `HONEYCOMB_LOCAL_QUEUE_ENABLED=true`.
5. Fix or waive the setup-mode `honeycomb daemon status` wording for reachable `/health` 503.
