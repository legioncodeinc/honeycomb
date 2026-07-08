---
description: Forget a memory from Honeycomb. Requires a reason, which this command collects.
argument-hint: "[path] [reason]"
arguments: [path, reason]
disable-model-invocation: true
---

Forget the memory at path "$path" from Honeycomb's memory. Reason given: "$reason".

`memory_forget` REQUIRES a `reason` for every deletion; it is not optional, and the reason becomes
part of the audit trail. Before calling it:

1. If `$path` is missing or ambiguous, ask the user to identify the memory to forget, e.g. by
   running `/recall` first to find its path.
2. If `$reason` is missing or empty, ask the user for a short reason (e.g. "outdated", "wrong",
   "superseded by a later decision") before proceeding. Do NOT call `memory_forget` without one.

Once both a path and a reason are confirmed, call `memory_forget` with `path` set to the confirmed
path and `reason` set to the confirmed reason, then tell the user what was forgotten and why.
