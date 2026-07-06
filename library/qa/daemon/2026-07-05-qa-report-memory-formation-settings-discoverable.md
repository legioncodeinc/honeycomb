# QA Report: Memory-formation as a discoverable, settings-driven, provider-gated feature

**Plan document:** none formal — SOURCE PLAN supplied inline by invoker (4 required outcomes)
**Audit date:** 2026-07-05
**Base branch:** `main`
**Head:** `fix-lease-discovery-on-paginated-scan` (PR #248, UNCOMMITTED working-tree diff)
**Auditor:** quality-worker-bee
**Ordering:** `security-worker-bee` ran first (PASS, one Low readability note) — no ordering violation.

## Summary

**Verdict: SHIP.** All 4 required outcomes are implemented, correctly wired end-to-end (not just correct in the pure helpers), and faithfully mirror the shipped `embeddings.enabled` pattern. All four gates are green (tsc 0 errors, dup 0.43%, SQL audit clean, `tests/daemon/` 3189 passed / 0 failed). One Warning: the `providerConfigured` signal (`model !== noopModelClient`) is a false-positive on the non-Portkey provider path when a routable `agent.yaml` exists but its `${SECRET_REF}` key is absent — health then reports `provider: "configured"` and `'auto'` enables extraction, yet runtime model calls no-op. This matches the plan's stated signal definition, so it does not block ship, but it is worth a follow-up. Two minor nits below.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All 4 outcomes present and wired: vault-first `memory.enabled`, `'auto'` extraction default, `/health reasons.memory`, `POST /api/actions/memory`. |
| Correctness   | ✅ | Vault-first precedence, `'auto'` collapse, and toggle persistence all verified end-to-end against the code, not just in isolation. |
| Alignment     | ✅ | Mirrors `readBootEmbeddingsEnabled` / embeddings toggle exactly; same scope resolvers, same fail-soft posture, same key-single-sourcing in `vault/api.ts`. |
| Gaps          | ⚠️ | `providerConfigured` can be a false-positive (routable config, missing key) → honest-signal degradation on a narrow misconfig. One Warning. |
| Detrimental   | ✅ | `'none'`→`'auto'` default flip is non-regressive: every other extraction test passes an explicit provider; `reasons.memory` stays additive/omitted-when-unwired. |

## Outcome-by-outcome PASS/FAIL

| # | Required outcome | Verdict | Evidence |
|---|---|---|---|
| 1 | Vault-backed `memory.enabled`, resolved VAULT-FIRST at boot (vault wins; else env `HONEYCOMB_PIPELINE_ENABLED`; both absent → OFF) | **PASS** | `assemble.ts:2103-2105` reads the vault value and overrides `config.enabled`; `pipeline/config.ts:465-470` `resolveMemoryEnabledVaultFirst`; three cases proven end-to-end (below). |
| 2 | `extractionProvider` default `"auto"`; derives from "is a real provider configured"; `"none"` opts out; explicit value overrides | **PASS** | `config.ts:363` `EXTRACTION_PROVIDER_AUTO`, `:379` schema default, `:405-410` `isExtractionEnabled`, `:430-439` collapse; stage wired at `assemble.ts:2159`. |
| 3 | No-secret "provider configured" signal for the dashboard (`/health reasons.memory = { enabled, provider }`) | **PASS (with Warning)** | `health.ts:275-280`, `:308-315`; populated at `assemble.ts:2147-2152`. Signal is correct per plan definition; see W-1 for the false-positive edge. |
| 4 | `POST /api/actions/memory` toggle mirroring embeddings, persisting `memory.enabled` | **PASS** | `actions-api.ts:225-250`; persists under `MEMORY_ENABLED_KEY`, `appliesOnRestart: true`, mirrors embeddings guard/scope/validation exactly. |

### Outcome 1 — vault-first at BOOT, all three cases traced end-to-end

The concern was that the pure helper could be correct but unwired. It is wired:

- `assemble.ts:2103` calls `readVaultMemoryEnabled(vault, secretScopeFromQueryScope(scope))` — the SAME scope pattern as `readBootEmbeddingsEnabled` (`:2501`) and `readVaultPollinatingEnabled` (`:1916`).
- `:2104-2105` `const enabled = resolveMemoryEnabledVaultFirst(vaultMemory, config.enabled); if (enabled !== config.enabled) config = { ...config, enabled };` — `config.enabled` is genuinely overridden.
- `buildPipelineWorker` is invoked with the real `vault` reader at `:3148`.

End-to-end cases (`resolveMemoryEnabledVaultFirst`, `config.ts:469`):
- **vault=true, env unset** → `decidedByVault:true` → returns `true` → memory ON without env editing. ✅
- **vault=false, env true** → `decidedByVault:true` → returns `false` (vault `false` wins over env). ✅ Note `readVaultMemoryEnabled` returns the structured `{decidedByVault, enabled}` so a present `false` is honored — a genuine improvement over the embeddings read shape.
- **vault absent, env true/false** → `decidedByVault:false` → returns `envEnabled`. ✅

Fail-soft verified: `readVaultMemoryEnabled` (`assemble.ts:41-53`) returns `{decidedByVault:false}` on `undefined` vault, `!res.ok`, or a thrown read → env/default stands, never a throw.

### Outcome 2 — `'auto'` collapse is total; the stage never sees raw `'auto'`

- The default is `'auto'` (`config.ts:379`), confirmed by the updated unit test (`config.test.ts:36`).
- `isExtractionEnabled(config, providerConfigured=false)` (`config.ts:405-410`): `enabled` false → false; `'none'` → false; `'auto'` → returns `providerConfigured`; any other explicit value → true. All four paths covered by `config.test.ts:89-113`.
- `resolveEffectiveExtractionProvider` (`config.ts:430-439`) collapses `'auto'` → `'auto-resolved'` (provider configured) or `'none'` (not) and leaves `'none'`/overrides UNCHANGED.
- **Stage never receives raw `'auto'`:** `assemble.ts:2159` runs `config = resolveEffectiveExtractionProvider(config, providerConfigured)` UNCONDITIONALLY before `createPipelineHandlers` (`:2187`) hands `config` to the extraction stage. The stage's single-arg `isExtractionEnabled(config)` at `extraction.ts:272` therefore reads a concrete token. Verified the only production caller of the gate is that line.

Full matrix (`auto`+provider → enabled/`auto-resolved`; `auto`+no-provider → off/`none`; `none` → off/unchanged; override → enabled/unchanged) is asserted in `config.test.ts:115-153`.

### Outcome 3 — health cell correctness

`health.ts:308-315` maps `providerConfigured` boolean → `"configured"|"unconfigured"` enum, additive (spread only when `inputs.memory !== undefined`). `enabled` reflects the vault-first value because `onMemoryFeature` (`assemble.ts:2152`) publishes `config.enabled` AFTER the `:2105` override. No secret leaks — two enums only. See W-1 for the `providerConfigured` truthiness caveat.

### Outcome 4 — toggle honesty

`actions-api.ts:225-250`: guard → `readEnabled` validation → best-effort persist under `MEMORY_ENABLED_KEY` → emit `onMemoryToggle` → `{ ok, enabled, persisted, appliesOnRestart: true }`. Nothing implies a live effect: unlike the embeddings toggle (`:252 embed.setEnabled`), there is deliberately NO live actuation — the worker snapshots its gate at boot, and the response honestly says `appliesOnRestart: true`. The persisted key (`MEMORY_ENABLED_KEY`) is exactly what the boot read (`readVaultMemoryEnabled`) reads back. Scope symmetry (write via `settingsScope`, read via `secretScopeFromQueryScope`) is identical to the already-shipped embeddings toggle, so no new persistence-round-trip risk is introduced.

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **`providerConfigured` false-positive on the non-Portkey provider path (routable config, missing key)**, `src/daemon/runtime/inference/model-client-factory.ts:263-287` + `src/daemon/runtime/assemble.ts:2147`

  `providerConfigured = model !== noopModelClient`. On the provider path, `buildProviderPathClient` returns a real `RouterModelClient` whenever `isRoutable(config)` is true — and `isRoutable` (`model-client-factory.ts:208-210`) checks ONLY `accounts.length > 0 && workloads.length > 0`, NOT credential presence. The `${SECRET_REF}` key is resolved lazily inside the provider call (`:245-247`), not at build time. So a routable `agent.yaml` with an absent/invalid key yields `providerConfigured: true` → `/health` shows `provider: "configured"` and, under the `'auto'` default, extraction is enabled (`auto-resolved`), yet the runtime model call cannot reach a provider and extraction silently no-ops — the exact "jobs complete, nothing hits the LLM" signature this PRD set out to make visible. The Portkey path is stricter (a missing key → `noopModelClient` + `"unconfigured"`, `:326-333`), so the gap is provider-path-only. This MATCHES the plan's definition of the signal ("the assembled ModelClient is non-noop"), so it does not block ship — but the dashboard may show a green "configured" that cannot actually extract. Recommended remediation: either tighten the signal to also confirm the `apiKeyRef` secret resolves at boot, or document that `provider: "configured"` means "routing configured" not "credential present".

  ```ts
  // model-client-factory.ts:208
  function isRoutable(config: InferenceConfig): boolean {
      return config.accounts.length > 0 && config.workloads.length > 0; // no key check
  }
  // assemble.ts:2147
  const providerConfigured = model !== noopModelClient; // true even if key is absent
  ```

## Suggestions (consider improving)

- [ ] **`onMemoryFeature` publishes a boot snapshot but the comment calls the health read "LIVE"**, `src/daemon/runtime/assemble.ts:2149-2152, 2571-2574`

  The `/health` handler reads the `memoryFeature` cell live per call, but the cell is populated once at boot and never updated (consistent with `appliesOnRestart`). The wording is fine, but a one-line note that `enabled`/`provider` only change on restart would prevent a future reader from expecting the toggle to move the health value without a restart.

- [ ] **`EXTRACTION_PROVIDER_AUTO_RESOLVED` is declared after its first use in `resolveEffectiveExtractionProvider`**, `src/daemon/runtime/pipeline/config.ts:437, 447`

  The const is referenced at `:437` and declared at `:447`. Hoisting is fine at runtime and tsc is green, but moving the declaration above the function (next to `EXTRACTION_PROVIDER_AUTO`/`_NONE`) would read more naturally and group the three sentinels together.

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| O1 | Vault-backed `memory.enabled`, resolved vault-first at boot | ✅ | `assemble.ts:41-53, 2103-2105`; `config.ts:465-470`; `vault/api.ts:510, 517` | 3 cases traced end-to-end; fail-soft. |
| O1a | Vault value present → wins (true enables w/o env) | ✅ | `config.ts:469`; test `config.test.ts:81-83` | |
| O1b | Vault `false` → disables even if env true | ✅ | `config.ts:469`; test `config.test.ts:85-87` | Structured `{decidedByVault}` return honors present `false`. |
| O1c | Vault absent → env fallback | ✅ | `config.ts:469`; test `config.test.ts:89-92` | |
| O2 | `extractionProvider` default `'auto'`, provider-derived | ✅ | `config.ts:363, 379, 405-410` | |
| O2a | `'none'` still opts out | ✅ | `config.ts:407`; test `config.test.ts:96` | |
| O2b | Explicit provider value overrides | ✅ | `config.ts:409`; test `config.test.ts:93` | |
| O2c | Stage never sees raw `'auto'` (collapse total) | ✅ | `assemble.ts:2159`; `extraction.ts:272`; tests `config.test.ts:115-153` | Collapse runs unconditionally pre-stage. |
| O3 | No-secret `/health reasons.memory = { enabled, provider }` | ✅ | `health.ts:275-280, 308-315`; `assemble.ts:2147-2152, 2571-2574` | Additive; two enums, no secret. |
| O3a | `providerConfigured` = "real provider" signal | ⚠️ | `assemble.ts:2147`; `model-client-factory.ts:208, 263-287` | Matches plan; false-positive on routable-but-keyless provider path (W-1). |
| O4 | `POST /api/actions/memory` toggle persists `memory.enabled` | ✅ | `actions-api.ts:225-250` | |
| O4a | Mirrors embeddings toggle auth/scope/validation | ✅ | `actions-api.ts:225-250` vs `:232-254`; tests `actions-api.test.ts:538-583` | |
| O4b | `appliesOnRestart: true` honest (no false live claim) | ✅ | `actions-api.ts:249`; no `setEnabled` call | Deferred-reconcile is honest. |
| NG | No live in-place reconcile implied | ✅ | `actions-api.ts:220-224` doc; `onMemoryToggle` event-only | Honored. |

## Files Changed

- `src/daemon/runtime/assemble.ts` (M) — `readVaultMemoryEnabled`; `buildPipelineWorker` resolves `enabled` vault-first, computes `providerConfigured`, collapses `'auto'`, publishes `/health` memory cell; `onMemoryToggle` wired.
- `src/daemon/runtime/dashboard/actions-api.ts` (M) — `POST /api/actions/memory` toggle (persist + event + `appliesOnRestart`), `onMemoryToggle` option.
- `src/daemon/runtime/health.ts` (M) — `HealthReasons.memory` + `HealthDetailInputs.memory`; additive mapping to `{ enabled, provider }`.
- `src/daemon/runtime/pipeline/config.ts` (M) — `EXTRACTION_PROVIDER_AUTO` (new default) + `_AUTO_RESOLVED`; `isExtractionEnabled(config, providerConfigured)`; `resolveEffectiveExtractionProvider`; `resolveMemoryEnabledVaultFirst`.
- `src/daemon/runtime/pipeline/index.ts` (M) — re-export the new symbols.
- `src/daemon/runtime/vault/api.ts` (M) — `MEMORY_ENABLED_KEY` + add to `KNOWN_SETTING_KEYS`.
- `tests/daemon/runtime/dashboard/actions-api.test.ts` (M) — 4 tests for the memory toggle.
- `tests/daemon/runtime/health.test.ts` (M) — memory feature-gating: omitted-when-unwired + enum surfacing.
- `tests/daemon/runtime/pipeline/config.test.ts` (M) — `'auto'` default, `isExtractionEnabled` matrix, vault-first precedence, collapse.

## Gate results (real numbers)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **PASS** — exit 0, 0 errors |
| Duplication | `npm run dup` | **PASS** — exit 0; 0.43% dup (threshold 7); 34 pre-existing clones, none in changed files |
| SQL safety | `npm run audit:sql` | **PASS** — exit 0; 302 files scanned, every interpolation escaped |
| Daemon tests | `npx vitest run tests/daemon/` | **PASS** — exit 0; 295 files, **3189 passed / 8 skipped / 0 failed** |

Known-flaky `tests/hooks/runtime/hook-runtime.test.ts` is outside `tests/daemon/` and was not run per the invoker's instruction.
