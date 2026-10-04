# PRD-013c: Obsidian Provider

> **Parent:** [PRD-013](./prd-013-sources-and-documents-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

The Obsidian vault provider: an artifact per Markdown file, a native graph mounted from vault topology (vault root entity, folders as groups, files as documents, wiki links as dependencies, headings as aspects, paragraphs as claims), and heading-split chunks, all watch-driven. Provider code is confined to the ingest stage; purge, health, and provenance come from the source contract (PRD-013a).

## Goals

- Mount a vault as read-only evidence with one artifact per Markdown file.
- Mirror the vault topology into the ontology so structure is queryable, not just text.
- Keep the vault current with a watch-driven update loop and provenance back to file, heading, and line range.

## Non-Goals

- Modifying vault files (sources are read-only).
- Ingesting non-Markdown attachments as artifacts.
- Cross-vault linking or external link resolution beyond wiki links.

## User stories

- As a user, I want my Obsidian vault mounted so that its notes and wiki-link structure become recallable evidence with provenance back to the file and heading.
- As an agent, I want vault topology in the graph so that I can traverse folders, headings, and links, not just full-text hits.
- As an operator, I want vault edits picked up automatically so that recall stays current without manual re-index.

## Functional requirements

- FR-1: `honeycomb sources add obsidian /path/to/Vault --name "Vault"` MUST register the vault as a source and queue an index job through the daemon.
- FR-2: Indexing MUST write one `memory_artifacts` row per Markdown file, carrying `source_id`, `source_kind`, vault-relative `source_path`, and `source_root`.
- FR-3: Indexing MUST mount the native graph: vault root becomes an entity, folders become groups, files become documents, wiki links become dependency edges, headings become aspects, and paragraphs become claims.
- FR-4: Content MUST be chunked by heading, with provenance recorded as vault-relative path plus heading and line range.
- FR-5: Chunks MUST be embedded as 768-dim `nomic-embed-text-v1.5` vectors carrying source provenance.
- FR-6: The daemon MUST watch the vault and re-read on change; re-scans MUST be single-flight and skip files whose content fingerprint is unchanged.
- FR-7: A removed file MUST be soft-deleted from `memory_artifacts` with its chunks purged; a rename MUST be handled as a delete plus an add.
- FR-8: All graph and artifact rows MUST be scoped to org and workspace and MUST be purgeable by `source_id` per the source contract.
- FR-9: A parse or read failure on a single file MUST be recorded as a source-owned failure artifact and MUST NOT delete other rows.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `honeycomb sources add obsidian /path/to/Vault`, when indexing runs, then each Markdown file becomes a `memory_artifacts` row and the vault topology is mounted into the ontology. |
| AC-2 | Given a vault file edited on disk, when the watcher fires, then the source re-reads and updates in place; a removed file is soft-deleted with its chunks purged. |
| AC-3 | Given a file with headings, when chunking runs, then chunks split by heading and each carries vault-relative path plus heading and line range. |
| AC-4 | Given wiki links between notes, when indexing runs, then they become dependency edges in the graph. |
| AC-5 | Given a renamed file, when the watcher fires, then the old row is soft-deleted and a new row is added. |
| AC-6 | Given a malformed file, when indexing runs, then a failure artifact is written and other files index normally. |

## Implementation notes

- Chunks split by heading; provenance is vault-relative path plus heading and line range.
- Wiki links become dependency edges; folders map to groups, headings to aspects, paragraphs to claims.
- Updates are watch-driven, single-flight, fingerprint-gated, consistent with the source contract.

## Dependencies

- PRD-013a source contract (purge, health, provenance, watch loop).
- The knowledge-graph ontology for entity/group/document/aspect/claim mapping.
- The embedder for heading-split chunk vectors.

## Open questions

- [ ] Confirm handling of unresolved or dangling wiki links (drop the edge versus a placeholder target).

## Related

- [parent index](./prd-013-sources-and-documents-index.md)
- [Source Lifecycle](../../../knowledge/private/sources/source-lifecycle.md)
- [Knowledge Graph Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
