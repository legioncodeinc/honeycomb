# PRD-070: First Browser Load Experience

> **Status:** Superseded by [hive PRD-003 (landing gate)](../../../../../hive/library/requirements/backlog/prd-003-portal-gate-and-routing/) and [hive PRD-004 (/buzzing)](../../../../../hive/library/requirements/backlog/prd-004-buzzing/).
>
> The first browser load is now owned by hive portal: PRD-003 defines the landing gate and PRD-004 defines the /buzzing boot experience. Honeycomb no longer serves this surface; its fleet role is defined in [PRD-071](../prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md).

> **Status:** Backlog
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None. Visual assets may be added to dashboard or portal asset folders.

---

## Overview

The first browser load after install or boot should feel intentional, alive, and trustworthy. Today the best case is that the primary dashboard opens after the daemon is healthy; the worst case is the user waits with no clear visual proof that Honeycomb is doing anything. After PRD-067 and PRD-068, the browser can open immediately to a portal shell. This PRD defines the visual and interaction experience for that first load: a polished graphical boot scene that communicates progress, shows health signals, respects accessibility, and transitions cleanly into the application.

This is not a marketing landing page. It is the first operational surface of the installed app.

---

## Goals

- Make the first browser load on boot feel high-quality and unmistakably Honeycomb.
- Show a graphical boot experience for the first 60 seconds that matches the real boot grace.
- Communicate progress through truthful health signals rather than fake percentages.
- Transition gracefully to the regular dashboard when the primary daemon is ready.
- Keep the experience lightweight enough to be served by the portal/Doctor process.
- Work on Chrome desktop without layout shifts, blank screens, or text overlap.
- Respect reduced motion and avoid motion-heavy effects for users who opt out.

## Non-Goals

- A public marketing landing page.
- A full onboarding wizard redesign.
- A game or decorative-only animation that hides actual health state.
- Loading remote fonts, scripts, analytics, or images from the internet.
- Blocking application readiness on animation completion.
- Adding authentication or repair actions to the boot screen.

---

## Code-grounded current state

| Area | Current code fact | UX implication |
|---|---|---|
| Regular dashboard assets | `src/daemon/runtime/dashboard/host.ts` serves `/dashboard`, `/dashboard/app.js`, `/dashboard/styles.css`, `/dashboard/honeycomb-memory-cluster.svg`, and fonts from the primary daemon. | The boot experience can reuse brand assets and visual language, but cannot depend on the primary daemon being up. |
| Portal seed | `doctor/src/status-page/server.ts` currently serves minimal inline HTML/CSS with no external resources. | The boot shell should preserve the no-network, loopback-only reliability posture. |
| Install opener | `src/commands/install.ts` opens the dashboard URL after daemon readiness. | PRD-068 will change the first-open target to the portal; this PRD defines what users see there. |
| Connectivity model | `src/dashboard/contracts.ts` defines reachable/unreachable states. | The visual scene should render from real connectivity states. |
| Setup warmup | `src/daemon/runtime/dashboard/setup-state.ts` exposes embeddings `warmup` once primary is reachable. | The graphical boot can show embeddings as warming without treating it as failure. |
| Health dashboard | PRD-069 will define layered status cards. | The boot scene should use the same health labels and transition into the health dashboard. |

---

## Experience concept

The boot screen should be a full-browser operational scene:

- Honeycomb brand mark or generated bitmap/asset-based visual as the first viewport signal.
- A central "Honeycomb is booting" state for the first 60 seconds.
- A subtle animated memory/health graph or honeycomb-cell field driven by CSS/canvas, not heavy libraries.
- Real status chips:
  - Portal
  - Doctor
  - Primary daemon
  - Storage
  - Embeddings
- A small event rail:
  - "Portal ready"
  - "Watching primary daemon"
  - "Waiting for /health"
  - "Dashboard ready" when true
- A clear action when ready: "Open dashboard".
- A secondary action: "View health details".

Copy should be calm and concrete:

- During grace: "Honeycomb is starting."
- Still starting after grace: "The primary daemon is still coming online."
- Healthy: "Honeycomb is ready."
- Needs attention: "Honeycomb needs attention."

Do not use fake progress bars. Use elapsed time, status chips, and real readiness transitions.

---

## Visual requirements

- The page must use a real visual asset or generated bitmap/Canvas scene, not a plain text card.
- The experience must not be dominated by a single purple/blue gradient.
- The first viewport must show the Honeycomb product identity and at least one live health signal.
- On desktop and mobile widths, no text may overlap, clip, or resize the layout unexpectedly.
- Buttons should use icons where appropriate and short labels.
- The page must support `prefers-reduced-motion: reduce`.
- The visual should degrade to a static image or static layout if animation fails.
- All assets must be served same-origin from the portal process or embedded inline.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the portal opens before primary readiness, when Chrome loads the page, then a branded graphical boot experience paints within 1 second on a normal local machine. |
| AC-2 | Given the portal boot timer is under 60 seconds and primary is not ready, when the page renders, then it says Honeycomb is booting and shows real status chips without claiming failure. |
| AC-3 | Given primary becomes ready, when the status poll observes readiness, then the page transitions to a ready state and enables an "Open dashboard" action. |
| AC-4 | Given boot exceeds 60 seconds and primary is still not ready, when the page updates, then it transitions to a calm "still starting" or "needs attention" state based on health data. |
| AC-5 | Given `prefers-reduced-motion: reduce`, when the page loads, then all nonessential animation is disabled while the page remains visually complete. |
| AC-6 | Given a mobile viewport, when the page renders, then health chips, event rail, and actions fit without overlap or horizontal scrolling. |
| AC-7 | Given the regular dashboard is ready, when the user clicks "Open dashboard", then the browser navigates to `http://127.0.0.1:3850/dashboard` or the configured local dashboard URL. |
| AC-8 | Given the user clicks "View health details", then the browser navigates to the PRD-069 health dashboard route without requiring the primary daemon. |
| AC-9 | Given portal status JSON is temporarily unavailable, when the page polls, then the visual remains mounted and shows an unknown/offline state rather than blanking. |
| AC-10 | Given a packaged install on this machine, when the first browser opens during boot, then screenshots at desktop and mobile sizes show a nonblank, polished, correctly framed experience. |

---

## Implementation notes

Recommended implementation path:

1. Build the boot experience as a portal-served shell, not as part of the primary daemon dashboard.
2. Keep the first version dependency-light:
   - Static HTML.
   - CSS.
   - Small inline or bundled JS for polling and transitions.
   - SVG/bitmap/canvas assets served locally.
3. Reuse existing brand assets from the dashboard bundle where possible, but copy or expose them through the portal so the primary daemon is not required.
4. Poll the portal health endpoint from PRD-068/069.
5. Use real health labels from PRD-069's shared health model.
6. Add browser verification with Playwright:
   - Desktop screenshot.
   - Mobile screenshot.
   - Reduced-motion screenshot.
   - Primary-down booting state.
   - Primary-ready transition.

Avoid:

- Remote CDNs.
- Long startup JS bundles.
- Heavy React dependency in the portal unless bundled and proven to paint fast.
- Fake progress percentages.
- Full-screen marketing hero copy.

---

## Files expected to change

| File | Expected change |
|---|---|
| `doctor/src/status-page/server.ts` or new `doctor/src/portal/*` | Serve boot shell and local assets. |
| `doctor/tests/status-page/server.test.ts` | Cover HTML contains boot UI states and no remote resources. |
| New portal browser tests | Verify desktop/mobile/reduced-motion render and ready transition. |
| `src/commands/install.ts` | Open portal first after PRD-068, not directly relevant to visual implementation beyond route target. |
| Asset folder under `doctor/` or shared dashboard assets | Add/copy any required brand images or generated visual assets. |

---

## Test plan

- Unit: HTML shell has required status roots and no external script/style URLs.
- Unit: status-to-copy mapping for booting, ready, still-starting, degraded, needs-attention.
- Browser: Playwright screenshot at 1440x900.
- Browser: Playwright screenshot at 390x844.
- Browser: Playwright reduced-motion emulation.
- Browser: canvas or visual asset nonblank check if using canvas.
- Live packaged proof: install candidate package, delay primary boot, confirm Chrome first load shows boot scene then ready transition.

---

## Open questions

- [ ] Should the boot scene use CSS/SVG only, Canvas, or a generated bitmap background plus CSS status UI? Recommendation: generated/static asset plus light CSS animation for v1.
- [ ] Should the page auto-open the regular dashboard when ready, or wait for user action? Recommendation: offer action first; auto-redirect only if the user has not interacted.
- [ ] Should the boot scene be named "Portal", "Health", or simply "Honeycomb"? Recommendation: user-facing name is "Honeycomb"; "Portal" remains implementation language.
- [ ] Do we want a launch sound or any audio? Recommendation: no.

---

## Related

- [PRD-067: Doctor Boot Grace Release Blocker](../prd-067-doctor-boot-grace-release-blocker/prd-067-doctor-boot-grace-release-blocker-index.md)
- [PRD-068: Portal Daemon Boot Shell](../prd-068-portal-daemon-boot-shell/prd-068-portal-daemon-boot-shell-index.md)
- [PRD-069: Application Health Dashboard](../prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md)
- [PRD-024: Dashboard UI Parity](../../completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md)
- `doctor/src/status-page/server.ts`
- `src/daemon/runtime/dashboard/host.ts`
- `src/dashboard/contracts.ts`
- `src/commands/install.ts`
