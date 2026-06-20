# PRD-022d: Assembly and Client Correctness (fire every seam, fix the two dogfood bugs)

> **Parent:** [PRD-022](./prd-022-data-access-api-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Wiring every data-API mount seam into the composition root and fixing the two client bugs the PRD-021 dogfood found. This sub-PRD owns firing each of the 022a, 022b, and 022c mount seams exactly once in `src/daemon/runtime/assemble.ts` `assembleSeams()`, after construction, extending the PRD-021 a-AC-2 exactly-once invariant to the data surface. It also owns the two client fixes: the loopback `DaemonClient` not stamping `x-honeycomb-session` for session-scoped verbs (so recall and remember 400 at the runtime-path middleware before reaching the handler), and a Windows libuv teardown crash on CLI exit. It confirms the SDK `recall()` and `remember()` and the MCP `memory_search` and `memory_store` tools now reach the wired endpoints. It does not own the handler bodies themselves (022a, 022b, 022c) or the end-to-end behavioral proof (022e).

## Goals

- Every data-API mount seam (memories, VFS browse, goals, KPIs, skills, rules, sources, secrets) fired exactly once in `assembleSeams()`, after construction.
- The PRD-021 a-AC-2 exactly-once invariant extended to the data-API seams, with seam-coverage tests proving each fires once.
- The loopback `DaemonClient` fixed to stamp `x-honeycomb-session` for session-scoped verbs, so recall and remember reach the handler rather than 400 at the runtime-path middleware.
- The Windows libuv teardown crash on CLI exit fixed, so a one-shot verb exits cleanly with no `UV_HANDLE_CLOSING` assertion and no exit 127.
- The SDK `recall()` and `remember()` and the MCP `memory_search` and `memory_store` tools confirmed to reach the wired endpoints.

## Non-Goals

- The handler bodies for memories (022a), VFS browse (022b), and product data (022c). This sub-PRD fires their seams and fixes the clients that call them; it does not implement the handlers.
- The end-to-end behavioral proof and the live golden path (022e).
- Any change to the PRD-021 composition-root order beyond adding the data-API seam firings after construction.
- The team-mode `x-honeycomb-org` hardening. Local single-user mode is the first-class path; the session header is the `x-honeycomb-session` fix, not the org header.

## User stories

- As a maintainer, I want every data-API seam fired exactly once by the composition root so that the exactly-once invariant PRD-021 established holds for the data surface too.
- As a developer, I want `honeycomb recall` to reach the handler instead of 400ing at the middleware so that the session-scoped verbs actually work from a one-shot CLI.
- As a developer on Windows, I want the CLI to exit cleanly so that a recall does not crash with a libuv assertion and exit 127 after returning its result.
- As a developer using the SDK, I want `client.recall()` and `client.remember()` to hit the wired endpoints so that the SDK is a real client, not a 501 caller.
- As an agent, I want the MCP `memory_search` and `memory_store` tools to reach the wired endpoints so that memory tools work against a real daemon.

## Functional requirements

- FR-1: Every data-API mount seam (`mountMemoriesApi`, the `/memory/*` browse mount, `/api/goals`, `/api/kpis`, `/api/skills`, `/api/rules`, `mountSourcesApi`, the secrets API mount) is fired in `src/daemon/runtime/assemble.ts` `assembleSeams()`, exactly once, after construction.
- FR-2: The exactly-once invariant is enforced by extending the PRD-021 a-AC-2 seam-coverage tests (`assemble.test.ts`) to assert each new data-API seam fires once and only once.
- FR-3: The loopback `DaemonClient` stamps the `x-honeycomb-session` header for session-scoped verbs, so a one-shot CLI recall or remember reaches the handler instead of 400ing at the runtime-path middleware.
- FR-4: The one-shot CLI mints or stamps a synthetic session id for session-scoped verbs, so a stateless invocation satisfies the session-group requirement without a prior session.
- FR-5: The Windows libuv teardown crash is fixed: the `UV_HANDLE_CLOSING` assertion (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit 127) on CLI exit no longer occurs, by closing the ensure-running spawn handles or the loopback client handles cleanly on exit.
- FR-6: The SDK `recall()` and `remember()` methods are confirmed to reach the wired `/api/memories/recall` and `/api/memories` endpoints, stamping the session header as the CLI does.
- FR-7: The MCP `memory_search` and `memory_store` tools are confirmed to reach the wired endpoints, stamping the session header, so the tool surface works against a real assembled daemon.
- FR-8: The thin-client invariant is preserved: the session-header and libuv fixes live in the loopback client and CLI exit path, not in the daemon handlers, so the clients stay thin.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `assembleSeams()`, when the daemon is assembled, then every data-API mount seam is fired exactly once after construction, proven by the extended `assemble.test.ts` coverage. |
| AC-2 | Given a one-shot `honeycomb recall`, when it runs, then the loopback `DaemonClient` stamps `x-honeycomb-session` and the request reaches the handler instead of 400ing at the runtime-path middleware. |
| AC-3 | Given a session-scoped verb from a stateless CLI invocation, when it runs, then a synthetic session id is minted and stamped so the session-group requirement is satisfied. |
| AC-4 | Given the CLI on Windows, when a verb completes, then it exits cleanly with no `UV_HANDLE_CLOSING` assertion and no exit 127. |
| AC-5 | Given the SDK `recall()` and `remember()`, when they run, then they reach the wired `/api/memories` endpoints with the session header stamped. |
| AC-6 | Given the MCP `memory_search` and `memory_store` tools, when they run, then they reach the wired endpoints with the session header stamped. |

## Implementation notes

- Firing the data-API seams is the same composition-root discipline PRD-021a established: fire after construction, exactly once, in a deterministic order, and prove it with seam-coverage tests. These seams join the capture, dashboard, notifications, and prune seams already fired.
- The session-header bug is the direct consequence of the 022a decision that `/api/memories` is a session group behind the runtime-path middleware: a one-shot CLI has no prior session, so it must mint and stamp a synthetic session id, or the request 400s before the handler. The open question of whether `/api/memories` should be a session group at all is carried at the index level; until it resolves, the client stamps the header.
- The libuv crash is a handle-teardown bug, most likely the ensure-running spawn (PRD-021b) or the loopback client not closing its handles cleanly on exit. The fix is to close handles deterministically on exit, not to suppress the assertion. Reproduce on Windows before and after, since exit 127 is platform-specific.
- This sub-PRD is the seam-and-client layer between the handlers (022a, 022b, 022c) and the proof (022e): once the seams fire and the clients stamp the header and exit cleanly, the dogfood can drive recall through the HTTP API. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-022a, PRD-022b, and PRD-022c mount seams that this fires.
- PRD-021a composition root (`assembleDaemon`, `assembleSeams`) and the a-AC-2 exactly-once invariant this extends.
- PRD-021b CLI runtime, the loopback `DaemonClient`, and the ensure-running spawn implicated in the libuv crash.
- PRD-011 runtime-path session middleware that requires `x-honeycomb-session`.
- PRD-019e SDK and PRD-019d MCP tool surface whose `recall`, `remember`, `memory_search`, and `memory_store` reach the wired endpoints.

## Open questions

- [ ] Should the one-shot CLI mint a per-invocation session id, or should `/api/memories` be reclassified as a non-session group, removing the need to stamp (shared with the index)?
- [ ] Is the libuv crash in the ensure-running spawn or the loopback client, and does it reproduce on non-Windows platforms under any condition?
- [ ] Should the synthetic session id be persisted for the duration of a multi-call CLI session, or minted fresh per invocation?

## Related

- [parent index](./prd-022-data-access-api-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
