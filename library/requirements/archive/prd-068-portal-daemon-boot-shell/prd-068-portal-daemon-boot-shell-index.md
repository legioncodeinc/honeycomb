# PRD-068: Portal Daemon Boot Shell

> **Status:** Superseded by [hive PRD-003 (portal landing gate and routing)](../../../../../hive/library/requirements/backlog/prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) and [hive PRD-004 (/buzzing service loaders)](../../../../../hive/library/requirements/backlog/prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md). Archived 2026-07-03; a reference copy lives in the hive repo as hive PRD-006 (`hive/library/requirements/archive/prd-006-portal-daemon-boot-shell/`).
>
> The portal is no longer a honeycomb-owned boot shell. Under the fleet realignment hive owns the human-facing portal: PRD-003 handles the landing gate and routing and PRD-004 handles the /buzzing boot experience. Honeycomb's role is now that of a supervised service (see [PRD-071](../../backlog/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md)).

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None. Local portal status files may be added under `~/.honeycomb`, but no DeepLake schema changes.

---

## Overview

The current install flow opens the primary daemon dashboard only after `honeycomb install` health-gates `127.0.0.1:3850`. That means the first browser experience is coupled to the slowest, heaviest process: the primary daemon. The longer-term fix is to launch a lightweight portal daemon immediately, separate from the primary daemon, so a browser can open instantly and show truthful boot progress while the primary daemon, embeddings service, storage checks, and dashboard app come online.

This PRD defines the second step in the boot-experience sequence: a portal daemon that starts fast, survives primary daemon failure, shows `booting` for the first 60 seconds, and transitions users into the regular Honeycomb dashboard once the primary daemon is ready.

---

## Goals

- Give fresh installs and machine boots an immediately available browser surface, even when the primary daemon is still warming.
- Keep the portal separate from the primary daemon so it can still render when `3850` is down.
- Reuse Doctor's existing loopback status-page foundation where possible, especially `doctor/src/status-page/server.ts`.
- Show a clear `booting` state for the first 60 seconds, then transition to `healthy`, `still starting`, `degraded`, or `needs attention` based on real health signals.
- Open the portal first from install and boot flows, then deep-link or redirect to the primary dashboard only after primary readiness.
- Keep the portal read-only for v1: no credential mutations, no repair buttons that execute side effects, no DeepLake reads.

## Non-Goals

- Replacing the regular dashboard served by the primary daemon at `/dashboard`.
- Building the full application health dashboard. The portal shell only hosts the boot and routing experience; PRD-069 defines the full health dashboard.
- Making the portal a remote control plane.
- Adding a second heavy frontend stack that can crash or delay startup.
- Exposing any portal endpoint outside loopback.

---

## Code-grounded current state

| Area | Current code fact | Portal implication |
|---|---|---|
| Install opens primary dashboard | `src/commands/install.ts` calls `ensureDaemonRunning(...)`, then opens `http://honeycomb.local:3850/dashboard` or `http://127.0.0.1:3850/dashboard`. | The browser cannot show progress until the primary daemon is healthy enough to answer. |
| Primary dashboard host | `src/daemon/runtime/dashboard/host.ts` serves the React shell and assets from the primary daemon in local mode. | The normal dashboard remains the destination after boot, but cannot be the first guaranteed surface. |
| Doctor status page | `doctor/src/status-page/server.ts` already serves read-only HTML and `/status.json` on loopback port `3852`. | This is the best seed for the portal because it already lives outside the primary daemon and is designed to swallow bind errors. |
| Doctor composition | `doctor/src/compose/index.ts` starts the status page before the supervisor loop. | The portal can be available before the first primary health decision. |
| Dashboard data source | `src/dashboard/launch.ts` and `src/dashboard/contracts.ts` treat daemon reachability as an explicit connectivity state. | The portal can reuse the same mental model: reachable vs unreachable, not blank page or hang. |
| Setup state | `src/daemon/runtime/dashboard/setup-state.ts` exposes `authenticated` and embeddings `warmup` once the primary is up. | The portal can consume this after primary readiness, but cannot depend on it during pre-bind boot. |
| Diagnostics health | `src/daemon/runtime/diagnostics-health.ts` exposes protected subsystem health through the primary daemon. | The portal can show coarse unauthenticated health while primary is down, then richer details after the primary is reachable and local mode permits it. |

---

## Product behavior

### First 60 seconds

When the portal starts, it displays `booting` for 60 seconds by default:

- The visual state is optimistic but honest: "Honeycomb is starting."
- It shows the primary daemon status as `waiting for 127.0.0.1:3850`.
- It shows Doctor status as `watching`.
- It shows a countdown or elapsed boot timer.
- It does not show a terminal failure during this window unless Doctor has an existing unresolved escalation from a prior run.

### After 60 seconds

After the grace window:

- If primary `/health` is `ok`, show a ready state and offer/open the regular dashboard.
- If primary `/health` is `degraded`, show degraded with subsystem details where available.
- If primary is still unreachable but a primary daemon PID/lock is held, show `still starting`.
- If primary is unreachable and no process/service is known to be running, show `needs attention`.
- If Doctor has an unresolved needs-attention record, surface it above all other copy.

### Transition

The portal must not hard-redirect before the primary is actually ready. Acceptable transitions:

- A primary "Open dashboard" button appears when `3850/dashboard` is reachable.
- Optional automatic soft-redirect after readiness, but only if the user has not interacted with troubleshooting UI.
- Always keep the portal URL available as the "health and boot" home base.

---

## Architecture options

### Recommended v1: portal served by Doctor

Use the existing Doctor process as the portal daemon for v1:

- Extend `doctor/src/status-page/server.ts` from minimal status page to portal shell.
- Keep `DEFAULT_STATUS_PAGE_PORT = 3852`.
- Add a richer `/portal/status.json` or extend `/status.json` with boot metadata.
- Serve static inline CSS/JS or bundled static assets with no runtime dependencies.
- Keep the process under Doctor's existing OS service supervision.

This meets the user's "separate daemon" intent because it is separate from the primary daemon and can render when primary is down. It avoids a third OS service while preserving the can-not-crash property.

### Later option: dedicated `honeycomb-portal` process

If Doctor becomes too constrained, split the portal into a dedicated lightweight process:

- Separate package or binary.
- OS-supervised like Doctor.
- Still loopback only.
- Still read-only.
- Consumes Doctor status and primary health over loopback.

This is explicitly not the v1 recommendation unless product or reliability pressure requires it.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given Doctor is installed and started, when the portal port is requested, then a browser-visible portal page responds before the primary daemon is required to answer `/health`. |
| AC-2 | Given the primary daemon has not answered `/health` and the portal boot timer is under 60 seconds, when the portal renders, then it shows `booting` rather than `dead`, `failed`, or `needs attention`. |
| AC-3 | Given the primary daemon becomes healthy during the first 60 seconds, when the portal polls status, then it transitions to ready and offers the regular dashboard URL. |
| AC-4 | Given the primary daemon remains unreachable after 60 seconds and no PID/service signal says it is still starting, when the portal polls status, then it shows a clear action-oriented needs-attention state. |
| AC-5 | Given Doctor has an unresolved needs-attention record from a prior episode, when the portal opens during a new boot, then the prior escalation is shown without being overwritten by the booting state. |
| AC-6 | Given port `3852` is occupied, when the portal attempts to bind, then Doctor logs the bind failure and continues running; the primary daemon is not affected. |
| AC-7 | Given `DO_NOT_TRACK=1` or telemetry opt-out is configured, when the portal renders and polls local status, then no extra telemetry egress is introduced. |
| AC-8 | Given the user is on a headless machine, when install cannot open a browser, then the CLI prints the portal URL, not only the primary dashboard URL. |
| AC-9 | Given the primary daemon is healthy, when the user opens the portal, then the portal links to `http://127.0.0.1:3850/dashboard` and does not proxy or duplicate the full dashboard. |
| AC-10 | Given local mode is not active or a future team/hybrid mode is running, then the portal remains loopback-only and exposes no tenant data or secret material. |

---

## Implementation notes

Recommended implementation path:

1. Extend Doctor's status page into a small portal host.
2. Add boot timer metadata to the status provider:
   - `portalStartedAt`
   - `startupGraceMs`
   - `primaryHealth`
   - `doctorHealth`
   - `needsAttention`
   - `regularDashboardUrl`
3. Add a read-only primary health probe from the portal status provider with a very short timeout, separate from the supervisor remediation loop.
4. Change `honeycomb install` so it starts/ensures Doctor/portal before waiting for the primary daemon, then opens `http://127.0.0.1:3852/`.
5. Keep the existing primary health-gate for command success semantics, but do not block the first browser open on it.
6. Keep the regular dashboard unchanged; the portal only routes to it after readiness.

Do not:

- Make the portal call DeepLake.
- Make the portal mutate credentials, settings, service registrations, or restart state.
- Serve the portal on `0.0.0.0`.
- Depend on the primary daemon's React dashboard bundle to render the boot shell.

---

## Files expected to change

| File | Expected change |
|---|---|
| `doctor/src/status-page/server.ts` | Evolve the minimal status page into a portal shell with boot state and richer JSON. |
| `doctor/src/compose/index.ts` | Provide portal boot timing, primary probe, and needs-attention state. |
| `doctor/tests/status-page/server.test.ts` | Cover booting, ready, degraded, needs-attention, bind failure. |
| `doctor/tests/compose/create-doctor.test.ts` | Cover portal status provider wiring. |
| `src/commands/install.ts` | Open the portal URL early and continue to report primary dashboard fallback. |
| `scripts/install/install.sh` and `scripts/install/install.ps1` | Ensure Doctor/portal bootstrap happens before CLI handoff where needed. |

---

## Test plan

- Unit: portal HTML and JSON render under all coarse states.
- Unit: bind failure does not throw.
- Unit: status provider does not block on primary health.
- CLI test: install command opens portal URL before or independently from primary dashboard readiness.
- Live Windows proof: install candidate package, start portal, verify browser can load `127.0.0.1:3852` while primary is delayed or down.
- Live delayed-primary proof: fake or delayed primary becomes healthy after 30 seconds; portal shows booting then ready.
- Headless proof: opener returns false; CLI prints portal URL.

---

## Open questions

- [ ] Should the portal keep using port `3852`, or should we reserve a more user-facing port name/constant before shipping the feature?
- [ ] Should install open the portal immediately and leave it open, or open the portal immediately and then soft-redirect once primary dashboard is ready?
- [ ] Should the portal be branded as "Honeycomb Portal", "Honeycomb Health", or "HiveDoctor"? Recommendation: "Honeycomb" first, Doctor as the reliability layer.
- [ ] Should a future dedicated portal process be a separate package, or remain a mode/route of `@legioncodeinc/doctor`?

---

## Related

- [PRD-067: Doctor Boot Grace Release Blocker](../prd-067-doctor-boot-grace-release-blocker/prd-067-doctor-boot-grace-release-blocker-index.md)
- [PRD-069: Application Health Dashboard](../prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md)
- [PRD-070: First Browser Load Experience](../prd-070-first-browser-load-experience/prd-070-first-browser-load-experience-index.md)
- `doctor/src/status-page/server.ts`
- `doctor/src/compose/index.ts`
- `src/commands/install.ts`
- `src/daemon/runtime/dashboard/host.ts`
- `src/dashboard/launch.ts`
- `src/dashboard/contracts.ts`
