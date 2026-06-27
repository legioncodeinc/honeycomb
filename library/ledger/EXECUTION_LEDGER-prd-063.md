# Execution Ledger — PRD-063 Portkey Gateway

> Single source of truth for the `/the-smoker` run. Worktree (pin in every brief):
> `C:\Users\mario\GitHub\honeycomb\.claude\worktrees\cool-lamarr-f0f044`
> Branch: `legion/cool-lamarr-f0f044`. Locked decisions: D-1 hand-rolled fetch (no SDK),
> D-2 send `activeModel`, D-3 opt-in `portkey.fallbackToProvider`.

## Status legend

OPEN · IN PROGRESS · DONE (impl + tests pass) · VERIFIED (independent pass) · BLOCKED

## AC Ledger

| ID | Source | Criterion (short) | Owner Bee | Wave | Status |
|---|---|---|---|---|---|
| a-AC-1 | 063a | Settings renders Portkey toggle + config field + PORTKEY_API_KEY row + fallback toggle | react-worker-bee | W1-B | OPEN |
| a-AC-2 | 063a | The 3 settings persist + round-trip via /api/settings | react-worker-bee | W1-B | OPEN |
| a-AC-3 | 063a | `portkey` catalog entry (openEnded); 3 keys known + validated | typescript-node-worker-bee | W1-A | OPEN |
| a-AC-4 | 063a | PORTKEY_API_KEY write-only + presence; no value route | react-worker-bee + ts-node | W1 | OPEN |
| a-AC-5 | 063a | wire.ts zod `.catch()` defaults degrade safely | react-worker-bee | W1-B | OPEN |
| a-AC-6 | 063a | key input write-only, cleared; local-only; no secret in page | react-worker-bee | W1-B | OPEN |
| b-AC-1 | 063b | `transport-portkey.ts` hand-rolled fetch, OpenAI-compatible (D-1) | typescript-node-worker-bee | W2 | OPEN |
| b-AC-2 | 063b | factory builds Portkey transport when enabled+key; per-provider key not read | typescript-node-worker-bee | W2 | OPEN |
| b-AC-3 | 063b | key resolved via `${SECRET_REF}`; never logged/returned | typescript-node-worker-bee | W2 | OPEN |
| b-AC-4 | 063b | precedence: default fail-closed + opt-in `fallbackToProvider` (D-3) | typescript-node-worker-bee | W2 | OPEN |
| b-AC-5 | 063b | toggle off → byte-identical to today | typescript-node-worker-bee | W2 | OPEN |
| b-AC-6 | 063b | `UsageSink` records tokens/cost under Portkey | typescript-node-worker-bee | W2 | OPEN |
| b-AC-7 | 063b | `/health` `reasons.portkey` (off/ok/unconfigured/unreachable) | typescript-node-worker-bee | W2 | OPEN |
| AC-1 | index | Default-OFF, zero-impact no-op | (covered by b-AC-5) | W2 | OPEN |
| AC-2 | index | Toggle+config+key in Settings | (covered by a-AC-*) | W1 | OPEN |
| AC-3 | index | Inference routes through Portkey when on | (covered by b-AC-2) | W2 | OPEN |
| AC-4 | index | Fail-closed precedence + opt-in fallback | (covered by b-AC-4) | W2 | OPEN |
| AC-5 | index | Metering + health honest | (covered by b-AC-6/7) | W2 | OPEN |
| AC-6 | index | Reranking gated + honest | retrieval-worker-bee | W3 | **BLOCKED** |
| AC-7 | index | Security + quality gate green | security + quality | Close-out | OPEN |
| c-AC-1 | 063c | Route Cohere rerank through Portkey | retrieval-worker-bee | W3 | **BLOCKED** |
| c-AC-2 | 063c | Rerank key resolved via resolver | retrieval-worker-bee | W3 | **BLOCKED** |
| c-AC-3 | 063c | Gated + honest inert when seam unavailable | retrieval-worker-bee | W3 | **BLOCKED** |
| c-AC-4 | 063c | Toggle off → rerank unchanged | (by construction, not touched) | W3 | OPEN |
| c-AC-5 | 063c | Security/quality sign-off | close-out | Close-out | OPEN |

## BLOCKED — parked with a specific ask

- **AC-6 / c-AC-1 / c-AC-2 / c-AC-3 (063c reranking).** Confirmed via code: `src/daemon/runtime/recall/config.ts`
  `DEFAULT_RERANKER = "none"`; the only rerank strategy that exists is embedding-cosine. There is NO provider-rerank
  call site / hook to route Cohere through Portkey. Per parent OQ-4 (unresolved), 063c either (a) depends on a
  PRD-027/047 deliverable that lands a `cohere` provider-reranker hook, or (b) must itself build the rerank-provider
  seam (a recall-engine change owned by `retrieval-worker-bee`, out of scope for a Portkey-routing PRD).
  **Ask:** decide OQ-4 ownership. Until then 063c stays dark; `portkey.enabled` does NOT change reranking, which is
  the honest default (c-AC-4 holds by construction since neither 063a nor 063b touches the recall path).

## Wave plan

- **Wave 1 (parallel, disjoint file trees)** — the Settings surface (063a).
  - **W1-A** `typescript-node-worker-bee` [opus] — DAEMON side only, owns `src/daemon/runtime/vault/**`:
    catalog `portkey` entry (`openEnded: true`); add `portkey.enabled`, `portkey.config`,
    `portkey.fallbackToProvider` to `KNOWN_SETTING_KEYS` + `validateSettingSemantics`; vitest.
  - **W1-B** `react-worker-bee` [sonnet] — DASHBOARD side only, owns `src/dashboard/web/**`:
    Portkey section on settings page (toggle + config field + PORTKEY_API_KEY write-only row + fallback toggle);
    `panels.tsx` `PROVIDER_KEY_NAME += portkey`; `wire.ts` zod schema; DOM/unit tests.
- **Wave 2 (after W1 VERIFIED)** — inference routing (063b).
  - **W2** `typescript-node-worker-bee` [opus] — owns `src/daemon/runtime/inference/**`, `assemble.ts` (the
    `readProviderModelOverride` seam), `health.ts`: new `transport-portkey.ts` (hand-rolled fetch), factory Portkey
    branch + fallback, assemble detection/wiring, `reasons.portkey`, UsageSink wiring; vitest.
- **Wave 3** — 063c assessment.
  - **W3** `retrieval-worker-bee` [opus] — confirm the rerank-seam block, ensure off-path unchanged (c-AC-4), write
    the BLOCKED note. No speculative rerank engine.
- **Close-out** — `security-worker-bee` [opus] then `quality-worker-bee` [opus].
- **Ship** — commit, push, PR, CI to green.

## Run log

- **Wave 1 VERIFIED** (combined independent run): `tsc --noEmit` exit 0; `vitest run tests/daemon/runtime/vault tests/dashboard/web` = 30 files, 355 passed, 2 skipped (pre-existing).
  - W1-A (typescript-node, opus): catalog `portkey` entry (`openEnded:true`); `portkey.enabled`/`portkey.config`/`portkey.fallbackToProvider` added to `KNOWN_SETTING_KEYS` + `validateSettingSemantics`; +7 tests. → a-AC-3 VERIFIED; daemon half of a-AC-4 confirmed (no value route).
  - W1-B (react, sonnet): `PortkeyGatewaySection` (toggle + config + write-only key + fallback toggle) in panels.tsx; settings.tsx wiring + D-2 supersede hint; `PROVIDER_KEY_NAME`/`SETTING_KEY` extended; +13 tests. wire.ts unchanged (existing `.catch` record tolerates new keys). → a-AC-1/2/4/5/6 VERIFIED.
  - Disjoint file trees, no contention. AC-2 (index) VERIFIED.
- **Wave 2 VERIFIED**: 063b inference routing (typescript-node, opus). New `transport-portkey.ts` (hand-rolled fetch; URL+headers verified against live Portkey docs), factory supersession via a synthetic single-account `${PORTKEY_API_KEY}` `InferenceConfig` (bypasses `applyProviderModelOverride`), assemble wiring + cached `unreachable` signal, `reasons.portkey` (off/ok/unconfigured/unreachable) in health.ts + dashboard strip. Shared OpenAI-compatible transport bits factored out to keep jscpd green.
  - Independent verify: `tsc --noEmit` exit 0; `jscpd` 0.51% (clones 27→25); full `vitest run` = 3948 passed, 10 skipped, **2 load-flakes** (`tests/property/json-parsers.property`, `tests/daemon/runtime/secrets/exec`) — both PASS in isolation (23/23), neither file touched by this branch → not regressions. `audit:sql` OK (269 files). `audit:openclaw` needs a prior `npm run build` (ENOENT on openclaw/dist) — runs in GitHub CI, not in `npm run ci`.
  - → b-AC-1..7 VERIFIED; AC-1/AC-3/AC-4/AC-5 VERIFIED. Security flag carried forward: synthetic Portkey target uses `public` privacy tier (router gate bypassed when Portkey on) — for security-worker-bee.
- **Wave 3 (063c) — BLOCKED confirmed** (retrieval-worker-bee assessment): `RERANKER_STRATEGIES = ["embedding-cosine","llm","none"]` (recall/config.ts:195); the only implemented reranker is LOCAL embedding-cosine (memories/recall.ts:1108 `rerankHits`); `llm` is a reserved unbuilt slot; NO provider/HTTP rerank hook exists. Branch does NOT touch recall (`recall/config.ts`, `memories/recall.ts`, `collection.ts` all zero-diff) → **c-AC-4 holds by construction**. c-AC-1/c-AC-2/c-AC-3 remain BLOCKED on OQ-4. Ask: (1) answer c-OQ-2 (is Portkey `/rerank` a first-class route?), (2) confirm 063c owns the rerank transport (reusing 063b's `transport-portkey.ts`) vs a recall PRD. A placeholder slice (register `cohere-via-portkey` token + inert fall-through) is possible but delivers zero functional rerank — NOT taken.
- **Close-out — security (security-worker-bee, opus): CLEAN at Medium+.** 0 Critical, 0 High. Fixed 1 Medium in-session: control-char reject on `portkey.config` (hardens the `x-portkey-config` header) + 2 regression tests. Privacy-tier bypass = Low/accepted (PRD-documented); shipped KB note `library/knowledge/private/security/portkey-privacy-tier.md`. `npm audit` 0 vulns; tsc 0; 455 tests pass. Report: `reports/2026-06-27-security-report.md`.
- **Close-out — quality (quality-worker-bee, opus): 063a+063b SHIP-READY.** tsc exit 0; Portkey suites 455 passed. 0 Critical, 0 Warning, 1 non-blocking Suggestion (S-1: KB pointer to the security report — RESOLVED by filing `reports/2026-06-27-security-report.md`). c-AC-4 confirmed by construction (recall zero-diff). 063c BLOCKED (not FAILED). Report: `qa/prd-063-portkey-gateway-qa.md`.

## Final status

- **063a + 063b: VERIFIED, ship-ready.** a-AC-1..6, b-AC-1..7, index AC-1/2/3/4/5/7 all VERIFIED. Security + quality gates clean.
- **063c: BLOCKED on OQ-4** (no provider-rerank seam; recall untouched so c-AC-4 holds). Parked with a specific ask (decide OQ-4 ownership + c-OQ-2 Portkey `/rerank` route shape). NOT shipped, NOT failed.
- **CI note:** full `vitest run` shows 2 load-induced flakes (`tests/property/json-parsers.property`, `tests/daemon/runtime/secrets/exec`) that pass in isolation and are untouched by this branch. `audit:openclaw` needs a prior `npm run build` (runs in GitHub CI).
