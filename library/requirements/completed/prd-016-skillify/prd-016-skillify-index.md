# PRD-016: Skillify

> **Status:** Completed — NOW LIVE (closed by [PRD-045f](../../in-work/prd-045-daemon-wiring-closeout/prd-045f-daemon-wiring-closeout-skillify-mining.md))
> **Priority:** P1
> **Effort:** M
> **Schema changes:** Additive

---

> **✅ Now live (2026-06-22 daemon-wiring close-out, PRD-045f).** The skillify mining worker is fully wired.
> `assembleDaemon` constructs + starts a worker leasing `["skillify"]` (mirroring the pollinating worker lifecycle);
> the worker runs the Haiku KEEP/MERGE/SKIP gate and writes append-only versioned rows to the `skills` table.
> Session-end enqueue (`session-end.ts:112`) and turn-counter enqueue (`capture/turn-counters.ts:150`) feed the
> now-live worker. The `skillify pull` CLI verb is registered in the dispatch table (`src/cli/skillify.ts`).
> `/api/skills` read was already live and remains so. Closed by
> [PRD-045f](../../in-work/prd-045-daemon-wiring-closeout/prd-045f-daemon-wiring-closeout-skillify-mining.md).
> Full audit: [`2026-06-22-daemon-wiring-liveness-audit.md`](../../in-work/prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md).

---

## Overview

Recurring patterns in agent sessions are worth codifying. When multiple sessions show the same approach to a problem (a migration idiom, a debugging sequence, a non-obvious tool invocation), that knowledge should not stay locked inside transcripts. Skillify mines recent sessions, crystallizes a reusable `SKILL.md`, and propagates it to every agent on the team. The pipeline has two halves. The first is local and happens at the end of every session: a stop-counter signals the honeycomb daemon, which runs the skillify worker as a background job; the worker fetches candidate sessions, extracts prompt/answer pairs, runs a gate model that returns KEEP, MERGE, or SKIP with a precision-over-recall stance, writes the skill file, and records an append-only version row to the DeepLake `skills` table. The second half is collaborative and happens at session start: every agent auto-pulls the latest skills from the `skills` table into its own skill directory. Hooks never talk to DeepLake directly; they signal the daemon, which owns the worker and the only connection to the store.

## Goals

- Trigger mining from a per-project stop-counter (every N turns) plus an unconditional session-end pass, with a worker lock preventing concurrent runs per project.
- Gate mined patterns through a model that returns KEEP/MERGE/SKIP, firing KEEP only for non-obvious patterns recurring across at least three exchanges.
- Write skills as append-only, versioned rows in the `skills` table with provenance, never UPDATEing in place.
- Propagate skills to teammates via `pull` and idempotent auto-pull at session start, fanning out symlinks to every detected agent's skill root.

## Non-Goals

- The session-capture pipeline that produces the transcripts skillify mines (consumed here; owned elsewhere).
- Defining the gate model; skillify shells out to the host agent's own CLI rather than holding an API key.
- Cross-org skill sharing beyond the workspace's tenancy scope.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-016a-skillify-trace-miner`](./prd-016a-skillify-trace-miner.md) | Trace mining and the gate model. | Draft |
| [`prd-016b-skillify-skills-writes`](./prd-016b-skillify-skills-writes.md) | Append-only versioned skills writes and watermarks. | Draft |
| [`prd-016c-skillify-skill-install`](./prd-016c-skillify-skill-install.md) | Local skill install and propagation. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the stop-counter reaches `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`, when a Stop event fires, then the counter resets and the daemon runs the skillify worker; session-end fires the worker unconditionally. |
| AC-2 | Given a mined pattern, when the gate returns KEEP, then it recurred across at least three exchanges, is non-obvious, and is not already covered; otherwise it is SKIP or MERGE. |
| AC-3 | Given a successful local write, when the daemon records to the `skills` table, then it inserts a new version row (never an in-place UPDATE) and advances the watermark to the oldest mined session. |

## Data model changes

Additive: `skills` table holding append-only, version-bumped skill rows with provenance (`source_sessions`, `version`, `created_by_agent`, scope) plus per-project watermark and counter state on disk.

## API changes

Additive: `honeycomb skillify pull` and the daemon worker trigger and auto-pull served at session start. No value-bearing public route beyond skill propagation.

## Open questions

- [ ] Should the default `HONEYCOMB_SKILLIFY_EVERY_N_TURNS` (20) be tunable per-workspace as well as per-env?
- [ ] How should cross-author MERGE conflicts be resolved when two teammates merge the same skill name concurrently?
- [ ] Should auto-pull's 5-second timeout be configurable for slow networks, or always fail-open?

## Related

- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)
- [Session Capture](../../../knowledge/private/ai/session-capture.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)
- [Schema](../../../knowledge/private/data/schema.md)
