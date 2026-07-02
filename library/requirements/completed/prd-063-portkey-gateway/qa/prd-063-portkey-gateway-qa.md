# QA Report — PRD-063 Portkey Gateway

> **Auditor:** `quality-worker-bee` (final close-out, `/the-smoker` run)
> **Date:** 2026-06-27
> **Branch / worktree:** `legion/cool-lamarr-f0f044` @ `9620f16` (base) — uncommitted working tree
> **Source plan:** `library/requirements/backlog/prd-063-portkey-gateway/` (index + 063a + 063b + 063c)
> **Ledger:** `library/ledger/EXECUTION_LEDGER-prd-063.md`
> **Ordering:** `security-worker-bee` ran first (clean at Medium+) → quality second. Correct. No ordering violation.

## Summary

PRD-063a (settings surface) and 063b (inference routing) are **ship-ready**. Every a-AC (1–6) and b-AC (1–7),
and the index ACs they cover (AC-1/2/3/4/5), are VERIFIED against the implementation with file:line and
named-test evidence; independent `tsc --noEmit` is clean (exit 0) and the targeted suites pass 455/455 (2
pre-existing skips). 063c (reranking) is correctly **BLOCKED** on parent OQ-4 (no provider-rerank seam exists);
c-AC-4 holds **by construction** (the branch leaves `recall/config.ts` and `memories/recall.ts` zero-diff). AC-7
security half is signed off by `security-worker-bee`; this report is the quality half. Findings are limited to
one Suggestion (a stale doc pointer). No Critical or Warning findings.

## Scorecard

| Axis | Status | Notes |
|---|---|---|
| **Completeness** | PASS | All in-scope a-AC/b-AC implemented + tested; 063c honestly parked, not faked. |
| **Correctness** | PASS | `tsc` exit 0; 455 targeted tests green; tests assert real wire behavior (URLs, headers, fail-closed). |
| **Alignment** | PASS | D-1 (hand-rolled fetch), D-2 (sends `activeModel`), D-3 (opt-in fallback) all implemented as the plan specifies. |
| **Gaps** | PASS | Off-path byte-identical (b-AC-5 proven); recall path untouched (c-AC-4 by construction). |
| **Detrimental patterns** | PASS | No key logging; names-only secret surface preserved; control-char header-injection guard added; privacy-tier trade-off documented. |

## Independent verification (run by this auditor, cited verbatim)

- `npx tsc --noEmit` → **exit 0** (no output).
- `npx vitest run tests/daemon/runtime/inference tests/daemon/runtime/vault tests/dashboard/web` →
  **`Test Files 41 passed (41)` / `Tests 455 passed | 2 skipped (457)`**, exit 0. Portkey-specific files included:
  `transport-portkey.test.ts (11)`, `model-client-factory-portkey.test.ts (8)`, `settings-api.test.ts (22)`,
  `settings-page.test.tsx (24)`, `wire.test.ts (34)`, `health.test.ts`, `app.test.tsx (12)`.
- The 2 skips are the long-standing `vault.test.ts` + `build-output.test.ts` skips, **not** the load-flakes named
  in the brief (`tests/property/json-parsers.property`, `tests/daemon/runtime/secrets/exec` are outside this command's
  scope and untouched by the branch — not attributed to PRD-063).

## Critical issues (must fix)

None.

## Warnings (should fix)

None.

## Suggestions (consider improving)

- **S-1 — Stale doc pointer in the privacy-tier KB note.**
  `library/knowledge/private/security/portkey-privacy-tier.md:38-39` references "the 2026-06-27 security audit in the
  PRD-063 reports folder", but `library/requirements/backlog/prd-063-portkey-gateway/reports/` contains only
  `.gitkeep` — the security report is not (yet) filed there. Either land the security-worker-bee report in that
  folder or soften the pointer. Non-blocking; the security sign-off itself was confirmed clean by the brief.

## Plan-item traceability

Legend: VERIFIED (independent pass) · PARTIAL · FAILED · BLOCKED.

### PRD-063a — settings surface

| AC | Status | Evidence |
|---|---|---|
| a-AC-1 | VERIFIED | `PortkeyGatewaySection` renders toggle + config input + write-only key row + fallback toggle from DS primitives — `src/dashboard/web/panels.tsx:695-885` (`data-testid="portkey-gateway-section"`). Test: `settings-page.test.tsx:329` "renders the gateway section with all four controls". |
| a-AC-2 | VERIFIED | Toggles persist via `onSaveSetting(SETTING_KEY.portkeyEnabled/…Fallback, bool)`; config commits on blur/Enter (`panels.tsx:738-742, 760-768`). Round-trip wired in `settings.tsx:513-549`. Tests: `settings-page.test.tsx:371,385,400,415`. |
| a-AC-3 | VERIFIED | Catalog entry `{id:"portkey", openEnded:true, models:[]}` — `catalog.ts:84-92`; `portkey.enabled/config/fallbackToProvider` added to `KNOWN_SETTING_KEYS` (`api.ts:58-66`) + typed validation in `validateSettingSemantics` (`api.ts:256-279`, non-boolean toggle / non-string config → 400). Tests: `settings-api.test.ts` (22 pass, incl. type-rejection cases). |
| a-AC-4 | VERIFIED | `PROVIDER_KEY_NAME.portkey = "PORTKEY_API_KEY"` (`panels.tsx:471`); writes via existing `setSecret` (`settings.tsx:519-527`); presence from names-only `GET /api/secrets`. No value route — grep-proven: `secrets/api.ts:11-13,191-195` (names only; no `GET /api/secrets/:name`). |
| a-AC-5 | VERIFIED | `wire.ts` `HealthReasonsSchema` adds `portkey: z.enum(...).catch("off")` (`wire.ts:808-811`); the settings record already tolerates new keys via `z.record().catch`. Test: `settings-page.test.tsx:353` "with settings:{} … no throw". |
| a-AC-6 | VERIFIED | Key input `type="password"`, draft cleared on success, never pre-filled (`panels.tsx:723-731, 755-762`). Tests: `settings-page.test.tsx:344` (write-only), `:431` (value never in DOM), `:467` (rejected write masks value). |

### PRD-063b — inference routing

| AC | Status | Evidence |
|---|---|---|
| b-AC-1 | VERIFIED | `createPortkeyTransport` hand-rolled `fetch` (no SDK), targets `PORTKEY_CHAT_COMPLETIONS_URL` with `x-portkey-api-key` + `x-portkey-config` headers — `transport-portkey.ts:73-80, 197-269`. Named-constant URL/headers (one-line change if docs shift). Tests: `transport-portkey.test.ts:80,95`. |
| b-AC-2 | VERIFIED | `resolvePortkeyClient` builds the synthetic single-account config (`apiKeyRef=${PORTKEY_API_KEY}`) + Portkey transport, bypassing `applyProviderModelOverride` — `model-client-factory.ts:352-419`. Test: `model-client-factory-portkey.test.ts:102` asserts Portkey URL hit, resolved key in header, config id attached, provider key never read; `:131` asserts Anthropic URL never hit. |
| b-AC-3 | VERIFIED | Key flows only into `x-portkey-api-key`; thrown errors carry status only, never body/key (`transport-portkey.ts:238-246`); no `console`/logger in the module (grep: empty). Tests: `transport-portkey.test.ts:133,149`; `model-client-factory-portkey.test.ts:124-128` (key not in URL/body/serialized client). |
| b-AC-4 | VERIFIED | Fail-closed default: missing key → `PortkeyUnconfiguredError` → no-op client + `unconfigured` in BOTH fallback modes (`model-client-factory.ts:322-359`). Opt-in fallback: `PortkeyFallbackModelClient` retries provider on unreachable only (`:429-453`). Tests: `model-client-factory-portkey.test.ts:182,200,218,249` (all four branches). |
| b-AC-5 | VERIFIED | Portkey off/unset delegates straight to `buildProviderPathClient` (`model-client-factory.ts:314-316`); status `off`. Tests: `model-client-factory-portkey.test.ts:147` (off → Anthropic path, provider key unchanged), `:166` (absent selection byte-identical). |
| b-AC-6 | VERIFIED | Usage mapped from OpenAI-shaped `usage` (`prompt_tokens→inputTokens`, etc.) through the shared `UsageSink` — `transport-portkey.ts:144-163, 253-263`. Tests: `transport-portkey.test.ts:162` (representative shape), `:188` (no-usage → zero, no throw), `:197` (thrown call reports nothing). |
| b-AC-7 | VERIFIED | `reasons.portkey` enum `off\|ok\|unconfigured\|unreachable` in `health.ts:51-79, 129-133`; assembly derives off/ok/unconfigured at boot (no probe) and flips to `unreachable` via cached `recordPortkeyUnreachable` observer (`assemble.ts:1413-1448, 1872-1893, 2206-2229`). Dashboard chip in `dashboard.tsx:115`. Tests: `health.test.ts:153-188` (verbatim states, secret-free). |

### PRD-063 — index ACs

| AC | Status | Evidence |
|---|---|---|
| AC-1 | VERIFIED | Default-OFF no-op — covered by b-AC-5 (off-path byte-identical, provider key flows unchanged). |
| AC-2 | VERIFIED | Toggle + config + key in Settings — covered by a-AC-1/2/4; no value route grep-proven. |
| AC-3 | VERIFIED | Inference routes through Portkey when on — covered by b-AC-2 (URL + headers + config id, provider key not read). |
| AC-4 | VERIFIED | Fail-closed precedence + opt-in fallback — covered by b-AC-4 (missing key hard-errors both modes; unreachable+fallback → provider). |
| AC-5 | VERIFIED | Metering + health honest — covered by b-AC-6 (UsageSink populated) + b-AC-7 (`reasons.portkey`, ROI not zeroed). |
| AC-6 | BLOCKED | Reranking gated/honest — parked on OQ-4; see 063c below. Not FAILED: the honest default (no Portkey rerank path) is in force. |
| AC-7 | VERIFIED (quality half) | `tsc` exit 0; targeted suites green; no secret in page/response/log; key write-only + cleared; names-only surface preserved. Security half signed off by `security-worker-bee` (clean at Medium+). |

### PRD-063c — reranking (PARKED / BLOCKED on OQ-4)

| AC | Status | Evidence |
|---|---|---|
| c-AC-1 | BLOCKED | No provider-rerank hook exists to route Cohere through Portkey. `recall/config.ts:83` `DEFAULT_RERANKER="none"`; `:195` `RERANKER_STRATEGIES=["embedding-cosine","llm","none"]` — only LOCAL embedding-cosine is implemented; `llm` is a reserved unbuilt slot. Depends on OQ-4 ownership decision. |
| c-AC-2 | BLOCKED | Dependent on c-AC-1; the rerank-key resolution path does not yet exist. |
| c-AC-3 | BLOCKED | Inert-when-seam-unavailable cannot be asserted as a built path; the seam itself is absent. Honest "not yet routed" is the current state. |
| c-AC-4 | VERIFIED (by construction) | `git diff --stat src/daemon/runtime/recall/config.ts src/daemon/runtime/memories/recall.ts` → **empty (zero-diff)**. `portkey.enabled` does not touch the recall path, so rerank behavior is exactly as PRD-027/047 define it. |
| c-AC-5 | DEFERRED | Close-out sign-off deferred with 063c; not in scope for this ship. |

**063c ask (carry forward):** Resolve parent **OQ-4** — does the `cohere`/provider-reranker option land in
`recall/config.ts` via a PRD-027/047 deliverable, or does 063c own building the rerank-provider seam (a recall-engine
change owned by `retrieval-worker-bee`)? Also answer **c-OQ-2** (is Portkey's Cohere rerank a first-class `/rerank`
route vs provider passthrough — determines the transport payload). Until then 063c stays dark; this is the correct,
honest default and should NOT be force-built.

## Files changed (one-line summary)

**Daemon (063a/063b):**
- `src/daemon/runtime/vault/catalog.ts` — adds `portkey` provider (`openEnded:true`, no curated models).
- `src/daemon/runtime/vault/api.ts` — 3 known setting keys + typed validation; control-char header-injection guard on `portkey.config`.
- `src/daemon/runtime/inference/transport-portkey.ts` *(new, 270 LOC)* — hand-rolled OpenAI-compatible Portkey transport + usage surfacing + unreachable signal.
- `src/daemon/runtime/inference/model-client-factory.ts` — Portkey supersession path, fail-closed status, opt-in fallback client.
- `src/daemon/runtime/inference/transport-anthropic.ts` — extracts shared `usageReportingTransport`/`PostResult`/`safeJsonParse` helpers (Anthropic path unchanged; 10/10 tests still green).
- `src/daemon/runtime/assemble.ts` — reads Portkey selection + derives assembly-time health; threads selection + unreachable observer into both worker builds.
- `src/daemon/runtime/health.ts` — `reasons.portkey` enum, read verbatim (no probe).

**Dashboard (063a):**
- `src/dashboard/web/panels.tsx` — `PortkeyGatewaySection` + `SETTING_KEY`/`PROVIDER_KEY_NAME` extensions.
- `src/dashboard/web/pages/settings.tsx` — section wiring + D-2 "superseded by Portkey" hint.
- `src/dashboard/web/pages/dashboard.tsx` — Portkey health chip.
- `src/dashboard/web/wire.ts` — `HealthReasonsSchema.portkey` with `.catch("off")` degrade.

**Tests (new/updated):** `transport-portkey.test.ts`, `model-client-factory-portkey.test.ts`,
`settings-api.test.ts`, `settings-page.test.tsx`, `wire.test.ts`, `app.test.tsx`, `health.test.ts`.

**Docs:** `library/knowledge/private/security/portkey-privacy-tier.md` *(new)* — documents the conscious
privacy-tier bypass when Portkey is on (flagged for security review).

## Final verdict

- **063a + 063b: SHIP-READY.** All in-scope ACs VERIFIED with file:line + named-test evidence; `tsc` clean; targeted
  suites green. The only finding is one non-blocking Suggestion (S-1, a stale doc pointer).
- **063c: correctly BLOCKED** on OQ-4 — do not force-build. c-AC-4 holds by construction (recall path zero-diff).
  Carry forward the OQ-4 / c-OQ-2 ownership ask to `retrieval-worker-bee`.
- **Gate:** AC-7 quality half PASS; security half already signed off clean at Medium+. Clear to commit → PR → CI.
