# PRD-013d: Discord Provider

> **Parent:** [PRD-013](./prd-013-sources-and-documents-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L

## Scope

The Discord provider across three sync modes: REST (bounded backfill plus forward refresh with checkpoints), gateway-tail (live bot connection indexing create/update/delete), and desktop-cache (local read with no bot token). A failure never deletes existing rows. Tokens are stored as secret references, never raw. Provider code is confined to ingest; purge, health, and provenance come from the source contract (PRD-013a).

## Goals

- Index Discord guilds, channels, threads, members, and messages as recallable evidence with provenance back to guild, channel, and message.
- Support three access patterns (bounded REST, live gateway tail, local desktop cache) under one contract.
- Never lose previously indexed rows to a partial failure or cache eviction.

## Non-Goals

- Posting to or modifying Discord (read-only evidence).
- Indexing voice or media content beyond message text.
- Storing raw bot tokens (always a secret reference).

## User stories

- As a team, I want Discord channels indexed so that decisions made in chat become recallable evidence with provenance back to the guild, channel, and message.
- As an operator, I want a live tail so that new messages appear in recall without a manual re-index.
- As a privacy-conscious user, I want desktop-cache mode so that I can index without granting a bot token.

## Functional requirements

- FR-1: REST mode MUST pull guilds, channels, threads, members, and per-message artifacts with latest and backfill checkpoints, refreshing forward from the latest checkpoint and backfilling within configured bounds and a `since` window.
- FR-2: Gateway-tail mode MUST hold a bot gateway connection open and index create, update, and delete events with per-channel tail checkpoints; removing the source MUST close the connection.
- FR-3: Desktop-cache mode MUST read the Discord desktop cache with no bot token, treating local-only DMs under a synthetic `@me` guild; cache eviction MUST NOT delete previously indexed rows.
- FR-4: Each message MUST become a `memory_artifacts` row carrying `source_id`, `source_kind`, and provenance identifying guild, channel/thread, and message.
- FR-5: The bot token MUST be supplied as a stored secret reference and resolved by the daemon; a raw token MUST never be persisted.
- FR-6: Snapshots MUST export and re-import artifacts with provenance for backup and move, excluding local `@me` DMs by default.
- FR-7: A partial fetch failure in any mode MUST be written as a source-owned failure artifact and reported, and MUST NOT delete any previously indexed row.
- FR-8: All artifacts and chunks MUST be scoped to org and workspace and purgeable by `source_id` per the source contract.
- FR-9: Interpolated channel names, message bodies, and ids MUST be escaped through the `sqlStr`/`sqlLike`/`sqlIdent` helpers before any DeepLake write.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given REST mode, when indexing runs, then guilds, channels, threads, members, and per-message artifacts are pulled with latest and backfill checkpoints, refreshing forward and backfilling within bounds. |
| AC-2 | Given any sync mode, when a fetch partially fails, then failures are written as source-owned failure artifacts and reported, and no previously indexed row is deleted. |
| AC-3 | Given gateway-tail mode, when a message create/update/delete event arrives, then it is indexed against the per-channel tail checkpoint. |
| AC-4 | Given the source is removed in gateway-tail mode, when purge runs, then the gateway connection is closed. |
| AC-5 | Given desktop-cache mode, when the cache evicts entries, then previously indexed rows remain. |
| AC-6 | Given a snapshot export, when it runs with defaults, then local `@me` DMs are excluded. |

## Implementation notes

- Gateway-tail holds a bot gateway connection with per-channel tail checkpoints; removing the source closes the connection.
- Desktop-cache reads the local cache under a synthetic `@me` guild for DMs and never deletes on cache eviction. Token stored as a secret reference, never raw.
- Soft-delete on the append-only status-advance path; no in-place UPDATE.

## Dependencies

- PRD-013a source contract (purge, health, provenance, checkpoints).
- The secrets store for the bot token reference.
- DeepLake daemon as the sole store client.

## Open questions

- [ ] Confirm snapshot export/import bounds and whether `@me` exclusion is overridable per export.

## Related

- [parent index](./prd-013-sources-and-documents-index.md)
- [Source Lifecycle](../../../knowledge/private/sources/source-lifecycle.md)
- [Secrets](../../../knowledge/private/security/secrets.md)
