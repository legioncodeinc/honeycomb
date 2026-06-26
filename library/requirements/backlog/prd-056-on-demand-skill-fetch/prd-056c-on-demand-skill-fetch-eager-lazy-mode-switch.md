# PRD-056c: Eager/Lazy Mode Switch

> **Parent:** [PRD-056](./prd-056-on-demand-skill-fetch-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S (1-3h)
> **Schema changes:** None

---

## Goals

Let a workspace choose eager (today's default) or lazy skill distribution, with an `auto` setting that flips to lazy once the catalog grows past the accuracy threshold, and guarantee no regression when eager is selected.

## Scope

- A skillify config field `skillMode: "eager" | "lazy" | "auto"`, default `eager`, persisted with the existing scope config.
- The `auto` threshold logic that flips to lazy past a configured catalog size (default derived from the 30-50 item accuracy band).
- Routing session-start to the eager auto-pull or the lazy catalog sync accordingly.

## Out of scope

- The catalog (PRD-056a) and body fetch (PRD-056b) mechanics themselves.

---

## User stories and acceptance criteria

### US-056c.1 - Default is unchanged

- AC-056c.1.1 Given no config (or `skillMode: eager`), when a session starts, then behaviour is byte-for-byte today's auto-pull (no regression).

### US-056c.2 - Lazy and auto

- AC-056c.2.1 Given `skillMode: lazy`, when a session starts, then only the metadata catalog syncs and bodies are fetched on trigger.
- AC-056c.2.2 Given `skillMode: auto` and a catalog larger than the threshold, when a session starts, then it runs lazy and logs the switch with the catalog size and threshold.
- AC-056c.2.3 Given `skillMode: auto` and a small catalog, when a session starts, then it runs eager.

---

## Technical considerations

- Reuse the existing skillify config store (`~/.honeycomb/state/skillify/config.json`) and add one field; `coerceScope`-style normalization keeps old configs valid.
- The switch is a routing decision at the session-start seam, not a new pipeline: eager calls today's `POST /api/skills/pull`; lazy calls the catalog sync.
- Threshold default grounded in the documented 30-50 item tool/skill selection-accuracy cliff.

## Evaluation and study of other codebases

- **Prior art:** Tool Search Tool's `ENABLE_TOOL_SEARCH=auto` flips on a context-percentage threshold; MCP guidance recommends 1-5% of context as the switch point. These define the `auto` heuristic.
- **Pattern:** our own scope config (`me`/`team`, `install` project/global) is the precedent for a persisted, normalized skillify mode field.

## Files touched (anticipated)

- Modified: skillify config types + normalization under `src/daemon-client/skillify/config.ts`; the session-start routing in `src/hooks/shared/session-start-seams.ts`. Tests for default-eager (no regression), lazy, and auto-threshold.

## Test plan

- Unit: absent config defaults eager (AC-056c.1.1); lazy routes to catalog (AC-056c.2.1); auto flips past threshold and logs (AC-056c.2.2); auto stays eager below threshold (AC-056c.2.3).

## Open questions

- [ ] Threshold unit: skill count, or estimated catalog token size (closer to the MCP percentage rule)?
