# PRD-066e: Upgrade And Rollback Hardening

> **Status:** Backlog
> **Parent:** PRD-066
> **Priority:** P0
> **Effort:** M
> **Created:** 2026-06-29

## Overview

PRD-066a-d prove the local queue implementation and harden the live cost proof, but they do not yet
prove the user upgrade path. The current behavior is additive and lazy: a daemon boot creates
`.daemon/local-queue.db` when the local queue is enabled, and existing DeepLake memory data remains
untouched. That is a good implementation shape, but it is not enough to call the feature
production-default-ready.

This add-on defines the production upgrade and rollback gate for PRD-066. Before local queue can be
enabled by default for single-machine installs, Honeycomb must prove that users upgrading from the
previous package keep their pending work, get the new local operational database safely, can roll
back to the shared queue path, and receive clear operator diagnostics if something goes wrong.

## Problem

Without an explicit upgrade proof, the feature can pass unit tests, live cost tests, and built-daemon
DB creation smoke while still failing real users in upgrade-shaped scenarios:

- an existing install may have pending DeepLake-backed `memory_jobs` when the new daemon boots;
- a user may upgrade while the local queue flag is off, then later turn it on;
- local queue default-on may change routing before old shared jobs are drained or classified;
- rollback may restore shared queue behavior but leave local jobs stranded;
- npm package layout, CLI daemon spawn flags, and workspace/home resolution may differ from the
  repo-local built-bundle smoke;
- laptop sleep/wake or a transient DeepLake outage may happen during the first post-upgrade job.

Those are production risks, not PRD-066d verification risks. They need their own acceptance criteria.

## Goals

- Prove a packaged upgrade from the previous release to the local-queue release.
- Prove first boot after upgrade creates or reopens local operational DBs without corrupting existing
  DeepLake memory data or shared queue data.
- Prove existing pending DeepLake-backed jobs are drained, ignored, or preserved according to an
  explicit migration rule.
- Prove rollback flag behavior after local queue has already been used.
- Prove default-on behavior is safe for single-machine installs before enabling it broadly.
- Capture sleep/wake and transient DeepLake outage behavior in a bounded dogfood matrix.
- Produce operator-facing upgrade notes and support diagnostics.

## Non-Goals

- Implement hosted multi-device control-plane upgrade semantics.
- Migrate shared cross-device jobs into the local queue.
- Remove the old DeepLake-backed `memory_jobs` path.
- Change DeepLake memory, recall, vector, or graph schemas.
- Store DeepLake credentials in the local queue.

## Scope

- Add a packaged upgrade smoke that installs or packs the previous version, creates representative
  state, upgrades to the candidate package, and boots the daemon through the same CLI/package path a
  user would run.
- Add tests for pending old shared jobs at upgrade time.
- Add rollback tests after local queue has created local jobs.
- Add diagnostics that identify whether the daemon is using local queue, shared queue fallback, or
  shared queue drain mode.
- Add release/support documentation for upgrade, rollback, and known remaining DeepLake cost paths.
- Add a dogfood checklist covering restart, sleep/wake, transient DeepLake outage, and packaged
  install/update.

## Functional Requirements

1. The upgrade smoke must exercise a packaged install path, not only repo-local `daemon/index.js`.
2. The upgrade smoke must start from the immediately previous production version or a locally packed
   artifact that represents it.
3. The pre-upgrade setup must create representative existing state:
   - an existing workspace/home directory;
   - existing credentials or a no-creds setup state, depending on the scenario;
   - at least one pending DeepLake-backed local-kind job;
   - no existing `.daemon/local-queue.db`.
4. First boot after upgrade must create `.daemon/local-queue.db` and reopen existing `.daemon/logs.db`
   without destructive changes.
5. Pending old shared jobs must follow an explicit policy: drain, preserve for fallback, or ignore
   only after a documented grace rule.
6. Rollback with `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` must restore shared queue behavior without a
   data migration.
7. Rollback after local queue use must not silently lose queued local work; it must either drain
   first, block with a clear diagnostic, or mark local-only work as intentionally local and visible.
8. Default-on behavior must be gated to single-machine installs only.
9. Multi-device, fleet, or unknown topology installs must remain on conservative fallback until the
   hosted control-plane work defines shared semantics.
10. Operator diagnostics must show local queue enabled/disabled, shared drain enabled/disabled,
    counts by local queue status, and whether pending shared jobs were detected.
11. Upgrade documentation must explain how to roll back, what happens to old `memory_jobs`, and how
    to identify an idle healthy daemon.
12. The release gate must include a bounded dogfood window with daemon restart, laptop sleep/wake,
    transient DeepLake outage, and packaged install/update scenarios.

## Acceptance Criteria

- AC-1: A packaged upgrade smoke installs the previous version, upgrades to the candidate version,
  boots the daemon through the package/CLI entrypoint, and passes.
- AC-2: First boot after packaged upgrade creates `.daemon/local-queue.db` and preserves/reopens
  `.daemon/logs.db`.
- AC-3: Existing DeepLake memory rows and recall behavior remain available after upgrade.
- AC-4: A pending pre-upgrade DeepLake-backed `summary` or local-kind job follows the documented
  migration policy without duplicate successful execution.
- AC-5: With local queue enabled after upgrade, new local-only jobs enqueue to the local queue and
  do not create new DeepLake queue rows.
- AC-6: With the rollback flag off after local queue has been used, the daemon returns to the old
  shared queue path and reports any local queued work that will not be processed under rollback.
- AC-7: Rollback requires no DeepLake schema migration and no local DB deletion.
- AC-8: Default-on is blocked unless the install is classified as single-machine/local topology.
- AC-9: Multi-device, fleet, or unknown topology installs stay on fallback or require explicit
  opt-in.
- AC-10: Upgrade diagnostics identify local queue status counts, shared drain mode, and pending old
  shared jobs.
- AC-11: The packaged upgrade smoke also verifies second boot against the upgraded workspace.
- AC-12: Dogfood evidence covers restart, sleep/wake, transient DeepLake outage, and rollback.
- AC-13: Release notes and support docs describe upgrade, rollback, old shared jobs, local DB
  location, and remaining DeepLake cost paths.
- AC-14: The release gate fails if idle local mode produces DeepLake coordination reads after the
  packaged upgrade.

## Upgrade Scenarios

| Scenario | Expected Result |
| --- | --- |
| Previous version, no pending jobs, local queue disabled | Upgrade boots and preserves old shared queue behavior |
| Previous version, no pending jobs, local queue enabled | Upgrade boots, creates local queue DB, idle coordination reads are zero |
| Previous version, pending shared local-kind job, drain enabled | Old job drains once; new local-only jobs go local |
| Previous version, pending shared local-kind job, drain disabled | Old job remains visible as pending shared work; no silent loss |
| Local queue used, then rollback flag disabled | Shared path resumes; local queued work is surfaced before it can be stranded |
| Existing `.daemon/local-queue.db` from prior failed boot | Upgrade reopens or quarantines it with clear diagnostic |
| No credentials / setup mode | Daemon boots setup/local DB path without touching live DeepLake |
| Sleep/wake during leased local job | Expired local lease recovers without duplicate successful work |
| DeepLake outage during memory work | Local job retries later; local queue stays available |

## Implementation Notes

### Packaged Upgrade Smoke

Preferred shape:

1. Build or download the previous package artifact.
2. Install it into a temporary global or fixture project home.
3. Boot it once enough to create previous-version state.
4. Seed a bounded throwaway DeepLake job table or controlled shared queue fixture for pending old
   local-kind jobs.
5. Pack the candidate version with `npm pack`.
6. Install/upgrade to the candidate package.
7. Boot through the CLI/package daemon entrypoint, not repo-local source.
8. Verify local DB creation/reopen, queue routing, old job policy, `/health`, and diagnostics.
9. Disable local queue and verify rollback behavior.
10. Clean temporary home, workspace, package install, daemon process, and throwaway DeepLake tables.

The smoke should avoid using a developer's real home directory, daemon lock, or canonical
`memory_jobs` table.

### Topology Gate

Default-on must be tied to an explicit topology decision. Safe initial rule:

- local/single-machine mode: eligible for default-on after all ACs pass;
- team, fleet, multi-device, or unknown mode: fallback stays on unless the user explicitly opts in.

This prevents PRD-066 from accidentally breaking cross-device expectations before ADR-0004 control
plane work lands.

### Rollback Contract

Rollback is a feature, not a panic button. If `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` is set after the
local queue has already accepted work, the daemon must not quietly ignore those local rows. It should
surface one of these explicit states:

- local queue empty: rollback safe;
- local queue has queued/retrying/leased rows: rollback blocked or warning emitted with counts;
- local queue has only completed/failed rows: rollback safe, with diagnostics retained.

## Test Plan

- Unit:
  - topology classification for default-on gating;
  - rollback diagnostics for non-empty local queue;
  - migration policy for old shared local-kind jobs.
- Integration:
  - packaged upgrade smoke from previous version to candidate;
  - rollback after local queue use;
  - pending old shared job drain/preserve behavior;
  - no-creds setup boot after package upgrade.
- Live:
  - idle meter after packaged upgrade;
  - active local memory work after packaged upgrade;
  - golden path after packaged upgrade;
  - recall eval after packaged upgrade when embed daemon is available.
- Dogfood:
  - restart;
  - laptop sleep/wake;
  - transient DeepLake outage;
  - rollback flag;
  - second boot after upgrade.

## Rollout Gate

PRD-066 cannot be considered production-default-ready until:

- every PRD-066e acceptance criterion is verified;
- a QA report records packaged upgrade evidence;
- security review confirms upgrade smoke isolation does not inherit real credentials or bind wider
  than loopback;
- release notes and support guidance are written;
- the fallback/rollback flag remains available for at least one release after default-on.

## Risks And Mitigations

- **Risk:** A user has old shared jobs that duplicate local work after upgrade.
  **Mitigation:** explicitly drain or preserve old jobs with idempotency checks before default-on.
- **Risk:** Rollback strands local-only jobs.
  **Mitigation:** block or warn on rollback when local queued/retrying/leased rows exist.
- **Risk:** Packaged behavior differs from repo-local built smoke.
  **Mitigation:** run the upgrade smoke through package/CLI entrypoints.
- **Risk:** Multi-device users lose shared queue semantics.
  **Mitigation:** topology gate keeps default-on limited to single-machine installs.
- **Risk:** Local DB corruption appears during upgrade.
  **Mitigation:** quarantine corrupt DB, emit diagnostic, and keep fallback path available.

## Open Questions

- What exact previous version should the first upgrade smoke use as the baseline?
- Should pending old shared local-kind jobs drain by default, or should first release preserve them
  unless an explicit drain flag is set?
- Should rollback block when local queued work exists, or warn and require a confirmation flag?
- Where should upgrade diagnostics appear first: CLI, local dashboard, logs API, or all three?
- How long should the fallback flag remain after default-on?
