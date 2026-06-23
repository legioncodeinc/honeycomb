# PRD-045e: Wire the Sources + Documents surface (closes PRD-013)

> **Status:** Completed
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-013 Sources and Documents
> **Priority:** P1
> **Effort:** L

## Overview

PRD-013 shipped the sources lifecycle, the document-ingest path, and the Obsidian/Discord/GitHub providers — but
**none of it is reachable**. `/api/sources` is deliberately deferred at the composition root (the engine needs a
registry + providers resolver "not yet constructible there"), so it and the CLI fall through to a 501.
`/api/documents` 501s without a worker, and the three providers are instantiated nowhere (dead code).

## Evidence of the gap

- `resolveProductDataDeps` deliberately omits `sources` (`assemble.ts:732-749`); `mountSourcesApi` is fired only
  when `options.sources` is present (`product/api.ts:279-283`) → `/api/sources` → 501 scaffold.
- `POST /api/documents` returns 501 when the worker is absent (`sources/api.ts:218-225`); the document-worker is a
  013b scaffold.
- Providers `sources/providers/{obsidian,discord,github}.ts` are exported but never instantiated.
- CLI `honeycomb sources` IS registered (`commands/contracts.ts:90`) and thin-clients to `/api/sources/*` — so it
  reaches the daemon and gets "not implemented."

## Goals

- Construct the sources **registry + providers resolver** at the composition root (the deps `resolveProductDataDeps`
  currently can't build) and pass `sources` into `mountProductDataApi` so `mountSourcesApi` fires.
- Wire the **document worker** so `POST /api/documents` ingests instead of 501ing.
- Instantiate the three providers behind the registry so a source can be added/listed/synced.

## Non-Goals

- New provider types beyond the three already built (Obsidian/Discord/GitHub).
- New schema — the sources/documents tables exist (PRD-003/013).
- Re-using otherhive's SQLite ingest wholesale; reuse only the already-ported parsers.

## User stories

- As a user, I want `honeycomb sources add <provider>` to register a real source and `honeycomb sources list` to
  return it — not a 501.
- As a user, I want `POST /api/documents` to ingest a document into memory.

## Acceptance criteria

| ID | Criterion |
|---|---|
| e-AC-1 | The composition root constructs the sources registry + providers resolver; cite the new `assemble.ts` wiring. |
| e-AC-2 | `mountSourcesApi` fires; `/api/sources` GET/POST/DELETE return real data (no 501), tenancy-scoped. |
| e-AC-3 | `POST /api/documents` ingests through the wired document worker (no 501); a live itest proves an ingested doc is recallable. |
| e-AC-4 | At least one provider (Obsidian) is instantiated and a source round-trips add → list → sync. |
| e-AC-5 | Fail-soft mount; a provider/worker error never crashes the daemon. |

## Implementation notes

- The blocker is constructibility at the composition root. Build the registry + providers resolver as a small
  assembly helper (mirroring `resolveProductDataDeps`'s secrets construction) and thread it through.
- Reuse the ported `ingest/*` parsers (chat/markdown/pdf/code/git) the provenance map flagged as safe-to-lift.

## Open questions

- [ ] Which providers must be live for close-out — all three, or Obsidian first with Discord/GitHub as fast-follow?
- [ ] Does the document worker run as a `memory_jobs` kind (preferred — reuse the queue) or inline in the handler?
