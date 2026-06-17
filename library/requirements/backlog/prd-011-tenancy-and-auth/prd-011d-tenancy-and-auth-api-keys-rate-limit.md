# PRD-011d: API Keys and Rate Limiting

> **Parent:** [PRD-011](./prd-011-tenancy-and-auth-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

Named, revocable API keys for remote connectors (hashed at rest, prefixed `hc_sk_`, printed once, role-bound and permission-narrowable) plus sliding-window rate limiting keyed by caller, with tighter limits on expensive operations. This PRD supplies the connector authentication path and the abuse controls that sit at the end of the request pipeline defined in PRD-011c.

## Goals

- Let remote connectors authenticate with named API keys rather than user tokens, with keys that are revocable and stored hashed.
- Print a new key's plaintext exactly once and store only a scrypt-salted hash in the `api_keys` table.
- Default connector keys to the narrow permission set of recall, remember, and documents, while allowing a role and an explicit permission list.
- Protect a shared daemon (port 3850) with sliding-window rate limiting in `team` and `hybrid` modes, with tighter limits on expensive and abuse-prone operations.

## Non-Goals

- The roles and permission sets themselves (PRD-011c); this PRD binds keys to those roles.
- Device-flow user tokens (PRD-011b).
- The secrets subsystem (PRD-012); API keys are not secrets-store material.
- Persisting rate-limit windows across restarts (out of scope for v1; resets on restart).

## User stories

- As an integrator, I want a connector API key scoped to recall/remember/documents so that a connector reads and writes memory but cannot run admin operations.
- As a team admin, I want to revoke a leaked key immediately so that a compromised connector loses access without rotating every other credential.
- As an operator, I want expensive routes rate-limited the moment the daemon is shared so a runaway connector cannot exhaust the backend.

## Functional requirements

- FR-1: An API key MUST be prefixed `hc_sk_`, generated with sufficient entropy, and returned in plaintext exactly once at creation; only a scrypt-salted hash MUST be persisted in the `api_keys` table.
- FR-2: A key MUST carry a role (PRD-011c) and MAY be narrowed with an explicit permission list; the connector default MUST be the set recall, remember, documents.
- FR-3: A key MAY bind to a connector, harness, agent, and allowed projects; a request using the key that targets a value outside its bindings MUST be denied.
- FR-4: Keys MUST be revocable, and a revoked key MUST be rejected on the next request without affecting other keys.
- FR-5: Authentication MUST accept a key as an alternative to a Bearer token in `team` and `hybrid` modes; key authentication MUST yield the same permission and scope checks as a token of the equivalent role.
- FR-6: Rate limiting MUST be a sliding window keyed by the caller (token subject or API key), with unauthenticated requests sharing a single `anonymous` bucket.
- FR-7: Rate limiting MUST be active only in `team` and `hybrid` modes and MAY reset on daemon restart.
- FR-8: Expensive and abuse-prone operations (forget, batch operations, admin, inference execution and gateway, LLM-backed recall) MUST carry tighter per-route limits than ordinary reads.
- FR-9: A caller exceeding its window MUST receive `429` with a `Retry-After` header indicating when it may retry.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a created API key, when it is returned, then the plaintext is printed once and only a scrypt-salted hash is stored in the `api_keys` table. |
| AC-2 | Given a caller exceeding its sliding-window limit on an expensive route, when the next request arrives, then it gets `429` with a `Retry-After` header. |
| AC-3 | Given a connector key with default permissions, when it calls an admin route, then it gets `403`. |
| AC-4 | Given a revoked key, when it is presented on the next request, then it is rejected while other keys continue to work. |
| AC-5 | Given `local` mode, when many requests arrive, then no rate limit is applied. |
| AC-6 | Given a key bound to `project=alpha`, when a request targets `project=beta`, then it is denied. |

## Implementation notes

- Keys carry a role and optional explicit permission list and can bind to a connector, harness, agent, and allowed projects; connector default is recall/remember/documents.
- Rate limiting is active in `team` and `hybrid` only and resets on restart; confirm per-route limit values before GA.
- Hashing uses scrypt with a per-key salt; never log or persist the plaintext after the one-time display.
- The rate-limit stage runs at the end of the request pipeline (after permission and scope checks in PRD-011c); the `429` is the last gate before the handler.
- The `api_keys` table is additive; see the data-layer schema doc for column shapes.

## Dependencies

- PRD-011c for roles, permission sets, and the request pipeline position of the rate-limit stage.
- PRD-011b/PRD-011a for the tenancy context a key inherits (org/workspace).
- DeepLake `api_keys` table (canon: the daemon on port 3850 is DeepLake's only client).

## Open questions

- [ ] Do rate-limit windows persist across daemon restarts, or is reset-on-restart acceptable for v1?
- [ ] What are the exact per-route limit values for the expensive operation group?

## Related

- [parent index](./prd-011-tenancy-and-auth-index.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
- [Credential Storage](../../../knowledge/private/security/credential-storage.md)
