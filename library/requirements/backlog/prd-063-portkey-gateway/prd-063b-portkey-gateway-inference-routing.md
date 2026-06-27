# PRD-063b: Portkey Gateway, Inference Routing

> **Parent:** [PRD-063 Portkey Gateway](./prd-063-portkey-gateway-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L
> **Schema changes:** None

## Overview

The behavioral half of PRD-063: when `portkey.enabled` is true and `PORTKEY_API_KEY` is present, Honeycomb's
inference routes through the Portkey gateway instead of resolving a per-provider key and calling the provider's
transport directly. This sub-PRD adds a Portkey transport and wires the supersession at the model-client factory
seam, then keeps usage metering and health observability honest under the new path.

The crux is the SUPERSESSION, not a model swap. The existing `applyProviderModelOverride()` mechanism
(`model-client-factory.ts:136-143`) swaps the provider/model strings but keeps the `${SECRET_REF}` pointed at the
original provider's key, that is the wrong tool here. Instead, when Portkey is on, the factory resolves
`PORTKEY_API_KEY` and constructs a Portkey transport (OpenAI-compatible base URL + Portkey auth headers carrying the
key and the `portkey.config` id), bypassing the per-provider key entirely.

## Goals

- Add `src/daemon/runtime/inference/transport-portkey.ts`: an OpenAI-compatible `ProviderTransport`
  (`execute` / `stream`) that targets the Portkey gateway base URL and attaches the Portkey auth headers (resolved
  key + config id), conforming to the existing `ProviderTransport` interface (`inference/contracts.ts:420-425`).
- Wire the supersession at assembly (`assemble.ts` `readProviderModelOverride` → `buildInferenceModelClient`,
  `model-client-factory.ts:157-192`): when `portkey.enabled` is true, build the Portkey transport from the resolved
  `PORTKEY_API_KEY` + `portkey.config`; otherwise keep today's per-provider path unchanged.
- Resolve `PORTKEY_API_KEY` through the existing `${SECRET_REF}` secret resolver (`createSecretResolver`,
  `secrets/store.ts`) so the key is decrypted in-process at call time and NEVER inlined, logged, or returned.
- Enforce the PRECEDENCE rule (parent AC-4 / D-3): Portkey-on supersedes provider keys. DEFAULT fail-closed: a
  missing `PORTKEY_API_KEY` or an unreachable gateway yields an honest error + a `/health` `reasons.portkey` signal,
  never a silent provider-key fallback. When `portkey.fallbackToProvider` is ON, an UNREACHABLE gateway falls back to
  the configured per-provider key (a missing `PORTKEY_API_KEY` stays a hard error regardless).
- Keep PRD-060 usage/cost metering (`UsageSink`) populated from the Portkey response, and add the `reasons.portkey`
  health enum (PRD-029).

## Non-Goals

- The Settings UI / vault keys (063a) and the rerank path (063c).
- Removing or refactoring the Anthropic transport, it stays as the default and as the opt-in (via
  `portkey.fallbackToProvider`, D-3) fallback target.
- Streaming-specific Portkey features (caching, semantic cache, request tracing IDs) beyond passing the config that
  enables them server-side at Portkey, Honeycomb sends the config and consumes the standard response.

## User stories

- *As an operator with Portkey on,* my pollinating/inference calls succeed using only my Portkey key + config, with no
  Anthropic/OpenAI key stored, and my ROI page still shows token/cost for those calls.
- *As an operator who enabled Portkey but forgot the key,* I get a clear "Portkey enabled but PORTKEY_API_KEY not set"
  error and a red `portkey` health reason, not a confusing silent success on some other provider.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | A `transport-portkey.ts` `ProviderTransport` exists, OpenAI-compatible, hand-rolled `fetch` (no `portkey-ai` SDK, parent D-1), targeting the Portkey base URL with Portkey auth headers (resolved `PORTKEY_API_KEY` + `portkey.config`). Header names + base URL confirmed against current Portkey docs at build, not hard-coded from memory. |
| b-AC-2 | With `portkey.enabled` true + key present, `buildInferenceModelClient` constructs the Portkey transport and inference executes through it; the per-provider key is neither required nor read. A test with a fake fetch asserts the request hits the Portkey URL with the resolved key in the header and the config id attached. |
| b-AC-3 | The key is resolved via the `${SECRET_REF}` resolver and appears in NO log line, NO telemetry, and NO response body (grep-proven; reuse the PRD-012 no-leak discipline). |
| b-AC-4 | **Precedence with opt-in fallback (D-3).** DEFAULT (`portkey.fallbackToProvider` off): Portkey-on with no `PORTKEY_API_KEY` → typed, honest error + `reasons.portkey = "unconfigured"`; gateway unreachable/auth-rejected → typed error + `reasons.portkey = "unreachable"`; neither path silently uses a provider key. With `portkey.fallbackToProvider` ON: an unreachable gateway falls back to the configured per-provider path, while a missing `PORTKEY_API_KEY` STILL hard-errors. All branches tested. |
| b-AC-5 | With `portkey.enabled` false/unset, the Portkey transport is never constructed and behavior is byte-identical to today (parent AC-1). |
| b-AC-6 | `UsageSink` records tokens/cost for Portkey-routed calls from the Portkey usage response (parent OQ-5); the ROI page does not zero out under Portkey. A test asserts usage is captured from a representative Portkey response shape. |
| b-AC-7 | `/health` carries `reasons.portkey` (`off` | `ok` | `unconfigured` | `unreachable`), mode-gated like the other reasons; the dashboard health strip renders it. |

## Implementation notes

- **Transport** (`inference/transport-portkey.ts`, modeled on `transport-anthropic.ts:1-97, 420-425`): Portkey is
  OpenAI chat-completions compatible, so the request/response handling mirrors an OpenAI-compatible transport with a
  Portkey base URL and the Portkey auth headers. Inject the base URL + a header-builder closure so a test can point it
  at a fake fetch (the same seam `ANTHROPIC_MESSAGES_URL` provides).
- **Factory wiring** (`model-client-factory.ts:157-192` + `assemble.ts` `readProviderModelOverride`): branch on
  `portkey.enabled`. When on, resolve `PORTKEY_API_KEY` via the secret resolver and build the Portkey transport with
  the `portkey.config` id; do NOT route through `applyProviderModelOverride` (which preserves the per-provider
  `apiKeyRef`). When off, the existing path is untouched.
- **Model param** (parent D-2): send `activeModel` as the requested model; the Portkey config may override per its
  routing. `activeProvider` is not authoritative when Portkey is on.
- **Fallback** (parent D-3): read `portkey.fallbackToProvider`. When OFF (default), an unreachable Portkey returns a
  typed error (fail-closed). When ON, catch the unreachable/transport error and route the SAME request through the
  existing per-provider path (resolving the provider's `${SECRET_REF}` as today). A missing `PORTKEY_API_KEY` is a
  hard error in BOTH cases, never a silent fallback. Surface the fallback in `reasons.portkey` so a degraded route is
  visible, not hidden.
- **Usage** (`UsageSink`, PRD-060d): extract tokens/cost from the Portkey response (confirm exact fields, OQ-5) so ROI
  capture continues. Portkey returns usage in the response and cost via its headers/analytics.
- **Health** (PRD-029 `health.ts`): add the `portkey` reason; `off` when the toggle is off, `unconfigured` when on but
  no key, `unreachable` on a failed probe/call, `ok` otherwise.
- **Privacy tier note** (`inference/contracts.ts:165-178` `Target`): Portkey abstracts the underlying provider, so the
  router's per-provider privacy-tier reasoning is bypassed when Portkey is on; document this in the KB so it is a
  conscious trade-off, not a silent regression. Flag for `security-worker-bee`.

## Decisions (inherited from parent)

- **D-1** hand-rolled `fetch` transport, no SDK. **D-2** send `activeModel`; Portkey config may override.
  **D-3** opt-in `portkey.fallbackToProvider` (default off = fail-closed; on = fall back to the provider key on an
  unreachable gateway, missing key still hard-errors).

## Open questions

- [ ] **b-OQ-1 (→ parent OQ-5).** Exact `UsageSink` field mapping from a Portkey response so ROI stays populated.
- [ ] **b-OQ-2 (build-time, not a design question).** Confirm the exact Portkey base URL + auth header names
  (`x-portkey-api-key`, the config / virtual-key header) against current Portkey docs before coding; do not hard-code
  from memory.

## Related

- [PRD-010 Model Provider Router](../../completed/prd-010-model-provider-router/prd-010-model-provider-router-index.md):
  the factory seam, the `${SECRET_REF}` resolver, the `ProviderTransport` interface.
- [PRD-060 ROI Tracker](../prd-060-roi-tracker/prd-060-roi-tracker-index.md), the `UsageSink` that must keep capturing
  under Portkey.
- [PRD-029 Degradation Observability](../../completed/prd-029-degradation-observability/prd-029-degradation-observability-index.md):
  the `/health` reasons the `portkey` signal joins.
