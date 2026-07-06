# PRD-075b: Render the PreToolDecision — Block-and-Inject + Conformance

> **Parent:** [`prd-075-on-demand-recall-command-surface-index`](./prd-075-on-demand-recall-command-surface-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (~0.5-1d, front-loaded by the contract-pinning task)
> **Schema changes:** None.
> **Depends on:** [`prd-075a`](./prd-075a-live-the-pretooluse-recall-path.md) (the propagated `decision`).

---

## Goal

Turn the `PreToolDecision` that 075a now surfaces into an actual Claude Code `PreToolUse` response that **blocks the real tool and delivers the daemon output to the model**. This is the missing shim capability: the claude-code shim today has only `eventMap` + `extractData` and a `"model-only"` context channel (`shim.ts:53`) that can inject but cannot block. `replace` needs both.

The load-bearing task is done **first**: pin the real Claude Code `PreToolUse` output contract from the installed harness (references-gate discipline), then write the renderer to it.

## Non-Goals

- **No runtime/VFS changes** — that is 075a.
- **No `SessionStart` notice** — that is 075c.
- **No non-claude-code harness wiring** — the render contract is expressed for reuse, but only the reference harness is implemented here.
- **No change to the `deny`/`rewrite` semantics** — the existing `WRITE_DENY_GUIDANCE` and `HARMLESS_ECHO` behaviors are rendered, not redesigned.

---

## Code-grounded starting point

| # | Fact | Code |
|---|---|---|
| 1 | The claude-code shim defines only `eventMap` + `extractData`; no pre-tool decision renderer; channel is `"model-only"` | `src/hooks/claude-code/shim.ts:42-53`, `:119-133` |
| 2 | `PreToolDecision` = `allow \| replace \| deny \| rewrite`; `replace` carries `output`, `deny` carries `guidance`, `rewrite` carries `command` | `src/hooks/shared/pre-tool-use.ts:41-45` |
| 3 | The Claude Code hooks **config** contract is already an executable oracle; the **response/stdout** contract is not yet encoded | `references/claude-code/hooks-schema.ts` (config keys only) |
| 4 | The binary driver writes the hook outcome to stdout; the shim owns the harness-native rendering | `src/hooks/binary.ts` (`runHookBinary`), `src/hooks/claude-code/index.ts` (the reference binary) |

---

## Design

### Step 1 — Pin the contract (do this before writing code)

Determine, from the installed Claude Code hooks reference, how a `PreToolUse` command hook returns a **block-and-inject** result. Candidate channels, in preference order:

1. **`hookSpecificOutput.additionalContext` + `permissionDecision: "deny"`** — if `PreToolUse` supports an `additionalContext` alongside a deny, this is the clean path: deny stops the real tool, `additionalContext` carries the daemon hits to the model.
2. **`permissionDecision: "deny"` + `permissionDecisionReason: <hits>`** — deny blocks the tool; the reason string is surfaced to the model as why the tool did not run. Contract-safe on older versions; the hits arrive as the "reason."
3. **`rewrite`-to-echo fallback** — if neither block-and-inject channel exists, rewrite the tool call to `echo <hits>` so the real tool never runs and the echo stdout *becomes* the tool result. Ugliest, but works on any version and reuses the existing `rewrite` decision kind.

Encode the chosen shape into `references/claude-code/` as an executable oracle (extend `hooks-schema.ts` or add a response-schema sibling), so the renderer is checked against a documented contract rather than a guess — matching the existing references-gate discipline.

### Step 2 — Write the renderer

Add a pre-tool decision renderer to the claude-code shim that maps each `PreToolDecision`:

| Decision | Rendered Claude Code `PreToolUse` response |
|---|---|
| `allow` | pass-through (no block, no injection) — the real tool runs |
| `replace` | block the real tool + deliver `output` to the model, via the Step-1 channel |
| `deny` | block + surface `guidance` (the mount-write guidance) |
| `rewrite` | substitute `command` (the harmless echo) so the tool runs but mutates nothing |

Thread the renderer through the shared `createShim`/`runHookBinary` path so the reference binary emits it. Keep the `"model-only"` channel for `SessionStart` unchanged — this adds a pre-tool render path, it does not alter the session-start injection.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | The real Claude Code `PreToolUse` block-and-inject contract is pinned and encoded as an executable oracle under `references/claude-code/`. A conformance test parses the shim's emitted `PreToolUse` response against it. |
| b-AC-2 | A `replace` decision renders to a `PreToolUse` response that (a) prevents the real tool from executing and (b) delivers `output` to the model, via the chosen Step-1 channel. A test asserts both properties on the serialized stdout. |
| b-AC-3 | A `deny` decision renders as a block carrying `guidance`; a `rewrite` renders as the substituted `command`; an `allow` renders as untouched pass-through (real tool runs, no injection). Each has a test. |
| b-AC-4 | End-to-end (shim + 075a runtime, daemon `vfs` faked): a mount `Grep` recall command produces a serialized `PreToolUse` response that blocks the grep and carries the faked hybrid-recall hits. |
| b-AC-5 | The cross-harness conformance suite (equivalence-to-reference) remains green; a non-claude-code harness that does not implement the renderer is unaffected (its pre-tool behavior is whatever it was). |
| b-AC-6 | Fail-soft: an absent decision (075a fail-soft path) or `allow` renders as pass-through — never a malformed block that could strand a turn. A test drives the no-decision outcome and asserts the real tool is allowed. |

---

## Files touched

**Modified**
- `src/hooks/claude-code/shim.ts` — add the `PreToolDecision` renderer; wire it into `createClaudeCodeShim`.
- `src/hooks/binary.ts` / `src/hooks/claude-code/index.ts` — surface the rendered pre-tool response on stdout (if not already carried by the outcome).
- `references/claude-code/hooks-schema.ts` (or a new `pretool-response-schema.ts` sibling) — the pinned response oracle.

**New**
- `tests/mcp/.../` or `tests/daemon/runtime/hooks/pretool-render.test.ts` — the render + conformance cases.

---

## Test plan

- **Contract:** parse the shim's emitted `PreToolUse` response against the `references/claude-code/` oracle (b-AC-1).
- **Render matrix:** one test per `PreToolDecision` kind → expected serialized response (b-AC-2, b-AC-3).
- **End-to-end (faked daemon):** mount `Grep` → 075a runtime → shim render → assert block + hits (b-AC-4).
- **Conformance:** run the existing equivalence-to-reference suite (b-AC-5).
- **Fail-soft render:** no-decision / `allow` → pass-through (b-AC-6).

---

## Open questions

- **Which Step-1 channel the installed version supports.** This is the single biggest unknown and gates the renderer's shape. Resolve it first, from the real harness docs/behavior, and record the finding in the references oracle. If the answer is "only deny+reason," the hits arrive as a "reason" string — acceptable, but the awareness notice (075c) should frame the recall command's output accordingly.
- **Truncation / size bound on injected hits.** The daemon already bounds recall output, but confirm the `PreToolUse` response has no stricter size ceiling than `SessionStart`; if it does, cap the rendered `output` and note the omission (no silent truncation — log or annotate the cut).
