# PRD-010d: Route CLI and Telemetry

> **Parent:** [PRD-010](./prd-010-model-provider-router-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S

## Scope

The `honeycomb route` operator verbs that mirror the inference API, plus daemon-local redacted routing telemetry that records the route and fallback sequence without secrets or request bodies. The CLI is a thin client over the daemon on port 3850; it never holds credentials or talks to DeepLake itself. Telemetry rows are written by the daemon as `jsonb` events in DeepLake and surfaced read-only through the CLI and the history API (PRD-010c).

## Goals

- Give operators CLI parity with the inference API: inspect, test, explain, and pin routing from the terminal.
- Record route and fallback sequences daemon-local and redacted, so operators can audit decisions without exposing secrets or request bodies.
- Let an operator pin a workload to a target and unpin it, for incident response and testing.
- Provide a doctor verb that surfaces config and account health.

## Non-Goals

- Deciding routes (PRD-010b) or serving the HTTP API (PRD-010c); the CLI calls those.
- Full cost telemetry, which is deferred to a later phase per the knowledge doc.
- Persisting runtime degradation across restarts; that is out of scope here too.

## User stories

- As an operator, I want `honeycomb route` verbs so that I can inspect, test, explain, and pin routing decisions from the CLI.
- As an on-call engineer, I want to pin a workload to a known-good target during an incident so that I can route around a failing provider.
- As an auditor, I want redacted telemetry so that I can review routing history without seeing credentials or prompt contents.

## Functional requirements

- FR-1: The CLI MUST expose `honeycomb route list`, `status`, `doctor`, `explain`, `test`, `pin`, and `unpin`, each calling the daemon on port 3850.
- FR-2: `honeycomb route explain` MUST print the routing decision for a workload without executing inference, mirroring the explain API.
- FR-3: `honeycomb route status` MUST show recent route and fallback sequences with secrets and request bodies redacted.
- FR-4: `honeycomb route list` MUST list configured targets and the workloads bound to them.
- FR-5: `honeycomb route test` MUST run a routed test call and report which target served it and the attempt sequence.
- FR-6: `honeycomb route pin` MUST pin a workload to a specified target, and `honeycomb route unpin` MUST remove the pin, returning that workload to normal policy resolution.
- FR-7: The daemon MUST persist routing telemetry as `jsonb` event rows in DeepLake, recording the route and fallback sequence but never secrets or request bodies.
- FR-8: Redaction MUST strip secrets and request bodies before the row is written, not just before display, so the stored row is already safe.
- FR-9: All telemetry rows and CLI operations MUST be scoped to the operator's org/workspace and `agent_id`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a configured router, when `honeycomb route explain` runs, then it prints the routing decision for a workload without executing inference. |
| AC-2 | Given telemetry enabled, when `honeycomb route status` runs, then it shows recent route and fallback sequences with secrets and request bodies redacted. |
| AC-3 | Given `honeycomb route pin <workload> <target>`, when a request for that workload routes, then it resolves to the pinned target until unpinned. |
| AC-4 | Given `honeycomb route test`, when it runs, then it reports the serving target and the full attempt sequence. |
| AC-5 | Given a stored telemetry row, when inspected directly in DeepLake, then it contains no secret value and no request body. |

## Implementation notes

- Verbs: `route list|status|doctor|explain|test|pin|unpin`. Telemetry stored as `jsonb` event rows, daemon-local.
- Redaction strips secrets and bodies before storage; retention window is an open question below.
- Pins are runtime state held by the daemon; whether pins survive a restart is an open question.

## Dependencies

- PRD-010b routing engine (decision, attempt sequence, pin honoring).
- PRD-010c API (the CLI is a client over it).
- DeepLake store for telemetry rows (written by the daemon only).

## Open questions

- [ ] What is the telemetry retention window, and is it configurable?
- [ ] Should pins persist across daemon restarts or reset to policy defaults?

## Related

- [parent index](./prd-010-model-provider-router-index.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
