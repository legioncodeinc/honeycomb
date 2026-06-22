# PRD-010: Model and Provider Router

> **Status:** Completed
> **Priority:** P1
> **Effort:** L
> **Schema changes:** Additive

---

## Overview

Before the router, inference was scattered: extraction picked its own model, synthesis picked another, interactive calls went straight to a harness, and there was no shared policy, fallback, or observability. The model and provider router pulls all of that into one place. The honeycomb daemon owns inference routing, and every workload (extraction, synthesis, interactive, dreaming) flows through one policy engine. Inference is declared in a top-level `inference:` block in `agent.yaml` where accounts hold credentials by secret reference, targets name a model with a privacy tier and capabilities, policies choose among targets, and workloads bind work to a policy. Hard gates block on privacy, capability, and context; strict, automatic, and hybrid modes pick the surviving target; and a fallback chain retries on 4xx/5xx. Harnesses reach the router as thin HTTP clients through a native inference API or an OpenAI-compatible gateway, and the daemon is the only thing that holds credentials or talks to DeepLake.

## Goals

- Express inference declaratively in `agent.yaml` with accounts, targets, policies, task classes, and workloads.
- Decide every route through one engine: hard gates first, then mode-based selection, then a recorded fallback chain.
- Expose routing through both a native inference API and an OpenAI-compatible gateway served by the daemon on port 3850.
- Keep routing telemetry daemon-local and redacted, with secret references resolved through the secrets subsystem and never logged.

## Non-Goals

- Defining the secrets subsystem that resolves account credentials (PRD-012).
- Implementing the dreaming workload's stronger policy behavior (PRD-009 consumes the router).
- A canonical top-level `models:` map, session/subscription account lifecycle, circuit breaking, and full cost telemetry (deferred to a later phase).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-010a-model-provider-router-config-contract`](./prd-010a-model-provider-router-config-contract.md) | Accounts, targets, policies, and workloads in `agent.yaml`. | Draft |
| [`prd-010b-model-provider-router-routing-engine`](./prd-010b-model-provider-router-routing-engine.md) | Privacy/capability/context gates, strict/automatic/hybrid modes, and fallback. | Draft |
| [`prd-010c-model-provider-router-gateway-api`](./prd-010c-model-provider-router-gateway-api.md) | Native inference API plus OpenAI-compatible gateway. | Draft |
| [`prd-010d-model-provider-router-route-cli`](./prd-010d-model-provider-router-route-cli.md) | `honeycomb route` verbs and redacted telemetry. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an `inference:` block, when the daemon loads it, then accounts, targets, policies, and workloads parse and secret references resolve without exposing raw keys in any dump or log. |
| AC-2 | Given an inference request whose top candidate fails a privacy, capability, or context gate, when routing runs, then that target is blocked and selection proceeds among the surviving candidates by policy mode. |
| AC-3 | Given a target that returns a 4xx or 5xx, when the request executes, then the router tries the next allowed target in the chain and records the attempt sequence. |
| AC-4 | Given an existing OpenAI client pointed at the daemon, when it calls `POST /v1/chat/completions`, then it receives routed inference, including streaming. |

## Data model changes

Additive: daemon-local redacted routing-history event rows (`jsonb`) in DeepLake. No changes to user-memory tables.

## API changes

Additive: native inference API (`/api/inference/status|history|explain|execute|stream`, `DELETE /api/inference/requests/:id`) and OpenAI-compatible gateway (`GET /v1/models`, `POST /v1/chat/completions`).

## Open questions

- [ ] Should runtime degradation (401/403 expired, 429 rate-limited) persist across daemon restarts rather than staying in-memory?
- [ ] When does the canonical top-level `models:` map land, and how does it relate to `targets`?
- [ ] What is the default policy mode (strict, automatic, or hybrid) for a workload that does not specify one?

## Related

- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
- [Dreaming Loop](../../../knowledge/private/ai/dreaming-loop.md)
- [Secrets](../../../knowledge/private/security/secrets.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
