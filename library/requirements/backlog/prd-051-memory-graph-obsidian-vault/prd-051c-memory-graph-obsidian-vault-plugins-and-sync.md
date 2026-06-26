# PRD-051c: Obsidian plugin enhancements + continuous export (exploration)

> **Parent:** [PRD-051](./prd-051-memory-graph-obsidian-vault-index.md)
> **Status:** Draft (exploratory — mostly open questions, NOT v1 scope)
> **Priority:** P3
> **Effort:** L (if pursued)
> **Schema changes:** None

---

## Overview

v1 (051a + 051b) is deliberately **stock-Obsidian-only and on-demand**: plain Markdown + wikilinks +
the core `obsidian://` scheme, exported when the user asks. That is the whole product for most users.

This sub-PRD captures the *optional* layer the feature request asked about — "what could we do with
Obsidian plugins?" and "on-demand vs. a fixed live area?" — so the value (and the cost) is on record
without committing v1 to it. Nothing here is required for the vault to be useful; each item is an
enhancement gated behind the user installing a community plugin or us shipping more daemon machinery.

**Framing:** v1's frontmatter is intentionally plugin-agnostic (plain keys any plugin *can* consume,
none *requires*), so these enhancements layer on without changing the 051a format.

## The plugin enhancement menu (each independent, each optional)

| Plugin (community) | What it adds over stock | Honeycomb hook | Cost / risk |
|---|---|---|---|
| **Dataview** | Live queries/tables over our frontmatter (e.g. "all entities of type X by `updated`", "edges with confidence < 0.5"). | Emit a couple of `dataview` query blocks in `Home.md` keyed on our `type`/`confidence`/`tags`. | User installs Dataview; queries are inert plain text without it (safe). |
| **Juggl / Graph Analysis** | Richer, styled, interactive graph view (filters, neighborhoods) beyond core graph. | Nothing — reads the same wikilinks. Optionally emit Juggl style tags. | Pure user-side; zero Honeycomb work. |
| **Breadcrumbs** | Hierarchy/relationship navigation (up/down/next) from typed frontmatter relations. | Map `depends_on`/`supersedes` to Breadcrumbs frontmatter fields. | Adds plugin-specific frontmatter keys (kept additive). |
| **Advanced URI** ([repo](https://github.com/Vinzent03/obsidian-advanced-uri)) | `obsidian://advanced-uri` — write frontmatter, run commands, open workspaces, manipulate canvas, search-and-replace. | A richer "Open in Obsidian" that lands on a *specific entity* note, or triggers a saved graph workspace. | Requires the user install Advanced URI; degrade to core `obsidian://open` without it. |
| **A bespoke "Honeycomb" plugin** | A vault-side button "Refresh from Honeycomb" that calls the daemon (`POST /api/vault/export`) and reloads; live status; jump-to-source. | We author + maintain a plugin; daemon CORS/loopback contract. | Highest cost; real maintenance + Obsidian review surface. |

## Continuous / watched export (the "fixed live area" question)

v1 = on-demand. The alternative is a **watcher** that re-exports whenever the memory graph converges:

- **Trigger:** hook the pollinating convergence (`src/daemon/runtime/pollinating/runner.ts`) — after a
  consolidation pass applies entity/dependency mutations, enqueue a debounced vault re-export.
- **Effect:** the canonical vault stays fresh with no button press; Obsidian (open on that vault) live-
  reloads changed notes.
- **Cost/risk:** churn on the user's filesystem + git noise if the vault is under version control;
  must respect 051a's `.obsidian/` preservation and never fight a user mid-edit; needs a quiet-period
  debounce and an opt-out. This is a fast-follow at most, not v1.

## Open questions

- [ ] **OQ-1:** Is any plugin worth a *first-class* path (we emit plugin-specific frontmatter/blocks by
  default), or do all enhancements stay opt-in docs ("install Dataview to get X")? Lean: opt-in docs;
  keep the default vault plugin-free.
- [ ] **OQ-2:** Continuous export — pursue the pollinate-convergence watcher as a fast-follow, or leave
  refresh fully manual? What is the debounce + opt-out contract?
- [ ] **OQ-3:** A bespoke Honeycomb Obsidian plugin (daemon-backed refresh, jump-to-source) — is the
  maintenance + Obsidian-review cost justified vs. the `obsidian://` + on-demand baseline? Likely no for
  now; revisit if users ask for in-vault refresh.
- [ ] **OQ-4:** `.canvas` (JSON Canvas) export as a *second* format alongside the Markdown vault — a
  spatial board view ([jsoncanvas.org](https://jsoncanvas.org/)) vs. the graph-view vault. Different
  use case (curated board vs. living graph); is it worth a `--format canvas` flag?
- [ ] **OQ-5:** Obsidian MCP servers exist (let an AI read/write a vault directly) — is there a story
  where Honeycomb's harnesses operate the vault via MCP rather than a file export? Out of scope here,
  noted for the harness roadmap.

## Related

- [PRD-051a](./prd-051a-memory-graph-obsidian-vault-markdown-export.md) / [PRD-051b](./prd-051b-memory-graph-obsidian-vault-open-in-obsidian.md) — the v1 baseline these enhance.
- [JSON Canvas](https://jsoncanvas.org/) · [Obsidian Advanced URI](https://github.com/Vinzent03/obsidian-advanced-uri) · [InfraNodus](https://infranodus.com/use-case/visualize-knowledge-graphs-pkm) (prior art: vault ↔ knowledge-graph round-trip).
