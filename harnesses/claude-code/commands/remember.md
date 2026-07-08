---
description: Store a fact, preference, decision, convention, or gotcha in Honeycomb's memory.
argument-hint: "[fact]"
disable-model-invocation: true
---

Store the following in Honeycomb's memory: $ARGUMENTS

Call `memory_store` with `text` set to the fact above. Classify its `type` from the closed
taxonomy the tool publishes in its own schema:

- `fact` (default): a stable, verifiable truth.
- `convention`: how things are done here.
- `preference`: the user/team's stated way of working.
- `decision`: an architectural or design choice and its rationale.
- `gotcha`: a non-obvious trap or constraint.
- `reference`: a pointer to an external resource.

Pick the best fit from the content of the fact; if none clearly applies, omit `type` and let it
default to `fact`. Confirm back to the user what was stored and under which type, in one short
line.
