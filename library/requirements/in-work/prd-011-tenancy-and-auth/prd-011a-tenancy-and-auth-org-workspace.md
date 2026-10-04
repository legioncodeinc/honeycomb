# PRD-011a: Org and Workspace Model

> **Parent:** [PRD-011](./prd-011-tenancy-and-auth-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The two-level org and workspace tenancy with isolation enforced at the DeepLake storage layer, so two workspaces share no row, partition, or index, plus the credential and switching mechanics that carry tenancy on each request. This is the outer ring of scoping. The inner ring, the within-workspace `agent_id` read policy, lives in [PRD-011e](./prd-011e-tenancy-and-auth-agent-scoping.md).

## Goals

- Make org the billing and membership boundary and workspace the project boundary within an org, with workspace isolation enforced at the DeepLake storage partition rather than only in the API.
- Resolve org from the token claim and workspace from a `default` sentinel server-side, so every Honeycomb daemon (port 3850) request to DeepLake carries an unforgeable tenancy pair.
- Provide `honeycomb org switch`, `honeycomb workspace use`, and `honeycomb status` so a user can move between tenancy contexts predictably.
- Honor environment overrides (`HONEYCOMB_ORG_ID`, `HONEYCOMB_WORKSPACE_ID`, `HONEYCOMB_TOKEN`) for scripted and CI use, with documented precedence.

## Non-Goals

- DeepLake storage internals beyond the partition boundary that enforces tenancy (covered by data-layer docs, not this PRD).
- The within-workspace `agent_id` read policy and its SQL clause (PRD-011e).
- Device-flow login itself and the credentials file IO helpers (PRD-011b); this PRD consumes them.
- The secrets subsystem (PRD-012).

## User stories

- As a team admin, I want workspaces hard-isolated at storage so that two projects in my org can never see each other's memory even on a buggy code path.
- As a developer, I want `honeycomb status` to show my logged-in org, workspace, and agent so I always know which tenancy context a command will hit.
- As a CI engineer, I want `HONEYCOMB_ORG_ID` and `HONEYCOMB_WORKSPACE_ID` to override the credentials file so my pipeline never depends on local login state.

## Functional requirements

- FR-1: The daemon MUST resolve the active org from the `org_id` claim in the bearer token, never from a client-supplied header or body field, and MUST send the resolved org on every DeepLake request.
- FR-2: The workspace MUST be part of the DeepLake storage path resolution so that a query issued in workspace A cannot read a row, partition, or index belonging to workspace B, even when an API-level filter is omitted on a new code path.
- FR-3: The daemon MUST resolve workspace from the credentials `workspaceId`, treating the `default` sentinel as a server-side-resolved value rather than a literal partition name.
- FR-4: `honeycomb org switch <org>` MUST re-mint a fresh org-bound token, because the org is baked into the token claim, then persist the new token and org identity through the credential helpers.
- FR-5: `honeycomb workspace use <workspace>` MUST update only the credentials file `workspaceId`, with no token re-mint, since the workspace resolves server-side.
- FR-6: `honeycomb status` MUST display the logged-in org (id and name), the active workspace, and the resolved agent without exposing the raw token.
- FR-7: Tenancy resolution MUST apply this precedence: environment override (`HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` / `HONEYCOMB_TOKEN`), then the token claim and credentials file, then the `default` sentinel for workspace.
- FR-8: The daemon MUST re-validate `orgId` and `workspaceId` against the JWT and the storage layer on every request, so a tampered credentials file cannot widen a token's reach.
- FR-9: Any tenancy resolution failure MUST fail closed: the request is denied with a structured error carrying path, org, and workspace context rather than falling back to a broader scope.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a request, when it reaches DeepLake, then the resolved org is sent and the workspace is part of the storage path so cross-workspace reads are impossible. |
| AC-2 | Given two workspaces in one org, when a recall runs in workspace A with its API filter deliberately removed, then no row, partition, or index from workspace B is reachable. |
| AC-3 | Given `honeycomb org switch acme`, when it runs, then a fresh org-bound token is re-minted and saved; `honeycomb workspace use backend` updates the credentials file only. |
| AC-4 | Given `HONEYCOMB_ORG_ID` and `HONEYCOMB_WORKSPACE_ID` set, when any command runs, then those values override the credentials file. |
| AC-5 | Given a credentials file edited to claim a different `orgId` than the JWT, when a request arrives, then the daemon rejects it rather than honoring the file. |
| AC-6 | Given `honeycomb status`, when it runs while logged in, then it prints org id, org name, workspace, and agent, and never prints the bearer token. |

## Implementation notes

- Org comes from the token claim; workspace resolves server-side from the `default` sentinel. The partition key shape combines org and workspace; see the data-layer DeepLake storage doc for the exact path resolution.
- Environment overrides (`HONEYCOMB_ORG_ID`, `HONEYCOMB_WORKSPACE_ID`, `HONEYCOMB_TOKEN`) take precedence for CI; document the precedence order in the CLI help text.
- Reuse the credential IO helpers from PRD-011b (`loadCredentials` / `saveCredentials`); this PRD must not touch the credentials file directly outside those helpers.
- `agent_id` resolution (request body, then harness session key, then `default`) is shared with PRD-011e; do not hardcode a tenancy value when a real one is known.

## Dependencies

- PRD-011b (device-flow auth) for the org-bound token and the credential helpers that persist tenancy.
- PRD-011e (agent scoping) consumes the resolved workspace context to apply the inner-ring read policy.
- DeepLake storage layer for partition path resolution (canon: DeepLake is the SQL/Vector store; the daemon on port 3850 is its only client).

## Open questions

- [ ] Confirm the exact partition key shape (org + workspace composite vs. nested path) with the data-layer owners.
- [ ] Should switching to a workspace that does not yet exist auto-create it or error?

## Related

- [parent index](./prd-011-tenancy-and-auth-index.md)
- [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
- [Credential Storage](../../../knowledge/private/security/credential-storage.md)
