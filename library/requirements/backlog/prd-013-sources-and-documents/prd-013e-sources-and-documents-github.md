# PRD-013e: GitHub Provider

> **Parent:** [PRD-013](./prd-013-sources-and-documents-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

The GitHub provider: issues, pull requests, and discussions indexed over GraphQL (token required), plus selected Markdown docs over REST, bounded by `maxItemsPerRepo` and path globs. Arbitrary source code is not ingested. Provider code is confined to ingest; purge, health, and provenance come from the source contract (PRD-013a).

## Goals

- Index repo issues, pull requests, discussions, and selected Markdown docs as recallable evidence with provenance back to repo and item.
- Bound ingestion by item count and path globs so large repos stay tractable.
- Resolve the token through a secret reference and never leak it to a non-GitHub remote.

## Non-Goals

- Ingesting arbitrary source code (only Markdown docs are ingested).
- Writing to GitHub (read-only evidence).
- Indexing binary assets or non-Markdown files.

## User stories

- As a developer, I want repo issues, PRs, discussions, and docs indexed so that project history becomes recallable evidence with provenance back to the repo and item.
- As a security reviewer, I want the GitHub token resolved from a secret reference and scoped to `github.com` so that it never leaks into a non-GitHub remote.
- As an operator, I want item and path bounds so that a large repo does not flood the store.

## Functional requirements

- FR-1: `honeycomb sources add github --repo Org/Repo --token-ref GITHUB_TOKEN --resource-type issues --resource-type docs` MUST register the repo as a source with the selected resource types and queue an index job.
- FR-2: Issues, pull requests, and discussions MUST be indexed over GraphQL (token required), each becoming a `memory_artifacts` row with provenance back to repo and item.
- FR-3: Selected Markdown docs MUST be indexed over REST; doc ingestion MUST be limited to Markdown and a non-Markdown file MUST be skipped.
- FR-4: Ingestion MUST be bounded by `maxItemsPerRepo` and by path globs for docs.
- FR-5: The token MUST resolve through a secret reference; git sync MUST resolve `GITHUB_TOKEN` for `github.com` only and MUST never inject it into a non-GitHub remote.
- FR-6: Each artifact MUST carry `source_id`, `source_kind`, and provenance, and MUST be scoped to org and workspace.
- FR-7: A partial fetch failure MUST be written as a source-owned failure artifact and reported, and MUST NOT delete previously indexed rows.
- FR-8: Interpolated repo names, item titles, and bodies MUST be escaped through the `sqlStr`/`sqlLike`/`sqlIdent` helpers before any DeepLake write.
- FR-9: All artifacts and chunks MUST be purgeable by `source_id` per the source contract.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `honeycomb sources add github --repo Org/Repo --token-ref GITHUB_TOKEN --resource-type issues --resource-type docs`, when indexing runs, then issues/PRs/discussions are pulled over GraphQL and selected Markdown docs over REST. |
| AC-2 | Given doc ingestion, when a non-Markdown file is encountered, then it is skipped; only Markdown is ingested, bounded by `maxItemsPerRepo` and path globs. |
| AC-3 | Given a `maxItemsPerRepo` bound, when indexing runs, then no more than that many items per repo are ingested. |
| AC-4 | Given a non-GitHub remote, when git sync runs, then `GITHUB_TOKEN` is not injected into it. |
| AC-5 | Given a partial GraphQL failure, when indexing continues, then a failure artifact is written and existing rows are retained. |
| AC-6 | Given indexed items, when inspected, then each carries repo and item provenance scoped to org and workspace. |

## Implementation notes

- Token resolves through a secret reference; git sync resolves `GITHUB_TOKEN` for `github.com` only and never injects it into a non-GitHub remote.
- Partial failures are written as source-owned failure artifacts and reported.
- Doc ingestion is Markdown-only; arbitrary source code is never ingested.

## Dependencies

- PRD-013a source contract (purge, health, provenance).
- The secrets store for the GitHub token reference.
- GitHub GraphQL and REST APIs.

## Open questions

- [ ] Confirm GraphQL rate-limit backoff strategy and whether it counts against the failure-artifact threshold.

## Related

- [parent index](./prd-013-sources-and-documents-index.md)
- [Source Lifecycle](../../../knowledge/private/sources/source-lifecycle.md)
- [Secrets](../../../knowledge/private/security/secrets.md)
