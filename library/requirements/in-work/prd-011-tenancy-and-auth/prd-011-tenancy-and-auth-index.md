# PRD-011: Tenancy and Auth

> **Status:** In-Work
> **Priority:** P0
> **Effort:** L
> **Schema changes:** Additive

---

## Overview

Honeycomb is team-shared and cloud-first, so tenancy and auth are foundational rather than bolted on. This module establishes the two-level tenancy that makes Honeycomb a team product (org and workspace, with isolation enforced at the DeepLake storage layer so two workspaces never share a row, partition, or index) plus the within-workspace `agent_id` read policy inherited from otherhive. It merges two auth stories: hivemind's device-flow login that binds durable storage to an org, and otherhive's RBAC that decides what an authenticated caller may touch. Login uses the OAuth 2.0 device flow, credentials persist in a `0600` file under the user's home, and a drifted org token heals on session start. The daemon runs in local, team, or hybrid mode, checks four roles on every protected route, accepts named API keys for connectors, and rate-limits expensive operations with a sliding window. The whole layer is fail-closed: when in doubt, deny.

## Goals

- Enforce org and workspace isolation at the storage layer, not only in the API, so a query in one workspace cannot reach another's rows.
- Establish identity through OAuth device flow, persist an org-bound token at mode `0600`, and heal org drift on session start.
- Gate every protected route by daemon mode (local/team/hybrid) and one of four RBAC roles.
- Authenticate connectors with named, revocable, hashed API keys and apply sliding-window rate limits to expensive operations.
- Scope reads within a workspace by `agent_id` and a read policy (isolated/shared/group) compiled into the memory query SQL.

## Non-Goals

- The secrets subsystem and encrypted secret store (PRD-012).
- DeepLake storage internals beyond the partition boundary that enforces tenancy.
- Designing new connector protocols; this module authenticates them, it does not define them.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-011a-tenancy-and-auth-org-workspace`](./prd-011a-tenancy-and-auth-org-workspace.md) | Org/workspace model and storage-layer partition isolation. | Draft |
| [`prd-011b-tenancy-and-auth-device-flow-auth`](./prd-011b-tenancy-and-auth-device-flow-auth.md) | Device-flow login, credentials file (0600), and drift healing. | Draft |
| [`prd-011c-tenancy-and-auth-modes-rbac`](./prd-011c-tenancy-and-auth-modes-rbac.md) | Local/team/hybrid daemon modes and RBAC roles. | Draft |
| [`prd-011d-tenancy-and-auth-api-keys-rate-limit`](./prd-011d-tenancy-and-auth-api-keys-rate-limit.md) | Named API keys and sliding-window rate limiting. | Draft |
| [`prd-011e-tenancy-and-auth-agent-scoping`](./prd-011e-tenancy-and-auth-agent-scoping.md) | `agent_id` read policies (isolated/shared/group) and the SQL scope clause. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given two workspaces in one org, when a recall runs in workspace A, then no row, partition, or index from workspace B is reachable even if the API filter were omitted. |
| AC-2 | Given a CLI login, when the user approves in the browser, then the daemon mints a long-lived org-bound token and the CLI saves `credentials.json` at mode `0600`. |
| AC-3 | Given `team` mode, when a request arrives without a valid Bearer token or API key, then it gets `401`; with a token but insufficient permission, `403`. |
| AC-4 | Given an `isolated` agent, when it recalls, then only its own non-archived memories are returned per the compiled scope clause. |

## Data model changes

Additive: `api_keys` table (hashed keys, role, permission list, bindings); `agents` roster rows carrying `read_policy` and optional `policy_group`. Org/workspace are storage-partition keys on existing tables.

## API changes

Additive: device-flow login endpoints, token/API-key admin routes, and org/workspace switch operations. Existing protected routes gain permission and scope checks.

## Open questions

- [ ] Should hybrid-mode localhost trust be configurable per-deployment, or always on when socket info is available?
- [ ] Do rate-limit windows persist across daemon restarts, or is reset-on-restart acceptable for v1?
- [ ] What is the default `read_policy` for a newly seen `agent_id` (isolated is the fail-closed default; confirm)?

## Related

- [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
- [Credential Storage](../../../knowledge/private/security/credential-storage.md)
