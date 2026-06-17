# PRD-002a: DeepLake Client and Connection

> **Parent:** [PRD-002](./prd-002-deeplake-storage-adapter-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the typed DeepLake client that the daemon uses as its single storage entry point: connection setup, config resolution, and the per-request org resolution that DeepLake uses for tenancy. In scope: opening and reusing one connection inside the daemon process, validating config at the boundary, exposing the query interface that the escaping (PRD-002b), healing (PRD-002c), write-pattern (PRD-002d), and vector-search (PRD-002e) layers route through, and sending the resolved org on each request so the storage layer enforces the partition boundary. Out of scope: the escaping helpers, the write primitives, the table catalog (PRD-003), and the tenancy policy decisions that live in auth.

## Goals

- A single DeepLake client lives in the daemon and is the only DeepLake connection in the entire system; no harness, CLI, MCP, or SDK opens DeepLake directly.
- The client exposes one query interface that every adapter layer routes through, so escaping, healing, and scoping apply uniformly regardless of which harness triggered the write.
- Config (endpoint, credentials, org resolution, query timeout) is validated at startup with `zod` and clamped to sane ranges, failing closed on bad input.
- Every query carries the resolved org/workspace identity so DeepLake enforces tenant isolation at the storage layer.
- A query timeout knob (`HONEYCOMB_QUERY_TIMEOUT_MS`) bounds every statement so a slow query cannot stall a daemon worker indefinitely.

## Non-Goals

- The `sqlStr`/`sqlLike`/`sqlIdent` escaping helpers (PRD-002b).
- Schema creation and healing (PRD-002c).
- Write primitives and atomicity patterns (PRD-002d).
- Vector search (PRD-002e) and the table catalog (PRD-003).

## User stories

- As the daemon, I want one client to open and reuse a DeepLake connection so that every write goes through the same escaping, healing, and scoping.
- As a security reviewer, I want every query to carry the resolved org so that a workspace can never read another's rows, partitions, or indexes.
- As an operator, I want connection and timeout settings validated at startup so that misconfiguration fails closed rather than at first write.

## Functional requirements

- FR-1: On daemon startup the client connects to the configured DeepLake endpoint and exposes a `query`/`exec` interface consumed by the escaping, healing, write-pattern, and vector-search layers; no other process in the system opens a DeepLake connection.
- FR-2: Config resolution reads endpoint, credentials/token, org-resolution settings, and tuning knobs, validating each at the boundary with `zod`; out-of-range or missing required values are rejected with structured errors and the daemon fails closed.
- FR-3: Each query sends the request's resolved org so DeepLake enforces the org/workspace partition boundary; the client never issues an unscoped query on a tenant table.
- FR-4: The query timeout is read from `HONEYCOMB_QUERY_TIMEOUT_MS` (routed through the tuning object), clamped to a non-negative range, and applied to every statement.
- FR-5: The client reuses one connection across daemon workers rather than opening per-request connections, and surfaces a typed connection-error result distinct from query errors.
- FR-6: Optional SQL tracing is gated by `HONEYCOMB_TRACE_SQL` so statements can be logged for debugging without leaking by default.
- FR-7: The client returns closed result shapes (a discriminated union over success, query error, connection error, timeout) rather than throwing untyped errors, so downstream layers branch on `kind`.
- FR-8: Org and credential values that flow into log lines or errors are redacted, never echoed in full.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given daemon startup, when the client initializes, then it connects to the configured DeepLake endpoint and exposes a query interface to other adapter layers. |
| AC-2 | Given a request carrying org/workspace identity, when a query runs, then the resolved org is sent so DeepLake enforces the partition boundary. |
| AC-3 | Given missing or out-of-range config, when the client initializes, then it rejects with a structured error and the daemon fails closed. |
| AC-4 | Given a query exceeding `HONEYCOMB_QUERY_TIMEOUT_MS`, when it runs, then the client returns a timeout result rather than blocking the worker indefinitely. |
| AC-5 | Given a non-daemon process, when it needs storage, then it calls the daemon on port 3850 and never opens DeepLake itself. |
| AC-6 | Given `HONEYCOMB_TRACE_SQL` is unset, when queries run, then statements are not logged; when set, then they are. |
| AC-7 | Given a connection failure versus a query failure, when either occurs, then the client returns distinct typed result kinds. |

## Implementation notes

- The daemon is the only DeepLake client by design; centralizing access here is what lets escaping (PRD-002b), healing (PRD-002c), and scoping apply uniformly no matter which harness or hook triggered the write. This is the architectural invariant the whole adapter rests on.
- Live as a daemon module that owns the connection handle and the config object; the write-pattern and vector layers depend on it, not the reverse.
- Validate config with `zod` at the boundary and clamp timeouts, limits, and intervals to non-negative ranges per the coding standards' fail-closed posture.
- DeepLake exposes no transactions at this layer; the client is a thin connection plus query surface, and correctness-under-concurrency is handled by the write patterns in PRD-002d, not by client-side locking.

## Dependencies

- None upstream within PRD-002; PRD-002b, 002c, 002d, and 002e all route through this client.
- External: the DeepLake SDK/HTTP query endpoint, `zod` for config validation.

## Open questions

- [ ] What is the exact connection/auth model for the DeepLake endpoint (token, org resolution header) and how is it configured?
- [ ] Does the resolved org travel as a header, a connection-scoped setting, or a query prefix?
- [ ] Should the client pool connections per workspace or share one connection with per-query org resolution?

## Related

- [parent index](./prd-002-deeplake-storage-adapter-index.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
