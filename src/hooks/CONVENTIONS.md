# Per-harness shims — CONVENTIONS (PRD-019c)

Per-harness shims live under `src/hooks/<harness>/`. A shim is a THIN OVERRIDE of the shared
core (`src/hooks/shared/`, 019b): it maps a harness's native event vocabulary onto the six
logical events, normalizes the native payload into `HookInput`, and routes the core's result
back through the harness's native response format. No memory logic, no SQL, no DeepLake lives
in shim code.

**Read `shared/CONVENTIONS.md` first** — it owns the lifecycle the shims map onto.

## Claude Code is the REFERENCE; every other shim asserts equivalence to it (D-4 / c-AC-1)

`src/hooks/claude-code/shim.ts` implements the FULL six-event lifecycle and is the baseline.
Each non-reference shim's Wave-2 test asserts it produces the SAME daemon-written rows as the
reference (c-AC-1). The divergences are real but SHALLOW: event names + payload fields vary
and the context channel differs; the shim normalizes before handing off to the shared core,
which owns all memory decisions, SQL, embeddings, and locking.

## The shared override-plumbing: `normalize.ts` (`createShim` + `ShimSpec`) — Wave 2

c-AC-1 is made STRUCTURAL, not coincidental, by ONE shared normalization engine. Every shim
is a thin {@link ShimSpec} config (event-map + channel + host-CLI + `references` + the handful
of payload extractors that genuinely differ) passed to `createShim(spec)` in
`src/hooks/normalize.ts`. `createShim` returns the full `HarnessShim` whose
`mapEvent`/`normalize`/`renderContext` are the SAME engine for every harness — so two specs
that agree on `eventMap` + `extractData` produce byte-identical `HookInput`s.

The canonical capture-data builders (`userMessageData`/`assistantMessageData`/`toolCallData`/
`sessionStartData`/`sessionEndData`/`preToolData`) live in `normalize.ts` and define the
`{ kind, ... }` shapes the Claude Code reference produces; every shim's `extractData` reuses
them, passing its OWN field accessors but keeping the SHAPE fixed. This is also what keeps the
six near-identical shim files under the jscpd threshold (the duplicated plumbing is in one
place).

`ShimSpec` also carries two OPTIONAL hooks: `deriveMeta` (harness-specific session metadata —
OpenClaw's `agent:alice:` auto-route, Cursor's `workspace_roots` cwd) and `renderUserVisible`
(condense the block for the user-visible channel — Codex's brief login line).

## The per-message batch path (OpenClaw / pi — FR-7)

A harness that only fires a session-end event (OpenClaw `agent_end`, pi `session_shutdown`)
carries its whole turn in that payload. `openclawExpandBatch(messages, meta)` normalizes the
message slice to one `HookInput` per message — the SAME canonical capture data the reference
produces — which the shim flushes through the 019b core's `runCaptureBatch`. The daemon writes
IDENTICAL rows to incremental capture (b-AC-1 / c-AC-1). OpenClaw additionally cuts the slice
since the last flush with `openclawSliceSinceLastFlush(messages, cursor)` (c-AC-3): only NEW
messages are sent, never re-sending already-captured ones.

## Context channel routing — `renderContext` → `ContextEnvelope` (c-AC-5)

The shared core renders ONE block (`HookResult.additionalContext`). `shim.renderContext(block)`
wraps it into a `ContextEnvelope`: `{ channel: "model-only", additionalContext }` (Claude Code,
Cursor under `additional_context`, OpenClaw) or `{ channel: "user-visible", text }` (Codex's
brief login line, Hermes's `{ context }` + MCP mention, pi's `AGENTS.md` block). Both channels
carry the same logical content; only the routing + any `renderUserVisible` condensation differs.

## The five divergences a shim overrides (FR-2)

| # | Divergence            | Where it lives                                  |
|---|-----------------------|-------------------------------------------------|
| 1 | event-name map        | `<HARNESS>_EVENT_MAP` (native → `LogicalEvent`)  |
| 2 | payload normalize     | `HarnessShim.normalize` (Wave 2)                |
| 3 | context channel       | `<HARNESS>_CONTEXT_CHANNEL` (`model-only`/`user-visible`) |
| 4 | host CLI for summaries| `<HARNESS>_HOST_CLI`                            |
| 5 | async pattern + CLI fallback | `CliFallback` seam (FR-9 / c-AC-2)       |

## Per-harness divergence table (the Wave-1 declared contracts)

| Harness     | Channel       | Runtime path | Host CLI                                              | Notes |
|-------------|---------------|--------------|------------------------------------------------------|-------|
| claude-code | model-only    | legacy       | `claude -p`                                          | REFERENCE, full 6-event (FR-1) |
| codex       | user-visible  | legacy       | `codex exec --dangerously-bypass-approvals-and-sandbox` | detached setup, brief login line, Bash-only (FR-3 / c-AC-4) |
| cursor      | model-only    | plugin       | `cursor-agent` → `claude` fallback                   | `additional_context` key, `workspace_roots` cwd, `Shell` intercept (FR-4) |
| openclaw    | model-only    | plugin       | (native extension; no host-CLI exec)                 | batches at `agent_end`, new-slice only, no PreToolUse (FR-5 / c-AC-3) |
| hermes      | model-only    | legacy       | `hermes chat -Q -q`                                  | native `{ context }` output; no pre-tool interception |
| pi          | user-visible  | plugin       | `pi --print --provider <p> --model <m>`              | static `AGENTS.md` block, no PreToolUse; ext source at `harnesses/pi/extension-source/honeycomb.ts` (FR-7) |

OpenCode / Gemini CLI / Oh My Pi (FR-8) are DOCUMENTED FUTURE shims, not implemented this
wave. Each is a thin `ShimSpec` over `createShim` exactly like the six above: OpenCode (bundled
runtime plugin + hooks, in-process lifecycle + `AGENTS.md` sync), Gemini CLI (MCP + `GEMINI.md`
sync, on-demand tools + identity sync), Oh My Pi (managed extension, fail-open on daemon errors
+ context injected outside the transcript). Adding one is a new `src/hooks/<harness>/shim.ts`
config + a parametrized entry in the c-AC-1 equivalence table — no engine change.

## Context channel (FR-10 / c-AC-5 — PRD open question, recorded not resolved)

`model-only` lands in the model's context but is not shown to the user (Claude Code, Cursor,
Hermes, OpenClaw); `user-visible` is rendered in the transcript (Codex's login line and
pi's `AGENTS.md`). The shim normalizes the SAME logical block to its channel
before handoff. Whether to NORMALIZE the difference or SURFACE it per harness is the PRD's
open question — left to Wave 2 / a later decision, not pre-decided here.

## CLI fallback for write-intercept-less harnesses (FR-9 / c-AC-2)

A harness with no pre-tool hook (OpenClaw, pi) cannot intercept a goal/KPI write, so the shim
routes the action through a CLI call (`honeycomb goal …`, `honeycomb kpi …`) via the
`CliFallback` seam rather than dropping it. The fake (`createFakeCliFallback`) records the
argv so a Wave-2 test asserts the fallback fires.

## Runtime-path stamping (FR-10) — `plugin` for runtime extensions, `legacy` for hook scripts

Each shim declares its `runtimePath`; the shared core forwards it on every daemon call. The
daemon enforces one active path per session (409 on conflict, b-AC-6) — the shim only stamps.

## References gate (FR-11 / D-3)

Before changing a shim, inspect the sibling repo under `references/<harness>/` for the exact
event names, payloads, and runtime behavior. No sibling repos exist under `references/` in
THIS repo, so the gate is a documented CONTRIBUTION RULE + a comment-cited protocol in each
shim (c-AC-6) — CI enforcement is the PRD's deferred open question (D-3). Each shim cites the
protocol it implements in its module header.

## What Wave 2 fills (signatures STABLE — pure fill)

- `claude-code/shim.ts` — `createClaudeCodeShim().normalize` (the reference, FULL).
- `codex|cursor|openclaw|hermes|pi/shim.ts` — a `create<Harness>Shim()` factory + `normalize`
  override built against the shared core, plus the CLI-fallback wiring where applicable.

The non-reference placeholder modules declare ONLY their constants this wave so the directory +
ownership exist with zero contention; Wave 2 adds the factory + exports it from `index.ts`.

## Deferred assembly (honest deferral — mirrors 019b D-9 / PRD-015)

The shims are CONSTRUCTED-AND-TESTED behind the 019b seams; they are NOT wired into a running
harness binary or native extension. NO harness is claimed live-wired. The deferred per-harness
runtime wiring (the real `harnesses/<h>/src/index.ts` dispatch + the native extensions, e.g.
`harnesses/pi/extension-source/honeycomb.ts` delivered as raw `.ts`, the OpenClaw native
extension, the Cursor extension) is the deferred assembly step — it dials the 019b core's real
`DaemonHookClient`/`CredentialReader`/`SummarySpawn` (which are themselves the 019b deferred
wiring). This wave delivers: the six shim factories, the shared `createShim` engine, the
channel-router, the OpenClaw new-slice batch path, and the CLI-fallback wiring — all driven by
the 019b recording fakes in `tests/hooks/<harness>/`.
