---
description: Search Honeycomb's memory for prior context on a query and surface the hits.
argument-hint: "[query]"
disable-model-invocation: true
---

Search Honeycomb's memory for: $ARGUMENTS

Call `hivemind_search` with that query (fall back to `memory_search` if `hivemind_search` is not
available in this session). Then, for the returned hits:

1. Present each hit's summary and its type (fact, convention, preference, decision, gotcha, or
   reference), most relevant first.
2. If a hit looks promising but the summary is too thin to answer the query, use `hivemind_read` on
   its ref to zoom into more detail (`depth: 2` for the raw turns) before reporting back.
3. If no tools are available (Honeycomb's MCP server is not registered in this session) or nothing
   relevant is found, say so plainly rather than guessing.
