# PRD-066e Dogfood Matrix

> Date: 2026-06-29
> Status: Automation added for package upgrade/restart paths; physical sleep/wake and transient
> DeepLake outage still require a bounded dogfood window before production default-on.

| Scenario | Current Evidence | Status |
| --- | --- | --- |
| Packaged install/update | `npm run smoke:local-queue-packaged-upgrade` packs the candidate, installs a previous fixture, upgrades to the candidate, and starts the upgraded daemon through the installed CLI entrypoint. | Automated |
| First upgraded boot | Packaged smoke verifies `.daemon/logs.db`, `.daemon/local-queue.db`, `event_log`, `request_log`, and `local_job`. | Automated |
| Second upgraded boot | Packaged smoke starts the upgraded CLI a second time against the same workspace and rechecks the DB schemas. | Automated |
| Rollback flag | Focused diagnostics tests verify `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` returns the shared path posture and reports queued local work without requiring DeepLake migration or local DB deletion. | Automated |
| Restart | Packaged smoke performs start/stop/start using the installed CLI and the same workspace. | Automated |
| Sleep/wake | Must run on a laptop/desktop with local queue enabled and at least one leased local job, then confirm expired lease recovery and no duplicate successful execution after wake. | Pending dogfood |
| Transient DeepLake outage | Must run with live credentials by inducing a bounded DeepLake connectivity failure during memory work, then confirm local job retry and later success. | Pending dogfood |
| Live idle meter after package upgrade | The existing live idle meter proves zero local idle coordination reads for repo build; packaged-upgrade-specific live meter still needs a single command gate. | Pending automation |
| Existing DeepLake recall after package upgrade | Existing live golden path/recall eval passed for the branch; packaged-upgrade-specific recall proof remains pending. | Pending automation |

## Production Default-On Gate

Do not flip local queue default-on for production single-machine installs until the pending dogfood
rows above are either automated or manually recorded with receipts.
