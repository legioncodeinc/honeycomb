# PRD-019e: Typed SDK and Framework Helpers

> **Parent:** [PRD-019](./prd-019-harness-integrations-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

`@honeycomb/sdk`, a typed HTTP client with no native dependencies (safe in Node, Bun, and the browser) wrapping the daemon API, plus React bindings, a Vercel AI SDK helper, and an OpenAI tool helper. This sub-PRD owns the public client surface, the typed error model, the retry policy, and the framework helper boundaries. It does not own the MCP server (019d), the daemon endpoints it wraps, or storage internals.

## Goals

- A typed `HoneycombClient` with no native dependencies that wraps the daemon API so applications get memory without speaking raw HTTP.
- Full coverage of the daemon surface the SDK is meant to reach: memory, hook entry points, connectors and documents, sources, skills and goals, health and diagnostics, and value-safe secrets.
- A typed error model and a retry policy that distinguishes idempotent reads from non-idempotent mutations.
- React bindings, a Vercel AI SDK helper, and an OpenAI tool helper that reuse the core client's token and API-key model.

## Non-Goals

- The MCP server and its tool surface (019d).
- Daemon endpoint implementation, storage, tenancy, and DeepLake access.
- The CLI (PRD-020a); the SDK is for application code, not the operator command line.
- Hook lifecycle behavior (019b); the SDK can call hook entry points but does not replace the hooks.

## User stories

- As an application developer, I want a typed client so that I get memory operations with explicit error handling instead of raw HTTP.
- As a frontend developer, I want React bindings so that I can call recall and remember from components without wiring fetch by hand.
- As an AI engineer, I want Vercel AI SDK and OpenAI tool helpers so that memory tools drop into my existing agent loop.

## Functional requirements

- FR-1: `HoneycombClient` is constructed with `daemonUrl`, optional `token` (for team and hybrid daemon modes), `actor`, and `actorType`, and uses only standard fetch so it runs in Node, Bun, and the browser with no native dependencies.
- FR-2: The client exposes ergonomic memory helpers including `remember(text, opts)` and `recall(query, opts)` that wrap the daemon endpoints and carry the configured token, actor, and actor type on every call.
- FR-3: The client covers the full intended surface: memory, hook entry points, connectors and documents, sources, skills and goals, health and diagnostics, and the value-safe secrets surface (names and redacted output only).
- FR-4: Errors are typed: an API error for non-2xx responses (with status and body), a network error for transport failures, and a timeout error when a request exceeds the configured budget.
- FR-5: GET requests retry on transient failure; mutating requests do not retry because they are not idempotent.
- FR-6: Every authenticated call carries the same token and API-key model as the rest of the daemon, and the client stamps the actor headers so SDK traffic is scoped and audited.
- FR-7: React bindings ship as a separate entry point providing hooks (for example a provider plus `useRecall`/`useRemember`) that wrap the core client and surface loading and typed-error state.
- FR-8: A Vercel AI SDK helper exposes Honeycomb memory as AI SDK tools, and an OpenAI tool helper exposes the same operations as OpenAI function-tool definitions, both reusing the core client and its token model.
- FR-9: The secrets surface in the SDK is value-safe: it can list names and exec with redacted output, never returning raw secret values.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the client, when `remember` and `recall` are called, then they wrap the daemon endpoints and carry the configured token, actor, and actor type. |
| AC-2 | Given a request fails, when the error surfaces, then it is typed (API error for non-2xx, network error for transport, timeout error past budget), and GET retries while mutating requests do not. |
| AC-3 | Given a browser, Node, and Bun runtime, when the client runs, then it works in all three with no native dependency. |
| AC-4 | Given the React bindings, when a component calls `useRecall`, then it gets results plus loading and typed-error state from the core client. |
| AC-5 | Given the Vercel AI SDK and OpenAI helpers, when memory tools are registered, then they reuse the core client's token and actor model. |
| AC-6 | Given the secrets surface, when it is used, then it returns names and redacted output only and never a raw value. |

## Implementation notes

- The SDK is one more thin client of the daemon; it never opens DeepLake and shares the auth token and API-key model documented in the auth architecture.
- The retry split (GET retries, mutations do not) mirrors the daemon's idempotency guarantees so the SDK never double-applies a non-idempotent write.
- Framework helpers ship as separate package entry points so the core client stays dependency-free for browser use.

## Dependencies

- Daemon API endpoints across memory, hooks, connectors/documents, sources, skills/goals, health/diagnostics, and secrets.
- Auth architecture for the token and API-key model.
- PRD-019d MCP server as the parallel on-demand surface (shared daemon API).

## Open questions

- [ ] Should the React, Vercel, and OpenAI helpers be separate published packages or subpath exports of `@honeycomb/sdk`?
- [ ] What is the default timeout budget and is it per-call configurable as well as client-wide?

## Related

- [parent index](./prd-019-harness-integrations-index.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
