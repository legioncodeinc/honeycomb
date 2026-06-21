# PRD-032b — Vault CLI: `honeycomb settings` + provider/model selector

> **Parent:** [PRD-032](./prd-032-encrypted-vault-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S

## Scope

The CLI surface for the vault: add `honeycomb settings get|set|list` and a provider→model selector flow,
sitting beside the existing `honeycomb secret …` verb, all loopback-daemon-mediated. This sub-PRD owns the
new `settings` verb and the selector UX; it does NOT own the vault store (032a), the dashboard (032c), or the
assembly wire-back (032d). The `honeycomb secret …` names-only posture is preserved verbatim — no
value-returning verb is added.

## Goals

- `honeycomb settings list` shows the current settings (active provider, model, dreaming flag, dashboard
  prefs) without printing any secret value.
- `honeycomb settings get <key>` / `set <key> <value>` round-trip a typed setting through the daemon to the
  vault `setting` class.
- A provider/model selector flow: pick provider (Anthropic / OpenAI / OpenRouter), then a model from that
  provider's curated catalog (PRD-032 D-6).
- Preserve the existing `honeycomb secret …` names-only, loopback-daemon-only security posture.

## Non-Goals

- The vault store, registry, and migration (032a).
- The dashboard Settings panel (032c).
- Reading settings at assembly to drive inference/dreaming (032d).
- A value-returning `secret` verb (forbidden — PRD-012 names-only posture).
- A live provider model-list fetch (curated catalog only; live fetch is the flagged enhancement, PRD-032 D-6).

## Functional requirements

- FR-1: `honeycomb settings list` prints the current `setting`-class records (provider, model,
  `dreaming.enabled`, dashboard prefs) via a daemon endpoint; secret values are NEVER printed (a secret shows
  as "set ✓" / "not set", names only).
- FR-2: `honeycomb settings get <key>` prints the typed value of a single setting; `honeycomb settings set
  <key> <value>` writes it through the daemon to the vault, validated by the class schema (032a FR-4).
- FR-3: A selector flow (e.g. `honeycomb settings provider` / an interactive or two-step `set provider …` →
  `set model …`) lets the user choose a provider then a model from that provider's curated catalog; an unknown
  model id is rejected for catalog providers, accepted free-form for the OpenRouter passthrough (PRD-032 D-6).
- FR-4: All `settings` and `secret` traffic goes through the real loopback `DaemonClient` (`src/cli`,
  `src/commands`), never direct disk access; a down daemon auto-starts per the existing 021b behavior.
- FR-5: The existing `honeycomb secret set|list|delete` verb (`/api/secrets`, `src/commands/storage-handlers.ts`)
  is unchanged — names-only, no value-returning verb, loopback-only.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given stored settings, when `honeycomb settings list` runs, then it shows provider/model/dreaming/prefs and shows secrets as set/not-set by name only — no secret value is printed. |
| b-AC-2 | Given a valid key/value, when `honeycomb settings set <key> <value>` runs, then the daemon writes the vault `setting` record and a subsequent `settings get <key>` returns the written value. |
| b-AC-3 | Given the selector flow, when the user picks a provider then a model, then the active provider/model settings are written; a model id outside the catalog is rejected for catalog providers and accepted free-form for OpenRouter. |
| b-AC-4 | Given any `settings`/`secret` invocation, when it runs, then it reaches the daemon over loopback (never direct disk) and the `honeycomb secret …` verb remains names-only. |

## Implementation notes

- Register `settings` in the unified dispatcher (`src/commands/index.ts`) beside `secret`; reuse the
  daemon-client plumbing in `storage-handlers.ts`. The selector's catalog is the single-sourced module from
  PRD-032 D-6 (shared with the dashboard 032c so CLI and UI agree on model lists).
- Keep the thin-client invariant: `src/commands` + `src/cli` are NON_DAEMON_ROOTs — no storage/DeepLake import.
- Output discipline: never echo a secret value; a `settings list` line for a secret-backed key reports
  presence only.

## Dependencies

- PRD-032a vault store + `setting` class accessors (read/write through the daemon).
- PRD-020a CLI dispatcher (`src/cli/index.ts`, `src/commands/index.ts`, `storage-handlers.ts`).
- The curated provider→model catalog (PRD-032 D-6), shared with 032c.

## Related

- [parent index](./prd-032-encrypted-vault-index.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
