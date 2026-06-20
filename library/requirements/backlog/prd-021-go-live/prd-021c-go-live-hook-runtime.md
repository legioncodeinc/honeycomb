# PRD-021c: Hook Runtime (real hook client, per-harness binaries, reference harness)

> **Parent:** [PRD-021](./prd-021-go-live-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

The production hook runtime: the real `DaemonHookClient`, `CredentialReader`, and `ContextRenderer` (the 019b seams whose prod implementations were deferred), the per-harness binary entry points wired through the 019c shim and 019b core, the two un-attached daemon hook endpoints, the notifications drain on session start, and Claude Code as the first fully-wired reference harness. This sub-PRD owns making a native hook event travel end-to-end from a harness binary to a captured DeepLake row. It does not own the daemon assembly that attaches the endpoints (021a), the CLI that wires the harness (021b), the dashboard that displays the captured sessions (021d), or the MCP surface (021e).

## Goals

- A production `DaemonHookClient` that POSTs to the loopback daemon's `/api/hooks/*` stamping the `x-honeycomb-runtime-path` header.
- A production `CredentialReader` that reads `~/.honeycomb/credentials.json`, and a real `ContextRenderer`.
- Per-harness binary entry points wired from the native hook payload through the 019c shim normalize, the 019b core, and the `DaemonHookClient`.
- The two un-attached daemon hook endpoints (`/api/hooks/context` and `/api/hooks/session-end`) attached alongside the already-attached `/api/hooks/capture`.
- The 020d notifications pipeline drained on session start.
- Claude Code as the first fully-wired reference harness, with the other harnesses sequenced as fast-follows.

## Non-Goals

- The composition root and the `attachHooksHandlers` call site (021a), though this sub-PRD supplies the handlers and endpoints it attaches.
- The CLI `setup`/`connect` wiring that installs the harness hook config (021b).
- The dashboard and live log that show captured events (021d).
- The MCP server registration (021e).
- Any new hook lifecycle contract, event, or normalized shape. PRD-019b owns the contract; this wires its prod implementations.

## User stories

- As a developer, I want a real hook event to reach the daemon so that my coding turns are actually captured, not dropped at a stubbed client.
- As a developer using Claude Code, I want its `hooks.json` to invoke the real bundle so that capture, context, and session-end all fire from my editor.
- As a developer, I want session start to render prior context and drain my notifications so that I begin each session with recalled memory and any pending warnings.
- As a maintainer, I want one reference harness fully wired so that adding the next harness is a shim, not a re-derivation of the runtime.

## Functional requirements

- FR-1: The production `DaemonHookClient` POSTs to the loopback daemon's `/api/hooks/*` endpoints and stamps the `x-honeycomb-runtime-path` header, so the daemon enforces one active runtime path per session (409 on conflict).
- FR-2: The production `CredentialReader` reads `~/.honeycomb/credentials.json` so the hook runtime speaks as the same authenticated identity the CLI login wrote and the daemon reads.
- FR-3: A real `ContextRenderer` replaces the deferred stub, rendering the recalled context the daemon returns into the harness-appropriate channel.
- FR-4: Each per-harness binary entry point (`harnesses/<h>/src/index.ts`, currently a stub) parses the native hook payload, passes it through the 019c shim normalize, into the 019b core (`runSessionStart`, `runCapture`, `runPreToolUse`, `runSessionEnd`), and out through the `DaemonHookClient`.
- FR-5: The two un-attached daemon hook endpoints are attached: `/api/hooks/context` and `/api/hooks/session-end`, alongside the already-attached `/api/hooks/capture`, so all three lifecycle calls reach the daemon.
- FR-6: The 020d notifications pipeline is drained on `SessionStart`, so a session begins with the primary banner and any pending warnings under the existing fail-soft, bounded model.
- FR-7: Claude Code is the first fully-wired reference harness: its `hooks.json` and marketplace-plugin actually invoke the bundle, so its native lifecycle events drive the runtime end-to-end.
- FR-8: The other harnesses are sequenced as fast-follows behind the Claude Code reference, each reusing the same `DaemonHookClient`, `CredentialReader`, and `ContextRenderer` rather than re-deriving the runtime.
- FR-9: The production runtime reuses the proven `tests/composition/` adapter pattern as its production shape, so the wiring matches the shape the composition tests already exercise.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a native hook event from a wired harness, when the binary runs, then the payload is normalized through the 019c shim, processed by the 019b core, and POSTed by the `DaemonHookClient` with the `x-honeycomb-runtime-path` header. |
| AC-2 | Given a logged-in user, when a hook runs, then the `CredentialReader` reads `~/.honeycomb/credentials.json` and the call speaks as the same identity as the daemon and CLI. |
| AC-3 | Given the daemon, when it is assembled, then `/api/hooks/context` and `/api/hooks/session-end` are attached alongside `/api/hooks/capture` so all three lifecycle calls reach it. |
| AC-4 | Given a session start, when the runtime fires, then prior context is rendered by the real `ContextRenderer` and the 020d notifications pipeline is drained. |
| AC-5 | Given Claude Code is set up, when a turn occurs, then its `hooks.json` invokes the bundle and the native lifecycle events drive the runtime end-to-end. |
| AC-6 | Given a second harness wired as a fast-follow, when its binary runs, then it reuses the same `DaemonHookClient`, `CredentialReader`, and `ContextRenderer` without re-deriving the runtime. |

## Implementation notes

- The three deferred seams (`DaemonHookClient`, `CredentialReader`, `ContextRenderer`) are the 019b prod implementations every CONVENTIONS note pointed at; this sub-PRD supplies them so the 019b core has real edges instead of fakes.
- Attaching `/api/hooks/context` and `/api/hooks/session-end` is wiring, not contract change: the handlers exist and the capture endpoint is already attached; the composition root (021a) calls `attachHooksHandlers` once and these two join it.
- Claude Code is the reference because its hook model is the cleanest fit for the normalized contract; once it is proven end-to-end, the remaining harnesses are shims over the same runtime. Honest deferral of the long tail is allowed, but the end-to-end proof on Claude Code is required for this PRD. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-019b hook lifecycle core (`runSessionStart`, `runCapture`, `runPreToolUse`, `runSessionEnd`) and the deferred client, reader, and renderer seams.
- PRD-019c per-harness shims that normalize native payloads.
- PRD-021a composition root that calls `attachHooksHandlers` and attaches the three endpoints.
- PRD-020d notifications pipeline drained on session start.
- PRD-021b CLI `setup`/`connect` that installs the harness hook config and the credential file.

## Open questions

- [ ] Which harnesses are in scope for this PRD's acceptance versus fast-follow (shared with the index)?
- [ ] Should the `ContextRenderer` channel (model-only versus user-visible) be normalized or surfaced per harness (carried from 019)?
- [ ] How should a 409 runtime-path conflict surface to the user during a real session?

## Related

- [parent index](./prd-021-go-live-index.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
