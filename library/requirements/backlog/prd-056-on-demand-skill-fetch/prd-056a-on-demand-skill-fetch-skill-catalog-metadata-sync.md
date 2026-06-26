# PRD-056a: Skill Catalog Metadata Sync

> **Parent:** [PRD-056](./prd-056-on-demand-skill-fetch-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Goals

Provide a Level-1 catalog: sync only skill metadata (`name`, `author`, `description`, `triggerText`) into context, never bodies, so an agent knows what skills exist and when to use them at near-zero token cost.

## Scope

- A `GET /api/skills/catalog` read endpoint returning metadata-only rows (no `body`) for the org.
- The client-side catalog assembly that holds these rows in context.
- Highest-version-per-skill selection so the catalog never shows stale duplicates.

## Out of scope

- Fetching bodies (PRD-056b) and the mode switch (PRD-056c).

---

## User stories and acceptance criteria

### US-056a.1 - Metadata-only catalog

- AC-056a.1.1 Given lazy mode, when the catalog syncs, then rows contain `name`/`author`/`description`/`triggerText` and never `body`.
- AC-056a.1.2 Given a skill with multiple versions, when the catalog lists it, then only the highest-version metadata appears.

### US-056a.2 - Scoped and cheap

- AC-056a.2.1 Given a caller in org X, when the catalog is read, then only org-X skills appear, via the same scope resolution as `GET /api/skills`.
- AC-056a.2.2 Given the catalog read, when measured, then payload size is bounded by metadata, not body size.

---

## Technical considerations

- Reuse the existing versioned read; project to metadata columns only (drop `body`) so the wire payload is small.
- Mount on the protected `/api/skills` group beside the existing read and publish/pull verbs, no collision.
- Poll-until-converged read discipline applies, as with every live Deep Lake read-back.

## Evaluation and study of other codebases

- **Prior art:** Agent Skills Level-1 metadata (`name`+`description` always loaded, ~100 tokens/skill); Tool Search Tool's deferred-definitions model.
- **Pattern (MIT, Go):** skillshare keeps a single source of truth and lists/syncs without copying bodies eagerly; its `list`/`diff` surface is the catalog analogue.

## Files touched (anticipated)

- New: a `catalog` read in `src/daemon/runtime/product/api.ts` (or a sibling), client catalog assembly under `src/daemon-client/skillify/`. Tests for metadata-only projection and scope.

## Test plan

- Route: catalog excludes `body` (AC-056a.1.1); highest-version only (AC-056a.1.2); org-scoped (AC-056a.2.1).

## Open questions

- [ ] Catalog cache TTL on the client between session starts.
