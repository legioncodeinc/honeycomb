# PRD-066c: Idle-Cost Verification And Rollout

> **Status:** Backlog
> **Parent:** PRD-066
> **Priority:** P0
> **Effort:** S

## Overview

Prove that the local queue materially reduces idle DeepLake cost before enabling it broadly. The
rollout should use PRD-062 instrumentation to separate DeepLake coordination reads from legitimate
memory/vector reads.

## Scope

- Define the idle measurement window.
- Capture before/after DeepLake coordination read counts.
- Add rollout and rollback flags.
- Add operator diagnostics for queue status and DeepLake coordination reads.
- Document release notes and support guidance for the transition period.

## Non-Goals

- Build the hosted control plane.
- Replace DeepLake memory behavior.
- Prove multi-device fleet behavior.
- Tune every active workload cost path.

## Functional Requirements

1. The query meter must label DeepLake operations as coordination, memory write, recall/vector read,
   or other.
2. The rollout report must include baseline idle behavior before local queue enablement.
3. The rollout report must include idle behavior after local queue enablement.
4. The daemon must expose local queue counts by status and kind.
5. The daemon must expose whether DeepLake queue fallback is active.
6. The release must include a rollback flag that restores the previous queue behavior.
7. Rollout must start with local development/internal dogfood before default-on release.
8. Support guidance must explain how to distinguish "idle and healthy" from "stuck local queue."

## Acceptance Criteria

- AC-1: Baseline report shows current idle DeepLake coordination reads before the feature flag is
  enabled.
- AC-2: Post-change report shows zero DeepLake coordination reads during the idle measurement window
  with an empty local queue.
- AC-3: Active memory writes and recall reads are still visible and correctly categorized.
- AC-4: Rollback flag restores previous behavior without a data migration.
- AC-5: Local queue diagnostics identify queued, leased, retrying, failed, and completed counts.
- AC-6: Dogfood rollout runs long enough to include daemon restart, sleep/wake, and transient
  DeepLake outage scenarios.
- AC-7: Release notes describe the local queue boundary and known remaining DeepLake cost paths.

## Verification Matrix

| Scenario | Expected Result |
| --- | --- |
| Fresh single-machine install, idle | Zero DeepLake coordination reads after startup settles |
| Existing install with no pending jobs | Zero DeepLake coordination reads after old DeepLake jobs drain |
| Existing install with old DeepLake jobs | Old jobs drain or follow explicit migration rule |
| Daemon restart with queued local job | Job resumes and executes once |
| Laptop sleep/wake | Expired leases recover without duplicate successful work |
| DeepLake outage during local-only work | Queue remains available and retries memory work later |
| Feature flag rollback | Daemon returns to previous DeepLake-backed queue behavior |

## Rollout Plan

1. Keep local queue disabled by default while implementation tests land.
2. Enable in local development with query metering required.
3. Enable for internal dogfood single-machine installs.
4. Publish before/after idle report.
5. Enable by default for single-machine installs.
6. Keep multi-device/fleet installs on conservative fallback behavior until ADR-0004 work is ready.

## Open Questions

- What idle measurement window is long enough to prove savings without slowing release?
- Should the user-facing dashboard show idle cost status, or should this remain a CLI/support
  diagnostic first?
- What threshold should block rollout if non-coordination DeepLake activity appears during idle?

