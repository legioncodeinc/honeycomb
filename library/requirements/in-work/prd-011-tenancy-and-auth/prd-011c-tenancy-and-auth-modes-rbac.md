# PRD-011c: Modes and RBAC

> **Parent:** [PRD-011](./prd-011-tenancy-and-auth-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The three daemon auth modes (local, team, hybrid) and the four RBAC roles (admin, operator, agent, readonly) checked on every protected route, with a fail-closed posture when socket info or scope is ambiguous. This PRD decides what an authenticated caller may touch; identity comes from PRD-011b and connector keys plus rate limiting from PRD-011d.

## Goals

- Support a single-user `local` setup and a shared `team` deployment with one daemon (port 3850) by gating every protected route on the active mode.
- Trust localhost in `hybrid` mode by TCP socket peer address (not the spoofable `Host` header) while requiring a token for remote clients.
- Map four roles to permission sets and check one on every protected route in `team` and `hybrid` modes.
- Keep the posture fail-closed: ambiguous socket info, malformed scope, or malformed role must never widen access.

## Non-Goals

- Minting tokens or the device flow (PRD-011b).
- Named API keys and rate limiting (PRD-011d), though this PRD defines where their checks slot into the request pipeline.
- The storage-layer org/workspace isolation (PRD-011a) and the `agent_id` read policy (PRD-011e); RBAC is the request-level outer check that precedes them.

## User stories

- As an operator, I want a hybrid mode that trusts localhost by socket peer address but requires a token for remote clients so that local dev stays frictionless while a shared daemon stays locked down.
- As a single developer, I want `local` mode with no auth bound to localhost so I am not fighting tokens on my own machine.
- As a team admin, I want a `readonly` role that can recall but never write so I can hand out safe read access.

## Functional requirements

- FR-1: The daemon MUST support three modes: `local` (no auth, binds to localhost, full access), `team` (every request needs a valid Bearer token or API key, all scoped and rate-limited), and `hybrid` (localhost trusted by socket, remote requires token).
- FR-2: In `team` and `hybrid` modes, an unauthenticated request to a protected route MUST receive `401`; an authenticated request lacking the required permission MUST receive `403`.
- FR-3: In `hybrid` mode, localhost trust MUST be derived from the TCP peer address on the socket, never from the `Host` header; when socket peer info is unavailable, the request MUST fail closed and require a token.
- FR-4: The daemon MUST implement four roles with these permission sets: `admin` (everything, including token creation, org/workspace admin, secret operations), `operator` (remember, recall, modify, forget, recover, documents, connectors, diagnostics, analytics), `agent` (remember, recall, modify, forget, recover, documents), and `readonly` (recall only).
- FR-5: `agent` MUST be the default role for harness connectors, since an agent integration should read and write memory but not run admin operations.
- FR-6: Every route in the always-checked endpoint groups (admin/token operations, diagnostics, sources, connectors, secrets, ontology mutations, org/workspace admin) MUST perform an explicit permission check.
- FR-7: A token or key MAY carry a tighter `scope` of `project`, `agent`, or `user`; a request touching a different value for a set scope field MUST receive `403`. The `admin` role bypasses scope, and scope is ignored in `local` mode.
- FR-8: The permission check MUST run before the scope check, which runs before the rate-limit check (PRD-011d), matching the documented request pipeline.
- FR-9: A malformed role or scope MUST NOT widen access; the request fails closed with a structured error.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `hybrid` mode with no available socket peer info, when a request arrives, then it fails closed and requires a token rather than trusting the `Host` header. |
| AC-2 | Given a `readonly` role, when it calls a write route, then it gets `403`; the `admin` role passes all permission and scope checks. |
| AC-3 | Given `team` mode, when a request arrives without a valid Bearer token or API key, then it gets `401`. |
| AC-4 | Given `local` mode, when any request arrives on localhost, then it has full access and no token is required. |
| AC-5 | Given a token scoped to `project=alpha`, when a request targets `project=beta`, then it gets `403` unless the role is `admin`. |
| AC-6 | Given an `agent`-role connector, when it calls a connectors-admin or token route, then it gets `403`. |

## Implementation notes

- Modes: `local` (no auth, localhost bind), `team` (token/API key required, all scoped and rate-limited), `hybrid` (localhost-by-socket trusted, remote requires token).
- Endpoint groups always requiring an explicit check: admin/token ops, diagnostics, sources, connectors, secrets, ontology mutations, org/workspace admin.
- Request pipeline order: mode gate, then credential check (401), then permission check (403), then scope check (403), then rate limit (429, PRD-011d).
- This request-level scope is the outer ring; the storage-level org/workspace isolation (PRD-011a) and the `agent_id` read policy (PRD-011e) are enforced beneath it.

## Dependencies

- PRD-011b for the Bearer token that authenticates callers.
- PRD-011d for API-key authentication and the rate-limit stage that follows the scope check.
- PRD-011a and PRD-011e for the storage-layer enforcement that sits beneath these request checks.

## Open questions

- [ ] Should hybrid-mode localhost trust be configurable per-deployment, or always on when socket info is available?
- [ ] Do `operator` and `agent` need a per-route override mechanism, or are the fixed permission sets sufficient for v1?

## Related

- [parent index](./prd-011-tenancy-and-auth-index.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
