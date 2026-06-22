# PRD-003e: Agents, Auth, and Telemetry Tables

> **Parent:** [PRD-003](./prd-003-core-data-model-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S

## Scope

Define the within-workspace and operations tables on DeepLake: `agents` (the roster that drives read-policy enforcement), `api_keys` (named, revocable, hashed credentials for remote connectors), and the telemetry tables (opt-in usage counters and an optional recall QA ledger, plus the router's redacted routing history). All are `USING deeplake` tables written only by the daemon on port 3850. Org and workspace identity is carried on every request and resolved by DeepLake, so these tables focus on within-workspace policy and local operations.

## Goals

- Declare `agents` as the within-workspace roster with a `read_policy` (`isolated`, `shared`, `group`) and a `policy_group` that drive scoping enforcement.
- Declare `api_keys` as hashed, revocable credentials with role, scope, optional explicit permission list, and connector/harness/agent binding.
- Declare the telemetry tables as opt-in and local, carrying counters and the redacted router history, never secrets or request bodies.
- Keep every table converging through the shared column-definition array and lazy heal pass.

## Non-Goals

- The auth flow, token issuance, and permission middleware that consume `api_keys` and `agents` (auth module, PRD-004a route scaffolding).
- The model and provider router that emits routing history (router module); this declares only the landing table.
- The org/workspace tenancy resolution itself (handled at the storage partition layer).
- The storage adapter primitives (PRD-002).

## User stories

- As auth, I want an `agents` roster with a `read_policy` so within-workspace scoping can resolve who may read what.
- As an operator, I want `api_keys` stored hashed and revocable so a leaked remote-connector credential can be rotated without touching others.
- As a diagnostician, I want opt-in local telemetry counters so I can triage recall quality and router behavior without ever capturing secrets or request bodies.

## Functional requirements

- FR-1: The catalog defines `agents` with `id`, `name`, `read_policy` (default `'isolated'`), `policy_group`, `created_at`, `updated_at`.
- FR-2: `read_policy` is one of `isolated`, `shared`, or `group`; a `group` policy uses `policy_group` to bound which agents share visibility.
- FR-3: The catalog defines `api_keys` with `id`, `name`, a hashed key value (never plaintext), `role`, `scope`, an optional explicit `permissions` list, a `connector`/`harness`/`agent` binding, a `revoked` flag, `created_at`, and `last_used_at`.
- FR-4: `api_keys` are revocable by advancing `revoked` rather than deleting in place, consistent with the DeepLake soft-delete pattern.
- FR-5: The catalog defines a telemetry usage-counter table (opt-in) with counter name, value, and window, used for diagnostics only.
- FR-6: The catalog defines an optional recall QA ledger table recording recall outcomes for tuning, carrying no request bodies or secrets.
- FR-7: The router's redacted routing history lands in a telemetry table with model, provider, workload, and outcome, with prompt content redacted.
- FR-8: All writes go through the daemon escaping helpers and lazy heal; each table is created on first write from its column-definition array.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an agent, when defined, then `agents` carries `read_policy` (`isolated`, `shared`, `group`) and a `policy_group`. |
| AC-2 | Given a remote connector credential, when stored, then `api_keys` holds a hashed key with role, scope, optional permission list, and connector/harness/agent binding. |
| AC-3 | Given an API key is revoked, when the revocation runs, then `revoked` is advanced and the row is retained for audit rather than deleted in place. |
| AC-4 | Given telemetry is opt-in and a counter is recorded, then no secret or request body is written to any telemetry table. |
| AC-5 | Given the router routes a workload, when history is recorded, then the telemetry row carries model, provider, workload, and outcome with prompt content redacted. |
| AC-6 | Given a `group` read policy, when scoping resolves, then `policy_group` bounds which agents share visibility. |
| AC-7 | Given any of these tables does not exist, when the first write runs, then it is created from its column-definition array and the write retries once. |

## Implementation notes

- Daemon modules: schema definition module owns the column-definition arrays; the auth module writes `api_keys` and `agents`; the router writes routing history; diagnostics write usage counters and the QA ledger.
- DeepLake write patterns: `agents` and `api_keys` are UPDATE-or-INSERT by key with revocation as a status advance; telemetry tables are append-only INSERT.
- Telemetry column shapes are defined as counter rows (name/value/window) and a redacted router-history row (model/provider/workload/outcome); the recall QA ledger is optional and additive.
- Edge cases: a hashed `api_keys` value is computed before interpolation; `last_used_at` updates accept the UPDATE-coalescing trade-off for the rare concurrent touch.
- Failure handling: missing-table or missing-column writes heal and retry once; permission errors are classified distinctly from schema gaps.

## Dependencies

- PRD-002 storage adapter and SQL helpers.
- Auth module (consumer of `api_keys` and `agents`); router module (producer of routing history).
- PRD-007 retrieval and scoping enforcement (consumer of `agents` read policy).

## Open questions

- [ ] Should the recall QA ledger be enabled by default in `local` mode or strictly opt-in everywhere?
- [ ] What retention window applies to redacted router history before it is swept?

## Related

- [parent index](./prd-003-core-data-model-index.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
