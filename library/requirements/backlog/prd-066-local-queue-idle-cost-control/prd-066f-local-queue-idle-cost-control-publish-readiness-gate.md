# PRD-066f: Publish Readiness Gate

> **Status:** Backlog
> **Parent:** PRD-066
> **Priority:** P0
> **Effort:** M
> **Created:** 2026-06-29

## Overview

PRD-066a through PRD-066e define and harden Honeycomb's local queue idle-cost fix. They prove the
core behavior, the upgrade path, rollback safety, and the packaged upgrade smoke. This add-on is the
final publish-readiness gate: it converts those implementation and verification threads into a
single release-candidate checklist that must be executed on this development machine before
publishing.

The purpose is not to add another feature. The purpose is to prevent a false green. A repo-local unit
test can pass while the packed npm artifact fails; a short live proof can pass while a longer idle
window still leaks coordination reads; an upgrade smoke can pass while a fresh no-credentials install
or default-port CLI run still has a bad user experience. PRD-066f keeps those risks visible and makes
the go/no-go decision evidence-based.

Target release posture:

```text
Candidate package installed like a user would install it
+ daemon booted from the package path
+ real local machine validation
+ live DeepLake credentialed proof where appropriate
+ no idle DeepLake coordination reads
+ documented upgrade, rollback, and publish evidence
= publish-ready for the local-queue default-on release gate
```

## Problem

The local queue work now has several separate proof points:

- focused unit tests for lazy storage, diagnostics, and daemon entrypoint behavior;
- typecheck;
- packaged upgrade smoke;
- packaged live idle-cost proof;
- PRD-066e upgrade and rollback requirements;
- PRD-048d npm publishing rehearsal requirements;
- external review signals from Aikido and CodeRabbit.

Those are necessary but not yet a complete publish gate. They need one consolidated execution plan,
one ledger, and one blocking definition of "ready." Without that, Honeycomb could ship a cost-saving
fix that is correct in the narrow test lane but still fails an actual user install, upgrade, rollback,
or no-creds setup flow.

## Goals

- Define the final local-machine validation gate for PRD-066 before publish.
- Turn the seven release-readiness validation lanes into concrete instructions.
- Require package-specific proof instead of relying only on repo-local source execution.
- Require both short automated proof and longer idle/cost dogfood proof.
- Require fresh install, no-credentials, upgrade, rollback, and default-port behavior to be checked.
- Require security/review gates to be recorded alongside automated test evidence.
- Require a go/no-go ledger that names commands, results, artifacts, residual risks, and owner.

## Non-Goals

- Build the hosted control plane, DigitalOcean Postgres backend, or Cloudflare queue architecture.
- Add multi-device memory sharing to PRD-066.
- Replace DeepLake for memory rows, vector search, recall, RRF, embeddings, or shared artifacts.
- Move PRD-066 out of `backlog/`; lifecycle promotion requires complete execution evidence.
- Write the final QA report in this document. QA report authorship remains owned by the quality
  workflow, but this PRD defines the ledger the report must contain.
- Publish the npm package automatically.
- Push a `vX.Y.Z` tag.

## Scope

PRD-066f covers the final validation window for the local queue release candidate:

1. Full local automated CI and focused regression tests.
2. Package-specific smoke tests from packed tarballs.
3. Fresh install and no-credentials setup behavior.
4. Upgrade, rollback, and second-boot behavior.
5. Longer live idle/cost proof against real credentialed behavior.
6. Dogfood resilience for restart, sleep/wake, and transient DeepLake outage.
7. Security, review, pack, and release rehearsal gates.

Each lane must produce ledger evidence before PRD-066 can be treated as publish-ready.

## User Stories

- As a single-machine Honeycomb user, I want an idle daemon to stop billing me for remote queue
  coordination without breaking memory features when I actually use them.
- As an existing user upgrading Honeycomb, I want my local runtime, logs, DeepLake memory data, and
  pending work to survive the upgrade.
- As a user without credentials configured yet, I want the daemon and dashboard to enter setup mode
  without forcing DeepLake auth or crashing.
- As a developer, I want the release candidate to be tested through the same package path users run,
  not only through repo-local source.
- As a release owner, I want one ledger that tells me what passed, what failed, what was skipped, and
  what risk remains before I publish.

## Validation Lane 1: Full Local CI And Focused Regression Tests

### Intent

Prove the codebase is internally coherent before leaning on live or package-specific evidence. This
lane catches TypeScript drift, focused local queue regressions, SQL-safety regressions, and broader
unit-test failures.

### Required Commands

Run from the repo root:

```powershell
npm run typecheck
npx vitest run tests/daemon/entry-main.test.ts tests/daemon/storage/lazy-client.test.ts tests/daemon/runtime/services/local-queue-diagnostics.test.ts
npm run audit:sql
npm run test
npm run ci
```

### Required Evidence

- Command, start time, finish time, exit code, and summary.
- Any failing test names and exact failure class.
- Any command intentionally skipped, with reason and follow-up owner.
- Note if `npm run ci` fails only because an already-known non-local-queue gate is flaky or broad
  formatting churn exists; do not call the lane green unless the release owner accepts that exception.

### Acceptance Criteria

- AC-066f.1.1: `npm run typecheck` passes.
- AC-066f.1.2: Focused local queue regression tests pass.
- AC-066f.1.3: SQL-safety audit passes or has only documented false positives accepted by the
  release owner.
- AC-066f.1.4: Broad test/CI status is recorded, including failures. A failing broad gate blocks
  publish unless the ledger explicitly marks it as unrelated and accepted.

## Validation Lane 2: Package-Specific Smoke Tests

### Intent

Prove the npm tarball behaves correctly after packing and installing, because users do not run the
repo-local TypeScript sources.

### Required Commands

Run from the repo root:

```powershell
npm run pack:check
npm run smoke:local-queue-packaged-upgrade
npm run smoke:local-queue-packaged-live-proof
```

If a real default-port CLI proof is not already covered by those scripts, run a separate scratch
install:

```powershell
npm pack
mkdir "$env:TEMP\honeycomb-package-default-port-proof"
cd "$env:TEMP\honeycomb-package-default-port-proof"
npm init -y
npm install "C:\Users\mario\GitHub\honeycomb\<generated-tarball>.tgz"
npx honeycomb --help
npx honeycomb daemon start
npx honeycomb daemon status
npx honeycomb daemon stop
```

Use an isolated runtime directory for any daemon run. Do not bind wider than loopback. Do not use the
developer's canonical daemon lock or production workspace unless the step explicitly says it is a
dogfood step.

### Required Evidence

- Tarball path and package version.
- Installed package path.
- `pack:check` summary.
- Packaged upgrade receipt.
- Packaged live proof receipt, including:
  - idle poll reads;
  - active poll reads;
  - recall reads delta;
  - total reads;
  - temporary workspace path.
- Default-port CLI proof receipt if executed separately.

### Acceptance Criteria

- AC-066f.2.1: `npm run pack:check` passes.
- AC-066f.2.2: Packaged upgrade smoke passes through the package/CLI path, not only repo-local source.
- AC-066f.2.3: Packaged live proof shows `idle_poll_reads=0`.
- AC-066f.2.4: Packaged live proof shows active recall still performs legitimate DeepLake reads.
- AC-066f.2.5: Active local mode does not resume queue polling after recall; active poll reads remain
  zero.
- AC-066f.2.6: The daemon entrypoint does not auto-run merely because it was dynamically imported by
  a packaged proof.
- AC-066f.2.7: If a default-port CLI proof is run, daemon start/status/stop work from the installed
  package without stale locks.

## Validation Lane 3: Fresh Install And No-Credentials Setup

### Intent

Prove the first-run experience is not harmed. Users may install Honeycomb before authenticating
DeepLake, or they may need to open the dashboard/setup flow without credentials. The local queue
must not force eager DeepLake auth.

### Required Scenario

Use a scratch runtime directory with no Honeycomb credentials, no existing `.daemon/`, and no
preexisting local queue database.

Required checks:

- package install completes;
- CLI help works;
- daemon can start or enter setup-mode health behavior without crashing;
- `/health` returns the expected setup/no-creds status;
- `/api/diagnostics/local-queue` does not force DeepLake auth;
- dashboard/setup route can be reached if the dashboard is part of the package proof;
- no plaintext secrets are written to logs.

### Required Evidence

- Scratch runtime path.
- Environment variables intentionally cleared or overridden.
- `/health` response status and relevant setup fields.
- Diagnostics response shape.
- Log excerpt showing no credential dump.
- Any expected `503 setup required` behavior must be labeled as expected, not failed.

### Acceptance Criteria

- AC-066f.3.1: Fresh no-creds install boots into expected setup behavior without an unhandled
  exception.
- AC-066f.3.2: Local queue diagnostics are available or gracefully unavailable without triggering
  DeepLake credential resolution.
- AC-066f.3.3: No local queue database creation requires DeepLake credentials.
- AC-066f.3.4: No logs contain raw DeepLake tokens, API keys, or credential blobs.

## Validation Lane 4: Upgrade, Rollback, And Second Boot

### Intent

Prove real users can upgrade and roll back. This lane consumes PRD-066e and verifies that local queue
default-on is not only correct for a clean repo run.

### Required Commands And Scenarios

Run:

```powershell
npm run smoke:local-queue-packaged-upgrade
```

Then perform or verify coverage for these scenarios:

1. Previous package or previous-version fixture boots in a scratch runtime.
2. Candidate package is installed over it.
3. First candidate boot creates or reopens `.daemon/local-queue.db`.
4. First candidate boot preserves or reopens `.daemon/logs.db`.
5. Second candidate boot reopens the same local DBs.
6. Rollback flag `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` restores the shared queue path.
7. Rollback after local queue use reports queued/retrying/leased local work instead of silently
   stranding it.
8. Existing pending DeepLake-backed local-kind jobs follow the documented policy: drain, preserve for
   fallback, or explicitly ignore after a grace rule.

### Required Evidence

- Previous artifact or fixture identity.
- Candidate tarball identity.
- Runtime directory before and after upgrade.
- Local DB existence and reopen proof.
- Rollback flag command and diagnostic output.
- Pending old shared job policy result.
- Second boot receipt.

### Acceptance Criteria

- AC-066f.4.1: Packaged upgrade smoke passes.
- AC-066f.4.2: First upgraded boot creates or reopens `.daemon/local-queue.db`.
- AC-066f.4.3: Existing `.daemon/logs.db` behavior is preserved.
- AC-066f.4.4: Second upgraded boot proves DB reopen, not one-time creation only.
- AC-066f.4.5: Rollback flag does not require deleting local DBs or migrating DeepLake schemas.
- AC-066f.4.6: Rollback diagnostics expose non-empty local queue state before work can be stranded.
- AC-066f.4.7: Old shared jobs are handled by the documented PRD-066e migration policy.

## Validation Lane 5: Longer Live Idle/Cost Proof

### Intent

Prove the actual cost-saving claim beyond a short smoke. The key product claim is:

```text
No user activity + empty local queue = zero DeepLake coordination reads.
```

The short package proof is necessary, but a longer local dogfood window is the stronger signal before
publish.

### Required Scenario

Use this machine with funded/working DeepLake credentials and an isolated Honeycomb runtime. Start
the candidate daemon through the package path when possible. Let startup settle, then run an idle
window of at least 10 minutes unless the release owner explicitly accepts a shorter window.

The meter must categorize reads at minimum as:

- `poll-lease`;
- `poll-reaper`;
- recall or memory reads;
- writes;
- other.

During the idle window:

- do not use the dashboard in a way that triggers memory reads;
- do not enqueue local jobs;
- do not run recall;
- record diagnostics before and after the window.

After the idle window, perform one active recall or memory operation and prove it still reaches
DeepLake for real work.

### Required Evidence

- Daemon start command.
- Package/tarball identity.
- Runtime directory.
- Idle window start and end timestamps.
- Query meter snapshot before idle.
- Query meter snapshot after idle.
- Count of `poll-lease` reads.
- Count of `poll-reaper` reads.
- Active recall or memory operation result.
- Query meter snapshot after active operation.

### Acceptance Criteria

- AC-066f.5.1: During the idle window, `poll-lease` reads are zero after startup settle.
- AC-066f.5.2: During the idle window, `poll-reaper` reads are zero after startup settle.
- AC-066f.5.3: Active recall or memory work still succeeds after idle.
- AC-066f.5.4: Active recall or memory work is categorized separately from coordination polling.
- AC-066f.5.5: The ledger states the approximate cost implication and any remaining DeepLake cost
  paths.

## Validation Lane 6: Restart, Sleep/Wake, And Transient Outage Dogfood

### Intent

Prove the queue behaves like something people can live with on laptops and routine development
machines. Idle-cost savings are not enough if the daemon duplicates work, loses local jobs, or
becomes opaque after normal laptop events.

### Required Scenarios

Run these against an isolated runtime:

1. **Daemon restart with queued local job**
   - enqueue a local job;
   - stop daemon before completion where possible;
   - restart daemon;
   - verify the job executes once.
2. **Daemon restart while idle**
   - start daemon with empty queue;
   - record diagnostics;
   - restart;
   - record diagnostics again;
   - verify idle coordination reads remain zero after settle.
3. **Sleep/wake or simulated lease expiry**
   - create or simulate a leased local job;
   - let the lease expire or use a deterministic test hook if available;
   - verify reaper/retry behavior does not duplicate successful completion.
4. **Transient DeepLake outage during memory work**
   - cause a bounded failed DeepLake call by revoking network/credentials in an isolated way or using
     a controlled mock if live outage simulation is unsafe;
   - verify local queue persists the work and retries later;
   - restore connectivity/credentials;
   - verify completion.

### Required Evidence

- Commands or manual actions used for each scenario.
- Queue counts before and after each scenario.
- Job id, kind, status transitions, and attempt counts.
- Any duplicate prevention/idempotency signal.
- Query meter snapshots showing idle coordination reads remain zero when no work exists.
- Clear note if a scenario was simulated instead of physically sleeping the laptop.

### Acceptance Criteria

- AC-066f.6.1: Restart with queued local work resumes without duplicate successful execution.
- AC-066f.6.2: Restart while idle returns to zero DeepLake coordination reads after startup settle.
- AC-066f.6.3: Sleep/wake or lease-expiry behavior recovers work without duplicate success.
- AC-066f.6.4: Transient DeepLake outage does not corrupt the local queue or lose retryable work.
- AC-066f.6.5: Diagnostics remain understandable after each scenario.

## Validation Lane 7: Security, Review, Pack, And Release Gates

### Intent

Prove the release candidate is not only functionally correct but reviewable, secure enough to ship,
and aligned with the npm release process.

### Required Checks

- Aikido SAST findings reviewed and either fixed or documented.
- CodeRabbit issues reviewed and either fixed or documented.
- SQL-safety audit run locally.
- Package tarball inspected by `npm run pack:check`.
- PRD-048d release rehearsal status reviewed.
- No `vX.Y.Z` tag pushed during rehearsal.
- No real npm publish performed during rehearsal.
- Release notes draft updated with:
  - local queue boundary;
  - default-on topology boundary;
  - rollback flag;
  - old shared job policy;
  - remaining DeepLake cost paths;
  - user-visible diagnostics.

### Required Evidence

- Aikido issue list or "no blocking findings" receipt.
- CodeRabbit issue list or "no blocking findings" receipt.
- `npm run audit:sql` result.
- `npm run pack:check` result.
- PRD-048d rehearsal status and any linked run URL if available.
- Confirmation that no publish tag was pushed.
- Confirmation that package publication did not occur.
- Release notes file path.

### Acceptance Criteria

- AC-066f.7.1: No unresolved critical SQL injection or path/file-inclusion findings remain in the
  local queue release surface.
- AC-066f.7.2: CodeRabbit blocking issues are resolved or accepted with release-owner signoff.
- AC-066f.7.3: `pack:check` passes.
- AC-066f.7.4: PRD-048d's npm rehearsal gates are complete or explicitly listed as blockers.
- AC-066f.7.5: No `vX.Y.Z` tag is pushed before the final go-live decision.
- AC-066f.7.6: The final ledger distinguishes "ready to publish" from "published."

## Evidence Ledger

The release owner must maintain a ledger with one row per evidence item. Suggested path:

```text
library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066f-publish-readiness-ledger.md
```

Because QA report authorship belongs to the quality workflow, this PRD defines the ledger shape but
does not replace the final QA report.

| Lane | Evidence Item | Command Or Scenario | Expected Result | Actual Result | Artifact / Receipt | Status | Owner | Residual Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Typecheck | `npm run typecheck` | Pass | TBD | TBD | Pending | Release owner | TBD |
| 1 | Focused regression tests | `npx vitest run ...` | Pass | TBD | TBD | Pending | Release owner | TBD |
| 1 | SQL audit | `npm run audit:sql` | Pass or accepted false positives | TBD | TBD | Pending | Release owner | TBD |
| 1 | Full test/CI | `npm run test`, `npm run ci` | Pass or documented blocker | TBD | TBD | Pending | Release owner | TBD |
| 2 | Pack check | `npm run pack:check` | Pass | TBD | TBD | Pending | Release owner | TBD |
| 2 | Packaged upgrade | `npm run smoke:local-queue-packaged-upgrade` | Pass | TBD | TBD | Pending | Release owner | TBD |
| 2 | Packaged live proof | `npm run smoke:local-queue-packaged-live-proof` | `idle_poll_reads=0` | TBD | TBD | Pending | Release owner | TBD |
| 2 | Default-port CLI proof | scratch package install | Start/status/stop pass | TBD | TBD | Pending | Release owner | TBD |
| 3 | Fresh no-creds install | scratch no-creds runtime | Setup mode without crash | TBD | TBD | Pending | Release owner | TBD |
| 3 | Diagnostics no-creds | `/api/diagnostics/local-queue` | No eager DeepLake auth | TBD | TBD | Pending | Release owner | TBD |
| 4 | Upgrade first boot | packaged upgrade smoke | DB created/reopened | TBD | TBD | Pending | Release owner | TBD |
| 4 | Upgrade second boot | packaged upgrade smoke | DB reopened | TBD | TBD | Pending | Release owner | TBD |
| 4 | Rollback flag | `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` | Shared path restored with warnings | TBD | TBD | Pending | Release owner | TBD |
| 5 | Long idle proof | 10+ minute idle window | Zero coordination reads | TBD | TBD | Pending | Release owner | TBD |
| 5 | Active memory proof | recall or memory operation | Legitimate DeepLake reads only | TBD | TBD | Pending | Release owner | TBD |
| 6 | Restart queued job | dogfood scenario | Executes once | TBD | TBD | Pending | Release owner | TBD |
| 6 | Restart idle daemon | dogfood scenario | Zero idle coordination reads | TBD | TBD | Pending | Release owner | TBD |
| 6 | Sleep/wake or lease expiry | dogfood scenario | Recover without duplicate success | TBD | TBD | Pending | Release owner | TBD |
| 6 | Transient outage | dogfood scenario | Retry later, no local corruption | TBD | TBD | Pending | Release owner | TBD |
| 7 | Aikido | review current findings | No blocking criticals | TBD | TBD | Pending | Release owner | TBD |
| 7 | CodeRabbit | review current findings | No blocking issues | TBD | TBD | Pending | Release owner | TBD |
| 7 | PRD-048d rehearsal | release rehearsal | Dry-run only, no publish | TBD | TBD | Pending | Release owner | TBD |
| 7 | Release notes | release notes draft | Boundary and rollback documented | TBD | TBD | Pending | Release owner | TBD |

## Go / No-Go Rules

The release is **go** only if all of the following are true:

- every P0 acceptance criterion in PRD-066f is passed or explicitly accepted by the release owner;
- packaged live proof shows zero idle coordination reads;
- packaged upgrade proof passes first boot and second boot;
- fresh no-creds setup behavior is proven;
- rollback behavior is proven or remains default-disabled with explicit blocker language;
- no unresolved critical security finding applies to this release surface;
- no broad test failure is unexplained;
- release notes name remaining DeepLake cost paths;
- no real npm publish has occurred before the go decision.

The release is **no-go** if any of the following are true:

- idle local mode produces DeepLake `poll-lease` or `poll-reaper` reads after startup settle;
- package install cannot boot the daemon from the installed artifact;
- upgrade requires deleting user data or local DBs;
- rollback can silently strand queued local work;
- no-creds setup crashes or leaks credentials;
- security review reports an unresolved critical issue in the changed release surface;
- the evidence ledger has missing results for any required lane.

## Implementation Notes

### Automated Test Execution On This Machine

This PRD assumes the current Windows development machine is available for automated testing. Execute
commands in PowerShell from:

```text
C:\Users\mario\GitHub\honeycomb
```

Use temporary runtime directories under `$env:TEMP` for package proofs. Avoid the user's real daemon
workspace except for an explicitly approved dogfood run.

### Query Meter Requirement

The local queue diagnostics endpoint must expose enough query-meter data for the packaged proof and
long idle proof to report:

- total DeepLake reads;
- reads by reason/category;
- `poll-lease` read count;
- `poll-reaper` read count;
- active recall or memory read count.

If that data is unavailable, the release cannot claim idle-cost proof, even if the daemon appears
quiet.

### Default-Port CLI Requirement

The installed CLI proof should use the default user-facing path at least once before publish. If
default port `3850` is unavailable on this machine, the ledger must record:

- what process occupied it;
- what alternate port was used;
- whether the default-port conflict is user/environment-specific or a product issue.

### Long Idle Window Requirement

The recommended idle window is 10 minutes. A shorter window may be used only if the release owner
explicitly accepts it for the current release. The ledger must not blur the difference between a
short smoke and a long idle dogfood run.

## Risks And Mitigations

- **Risk:** Short smoke tests miss periodic polling.
  **Mitigation:** require a longer idle window with query-meter snapshots before and after.
- **Risk:** Repo-local tests pass but npm package behavior fails.
  **Mitigation:** require `npm pack`, `pack:check`, packaged upgrade, and packaged live proof.
- **Risk:** Fresh users cannot reach setup without credentials.
  **Mitigation:** require no-creds scratch runtime validation.
- **Risk:** Upgrade works once but DB reopen fails.
  **Mitigation:** require second boot proof after upgrade.
- **Risk:** Rollback strands local queue work.
  **Mitigation:** require rollback diagnostics for non-empty local queue state.
- **Risk:** Manual dogfood evidence is too vague to support a publish decision.
  **Mitigation:** use the ledger columns in this PRD and attach concrete receipts.
- **Risk:** Security review is treated as separate from release readiness.
  **Mitigation:** include Aikido, CodeRabbit, and SQL audit in the same go/no-go ledger.

## Dependencies

- PRD-066a local queue store.
- PRD-066b worker routing and migration.
- PRD-066c idle-cost verification and rollout.
- PRD-066d verification hardening and upgrade smoke.
- PRD-066e upgrade and rollback hardening.
- PRD-048d npm publishing rehearsal and pack-install dogfood.
- ADR-0006 local queue interim idle-cost architecture.
- Existing scripts:
  - `npm run typecheck`;
  - `npm run audit:sql`;
  - `npm run test`;
  - `npm run ci`;
  - `npm run pack:check`;
  - `npm run smoke:local-queue-packaged-upgrade`;
  - `npm run smoke:local-queue-packaged-live-proof`.

## Open Questions

- Should the long idle window be exactly 10 minutes, 15 minutes, or release-owner configurable?
- Should `npm run ci` be a hard publish blocker if it fails in an unrelated known-flaky area?
- What previous package version should be the canonical baseline for upgrade proof once the package
  has been published publicly?
- Should the package-specific live proof remain in-process for precise metering, or should a second
  out-of-process CLI proof become mandatory before publish?
- Where should the evidence ledger live after execution: PRD-066 `qa/`, PRD-048 `reports/`, or both?
- Should no-creds setup proof include a browser/dashboard screenshot, or is API/CLI proof sufficient
  for the first publish gate?
