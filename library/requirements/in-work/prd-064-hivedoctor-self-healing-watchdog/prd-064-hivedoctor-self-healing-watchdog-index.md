# PRD-064: HiveDoctor - Self-Healing Watchdog Daemon (v1)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** XL (> 3d)
> **Schema changes:** None on Deep Lake. New `@legioncodeinc/hivedoctor` package with its own local state file; no change to the seven Deep Lake tables.

---

## Overview

Honeycomb ships a primary daemon (`127.0.0.1:3850`, `src/daemon`) that supervises an embeddings child (`127.0.0.1:3851`, `embeddings/`). When that daemon wedges, gets spawned from an unwritable cwd, serves stale routes, or its credentials go bad, the user sees a broken product and **we see nothing**. Multiple users are hitting these failure modes right now and we have zero remote visibility, so support is reactive and slow, and it costs us credibility.

HiveDoctor is a second, deliberately tiny, **separate package** (`@legioncodeinc/hivedoctor`) whose only job is to keep the Honeycomb install healthy and to tell us when it can't. It is designed to be effectively incapable of crashing: near-zero runtime dependencies (Node built-ins only), every remediation wrapped so a failure logs rather than kills it, and the process itself supervised by the OS so it survives reboots and self-kills. It performs the troubleshooting a human operator would: probe health, restart with exponential backoff, escalate to reinstall, clear bad credentials, remove a conflicting Hivemind install, and - when all of that fails - surface a structured "needs attention" report to the dashboard and to telemetry.

This is the v1 cut: maximum self-healing and visibility, minimum new attack surface and minimum blast radius from a bad auto-action. HiveDoctor talks to the primary daemon only over loopback HTTP (`/health`) and to the outside world only over the npm registry and the telemetry endpoint. It never imports the daemon's heavy dependencies (Deep Lake clients, `@huggingface/transformers`).

Source of truth for the failure modes this addresses: the operator-pain memory set - daemon boot wedges on memory_jobs backlog, secrets 502 = daemon cwd is system32, stale global daemon serves old routes, active workspace authority is credentials.json.

---

## Goals

- **Keep the primary daemon alive.** Probe `/health` on a fixed interval; on failure, run an escalating remediation ladder (restart -> reinstall -> clear creds -> report) with exponential backoff, exactly as a careful human operator would.
- **Be more reliable than what it watches.** HiveDoctor runs as its own OS-supervised process with Node-built-in-only runtime deps, so it survives daemon crashes, its own crashes, and reboots.
- **Give us remote eyes.** Emit error telemetry to PostHog, installation-health as OTLP, and attempted-troubleshooting steps as OTLP - all opt-out, never on when the user has said no.
- **Auto-heal silently on the happy path, escalate loudly on the hard path.** When the ladder cannot restore health, push a structured diagnosis to the dashboard and telemetry so we can act proactively.
- **Keep the daemon current, safely.** Poll npm `@legioncodeinc/honeycomb@latest` on a 30-minute TTL and auto-update the primary daemon (opt-out), gated so a single bad publish cannot brick the fleet, with post-update health verification and rollback.
- **Ship a delightful, branded operator tool.** A cute "hive doctor" ASCII art on invocation and a focused set of fix-it CLI commands.
- **Never surprise-update itself.** HiveDoctor only updates its own package on explicit `hivedoctor self-update`; it is designed not to need updating.

## Non-Goals

- **Commanding agents or fleet-wide control.** Remote command/enrollment/mint authority is [PRD-055](../prd-055-fleet-control-enrollment-and-mint-authority/prd-055-fleet-control-enrollment-and-mint-authority-index.md). HiveDoctor is local self-healing only.
- **Replacing the embed supervisor.** The primary daemon keeps supervising its embeddings child ([`embed-supervisor.ts`](../../../../src/daemon/runtime/services/embed-supervisor.ts)). HiveDoctor observes embeddings health via the primary `/health` and heals it indirectly by restarting the primary; it does not own the embed child directly (OD-8, resolved: indirect).
- **Purging credentials.** v1 does NOT auto-clear or manually clear `~/.deeplake/credentials.json` (OD-4, resolved: "do not purge credentials yet"). The capability is designed for but deferred to a later version; if HiveDoctor suspects a credential fault it escalates rather than deletes.
- **A hosted control plane of its own.** v1 reuses the existing PostHog telemetry path and the existing dashboard surface; it does not stand up new server infrastructure beyond a telemetry/OTLP sink.
- **Changing the Deep Lake schema or the recall/skillify pipeline.** Out of scope entirely.
- **Auto-updating HiveDoctor itself.** Explicitly forbidden by design (AC-6).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-064a-supervisor-core-and-lifecycle`](./prd-064a-hivedoctor-self-healing-watchdog-supervisor-core-and-lifecycle.md) | The watch loop, health probing, exponential-backoff restart, and the troubleshooting state machine | Draft |
| [`prd-064b-self-supervision-and-install-integration`](./prd-064b-hivedoctor-self-healing-watchdog-self-supervision-and-install-integration.md) | "Who watches the watchdog" - OS service / scheduled-task registration, baked into the bootstrap installer, opt-out | Draft |
| [`prd-064c-remediation-ladder`](./prd-064c-hivedoctor-self-healing-watchdog-remediation-ladder.md) | The escalating repair actions: reinstall primary, clear credentials, uninstall Hivemind - with authority tiers + idempotency | Draft |
| [`prd-064d-telemetry-and-observability`](./prd-064d-hivedoctor-self-healing-watchdog-telemetry-and-observability.md) | PostHog error events, OTLP installation-health, OTLP troubleshooting spans, and the opt-out contract | Draft |
| [`prd-064e-auto-update-engine`](./prd-064e-hivedoctor-self-healing-watchdog-auto-update-engine.md) | 30-min npm `@latest` poll for the primary daemon, blessed-version gate, post-update health verify + rollback | Draft |
| [`prd-064f-cli-and-ux`](./prd-064f-hivedoctor-self-healing-watchdog-cli-and-ux.md) | The ASCII art, diagnostic + manual-fix commands, and the explicit `self-update` for HiveDoctor's own package | Draft |
| [`prd-064g-dashboard-escalation-reporting`](./prd-064g-hivedoctor-self-healing-watchdog-dashboard-escalation-reporting.md) | How an unhealable state reaches the dashboard when the daemon is down: local status page + hosted escalation sink + incident file | Draft |
| [`prd-064h-primary-daemon-os-native-service`](./prd-064h-hivedoctor-self-healing-watchdog-primary-daemon-os-native-service.md) | Make the Honeycomb primary daemon itself an OS-native service (liveness floor under HiveDoctor's intelligent healing) | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given HiveDoctor is killed (SIGKILL) or the machine reboots, when the OS service manager runs, then HiveDoctor is back up within its restart window without any user action. |
| AC-2 | Given the primary daemon stops answering `/health`, when HiveDoctor's watch loop fires, then it restarts the daemon with exponential backoff and the daemon returns to `healthy`, with the whole episode logged locally. |
| AC-3 | Given the primary daemon cannot be restored after the full remediation ladder, when the ladder exhausts, then HiveDoctor records a structured "needs attention" report (diagnosis + ordered steps attempted + outcomes) reachable by the dashboard and emitted to telemetry. |
| AC-4 | Given telemetry is at its default (enabled), when HiveDoctor acts, then error events reach PostHog and installation-health + troubleshooting spans are emitted as OTLP; given `DO_NOT_TRACK=1`, `HONEYCOMB_TELEMETRY=0`, or the install opt-out, then zero telemetry leaves the box. |
| AC-5 | Given a new blessed `@legioncodeinc/honeycomb@latest`, when the 30-min poll observes it and auto-update is enabled, then HiveDoctor updates the primary daemon, verifies `/health`, and on a failed verify rolls back to the prior version. |
| AC-6 | Given any condition whatsoever, HiveDoctor never auto-updates its own package; `hivedoctor self-update` is the only code path that bumps `@legioncodeinc/hivedoctor`. |
| AC-7 | Given a user runs `hivedoctor` (no args), then the hive-doctor ASCII art renders followed by a menu of diagnostic and repair commands. |
| AC-8 | Given any single remediation step throws (network error, permission error, missing binary), when it fails, then the error is caught and logged and HiveDoctor stays alive and continues the loop - a remediation failure never crashes the watchdog. |
| AC-9 | Given a remediation rung, when HiveDoctor reaches it, then it runs per the resolved authority model - restart auto; reinstall auto after 3 failed restarts; uninstall conflicting Hivemind auto whenever detected; credential purge NOT performed (escalate instead) - and every rung is idempotent and logged with before/after state. |
| AC-10 | Given a user opted out at install (`--no-hivedoctor` or the auto-action opt-out), when installation completes, then HiveDoctor is either not installed or installed in observe-only mode per the chosen granularity, and it takes no auto-actions. |

---

## Architecture at a glance

```
            OS service manager (launchd / systemd / Windows service or Scheduled Task)
                                   │ supervises + restarts on crash/reboot  (064b)
                                   ▼
   ┌───────────────────────────  hivedoctor process  ───────────────────────────┐
   │  watch loop (064a) ── probe http://127.0.0.1:3850/health every N s          │
   │        │ unhealthy                                                          │
   │        ▼                                                                    │
   │  remediation ladder (064a + 064c), exponential backoff between rungs:       │
   │    1. restart daemon (precedent: src/daemon/restart-helper.ts)   [auto]      │
   │    2. reinstall primary, after 3 failed restarts                 [auto]      │
   │    3. uninstall conflicting Hivemind (@deeplake/hivemind)        [auto]      │
   │    4. escalate → dashboard + telemetry "needs attention"  (064g) [auto]      │
   │    (clear-credentials: DEFERRED, not in v1 - escalate instead)              │
   │                                                                            │
   │  auto-update engine (064e) ── 30-min npm @latest poll, blessed-gate,        │
   │                               verify /health, rollback on fail              │
   │                                                                            │
   │  telemetry (064d) ── PostHog errors + OTLP install-health + OTLP steps      │
   │  CLI + ASCII art (064f) ── manual diagnostics, fixes, explicit self-update  │
   └────────────────────────────────────────────────────────────────────────────┘
```

---

## Design principles (binding)

1. **Incapable of crashing.** Runtime dependencies are Node built-ins only (`node:http`, `node:child_process`, `node:fs`, `node:os`, `node:timers`). Every remediation runs inside a `try/catch` that logs and continues. An uncaught exception handler is a last-resort net, not the primary defense.
2. **More reliable than the watched.** HiveDoctor is supervised by the OS, not by the primary daemon. The two never depend on each other to stay alive.
3. **Loopback + registry only.** HiveDoctor reaches the daemon over `127.0.0.1` and the world over npm + the telemetry sink. No new inbound ports, no new auth surface.
4. **Silent on the happy path, loud on the hard path.** A successful restart is a low-noise log line; an unhealable install is a high-signal escalation.
5. **Least blast radius.** Destructive actions are gated by an authority tier (064c). A bad auto-update cannot propagate fleet-wide without passing the blessed-version gate (064e).
6. **Honest opt-out.** Telemetry and auto-actions honor `DO_NOT_TRACK` / `HONEYCOMB_TELEMETRY=0` / the install flag, verifiable by a single egress chokepoint.

---

## Evaluation and study of other codebases

Selection rule (per Mario, 2026-06-26): **fold code from MIT-licensed projects only**; Apache-2.0 and AGPL are study-only. Licenses to be re-verified at implementation time.

**Fold / fork candidates (MIT) - pending verification:**
- `node-windows` / `node-mac` / `node-linux` (MIT) - service-registration helpers for the three OS service managers (064b). Strong candidate, but weigh against the "Node-built-ins-only" principle: prefer shelling out to `launchctl` / `systemctl --user` / `sc.exe` / `schtasks` directly and vendoring only the tiny plist/unit/XML templates, to avoid taking on a dependency in the can't-crash process.

**Study only (ideas free, code not vendored):**
- **systemd** unit semantics (`Restart=always`, `RestartSec`, `StartLimitIntervalSec`/`StartLimitBurst`) - the canonical model for "restart with backoff, give up after a burst, surface failure." HiveDoctor's self-supervision (064b) and ladder backoff (064a) mirror this.
- **PM2** (AGPL) - god-daemon supervision, exponential restart delay, and the `pm2 resurrect` reboot-persistence pattern. Study its backoff and crash-loop detection; do not vendor.
- **Sentry SDK** crash-reporting ergonomics (breadcrumbs, before-send scrubbing) - informs the telemetry scrubbing contract in 064d. We do NOT adopt Sentry (OD-2 resolved: PostHog only); PostHog Error Tracking covers exception grouping via `$exception` events.
- **OpenTelemetry** semantic conventions for spans/resource attributes - the wire shape for installation-health and troubleshooting telemetry (064d).

**What we reuse from our own code:**
- Restart precedent: [`src/daemon/restart-helper.ts`](../../../../src/daemon/restart-helper.ts) (waits for old `/health` down, then spawns fresh detached) and the bounded-backoff pattern in [`embed-supervisor.ts`](../../../../src/daemon/runtime/services/embed-supervisor.ts) and [`poll-backoff.ts`](../../../../src/daemon/runtime/services/poll-backoff.ts).
- Structured health: [`src/daemon/runtime/health.ts`](../../../../src/daemon/runtime/health.ts) per-subsystem reasons (`storage`, `embeddings`, `schema`) - the input that lets HiveDoctor pick the right rung instead of blindly restarting.
- Telemetry chokepoint to mirror: [`src/daemon/runtime/telemetry/emit.ts`](../../../../src/daemon/runtime/telemetry/emit.ts) (`emitTelemetry`, PostHog capture, opt-out via `HONEYCOMB_TELEMETRY=0` / `DO_NOT_TRACK=1`, allow-list scrubbing).
- Installer seam: [`scripts/install/install.sh`](../../../../scripts/install/install.sh) / [`install.ps1`](../../../../scripts/install/install.ps1) and the `honeycomb install` verb ([`src/commands/install.ts`](../../../../src/commands/install.ts)) - where the HiveDoctor bootstrap + opt-out flag attach.
- Credentials authority: [`src/daemon/runtime/auth/credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts) (`~/.deeplake/credentials.json`) - the file HiveDoctor clears at the credentials rung.

---

## Data model changes

No Deep Lake changes. HiveDoctor keeps a small local **incident log + state file** under its own workspace dir (default `~/.honeycomb/hivedoctor/`):

- `state.json` - last-known daemon health, current backoff rung, last successful heal, auto-update channel + pinned/blessed version, opt-out flags.
- `incidents.ndjson` - append-only, bounded (size-capped + rotated) record of each remediation episode: timestamp, trigger, `/health` reasons, ordered steps attempted, outcomes. This is the source for the dashboard escalation report (064g) and the OTLP troubleshooting spans (064d).

Both are plain files written defensively (the same `canWriteDir()` fallback discipline the daemon uses) so a read-only or wrong cwd never wedges HiveDoctor.

---

## API changes

No new inbound daemon routes are strictly required for the watch loop (it consumes the existing `/health`). Two small additions are scoped in sub-PRDs and remain open:

- **(064g)** A way for the dashboard to read HiveDoctor's incident log when the daemon is up (read a file the daemon already exposes, or a tiny localhost status endpoint HiveDoctor serves) - chosen in 064g, see Open Questions.
- **(064e)** A "blessed version" lookup the auto-update engine consults before pulling `@latest` (a static JSON on the install CDN, or the telemetry/control-plane host) - chosen in 064e, see Open Questions.

---

## Risks

- **Auto-update fleet brick.** A bad `@latest` publish auto-propagating to every install within 30 minutes is the single highest risk. Mitigated by the blessed-version gate + post-update `/health` verify + rollback (064e). The gate is mandatory, not optional.
- **Destructive auto-action data/UX loss.** Clearing credentials logs the user out; uninstalling Hivemind touches a different product. Mitigated by the authority tier (064c): only the low-blast rungs auto-fire; the high-blast rungs need explicit or remote authorization.
- **Watchdog war / double-restart.** HiveDoctor and the daemon's own lock/restart-helper racing to restart could loop. Mitigated by respecting the PID/lock (`~/.honeycomb/daemon.pid`) and a cooldown after any restart HiveDoctor did not initiate.
- **The "who watches the watchdog" gap.** If self-supervision (064b) is weak, the whole premise fails. The OS service manager is the answer; a userland self-relaunch is a fallback, not the design.
- **Telemetry trust.** Shipping a process that phones home by default is a trust risk; the opt-out must be honest, documented at install, and verifiable (single chokepoint, 064d).

---

## Decisions (resolved by Mario, 2026-06-27)

The eight ODs that shaped the build are now resolved. Recorded here as the binding rulings; residual sub-questions are in the "Remaining sub-questions" list below.

- **OD-1 (self-supervision model) - RESOLVED: OS-native.** HiveDoctor is supervised by the OS service manager per platform (launchd / systemd-user / Windows Service or Scheduled Task). Userland self-relaunch is a fallback only; mutual daemon-and-doctor supervision is rejected. **Extension:** the Honeycomb primary daemon should *also* be OS-native - see new sub-PRD [064h](./prd-064h-hivedoctor-self-healing-watchdog-primary-daemon-os-native-service.md). The OS service gives a liveness floor; HiveDoctor remains the intelligent healing layer above it (wedged-but-alive, stale routes, version updates, escalation).
- **OD-2 (telemetry sinks) - RESOLVED: PostHog only, via PostHog Logs (OTLP).** No Sentry. HiveDoctor's three streams flow as OTLP **log records** to PostHog Logs (`{host}/i/v1/logs`, Bearer `phc_` project token, OTLP/HTTP). The logs exporter is OTLP/HTTP+**JSON**, so we hand-roll a zero-dependency JSON POST and honor the built-ins-only principle without dropping OTLP. Real exceptions may additionally go to PostHog Error Tracking (`captureException` → `$exception`) for issue-grouping. PostHog Logs is free to 50GB/mo. (Verified against PostHog Logs docs, 2026-06-27.)
- **OD-3 (auto-update safety) - RESOLVED: on by default + blessed-version gate + verify + rollback.** The 30-min `@latest` poll stands; the server-controlled blessed channel is the mandatory safety so a bad publish cannot auto-propagate fleet-wide.
- **OD-4 (remediation authority) - RESOLVED.** restart = auto; reinstall = auto **after 3 failed restarts**; uninstall conflicting Hivemind = **auto, always** (whenever a conflicting `@deeplake/hivemind` is detected); **clear-credentials = deferred, not in v1** (escalate instead of purging).
- **OD-5 (opt-out granularity) - RESOLVED: master switch + dashboard toggles.** `--no-hivedoctor` at install is the only install-time switch. Finer toggles (telemetry, auto-update, observe-only) live in the dashboard (telemetry env opt-outs `DO_NOT_TRACK` / `HONEYCOMB_TELEMETRY=0` are still honored).
- **OD-6 (package boundary) - RESOLVED.** `@legioncodeinc/hivedoctor` is a new top-level `hivedoctor/` directory in this repo, its own dependency-light package with its own release job.
- **OD-7 (dashboard reachability when daemon is down) - RESOLVED: all three paths in v1.** A minimal local status page on HiveDoctor's own loopback port, a hosted escalation sink (so we see failures remotely), and the incident file the dashboard renders on recovery. See [064g](./prd-064g-hivedoctor-self-healing-watchdog-dashboard-escalation-reporting.md).
- **OD-8 (embeddings scope) - RESOLVED: indirect.** Heal embeddings by restarting the primary, which restarts its embed child. No second supervisor over `3851` in v1.

### Sub-questions (resolved 2026-06-27)

- **OTLP transport (064d) - RESOLVED: PostHog Logs, hand-rolled OTLP/JSON, zero deps.** Stream telemetry as OTLP log records to `{host}/i/v1/logs`; the OTLP/HTTP+JSON encoding lets us POST via `fetch` with no OpenTelemetry SDK dependency, honoring built-ins-only. Exceptions may also hit Error Tracking for grouping.
- **Blessed-channel (064e) - RESOLVED: static JSON on the install CDN.** A `blessed-version.json` on `get.theapiary.sh`, flipped by a CI "bless" step gated on canary + smoke health. Fail-closed (stay on current version) if unreachable.
- **Hosted escalation sink (064g) - RESOLVED: reuse PostHog + alert.** An escalation is a high-severity log record/event we already send; add a PostHog alert on it. Correlate broken-auth installs by the stable per-install `device_id` (PRD-033 UUID), not org id. Graduate to PRD-061's surface later.
- **Windows default (064b/064h) - RESOLVED: per-user Scheduled Task.** No admin / no UAC, lowest install friction, for both HiveDoctor and the primary daemon. Windows Service offered as an enterprise opt-in.
- **Bootstrap mechanic (064b) - default: second global.** `npm i -g @legioncodeinc/hivedoctor`, keeping HiveDoctor's lifecycle independent of the Honeycomb tarball (revisit only if the second global proves fragile on install).

---

## Related

- [`prd-050-quick-install-and-guided-setup`](../../completed/prd-050-quick-install-and-guided-setup/prd-050-quick-install-and-guided-setup-index.md) - the installer HiveDoctor bootstraps into; [`prd-050d`](../../completed/prd-050-quick-install-and-guided-setup/prd-050d-quick-install-and-guided-setup-hivemind-coexistence-and-migration.md) (Hivemind coexistence) and [`prd-050e`](../../completed/prd-050-quick-install-and-guided-setup/prd-050e-quick-install-and-guided-setup-operator-adoption-telemetry.md) (adoption telemetry chokepoint we mirror).
- [`prd-054-fleet-observation-control-plane`](../prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md) and [`prd-055`](../prd-055-fleet-control-enrollment-and-mint-authority/prd-055-fleet-control-enrollment-and-mint-authority-index.md) - the fleet observe/command halves HiveDoctor stays clear of (it is local self-healing, not remote command).
- [`prd-061-hosted-roi-admin-surface`](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md) - candidate hosted escalation sink for 064g.
- `library/knowledge/private/operations/observability-and-degradation.md` - the degradation/health model HiveDoctor reads.
- `library/knowledge/private/data/deeplake-storage.md` - why presence/incident state must stay off the Deep Lake substrate.
- Operator-pain precedents this PRD exists to fix: daemon boot wedge on memory_jobs backlog; secrets 502 = daemon cwd is system32; stale global daemon serves old routes; active workspace authority is `~/.deeplake/credentials.json`.
