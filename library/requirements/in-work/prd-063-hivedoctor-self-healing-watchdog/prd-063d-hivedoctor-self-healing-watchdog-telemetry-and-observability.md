# PRD-063d: HiveDoctor - Telemetry and Observability

> **Parent:** [PRD-063](./prd-063-hivedoctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)

---

## Goals

Give us the remote eyes we lack today, while keeping an honest, single-chokepoint opt-out. **PostHog is the only sink** (OD-2 resolved: no Sentry), and the transport is **PostHog Logs over OTLP** (resolved 2026-06-27). All three streams are OTLP **log records** with severity, landing in one PostHog project, all opt-out:

1. **Errors (severity ERROR)** - when HiveDoctor catches an error or a remediation fails. Optionally also pushed to PostHog Error Tracking (`captureException` → `$exception`) for issue-grouping.
2. **Installation-health (severity INFO)** - periodic install-health snapshot (daemon version, health state, OS, last-heal age).
3. **Attempted-troubleshooting (severity INFO/WARN)** - each remediation episode (trigger, `/health` reasons, ordered steps, outcomes), sourced from `incidents.ndjson`, one record per episode (or per step) carrying the `device_id` for correlation.

## Scope

- A single egress chokepoint mirroring [`emit.ts`](../../../../src/daemon/runtime/telemetry/emit.ts): one function all telemetry flows through, so opt-out is verifiable in one place.
- **Zero-dependency OTLP log emission** to `POST {host}/i/v1/logs` with `Authorization: Bearer <phc_ project_token>` (or `?token=`). PostHog Logs is a generic OTLP receiver and its logs exporter is OTLP/HTTP+**JSON**, so HiveDoctor hand-rolls the OTLP `LogsData` JSON body and POSTs via `fetch` - no OpenTelemetry SDK dependency in the can't-crash process. Reuse the existing config injection (`__HONEYCOMB_POSTHOG_KEY__` / `__HONEYCOMB_POSTHOG_HOST__`); keep the endpoint behind one constant (it is alpha).
- Optional: real exceptions additionally to Error Tracking via the dependency-free `/i/v0/e/` capture POST (`$exception`) for auto-grouping into issues.
- Each log record carries `service.name` (`hivedoctor`), `device_id` (PRD-033 UUID, for broken-auth correlation), daemon + HiveDoctor versions, and the OS - via OTLP resource + record attributes.
- Property allow-list / scrubbing so no path leaks PII, tokens, or credentials (mirror `buildAllowedProperties`). Credential *contents* are NEVER emitted - only the fact and outcome of a remediation.
- Opt-out honored for all streams: `DO_NOT_TRACK=1`, `HONEYCOMB_TELEMETRY=0`, and the dashboard telemetry toggle (OD-5: finer toggles live in the dashboard). Fire-and-forget, non-blocking, never affects healing.

## Out of scope

- The dashboard rendering of escalations - [063g](./prd-063g-hivedoctor-self-healing-watchdog-dashboard-escalation-reporting.md).
- Generating the incidents themselves - [063a](./prd-063a-hivedoctor-self-healing-watchdog-supervisor-core-and-lifecycle.md)/[063c](./prd-063c-hivedoctor-self-healing-watchdog-remediation-ladder.md).

## Acceptance criteria

- AC-063d.1 Given default settings, when HiveDoctor catches an error, then a scrubbed ERROR-severity OTLP log record reaches PostHog Logs at `/i/v1/logs`.
- AC-063d.2 Given default settings, when the install-health timer fires, then an INFO OTLP log record (version, health, OS, last-heal age, `device_id`) is emitted.
- AC-063d.3 Given a remediation episode completes, when it ends, then an OTLP log record is emitted reflecting the ordered steps and outcomes, carrying the `device_id`.
- AC-063d.7 Given the emitter runs, when it sends, then it uses no OpenTelemetry SDK dependency (hand-rolled OTLP/JSON over `fetch`), verified by the dependency list.
- AC-063d.4 Given `DO_NOT_TRACK=1` or `HONEYCOMB_TELEMETRY=0` or `--no-telemetry`, when any of the three streams would fire, then nothing leaves the box (verifiable at the single chokepoint) (AC-4 parent).
- AC-063d.5 Given any emission, when serialized, then no credential, token, or PII field is present (allow-list enforced).
- AC-063d.6 Given the telemetry sink is unreachable, when emission fails, then HiveDoctor swallows the error and continues healing (telemetry never blocks).

## Technical considerations

- **PostHog Logs is confirmed (OD-2 + transport resolved):** a generic OTLP receiver at `/i/v1/logs`, `phc_` project-token auth, OTLP/HTTP+JSON. No collector, no Sentry, no second vendor. One project holds HiveDoctor's logs alongside the product's events and Error Tracking.
- **Hand-rolled, zero-dep:** because the logs path accepts OTLP/JSON, HiveDoctor serializes the `LogsData` JSON by hand and POSTs via `fetch`. This keeps the can't-crash process free of the OpenTelemetry SDK. Vendor a tiny, well-tested serializer module; validate its JSON against the OTLP logs schema in a Vitest fixture.
- **Token hygiene:** use the public `phc_` project token (write-only), never a personal `phx_` key. Prefer the `Authorization: Bearer` header over the `?token=` query form so the token never lands in any intermediary access log.
- **Alpha caveat + cost:** PostHog Logs is alpha (pin the endpoint behind one constant); free to 50GB/mo, far above HiveDoctor's low-volume episodic output.

## Open questions

- [ ] Install-health snapshot cadence (hourly? on state change only?).
- [ ] Whether errors go to Logs only, or also to Error Tracking (`$exception`) for issue-grouping - lean: both, since the second path is dependency-free.
- [ ] One log record per remediation episode vs one per step (per-step gives a finer timeline at higher volume).

> OD-2 (PostHog only) and the OTLP transport (PostHog Logs, hand-rolled JSON) are resolved in the parent index.
