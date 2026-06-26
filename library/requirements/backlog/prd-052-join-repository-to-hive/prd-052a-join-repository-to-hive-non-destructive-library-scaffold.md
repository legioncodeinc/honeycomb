# PRD-052a: Non-Destructive Library Scaffold

> **Parent:** [PRD-052](./prd-052-join-repository-to-hive-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S (< 1d)
> **Schema changes:** None. Filesystem-only writes confined to a new `library/` tree.

---

## Overview

Create the canonical `library/` tree in the user's repository as a **README-only** scaffold: every folder this repo uses, each with a short explanatory README, and nothing else. No PRDs, no knowledge docs, no opinions about the user's code. The scaffold is the empty shelving; the user (helped by 052c's prompt and the Stingers) fills it.

The entire value of this sub-PRD is in the word **non-destructive**. It must be impossible for joining to clobber a user's existing file, and re-running must be a safe no-op for anything already present.

## Goals

- Create the canonical tree: `library/requirements/{backlog,in-work,completed}`, `library/issues/{backlog,completed}`, `library/knowledge/{public,private}`, `library/notes/`, `library/requirements/reports/`, each seeded with a README that explains the folder's purpose and the schema-v2 path conventions.
- Use a **no-clobber copy** (idempotent): existing files are preserved; only missing files are written; re-running join never overwrites or deletes.
- Produce a **dry-run plan** listing every path that would be created, so the parent flow can show it before any write.
- Record what was created in the local **join manifest** so uninstall is exact.
- Honor the `notes/` protection convention (seed its README, but mark it human-only).

## Non-Goals

- Installing harness assets (052b) or writing the onboarding explainer / prompt (052c).
- Seeding any content beyond folder READMEs.
- Migrating or reformatting an existing `library/` (if one exists, it is left as-is; join only fills gaps).

## User stories

- As a new user, joining gives me a clean, self-documenting `library/` I can start filling, and I can see exactly what it created.
- As a user who already has a `library/`, joining never touches my existing files; it only adds any missing standard folders/READMEs, and tells me it did so.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Join creates the full canonical `library/` tree with an explanatory README in each folder and no other content. |
| a-AC-2 | The copy is no-clobber: a pre-existing file at any target path is preserved unchanged; a test places a sentinel file and asserts join does not modify it. |
| a-AC-3 | Re-running join after a complete scaffold is a no-op (no writes, no errors); a test asserts an unchanged working tree on the second run. |
| a-AC-4 | The dry-run plan enumerates exactly the paths that would be created on a given repo state, matching what apply then creates. |
| a-AC-5 | The join manifest records every path this sub-PRD created, sufficient for an exact uninstall. |
| a-AC-6 | `notes/` is seeded with a README that marks it human-only, consistent with the library convention. |

## Implementation notes

- Mirror the no-clobber seeding pattern the library tooling already uses (`cp -n`-style idempotent copy); the templates are the canonical READMEs.
- Derive the target tree from the schema-v2 conventions (the same structure this repo is on), not the legacy v1 layout.
- The dry-run is just the diff between the desired tree and what exists; compute it without writing.
- Keep the scaffold content generic and repo-agnostic (placeholder project name), since this runs in an arbitrary user repo.

## Open questions

- [ ] Whether to scaffold `public/` knowledge by default or only `private/` (lean: both, with READMEs explaining the audience split).
- [ ] Monorepo placement (repo root vs per-package) — coordinate with the parent's monorepo open question.
- [ ] Whether to add a top-level `library/README.md` index (lean: yes, it is the map).

## Related

- [PRD-052 index](./prd-052-join-repository-to-hive-index.md) — parent flow, dry-run + manifest + uninstall contract.
- [PRD-050: Quick Install](../../completed/prd-050-quick-install-and-guided-setup/prd-050-quick-install-and-guided-setup-index.md) — the no-clobber, idempotent posture mirrored here.
- Sibling sub-PRDs: [052b harness asset provisioning](./prd-052b-join-repository-to-hive-harness-asset-provisioning.md), [052c onboarding explainer and prompt](./prd-052c-join-repository-to-hive-onboarding-explainer-and-prompt.md).
