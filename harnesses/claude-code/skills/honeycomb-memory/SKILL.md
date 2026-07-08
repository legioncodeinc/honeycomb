---
name: honeycomb-memory
description: Use before starting non-trivial work that Honeycomb may already have prior context for (a past decision, a stated convention, where something lives), when a recalled memory should be cited and possibly zoomed into for detail, or after a decision, preference, durable fact, or gotcha emerges that is worth remembering for next time. Searches with hivemind_search/memory_search, zooms a promising hit with hivemind_read, and stores new memories with memory_store using the correct type.
when_to_use: Before re-explaining a convention the user has already stated, before re-deciding something already decided, when the user asks "did we cover this before" or "what did we decide about X", or right after a decision/preference/gotcha is stated in the conversation.
---

# Honeycomb memory

Honeycomb is a cross-harness memory system. It stores decisions, conventions, preferences, facts,
gotchas, and references, and makes them recallable across sessions and across harnesses through a
local daemon exposed here as MCP tools. This skill teaches three behaviors; each points at one of
those existing tools. It never invents a new tool.

## 1. Search before non-trivial work

Before starting a task that plausibly has prior context, e.g. it touches a past decision, a stated
convention, or "where does X live", call `hivemind_search` (or `memory_search`) with a query
describing the task FIRST, rather than asking the user to re-explain something they may have
already told Honeycomb.

- `hivemind_search` runs the hybrid recall (lexical + semantic, degraded-honest) over durable
  memory and returns refs you can zoom into.
- `memory_search` is the direct memory-table search when you already know you want a memory, not a
  broader recall.

This is the token-cheap, model-driven complement to Honeycomb's always-on recall floor: it fires
only when this skill decides it is relevant, not on every turn.

## 2. Cite recalled decisions, and zoom for detail

When a search surfaces a prior decision or convention, cite it in your work rather than silently
re-deciding it. If the hit is a summary and you need more detail, e.g. the exact wording, the
surrounding turns, use `hivemind_read` to zoom the ref down:

- `depth: 1` (the default) resolves to the Tier-2 summary.
- `depth: 2` resolves to Tier-3 raw turns (bounded by the daemon's turn cap).

Do not silently ignore a recalled decision that conflicts with what you are about to do. Surface
the conflict to the user instead of overriding it unprompted.

## 3. Store with the right type

After a decision, a stated preference, or a durable fact emerges in the conversation, e.g. the user
picks an approach, corrects your assumption, or states a fact about the system, call `memory_store`
so it is recallable next time. Classify it using the closed memory-type taxonomy the tool publishes
in its own schema (do not invent a type outside this set):

- `fact` (default): a stable, verifiable truth about the system, codebase, or domain.
- `convention`: how things are done here, idioms and patterns to follow by default.
- `preference`: the user/team's stated way of working, corrections and do/don't guidance.
- `decision`: an architectural or design choice and its rationale, don't relitigate it.
- `gotcha`: a non-obvious trap, failure mode, or constraint to watch out for.
- `reference`: a pointer to an external resource (URL, dashboard, ticket, doc).

Prefer the most specific type over `fact` when the content clearly fits `convention`,
`preference`, `decision`, `gotcha`, or `reference` instead.

## Inert-safe

If the Honeycomb MCP server is not registered in this session, `hivemind_search`, `memory_search`,
`hivemind_read`, and `memory_store` simply are not in the available tool list. This skill has no
effect in that case: do not attempt to work around a missing tool, and do not tell the user memory
is unavailable unless asked.
