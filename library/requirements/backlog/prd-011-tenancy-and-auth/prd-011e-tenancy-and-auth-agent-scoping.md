# PRD-011e: Agent Scoping

> **Parent:** [PRD-011](./prd-011-tenancy-and-auth-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The within-workspace `agent_id` read policy (isolated/shared/group) compiled into a SQL WHERE clause that every memory query carries, with recall authorizing candidate IDs before any content loads. This is the inner ring of scoping. The outer ring, storage-layer org/workspace isolation, lives in [PRD-011a](./prd-011a-tenancy-and-auth-org-workspace.md); both rings must hold for a row to be visible.

## Goals

- Thread `agent_id` through every read and write that touches user data inside a workspace, resolving it consistently across memories, ontology, sources, sessions, analytics, and diagnostics.
- Compile the three read policies (isolated, shared, group) into a SQL WHERE fragment with values escaped through the DeepLake string helpers, since DeepLake takes no bound parameters.
- Authorize candidate memory IDs from recall's wide-net channels before any content-bearing stage loads, so a strong vector hit cannot leak content past the policy.
- Keep the inner ring fail-closed: a malformed caller falls back to `isolated`, and archived memories are always excluded.

## Non-Goals

- The outer-ring org/workspace storage isolation (PRD-011a), which is enforced beneath this clause.
- Request-level RBAC, modes, and scope (PRD-011c); this PRD is the storage-side enforcement that follows them.
- Designing the recall retrieval channels themselves; this PRD inserts the authorization boundary into the existing recall flow.

## User stories

- As a team, I want a shared read policy so that my agents see workspace-global memory plus their own while a CI agent keeps an isolated private lane.
- As an engineering lead, I want a group policy so a set of agents in one `policy_group` share their global memories without exposing them to agents outside the group.
- As a security reviewer, I want scoping compiled into the query SQL so a new code path either includes the clause or visibly does not, which makes enforcement auditable.

## Functional requirements

- FR-1: Every memory query MUST carry the compiled scope clause; the daemon MUST resolve `agent_id` from an explicit request field, then a harness session key (for example OpenClaw's `agent:alice:...` form), then the `'default'` sentinel.
- FR-2: The clause builder MUST accept the agent id, read policy, and optional policy group, and return the WHERE fragment plus its escaped values, escaped via the DeepLake string helpers (no bound parameters).
- FR-3: The `isolated` policy MUST emit `AND m.agent_id = '<id>' AND m.visibility != 'archived'`.
- FR-4: The `shared` policy MUST emit `AND (m.visibility = 'global' OR m.agent_id = '<id>') AND m.visibility != 'archived'`.
- FR-5: The `group` policy MUST emit a clause restricting global rows to agents whose `policy_group` matches, OR the agent's own rows, with archived excluded, reading the group membership from the `agents` table.
- FR-6: Archived memories MUST be excluded under all three policies.
- FR-7: Recall's candidate channels (full-text, vector, graph traversal, hints) MUST produce memory IDs only; the scope clause MUST authorize those candidates before any content-bearing stage (rerank, summaries, transcript expansion, access tracking) runs.
- FR-8: A malformed caller MUST fall back to `isolated`; the code MUST never hardcode `'default'` for a scoped path when a real agent id is known.
- FR-9: Cross-agent links, proposal applies, and claim updates MUST be explicitly rejected or handled, never silently allowed; scope failures MUST return structured errors carrying org, workspace, and agent id.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an agent's `read_policy` and `policy_group`, when a memory query runs, then the clause builder emits the matching WHERE fragment with values escaped via the DeepLake string helpers. |
| AC-2 | Given recall's candidate channels (FTS, vector, traversal), when they return IDs, then the scope clause authorizes those IDs before any content-bearing stage loads, so a strong vector hit cannot leak content past the policy. |
| AC-3 | Given an `isolated` agent, when it recalls, then only its own non-archived memories are returned. |
| AC-4 | Given a `shared` agent, when it recalls, then it sees workspace-global memories plus its own, with archived excluded. |
| AC-5 | Given a `group` agent, when it recalls, then it sees global memories from agents in the same `policy_group` plus its own, with archived excluded. |
| AC-6 | Given a malformed or missing read policy, when a query runs, then the builder falls back to `isolated`. |

## Implementation notes

- Policies: `isolated` (own only, fail-closed default), `shared` (global plus own), `group` (group-global plus own); archived always excluded.
- A malformed caller falls back to `isolated`. Never hardcode `'default'` for a scoped path when a real agent id is known.
- The clause builder is the single source of the WHERE fragment; every memory query routes through it so enforcement is auditable.
- The `agents` roster row carries `read_policy` and optional `policy_group` (additive schema). The default `read_policy` for a newly seen `agent_id` is `isolated`.
- DeepLake takes no bound parameters, so all interpolated values pass through the storage-layer string-escape helpers; never build the clause with raw concatenation.

## Dependencies

- PRD-011a for the outer-ring org/workspace partition enforced beneath this clause.
- DeepLake storage layer for the string-escape helpers and the `agents` table (canon: the daemon on port 3850 is DeepLake's only client).
- The recall retrieval flow into which the authorization boundary is inserted.

## Open questions

- [ ] Confirm `isolated` as the default `read_policy` for a newly seen `agent_id`.
- [ ] Should writes (not just reads) carry an analogous policy, or is write always scoped to the calling `agent_id`?

## Related

- [parent index](./prd-011-tenancy-and-auth-index.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
- [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)
