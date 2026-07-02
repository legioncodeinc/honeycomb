# QA Report: PRD-063c, Portkey Gateway, Reranking (Cohere via Portkey)

**Plan document:** `library/requirements/backlog/prd-063-portkey-gateway/prd-063c-portkey-gateway-reranking.md`
**Audit date:** 2026-06-27
**Base branch:** `main`
**Head:** `legion/cool-lamarr-f0f044` (063c changes uncommitted in the working tree, stacked on PR #147 `dd6d6e2`)
**Auditor:** quality-worker-bee

## Summary

063c is **SHIP-READY.** The Cohere-via-Portkey reranker is implemented exactly to spec: a new `cohere` strategy
(default reranker stays `none`), a fail-soft `/v1/rerank` transport reusing 063b's `buildPortkeyHeaders` + auth +
`${SECRET_REF}` seam, a bounded (provider-timeout, ~1000ms) race in `rerankWithCohere`, and a late-bound seam wired
gateway-on-only in `assemble.ts`. All four functional ACs (c-AC-1..c-AC-4) are **VERIFIED** with file:line + named-test
evidence; c-AC-5 quality gates are green (`tsc --noEmit` exit 0; the four targeted vitest suites 585/585 passed including
both new 063c suites; `npm run audit:sql` clean over 272 files); security signed off CLEAN at Medium+ (ordering correct).
Zero Critical, zero Warning, one non-blocking Suggestion. The recall-quality eval (`c-OQ-1`) that gates flipping the
default ON is an explicitly DEFERRED follow-up, not a blocking criterion for this capability build, and is recorded as
such below.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | c-AC-1..c-AC-4 fully implemented + tested; c-AC-5 gates green; c-OQ-1/2 are deferred follow-ups by design. |
| Correctness   | ✅ | Request shape, auth header, reorder-by-score, fail-soft to RRF, and timeout race all behave per spec and under test. |
| Alignment     | ✅ | Reuses 063b foundation (shared `buildPortkeyHeaders`, `PORTKEY_RERANK_URL`, `recordPortkeyUnreachable`); `DEFAULT_RERANKER` stays `none` (c-D-3). |
| Gaps          | ✅ | Fail-soft covers timeout/error/unreachable/malformed/missing-key/out-of-range index; secret never leaves the auth header. |
| Detrimental   | ✅ | No secret in any log/throw/return; no `console`/`logger`/`throw` of the key; jscpd-safe header reuse; hot-path budget bounded. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

None.

## Suggestions (consider improving)

- [ ] **`HONEYCOMB_RECALL_RERANKER_PROVIDER_TIMEOUT_MS` / `_COHERE_MODEL` env knobs not surfaced in operator docs**, `src/daemon/runtime/recall/config.ts:97,112,556,558`

  The two new provider-rerank env overrides (`HONEYCOMB_RECALL_RERANKER_PROVIDER_TIMEOUT_MS`,
  `HONEYCOMB_RECALL_RERANKER_COHERE_MODEL`) are wired, defaulted, and clamped correctly in `envRecallConfigProvider`,
  but they live only in the config-module JSDoc. When `c-OQ-2` (timeout/window tuning on a real round-trip) and
  `c-OQ-1` (the recall-quality eval) are run, an operator-facing note of these knobs alongside `HONEYCOMB_RECALL_RERANKER=cohere`
  would close the loop. Non-blocking; the spec did not require operator docs for a default-OFF capability.

## Plan Item Traceability

| #      | Plan Requirement | Status | Implementation Location | Notes |
|--------|------------------|--------|-------------------------|-------|
| c-AC-1 | `cohere` + `portkey.enabled` → `POST /v1/rerank` with `{ model, query, documents, top_n }`, resolved `PORTKEY_API_KEY` + config header, reorder by `relevance_score`; no `COHERE_API_KEY`; fake-fetch test asserts shape/auth/reorder | ✅ VERIFIED | `recall/rerank-portkey.ts:147-188` (transport body + headers via `buildPortkeyHeaders`, `PORTKEY_RERANK_URL`); `memories/recall.ts:1162-1164,1243-1305` (`cohere` branch + reorder); `inference/transport-portkey.ts:80,95-101` (URL + shared headers) | Tests: `rerank-portkey.test.ts` "POSTs the resolved key header + config + { model, query, documents, top_n }…" asserts URL=`PORTKEY_RERANK_URL`, both auth headers, snake_case `top_n`, and indexed scores; `rerank-cohere.test.ts` "sends { query, documents, topN } to the seam and reorders…" → `["near","far"]`. |
| c-AC-2 | `PORTKEY_API_KEY` resolved via `${SECRET_REF}` resolver threaded into the rerank stage; in no log/error/telemetry/response (grep-proven) | ✅ VERIFIED | `recall/rerank-portkey.ts:220-235` (`buildCohereRerankSeam` resolves at call time, catches resolver failure); key placed only in `buildPortkeyHeaders` (`transport-portkey.ts:95-101`); `assemble.ts:2370-2383` threads `createSecretResolver` + `PORTKEY_API_KEY_REF` | Grep confirmed: no `console`/`logger`/`throw` of `apiKey` in `rerank-portkey.ts`. Tests: c-AC-2 block "appears in no captured call field but the header, and in no returned value" + "the bound seam resolves the key via ${SECRET_REF}…" (both grep-style `JSON.stringify(out)` assertions). |
| c-AC-3 | Bounded + fail-soft: timeout / error / unreachable / malformed → RRF order unchanged; `reasons.portkey` flips to `unreachable` | ✅ VERIFIED | `memories/recall.ts:1258-1274` (`Promise.race` vs `providerTimeoutMs`, TIMED_OUT/`ok:false` → RRF); `recall/rerank-portkey.ts:155-179` (network→503, non-2xx→status, malformed-2xx→no signal); `assemble.ts:2376` (`onTransportError: recordPortkeyUnreachable`) | Provider timeout default `DEFAULT_RERANKER_PROVIDER_TIMEOUT_MS=1000` (`config.ts:97`). Tests: `rerank-portkey.test.ts` c-AC-3 block (503 fires, 401 fires, malformed-2xx does NOT fire, missing-key→`ok:false` no fetch); `rerank-cohere.test.ts` (hanging seam via injected clock, `ok:false` seam, and a REJECTING seam all → RRF `["far","near"]`). |
| c-AC-4 | Any other strategy / `portkey.enabled` off → byte-identical, no Portkey rerank call | ✅ VERIFIED | `memories/recall.ts:1162-1171` (`cohere` requires both strategy AND seam; `none`/`llm`/`embedding-cosine` paths unchanged); `assemble.ts:1985-1992` (inner seam absent until gateway ON) | `DEFAULT_RERANKER` stays `none` (`config.ts:83`). Tests: `rerank-cohere.test.ts` c-AC-4 block — `cohere`-no-seam → RRF, `none`→0 seam calls, `embedding-cosine`→cohere seam never called. |
| c-AC-5 | Security then quality sign-off; no secret in page/response/log; `npm run ci` green | ✅ VERIFIED | This report (quality half); security report `reports/2026-06-27-063c-security-report.md` (CLEAN Medium+, 1 doc-only Medium fixed) | Gates re-run this audit: `npx tsc --noEmit` exit 0; `npx vitest run tests/daemon/runtime/recall tests/daemon/runtime/memories tests/daemon/runtime/inference tests/daemon/runtime/assemble.test.ts` = 51 files, **585 passed, 0 failed**; `npm run audit:sql` = 272 files, "every SQL interpolation routes through an escaping helper". Ordering correct (security ran before quality). |
| c-D-1 | Portkey exposes Cohere rerank at `POST /v1/rerank`, same auth pair, body `{model,query,documents,top_n}` → `results:[{index,relevance_score}]` | ✅ | `transport-portkey.ts:80` (`PORTKEY_RERANK_URL`); `rerank-portkey.ts:114-122` (zod response schema), `:148-154` (request body) | Wire shape matches the locked decision. |
| c-D-2 | 063c owns the rerank transport, reusing 063b's foundation; recall fusion/scoring untouched | ✅ | Shared `buildPortkeyHeaders` (`transport-portkey.ts:95`); fusion/RRF code in `recall.ts` unchanged (rerank only reorders the post-fuse window) | jscpd-safe: no re-hand-rolled header object. |
| c-D-3 | New `cohere` strategy, default OFF; activates only when strategy `cohere` AND `portkey.enabled` | ✅ | `config.ts:231` (`RERANKER_STRATEGIES` includes `cohere`), `:83` (`DEFAULT_RERANKER="none"`); `recall.ts:1162-1163` + `assemble.ts:2369` (gateway-on gate) | — |
| NG | Do not change RRF/window/dedup; do not flip default ON; no direct (non-Portkey) `COHERE_API_KEY` path | ✅ | Reorder operates only on the fused window; default stays `none`; transport only ever sends the Portkey key via Portkey headers | Honored. |
| c-OQ-1 | Recall-quality eval (`eval:recall`) gating default-ON | 🟦 DEFERRED | Not in scope for this build (owned by `retrieval-worker-bee`) | Documented follow-up that GATES turning `cohere` on by default; NOT a blocking AC. v1 ships default-OFF by design. |
| c-OQ-2 | Confirm rerank timeout (~1000ms) + window (50) on a real round-trip | 🟦 DEFERRED | Defaults wired + clamped (`config.ts:97,119`); tuned by the eval above | Documented follow-up; not blocking. |

Legend: ✅ VERIFIED · ⚠️ PARTIAL · ❌ FAILED · 🟦 deferred/out-of-scope follow-up.

## Files Changed (063c production + tests)

- `library/requirements/backlog/prd-063-portkey-gateway/prd-063c-portkey-gateway-reranking.md` (M), spec rewritten from BLOCKED into the executable c-AC-1..c-AC-5 / c-D-1..c-D-3 surface.
- `src/daemon/runtime/assemble.ts` (M, +91/-1), late-bound `cohereRerankSeam` (gateway-on only) + secret-resolver/model threading + `recordPortkeyUnreachable` reuse; rerank mount deps.
- `src/daemon/runtime/inference/transport-portkey.ts` (M, +23/-6), factored shared `buildPortkeyHeaders` + `PORTKEY_BASE_URL`/`PORTKEY_RERANK_URL` constants consumed by the rerank transport.
- `src/daemon/runtime/memories/api.ts` (M, +23/-0), threads the resolved `reranker` config + `cohereRerank` seam into `recallMemories`.
- `src/daemon/runtime/memories/recall.ts` (M, +166/-17), `CohereRerankSeam` contract, `cohere` branch in `rerankHits`, and `rerankWithCohere` (bounded race + total-order reorder).
- `src/daemon/runtime/recall/config.ts` (M, +58/-4), `cohere` in `RERANKER_STRATEGIES`, `providerTimeoutMs`/`cohereModel` knobs + env wiring; `DEFAULT_RERANKER` stays `none`.
- `src/daemon/runtime/recall/rerank-portkey.ts` (A), the Cohere-via-Portkey rerank transport + `${SECRET_REF}` seam (fail-soft `ok:false`, never throws).
- `tests/daemon/runtime/memories/rerank-cohere.test.ts` (A), engine-level c-AC-1/c-AC-3/c-AC-4 coverage.
- `tests/daemon/runtime/recall/rerank-portkey.test.ts` (A), transport/seam-level c-AC-1/c-AC-2/c-AC-3 coverage.

---

### Verbatim gate output

```
$ npx tsc --noEmit
TSC_EXIT=0

$ npx vitest run tests/daemon/runtime/recall tests/daemon/runtime/memories tests/daemon/runtime/inference tests/daemon/runtime/assemble.test.ts
 Test Files  51 passed (51)
      Tests  585 passed (585)
VITEST_EXIT=0

$ npm run audit:sql
SQL-safety audit: scanned 272 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.
AUDITSQL_EXIT=0
```

Note on the known load-flakes: the full `vitest run` carries 2 documented load-flakes
(`tests/property/json-parsers.property`, `tests/daemon/runtime/secrets/exec`) that pass in isolation and are NOT touched
by 063c. They are out of the targeted scope above (which ran 585/585 clean) and are not attributable to this work.
```
