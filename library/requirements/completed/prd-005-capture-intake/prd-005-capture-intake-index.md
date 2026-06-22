# PRD-005: Capture Intake

> **Status:** Completed
> **Priority:** P0
> **Effort:** M
> **Schema changes:** None

---

## Overview

Capture is the cheap, always-on front of Honeycomb: it records what the agent did as structured events, commits them durably, and gets out of the way before any model runs. This module builds the intake layer: the capture API that writes exactly one `sessions` row per event (with a `JSONB` message), the non-blocking attachment of a 768-dim `nomic-embed-text-v1.5` embedding via the embed daemon, and the guards that keep capture defensible on every turn. Capture came directly from hivemind, proven across harnesses, and now feeds otherhive's pipeline rather than only powering summaries. The smart work, extraction and the graph, happens afterward in daemon workers off the turn path.

## Goals

- Write exactly one `sessions` row per event (user message, tool call, assistant message), never concatenating into an existing row.
- Attach a 768-dim embedding when enabled, non-blocking, leaving the column null on disable or failure.
- Gate capture with a bypass switch, plugin-enabled check, recursion guard, and fail-soft behavior so a capture error never breaks the agent's turn.
- Bump the per-turn counters that cue the skillify miner and summary worker without running them inline.

## Non-Goals

- The distillation pipeline that reads `sessions` (PRD-006).
- The summary and skillify workers themselves (cued here, implemented elsewhere).
- Embedding model hosting internals (the embed daemon is consumed, not built here).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-005a-capture-intake-capture-endpoint`](./prd-005a-capture-intake-capture-endpoint.md) | Capture API and `sessions` INSERT-once with `JSONB` message. | Draft |
| [`prd-005b-capture-intake-embedding-attach`](./prd-005b-capture-intake-embedding-attach.md) | nomic embed daemon client, 768-dim, non-blocking. | Draft |
| [`prd-005c-capture-intake-capture-guards`](./prd-005c-capture-intake-capture-guards.md) | Bypass switch, plugin-enabled, recursion guard, fail-soft. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a turn event, when capture runs, then exactly one `sessions` row is INSERTed with the event as a `JSONB` `message`, never concatenated into an existing row. |
| AC-2 | Given embeddings are enabled, when an event is captured, then a 768-dim vector is attached non-blocking; when disabled or failing, the column is null and the event is still captured and lexically searchable. |
| AC-3 | Given `HONEYCOMB_CAPTURE=false` or a disabled plugin, when a turn occurs, then capture is skipped. |
| AC-4 | Given a summary or skillify worker running the harness CLI, when it acts, then the recursion guard prevents its activity from being captured as new turns. |

## Data model changes

None: writes to the `sessions` table defined in PRD-003c.

## API changes

Additive: the capture endpoint under the daemon's hook/capture route surface (scaffolded in PRD-004).

## Open questions

- [ ] What per-turn counter thresholds cue the summary worker (message count versus time) and the skillify miner (every N turns)?
- [ ] Where does the bypass switch live for non-env harnesses (config versus header)?
- [ ] Should embedding attachment be inline-async on the capture call or deferred to a follow-up job?

## Related

- [Session Capture](../../../knowledge/private/ai/session-capture.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [Schema](../../../knowledge/private/data/schema.md)
