# PRD-063c: Portkey Gateway, Reranking (Cohere via Portkey, gated)

> **Parent:** [PRD-063 Portkey Gateway](./prd-063-portkey-gateway-index.md)
> **Status:** Draft (gated, depends on the recall rerank seam)
> **Priority:** P3
> **Effort:** M
> **Schema changes:** None

## Overview

The reranking half of the one-stop Portkey configuration: route a Cohere reranker through the same Portkey gateway
and key, so the user configures the rerank model in Portkey alongside inference, superseding a standalone Cohere
rerank key. This is the genuinely forward-looking piece of PRD-063, because **Cohere reranking is not wired today**:
the recall pipeline runs an EMBEDDING-COSINE reranker or `none` (`src/daemon/runtime/recall/config.ts`,
`DEFAULT_RERANKER = "none"`), and there is no provider-rerank call site. So 063c is explicitly GATED, it lights up
only once the recall config exposes a provider-rerank hook, and otherwise stays dark and honest rather than shipping
a half-wired rerank.

## Goals

- Add a `cohere-via-portkey` reranker option to the recall rerank seam so, when `portkey.enabled` is on, reranking
  calls Cohere THROUGH the Portkey gateway using the resolved `PORTKEY_API_KEY` + `portkey.config`.
- Supersede a standalone Cohere rerank key the same way inference supersedes provider keys: with Portkey on, rerank
  uses the Portkey path and no separate `COHERE_API_KEY` is required.
- Keep the gate honest: when the recall rerank seam is unavailable, 063c does not execute; the Settings/health surface
  reports rerank as "not yet routed through Portkey" rather than implying it works.

## Non-Goals

- Designing the reranker's scoring/fusion, window, or eval, that is PRD-027 / PRD-047 (recall). 063c only routes an
  existing provider-rerank hook through Portkey.
- Turning rerank ON by default. The recall default stays as PRD-027/047 set it; 063c only changes WHERE a Cohere
  rerank call goes when rerank is enabled AND Portkey is on.
- Inference routing (063b) and the Settings surface (063a).

## User stories

- *As an operator with Portkey on and rerank enabled,* my reranking uses the Cohere model I configured in Portkey,
  billed and observed through Portkey, with no separate Cohere key in Honeycomb.
- *As an operator on a build where the rerank seam is not ready,* the UI tells me rerank-through-Portkey is not yet
  available rather than silently doing nothing or pretending it routed.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | When the recall config exposes a provider-rerank hook AND `portkey.enabled` is on, reranking routes a Cohere rerank request through the Portkey gateway with the resolved `PORTKEY_API_KEY` + `portkey.config`; no `COHERE_API_KEY` is required. |
| c-AC-2 | The Portkey key is resolved via the `${SECRET_REF}` resolver and never inlined, logged, or returned (same discipline as 063b). |
| c-AC-3 | **Gated + honest.** When the rerank seam is unavailable, 063c is inert: no rerank call is attempted through Portkey, and the Settings/health surface reports "rerank not routed through Portkey (seam unavailable)", never a fabricated or half-wired rerank. A test asserts the inert path. |
| c-AC-4 | With `portkey.enabled` off, rerank behavior is exactly as PRD-027/047 define it (no Portkey path). |
| c-AC-5 | Security + gate: no secret in any page/response/log; `security-worker-bee` then `quality-worker-bee` sign off; `npm run ci` green. |

## Implementation notes

- **Dependency first.** Confirm with `retrieval-worker-bee` whether a `cohere` (provider) reranker option lands in
  `recall/config.ts` via PRD-027/047, or whether 063c introduces the provider-rerank seam itself (parent OQ-4). 063c
  should NOT invent a rerank engine; it routes an existing hook.
- **Reuse 063b's transport surface** for the Portkey HTTP call where possible (the gateway base URL + auth headers are
  identical; only the endpoint/payload differs, rerank vs chat-completions). Confirm Portkey's rerank route + payload
  against current Portkey docs (do not hard-code from memory).
- **Key reuse.** No new secret: rerank reuses `PORTKEY_API_KEY`. A standalone `COHERE_API_KEY` is only relevant on the
  non-Portkey path (out of scope here; if/when a direct Cohere rerank lands, it is a separate PRD).
- **Observability.** Fold rerank reachability into the parent `reasons.portkey` health signal (or a sub-reason) so a
  misconfigured rerank is visible, not silent.

## Open questions

- [ ] **c-OQ-1 (→ parent OQ-4).** Ownership of the rerank seam: does the `cohere`/provider reranker option come from a
  recall PRD (027/047) or does 063c add it? Resolve before scheduling 063c.
- [ ] **c-OQ-2.** Does Portkey expose Cohere rerank via a first-class `/rerank` gateway route, or only via provider
  passthrough? Confirm against current Portkey docs; it determines the transport payload shape.

## Related

- [PRD-027 Recall Ranking and Eval](../../completed/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md)
  and [PRD-047 Retrieval Quality Upgrades](../../completed/prd-047-retrieval-quality-upgrades/prd-047-retrieval-quality-upgrades-index.md):
  where rerank lives today and the seam this depends on.
- [PRD-063b Inference Routing](./prd-063b-portkey-gateway-inference-routing.md), the Portkey transport + key
  resolution this reuses.
