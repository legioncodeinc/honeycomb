# PRD-066b: Worker Routing And Migration

> **Status:** Backlog
> **Parent:** PRD-066
> **Priority:** P0
> **Effort:** M

## Overview

Move local-only daemon producers and workers from DeepLake-backed queue discovery to the new local
queue. The goal is not to eliminate all DeepLake access; it is to eliminate DeepLake coordination
reads for work that originates and executes on the same machine.

## Scope

- Audit current job kinds and classify them as local-only, shared, or unknown.
- Route first-wave local-only producers to the local queue.
- Route first-wave local-only workers to lease from the local queue.
- Keep existing DeepLake-backed job behavior available behind a fallback flag.
- Define drain behavior for any already-enqueued DeepLake jobs.
- Preserve idempotency and ordering expectations for migrated job kinds.

## Non-Goals

- Implement hosted fleet coordination.
- Migrate shared cross-device work to the local queue.
- Remove PRD-062 adaptive polling.
- Change memory/vector persistence behavior.

## First-Wave Candidate Jobs

The implementation audit should verify exact names before code changes, but the intended first wave
is:

- local capture processing jobs;
- pollinating trigger and maintenance jobs created by the same daemon;
- local summary, wiki, and document retry jobs;
- local debounce and batching timers;
- local reaper and retry bookkeeping.

Jobs should stay out of scope for this PRD if they intentionally coordinate between devices or
depend on another machine discovering the same queue item.

## Functional Requirements

1. Job producers must declare whether their job is local-only or shared.
2. Local-only producers must enqueue to the local queue when the feature flag is enabled.
3. Shared or unknown jobs must continue using the existing path until explicitly migrated.
4. Local-only workers must lease from the local queue when the feature flag is enabled.
5. Local workers must touch DeepLake only inside handlers that perform actual memory/vector/storage
   work.
6. Existing DeepLake-backed jobs must either drain safely or be ignored only after an explicit
   migration rule.
7. The worker layer must emit metrics distinguishing local queue leasing from DeepLake operations.
8. Feature flag off must preserve current queue behavior.

## Acceptance Criteria

- AC-1: Tests assert that first-wave local-only producers do not call DeepLake enqueue APIs when the
  local queue flag is enabled.
- AC-2: Tests assert that first-wave local-only workers do not call DeepLake polling APIs for job
  discovery when the local queue flag is enabled.
- AC-3: Handler-level DeepLake reads/writes still occur when a local job performs real memory work.
- AC-4: Feature flag off preserves current DeepLake-backed queue behavior.
- AC-5: Migration tests cover old DeepLake jobs that exist at daemon startup.
- AC-6: Duplicate execution is prevented or made harmless through idempotency keys.
- AC-7: Unknown job kinds fail closed to the current shared path until classified.

## Migration Plan

1. Add classification for each known job kind: `local`, `shared`, or `unknown`.
2. Enable local queue for one low-risk job kind in tests.
3. Enable first-wave local job kinds behind a default-off flag.
4. Drain any old DeepLake jobs while preventing new local-only jobs from entering DeepLake.
5. Turn the flag on for local development and internal dogfood.
6. Turn the flag on for single-machine installs after PRD-066c verifies idle behavior.

## Risks

- A job classified as local-only may have hidden cross-device expectations.
- Duplicate retries could create duplicate memory writes if handlers are not idempotent.
- Old DeepLake jobs may keep polling alive until drained or explicitly abandoned.
- Diagnostics may be confusing while both queue paths exist.

## Open Questions

- What is the exact source of truth for job-kind classification?
- Should the fallback flag be global or per job kind?
- How long should old DeepLake queue draining remain enabled?

