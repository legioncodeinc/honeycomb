# PRD-021f: Dogfood and Acceptance (the behavioral proof plus receipts)

> **Parent:** [PRD-021](./prd-021-go-live-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The behavioral proof that the assembled system works end-to-end, plus the receipts: setup into a real Claude Code session, a real turn captured to DeepLake, a session-end summary, the next session's recall surfacing the prior context, the dashboard and live log showing it all, a scripted golden-path smoke, a recorded demo, and the observability story. This sub-PRD owns the end-to-end acceptance that the other five sub-PRDs enable. It does not own the seams themselves: the daemon assembly (021a), the CLI (021b), the hook runtime (021c), the dashboard and log (021d), and the MCP transport (021e) supply the parts this proves.

## Goals

- `honeycomb setup` into a real Claude Code session, then Cursor.
- A real turn captured to DeepLake `sessions` rows, no fakes.
- A session-end summary worker producing a `memory` summary row.
- The next session's recall surfacing the prior context: the cross-session memory proof.
- The dashboard showing the real session and the live log streaming the capture events in real time.
- A scripted end-to-end golden-path smoke an operator (or CI with credentials) can run.
- A recorded demo artifact and the receipts story: recall-hit metric and token-savings visibility.

## Non-Goals

- The composition root, CLI, hook runtime, dashboard, and MCP transport, which the other five sub-PRDs own and this consumes.
- Any new business logic or DeepLake schema. The proof exercises existing seams end-to-end.
- Hardening every harness. Claude Code is the proof harness; Cursor follows; the rest are out of scope for this PRD's acceptance.

## User stories

- As a developer, I want to set up Honeycomb in Claude Code and have my turn captured so that my work becomes recallable memory with no extra steps.
- As a developer, I want my next session to recall what I did last time so that the cross-session memory promise is real, not theoretical.
- As an operator, I want to watch the dashboard and live log during a session so that I can see capture happening in real time.
- As a maintainer, I want a scripted golden-path smoke so that anyone with credentials can prove the system end-to-end in one run.
- As a stakeholder, I want a recorded demo and a recall-hit metric so that the go-live has receipts.

## Functional requirements

- FR-1: `honeycomb setup` wires a real Claude Code session end-to-end (then Cursor as the fast-follow), using the 021b CLI and the 021c reference-harness wiring.
- FR-2: A real coding turn is captured to DeepLake `sessions` rows through the assembled daemon and the production hook client, with no fakes or stubs in the path.
- FR-3: On session end, the summary worker runs and produces a `memory` summary row from the captured session.
- FR-4: The next session's recall surfaces the prior context end-to-end: the new session reads the prior summary and raw turns through the daemon, proving cross-session memory.
- FR-5: The dashboard shows the real session and the live log streams the capture events in real time during the session (via the 021d surfaces).
- FR-6: A scripted end-to-end golden-path smoke exists that an operator, or CI with credentials, can run to drive setup, capture, summary, and cross-session recall in one pass.
- FR-7: A recorded demo artifact captures the golden path, with credentials and sensitive captured-trace content redacted.
- FR-8: The receipts and observability story is in place: a recall-hit metric and token-savings visibility, surfaced through the existing dashboard KPIs and logs rather than new schema.
- FR-9: Bugs discovered during the first real run are routed through security then quality before close-out, consistent with the index risk decision.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `honeycomb setup` into Claude Code plus a daemon start, when a real turn occurs, then it is captured to DeepLake `sessions` rows with no fakes in the path. |
| AC-2 | Given a captured session, when it ends, then the summary worker produces a `memory` summary row. |
| AC-3 | Given a later session, when recall runs, then it surfaces the prior summary and turns end-to-end, proving cross-session memory. |
| AC-4 | Given a live session, when the dashboard and live log are open, then the real session appears and capture events stream in real time. |
| AC-5 | Given the golden-path smoke, when an operator or CI with credentials runs it, then setup, capture, summary, and cross-session recall complete in one pass. |
| AC-6 | Given the go-live, when it is presented, then a redacted recorded demo and a recall-hit metric with token-savings visibility are available as receipts. |

## Implementation notes

- This sub-PRD is the acceptance gate for the whole PRD: AC-1 through AC-3 at the index level are proven here, end-to-end, on a real harness. The other five sub-PRDs are "done" when this one passes.
- The proof must use no fakes in the capture-to-recall path: real setup, real daemon, real hook client, real DeepLake rows, real summary worker, real recall. Test doubles are for the unit and composition rungs, not the dogfood.
- First-run-is-the-first-real-run: expect integration bugs the seam-level tests could not catch. The golden-path smoke plus structured logging make those bugs reproducible, and the security-then-quality close-out is mandatory before this PRD ships. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-021a assembled daemon serving `/health` against live DeepLake.
- PRD-021b CLI `setup` and daemon lifecycle.
- PRD-021c reference-harness hook runtime capturing real turns.
- PRD-021d dashboard and live log showing the session and capture events.
- PRD-017 summary worker producing the `memory` summary row.
- PRD-018 recall path surfacing prior context in a later session.

## Open questions

- [ ] Which harnesses are in scope for this PRD's acceptance versus fast-follow (Claude Code is the proof; Cursor follows)?
- [ ] Demo and receipts packaging: recording format and the redaction policy for credentials and captured-trace content.
- [ ] Should the golden-path smoke run in CI with stored credentials, or stay an operator-run script gated on real credentials?
- [ ] What is the minimum recall-hit and token-savings signal that counts as a passing receipt?

## Related

- [parent index](./prd-021-go-live-index.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Notifications and Environment Health](../../../knowledge/private/operations/notifications-and-health.md)
