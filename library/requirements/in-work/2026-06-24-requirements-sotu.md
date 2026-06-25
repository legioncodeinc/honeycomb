# Requirements — State of the Union (SOTU)

> **Date:** 2026-06-24 · **Re-validated:** 2026-06-25 (see §0 — authoritative)
> **Scope:** every PRD under `library/requirements/` (archive, backlog, completed, in-work).
> **Method:** every QA report read; every questionable status re-validated against real `src/` code
> (invocation sites, not header comments). Linchpin claims confirmed at file:line via deep scan.
> **Premise:** per project memory "Completed ≠ live (deferred assembly)" — a `Status: Completed`
> header is treated as a claim to be verified at a runtime invocation site, never as evidence.

---

## 0. Re-validation — 2026-06-25 (supersedes the verdicts below where they conflict)

> **Re-run date:** 2026-06-25 · **Method:** one focused verification pass per in-work PRD, each
> grounding every claim at a current `src/` invocation site (post-#97/#100/#101/#105 HEAD `98630a3`),
> reading every QA/security report in the folder. This section is authoritative; §2–§7 are retained
> as the 2026-06-24 record.

The six `in-work/` PRDs split cleanly into **three done-and-mis-filed** and **three genuinely open**:

| PRD | 2026-06-25 verdict | Decisive evidence (current code) |
|---|---|---|
| **028 storage-read-consistency** | ✅ **DONE — relocate to `completed/`** | All 5 required ACs met. `readConverged` live (`src/daemon/storage/converge.ts:273`); consumed by asset-sync (`runtime/assets/sync.ts:187`), dashboard (`dashboard/sync-api.ts:409`) + 6 itests. The only unadopted piece — store→recall — was **always non-AC polish** (index:106-107), never a defect. Seam adoption has *grown* since the reopen note. |
| **045 daemon-wiring-closeout** | ✅ **DONE — relocate to `completed/`** | All 7 engines wired/de-scoped at the composition root, re-confirmed after #100/#101 landed on top: 006 worker `assemble.ts:1831`; 008 `mountOntology` `:1006`; 013 `mountProductData` `:873`; 016 `buildSkillifyWorker` `:1847`; 018 `mountSkillPropagation` `:1027`; 007 5 dead files **absent** (Glob: none); 009 mounted but OFF (`pollinating/config.ts:63`). QA rev 3 = PASS. Folder **understates** reality. |
| **047 retrieval-quality-upgrades** | ✅ **DONE — relocate to `completed/`** | Merged `cdc909d`/#97. Every wave wired into the live `recallMemories` pipeline (`recall.ts:1300→1316→1326→1338→1356`), sole prod caller `runtime/.../api.ts:405`. Honest defaults (rerank `none`, dedup on, recency off-equiv, MMR opt-in). QA **PASS, 31/31 ACs**; ledger `EXECUTION_LEDGER-prd-047.md` all ✅. |
| **019 harness-integrations** | ⛔ **GENUINELY OPEN** | Only **3 of 6** harnesses wired (claude-code/codex/cursor), and those write **hooks only**. The connector registry has exactly three keys (`src/cli/connector-runner.ts:62-73`); hermes/pi/openclaw have shim source but **no connector** and are absent from the registry (`connectors/CONVENTIONS.md:90` lists them TODO). **MCP-server-via-install is met for none** (no MCP refs in any connector; claude `plugin.json` declares no `mcpServers`; hermes `.mcp.json` is orphaned). |
| **020 surfaces** | ⛔ **GENUINELY OPEN** | The Cursor **extension** (020c) is an unshipped source shell: `harnesses/cursor/extension/` holds 5 `.ts` files but **no extension manifest** (repo-wide: zero `vscode` engine / `activationEvents` / `contributes`) and **no esbuild entry** (`esbuild.config.mjs` builds only the cursor *hook* harness, `:186`). CLI (`cli/index.ts:36`), dashboard (`assemble.ts:740,782`) + notifications (`:743`) are live. |
| **033 asset-sync-substrate** | ⛔ **GENUINELY OPEN** | Session-start **asset auto-pull is dead code**: `autoPull` (`src/daemon-client/assets/install.ts:258`) has **zero production callers** (only tests); session-start pulls **skills only** (`hooks/shared/session-start.ts:93` → `autoPullSkills`); `SessionStartSeams` exposes **no asset method** (`hooks/shared/contracts.ts:427-447`). `/api/assets` (`assemble.ts:1731`) + `honeycomb asset` CLI are live. Remedy = extend the shared session-start seam (mirror PRD-045g's `autoPullSkills` wiring). |

**Net:** the in-work folder should shrink from 6 → 3. Moving 028/045/047 to `completed/` (after ticking
their ACs and flipping `Status:` headers) leaves a clean, honest open set of **019 / 020 / 033** —
all breadth/wiring work, no core-engine gaps. No commits since 2026-06-24 touched the 019/020/033
gaps, so those three "STILL OPEN" calls remain accurate at HEAD.

---

## 1. Lifecycle tally

| Tier | Count | Meaning |
|---|---|---|
| `completed/` | 44+ PRDs (incl. 028/045/047 relocated 2026-06-25, plus 049/050 since merged) | Shipped + QA-passed |
| `in-work/` | **3 PRDs (019, 020, 033)** — *was 6; 028/045/047 moved to `completed/` on 2026-06-25 (§0)* | Active |
| `backlog/` | PRD-048 (npm publishing — now in progress, OIDC #105) | Not started → in progress |
| `archive/` | 4 PRDs (pre-merge cursor 002–005) | Historical, superseded numbering |

Lifecycle = folder location. The original build plan was 20 modules across 6 phases (001–020);
everything from 021 up is post-foundation hardening, wiring, dashboard, and quality work.

---

## 2. Headline: the "Completed ≠ live" debt was caught and largely paid

On **2026-06-22** a daemon-wiring **liveness audit**
(`in-work/prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md`)
checked every completed PRD against real runtime invocation sites and found a recurring failure
mode: **7 engines were "code + tests done" but nothing in the daemon ever invoked them** — jobs
enqueued that no worker leased, or routes that fell through to `501 not_implemented`.

**PRD-045 was created to close that gap, and it is done.** Verified on `main`
(commit `d5b4a1f`, PR #82):

| Engine | Status on `main` | Evidence (current file:line) |
|---|---|---|
| 006 memory-pipeline worker | ✅ LIVE | built+started `assemble.ts:1691`; capture enqueues `memory_extraction` via `assemble.ts:1271` → `capture/attach.ts:84` |
| 008 ontology surface | ✅ LIVE | `mountOntology` fired `assemble.ts:898`; `inlineLinkMemory` on graph-persist write path `pipeline/graph-persist.ts:470` |
| 013 sources / documents | ✅ LIVE | `buildSourcesApiDeps` `assemble.ts:972`; mounted via `mountProductData` `assemble.ts:777` (no longer 501) |
| 016 skillify mining | ✅ LIVE | `buildSkillifyWorker` started `assemble.ts:1707`; `skill`/`skillify` verbs registered `commands/contracts.ts:87-88` |
| 018 team-skill-sharing | ✅ LIVE | `mountSkillPropagation` `assemble.ts:919`; **real** auto-pull seam `hooks/shared/session-start-seams.ts:90` (was a no-op) |
| 007 retrieval engine | ✅ DE-SCOPED cleanly | the 5 dead files (`recall/{engine,traversal,authorization,shaping,gate}.ts`) are **actually deleted**; RRF path is the live reality |
| 009 pollinating loop | ✅ wired, **OFF by default** | live behind `HONEYCOMB_PIPELINE_*` / `HONEYCOMB_POLLINATING_ENABLED` flags (deliberate no-surprise-spend posture) |

PRD-045's QA report is at **rev 3 / PASS**, `npm run ci` green (250 files, 2816 tests), with a
**Critical IPv4-mapped-IPv6 SSRF bypass** found-and-fixed in the new URL fetcher along the way.
This is verified at real invocation sites — not header-trust.

> ⚠️ **Status discrepancy (fix this):** PRD-045's parent index still reads `Status: In Work` with
> AC-1…AC-6 unchecked, even though all sub-PRDs are Completed/Resolved, the work merged, and QA
> passed. It is *more* done than its folder claims — the inverse of the usual trap.
> **Action: move `prd-045-daemon-wiring-closeout/` → `completed/`** and check its parent ACs.

---

## 3. The genuinely-open in-work set (validated in code)

Four PRDs were reopened from `completed/` because the liveness audit caught real gaps. Each gap was
re-confirmed to **still exist** in current code.

| PRD | Reopened reason | Code verdict |
|---|---|---|
| **019 harness-integrations** | Only 1 of 6 harnesses fully live | **STILL OPEN.** Connector registry registers `claude-code` + `codex` + `cursor` only (`cli/connector-runner.ts:62-73`). Hermes/pi/OpenClaw exist as shim source but are **not** in the registry. MCP-server-via-install met for none. *(Correction to the audit: registry has 3 harnesses, not 2.)* |
| **020 surfaces** | Cursor extension UI unbuilt | **STILL OPEN.** `harnesses/cursor/extension/` has TS sources but **no** extension manifest and **no** esbuild bundle entry — an unshipped shell. CLI + dashboard + notifications are live. |
| **028 storage-read-consistency** | Seam built but headline call site never adopted it | **RECLASSIFIED 2026-06-25 → DONE (see §0).** All 5 required ACs met; the un-adopted store→recall wiring was always explicitly optional / non-AC polish, not a defect. The "open" status was a stale lifecycle artifact. **Relocate to `completed/`.** |
| **033 asset-sync-substrate** | Session-start asset auto-pull is dead code | **STILL OPEN.** `daemon-client/assets/install.ts:258` `autoPull` is never invoked; `hooks/shared/session-start.ts:93` auto-pulls **skills only**; `SessionStartSeams` has no asset method. `/api/assets` + `honeycomb asset` CLI are live. Needs the shared session-start seam extended (coordinate with 045g's seam). |

> **Important nuance:** the 019/020 QA reports (dated 2026-06-18) say "CLEAN TO SHIP / 36-36 / 27-27
> ACs" — but those reports honestly validated *code-behind-seams*, explicitly **not** claiming live
> wiring. That is exactly why the later liveness audit reopened them. The QA wasn't wrong; it
> measured a different bar (code+tests) than the audit (runtime reachability).

---

## 4. PRD-047 retrieval-quality-upgrades — early, and honestly so

| Wave | Status (code-verified) | Evidence |
|---|---|---|
| 047a native hybrid | ✅ **Closed with a measured NO** | Live A/B proved `deeplake_hybrid_record` returns degenerate constant-zero scores (recall@5 0.14 vs RRF 0.72–0.78). Keep RRF. `memories/hybrid-recall.ts` kept as **unwired** reference (bench-only); vendor report filed. |
| 047f graded nDCG eval | ✅ **Implemented + wired** | `eval/metrics.ts:108-150` computes nDCG; `eval/golden.ts` `runEval` reports nDCG@10; graded-relevance schema live (golden set still binary). |
| 047b reranker | ✅ **Built (later 2026-06-24)** | `rerankHits` in `recall.ts`; default `none` (measured ~0 lift). See update below. |
| 047c semantic dedup | ✅ **Built (later 2026-06-24)** | `dedupHits` in `recall.ts`, default on. See update below. |
| 047d recency dampening | ✅ **Built (later 2026-06-24)** | `applyRecencyDampening`, default off-equivalent. See update below. |
| 047e token-budget + MMR | ✅ **Built (later 2026-06-24)** | `selectWithinTokenBudget`, opt-in. See update below. |

> **UPDATE (later 2026-06-24): 047b–047e are now BUILT.** This SOTU was written in the morning; a
> `/the-smoker` run later the same day drove PRD-047 to completion (W0 047f → W1 047b → W2 047c →
> W3 047d → W4 047e), with an `EXECUTION_LEDGER-prd-047.md`, security + quality close-out (QA PASS,
> 31/31 ACs), and PR #97. The "why they aren't wired" analysis below was accurate **at the time of
> the original audit** and is retained as the pre-smoker snapshot — read it as history, not current
> state. Net change vs the snapshot: the reranker/dedup/recency/MMR stages are wired into `recall.ts`
> behind honest defaults (rerank `none` after a measured ~0 lift; dedup on; recency off-equivalent;
> MMR opt-in), and the config knobs are no longer orphaned. 047a was also re-tested (operator fixed →
> parity; still keep RRF).

### Why 047b–047d weren't wired in — as of the original morning audit (root cause, code-validated)

> Historical snapshot — superseded by the UPDATE above. Two distinct facts at the time:

1. **They were never built — they are `backlog` sub-PRDs inside an in-work parent.** Each of
   047b/c/d/e carries `Status: backlog` in its own header. Only **Wave 0** of PRD-047 has
   executed: 047a (benchmark → "keep RRF") and 047f (the nDCG eval instrument). There is **no
   execution ledger** for 047 (`library/ledger/` has no `prd-047` file), confirming W1/W2 have not
   run. The sequencing is deliberate: land the **measurement** first (047f) so every ranking change
   in W1/W2 is provable on the golden set, *then* spend it.

2. **The config knobs that make them look "half-wired" are orphaned scaffolding from a deleted
   PRD.** `src/daemon/runtime/recall/config.ts` was born in commit `49880af`
   (**`feat(prd-007): retrieval — five-phase recall engine`**). The reranker/recency fields were
   scaffolded as part of PRD-007's original five-phase `RecallEngine`. **PRD-045b de-scoped that
   engine** — it deleted `engine/traversal/authorization/shaping/gate.ts` but kept `config.ts`. So
   those knobs are survivors of a torn-out design. The live recall path doesn't even read them: the
   only remaining importer of `recall/config.ts` is `vfs/api.ts:62` (`resolveRecallConfig`), **not**
   `recall.ts`.

**Net:** 047b/c/d/e are planned, eval-gated, pre-implementation. What exists in the tree is a config
remnant from the deleted PRD-007 engine — which is precisely why the live recall path ignores it.
PRD-047's own framing ("the plumbing is half-built") is accurate but generous: the plumbing is
inherited rubble, and these waves will wire a real reranker/dedup/recency stage into `recall.ts` and
likely re-home or clean up the stray knobs as they go.

---

## 5. Backlog: PRD-048 npm publishing — not started, by design

Confirmed in `package.json`: still `"private": true`, unscoped name `honeycomb`, `publishConfig`
commented out. The release pipeline (`.github/workflows/release.yaml`, `pack-check.mjs`, preflight)
is built and fails-closed. 048 is a switch-flip + org-provisioning PRD that deliberately stops short
of the first real publish (the go-live tag is a separate manual step).

---

## 6. Cross-cutting hygiene flags

- **Pervasive doc-rot (cosmetic):** completed sub-PRDs still read `Status: Draft`;
  `src/daemon/storage/catalog/index.ts:15-34` carries stale `(stub)` / "Wave 2 — DO NOT TOUCH"
  comments on fully-built groups. A `library` sync-audit pass is owed.
- **Latent route collision (non-breaking):** both `mountDashboardApi` and `mountGraphApi` register
  `GET /api/graph`; the dashboard's `{nodes,edges}` shape wins by registration order. Flagged given
  this repo's history with route collisions (project memory: "Dogfood surfaces integration bugs").
- **Post-045 momentum:** commits #89–#93 (graph render fix, closed memory-type taxonomy,
  Claude-Code plugin re-registration) show active polishing continuing past the closeout.

---

## 7. Bottom line

**Honeycomb is functionally complete and live as a single-harness (Claude Code) agent-memory
daemon.** Foundation, storage, capture, memory pipeline, retrieval (RRF), ontology, skillify,
team-sharing, dashboard, CLI, secrets/vault, and codebase-graph are all wired into the real
composition root and verified. The "completed ≠ live" debt that threatened the whole project was
found and paid down by PRD-045.

**What remains is breadth and polish, not core engine work** (updated per §0, 2026-06-25):

1. **Multi-harness reach (019/020)** — 5 of 6 harnesses (hooks-only for the 3 that exist; no
   connector for hermes/pi/openclaw), MCP-via-install for none, and the Cursor extension UI (no
   manifest, no esbuild entry) still need wiring. *Highest-value gap — genuinely open.*
2. **Asset auto-pull (033)** — one session-start seam extension; `autoPull` is dead code today.
   *Genuinely open.*
3. **Go-public (048)** — switch-flips when ready to ship to npm.
4. **Bookkeeping (now the bulk of the in-work folder)** — **relocate 028, 045, and 047 to
   `completed/`** (all done/QA-passed; tick their ACs + flip `Status:` headers first), flip Draft
   sub-PRD statuses, dedupe the `/api/graph` route.

The single most important correction (2026-06-25): **three of the six in-work PRDs — 028, 045, 047 —
are done and merely mis-filed; relocate them.** Only **019 / 020 / 033** carry real, code-verified
open work. PRD-047 has since merged (#97) and joins 045 and 028 in the "docs understate reality" set.

### Validation caveat

Wiring was validated at invocation sites and via the green CI/QA suites, but several acceptance
paths are proven by **token-gated live itests that are skip-safe**. "Live on a real DeepLake backend
under load" rests on the dogfood runs the QA reports cite, not on something re-run during this audit.
