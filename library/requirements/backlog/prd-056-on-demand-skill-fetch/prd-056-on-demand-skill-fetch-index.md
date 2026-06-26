# PRD-056: On-Demand Skill Fetch (Progressive Disclosure Hybrid)

> **Status:** Backlog
> **Priority:** P2
> **Effort:** L (1-3d)
> **Schema changes:** None (the `skills` table already separates metadata from body)

---

## Overview

Today Honeycomb distributes skills **eagerly**: on every `SessionStart` the auto-pull selects all newer team skills and writes plus symlinks them into every agent root (see [`team-skills-sharing.md`](../../../knowledge/private/collaboration/team-skills-sharing.md)). For a single developer with a few dozen skills this is correct and cheap. For a fleet of many ephemeral sub-agents it is worth offering the **lazy** alternative the ecosystem has converged on: keep a lightweight catalog in context and fetch a skill's body only when it is actually needed.

This PRD adds lazy fetch as a **hybrid alongside** eager pull, not a replacement. It is Anthropic's progressive disclosure applied to the team catalog, and it maps onto the existing schema with no migration, because the `skills` table already stores `name`/`author`/`description`/`triggerText` separately from `body`.

Source of truth: [`fleet-observation-and-on-demand-skills.md`](../../../knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md).

---

## Goals

- A **metadata-only catalog sync** that brings just `name`/`author`/`description`/`triggerText` into context (Level 1), not full bodies.
- A **lazy body-fetch** path that retrieves a single skill's `body` by `(name, author)` at the highest version only when it triggers (Level 2).
- A **mode switch** so a workspace runs eager (default) or lazy, with a threshold that flips to lazy once the catalog grows past the accuracy band.
- No regression to today's eager auto-pull when lazy is off.

## Non-Goals

- Removing or weakening eager auto-pull. It stays the default.
- The fleet control plane (PRD-054, PRD-055). This PRD is independent of those.
- A new skills table or embedding change (the existing table and recall path are reused).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-056a-skill-catalog-metadata-sync`](./prd-056a-on-demand-skill-fetch-skill-catalog-metadata-sync.md) | Sync metadata-only catalog rows (no body) for the in-context Level-1 table | Draft |
| [`prd-056b-lazy-body-fetch`](./prd-056b-on-demand-skill-fetch-lazy-body-fetch.md) | Fetch one skill's body by `(name, author)` @ latest, on trigger | Draft |
| [`prd-056c-eager-lazy-mode-switch`](./prd-056c-on-demand-skill-fetch-eager-lazy-mode-switch.md) | The eager/lazy mode config + threshold to flip, default eager | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given lazy mode, when a session starts, then only skill metadata (no bodies) is synced into the catalog, and no bodies are written to disk up front. |
| AC-2 | Given a skill triggers in lazy mode, when its body is needed, then exactly that one body is fetched at its highest version, with poll-until-converged read discipline. |
| AC-3 | Given eager mode (default), when a session starts, then behaviour is identical to today's auto-pull (no regression). |
| AC-4 | Given a workspace catalog larger than the configured threshold, when mode is auto, then it flips to lazy and logs the switch. |
| AC-5 | Given a body fetch in lazy mode, when scope is resolved, then it stays inside the caller's org partition exactly as the existing skills read does. |

---

## Data model changes

None. The `skills` table already separates the Level-1 metadata columns (`name`, `author`, `description`, `triggerText`) from the Level-2 `body`, confirmed in the publish schema in [`propagation-api.ts`](../../../../src/daemon/runtime/skillify/propagation-api.ts). Lazy mode is a query shape, not a schema change.

---

## API changes

- `GET /api/skills/catalog` (org-scoped, read-only): returns metadata rows only (no `body`) for the Level-1 catalog.
- `GET /api/skills/:author/:name/body` (org-scoped, read-only): returns the single highest-version `body` for one skill (Level-2 lazy fetch).

Both mount on the already-protected `/api/skills` group beside the existing `GET /api/skills` (`mountSkillsReadApi`) and the publish/pull verbs, with no route collision and the same tenancy resolution.

---

## Evaluation and study of other codebases

Fold rule: **MIT code only**; Apache-2.0 and AGPL study-only. Verified June 2026.

**Prior art that defines the pattern (specs/docs, not code to vendor):**
- Anthropic Agent Skills **progressive disclosure**: Level 1 metadata (`name`+`description`, ~100 tokens/skill) always loaded, Level 2 body on trigger, Level 3 resources on demand. This is the exact three-level model AC-1/AC-2 implement.
- Anthropic **Tool Search Tool** (`defer_loading`, search catalog, load 3-5 relevant): ~85% context savings, and the finding that tool/skill selection accuracy degrades past 30-50 simultaneously loaded items, the basis for the threshold in PRD-056c.
- MCP client progressive-discovery guidance: switch from eager load to lazy past ~1-5% of the context window.

**Pattern (MIT, Go, repurpose not vendor):**
- [`runkids/skillshare`](https://github.com/runkids/skillshare) (MIT, ~2.3k stars) is a single-source-of-truth skill sync across 60+ CLIs that we mirror conceptually. Three repurposable ideas beyond our current propagation: **security-audit-on-install** (scan a skill for prompt-injection / data-exfiltration before use), **bidirectional collect** (edits in a target flow back to source), and **Windows NTFS junctions** for linking where our POSIX-symlink fan-out fails (directly relevant given Honeycomb's heavy Windows footprint). Go, so we repurpose the design, not the code.

**Study only (AGPL, ideas free):**
- [`plastic-labs/honcho`](https://github.com/plastic-labs/honcho) (AGPL-3.0): its split between cheap always-available representations and deeper on-query reasoning, plus async batch processing (~1000-token batches), is the same metadata-cheap / body-on-demand economics. Study the model; never vendor the code.

**Our own code reused:** the versioned read (`selectNewerForOrgUsers` behind `GET /api/skills`), the publish schema's metadata/body split ([`propagation-api.ts`](../../../../src/daemon/runtime/skillify/propagation-api.ts)), the auto-pull seam ([`daemon-client/skillify/index.ts`](../../../../src/daemon-client/skillify/index.js)), and the eventual-consistency poll-until-converged read rule.

---

## Open questions

- [ ] Trigger surface: does the agent decide to fetch a body from the catalog `description` (pure progressive disclosure, matches Agent Skills), or does the daemon push a fetch when it detects a `triggerText` match (logic stays daemon-side)?
- [ ] Should lazy mode also adopt skillshare's security-audit-on-install scan as a gate before a fetched body is written?
- [ ] Catalog freshness: re-sync metadata on every session start (cheap) or on a `list_changed`-style signal?

---

## Related

- [`team-skills-sharing.md`](../../../knowledge/private/collaboration/team-skills-sharing.md) - the eager model this augments.
- [`fleet-observation-and-on-demand-skills.md`](../../../knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md) - design source of truth.
- [`ai/skillify-pipeline.md`](../../../knowledge/private/ai/skillify-pipeline.md), [`ai/retrieval.md`](../../../knowledge/private/ai/retrieval.md).
