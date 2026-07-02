# PRD-064g: Doctor - Dashboard Escalation Reporting

> **Parent:** [PRD-064](./prd-064-doctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (3-8h)

---

## Goals

When auto-heal cannot restore the install, the user (and we) must learn about it. The wrinkle: the dashboard is served by the primary daemon, so when the daemon is dead, the dashboard is dead too. This sub-PRD solves "report a problem in the thing that hosts the report."

- Surface a structured "needs attention" report - diagnosis, ordered steps attempted, outcomes, recommended next action - whenever the remediation ladder exhausts.
- Make that report reachable even when the primary daemon is down.

## Scope

All three reachability paths ship in v1 (OD-7 resolved: local status page + hosted sink + incident file):

1. **Incident file the dashboard renders on recovery:** Doctor writes the escalation to `incidents.ndjson` / a `needs-attention.json`; once the daemon is back, the dashboard reads and renders a banner/health card. Survives daemon-down because it is just a file.
2. **Hosted escalation sink (resolved: reuse PostHog + alert):** the escalation is a high-severity OTLP log record on the 064d PostHog Logs path; we add a PostHog **alert** on it so we are notified remotely even if the user never opens the local dashboard. Correlate broken-auth installs by the stable per-install `device_id` (PRD-033 UUID), not org id. Graduate to a richer operator view in [PRD-061](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md) later.
3. **Minimal local status page:** Doctor serves a tiny read-only status page on its own loopback port so the user has *something* to look at while the primary daemon (and its dashboard) is down.

## Out of scope

- The healing itself - [064a](./prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md)/[064c](./prd-064c-doctor-self-healing-watchdog-remediation-ladder.md).
- The telemetry wire format - [064d](./prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md).

## Acceptance criteria

- AC-064g.1 Given the ladder exhausts, when escalation fires, then a structured needs-attention record (diagnosis + steps + outcomes + recommended action) is persisted locally (AC-3 parent).
- AC-064g.2 Given the daemon recovers after an escalation, when the dashboard loads, then it renders the most recent needs-attention report and its resolution state.
- AC-064g.3 Given the user is credentialed and the hosted sink is enabled, when escalation fires, then the report reaches the hosted surface so we see it remotely.
- AC-064g.4 Given the daemon is down and the local status page is enabled, when the user hits Doctor's loopback port, then they see current health + the escalation + suggested commands.
- AC-064g.5 Given an escalation is later resolved (heal succeeds on a subsequent loop), when resolution occurs, then the report is marked resolved so the dashboard banner clears.

## Technical considerations

- **Daemon-down is the design case, not the edge case.** Path 1 (file) must not require the daemon; path 2 (hosted) is how *we* learn without the user. Path 3 is comfort UX.
- **Dashboard read seam:** prefer having the daemon read Doctor's incident file (no new write path into the daemon) over Doctor calling into the daemon - keeps the dependency one-directional.
- **Scrubbing:** the same allow-list as 064d; a report shown locally may carry more detail than what is emitted remotely.

## Open questions

- [ ] Local status page port + whether it binds only when the primary daemon is down or always.
- [ ] PostHog alert routing for escalations (email / Slack) and a rate limit so a fleet-wide bad release does not fire thousands of alerts.
- [ ] How is a resolved escalation acknowledged - auto-clear on next healthy probe, or explicit user dismissal?

> OD-7 (all three paths in v1) and the hosted sink (reuse PostHog + alert, `device_id` correlation) are resolved in the parent index.
