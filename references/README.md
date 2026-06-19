# `references/` — the executable harness-contract fixtures

These are the **executable contract fixtures** for the harness `hooks.json` protocols. They make
the "references gate" — cited as a documented CONVENTION in PRDs 019a / 020c / 020d (decision
D-3) — actually **executable** for the first time.

## Why this exists

The Honeycomb connectors (`src/connectors/claude-code.ts`, `src/connectors/cursor.ts`, both
extending the 019a `HarnessConnector` base) emit each harness's hook config at install time. The
019a unit tests only assert that "an entry was added" — they never check the emitted config
matches what the **real harness** would accept. A typo'd or renamed event name, or a merge that
produces a structure the harness rejects, would pass the unit tests and silently break that
harness on a real user install.

Each `references/<harness>/hooks-schema.ts` encodes — as an **independent `zod` oracle** — the
structure the **real** harness accepts. The conformance suite
(`tests/conformance/connector-hooks-conformance.test.ts`) runs the REAL connectors through their
REAL install path (over the 019a in-memory `createFakeFs` seam — no real `~` is touched), captures
the emitted config, and validates it against these schemas.

## The key property: these encode the EXTERNAL protocol, not Honeycomb's code

The schemas are an **oracle the connector is checked against**, not a mirror of the connector
types. They are derived from the harness vendors' own documentation and the in-repo legacy
references — never from `src/connectors/*`. That independence is the whole point: if a connector
emits a config that does **not** conform, the gate fails (or pins the divergence as a finding) —
**the schemas are never relaxed to make a connector pass.**

## Files

| File | Encodes | Primary source |
| --- | --- | --- |
| `claude-code/hooks-schema.ts` | `~/.claude/settings.json` → `hooks` map: event → `[{ matcher?, hooks: [{ type, command, timeout?, async? }] }]` | code.claude.com/docs/en/hooks + `hivemind-v1/harnesses/claude-code/hooks/hooks.json` |
| `cursor/hooks-schema.ts` | `~/.cursor/hooks.json` → `{ version?, hooks: { event: [{ command, type?, timeout?, matcher?, failClosed?, loop_limit? }] } }` | cursor.com/docs/agent/hooks + `src/hooks/cursor/shim.ts` |

## Fidelity caveats (read before trusting a strict rule)

These encode what is **known and justifiable** from the public protocol; where a field could not
be pinned exactly, the schema tolerates it (`.passthrough()`) rather than inventing a rule:

- **Claude Code** accepts far more events than Honeycomb registers (`Setup`, `Notification`,
  `SubagentStart`, `PreCompact`, …). The event-name oracle validates each emitted event key by
  **membership** in the recognized set, not by an exact total-set match — a connector that adds a
  new *valid* event must not fail, while a *non-event* must. The handler object passes through
  harness fields the gate does not constrain (`if`, `once`, `args`, `shell`, `statusMessage`,
  `asyncRewake`). `async` **is** a real Claude Code command-hook field and is asserted as a boolean.
- **Cursor** lists each event's handlers as a **flat array of entries** directly under the event
  key (`hooks[event] = [{ command, type?, … }]`) — it does **not** use the Claude-Code-style
  nested `{ matcher?, hooks: [...] }` block. Cursor has **no `async` field** (its model is
  `timeout` / `failClosed` / `loop_limit`); an `async` key is tolerated as an unknown passthrough,
  never asserted as part of the contract. `beforeShellExecution` is a real Cursor event (the
  shell-command gate, the analogue of Claude Code's `PreToolUse` + `Bash` matcher).

See the header of each schema file for the per-field source citations.
