# PRD-010a: Config Contract

> **Parent:** [PRD-010](./prd-010-model-provider-router-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The declarative `inference:` block in `agent.yaml`: accounts hold provider credentials by secret reference, targets name a model on an account with a privacy tier and capabilities, policies choose among targets, task classes describe kinds of work, and workloads bind a task class to a policy. This sub-PRD owns parsing, validation, and cross-reference resolution of that block. It is consumed by the routing engine (PRD-010b) which uses the parsed targets, policies, and gates. The daemon is the only component that reads resolved credentials; harnesses never see them.

## Goals

- Put all inference routing policy in one reviewable place in `agent.yaml` so an operator can audit which models run which workloads.
- Reference credentials by secret reference only, so a config dump never contains a raw key.
- Validate the block at parse time and resolve every cross-reference, so a workload that names a missing policy or a policy that names a missing target fails loudly rather than at request time.
- Carry the privacy tier and capability list on each target so the routing engine can gate deterministically.

## Non-Goals

- Deciding routes or executing inference (PRD-010b).
- Serving the API or gateway (PRD-010c) or the CLI (PRD-010d).
- Resolving the secret value; that is the secrets subsystem's job (PRD-012). This block holds only the reference.
- Defining a canonical top-level `models:` map; that is deferred per the knowledge doc's current state.

## User stories

- As an operator, I want to declare inference accounts and targets in `agent.yaml` so that routing policy lives in one reviewable place.
- As a security reviewer, I want credentials referenced by secret only so that I can share or commit config without leaking keys.
- As a daemon, I want cross-references validated up front so that I never start a request against an undefined policy.

## Functional requirements

- FR-1: The daemon MUST parse a top-level `inference:` block in `agent.yaml` with `accounts`, `targets`, `policies`, `taskClasses`, and `workloads` sections.
- FR-2: Each account MUST carry an `id`, a `provider`, and credential fields expressed as secret references (e.g. `apiKey: ${ANTHROPIC_API_KEY}`); raw inline keys MUST be rejected with a validation error.
- FR-3: Each target MUST name a `model` on a referenced `account` and carry a `privacy` tier and a `capabilities` list.
- FR-4: Each policy MUST declare a `mode` (`strict`, `automatic`, or `hybrid`) and the targets it selects among (an ordered `chain` for strict, a candidate set for automatic/hybrid).
- FR-5: Each workload MUST bind a `taskClass` to a `policy`; the parser MUST resolve that the named policy and task class exist.
- FR-6: Validation MUST fail when any cross-reference is dangling: a workload naming a missing policy, a policy naming a missing target, or a target naming a missing account.
- FR-7: A config dump or diagnostic output MUST show only the secret reference, never the resolved value, for every credential field.
- FR-8: The parsed contract MUST be exposed to the routing engine as a typed in-memory structure scoped to the workspace's `agent.yaml`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an `inference:` block with accounts, targets, policies, and workloads, when the daemon parses it, then each section validates and cross-references resolve (a workload names a real policy, a policy names real targets). |
| AC-2 | Given an account with `apiKey: ${SECRET_REF}`, when config is dumped, then the resolved key never appears and only the reference is shown. |
| AC-3 | Given a workload that names a non-existent policy, when the daemon parses config, then parsing fails with an error identifying the dangling reference. |
| AC-4 | Given a target with an inline raw API key, when the daemon parses config, then it is rejected in favor of a secret reference. |
| AC-5 | Given a valid block, when parsing completes, then targets expose their privacy tier and capabilities to the routing engine. |

## Implementation notes

- Targets carry a privacy tier and capability list used by the gates in PRD-010b; capability vocabulary (e.g. `completion`, `caching`, `vision`) is an open question below.
- Secret references resolve through the secrets subsystem, never raw keys in config; resolution happens at execution time, not parse time, so parsing never touches `.secrets/`.
- Authoritative implementation is `platform/daemon/src/inference-router.ts` per the knowledge doc.

## Dependencies

- `agent.yaml` loader and the workspace layout.
- PRD-012 secrets subsystem for reference resolution at execution time.
- Consumed by PRD-010b routing engine.

## Open questions

- [ ] What is the closed capability vocabulary, and how are new capabilities added without breaking existing targets?
- [ ] Should privacy tiers be a fixed ordered enum, and what are the exact tier names?

## Related

- [parent index](./prd-010-model-provider-router-index.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
- [Secrets](../../../knowledge/private/security/secrets.md)
