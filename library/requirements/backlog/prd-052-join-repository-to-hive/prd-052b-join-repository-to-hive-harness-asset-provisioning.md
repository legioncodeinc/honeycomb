# PRD-052b: Harness Asset Provisioning

> **Parent:** [PRD-052](./prd-052-join-repository-to-hive-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (1-2d)
> **Schema changes:** None. Additive writes to the detected harness's asset folder, tracked by the existing installed-assets registry.

---

## Overview

On join, detect which harness the user actually runs and install a **deliberately minimal** starter command set into that harness's convention location, through the asset-install registry the daemon already has ([`harness-detect.ts`](../../../../src/daemon/runtime/dashboard/harness-detect.ts), [`harness-registry.ts`](../../../../src/daemon/runtime/dashboard/harness-registry.ts), [`installed-assets.ts`](../../../../src/daemon/runtime/dashboard/installed-assets.ts), [`asset-install-target.ts`](../../../../src/daemon/runtime/dashboard/asset-install-target.ts)). The whole point is restraint: one or two commands that drive the day-one loop, not the 60-Stinger army. The full roster is a later, opt-in step.

## Goals

- **Detect the harness** via the existing detection path and resolve its asset-install target.
- Install a **minimal starter set** (the commands that make the capture-knowledge -> clear-drift loop work; exact contents are a parent open question) using the existing registry, with a **no-clobber** posture so a user's existing same-named asset is never overwritten.
- Track every installed asset in the **join manifest** + the installed-assets registry so uninstall is exact and scoped.
- Provide a **dry-run** contribution (which assets, to which paths, for which harness) to the parent plan.
- Degrade honestly when the harness is unknown or unsupported for provisioning: skip asset install, still let the scaffold (052a) and explainer (052c) proceed, and say so plainly.

## Non-Goals

- The library scaffold (052a) or the explainer/prompt (052c).
- Installing the full Stinger roster or any bulk asset set.
- Re-architecting harness wiring; this reuses the existing registry and detection.
- Parity across all six harnesses on day one (start where parity is honest).

## User stories

- As a Claude Code user, joining drops in the one or two commands I need to start the loop, and nothing else clutters my setup.
- As a user on an unsupported harness, joining still scaffolds my `library/` and explains the workflow, and clearly tells me asset provisioning is not yet available for my harness instead of failing.
- As any user, uninstalling join removes exactly the assets it added and leaves my own commands alone.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Join detects the user's harness through the existing detection path and resolves the correct asset-install target. |
| b-AC-2 | Join installs only the minimal starter set (asserted against an explicit allow-list of starter assets), not the full roster. |
| b-AC-3 | Installation is no-clobber: a pre-existing user asset at a target path is preserved; a test asserts it is untouched. |
| b-AC-4 | Every installed asset is recorded in the manifest + installed-assets registry; uninstall removes exactly those and only those. |
| b-AC-5 | On an unknown/unsupported harness, asset provisioning is skipped cleanly with a plain-language message, and the rest of the join (scaffold + explainer) still completes. |
| b-AC-6 | The dry-run plan accurately lists the assets and paths that would be installed for the detected harness. |

## Implementation notes

- Reuse [`harness-detect.ts`](../../../../src/daemon/runtime/dashboard/harness-detect.ts) for detection and [`asset-install-target.ts`](../../../../src/daemon/runtime/dashboard/asset-install-target.ts) for path resolution; do not hand-roll harness path logic.
- Define the starter set as an explicit, small allow-list so "minimal" is enforced in code and testable, and so widening it later is a deliberate change.
- Thread installs through [`installed-assets.ts`](../../../../src/daemon/runtime/dashboard/installed-assets.ts) so the existing Harnesses page and uninstall already understand the state.
- The unsupported-harness path must be a graceful skip, never a hard failure of the whole join.

## Open questions

- [ ] The exact starter allow-list (ties to the parent's "starter asset set" question).
- [ ] Harness coverage order for provisioning parity.
- [ ] Whether provisioned starter assets should be version-stamped so a later "update my assets" flow can reconcile them.

## Related

- [`src/daemon/runtime/dashboard/harness-detect.ts`](../../../../src/daemon/runtime/dashboard/harness-detect.ts), [`harness-registry.ts`](../../../../src/daemon/runtime/dashboard/harness-registry.ts), [`installed-assets.ts`](../../../../src/daemon/runtime/dashboard/installed-assets.ts), [`asset-install-target.ts`](../../../../src/daemon/runtime/dashboard/asset-install-target.ts) — the detection + install registry reused here.
- [PRD-036: Skill/Asset Discovery](../../completed/prd-036-skill-asset-discovery/prd-036-skill-asset-discovery-index.md) and [PRD-039: Harnesses Page](../../completed/prd-039-harnesses-page/prd-039-harnesses-page-index.md) — the asset state model + surface.
- Sibling sub-PRDs: [052a non-destructive library scaffold](./prd-052a-join-repository-to-hive-non-destructive-library-scaffold.md), [052c onboarding explainer and prompt](./prd-052c-join-repository-to-hive-onboarding-explainer-and-prompt.md).
