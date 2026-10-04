# PRD-032d — Vault wire-back: assembly reads provider/model + pollinating from the vault

> **Parent:** [PRD-032](./prd-032-encrypted-vault-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The wire-back that makes the vault the live source of truth for inference selection and the pollinating toggle.
At assembly, the daemon READS the active provider/model and the `pollinating.enabled` flag from the vault
`setting` class (PRD-032 D-5, option B), falling back to the committed `agent.yaml` and the
`HONEYCOMB_POLLINATING_ENABLED` env var only when no vault setting exists. The vault does NOT generate or
overwrite `agent.yaml`. This sub-PRD owns the assembly read path and the resolution precedence; it does NOT
own the vault store (032a), the CLI verb (032b), or the dashboard panel (032c).

## Goals

- Assembly resolves the inference provider/model from the vault `setting` class, with the committed
  `agent.yaml` as a static fallback/example (vault wins when set).
- Assembly resolves `pollinating.enabled` from the vault, with `HONEYCOMB_POLLINATING_ENABLED` as the fallback.
- One direction only: the vault is read; it never writes back to `agent.yaml` (no drift, no write-back loop).
- No regression for installs with no vault settings (they keep booting from `agent.yaml` / the env var).

## Non-Goals

- The vault store, registry, and migration (032a); the CLI verb (032b); the dashboard panel (032c).
- Re-architecting the router or the pollinating loop (PRD-010 / PRD-009 / PRD-026 own those).
- Generating or rewriting `agent.yaml` from the vault (PRD-032 D-5 rejects option A).

## Functional requirements

- FR-1: At assembly (`src/daemon/runtime/assemble.ts`), the inference provider/model/target selection resolves
  from the vault `setting` class when present; absent a vault setting, it falls back to the committed
  `agent.yaml` (`buildInferenceModelClient`, `src/daemon/runtime/inference/config.ts`).
- FR-2: The inference CREDENTIAL keeps resolving through the vault `secret` class via the existing
  `${SECRET_REF}` path — only provider/model/target SELECTION moves to vault-driven settings (the key is still
  never inlined).
- FR-3: The `pollinating.enabled` flag resolves from the vault `setting` class when present; absent it, it falls
  back to `HONEYCOMB_POLLINATING_ENABLED` (`src/daemon/runtime/pollinating/config.ts`), preserving PRD-026 behavior.
- FR-4: The vault never writes `agent.yaml`; resolution is read-only and single-directional (vault → fallback),
  so there is no committed-file-vs-vault drift.
- FR-5: With no vault settings present, the daemon boots exactly as today (existing `agent.yaml` / env path),
  including the no-op model client when `agent.yaml` is absent — no regression.

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | Given a vault `setting` for active provider/model, when the daemon assembles, then it builds the inference model client for THAT provider/model (the vault wins over the committed `agent.yaml`). |
| d-AC-2 | Given a vault `setting` `pollinating.enabled=true`, when assembled, then `POST /api/diagnostics/pollinate` no longer returns `reason:"disabled"` (PRD-026 behavior) WITHOUT `HONEYCOMB_POLLINATING_ENABLED` being set. |
| d-AC-3 | Given NO vault settings, when assembled, then provider/model falls back to `agent.yaml` and pollinating falls back to `HONEYCOMB_POLLINATING_ENABLED` — existing installs are unchanged. |
| d-AC-4 | Given any resolution, when the daemon runs, then the vault is only READ (it never writes `agent.yaml`), so there is no committed-file-vs-vault drift. |
| d-AC-5 | Given the inference credential, when the model client is built, then the key still resolves through the vault `secret` class via `${SECRET_REF}` and is never inlined. |

## Implementation notes

- Thread a vault-settings read into the assembly inference path (`assemble.ts` → `buildInferenceModelClient`)
  so the resolved provider/model comes from the vault first; keep `agent.yaml` as the static fallback. Layer
  the `pollinating.enabled` vault read in front of the env read in `pollinating/config.ts` (vault → env → false-safe).
- Keep the boot resilient: an absent vault, an absent `agent.yaml`, and an unset env all degrade to the
  existing no-op/false-safe behavior (no throw at boot).
- Do NOT introduce a write-back: the vault is the source of truth; `agent.yaml` stays committed and documents
  "contains NO secret" — the wire-back must not undermine that guarantee.

## Dependencies

- PRD-032a vault `setting`/`secret` classes (the read source at assembly).
- PRD-010 inference config + `${SECRET_REF}` resolution (`src/daemon/runtime/inference/*`, `agent.yaml`).
- PRD-026 pollinating-enabled semantics (`src/daemon/runtime/pollinating/config.ts`, `api.ts`).
- The daemon assembly path (`src/daemon/runtime/assemble.ts`, `AGENT_CONFIG_FILE_NAME`,
  `buildInferenceModelClient`).

## Related

- [parent index](./prd-032-encrypted-vault-index.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
