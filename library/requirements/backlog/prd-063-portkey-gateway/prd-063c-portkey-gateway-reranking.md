# PRD-063c: Portkey Gateway, Reranking (Cohere via Portkey)

> **Parent:** [PRD-063 Portkey Gateway](./prd-063-portkey-gateway-index.md)
> **Status:** Backlog (UNBLOCKED 2026-06-27, ready to build)
> **Priority:** P3
> **Effort:** M
> **Schema changes:** None

## Overview

Route a Cohere reranker through the same Portkey gateway and `PORTKEY_API_KEY` that 063b already wired for inference,
so the operator configures the rerank model in Portkey alongside inference, superseding a standalone Cohere rerank
key. Today Honeycomb's recall pipeline reranks with a LOCAL embedding-cosine pass or `none` (no provider/HTTP
reranker exists). This sub-PRD adds the FIRST provider reranker: a `cohere` strategy that, when Portkey is on, sends
the query + candidate document TEXTS to Cohere through Portkey's gateway and reorders the fused top-N window by the
returned relevance scores.

This was blocked on two open questions; both are now resolved (see Decisions). The Portkey HTTP plumbing, auth, and
secret resolution from 063b are reused, so the new surface is a rerank transport (different path + payload) plus a
single branch at the existing rerank dispatch point and one new dependency: the rerank stage gains access to the
`${SECRET_REF}` resolver it does not have today.

## Decisions (the unblock)

- **c-D-1, Portkey exposes Cohere rerank (resolves c-OQ-2).** Verified against current Portkey docs (Gateway to Other
  APIs): `POST https://api.portkey.ai/v1/rerank`, authenticated with the SAME `x-portkey-api-key` + config/virtual-key
  header pair 063b uses. Body is Cohere's rerank shape `{ model, query, documents: string[], top_n }`; the response
  carries `results: [{ index, relevance_score }]`. So the gateway host + auth are identical to inference, only the
  path (`/v1/rerank`) and the request/response shape differ.
- **c-D-2, 063c owns the rerank transport, reusing 063b (resolves parent OQ-4).** The rerank HTTP call is built in
  THIS sub-PRD on top of 063b's `transport-portkey.ts` foundation (shared base host, the `x-portkey-api-key` +
  `x-portkey-config` header builder, the `${SECRET_REF}` resolution, and the `reasons.portkey` health signal). The
  recall-engine fusion/scoring stays in PRD-027/047 territory and is NOT touched.
- **c-D-3, a new `cohere` reranker strategy, default OFF.** Add `cohere` to `RERANKER_STRATEGIES`
  (`recall/config.ts`). When the strategy is `cohere` AND `portkey.enabled`, rerank routes through Portkey with
  `PORTKEY_API_KEY` (superseding a standalone Cohere key). The DEFAULT reranker stays `none` (PRD-047b); turning
  `cohere` on by default is gated behind a recall-quality eval (see Open questions), because PRD-047b's eval found the
  local embedding-cosine rerank did not beat RRF on Honeycomb's data, so a provider reranker must EARN the default.

## Goals

- Build a Cohere-via-Portkey reranker (`POST /v1/rerank`) reusing 063b's Portkey transport foundation, selected by the
  new `cohere` strategy and the `portkey.enabled` toggle.
- Wire it into the single existing rerank dispatch point (`rerankHits`, `memories/recall.ts`) behind the new branch,
  threading the `${SECRET_REF}` resolver into the rerank stage (its one new dependency).
- Make it LATENCY-BOUNDED and FAIL-SOFT: an outbound rerank call that times out, errors, or hits an unreachable
  gateway falls back to the RRF order and never breaks or stalls recall beyond the timeout; failures feed
  `reasons.portkey`.
- Supersede a standalone Cohere rerank key: with Portkey on, rerank uses `PORTKEY_API_KEY`; no separate
  `COHERE_API_KEY` is required.

## Non-Goals

- Designing the reranker's fusion/scoring or changing RRF, the window, or the dedup. 063c only adds a provider rerank
  call behind the existing seam (PRD-027/047 own the recall algorithm).
- Turning `cohere` rerank ON by default. Default stays `none`; flipping the default is a separate, eval-gated change.
- A direct (non-Portkey) `COHERE_API_KEY` rerank path. Out of scope; if wanted later it is its own small PRD.
- Inference routing (063b) and the settings surface (063a), which are shipped.

## User stories

- *As an operator with Portkey on and `cohere` rerank selected,* my recall reranks via the Cohere model I configured
  in Portkey, billed and observed through Portkey, with no separate Cohere key in Honeycomb, and recall never stalls
  if the gateway is slow (it falls back to the unranked-fused order within the timeout).
- *As an operator who has not enabled Portkey or selected `cohere`,* my reranking is byte-identical to today.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | With reranker strategy `cohere` AND `portkey.enabled`, `rerankHits` sends `{ model, query, documents, top_n }` (documents = the fused top-N candidate texts) to `POST https://api.portkey.ai/v1/rerank` with the resolved `PORTKEY_API_KEY` + config header, and reorders the window by the returned `results[].relevance_score`. No `COHERE_API_KEY` is required. A fake-fetch test asserts the request shape, the auth header, and the reorder. |
| c-AC-2 | `PORTKEY_API_KEY` is resolved via the `${SECRET_REF}` resolver threaded into the rerank stage; it appears in no log line, error, telemetry, or response (grep-proven, same discipline as 063b). |
| c-AC-3 | **Bounded + fail-soft.** A rerank call that exceeds the rerank timeout, errors, or hits an unreachable gateway returns the RRF order unchanged (recall never breaks or blocks beyond the timeout); the failure flips `reasons.portkey` to `unreachable`. Tested with a hanging/error fake fetch. |
| c-AC-4 | With any strategy other than `cohere` (or `portkey.enabled` off), rerank behavior is byte-identical to today: `embedding-cosine` and `none` paths unchanged; no Portkey rerank call is made. Tested. |
| c-AC-5 | Security (`security-worker-bee`) then quality (`quality-worker-bee`) sign off; no secret in any page/response/log; `npm run ci` green. |

## Implementation notes

- **Strategy token** (`src/daemon/runtime/recall/config.ts`): add `"cohere"` to `RERANKER_STRATEGIES`
  (currently `["embedding-cosine", "llm", "none"]`); it is selectable via the existing `HONEYCOMB_RECALL_RERANKER`
  env and the `recallMode`/reranker setting path. `DEFAULT_RERANKER` stays `none`.
- **Rerank transport** (new, e.g. `src/daemon/runtime/inference/transport-portkey-rerank.ts` or a `recall/` sibling):
  reuse 063b's Portkey base host + `x-portkey-api-key`/`x-portkey-config` header builder + injectable `fetch`. The ONE
  difference from the chat transport is the path (`/v1/rerank`) and the Cohere body/response shape. Confirm the exact
  `model` id format (e.g. `rerank-v3.5` / `rerank-v4.0`) against current Portkey/Cohere docs at build.
- **Dispatch branch** (`src/daemon/runtime/memories/recall.ts`, `rerankHits` ~line 1108): today
  `if (config.strategy !== "embedding-cosine") return rrfOrder;`. Add a `cohere` branch that, when `portkey.enabled`,
  builds `documents` from the fused candidates' `text`, calls the rerank transport with a bounded timeout, and maps
  `results[].index` back onto the candidate order. Any failure → `return rrfOrder` (fail-soft).
- **Resolver threading** (the one new dependency): the rerank stage currently has no vault/secret dependency. Thread
  the `SecretResolver` (or the resolved key callback) from assembly into the recall config/rerank path, the same
  `${SECRET_REF}` seam 063b uses. Keep it injected for tests.
- **Timeout/latency** (hot-path discipline): the local `DEFAULT_RERANKER_TIMEOUT_MS = 300` is too tight for an
  outbound call. Add a rerank-specific timeout (propose ~1000ms, configurable) and ALWAYS fall back to RRF on exceed,
  so a slow gateway adds at most the timeout to a recall, never a hang. This is the conscious latency/cost trade-off
  of an external reranker on every recall.
- **Observability**: fold rerank reachability into `reasons.portkey` (reuse the 063b `recordPortkeyUnreachable`
  signal) so a misconfigured rerank is visible.

## Open questions

- [ ] **c-OQ-1, the rerank-quality eval (gates default-on).** PRD-047b found the local embedding-cosine reranker did
  not beat RRF on Honeycomb's data (hence `DEFAULT_RERANKER = "none"`). Before `cohere` is ever made the default, run
  a recall-quality eval (`eval:recall`) on real data to confirm Cohere rerank actually improves results enough to
  justify the per-query latency + cost. Owned by `retrieval-worker-bee`. v1 ships the capability default-OFF.
- [ ] **c-OQ-2, rerank timeout + window defaults.** Confirm the latency budget (proposed 1000ms timeout, window 50)
  against a real Portkey+Cohere round-trip; tune via the eval above.

## Related

- [PRD-063b Inference Routing](./prd-063b-portkey-gateway-inference-routing.md): the Portkey transport + key
  resolution + `reasons.portkey` this reuses.
- [PRD-027 Recall Ranking and Eval](../../completed/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md)
  and [PRD-047 Retrieval Quality Upgrades](../../completed/prd-047-retrieval-quality-upgrades/prd-047-retrieval-quality-upgrades-index.md):
  the rerank dispatch point (`rerankHits`), the strategies, and the eval discipline that gates default-on.
- Portkey rerank reference: Gateway to Other APIs (`POST /v1/rerank`), Cohere Rerank API.
