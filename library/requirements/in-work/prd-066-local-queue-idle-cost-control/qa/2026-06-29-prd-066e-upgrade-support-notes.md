# PRD-066e Upgrade, Rollback, And Support Notes

> Date: 2026-06-29
> Scope: Local queue idle-cost control packaged upgrade and rollback hardening.

## Upgrade Behavior

- The local queue is additive. Upgrade does not migrate or rewrite DeepLake memory, recall, vector,
  graph, or shared `memory_jobs` schemas.
- When `HONEYCOMB_LOCAL_QUEUE_ENABLED=true`, the daemon creates or reopens
  `.daemon/local-queue.db` under the resolved Honeycomb workspace.
- The existing `.daemon/logs.db` remains in place and is reopened on the first and second upgraded
  boot.
- Existing DeepLake memory rows remain the authoritative memory/recall substrate. PRD-066 changes
  local scheduling for local-only work, not the memory store.

## Old Shared Jobs

- New local-only jobs route to `.daemon/local-queue.db` when the local queue is enabled.
- Unknown or shared job kinds stay on the existing DeepLake-backed shared queue.
- Old DeepLake-backed local-kind jobs are visible through diagnostics as pending shared local jobs.
- If `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED=true`, workers can drain old shared local-kind jobs after
  the local queue is empty.
- If drain mode is false, old shared local-kind jobs are preserved on the shared path and surfaced
  rather than silently discarded.

## Rollback

Set:

```powershell
$env:HONEYCOMB_LOCAL_QUEUE_ENABLED = "false"
```

Expected behavior:

- the daemon returns to the old shared queue path;
- no DeepLake schema migration is required;
- `.daemon/local-queue.db` is not deleted;
- diagnostics report any queued, retrying, or leased local rows that will not process while rollback
  is active.

Rollback is safe when the local queue is empty or only contains completed/failed historical rows. If
queued/retrying/leased local rows exist, support should either re-enable local queue long enough to
drain them or explicitly accept that local-only work remains parked in `.daemon/local-queue.db`.

## Diagnostics

The protected local diagnostics endpoint is:

```text
GET /api/diagnostics/local-queue
```

It reports:

- local queue enabled/disabled;
- local queue persistence availability;
- status counts and kind counts from `.daemon/local-queue.db`;
- shared drain mode;
- topology default-on eligibility;
- rollback safety/warning fields;
- request-time pending shared local-kind jobs from DeepLake, or an unavailable/not-checked result.

The pending shared-job count is intentionally request-time only. It is not an idle poll and should
not reintroduce the PRD-066 idle coordination cost.

## Remaining DeepLake Cost Paths

PRD-066 only removes idle coordination polling for local-only job discovery. DeepLake is still used
for:

- memory writes;
- recall reads;
- vector/hybrid search;
- graph/codebase persistence when enabled;
- old shared queue fallback or explicit shared-drain diagnostics;
- multi-device/fleet shared semantics.

## Default-On Rule

Default-on is allowed only for single-machine/local topology. Multi-device, fleet, team/hybrid, or
unknown topology must stay conservative unless the user explicitly opts in.

Recognized environment controls:

```text
HONEYCOMB_TOPOLOGY=single-machine|multi-device|fleet|unknown
HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN=true
```

`HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN=true` allows an advanced user to override the topology guard.
Without that override, unknown/fleet/multi-device installs are not eligible for local queue
default-on.
