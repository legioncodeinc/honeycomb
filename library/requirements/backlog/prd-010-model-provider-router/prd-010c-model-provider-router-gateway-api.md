# PRD-010c: Gateway and Native API

> **Parent:** [PRD-010](./prd-010-model-provider-router-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The two HTTP surfaces the daemon exposes for routed inference on port 3850: a native inference API (status, history, explain, execute, stream, cancel) and an OpenAI-compatible gateway so existing OpenAI clients get routed inference for free. Both surfaces are thin HTTP wrappers over the routing engine (PRD-010b); harnesses reach inference only through these surfaces and never hold credentials or talk to DeepLake directly. The daemon on port 3850 is the only DeepLake client.

## Goals

- Expose routed, policy-governed inference over HTTP so harnesses are thin clients over the daemon.
- Let an existing OpenAI client point at the daemon and get routed inference without rewriting the client.
- Provide an explain endpoint that returns the routing decision without executing, for debugging and dry runs.
- Stream completions over SSE and support cancellation of active streams.

## Non-Goals

- Deciding routes or gating (PRD-010b owns the decision; these surfaces invoke it).
- Parsing config (PRD-010a).
- CLI verbs and telemetry storage (PRD-010d).
- Adding non-OpenAI gateway dialects; only the OpenAI-compatible shape is in scope.

## User stories

- As a harness developer, I want to point an existing OpenAI client at the daemon so that I get routed, policy-governed inference without rewriting my client.
- As a debugger, I want an explain endpoint so that I can see the routing decision without spending a real inference call.
- As an operator, I want a cancel endpoint so that I can stop a runaway stream.

## Functional requirements

- FR-1: The daemon MUST serve the native inference API on port 3850 with `GET /api/inference/status`, `GET /api/inference/history`, `POST /api/inference/explain`, `POST /api/inference/execute`, `POST /api/inference/stream`, and `DELETE /api/inference/requests/:id`.
- FR-2: `POST /api/inference/explain` MUST return the routing decision (chosen target, gating outcome) without executing the request.
- FR-3: `POST /api/inference/execute` MUST run routed inference through the engine and return the result plus the recorded attempt sequence.
- FR-4: `POST /api/inference/stream` MUST stream a routed completion over SSE, and `DELETE /api/inference/requests/:id` MUST cancel an active stream by id.
- FR-5: `GET /api/inference/history` MUST return redacted routing and fallback decisions when telemetry is on, without secrets or request bodies.
- FR-6: The daemon MUST serve an OpenAI-compatible gateway with `GET /v1/models` and `POST /v1/chat/completions`, the latter supporting streaming.
- FR-7: A `POST /v1/chat/completions` request from a standard OpenAI client MUST route through the same engine as the native API, so the gateway is a shape adapter, not a second router.
- FR-8: Every surface MUST clamp request bodies and headers and redact errors before returning, so oversized or malformed input is bounded and provider errors never leak secrets.
- FR-9: All surfaces MUST resolve through the routing engine only; they MUST NOT hold credentials or access DeepLake or `.secrets/` directly.
- FR-10: Requests MUST be scoped to the calling org/workspace and `agent_id` so a harness cannot route under another agent's policy.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the native API, when a client calls `POST /api/inference/explain`, then it returns the routing decision without executing the request. |
| AC-2 | Given the gateway, when a client calls `POST /v1/chat/completions` with streaming, then routed inference streams back over SSE. |
| AC-3 | Given a stock OpenAI client pointed at the daemon, when it lists models via `GET /v1/models`, then it receives the routable targets and can complete a chat call. |
| AC-4 | Given an active stream, when `DELETE /api/inference/requests/:id` is called, then the stream is cancelled. |
| AC-5 | Given an oversized request body, when it hits any surface, then it is clamped within limits and the provider error, if any, is redacted before return. |
| AC-6 | Given telemetry on, when `GET /api/inference/history` is called, then it returns route and fallback decisions with secrets and bodies stripped. |

## Implementation notes

- All endpoints served by the daemon on port 3850. Native: `/api/inference/status|history|explain|execute|stream`, `DELETE /api/inference/requests/:id`. Gateway: `GET /v1/models`, `POST /v1/chat/completions`.
- Request bodies and headers are clamped and errors redacted before return; exact clamp limits are an open question below.
- The gateway is a thin shape adapter mapping OpenAI request/response to the engine's internal call, reusing the same gates and fallback.

## Dependencies

- PRD-010b routing engine (decision, execution, attempt sequence).
- PRD-010a config contract (for `GET /v1/models` listing).
- PRD-010d telemetry store (for `GET /api/inference/history`).
- Daemon HTTP server on port 3850.

## Open questions

- [ ] What are the exact clamp limits for request body size and header count/size?
- [ ] How are OpenAI model names mapped to internal targets in `GET /v1/models` and chat requests?

## Related

- [parent index](./prd-010-model-provider-router-index.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
