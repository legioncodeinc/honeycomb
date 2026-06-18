# PRD-017: Wiki Summaries

> **Status:** In-Work
> **Priority:** P1
> **Effort:** M
> **Schema changes:** Additive

---

## Overview

Honeycomb collapses verbose session traces into AI-written wiki summaries so recall ranks documents instead of thousands of raw rows. The summary worker is owned by the honeycomb daemon (port 3850), the only DeepLake client; hooks signal the daemon on final and periodic triggers, and the daemon serializes a worker config, fetches session events with retry-on-empty backoff, runs a host-harness gate CLI to write the markdown, embeds it with a 768-dim vector, and writes it to the `memory` table at `/summaries/<userName>/<sessionId>.md` via SELECT-before-INSERT. Those summaries plus a synthesized `MEMORY.md` and thread heads are what surface when an agent greps or follows links across the memory virtual filesystem.

## Goals

- Daemon-owned summary worker that fires on final (`Stop`/`SessionEnd`/`session_shutdown`) and periodic (N-messages or elapsed-hours) triggers with per-session locking.
- Per-harness gate CLI generation so summaries are written by the host agent's own CLI without a separate API key.
- Synthesize a top-level `MEMORY.md` plus thread heads from session summaries for fast structural recall.
- Resilient to DeepLake eventual consistency: retry on empty events, never strand placeholders, treat embedding failure as non-fatal.

## Non-Goals

- The retrieval ranking algorithm itself (covered by the retrieval module).
- Session capture row writes (covered by session-capture).
- Skillify mining of skills from sessions (covered by team skill sharing and the skillify pipeline).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-017a-wiki-summaries-summary-worker`](./prd-017a-wiki-summaries-summary-worker.md) | Daemon summary worker plus host-harness gate CLI generation. | Draft |
| [`prd-017b-wiki-summaries-synthesis`](./prd-017b-wiki-summaries-synthesis.md) | `MEMORY.md` synthesis plus thread heads. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a session reaches `SessionEnd`, when the daemon runs the summary worker, then a summary row is written to the `memory` table at `/summaries/<userName>/<sessionId>.md` exactly once. |
| AC-2 | Given DeepLake read consistency lags the write, when the worker fetches session events and finds none, then it retries with linear backoff up to the configured limit before giving up and removes any in-progress placeholder. |
| AC-3 | Given a periodic threshold (messages or hours) is crossed mid-session, when capture records the event, then the daemon is signaled and runs at most one concurrent summary per session via the per-session lock. |

## Data model changes

Additive: the `memory` table carries summary rows with a `summary_embedding` (768-dim `nomic-embed-text-v1.5`) column and a `description` excerpt. A synthesized `MEMORY.md` plus thread-head rows are written under the memory path. No breaking changes.

## API changes

Additive daemon endpoints to trigger and report summary runs and to write/read synthesized `MEMORY.md` and thread-head rows. No breaking changes to existing hook endpoints.

## Open questions

- [ ] Should `MEMORY.md` synthesis run on every summary write or on its own debounced schedule?
- [ ] How are thread heads keyed when a session is resumed across `--resume`/`--continue`?
- [ ] Should periodic and final triggers share one config or diverge per harness?

## Related

- [Wiki Summary Workers](../../../knowledge/private/ai/wiki-summary-workers.md)
- [Session Capture](../../../knowledge/private/ai/session-capture.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
