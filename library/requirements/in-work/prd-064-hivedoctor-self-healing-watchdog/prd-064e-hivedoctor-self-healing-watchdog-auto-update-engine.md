# PRD-064e: HiveDoctor - Auto-Update Engine

> **Parent:** [PRD-064](./prd-064-hivedoctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)

---

## Goals

Keep the primary daemon current automatically and safely, so users stop running stale builds with already-fixed bugs - without letting one bad publish brick the fleet.

- Poll the npm registry for `@legioncodeinc/honeycomb@latest` on a **30-minute TTL**.
- Auto-update the primary daemon when a new version is available **and blessed** (opt-out via `--no-auto-update` / env).
- Verify `/health` after the update; **roll back** to the prior version on a failed verify.
- Never touch HiveDoctor's own package here - that is explicit-only ([064f](./prd-064f-hivedoctor-self-healing-watchdog-cli-and-ux.md)).

## Scope

- The 30-min poll (jittered to avoid a thundering herd against npm/our gate).
- The **blessed-version gate** (OD-3, resolved): before installing `@latest`, fetch `blessed-version.json` from the install CDN (`get.theapiary.sh`) that names the version approved for auto-rollout. `@latest` on npm is necessary but not sufficient. The file is flipped by a CI "bless" step gated on canary + smoke health. Fail-closed: if the file is unreachable or unparseable, stay on the current version.
- The update transaction: record current version, `npm i -g @legioncodeinc/honeycomb@<blessed>`, restart via the 064a restart path, poll `/health`.
- Rollback: on failed post-update `/health`, reinstall the recorded prior version and restart; emit a telemetry event either way.
- Opt-out + pinning: `--no-auto-update`, env toggle, and an optional pinned version that disables forward updates.

## Out of scope

- Reinstall-as-repair (same npm primitive, different intent) - [064c](./prd-064c-hivedoctor-self-healing-watchdog-remediation-ladder.md) rung 2.
- HiveDoctor self-update - [064f](./prd-064f-hivedoctor-self-healing-watchdog-cli-and-ux.md).

## Acceptance criteria

- AC-064e.1 Given a blessed version newer than installed, when the poll fires and auto-update is on, then the daemon is updated to the blessed version within ~30 min.
- AC-064e.2 Given npm `@latest` is newer but NOT blessed, when the poll fires, then HiveDoctor does NOT update (gate holds).
- AC-064e.3 Given an update whose post-update `/health` fails, when verify fails, then HiveDoctor rolls back to the prior version and the daemon returns to healthy on the old version.
- AC-064e.4 Given `--no-auto-update` or a pinned version, when a newer blessed version exists, then no update occurs.
- AC-064e.5 Given any update or rollback, when it completes, then a telemetry event records from-version, to-version, and outcome.
- AC-064e.6 Given an update is in progress, when the watch loop also wants to act, then they are serialized (no concurrent npm installs / restarts).

## Technical considerations

- **The gate is the safety, not the TTL.** A 30-min poll against raw `@latest` would propagate a bad publish fleet-wide in 30 min; the blessed channel (`blessed-version.json` on the install CDN) is what makes auto-update safe. Mandatory, and fail-closed.
- **Atomicity:** global npm installs are not transactional; the prior version + a verify+rollback loop is how we approximate atomicity.
- **Coordination with rung 2:** auto-update and reinstall-as-repair must not run concurrently; share a single "install lock" in HiveDoctor.
- **Our release process gains a "bless" step:** publishing to npm and blessing for auto-rollout become two actions (could be gated on canary/smoke health).

## Open questions

- [ ] `blessed-version.json` schema (single version string vs min/max range vs per-channel) and cache-control headers on the CDN object.
- [ ] Whether the CI "bless" step is fully automatic (canary green → bless) or requires a human gate.

> OD-3 is resolved in the parent index: on-by-default, blessed gate via install-CDN static JSON, verify + rollback, fail-closed.
