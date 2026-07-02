# PRD-052: Join Repository to Hive

> **Status:** Backlog (sequenced after [PRD-051](../prd-051-repository-health-and-knowledge-drift/prd-051-repository-health-and-knowledge-drift-index.md); diagnose first, then invite)
> **Priority:** P2
> **Effort:** L (1-3d)
> **Schema changes:** None to the DeepLake catalog. Writes are confined to a new `library/` tree and harness asset folders in the user's repo, all opt-in, idempotent, and reversible.

---

## Overview

PRD-051 lets a user *see* that their repo has knowledge drift and un-mined sessions. This module is the invitation that follows the diagnosis: a **non-destructive "Join Repository to Hive"** action that scaffolds the workflow which keeps those signals green. It is the bridge from "Honeycomb remembers things for me" to "Honeycomb gives me a way to keep my repo's knowledge alive."

The deliverable is a guided join flow (CLI verb plus a dashboard affordance) that, on explicit consent, does four things, every one of them additive and reversible:

1. **Scaffolds a blank, README-only `library/`** in the user's repo (the same canonical tree this repo uses: `requirements/`, `issues/`, `knowledge/`, `notes/`, `reports/`), seeded only with READMEs that explain each folder. No content, no PRDs, no opinions about their code.
2. **Provisions a minimal, harness-appropriate asset set** (the one or two commands that matter on day one, not the whole Bee Army) for whichever harness the user actually runs, using the existing harness detection + asset-install registry ([`harness-detect.ts`](../../../../src/daemon/runtime/dashboard/harness-detect.ts), [`harness-registry.ts`](../../../../src/daemon/runtime/dashboard/harness-registry.ts), [`installed-assets.ts`](../../../../src/daemon/runtime/dashboard/installed-assets.ts), [`asset-install-target.ts`](../../../../src/daemon/runtime/dashboard/asset-install-target.ts)).
3. **Explains the workflow**: a short, generated onboarding doc (and dashboard panel) covering what the `library/` folders are for, what the provisioned commands do, and *why* `/library-stinger` and `/knowledge-stinger` exist, written for someone who has never seen the Bee Army.
4. **Hands over a copy-paste prompt** the user can drop into their agent to run `/knowledge-stinger` against their first real change, so the very first thing they do produces a knowledge doc and turns a drift signal green.

The governing constraint is **progressive disclosure**. The internal version of this repo holds 60+ Stingers and a full multi-agent SDLC; dropping that on a new user is the fastest way to an uninstall. Join-to-Hive reveals exactly one workflow loop (capture knowledge -> see drift go green) and lets the rest earn its way in later.

Two principles:

> **Principle 1 (non-destructive, visibly):** every write is opt-in per artifact, namespaced under `library/` or the harness's own asset folder, shown in a dry-run before it lands, idempotent (re-running never clobbers user edits), and removable by a clean uninstall. Joining hive must never feel like the tool took over the repo.
> **Principle 2 (value before methodology):** the join flow is offered *after* PRD-051 has already shown the user a real signal. We never ask for the workflow change before the user has seen the payoff.

The three sub-PRDs cover the non-destructive `library/` scaffold, the harness-appropriate asset provisioning with dry-run and uninstall, and the onboarding explainer plus the copy-paste `/knowledge-stinger` prompt.

---

## Goals

- A **"Join Repository to Hive"** flow, invokable from a CLI verb and from a dashboard affordance, gated behind an explicit consent step that shows exactly what will be written.
- **Non-destructive library scaffold:** create the canonical `library/` tree as README-only, using a no-clobber copy so an existing `library/` (or any user file) is never overwritten; re-running is a safe no-op for already-present files.
- **Harness-appropriate, minimal asset provisioning:** detect the user's harness and install a deliberately small starter set (the commands that drive the day-one loop), through the existing asset-install registry, with the same no-clobber + reversible posture.
- **A generated onboarding explainer** (doc + dashboard panel) that teaches the folders, the starter commands, and the rationale for `/library-stinger` and `/knowledge-stinger`, pitched at a first-time user.
- **A copy-paste agent prompt** for `/knowledge-stinger` that the user can run immediately to produce their first knowledge doc.
- A **dry-run** mode that lists every path that would be created or modified, and a **clean uninstall** that removes exactly what the join added (and only that), confirmable by the user.

## Non-Goals

- **Installing the full Bee Army / every Stinger.** v1 provisions a minimal starter set only. Bulk asset installation and the full roster are a later, opt-in step, not part of joining.
- **Computing health signals.** That is [PRD-051](../prd-051-repository-health-and-knowledge-drift/prd-051-repository-health-and-knowledge-drift-index.md). This module consumes the *fact that* drift exists to motivate the invite; it does not compute it.
- **Firing reminders / nudges.** The post-PRD "now run /knowledge-stinger" coaching loop is [PRD-053](../prd-053-coaching-and-reminder-loop/prd-053-coaching-and-reminder-loop-index.md).
- **All six harnesses at parity on day one.** Start with the harness(es) where the starter asset set can be kept honest; widen coverage as parity is proven. Harness wiring mechanics are owned by the harness-integration work, reused here.
- **Authoring real PRDs or knowledge docs for the user.** The scaffold is blank by design; content is the user's (helped by the provided `/knowledge-stinger` prompt).
- **A remote/hosted component.** The flow runs locally through the existing daemon + CLI; no new bind, no new auth surface.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-052a-…-non-destructive-library-scaffold`](./prd-052a-join-repository-to-hive-non-destructive-library-scaffold.md) | Create the canonical README-only `library/` tree in the user's repo via an idempotent, no-clobber copy; dry-run preview; never overwrite user files. | Draft |
| [`prd-052b-…-harness-asset-provisioning`](./prd-052b-join-repository-to-hive-harness-asset-provisioning.md) | Detect the user's harness and install a minimal starter command set through the existing asset-install registry, with dry-run and a clean, scoped uninstall. | Draft |
| [`prd-052c-…-onboarding-explainer-and-prompt`](./prd-052c-join-repository-to-hive-onboarding-explainer-and-prompt.md) | Generate the first-time onboarding explainer (doc + dashboard panel) and the copy-paste `/knowledge-stinger` prompt; progressive-disclosure framing. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | A "Join Repository to Hive" action is available from both the CLI and the dashboard; invoking it shows an explicit, itemized **dry-run** of every path it would create or modify and requires confirmation before any write. |
| AC-2 | Joining scaffolds the canonical `library/` tree as **README-only** (no PRDs, no knowledge content) using a no-clobber copy; an existing `library/` or any user file in the way is preserved untouched, and re-running join is a safe no-op for present files. |
| AC-3 | Joining detects the user's harness and installs a **minimal starter asset set** (not the full roster) through the existing asset-install registry, with the same no-clobber posture. |
| AC-4 | The join produces an **onboarding explainer** (a doc plus a dashboard panel) covering the folders, the starter commands, and the rationale for `/library-stinger` and `/knowledge-stinger`, readable by someone new to the Bee Army. |
| AC-5 | The join surfaces a **copy-paste prompt** that, pasted into the user's agent, runs `/knowledge-stinger` to produce their first knowledge doc. |
| AC-6 | A **clean uninstall** removes exactly the artifacts the join added (scaffold READMEs it created, starter assets it installed) and nothing the user authored; a test asserts a join-then-uninstall leaves the repo byte-identical to its pre-join state aside from intentionally user-created content. |
| AC-7 | The whole flow is **idempotent and reversible**: join, edit a file, re-join, uninstall, and the user's edits are never lost or clobbered at any step. |
| AC-8 | No write occurs outside `library/` and the detected harness's own asset folder; a test asserts the write set is confined to those namespaces. |

---

## Data model changes

**No DeepLake catalog changes.** Writes are filesystem-only and confined to the user's repo:

- **`library/` tree (new, README-only):** the canonical folder set seeded from templates via no-clobber copy. Mirrors the structure this repo uses (`requirements/{backlog,in-work,completed}`, `issues/{backlog,completed}`, `knowledge/{public,private}`, `notes/`, `reports/`), each with an explanatory README and nothing else.
- **Harness asset folder (additive):** the minimal starter command set written into the detected harness's convention location, tracked through the existing [`installed-assets.ts`](../../../../src/daemon/runtime/dashboard/installed-assets.ts) registry so uninstall knows exactly what it placed.
- **A local join manifest:** a small machine-local record (under the runtime dir) of what the join created/installed for this repo, so uninstall is exact and idempotency is provable. Carries no secret; deletable.

---

## API changes

All local; no new external surface:

- **CLI:** a `honeycomb join` verb (name TBD in 052a) with `--dry-run` and an `--uninstall` counterpart, composing the existing setup/asset-install engine.
- **Daemon (loopback, local-mode-only):** a small set of endpoints beside the dashboard host group to drive the dashboard affordance: `GET /join/plan?project=<id>` (the dry-run plan), `POST /join/apply?project=<id>` (perform the scaffold + starter-asset install after consent), `POST /join/uninstall?project=<id>`. These reuse the harness-detect + asset-install registry already mounted in the dashboard runtime.
- No outbound network calls beyond what the existing asset-install path already does.

---

## Open questions

- [ ] **Verb + affordance naming:** `honeycomb join`, `honeycomb hive join`, or fold into `honeycomb setup`? And what the dashboard CTA reads as ("Join to Hive" vs "Set up workflow").
- [ ] **Starter asset set contents:** which one or two commands ship on day one. Strong candidate: a `/knowledge-stinger`-equivalent (the loop that turns a change into a knowledge doc and clears drift), plus possibly `/library-stinger`. The full roster is deferred.
- [ ] **Harness coverage order:** which harness(es) get parity first; how to message "your harness is not yet supported for asset provisioning" while still offering the scaffold + explainer.
- [ ] **Scaffold scope toggles:** does the user pick which `library/` subtrees to create, or is it all-or-nothing README-only? Lean: all-or-nothing README-only is simplest and lowest-risk (READMEs are cheap and explanatory).
- [ ] **Uninstall of user-touched scaffold:** if the user edited a scaffolded README, does uninstall remove it, keep it, or prompt? Lean: keep anything the user modified; only remove pristine artifacts the join created.
- [ ] **Relationship to PRD-051's page:** is "Join to Hive" a CTA on the Repository Health page, a separate onboarding flow, or both? Lean: a CTA on the health page once a signal is shown (value-before-methodology), plus a CLI entry point.
- [ ] **Monorepo / nested repos:** where does `library/` land in a monorepo, and does join operate per-package or per-repo?

---

## Related

- [PRD-051: Repository Health and Knowledge Drift](../prd-051-repository-health-and-knowledge-drift/prd-051-repository-health-and-knowledge-drift-index.md) — the diagnosis this invite follows; its health page is the likely host for the join CTA.
- [PRD-019: Harness Integrations](../../in-work/prd-019-harness-integrations/prd-019-harness-integrations-index.md) and the harness-integration work — the detection + wiring mechanics reused here.
- [PRD-036: Skill/Asset Discovery](../../completed/prd-036-skill-asset-discovery/prd-036-skill-asset-discovery-index.md) and [`installed-assets.ts`](../../../../src/daemon/runtime/dashboard/installed-assets.ts) / [`harness-registry.ts`](../../../../src/daemon/runtime/dashboard/harness-registry.ts) — the asset-install registry the starter provisioning runs through.
- [PRD-039: Harnesses Page](../../completed/prd-039-harnesses-page/prd-039-harnesses-page-index.md) — the dashboard surface that already renders harness/asset state, a likely home for the join affordance.
- [PRD-050: Quick Install and Guided Setup](../../completed/prd-050-quick-install-and-guided-setup/prd-050-quick-install-and-guided-setup-index.md) — the no-clobber, idempotent, plain-language setup posture this module mirrors.
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md) — the propagation model the deferred full-roster install would later use.
- Successor: [PRD-053: Coaching and Reminder Loop](../prd-053-coaching-and-reminder-loop/prd-053-coaching-and-reminder-loop-index.md) — the nudges that keep a joined repo's knowledge fresh.
