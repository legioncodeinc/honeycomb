# PRD-004d: Runtime Path Negotiation

> **Parent:** [PRD-004](./prd-004-daemon-runtime-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S

## Scope

Implement the `x-honeycomb-runtime-path` contract: the daemon on port 3850 claims a session for the first integration path (`plugin` or `legacy`) that touches it and returns `409 Conflict` to the other path on that session, with stale claims swept after a timeout. A harness session can be reachable through more than one integration surface (an install-time connector path and a runtime plugin path); this contract stops both from writing into one session and double-counting tokens or duplicating memory.

## Goals

- Claim a session for the first runtime path that touches it, keyed on the `x-honeycomb-runtime-path` header.
- Return `409 Conflict` when the other path requests an already-claimed session.
- Sweep stale claims after a timeout so a crashed harness does not lock a session forever.
- Make the active path observable so operators can triage duplicated memory and high-token reports.

## Non-Goals

- The connector install flow that decides which path a harness uses (integrations module).
- The capture write path the claim protects (PRD-005).
- The HTTP server scaffolding the middleware mounts onto (PRD-004a).
- The auth and tenancy resolution (auth module).

## User stories

- As an operator, I want a session owned by exactly one runtime path so duplicated memory and double-counted tokens never happen.
- As a connector, I want a clear `409` when I touch a session another path already owns so I back off cleanly.
- As a diagnostician, I want to confirm only the intended path is active when triaging duplicated memory.

## Functional requirements

- FR-1: Every session-scoped request carries `x-honeycomb-runtime-path` set to `plugin` or `legacy`; a request missing or carrying an invalid value is rejected.
- FR-2: On the first request for a session, the daemon records a claim binding the session key to the requesting path with a claim timestamp.
- FR-3: A subsequent request for the same session from a different path returns `409 Conflict`.
- FR-4: A subsequent request for the same session from the claiming path proceeds normally and refreshes the claim timestamp.
- FR-5: A stale-claim sweeper expires claims older than the configured TTL so the session can be reclaimed by either path.
- FR-6: The claim check runs as middleware ahead of the session-scoped handlers so the conflict is detected before any capture write.
- FR-7: The active claimed path for a session is queryable (via diagnostics) for triage of duplicated memory and high-token reports.
- FR-8: Claim state is durable enough to survive within the configured TTL but is not required to persist across the full retention horizon.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a session first touched by the `plugin` path, when the `legacy` path requests the same session, then the daemon returns `409 Conflict`. |
| AC-2 | Given a claim whose harness has crashed, when the sweep interval elapses past the TTL, then the stale claim expires and the session can be reclaimed. |
| AC-3 | Given the claiming path requests its own session again, when the request runs, then it proceeds and the claim timestamp refreshes. |
| AC-4 | Given a request without a valid `x-honeycomb-runtime-path`, when it arrives, then it is rejected before any session-scoped handler runs. |
| AC-5 | Given a duplicated-memory triage, when an operator queries the session, then the active claimed path is reported. |
| AC-6 | Given a session whose claim has just expired, when either path touches it, then a fresh claim is recorded for that path. |
| AC-7 | Given the conflict, when `409` is returned, then no capture write has occurred for that request. |

## Implementation notes

- Daemon modules: a runtime-path middleware reads the header, looks up the session claim, and either proceeds, refreshes, or returns `409`; a sweeper loop expires stale claims; diagnostics expose the active path.
- Data shapes: a claim is `{ session_key, path, claimed_at, last_seen_at }`; storage may be an in-daemon map persisted/checkpointed so it survives within the TTL, consistent with the daemon-only-touches-DeepLake rule for any durable persistence.
- The stale-claim TTL defaults to a few hours, and the sweeper runs on a periodic cadence well under the TTL so a crashed harness frees its session promptly without flapping.
- Edge cases: a clock skew between paths is tolerated because the claim is keyed on first-touch order, not absolute time; a rapid refresh from the claiming path does not extend a claim past a hard cap.
- Failure handling: if claim lookup is unavailable, the middleware fails closed for the non-claiming path (returns `409`) rather than risking a double write.

## Dependencies

- PRD-004a HTTP server (middleware mount point and process lifecycle).
- PRD-005 capture intake (the write path the claim protects).
- Integrations / harness module (sends `x-honeycomb-runtime-path`).

## Open questions

- [ ] What is the exact default TTL (a few hours) and sweep cadence, and should they be configurable per deployment?
- [ ] Should claim state be persisted to DeepLake or kept in-process with checkpointing across restarts?

## Related

- [parent index](./prd-004-daemon-runtime-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
