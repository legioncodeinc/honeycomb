# EXECUTION LEDGER — PRD-025 Semantic recall on by default (M)

> Orchestrator: `/the-smoker` · Branch: `prd-025-semantic-recall-default` · Status: **IN-WORK**
> Goal: a fresh `honeycomb login` user gets hybrid lexical + 768-dim **semantic** recall out of the box —
> store path populates the vector, recall reaches the `<#>` cosine path, lexical is the *graceful* fallback.

## The built seams this PRD wires ON (D-5: reuse, don't fork)
- `src/daemon/runtime/services/embed-client.ts` — `noopEmbedClient` (today's default), the real `DaemonEmbedClient` + `createEmbedAttachment`, `resolveEmbedClientOptions`, `assertEmbeddingDim`.
- `src/daemon/storage/vector.ts` — `vectorSearch` / `buildVectorSearchSql`, `EMBEDDING_DIMS = 768` ↔ schema `FLOAT4[]`.
- `src/daemon/runtime/memories/{recall.ts (hard-coded `degraded:true` @255),store.ts,api.ts}` + the capture `EmbedAttachment` + `controlled-writes.ts`.
- `embeddings/embed-daemon.js` (the shipped embed daemon), `HONEYCOMB_EMBEDDINGS` / `HONEYCOMB_EMBED_URL` / `HONEYCOMB_EMBED_TIMEOUT_MS`.

## AC matrix (7) — OPEN → DONE → VERIFIED
| AC | Criterion (abbrev) | Wave | Owner | Status |
|----|--------------------|------|-------|--------|
| AC-1 | Default-ON for a fresh user (`resolveEmbedClientOptions` unset→enabled, opt-OUT); `login` provisions/owns the embed daemon | 1+2 | ts-node + embeddings | **DONE (unit)** — Wave-1 inversion unit-proven; **Wave-2 second half DONE**: the daemon OWNS + supervises the embed daemon as a `DaemonService` (spawn/health-check/crash-restart), zero-config first-run model acquisition wired (mirrors `ensure-tree-sitter`), opt-out + offline pre-stage; unit-proven w/ a fake child. **Live spawn on this host = Wave 3.** |
| AC-2 | Stored + captured rows carry a real non-NULL 768-dim vector (default seam = real `createEmbedAttachment`); proven live by poll-convergent read-back | 1 | ts-node | **DONE (unit + itest authored)** — store + capture seams default to the real embedder; live read-back proof authored (skips w/o embed daemon), **runs Wave 3** |
| AC-3 | Recall runs the `<#>` cosine arm when available + sets `degraded` HONESTLY (line-255 hard-code gone); unit-tested both branches | 1 | ts-node | **DONE** — unconditional `degraded:true` deleted; both branches unit-proven |
| AC-4 | **Behavioral bar (GATED LIVE ITEST):** capture a turn → query with NO shared surface tokens → semantic surfaces it, lexical-only does not | 3 | ts-node + orch | **ITEST AUTHORED** — `semantic-recall-live.itest.ts` AC-4 case written + skips cleanly; **live-runs Wave 3** |
| AC-5 | Graceful non-hanging degrade: embed daemon killed → recall 200 `degraded:true` within timeout; restart → `degraded:false` (gated live toggle) | 2+3 | embeddings + orch | **Wave-2 plumbing DONE** — recall-side honest-degrade landed Wave 1; the supervisor now exposes `stop()`/`restart()` (kill mid-session → recall degrades; `restart()` brings semantic back + resets the bounded count), unit-proven w/ a fake child. **Live kill→degrade→restart toggle = Wave 3.** |
| AC-6 | Dim invariant: 768 ↔ `FLOAT4[]` ↔ model output; non-768/malformed → NULL (lexically recallable), never a silent bad write; unit + live | 1 | ts-node | **DONE (unit) + itest authored** — embed-client + controlled-writes dim-reject unit-covered (pre-existing) + recall-side defense-in-depth unit-added; live case authored, **runs Wave 3** |
| AC-7 | Gates green (ci/build/audit:sql/audit:openclaw/invariant); no secret in embed IPC/model-download logs/recall; npm artifact does NOT balloon 600 MB (`files`+`pack:check`) | 2+3 | security + orch | **Wave-2 lean-artifact DONE** — `pack:check` green (48 files, **0** transformers/onnx/model/.bin packed, 5.77 MB unpacked, no 600 MB balloon); the ~600 MB stack ships as `optionalDependencies` + first-run acquisition, NOT in `files`; grep-proven no secret in the embed IPC / supervisor / model-download paths. Full secret/PII close-out = **Wave 3 security-worker-bee**. |

## Wave 1 (daemon-side) — DONE

**Files changed (+why):**
- `src/daemon/runtime/services/embed-client.ts` — **D-1 default-on inversion.** `resolveEmbedClientOptions` now opt-OUT: unset / `true` / `1` → `enabled:true`; an EXPLICIT `false` / `0` (whitespace+case tolerated) → `enabled:false`; any other value → default (enabled). URL/timeout/dim knobs untouched; the null-on-failure `DaemonEmbedClient` contract unchanged. (AC-1 unit)
- `src/daemon/runtime/assemble.ts` — **AC-2 store/capture seam → real embedder.** `assembleDaemon` builds the real `EmbedAttachment` ONCE via `createEmbedAttachment({ storage })` (injectable via new `options.embed` for hermetic tests) and threads it through `assembleSeams` into BOTH `attachHooks` (capture, the full `EmbedAttachment`) and `mountMemories` (store, its `.client`). A captured turn + a stored memory now land a real 768-dim vector when embeddings are available; null → NULL vector (lexical), never a throw.
- `src/daemon/runtime/memories/recall.ts` — **AC-3 cosine arm + honest `degraded`.** Added the `<#>` semantic arms (memories.`content_embedding` + sessions.`message_embedding`) via the EXISTING `vectorSearch` (D-5 — no forked vector SQL), a guarded hydrate-by-id SELECT, and `runSemanticArms` (embed query → arms; returns `null` when it could not run). `recallMemories` now: runs semantic + lexical concurrently, merges semantic-first + lexical (deduped by `source+id` in `shapeHits`), and sets `degraded = (semanticHits === null)`. **The unconditional `return { …, degraded: true }` is DELETED.** Recall never throws/hangs on the embed path. Arm-COMBINATION only (ranking is PRD-027).
- `src/daemon/runtime/memories/api.ts` — threads `options.embed` (the store `EmbedClient`) into the `/api/memories/recall` `recallMemories` call so the route reaches the cosine path.
- `tests/daemon/runtime/services/embed-client.test.ts` — flipped the `resolveEmbedClientOptions` assertions: **unset → enabled** (AC-1); added explicit `false`/`0`/` FALSE `/`maybe` cases. (The disabled-client behavior test uses an explicit `{enabled:false}` option, unchanged.)
- `tests/daemon/runtime/memories/recall.test.ts` — **+8 AC-3/AC-6 tests:** semantic-ran→`degraded:false` (memories + sessions lexical-miss), fallback→`degraded:true` (embed null / no client / embed throws), AC-6 wrong-dim→no semantic arm→`degraded:true`, semantic-ran-but-missed→`degraded:false`, and the semantic+lexical dedup. Injected fake `EmbedClient` (success / null / throw) drives BOTH branches.
- `tests/integration/semantic-recall-live.itest.ts` — **NEW gated live itest** (AC-2 vector-populated poll-convergent read-back, AC-4 semantic-beats-lexical-miss, AC-6 malformed→NULL+lexical). Mirrors `memories-api-live.itest.ts` (boot harness, per-run unique term/session, `workspace=honeycomb_ci`, poll-to-convergence). **Skips cleanly** (`describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` + an embed-daemon reachability probe in `beforeAll` → `embedReady` guard) when the token OR the embed daemon is absent. `git check-ignore` = not-ignored (committable).

**AC-6 dim-reject coverage (already present + extended):** the embed-client (`512`/`769` → null, `embed.dim_rejected`) and controlled-writes (`c-AC-6 wrong-dim embed → content_embedding NULL, row lands`) unit tests already prove reject-to-NULL at the write boundary; this wave adds the recall-side defense-in-depth (a wrong-dim query vector is never sent to the `<#>` arm).

**Wave-1 gate exit codes (all green):**
- `npm run ci` (typecheck + dup/jscpd + test + audit:sql) → **0**
- `npm run build` → **0**
- `npm run audit:sql` → **0**
- `npm run audit:openclaw` → **0**
- `tests/daemon/storage/invariant.test.ts` → **0**
- (Note: a single pre-existing flaky test `tests/daemon/runtime/secrets/exec.test.ts` "b-AC-5 timeout/partial-output" failed ONCE under full-suite parallel load and PASSED in isolation + on the clean ci re-run — a runaway-process-kill timing race, NOT a PRD-025 regression. Untouched by this wave.)

**Handoff — what stays Wave 2 vs Wave 3:**
- **Wave 2 (embeddings-runtime):** the embed-daemon process lifecycle — `honeycomb login`/daemon-start provisioning + ownership/supervision of the embed daemon (AC-1 second half), warmup off the turn path, crash-restart, and the first-run model acquisition + lean-artifact install (AC-7 600 MB / `pack:check`). Wave 1 left the embed seam ON by default and reachable-or-degrade; Wave 2 makes the daemon actually run.
- **Wave 3 (live verify + close-out):** run `semantic-recall-live.itest.ts` against live DeepLake + a running embed daemon (AC-2/AC-4/AC-6 live), the AC-5 kill→degrade→restart live toggle, and the security/quality/pack close-out (AC-7).

## Wave 2 (embed-daemon lifecycle + zero-config install) — DONE

**The supervisor design (D-6 — the daemon OWNS the embed process):**
- `src/daemon/runtime/services/embed-supervisor.ts` — **NEW `DaemonService`** (`createEmbedSupervisor`). Wired into `assembleDaemon`'s `services.embed` and the daemon lifecycle exactly like the queue + watcher: `startServices()` calls `embed.start()` LAST, `stopServices()` calls `embed.stop()` FIRST (so a clean daemon shutdown drains the embed child — no orphan). It:
  - **spawns** the bundled `embeddings/embed-daemon.js` as a single supervised child (`stdio:"ignore"`, `windowsHide:true` — Windows dev host), tracked for crash;
  - **health-checks** it by polling loopback `GET <HONEYCOMB_EMBED_URL>/health` until the listener answers (bounded `liveTimeoutMs`);
  - **warms OFF the turn path (D-3):** after liveness it kicks a BACKGROUND warm-wait (`/health.ready`) that is NEVER awaited on the daemon-start path — so daemon readiness (and the first user recall) is never blocked on a cold model; until warm, recall is lexical + `degraded:true` (Wave-1 contract);
  - **crash-restarts (D-6):** a child exit → `handleCrash` respawns with backoff up to a BOUNDED `maxRestarts`, then gives up and leaves recall lexical (a crash loop never wedges the daemon, never blocks a turn — D-4);
  - **opt-out (D-1):** reads the SAME `HONEYCOMB_EMBEDDINGS` the embed client does — an explicit `false`/`0` makes it INERT (no child spawned); unset/on spawns with zero config;
  - **AC-5 plumbing:** exposes `stop()` (kill mid-session → recall degrades) + `restart()` (deliberate kill→respawn, resets the bounded count → semantic back). Hermetic by injection (`spawnChild` / `probeHealth` / `clock`).
- `embeddings/src/index.ts` — **the stub became a REAL embed daemon.** Loopback HTTP IPC: `GET /health` (`{ ok, ready, model, revision, dims, version }` — no secret), `POST /embed { text } → { vector:number[768] }` (200 warm; **503** before warm so the client leaves the column NULL; **dim-rejected** non-768 → error, never written — AC-6). The heavy `@huggingface/transformers` stack is loaded **LAZILY** via a runtime `import()` (routed through `new Function` so tsc/esbuild never resolve the optional dep) inside `warmup()` — so CI + the bundle never need it. Warm runs a throwaway embed so the first real call is fast (D-3).
- `src/daemon/runtime/server.ts` + `assemble.ts` — `DaemonServices.embed` added (default `noopEmbedSupervisor`); `assembleDaemon` constructs the real supervisor (injectable via `options.embedSupervisor` for hermetic tests) + threads it into start/stop.

**The pinned model revision (D-2 open sub-decision — RESOLVED):** `nomic-ai/nomic-embed-text-v1.5` @ revision **`v1.5`**, quantization **`q8`**, **768** dim (the `FLOAT4[]` schema lock — AC-6). transformers.js downloads + **caches** the model under `~/.honeycomb/embed-models/` (`HONEYCOMB_EMBED_CACHE_DIR` override = the offline/air-gapped pre-stage) on first warmup, reused across upgrades. The nomic `search_document:` document prefix is applied transparently.

**First-run install (D-2 / D-3 — mirrors `ensure-tree-sitter`):**
- The ~600 MB inference stack ships as **`optionalDependencies` `@huggingface/transformers ^3.0.0`** — NOT in the `files` allowlist (lean tarball, AC-7).
- `scripts/ensure-embed-deps.mjs` — NEW non-fatal `postinstall` heal (chained after `ensure-tree-sitter`): resolve-only checks whether the optional stack is present, prints ONE clear line, and ALWAYS exits 0 (a slimmed/offline/`--no-optional` install never hard-breaks; embeddings stay OFF and recall is lexical — no quality cliff, D-4). Respects the `HONEYCOMB_EMBEDDINGS` opt-out.
- The model itself is acquired **lazily on first daemon warmup**, background-warm — it does NOT block `honeycomb login` or the first recall (D-3). Added to the `files` allowlist: `scripts/ensure-embed-deps.mjs` only.

**The lean-artifact proof (D-2 / AC-7):** `npm run pack:check` → **green** (48 files, all required runtime files present, no forbidden patterns). `npm pack --dry-run` → **0** files matching `transformers|onnx|.onnx|model|.bin|embed-models`; unpacked size **5.77 MB** (no 600 MB balloon); `embeddings/embed-daemon.js` + `ensure-embed-deps.mjs` present. The Wave-1 `pack:check` required-files guard still passes.

**Tests (hermetic — NO real 600 MB download in CI):**
- `tests/daemon/runtime/services/embed-supervisor.test.ts` — supervisor lifecycle vs a FAKE child + scripted `/health`: spawns + live on start; warmup OFF the start path (start resolves before warm); bounded crash-restart (respawn → respawn → give up); `stop()` kills + not-live; `restart()` respawns + resets the bound (AC-5 toggle); opt-out → never spawns; never-live child → start resolves (degrades, not hangs — D-4).
- `tests/embeddings/embed-daemon.test.ts` — pinned model/revision/q8/768 + cache-dir resolution; `embed()` 768 on a fake extractor, wrong-dim rejected (AC-6); `/health` ready false→true + no secret; `/embed` 503 cold (no input echoed) / 200 warm / 400 malformed. Real model never loaded (fake extractor via `__setExtractorForTest`).
- `tests/daemon/runtime/assemble.test.ts` — **extended**: the embed supervisor is the daemon's `embed` service (D-6 ownership), `startServices`/`stopServices` start/stop it (lifecycle-owned), the real supervisor is inert under `HONEYCOMB_EMBEDDINGS=false`. Existing `.start()`-calling tests inject `noopEmbedSupervisor` to stay hermetic (assertions unchanged).

**Wave-2 gate exit codes (all green):**
- `npm run ci` (typecheck + dup/jscpd + test + audit:sql) → **0** (1826 passed, 5 skipped; jscpd 0.48% — no embed clones)
- `npm run build` → **0** (embed-daemon bundle real, 186 lines; transformers external)
- `npm run audit:sql` → **0**
- `npm run audit:openclaw` → **0**
- `npm run pack:check` → **0** (48 files, lean, no model blob)
- `tests/daemon/storage/invariant.test.ts` → **0** (embeddings stays DeepLake-free)
- AC-7 secret scan of the new embed IPC / supervisor / model-download paths → **no leak** (grep-proven); all 5 new files `git check-ignore` = committable.

**What the orchestrator must run LIVE in Wave 3 (this Windows host):**
```bash
# 1. Acquire the embedding runtime (the ~600 MB optional stack — one time on this host).
npm i @huggingface/transformers      # or: npm i --include=optional

# 2. Build so the real embed-daemon bundle + daemon bundle are fresh.
npm run build

# 3. Start the embed daemon standalone to warm + cache the model (first run downloads ~600 MB
#    under ~/.honeycomb/embed-models/; then GET /health should report ready:true).
node embeddings/embed-daemon.js &
#    poll:  curl http://127.0.0.1:3851/health      → expect { ok:true, ready:true, dims:768 }

# 4. Live-verify against live DeepLake (export the token + org/workspace as the other itests do):
#    HONEYCOMB_DEEPLAKE_TOKEN=... HONEYCOMB_DEEPLAKE_ORG=... HONEYCOMB_DEEPLAKE_WORKSPACE=...
npx vitest run --config vitest.integration.config.ts tests/integration/semantic-recall-live.itest.ts
#    → AC-2 (vector populated, poll-convergent read-back), AC-4 (semantic beats lexical-miss), AC-6 (malformed→NULL+lexical)

# 5. AC-5 live kill→degrade→restart toggle (the supervisor builds it; the orchestrator runs it live):
#    with the daemon up + embed warm, kill the embed child (or call the supervisor restart),
#    issue a recall within the timeout → expect degraded:true; restart the embed daemon →
#    a subsequent recall → degraded:false. (Park as BLOCKED with the specific ask if the
#    model genuinely cannot run on this Windows host — never silently skip.)
```

## Wave plan
- **Wave 1 — Daemon-side semantic wiring (typescript-node-worker-bee).** Invert `resolveEmbedClientOptions` → default-on opt-OUT (D-1); swap the store + capture `embed` seam from `noopEmbedClient` → real `createEmbedAttachment` at daemon construction (`mountMemoriesApi`/`assembleDaemon`/capture) (AC-2); wire `/api/memories/recall` to run the `vectorSearch` `<#>` arm when embeddings available + set `degraded` honestly, deleting the hard-coded `degraded:true` @ recall.ts:255 (AC-3); dim-reject-to-NULL (AC-6); unit tests on BOTH branches; author the gated live itest (AC-2/AC-4/AC-5/AC-6 live) — skipped cleanly when the embed daemon is absent (mirror the DeepLake gated-itest pattern). **NOTE: ranking/fusion of the arms is PRD-027 — this wave's bar is the semantic arm RUNS and is reflected in `degraded`.**
- **Wave 2 — Embed-daemon lifecycle + zero-config install (embeddings-runtime-worker-bee).** Daemon owns/supervises the embed daemon (D-6): warmup OFF the turn path, crash-restart, harden the Unix-socket/NDJSON IPC; wire first-run model acquisition into `honeycomb login`/daemon start (background-warm, D-3) mirroring `ensure-tree-sitter`; keep the npm artifact lean (D-2 — model acquired, NOT packed; `pack:check` + `files` stay green, AC-7). Depends on Wave-1's embed seam.
- **Wave 3 — Live verification + close-out (security → quality → orchestrator).** Install embeddings on this host, start the embed daemon, run the gated live itests against live DeepLake: AC-2 (vector populated), AC-4 (semantic-beats-lexical), AC-5 (kill→degrade→restart), AC-6 (dim). security-worker-bee (no secret in IPC/logs, AC-7) → quality-worker-bee (impl vs PRD). If the embed MODEL genuinely cannot run on this Windows host, park AC-4/AC-5 *live-proof* as **BLOCKED** with the specific ask (per smoker non-negotiable) — ship the wiring + unit + scaffold; never silently skip.

## Wave-3 live-fixes
- **embed daemon: port `NaN` on unset env → defensive parse + regression test.** Live-verification (standalone `node embeddings/embed-daemon.js` with `HONEYCOMB_EMBED_PORT` UNSET) crashed immediately: `failed to start: options.port should be >= 0 and < 65536. Received type number (NaN)`. Root cause `embeddings/src/index.ts:230` — `options.port ?? Number(env.HONEYCOMB_EMBED_PORT) ?? EMBED_PORT`: `Number(undefined)` is `NaN`, and `??` only coalesces `null`/`undefined` (NOT `NaN`), so an unset env yielded `port = NaN` → `server.listen(NaN)` threw. Wave-2's supervisor unit tests used a fake child and never exercised the real `startEmbedDaemon` bind, so it slipped through. **Fix:** extracted a pure exported `resolveEmbedPort(override, rawEnvPort)` helper (precedence: explicit `options.port` → a VALID in-range env port → `EMBED_PORT` 3851; unset/garbage/empty/out-of-range all fall back, never `NaN`) and rewired `startEmbedDaemon`. The host read (line 229, `??` on a string) was already safe; no other `Number(env...)` reads in the file. **Regression test:** extended `tests/embeddings/embed-daemon.test.ts` with a "bind port resolves to a finite default, never NaN" suite that drives the REAL resolver (unset→3851, valid honored, garbage/`""`/`"99999"`→fallback, `options.port` overrides both) plus a real-bind assertion that unset env actually listens on a finite ephemeral port instead of throwing. Gates green: `npm run ci`=0, `build`=0, `audit:sql`=0, `audit:openclaw`=0, `invariant.test.ts`=0.
- **embed daemon: invalid model revision `"v1.5"` → 404 at warmup; pinned to an immutable commit SHA.** Live warmup of `nomic-ai/nomic-embed-text-v1.5` failed: `Could not locate file: ".../resolve/v1.5/tokenizer.json"` (404). Root cause `embeddings/src/index.ts:52` — `MODEL_REVISION` was set to the model NAME `"v1.5"`, which is NOT a git ref on the HF repo (the weights live on `main`), so transformers.js resolved `resolve/v1.5/...` → 404. Proven on this host that `revision: "main"` loads + embeds a 768-dim vector, so the runtime is sound — only the pin was wrong. **Fix:** set `MODEL_REVISION` to the immutable commit SHA `e9b6763023c676ca8431644204f50c2b100d9aab` (the `main` HEAD of the repo, verified to carry `tokenizer.json`, `config.json`, and `onnx/model_quantized.onnx` — the q8 weights `dtype:"q8"` resolves). A pinned SHA satisfies D-2 reproducibility better than the moving `main`. The warmup call API was confirmed already-correct against the run that worked: `pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5", { revision, dtype:"q8" })` then `extractor("search_document: …", { pooling:"mean", normalize:true })` — only the revision value changed. **Regression test:** the old `expect(MODEL_REVISION).toBe("v1.5")` assertion is replaced with one that asserts the revision is a VALID ref — `main` OR a 40-hex commit SHA, and explicitly NOT `"v1.5"`/the model id — so a re-introduction of the model-name-as-revision bug fails the unit gate without downloading the model.
- **embed daemon: warmup failure was swallowed → now logged + surfaced on `/health` (observable degradation).** When warmup failed the daemon set `warmFailed:true` on `/health` but logged NOTHING and exposed no reason, so the 404 had to be rediscovered by reproducing the model load by hand. **Fix (`embeddings/src/index.ts`):** the background warmup `.catch` in `startEmbedDaemon` now (1) writes a one-line `[honeycomb-embed] warmup failed: <reason>` to the daemon's stderr, and (2) exposes a short `warmError` reason string on `/health` (alongside the existing `warmFailed:true` + `ready:false`). Both run through a new `redactWarmError()` helper that keeps the diagnostic (model URL + transformers.js error text) but strips any `hf_…` token / `Authorization: Bearer …` / `token=`/`api_key=` value, collapses whitespace, and truncates to `WARM_ERROR_MAX=300` — so neither the log nor the `/health` field can carry a secret (AC-7). `warmup()` itself stays a pure load step that throws; the daemon owns surfacing. **Tests:** a test-only `__setTransformersLoaderForTest` seam drives a deterministic warmup rejection (the real 404 message) WITHOUT downloading the 600 MB model or depending on whether the optional dep is installed; asserts `warmup()` throws, `startEmbedDaemon` logs the redacted one-liner to stderr AND `/health` reports `warmFailed:true`+`ready:false`+a non-empty redacted `warmError` with the model URL present and the spliced `hf_…` token absent on BOTH surfaces, plus a direct `redactWarmError` unit (strips tokens, single-lines, truncates, keeps the URL). Grep-proven: no secret literal in `embeddings/src/index.ts` or the built `embeddings/embed-daemon.js`.
- **Gates (both fixes):** `npm run ci`=0 (1835 passed / 5 skipped, incl. the 17-test embed-daemon suite + `audit:sql` inline), `npm run build`=0 (rebuilds `embeddings/embed-daemon.js` carrying the SHA + `warmError` + log line), `npm run audit:sql`=0, `npm run audit:openclaw`=0, `tests/daemon/storage/invariant.test.ts`=0.

## Blockers
- (none yet)

## Wave 3 — LIVE VERIFICATION (orchestrator) ✅

Embed model RUNS on this Windows host (`@huggingface/transformers` loads; `nomic-embed-text-v1.5` q8 768-dim warms in ~5 s, cached). Two Wave-3 live-fixes en route (both bee-fixed + regression-tested): the embed daemon port NaN-on-unset-env, and the invalid pinned revision `v1.5`→ commit SHA + warmup-error now logged/surfaced.

- **AC-2 ✅ VERIFIED LIVE** — gated `semantic-recall-live.itest.ts` passed: a stored memory landed a non-NULL 768-dim `content_embedding` (poll-convergent read-back).
- **AC-4 ✅ VERIFIED LIVE (the behavioral bar)** — gated itest passed: capture "the build is timing out on the pack step", recall "CI keeps failing during publish" (a pure BM25/ILIKE MISS) → the **semantic `<#>` path surfaced the captured memory; the lexical-only arm did not.** Semantic recall is real, on, and adding recall the lexical path can't.
- **AC-6 ✅ VERIFIED LIVE** — gated itest passed: a malformed-dim write landed `content_embedding` NULL + stayed lexically recallable.
- **AC-5 ✅ VERIFIED LIVE** — assembled-daemon toggle: embed UP → recall `degraded:false` (semantic); embed KILLED → recall **HTTP 200 `degraded:true` in 0.58 s** (no hang); embed RESTARTED → recall `degraded:false` (semantic back).
- **AC-1 ✅ (unit) + live** — default-on confirmed: a daemon started with NO `HONEYCOMB_EMBEDDINGS` flag + the embed daemon up did semantic recall (`degraded:false`).
- **AC-3 ✅ VERIFIED** — recall reaches the cosine arm; `degraded` honest both branches (live false/true observed); line-255 hard-code gone.
- **AC-7** — `@huggingface/transformers` is an **optionalDependency** (`^3.8.1`), NOT a hard dep (won't force-pull); `pack:check` lean (no 600 MB in `files`). Full secret/PII close-out = security-worker-bee next.

`gated itest result: 3/3 passed in 17.2 s`. Live gates green. Close-out (security → quality) pending.
