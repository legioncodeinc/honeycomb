# PRD-065: Doctor Go-Live and Activation

> **Status:** In Work
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None. Adds one static CDN object (`blessed-version.json`) to the get.theapiary.sh install surface and turns on already-shipped Doctor behavior.

---

## Overview

[PRD-064](../../completed/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md) built and shipped Doctor (`@legioncodeinc/doctor`, live on npm at 0.1.3 via OIDC). Three pieces were built but left dormant or unverified because they depend on infrastructure outside the package: the **blessed-version channel** that activates auto-update, the **one-command installer** actually serving the Doctor bootstrap, and a **live confirmation** that telemetry reaches PostHog. This PRD turns those on and verifies them. It is an activation and verification pass, not new package code.

---

## Goals

- **Activate auto-update.** Serve `https://get.theapiary.sh/blessed-version.json` so Doctor's auto-update engine (built in 064e, currently fail-closed with no channel) forward-updates straggler daemons to a blessed honeycomb version, with the client's verify-and-rollback intact.
- **Go live in the installer.** Deploy the get.theapiary.sh install surface so a fresh `curl get.theapiary.sh | sh` installs Doctor and registers its OS service (opt out with `--no-doctor`).
- **Confirm telemetry end to end.** Prove a live Doctor run emits install-health and troubleshooting OTLP logs to PostHog (project Honeycomb, 485287), and that opt-out suppresses them.
- **Self-blessing releases.** Make each honeycomb `v*` release regenerate `blessed-version.json` to the released version, so blessing rides the existing release gate with no separate manual step.

## Non-Goals

- New Doctor package code (the watchdog, ladder, telemetry, auto-update, CLI all shipped in 064).
- A full canary-gated bless pipeline (release-tag-equals-bless is the v1; a richer canary/health gate is a follow-up, see Open questions).
- The dashboard surfaces for Doctor (escalation render + telemetry/auto-update toggles) - tracked as follow-ups below.

---

## Acceptance criteria

| ID | Criterion | Status |
|---|---|---|
| AC-1 | `https://get.theapiary.sh/blessed-version.json` returns `{"version": "<x>"}` (short-cached, `application/json`); Doctor's blessed gate reads it and stops failing closed. | Shipped this pass (build emits it); live on deploy |
| AC-2 | A fresh install from get.theapiary.sh installs `@legioncodeinc/doctor` and registers its OS service unless `--no-doctor`; the served `install.sh`/`install.ps1` contain the Doctor bootstrap. | Live on deploy |
| AC-3 | A Doctor run emits OTLP logs to PostHog Logs (485287), scrubbed (no creds/PII); `DO_NOT_TRACK=1` produces zero egress. | CONFIRMED (2026-06-28): service `doctor`, 95 records/7d, `episode` stream landing with allow-listed attributes only. Caveats: emitters seen were dev builds (`0.0.0-dev`, `device_id: unknown-device`); confirm a published install stamps version + device-id, and spot-check the info/error streams + the opt-out path. |
| AC-4 | Each honeycomb `v*` release deploy regenerates `blessed-version.json` to the released version (self-blessing); a manual dispatch blesses main's current version. | Shipped this pass |
| AC-5 | A bad blessed value is recoverable: re-deploy with a corrected (or removed) `blessed-version.json` and the client fails closed to the current version. | By construction (fail-closed client) |

---

## Implementation (this pass)

- `site/install/build.mjs` now emits `dist/blessed-version.json` = `{ version: <root package.json version> }` (currently **0.1.9**), so the same Cloudflare Pages deploy that publishes the installer also publishes the blessed channel, and a `v*` release self-blesses the released version.
- `site/install/_headers` serves `/blessed-version.json` as `application/json`, `nosniff`, `max-age=300` (short, so a new bless propagates inside the 30-minute poll).
- Activation = run `deploy-install-site.yaml` (the existing Cloudflare Pages deploy; `v*` tag or manual dispatch). That one deploy publishes the Doctor-enabled installer **and** the blessed channel.

The installer scripts (`scripts/install/install.sh` / `install.ps1`) already carry the Doctor bootstrap (064b, merged to main); `build.mjs` copies them verbatim as its single source of truth, so no installer edit is needed for go-live.

---

## Open questions / follow-ups

- [x] **Telemetry confirmation (AC-3).** CONFIRMED 2026-06-28 via PostHog Logs: `doctor` service, 95 records/7d, `episode` stream scrubbed (no creds/PII). Residual: the observed emitters were dev builds (`doctor_version: 0.0.0-dev`, `device_id: unknown-device`) - confirm a published `0.1.x` install stamps a real version and resolves the PRD-033 device-id (the `unknown-device` fallback is the one thing to chase), and spot-check the `info` (install-health) and `error` streams plus the `DO_NOT_TRACK=1` opt-out.
- [ ] **Canary-gated bless.** v1 blesses the released version on the release-tag deploy (which already passed CI). A stronger gate (bless only after a canary cohort reports healthy via the same telemetry) is the natural follow-up to 064e's "gated on canary + smoke health."
- [ ] **Dashboard surfaces.** Render `needs-attention.json` as a health banner in the daemon dashboard, and add the telemetry/auto-update toggles (OD-5 said these live in the dashboard; env opt-outs work, the UI does not exist yet).
- [ ] **064h live verification.** The daemon-as-OS-native change shipped as code; run a real macOS+Linux+Windows smoke before relying on it, and wire `daemon-service unregister` into an uninstall verb.
- [ ] **Cross-platform dogfood.** Everything is unit-tested across OSes in CI, but only the Windows path has touched a real machine (install + status + diagnose verified live). Exercise install-service + a real heal cycle on each OS.
- [ ] **Aikido disposition.** Confirm the 4 CRITICAL Aikido findings that were merged past (PR #159) were triaged/suppressed with the rationale in `qa/prd-064-aikido-triage.md`, so the security record is clean.

---

## Related

- [`prd-064-doctor-self-healing-watchdog`](../../completed/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md) - the package this activates; 064e (auto-update + blessed gate), 064b (installer hooks), 064d (telemetry).
- `.github/workflows/deploy-install-site.yaml` - the Cloudflare Pages deploy that publishes get.theapiary.sh.
- `site/install/build.mjs`, `site/install/_headers` - the install-surface build (now emits the blessed channel).
- `doctor/src/update/blessed-channel.ts` - the client that fetches `https://get.theapiary.sh/blessed-version.json` (fail-closed).
