# PRD-051: Memory Graph → Obsidian Vault

> **Status:** Backlog
> **Priority:** P2
> **Effort:** L
> **Schema changes:** None (reads the existing PRD-008 ontology tables; writes LOCAL files only)
> **Owner:** unassigned

---

## Overview

Honeycomb's **memory graph** — the knowledge graph of entities and relations the PRD-008 ontology
accumulates from captured work (`entities` + `entity_dependencies`, served today by
`fetchMemoryGraphView` at `GET /api/diagnostics/memory-graph`, `src/daemon/runtime/dashboard/api.ts`)
— is the product's unique, compounding asset. Today the only way to see it is the minimal in-app SVG
canvas on the `#/graph` page (PRD-041b), which the recent memory-aware graph cap made survivable but
which is still a thumbnail: no backlinks, no notes, no search, no place to *think in*.

Obsidian is the mature home for exactly this shape of data: one note per concept, `[[wikilinks]]` for
relations, a real force-directed graph view, backlinks, and a deep plugin ecosystem — all over plain
Markdown files the user owns. This PRD exports the memory graph into an **Obsidian-compatible Markdown
vault** (one note per entity, wikilinks for relations) written to a stable local directory, adds an
**"Open in Obsidian"** affordance on the dashboard that deep-links straight into that vault via the
core `obsidian://` URI scheme, and scopes out the optional plugin/continuous-sync enhancements so v1
stays plugin-free and on-demand.

This is a follow-up in the graph lineage (PRD-041 graph page → the memory-aware graph cap). Where the
cap solved *"the in-app canvas cannot render a large graph"*, this PRD answers the user's real
question — *"what do I actually DO with the graph?"* — by handing the graph to a tool built to explore
it. Notably, the SVG-render cap does **not** apply here: Obsidian handles large vaults natively, so the
export is unbounded by design (see 051a).

## Goals

- Export the memory graph to a **plain-Markdown Obsidian vault** — one note per `entity`, relations as
  `[[wikilinks]]` carrying the edge type + reason — that opens correctly in a stock Obsidian install
  with **no plugin required**.
- Write the vault to a **stable, per-scope canonical location** so "Open in Obsidian" always targets the
  same place and Obsidian needs registering only once.
- Add a dashboard **"Open in Obsidian"** action that exports (or refreshes) the vault and deep-links into
  it via `obsidian://`, with an honest fallback when Obsidian is not installed/registered.
- Keep the LOCAL-mode-only, no-secret-in-output, daemon-owns-the-filesystem security posture, and make
  the writer XSS-/path-traversal-safe for untrusted entity text.
- Decide on-demand vs. continuous export for v1 (decision: **on-demand**), and document the optional
  Obsidian-plugin enhancements as a clear-eyed future layer rather than v1 scope.

## Non-Goals

- Building or changing the PRD-008 ontology itself (entities, dependencies, supersession, the
  `/api/ontology/*` surface, the pollinating writer). This PRD **reads** that graph; it never authors it.
- Exporting the **codebase** graph to a vault. The writer is built source-agnostic (051a OQ), but the
  codebase-graph vault is out of scope for v1 — the memory graph is the high-value, unique target.
- Bundling, installing, or requiring any Obsidian community plugin. v1 is stock-Obsidian-only; plugins
  are an explicitly optional, future layer (051c).
- Two-way sync / writing the user's Obsidian edits back into the ontology. The vault is a **derived,
  read-only projection** — re-export overwrites it; user edits are not ingested.
- Continuous/watched re-export on every pollinate convergence (051c open question; v1 is on-demand).
- A hosted/cloud vault or any network publish. The vault is a local-filesystem artifact only.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-051a-…-markdown-export`](./prd-051a-memory-graph-obsidian-vault-markdown-export.md) | The export engine: ontology → Markdown vault (notes + wikilinks + frontmatter), canonical vault dir, CLI + daemon endpoint, safety. | Draft |
| [`prd-051b-…-open-in-obsidian`](./prd-051b-memory-graph-obsidian-vault-open-in-obsidian.md) | The dashboard "Open in Obsidian" deep-link via the `obsidian://` URI scheme, vault registration UX, and the not-installed fallback. | Draft |
| [`prd-051c-…-plugins-and-sync`](./prd-051c-memory-graph-obsidian-vault-plugins-and-sync.md) | Exploration: optional Obsidian-plugin enhancements (Dataview/Juggl/Breadcrumbs/Advanced URI/bespoke) + continuous/watched export. Open-questions, not v1. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a populated memory graph, when the user runs the export, then a valid Obsidian vault exists at the canonical per-scope path with one Markdown note per entity and `[[wikilinks]]` between related entities, openable in stock Obsidian with no plugin. |
| AC-2 | Given a vault has been exported, when the user clicks "Open in Obsidian" on the dashboard, then Obsidian launches focused on that vault (or shows the honest fallback when Obsidian is not installed/registered). |
| AC-3 | Given an empty memory graph (`built:false`), when the user attempts to export, then the surface shows the honest "no memory graph yet — run `honeycomb pollinate trigger --compact`" state and writes no vault, never a faked one. |
| AC-4 | Given untrusted entity names/text (path separators, `]]`, frontmatter-breaking chars), when the vault is written, then filenames are sanitized (no traversal), wikilinks/frontmatter are escaped, and no secret/token appears in any file. |
| AC-5 | Given the export runs twice, then it is idempotent into the canonical dir (a re-export reflects the current graph; stale notes for deleted entities are removed or tombstoned per 051a's reconciliation rule). |

## Open questions (module-level)

- [ ] **Source scope:** v1 ships the *memory* graph only; do we generalize the writer to also emit the
  codebase-graph vault behind one `--source` flag now, or defer? (051a OQ-1.)
- [ ] **Canonical dir vs. user-chosen:** is `~/.honeycomb/obsidian/<scope>/` the right default, and do we
  let the user point it at an existing vault (subfolder) instead? (051a OQ-2 / 051b.)
- [ ] **Refresh model:** on-demand only for v1 (decided), but is a "re-export on pollinate convergence"
  watcher worth a fast-follow? (051c.)

## Related

- [PRD-041: Graph Page](../../completed/prd-041-graph-page/prd-041-graph-page-index.md) — the in-app graph this complements.
- [PRD-008: Knowledge Graph Ontology](../../completed/prd-008-knowledge-graph-ontology/prd-008-knowledge-graph-ontology-index.md) — the entity/dependency source this reads.
- [PRD-009: Pollinating Loop](../../completed/prd-009-pollinating-loop/) — the consolidation pass that populates the memory graph (`honeycomb pollinate trigger --compact`).
- The recent memory-aware **graph cap** (`snapshotToGraphView`, `src/daemon/runtime/codebase/api.ts`) — the in-app render fix this builds beyond.
- External: [JSON Canvas spec](https://jsoncanvas.org/) · [Obsidian URI](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) · [Obsidian Advanced URI plugin](https://github.com/Vinzent03/obsidian-advanced-uri).
