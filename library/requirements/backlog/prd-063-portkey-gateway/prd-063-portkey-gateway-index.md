# PRD-063: Portkey Gateway (optional one-stop inference + reranking)

> **Status:** Backlog
> **Priority:** P2
> **Effort:** L
> **Schema changes:** None
> **Owner:** `/the-smoker`

## Overview

An OPTIONAL [Portkey.ai](https://portkey.ai) AI-gateway integration. Honeycomb today resolves inference per provider:
the operator stores a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) write-only in the
encrypted vault (PRD-012 / PRD-032), the vault `setting` class records the `activeProvider` / `activeModel`
selection (PRD-044c), and the inference model client (`src/daemon/runtime/inference/model-client-factory.ts`,
PRD-010) resolves the `${SECRET_REF}` to that one provider's key at call time. Reranking is a separate path that
today runs EMBEDDING-COSINE or `none` (PRD-027 / PRD-047), there is no Cohere-rerank provider wired.

This PRD adds a single toggle in Settings, **"Use Portkey gateway"**, that, when ON, SUPERSEDES the per-provider
key resolution and routes Honeycomb's inference (and, in a gated second phase, reranking) through ONE Portkey
endpoint configured by a single `PORTKEY_API_KEY` plus a Portkey config / virtual-key id. Portkey then owns the
provider routing, the model, guardrails, fallbacks, and (for rerank) the Cohere call, so the user configures the
fleet once in Portkey instead of pasting a separate key per provider into Honeycomb.

The toggle is OFF by default and changes NOTHING until a user turns it on and supplies a `PORTKEY_API_KEY`; the
existing per-provider path stays the default and the fallback. The feature reuses the EXISTING surfaces end to end:
the vault `setting` class for the toggle + config (additive keys), the names-only secrets surface for
`PORTKEY_API_KEY` (write-only, presence-only, no new value-returning route), the Settings page provider-keys
section for the UI, and the inference model-client factory seam for the routing swap. No new crypto, no new
persistence, no new design system.

## Goals

- Add an OPTIONAL, default-OFF Portkey toggle to the Settings page that, when enabled, makes Portkey the single
  configured path for inference, superseding the per-provider API keys for one-stop configuration.
- Persist the toggle (`portkey.enabled`) and the Portkey config/virtual-key id (`portkey.config`) as additive vault
  `setting` keys, and store the `PORTKEY_API_KEY` write-only in the encrypted vault with names-only presence, exactly
  the model the other provider keys already use (PRD-044b / D-2).
- Route inference through the Portkey gateway when (and only when) the toggle is ON and a `PORTKEY_API_KEY` is
  present, via an OpenAI-compatible Portkey transport, WITHOUT inlining or logging the key (the `${SECRET_REF}`
  resolver discipline holds, FR-2 of PRD-012).
- Keep usage/cost metering (PRD-060 `UsageSink`) and degradation observability (PRD-029 `/health` reasons) honest
  under Portkey, ROI capture and the health strip must keep working when calls route through the gateway.
- Bring reranking under the same gateway in a GATED sub-feature (063c): light up a Cohere-rerank-via-Portkey path so
  the rerank model is configured in Portkey too, explicitly dependent on the recall rerank seam (PRD-027 / PRD-047),
  not assumed to exist today.
- Define a single PRECEDENCE rule (Portkey-on supersedes provider keys) with a DEFAULT fail-closed posture, plus an
  OPT-IN `portkey.fallbackToProvider` setting that, when on, falls back to the configured provider key if Portkey is
  unreachable. Document both paths.

## Non-Goals

- **Replacing the model-provider router (PRD-010).** Portkey is an ALTERNATE transport selected at the factory seam;
  the per-provider path remains and is the default + fallback. This PRD does not delete the Anthropic transport.
- **A Portkey admin UI inside Honeycomb.** Configs, guardrails, virtual keys, routing, and fallbacks are authored in
  the Portkey dashboard; Honeycomb stores only the API key + the config/virtual-key id that points at that setup.
- **Per-request provider/model authority when Portkey owns it.** When the Portkey config pins the provider+model,
  Honeycomb's `activeProvider`/`activeModel` selectors stop being authoritative for routing (see OQ-2). This PRD does
  not try to reconcile two sources of truth, Portkey wins when on.
- **Building the Cohere-rerank engine path from scratch.** 063c lights up rerank-through-Portkey on top of the recall
  rerank seam; designing the reranker's fusion/scoring is PRD-027 / PRD-047 (recall) and stays there. If that seam is
  not ready, 063c ships behind its flag and reports honestly, never half-wired.
- **Team/hybrid multi-tenant key administration, named keys, or per-agent Portkey configs.** Local-mode single-tenant
  only, like the rest of the Settings surface (PRD-044 posture inherited).
- **Returning a secret value from any endpoint.** There is, and remains, no value-returning secrets route; the
  Portkey key is write-only + presence-only (PRD-032 / D-2).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-063a-portkey-gateway-settings-surface`](./prd-063a-portkey-gateway-settings-surface.md) | The Settings toggle + config field + `PORTKEY_API_KEY` presence; vault `setting` keys (`portkey.enabled`, `portkey.config`); catalog entry; wire schema | Draft |
| [`prd-063b-portkey-gateway-inference-routing`](./prd-063b-portkey-gateway-inference-routing.md) | The Portkey transport + the factory supersession/precedence; usage metering + health under Portkey | Draft |
| [`prd-063c-portkey-gateway-reranking`](./prd-063c-portkey-gateway-reranking.md) | Cohere-rerank-through-Portkey, GATED on the recall rerank seam; rerank-key supersession | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | **Default-OFF, zero-impact.** With `portkey.enabled` unset/false, behavior is byte-identical to today: inference resolves the per-provider key and routes the existing transport; no Portkey code path executes. A test asserts the off-state is a no-op. |
| AC-2 | **Toggle + config + key in Settings (063a).** The Settings page shows a "Use Portkey gateway" toggle, a Portkey config/virtual-key text field, and a `PORTKEY_API_KEY` write-only row with names-only presence ("set ✓" / "not set"). The toggle persists as `portkey.enabled`, the field as `portkey.config`, both validated as known setting keys; the key writes via `POST /api/secrets/PORTKEY_API_KEY`. No endpoint returns the key value (grep-proven). |
| AC-3 | **Inference routes through Portkey when on (063b).** With the toggle ON and `PORTKEY_API_KEY` present, inference calls go to the Portkey gateway (OpenAI-compatible base URL + Portkey auth headers carrying the resolved key + the `portkey.config` id), and the per-provider key is NOT required or read. The key is resolved through the `${SECRET_REF}` resolver and never inlined or logged. |
| AC-4 | **Precedence with opt-in fallback.** Portkey-on supersedes the provider keys. By DEFAULT (fail-closed): Portkey-on-but-misconfigured (no `PORTKEY_API_KEY`, or the gateway rejects/cannot be reached) surfaces an HONEST error and a `/health` reason, and does NOT silently use a provider key. When `portkey.fallbackToProvider` is ON, an UNREACHABLE Portkey gateway falls back to the configured per-provider key (a missing `PORTKEY_API_KEY` is still a hard error, never a silent fallback). Both paths are documented and tested. |
| AC-5 | **Metering + health stay honest (063b).** Usage/cost capture (PRD-060 `UsageSink`) still records tokens/cost for Portkey-routed inference (from Portkey's usage response), and the `/health` reasons gain a `portkey` signal (`ok` / `unconfigured` / `unreachable`) when the toggle is on. ROI does not silently zero out under Portkey. |
| AC-6 | **Reranking is gated and honest (063c).** When the toggle is on AND the recall rerank seam is available, reranking routes Cohere through Portkey using the same key; when the seam is not available, 063c stays behind its flag and the UI/health reports rerank as not-yet-routed, never a half-wired or fabricated rerank. |
| AC-7 | **Security + gate.** No token/secret value in any page, response, or log line; the Portkey key input is write-only and cleared after submit; LOCAL-MODE-ONLY inherited. `npm run ci` / `audit:sql` / `audit:openclaw` / invariant all green. `security-worker-bee` then `quality-worker-bee` sign off before merge. |

## Data model changes

None. Three additive vault `setting`-class keys (`portkey.enabled` boolean, `portkey.config` string,
`portkey.fallbackToProvider` boolean, default false) reuse the existing `SettingValueSchema` scalar contract;
`PORTKEY_API_KEY` is a `secret`-class record under the existing `.secrets/<scope>/` layout. No new tables, columns,
or indexes.

## API changes

- **`/api/settings`** (PRD-032c), no route change; the additive keys `portkey.enabled` + `portkey.config` +
  `portkey.fallbackToProvider` flow through the existing `GET`/`POST /api/settings/:key` once added to
  `KNOWN_SETTING_KEYS` + `validateSettingSemantics` (`src/daemon/runtime/vault/api.ts`).
- **`/api/secrets`** (PRD-012a), no route change; `PORTKEY_API_KEY` uses the existing names-only list + write-only
  `POST /api/secrets/:name`. No value-returning route is added.
- **`/health`** (PRD-029), additive `reasons.portkey` enum (`ok` | `unconfigured` | `unreachable` | `off`),
  mode-gated like the other reasons.

## Decisions

- **D-1, Transport: hand-rolled fetch (lean deps).** The Portkey transport is a hand-rolled `fetch` against the
  Portkey OpenAI-compatible base URL + auth headers, NOT the `portkey-ai` SDK, matching the repo's lean-deps posture
  (`transport-anthropic.ts` is also a hand-rolled fetch) and keeping the bundle / `audit:openclaw` surface small. The
  EXACT Portkey header names + base URL are confirmed against current Portkey docs at build time (never hard-coded
  from memory).
- **D-2, Honeycomb still sends `activeModel`.** When Portkey is on, Honeycomb sends `activeModel` as the requested
  model; the Portkey config may override it per its routing. `activeProvider` is not authoritative for routing when
  Portkey is on (greyed out in the UI per 063a).
- **D-3, Opt-in fallback.** A `portkey.fallbackToProvider` setting (boolean, default false) governs failure behavior.
  DEFAULT (off): fail-closed, a misconfigured/unreachable Portkey surfaces an honest error + `/health` reason. ON: an
  UNREACHABLE Portkey falls back to the configured per-provider key. A MISSING `PORTKEY_API_KEY` is always a hard
  error (never a silent fallback), regardless of this setting.

## Open questions

- [x] **OQ-4, Rerank seam readiness (063c) — RESOLVED 2026-06-27.** 063c OWNS the rerank transport, reusing 063b's
  Portkey foundation, and adds a new `cohere` reranker strategy at the existing `rerankHits` dispatch point (it does
  NOT wait on a separate recall PRD). Confirmed Portkey exposes Cohere rerank via `POST /v1/rerank` (same auth as
  063b). 063c is UNBLOCKED and ready to build; default reranker stays `none` (turning `cohere` on by default is gated
  behind a recall-quality eval). See 063c Decisions c-D-1/c-D-2/c-D-3.
- [ ] **OQ-5, Usage/cost extraction from Portkey.** PRD-060 ROI needs tokens + cost. Portkey returns usage in the
  response (and cost via its analytics); confirm the exact field the `UsageSink` reads from a Portkey response so ROI
  stays populated (063b).

## Related

- **Settings page (same surface, house style):** [PRD-044 Settings Page](../../completed/prd-044-settings-page/prd-044-settings-page-index.md):
  the provider-keys section, the `PROVIDER_KEY_NAME` presence model, the vault `setting`/`secrets` wire methods, the
  LOCAL-MODE-ONLY + no-secret-in-page posture this PRD extends with a Portkey row.
- **Model provider router:** [PRD-010 Model Provider Router](../../completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md):
  the inference model client, the `${SECRET_REF}` resolver, the transport seam Portkey plugs into as an alternate.
- **Encrypted vault (secrets + settings):** [PRD-032 Encrypted Vault](../../completed/prd-032-encrypted-vault/prd-032-encrypted-vault-index.md)
  built on [PRD-012 Secrets](../../completed/prd-012-secrets/prd-012-secrets-index.md):
  `POST /api/secrets/:name` (write-only), `GET /api/secrets` (names only), `GET`/`POST /api/settings`, the provider
  catalog, the `setting`-class scalar contract.
- **Recall ranking + rerank:** [PRD-027 Recall Ranking and Eval](../../completed/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md)
  and [PRD-047 Retrieval Quality Upgrades](../../completed/prd-047-retrieval-quality-upgrades/prd-047-retrieval-quality-upgrades-index.md):
  where rerank runs today (embedding-cosine | `none`) and the seam 063c depends on.
- **ROI / usage metering:** [PRD-060 ROI Tracker](../prd-060-roi-tracker/prd-060-roi-tracker-index.md):
  the `UsageSink` that must keep capturing token/cost under Portkey (AC-5).
- **Degradation observability:** [PRD-029 Degradation Observability](../../completed/prd-029-degradation-observability/prd-029-degradation-observability-index.md):
  the per-subsystem `/health` reasons the additive `portkey` signal joins.
- **Source to touch:** `src/daemon/runtime/vault/catalog.ts` + `vault/api.ts` (catalog entry + setting keys),
  `src/dashboard/web/pages/settings.tsx` + `panels.tsx` + `wire.ts` (toggle/field/key row + wire schema),
  `src/daemon/runtime/inference/model-client-factory.ts` + a new `inference/transport-portkey.ts` (routing seam),
  `src/daemon/runtime/assemble.ts` (`readProviderModelOverride` → Portkey detection + wiring),
  `src/daemon/runtime/recall/config.ts` (the gated rerank hook, 063c).
