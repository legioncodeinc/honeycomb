# PRD-019: Harness Integrations

> **Status:** Backlog
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** None

---

## Overview

Honeycomb runs underneath the coding harnesses people already use and gives them one shared memory layer. The memory logic lives once in the daemon (port 3850), the only DeepLake client, and every harness reaches it through three thin-client surfaces: an install-time connector that patches config, writes hook handlers, and links skills; runtime plugins or extensions that handle lifecycle and expose tools; and lifecycle hooks that call the daemon's `/api/hooks/*` endpoints. This module covers the shared connector base, the lifecycle hook contract, the per-harness shims across the full union matrix, the MCP server and tool surface, and the typed `@honeycomb/sdk`. Adding a harness means writing a shim, not a memory engine.

## Goals

- A shared connector base with install/uninstall that every per-harness connector extends, preserving foreign config and staying idempotent.
- One normalized lifecycle hook contract (session-start, user-prompt-submit, pre/post-compaction, session-end) that all shims map their native events onto.
- Per-harness shims across the full union matrix that normalize payloads and route daemon responses back through each harness's response format.
- An MCP server inside the daemon exposing the unified `honeycomb_` tool surface, plus a typed SDK with React, Vercel AI SDK, and OpenAI helpers.

## Non-Goals

- Memory engine internals: capture writes, retrieval ranking, summary generation (covered by their own modules).
- DeepLake storage and tenancy logic (the daemon owns these).
- The Cursor editor extension UX surface (covered by the surfaces module).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-019a-harness-integrations-connector-base`](./prd-019a-harness-integrations-connector-base.md) | Shared connector base plus install/uninstall. | Draft |
| [`prd-019b-harness-integrations-hook-lifecycle`](./prd-019b-harness-integrations-hook-lifecycle.md) | Lifecycle hook contract across the session lifecycle. | Draft |
| [`prd-019c-harness-integrations-harness-shims`](./prd-019c-harness-integrations-harness-shims.md) | Per-harness shims for the full union matrix. | Draft |
| [`prd-019d-harness-integrations-mcp-server`](./prd-019d-harness-integrations-mcp-server.md) | MCP server plus tool surface. | Draft |
| [`prd-019e-harness-integrations-sdk`](./prd-019e-harness-integrations-sdk.md) | `@honeycomb/sdk` typed client plus React/Vercel/OpenAI helpers. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given any supported harness, when `honeycomb setup` or `honeycomb connect <harness>` runs, then its connector patches config, writes hook handlers, links skills, and uninstall cleanly reverses only Honeycomb's changes. |
| AC-2 | Given a harness fires a native lifecycle event, when its shim runs, then the event and payload are normalized to the shared shape and the call reaches the daemon's `/api/hooks/*` with the `x-honeycomb-runtime-path` header. |
| AC-3 | Given a harness that speaks MCP, when the MCP server is reachable, then the unified `honeycomb_` tool surface appears in its native tool list and every tool handler routes through the daemon API. |

## Data model changes

None. All surfaces are thin clients; storage and schema are owned by the daemon and the storage modules.

## API changes

Additive surface for MCP tools (streamable HTTP at `/mcp` or stdio) and the SDK client wrapping existing daemon endpoints. The daemon enforces one active runtime path per session (`409` on conflict) via the `x-honeycomb-runtime-path` header. No breaking changes to existing hook endpoints.

## Open questions

- [ ] Which harnesses get a native runtime extension versus hooks-only, and where does the line sit for new entrants?
- [ ] How is the references gate (sibling-harness repo inspection) enforced in CI rather than by convention?
- [ ] Should the `additionalContext` channel difference (model-only vs user-visible) be normalized or surfaced per harness?

## Related

- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
