# PRD-007c: Authorization Boundary

> **Parent:** [PRD-007](./prd-007-retrieval-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the authorization phase (phase 3 of recall): re-query the memory tables with the full scope before any content-bearing stage runs. The scope is two rings: the outer org/workspace partition enforced at the DeepLake storage layer, and the inner within-workspace `agent_id` read-policy clause, plus any type, tag, project, pinned, importance, or date filters the caller passed. Up to this phase only memory IDs have moved through collection (PRD-007a) and traversal (PRD-007b); this is the boundary that makes recall safe. It applies identically to scored recall and to the VFS browse surface.

## Goals

- Re-query the memory tables with the org/workspace partition and the agent read-policy clause to authorize candidates.
- Apply caller filters (type, tag, project, pinned, importance, date) as part of the same authorized re-query.
- Drop every unauthorized candidate before any content loads, so all later stages run on authorized rows only.
- Fail closed: a malformed or unknown caller falls back to `isolated`, never to a wider policy.
- Use the shared clause builder so a new code path either carries the scope clause or does not, keeping scoping auditable.

## Non-Goals

- Defining the read policies or the `agents` roster (PRD-003e / scoping doc); this phase consumes them.
- Collecting candidates (PRD-007a, PRD-007b) or shaping the authorized set (PRD-007d).
- Hydrating content rows (PRD-007e); this phase authorizes IDs, the gate hydrates.

## User stories

- As a security reviewer, I want content gated behind a scope re-query so that recall can never return a memory the requesting agent may not see.
- As a platform owner, I want the inner-ring scope compiled into a SQL clause every memory query carries so that scoping is auditable across code paths.
- As an operator, I want a malformed caller to fail closed to `isolated` so that a bug widens nothing.

## Functional requirements

- **FR-1** Authorization MUST re-query the memory tables with the full scope: the org/workspace partition plus the `agent_id` read-policy clause, taking the collected candidate IDs as input.
- **FR-2** The agent read-policy clause MUST be produced by the shared clause builder from the agent id, `read_policy`, and `policy_group`, returning the WHERE fragment plus its values escaped through the SQL helpers (the endpoint takes no bound parameters).
- **FR-3** The clause MUST implement the three policies: `isolated` (own memories only), `shared` (workspace-global plus own), and `group` (global from agents in the same `policy_group`, plus own), and MUST exclude archived memories in all three.
- **FR-4** Caller filters (type, tag, project, pinned, importance, date range) MUST be applied within the same authorized re-query, never as an unscoped pre-filter.
- **FR-5** The outer org/workspace partition MUST be enforced beneath the inner clause at the storage layer, so even a buggy clause cannot cross a workspace boundary.
- **FR-6** Any candidate that does not survive the scoped re-query MUST be dropped, and every content-bearing stage afterward (rerank, summaries, transcript expansion, access tracking) MUST run strictly on the authorized set.
- **FR-7** A malformed, missing, or unresolvable agent id MUST fall back to `isolated` rather than widening access, and the failure MUST return a structured error with context (org, workspace, agent id, route) rather than being swallowed.
- **FR-8** The same authorization boundary MUST apply to the VFS browse surface before any content is returned, so the explicit browse path cannot bypass the read policy.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given collected candidate IDs, when authorization runs, then the engine re-queries with the org/workspace partition and the `agent_id` read-policy clause plus caller filters. |
| AC-2 | Given an `isolated` agent, when authorization runs, then only its own non-archived memories survive. |
| AC-3 | Given a `group` agent, when authorization runs, then global memories from same-`policy_group` agents plus its own survive, archived excluded. |
| AC-4 | Given an unauthorized candidate, when the boundary applies, then it is dropped before any content loads. |
| AC-5 | Given a malformed agent id, when authorization runs, then it falls back to `isolated` and returns a structured error context, never a wider policy. |
| AC-6 | Given a buggy inner clause, when a cross-workspace ID is present, then the storage partition still prevents it from surfacing. |
| AC-7 | Given a VFS browse request, when content is requested, then the same scope clause authorizes rows before any content returns. |

## Implementation notes

- Ordering is the defense: wide-net channels produce IDs, then this phase authorizes, then content loads. A strong vector hit or a high-degree entity can surface an ID but cannot leak content past the read policy.
- The clause builder is the single chokepoint; reuse it everywhere a memory query is issued so scoping reviews are a search for the builder, not an audit of hand-written WHERE clauses.
- All interpolated values (agent id, policy group, filter values) route through `sqlStr`/`sqlLike`/`sqlIdent` because the DeepLake query endpoint has no parameterized queries.
- Fail-closed posture matches the request-level scope checks in auth-architecture and the trust model: when in doubt, deny.

## Dependencies

- PRD-003 DeepLake schema and the `agents` roster (read policy, policy group) plus the SQL escaping helpers.
- The shared scope clause builder (scoping-and-visibility).
- PRD-007a / PRD-007b (provide candidate IDs).
- PRD-007e (hydrates the authorized set).

## Open questions

- [ ] Does authorization re-fetch IDs in one batched query, or per-channel before merge?
- [ ] What structured error shape does an authorization failure return to the hook layer?

## Related

- [parent index](./prd-007-retrieval-index.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
