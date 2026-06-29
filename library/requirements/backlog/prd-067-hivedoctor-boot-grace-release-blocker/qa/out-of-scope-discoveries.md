# PRD-067 Out-of-Scope Discoveries

> **PRD:** `prd-067-hivedoctor-boot-grace-release-blocker`
> **Discovered during:** Package-specific local live proof on 2026-06-29
> **Disposition:** Accepted into PRD-067 scope as AC-11 on 2026-06-29.

## OOS-1: Second HiveDoctor `run` Can Exit Early When Status Port Is Already Bound

**Observation**

During package live testing, an older local `node bundle/cli.js run --no-auto-update` process was already listening on `127.0.0.1:3852`, the fixed HiveDoctor status-page port.

When the test launched a second packaged `hivedoctor run`, the status page could not bind. The status-page server correctly swallowed the bind failure, but the remaining long-running timers are unref'ed. With no referenced handle keeping the process alive, the second process could exit before it reached the first healthy tick.

**Original Scope Assessment**

PRD-067 is scoped to boot grace behavior once the supervisor is running:

- suppress remediation during the startup grace;
- keep the probe timeout short;
- resume normal remediation after grace;
- re-arm grace after successful restarts.

The fixed status-page port / duplicate HiveDoctor process lifecycle behavior is adjacent operational hardening, not required for the boot-grace acceptance criteria.

The user accepted this into PRD-067 scope after review, so it is now tracked in the execution ledger as AC-11.

**Why It May Matter**

This can affect local manual tests and may affect real installs if:

- an older HiveDoctor process is already running;
- the service manager starts a second instance instead of replacing the first;
- another process occupies `127.0.0.1:3852`;
- status-page bind failure leaves no referenced handles after startup.

**Potential Follow-Up Options**

1. Add a `HIVEDOCTOR_STATUS_PAGE_PORT` env/config field so tests and operators can choose port `0` or another loopback port.
2. Add a process-level keepalive handle for `run` so HiveDoctor remains alive even when the status page cannot bind.
3. Add single-instance detection or a lock file for HiveDoctor itself, so duplicate runs exit with an explicit diagnostic instead of a quiet early exit.
4. Treat status-page bind failure as degraded-but-running, and expose it in `hivedoctor status` / logs.

**Recommendation**

Bring this into a separate PRD or addendum after PRD-067, with option 2 as the smallest operational safety fix and option 1 as the best testability/operator-control improvement.
