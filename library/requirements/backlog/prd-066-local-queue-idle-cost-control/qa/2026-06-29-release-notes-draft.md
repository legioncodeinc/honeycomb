# Release Notes Draft: Local Queue Idle-Cost Control

Honeycomb can now run first-wave local-only daemon jobs through a durable device-local SQLite queue instead of polling the shared Deeplake-backed `memory_jobs` queue while idle.

The local queue is a scheduler boundary only. DeepLake remains the memory, recall, vector, and shared-state substrate; real memory writes and recall reads still use the existing DeepLake-backed storage paths when work is active.

## Feature Flags

- `HONEYCOMB_LOCAL_QUEUE_ENABLED=true` enables the local queue router.
- `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` or unset preserves the existing shared Deeplake-backed queue behavior.
- `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED=true` enables migration drain mode so old shared `memory_jobs` rows can be leased after the local queue is empty.

## Expected Cost Impact

For single-machine users with no active work and an empty local queue, local-only workers should stop issuing DeepLake coordination reads for queue discovery. This does not remove DeepLake costs for real memory writes, recall reads, vector search, schema checks, or any shared/fleet feature that intentionally uses DeepLake.

Live PRD-066 query-meter proof on 2026-06-29 measured the shared DeepLake-backed queue path at 39 poll reads and the local queue path at 0 poll reads / 0 poll writes for the same idle/job-discovery proof. The active local memory pipeline also reached DeepLake storage work with 67 total reads and 15 total writes while remaining at 0 coordination poll reads / 0 poll writes.

## Remaining Verification

Before release, run the remaining PRD-066 and dogfood checks against a funded, credentialed daemon to capture:

- recall reads categorized separately from coordination polling;
- daemon restart, sleep/wake, and transient DeepLake outage dogfood scenarios.
