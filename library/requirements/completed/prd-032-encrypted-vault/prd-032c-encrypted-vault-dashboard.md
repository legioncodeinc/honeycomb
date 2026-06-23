# PRD-032c — Vault dashboard: Settings panel (provider/model + feature toggles)

> **Parent:** [PRD-032](./prd-032-encrypted-vault-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The dashboard surface for the vault: a Settings panel in the existing daemon-served dashboard
(`src/dashboard/web`) where the user selects provider (Anthropic / OpenAI / OpenRouter) → that provider's
curated model list loads → picks a model; and toggles feature flags (pollinating on/off). Writes go through the
daemon to the vault `setting` class. This sub-PRD owns the panel and its daemon data contract; it does NOT
own the vault store (032a), the CLI verb (032b), or the assembly wire-back (032d). Consistent with PRD-020b,
the panel reads/writes only through daemon endpoints — it never opens the vault directly.

## Goals

- A Settings panel rendering the current active provider/model and feature-flag state from daemon-served data.
- A provider→model selector: pick provider, then a model from that provider's curated catalog (PRD-032 D-6).
- Feature-flag toggles (pollinating on/off) that persist to the vault through the daemon.
- No secret value ever rendered — a provider key shows as "set ✓" / "not set" by name only.

## Non-Goals

- The vault store and registry (032a) and the CLI verb (032b).
- Reading settings at assembly to drive inference/pollinating (032d).
- A live provider model-list fetch (curated catalog only; live fetch is the flagged enhancement, PRD-032 D-6).
- Editing or displaying secret values in the UI (forbidden — names/presence only).

## User stories

- As an operator, I want to pick my inference provider and model from the dashboard so I don't hand-edit
  `agent.yaml`.
- As an operator, I want to toggle pollinating on/off from the dashboard so I don't set an env var.
- As a security-conscious user, I want the panel to confirm a provider key is set without ever showing it.

## Functional requirements

- FR-1: The dashboard renders a Settings panel (in `src/dashboard/web`, alongside the existing panels) showing
  the active provider, model, and feature-flag state from daemon-served `setting`-class data.
- FR-2: A provider selector (Anthropic / OpenAI / OpenRouter) drives a model list: choosing a provider loads
  that provider's curated catalog models; choosing a model persists the active provider/model setting.
- FR-3: Feature-flag toggles (pollinating on/off, and sibling flags) write the corresponding `setting` record;
  on reload the panel reflects the persisted vault value.
- FR-4: Every write POSTs through a daemon endpoint that writes the vault `setting` record; the panel never
  opens the vault directly and holds no storage logic (PRD-020b posture).
- FR-5: Provider keys are shown as presence only ("set ✓" / "not set") by name — no secret value is rendered;
  the OpenRouter provider accepts a free-form model id (passthrough), catalog providers constrain to the list.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given the daemon is running, when the Settings panel loads, then it renders the active provider/model and feature-flag state from daemon-served vault settings. |
| c-AC-2 | Given the panel, when the user selects a provider, then that provider's curated catalog models load; when the user picks a model, then the active provider/model setting persists and survives reload. |
| c-AC-3 | Given the panel, when the user toggles pollinating on, then the `pollinating.enabled` setting is written to the vault and the toggle reflects the persisted value on reload. |
| c-AC-4 | Given a provider key, when the panel renders, then it shows presence ("set ✓" / "not set") by name only and never displays a secret value. |
| c-AC-5 | Given the panel, when any change is made, then the write goes through a daemon endpoint (the panel never opens the vault directly), consistent with PRD-020b. |

## Implementation notes

- The panel lives in `src/dashboard/web/{panels.tsx,app.tsx,wire.ts}` and reads/writes via the daemon data
  contract (the same pattern the existing KPI/sessions/settings views use). The provider→model catalog is the
  single-sourced module from PRD-032 D-6, shared with the CLI selector (032b) so both surfaces agree.
- The panel is the canonical Settings view the Cursor extension webview embeds (PRD-020c), so render it as a
  shared view component, not extension-only.
- Connectivity state reuses the existing daemon-reachability handling (PRD-020b/020d) — a daemon-down panel
  shows a clear state, never hangs.

## Dependencies

- PRD-032a vault `setting` class + a daemon endpoint to read/write settings.
- PRD-020b daemon-served dashboard (`src/dashboard/web`) and its data contract; PRD-020c webview embed.
- The curated provider→model catalog (PRD-032 D-6), shared with 032b.

## Related

- [parent index](./prd-032-encrypted-vault-index.md)
- [Cursor Extension Architecture](../../../knowledge/private/frontend/cursor-extension-architecture.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
