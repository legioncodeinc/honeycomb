# PRD-010b: Routing Engine

> **Parent:** [PRD-010](./prd-010-model-provider-router-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L

## Scope

The decision core that turns a workload into a concrete target: hard gates that block on privacy tier, missing capability, or insufficient context; degrade handling for missing or expired accounts; strict/automatic/hybrid mode selection among the survivors; and a fallback chain that retries on 4xx/5xx while recording the attempt sequence. The engine consumes the parsed config contract (PRD-010a), runs inside the honeycomb daemon, and is invoked by the API, gateway, and CLI surfaces (PRD-010c, PRD-010d). It holds the only credentials and is the only thing that talks to DeepLake.

## Goals

- Resolve every workload (extraction, synthesis, interactive, pollinating) through one shared policy engine, so there are no separate per-stage routers.
- Gate deterministically so no request runs on a model that violates its privacy or capability requirements or whose context window is too small.
- Degrade gracefully when an account is missing or expired rather than hard-blocking the whole request.
- Fall back through the allowed chain on transient provider failures and record the full attempt sequence for telemetry.

## Non-Goals

- Parsing the config contract (PRD-010a).
- Exposing HTTP surfaces (PRD-010c) or CLI verbs (PRD-010d).
- Persisting runtime degradation across restarts; per the knowledge doc, degradation is in-memory and not yet persisted.
- Circuit breaking with cooldown recovery and full cost telemetry, which are deferred to a later phase.

## User stories

- As the daemon, I want to resolve a workload to a concrete target with deterministic gating so that no request runs on a model that violates its privacy or capability requirements.
- As an operator, I want a missing account to degrade rather than hard-fail so that one expired credential does not take down all inference.
- As a debugger, I want the attempt sequence recorded so that I can see which targets were tried and why each failed.

## Functional requirements

- FR-1: The engine MUST resolve a request as workload to policy to candidate targets using the parsed config contract.
- FR-2: Hard gates MUST block a candidate outright when its privacy tier is too low for the request, a required capability is missing, or its context window is too small for the request.
- FR-3: A missing or expired account MUST degrade (remove that target from candidates) rather than hard-block the request, so other survivors remain eligible.
- FR-4: Among survivors, `strict` mode MUST follow the explicit ordered chain, `automatic` MUST score eligible candidates, and `hybrid` MUST score within an allowlist.
- FR-5: When a chosen target fails with a 4xx or 5xx, the engine MUST try the next allowed target in the chain and continue until a target succeeds or the chain is exhausted.
- FR-6: The engine MUST record the full attempt sequence (each target tried and its outcome) and return it alongside the result for telemetry.
- FR-7: Runtime degradation MUST treat 401/403 as expired and 429 as rate-limited; the knowledge doc notes this is in-memory and not persisted across restarts.
- FR-8: The engine MUST resolve secret references in accounts through the secrets subsystem at execution time, so credentials never appear in config dumps or logs.
- FR-9: The engine MUST be the only component that holds credentials and the only one that talks to DeepLake; harnesses reach it as thin HTTP clients.
- FR-10: An explain path MUST return the chosen target and gating decision without executing the request (consumed by PRD-010c explain and PRD-010d `route explain`).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a candidate target with too low a privacy tier, a missing capability, or too small a context window, when gates run, then it is blocked outright. |
| AC-2 | Given a policy in `strict` mode, when selection runs, then targets are tried in the explicit chain order; in `automatic` candidates are scored, and in `hybrid` scored within an allowlist. |
| AC-3 | Given a missing or expired account, when resolution runs, then that target degrades out of the candidate set and other survivors remain eligible. |
| AC-4 | Given a target that returns 5xx, when it fails, then the engine tries the next allowed target and appends both to the recorded attempt sequence. |
| AC-5 | Given a 401 from a target, when it returns, then the engine marks that account expired in-memory and degrades it for subsequent requests in the same process lifetime. |
| AC-6 | Given an explain request, when it runs, then the engine returns the routing decision without executing inference. |

## Implementation notes

- A missing or expired account degrades rather than hard-blocks; degrade removes the target from the candidate set while a hard gate blocks it on policy grounds. The distinction matters for telemetry attribution.
- On 4xx/5xx, try the next allowed target and append to the recorded attempt sequence. Authoritative impl: `platform/daemon/src/inference-router.ts`.
- Circuit breaking with cooldown recovery and persisted degradation are deferred; until then degradation is per-process.

## Dependencies

- PRD-010a config contract (parsed targets, policies, gates).
- PRD-012 secrets subsystem for credential resolution at execution time.
- DeepLake store (for telemetry rows written via PRD-010d).
- Consumed by PRD-010c and PRD-010d.

## Open questions

- [ ] What scoring function does `automatic`/`hybrid` use (cost, latency, capability fit), and is it configurable?
- [ ] When the whole chain is exhausted, what error shape is returned to the caller?

## Related

- [parent index](./prd-010-model-provider-router-index.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
