# Standing: completed PRDs 027-034

Date: 2026-10-04
Shard: Wave 1b, completed 027 through 034
Tree: this repository only. `node_modules` and build outputs were not used as evidence.
Method: every index, lettered child, and QA note in the shard was read. Each acceptance criterion is quoted from the PRD, then checked against current source. A QA report saying PASS is not a verdict.

Verdict rules:

- MET: the behavior or the test that encodes it is in this tree at the cited lines.
- UNMET: the named behavior or file is absent or contradicted by current source.
- UNVERIFIABLE: only a fresh `npm run ci` or a credentialed live run would prove the clause, and this pass did not execute those. When an AC mixes an in-tree behavior with "gates are green", the verdict follows the in-tree behavior and the gate clause is listed under "Gate re-run".

ASCII hyphens only.

## Counts

| PRD | Index ACs | Child ACs | MET | UNMET | UNVERIFIABLE | Recommended bucket |
|---|---|---|---|---|---|---|
| 027 | 7 | 0 | 6 | 1 | 0 | completed |
| 028 | 5 | 0 | 5 | 0 | 0 | completed |
| 029 | 6 | 0 | 4 | 1 | 1 | completed |
| 030 | 6 | 0 | 6 | 0 | 0 | completed |
| 031 | 6 | 0 | 5 | 0 | 1 | completed |
| 032 | 8 | 20 | 20 | 8 | 0 | completed, with residuals |
| 033 | 7 | 18 | 25 | 0 | 0 | completed |
| 034 | 7 | 13 | 18 | 0 | 2 | completed |
| Total | 52 | 51 | 89 | 10 | 4 | |

103 acceptance criteria. 89 MET, 10 UNMET, 4 UNVERIFIABLE.

Unmet list (10):

1. PRD-027 AC-4. Dashboard recall renderer is absent. CLI half is met.
2. PRD-029 AC-1. Dashboard "lexical fallback" badge and its DOM test are absent.
3. PRD-032 AC-5. Dashboard Settings panel is absent.
4. PRD-032 c-AC-1 through c-AC-5 (five criteria). Same absent panel.
5. PRD-032 AC-6. Provider/model vault override is met. `POST /api/diagnostics/pollinate` still returns `reason: "disabled"` from the env flag, not the vault setting.
6. PRD-032 d-AC-2. Same pollinate-route gap.

## Files read

- `library/requirements/completed/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md` (no lettered child, no QA note)
- `library/requirements/completed/prd-028-storage-read-consistency/prd-028-storage-read-consistency-index.md`
- `library/requirements/completed/prd-028-storage-read-consistency/reports/2026-06-21-qa-report.md`
- `library/requirements/completed/prd-028-storage-read-consistency/reports/2026-06-21-security-report.md`
- `library/requirements/completed/prd-029-degradation-observability/prd-029-degradation-observability-index.md`
- `library/requirements/completed/prd-029-degradation-observability/reports/2026-06-21-security-report.md`
- `library/requirements/completed/prd-029-degradation-observability/reports/2026-06-22-qa-report.md`
- `library/requirements/completed/prd-029-degradation-observability/reports/2026-06-22-security-report.md`
- `library/requirements/completed/prd-029-degradation-observability/reports/2026-07-05-qa-report.md`
- `library/requirements/completed/prd-030-memory-compaction/prd-030-memory-compaction-index.md`
- `library/requirements/completed/prd-030-memory-compaction/reports/2026-06-21-qa-report.md`
- `library/requirements/completed/prd-030-memory-compaction/reports/2026-06-21-security-report.md`
- `library/requirements/completed/prd-031-live-integration-test-net/prd-031-live-integration-test-net-index.md`
- `library/requirements/completed/prd-031-live-integration-test-net/reports/2026-06-21-qa-report.md`
- `library/requirements/completed/prd-032-encrypted-vault/prd-032-encrypted-vault-index.md`
- `library/requirements/completed/prd-032-encrypted-vault/prd-032a-encrypted-vault-core.md`
- `library/requirements/completed/prd-032-encrypted-vault/prd-032b-encrypted-vault-cli.md`
- `library/requirements/completed/prd-032-encrypted-vault/prd-032c-encrypted-vault-dashboard.md`
- `library/requirements/completed/prd-032-encrypted-vault/prd-032d-encrypted-vault-wireback.md`
- `library/requirements/completed/prd-032-encrypted-vault/reports/2026-06-21-qa-report.md`
- `library/requirements/completed/prd-033-asset-sync-substrate/prd-033-asset-sync-substrate-index.md`
- `library/requirements/completed/prd-033-asset-sync-substrate/prd-033a-asset-sync-substrate-registry-identity.md`
- `library/requirements/completed/prd-033-asset-sync-substrate/prd-033b-asset-sync-substrate-promotion-lifecycle.md`
- `library/requirements/completed/prd-033-asset-sync-substrate/prd-033c-asset-sync-substrate-sync-engine.md`
- `library/requirements/completed/prd-033-asset-sync-substrate/qa/2026-06-21-qa-report.md`
- `library/requirements/completed/prd-033-asset-sync-substrate/qa/2026-06-25-qa-report.md`
- `library/requirements/completed/prd-033-asset-sync-substrate/qa/2026-06-25-security-report.md`
- `library/requirements/completed/prd-034-resilient-live-test-strategy/prd-034-resilient-live-test-strategy-index.md`
- `library/requirements/completed/prd-034-resilient-live-test-strategy/prd-034a-resilient-live-test-strategy-irl-faithful-suite.md`
- `library/requirements/completed/prd-034-resilient-live-test-strategy/prd-034b-resilient-live-test-strategy-stress-harness.md`
- `library/requirements/completed/prd-034-resilient-live-test-strategy/qa/2026-06-21-qa-report.md`

## Recommended buckets

Stay in `completed/` for all eight folders. Do not move them on this shard's evidence alone.

- 027, 028, 029, 030, 031, 033, 034: the load-bearing behavior is in source. 027 AC-4 and 029 AC-1 fail because `src/dashboard/web/` is gone. `library/knowledge/private/frontend/dashboard-architecture.md` says the SPA now lives in the Hive repo and is not files in this tree. That is a cross-repo split, not withdrawn work and not a reason to return the daemon PRDs to `in-work/`.
- 032: vault core, CLI, DeepLake copy-not-move migration, and provider/model override are in source. Residuals that are not met in this tree: the Settings panel (AC-5, c-AC-1..5) and the pollinate HTTP toggle (AC-6 pollinate clause, d-AC-2). Recommend the folder stay `completed/` and that wave 2 treat those residuals as open, not as a QA-PASS. A move back to `in-work/` is justified only if wave 2 decides the pollinate route clause reopens the PRD. Archive is the wrong bucket: the work was not withdrawn.
- Child status lines are stale on 032a-d and 034a-b (they still say Draft) while the indexes say completed. That is a status-line edit for a later librarian, not a bucket move.
- 030's 2026-06-21 QA critical (`epistemic_assertions` keyed by `claim_key`) is fixed in current source. Do not reopen 030 from that QA note.
- 028's store-to-recall adoption is explicitly non-AC in the index. Do not treat it as unmet.

## Gate re-run (not executed)

These clauses say `npm run ci` / `build` / `audit:sql` / `audit:openclaw` are green, or that a live suite passed on a healthy backend. This pass did not run them. Structural wiring that can be read is cited on the AC. Current greenness is UNVERIFIABLE:

- 027 AC-7 gate tail
- 028 AC-5 gate tail (redaction unit test is MET)
- 029 AC-6 (the whole AC)
- 030 AC-6 gate tail
- 031 AC-6 green and unit-count-stable tail
- 032 AC-8 gate tail
- 034 AC-7 green tail (stress-never-gates wiring is MET)
- 034 a-AC-6 (the whole AC)
- 027 AC-6, 028 AC-3, 031 AC-5, 034 AC-2: the asserting tests are in tree; the live numeric result was not re-run

---

## PRD-027 Recall ranking and eval

Index only. No lettered child. No QA note in the folder. Index status line says completed (`prd-027-recall-ranking-and-eval-index.md:3`).

Recommended bucket: completed. Ranking, shaping, dedup, the golden set, and `npm run eval:recall` are in source. AC-4's dashboard half is the SPA residual.

### AC-1 MET

Quote: "POST /api/memories/recall returns hits each carrying a real score, ordered by fused relevance (RRF, D-1) - not arm order, not client-fabricated. Unit-tested: a query where the semantic-strong hit and the lexical-strong hit differ produces a fused order that matches the RRF math."

PRD: `library/requirements/completed/prd-027-recall-ranking-and-eval/prd-027-recall-ranking-and-eval-index.md:112-114`

Evidence:

- `src/daemon/runtime/memories/recall.ts:238` `RRF_K = 60`
- `src/daemon/runtime/memories/recall.ts:284-297` `MemoryRecallHit.score`
- `src/daemon/runtime/memories/recall.ts:757` `fuseHits`
- `src/daemon/runtime/memories/api.ts:527-537` `recallResponse` forwards hits verbatim, including `score`
- `tests/daemon/runtime/memories/recall.test.ts:618-656` semantic-strong vs lexical-strong matches the RRF sum

### AC-2 MET

Quote: "Given a recall where a distilled [memory] fact and a raw [sessions] JSON dump both match, the distilled fact ranks ABOVE the raw dump, and the raw session row is tagged drill-down/secondary (D-3). Unit-tested on a mixed-arm fixture."

PRD: `prd-027-recall-ranking-and-eval-index.md:115-117`

Evidence:

- `src/daemon/runtime/memories/recall.ts:255-258` `ARM_CLASS_WEIGHT` memory 1.0, session 0.4
- `src/daemon/runtime/memories/recall.ts:320-324` `secondary: true` for a raw session dump
- `src/daemon/runtime/memories/recall.ts:815` `secondary: kind === "session"`
- `tests/daemon/runtime/memories/recall.test.ts:666-689` fact ranks above the dump and the dump is `secondary: true`

### AC-3 MET

Quote: "Near-duplicate hits across arms are collapsed to one, and every returned hit carries its source + scope provenance. Unit-tested."

PRD: `prd-027-recall-ranking-and-eval-index.md:118-119`

Evidence:

- `src/daemon/runtime/memories/recall.ts:860` fusion identity is `source+id`
- `src/daemon/runtime/memories/recall.ts:284-299` every hit carries `source` and `kind`
- `tests/daemon/runtime/memories/recall.test.ts:715-742` a hit on both the semantic and lexical arms collapses to one and keeps `source: "memories"`

Scope note: tenancy scope stays on the request (`scope: SCOPE` in the test). The hit does not grow an org/workspace field. The unit test treats `source` plus `kind` as the provenance the AC asks to keep. MET on that reading.

### AC-4 UNMET

Quote: "The dashboard/CLI render the engine score + engine order; the 1 - i*0.06 fabrication is removed (grep-proven gone) and the rendered order equals the engine order."

PRD: `prd-027-recall-ranking-and-eval-index.md:120-121`

Evidence, CLI half MET:

- Grep of `*.{ts,tsx,js,mjs}` for `1 - i * 0.06` and `Math.max(0, 1 -`: ABSENT
- `src/commands/storage-handlers.ts:304-312` iterates engine order and prints `hit.score`. No client re-sort.

Evidence, dashboard half UNMET:

- `src/dashboard/web/` ABSENT (no `app.tsx`, no recall bar)
- `src/dashboard/views.ts` has no recall score render
- `library/knowledge/private/frontend/dashboard-architecture.md:44` states the SPA files are not in this repository

### AC-5 MET

Quote: "A committed golden set (~30-50 (query -> expected) pairs, lexical-miss-inclusive) runs via npm run eval:recall AND a gated live itest against a real assembled daemon + real embed daemon (polling to embedding convergence), emitting recall@k (k=1,5,10) + MRR (+ nDCG). The harness reports per-query hits/misses."

PRD: `prd-027-recall-ranking-and-eval-index.md:122-125`

Evidence:

- `eval/recall-golden.json:7` `pairs` array. 36 `"key":` entries. 16 `"lexicalMiss": true`
- `package.json:68` `"eval:recall": "node scripts/eval-recall.mjs"`
- `scripts/eval-recall.mjs:3-6` documents the golden set plus assembled daemon
- `src/eval/metrics.ts:19-21` recall@k, MRR, nDCG
- `tests/integration/recall-eval-live.itest.ts:93-94` loads golden set and baseline
- `tests/eval/golden.test.ts:158-167` metric unit tests including nDCG

The live itest was not executed here. The harness and the gated file exist.

### AC-6 MET

Quote: "Run on the golden set with embeddings ON vs the BM25/ILIKE-only fallback, the harness shows semantic-on with the new ranking beats lexical-only on recall@5 / MRR. A committed recall@5 / MRR baseline is enforced: a change that drops either below baseline - epsilon FAILS the eval."

PRD: `prd-027-recall-ranking-and-eval-index.md:126-129`

Evidence:

- `eval/recall-baseline.json:5-8` `recallAt5` 0.55, `mrr` 0.55, `placeholder` false
- `tests/eval/golden.test.ts:240-247` an enforced baseline fails when recall@5 drops below the floor
- `tests/integration/recall-eval-live.itest.ts:439-459` asserts `lift.beats` for semantic vs lexical

Live numeric pass was not re-run. The gate and the comparison assertion are in source.

### AC-7 MET (gate tail not re-run)

Quote: "npm run ci / build / audit:sql / audit:openclaw / invariant stay green; the ranking + shaping preserve the per-arm fail-soft tolerance (a missing sibling table still degrades that arm to empty, never a 500); no secret/credential in eval output or fixtures (grep-proven)."

PRD: `prd-027-recall-ranking-and-eval-index.md:130-132`

Evidence:

- `tests/daemon/runtime/memories/recall.test.ts:745-777` missing sibling arms return the surviving hit, no throw, `degraded: true`
- Golden fixtures in `eval/recall-golden.json` are synthetic sentences, not credentials
- Current `npm run ci` greenness: UNVERIFIABLE (not run)

---

## PRD-028 Storage read-consistency

No lettered child. QA `reports/2026-06-21-qa-report.md` says PASS on AC-1..5. Security report same day says CLEAN. Those reports are historical. Verdicts below are from current source.

Recommended bucket: completed.

### AC-1 MET

Quote: "A unit test drives readConverged against a FAKE flapping StorageQuery that returns stale (empty / lower-version) rows for the first N calls then the fresh row. The seam polls until the predicate holds and returns the fresh ok - proven without any live backend, with a fake clock so the test is fast and non-flaky."

PRD: `prd-028-storage-read-consistency-index.md:76-79`

Evidence:

- `src/daemon/storage/converge.ts:273` `export async function readConverged`
- `tests/daemon/storage/converge.test.ts:78` flapping fake returns the fresh ok

### AC-2 MET

Quote: "With a fake client that NEVER converges, readConverged exhausts the bounded budget and returns the last real QueryResult (not a throw, not a hang, not an invented row). A unit test asserts the call returns within the budget and the result is the last real read."

PRD: `prd-028-storage-read-consistency-index.md:80-82`

Evidence:

- `src/daemon/storage/converge.ts:136-149` budget from `HONEYCOMB_READ_CONVERGE_*`
- `tests/daemon/storage/converge.test.ts:103` never-converging fake returns the last real result

### AC-3 MET (live loop not re-run)

Quote: "A gated live itest writes a row via the controlled-write primitive then reads it back THROUGH readConverged and ALWAYS sees the write - run N>=20 times in a loop with zero misses."

PRD: `prd-028-storage-read-consistency-index.md:83-85`

Evidence:

- `tests/integration/read-converge-live.itest.ts:74` `const N = 25`
- `tests/integration/read-converge-live.itest.ts:178-206` writes via `appendVersionBumped` and reads back through `readConverged`
- `tests/integration/read-converge-live.itest.ts:29` `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)`

Zero-miss on a live backend was not re-run.

### AC-4 MET

Quote: "At least the controlled-writes + graph-persist live itests read back through the shared seam (or the harness helper that wraps it); their bespoke poll loops are removed. grep proves no remaining ad-hoc retry until row appears loop in those files."

PRD: `prd-028-storage-read-consistency-index.md:86-88`

Evidence:

- `tests/integration/controlled-writes-live.itest.ts:236` `readConverged`
- `tests/integration/graph-persist-live.itest.ts:129` `readConverged`
- Grep of those two files for `for (let poll` and `SCAN_POLLS`: ABSENT

Other itests still hand-roll polls. The AC only requires these two files.

### AC-5 MET (gate tail not re-run)

Quote: "npm run ci / build / audit:sql / audit:openclaw all green; a trace-on run shows convergence lines carry no token and no full org (redaction proof)."

PRD: `prd-028-storage-read-consistency-index.md:89-90`

Evidence:

- `src/daemon/storage/converge.ts:299` `redactToken(scope.org)`
- `tests/daemon/storage/converge.test.ts:163-182` trace must not contain the full org; last-4 form only
- Current gate greenness: UNVERIFIABLE

Call-site note (not an AC): `readConverged` is used by `src/daemon/runtime/assets/sync.ts:187` and `src/daemon/runtime/dashboard/sync-api.ts:409`. Store-to-recall wiring remains optional, matching the index at lines 10-14.

---

## PRD-029 Degradation observability

No lettered child. QA notes read: 2026-06-22 QA (PASS 6/6, cites `src/dashboard/web/app.tsx`), 2026-06-21 and 2026-06-22 security (CLEAN), 2026-07-05 QA (additive `/api/status` check). The 2026-06-22 dashboard paths are stale.

Recommended bucket: completed. Daemon health and the degraded log are in source. AC-1 is the SPA residual.

### AC-1 UNMET

Quote: "A unit/DOM test asserts that when a recall response carries degraded: true, the dashboard recall bar renders the lexical fallback badge; when degraded: false it does not. Driven by the recall response shape, no live backend needed."

PRD: `prd-029-degradation-observability-index.md:69-71`

Evidence:

- `src/dashboard/web/` ABSENT
- Grep of `src/dashboard` for `lexical fallback` / `LexicalFallback` / `HealthStrip`: ABSENT
- `tests/dashboard/web/` ABSENT
- CLI marker exists and is not the dashboard bar: `src/commands/storage-handlers.ts:301-302`, test `tests/commands/storage-handlers.test.ts:142-154`

### AC-2 MET

Quote: "A unit test asserts that when a subsystem is down (e.g. the SELECT 1 probe returns non-ok -> storage unreachable, or embeddings are off), /health detail names that subsystem and its state - not a bare degraded. The coarse bit still reports too."

PRD: `prd-029-degradation-observability-index.md:72-74`

Evidence:

- `src/daemon/runtime/health.ts:487` `buildHealthDetail`
- `src/daemon/runtime/health.ts:520` `reasons` object
- `tests/daemon/runtime/health.test.ts:94-116` storage unreachable and embeddings off, coarse bit still reported
- `src/daemon/runtime/server.ts:338-342` live `/health` uses `publicHealthDetail`

### AC-3 MET

Quote: "A test proves the full subsystem detail is exposed on local /health but the public team/hybrid /health returns only the coarse bit (the detail is on the protected diagnostics surface) - no internal topology leaks unauthenticated."

PRD: `prd-029-degradation-observability-index.md:75-77`

Evidence:

- `src/daemon/runtime/health.ts:652-656` `publicHealthDetail` keeps `reasons` only when `mode === "local"`
- `tests/daemon/runtime/health.test.ts:480-540` local keeps reasons; team and hybrid public bodies strip them; protected diagnostics route exposes them

### AC-4 MET

Quote: "A recall that runs degraded emits a structured log line capturing the degraded mode (lexical fallback / which arms covered) - asserted via the ring-buffer logger."

PRD: `prd-029-degradation-observability-index.md:78-79`

Evidence:

- `src/daemon/runtime/memories/api.ts:119` `RECALL_DEGRADED_EVENT = "recall.degraded"`
- `src/daemon/runtime/memories/api.ts:567-574` `logDegradedRecall` emits `mode: "lexical_fallback"` and `sources`
- `src/daemon/runtime/memories/api.ts:882` call site
- `tests/daemon/runtime/health.test.ts:570-603` exactly-one event on degraded recall, none when not degraded

### AC-5 MET

Quote: "A grep/test proves no token, endpoint credential, full org GUID, or header value appears in the /health detail, the degraded badge payload, or the degraded log line."

PRD: `prd-029-degradation-observability-index.md:80-81`

Evidence:

- `src/daemon/runtime/memories/api.ts:560-564` log forwards mode and sources only
- `tests/daemon/runtime/health.test.ts:623` AC-5 suite injects a token and org and asserts they do not appear
- Dashboard badge payload: ABSENT with the SPA (see AC-1). The daemon log and `/health` detail tests still cover the fields this AC names for those two surfaces.

### AC-6 UNVERIFIABLE

Quote: "npm run ci / build / audit:sql / audit:openclaw all green."

PRD: `prd-029-degradation-observability-index.md:82`

Evidence: `.github/workflows/ci.yaml:3-6` still runs that recipe on the quality gate. This pass did not run it. Current greenness ABSENT as a fresh result.

---

## PRD-030 Memory compaction

No lettered child. QA `reports/2026-06-21-qa-report.md` verdict NOT VERIFIED: `epistemic_assertions` mapped to `claim_key`. Security report same day otherwise CLEAN. The index reconciliation (lines 8-12) says the key is now `id`. Current source matches the reconciliation, not the QA failure.

Recommended bucket: completed.

### AC-1 MET (live not re-run)

Quote: "Gated live itest: seed a version-bumped table with N (e.g. 50) versions of one key. Run compaction. After it, read back poll-convergently and assert: rows for that key <= K (the retention bound), the highest-version read is BYTE-IDENTICAL to the pre-compaction read, and the total row count strictly dropped."

PRD: `prd-030-memory-compaction-index.md:83-86`

Evidence:

- `src/daemon/storage/compaction.ts` reap set excludes `version >= highest` (QA cited the invariant; current allow-list is `src/daemon/storage/compaction.ts:215`)
- `tests/integration/compaction-live.itest.ts:58` imports `readConverged`
- `tests/integration/compaction-live.itest.ts:119-124` read-back goes through the shared seam

Live byte-identical result was not re-run.

### AC-2 MET

Quote: "Versions inside the keep-latest-N AND inside the time window survive; only versions outside BOTH are reaped. Proven with a seeded mix of recent + old versions: the old-and-beyond-N are gone, the recent-or-windowed remain, the current is untouched."

PRD: `prd-030-memory-compaction-index.md:87-89`

Evidence: `tests/daemon/storage/compaction.test.ts` retention matrix (QA cited `compaction.test.ts:166-219`; the file still exists and covers AC-2). Live file `tests/integration/compaction-live.itest.ts` still contains the AC-2 case. Not re-run live.

### AC-3 MET (live not re-run)

Quote: "During/after a compaction pass, a concurrent highest-version read for the key NEVER returns empty and NEVER returns a non-current version. Proven by interleaving a poll-convergent read against a live compaction on a throwaway namespaced table; the current state is always resolvable."

PRD: `prd-030-memory-compaction-index.md:90-93`

Evidence: `tests/integration/compaction-live.itest.ts` AC-3 observations go through `readConverged` (`:255`, `:313`). Live interleave was not re-run.

### AC-4 MET

Quote: "Running compaction twice in a row on the same key reaps on the first pass and is a no-op on the second (zero rows deleted, current read still byte-identical). Asserted on the live itest."

PRD: `prd-030-memory-compaction-index.md:94-95`

Evidence: `tests/daemon/storage/compaction.test.ts` idempotent case and `tests/integration/compaction-live.itest.ts` second-pass case. Live not re-run.

### AC-5 MET

Quote: "A compaction interrupted mid-reap (simulated partial delete) leaves the highest version readable and the retained window intact; a subsequent re-run completes to the bound. No lineage hole that drops the survivor."

PRD: `prd-030-memory-compaction-index.md:96-98`

Evidence: `tests/daemon/storage/compaction.test.ts` partial-delete re-run, and the live itest AC-5. Highest-version exclusion is in the reap set (`src/daemon/runtime/maintenance/compact-api.ts:98-101` documents the safety rule).

### AC-6 MET (gate tail not re-run)

Quote: "No source-backed current claim is reaped; reaped counts are logged per table/key; npm run ci, build, audit:sql, audit:openclaw, and the invariant test pass. The live itest is gated (creds-only, skipped in CI) and isolates to a throwaway, namespaced table it is free to DROP, never a real pollinating_state/skills/rules table."

PRD: `prd-030-memory-compaction-index.md:99-102`

Evidence:

- `src/daemon/runtime/maintenance/compact-api.ts:105-111` `COMPACTABLE_KEY_COLUMNS.epistemic_assertions` is `"id"` (the 2026-06-21 QA failure is fixed)
- `tests/daemon/runtime/maintenance/compact-api.test.ts:140-203` writer cross-check pins `epistemic_assertions` to `id` and fails on drift
- `src/daemon/runtime/maintenance/compact-api.ts:269-276` `POST /api/diagnostics/compact`
- `tests/integration/compaction-live.itest.ts:120` area is `describe.skipIf` gated and uses a `ci_compaction_` throwaway (file header and table prefix)
- Gate greenness: UNVERIFIABLE

---

## PRD-031 Live-integration test net

No lettered child. QA `reports/2026-06-21-qa-report.md` says PASS. CI has since been reshaped by PRD-034 (push live job is soft). That still satisfies AC-4's "runs on schedule plus main-push, skips with no token" wording. It does not require the push job to block the merge.

Recommended bucket: completed.

### AC-1 MET

Quote: "An assembled-daemon test boots via assembleDaemon and asserts the PRD-022 data routes (e.g. GET /api/diagnostics/kpis, POST /api/memories/recall) are reachable and NOT shadowed by the dashboard host - a test that WOULD HAVE FAILED under the PRD-020b/PRD-022 collision and passes now."

PRD: `prd-031-live-integration-test-net-index.md:71-74`

Evidence: `tests/daemon/runtime/assembled-net.test.ts:80-89` AC-1 describe, real assembled app, plain CI file (not `.itest.ts`).

### AC-2 MET

Quote: "An assembled-daemon test proves a request MISSING the required x-honeycomb-* header is rejected at the middleware edge (e.g. a session group 400/401 without x-honeycomb-session), and the same request WITH the header reaches the handler - exercising the real middleware chain, not an isolated mount."

PRD: `prd-031-live-integration-test-net-index.md:75-78`

Evidence: `tests/daemon/runtime/assembled-net.test.ts:138-147` AC-2 describe.

### AC-3 MET (live not re-run)

Quote: "A gated live itest against a FRESH partition (only memories exists) proves recall still surfaces the memories hit and does NOT 500 when the memory/sessions sibling tables are absent (the per-arm tolerance), reproducing the original dogfood regression."

PRD: `prd-031-live-integration-test-net-index.md:79-81`

Evidence: `tests/integration/missing-table-heal-live.itest.ts:39` header states siblings proven absent and read-back uses `readConverged`. `tests/integration/missing-table-heal-live.itest.ts:248` `readConverged` before recall. Live not re-run.

### AC-4 MET

Quote: "A CI job definition runs the live suite on a schedule: trigger (plus main-push), and on a no-token run (fork / secret unset) it SKIPS cleanly and the workflow stays green - proven by the preserved gate -> has_token gate."

PRD: `prd-031-live-integration-test-net-index.md:82-84`

Evidence:

- `.github/workflows/ci.yaml:42-43` `schedule` cron `0 7 * * *`
- `.github/workflows/ci.yaml:238-244` `integration-push-soft` on `push` when `has_token == 'true'`, `continue-on-error: true`
- `.github/workflows/ci.yaml:268-276` `integration-nightly` on schedule
- `.github/workflows/ci.yaml:220-228` `gate` writes `has_token=false` when the secret is empty

### AC-5 MET (live not re-run)

Quote: "The broadened live suite's write->read-back classes go through PRD-028's consistency seam (no bespoke poll loops); a multi-run loop shows no consistency-flap flakes."

PRD: `prd-031-live-integration-test-net-index.md:85-86`

Evidence: `tests/integration/write-readback-noflap-live.itest.ts:6-31` states no bespoke poll loops. `tests/integration/write-readback-noflap-live.itest.ts:80` `const N = 12`. Both watermark and `rowPresent` loops call `readConverged` (`:196`, `:238`). Live zero-miss was not re-run. N=12 is below PRD-028's N>=20; this AC does not set N.

### AC-6 UNVERIFIABLE

Quote: "npm run ci (which excludes .itest.ts) stays green and unit-count-stable; build / audit:sql / audit:openclaw green; the new assembled-daemon tests run in plain CI."

PRD: `prd-031-live-integration-test-net-index.md:87-88`

Evidence for the placement half: `tests/daemon/runtime/assembled-net.test.ts` is a plain `*.test.ts`, so it is inside `npm test` rather than the integration config. Current green and unit-count stability were not measured.

---

## PRD-032 Encrypted vault

Children: 032a, 032b, 032c, 032d. Their status tables in the index still say Draft (`prd-032-encrypted-vault-index.md:174-177`) while the index status is completed. QA `reports/2026-06-21-qa-report.md` says PASS and notes `resolveDeeplakeToken` is staged off the live login path. That staging is still true.

Recommended bucket: completed, with the residuals in the unmet list. Do not treat the QA PASS as covering the dashboard or the pollinate route.

### Index AC-1 MET

Quote: "The vault stores secret, setting, and a registered test/future class under (class, scope, name), each record encrypted with the machine-bound key at file 0600 / dir 0700. Copying the vault dir to a host with a different machine key fails to decrypt. Unit-tested against a temp dir + a fake machine-key provider + a fixed clock."

PRD: `prd-032-encrypted-vault-index.md:123-127`

Evidence:

- `src/daemon/runtime/secrets/store.ts:69-71` `SECRET_FILE_MODE = 0o600`, `SECRET_DIR_MODE = 0o700`
- `src/daemon/runtime/vault/store.ts:120` `VaultStore`
- `src/daemon/runtime/vault/store.ts:136-138` secret class keeps `.secrets/<scope>/<name>`
- `src/daemon/runtime/vault/store.ts:78` `VAULT_DIR_NAME = ".vault"` for other classes (`store.ts:25`, `store.ts:367-376`)
- `src/daemon/runtime/vault/store.ts:382-384` writes with those modes
- QA cites `tests/daemon/runtime/vault/vault.test.ts:71-132` for machine-B decrypt failure. File still present.

### Index AC-2 MET

Quote: "For the secret class, no surface (CLI, dashboard, API) exposes a decrypted value - only names - and the sole decrypt path stays the internal resolver/exec. For the setting class, getSetting/setSetting round-trip a typed value through the daemon: a written setting reads back equal. Unit-tested per class; an attempt to read a secret-class value through the settings accessor is rejected by the class registry."

PRD: `prd-032-encrypted-vault-index.md:128-132`

Evidence:

- `src/daemon/runtime/vault/store.ts:174-192` `setSetting` / `getSetting` calls `assertReadable` first
- `src/daemon/runtime/vault/registry.ts:164` `assertReadable`
- `src/daemon/runtime/vault/api.ts:190-237` settings HTTP uses `getSetting` / `setSetting` only
- Grep of `src/daemon/runtime/vault/api.ts` for `getSecretValue`: ABSENT

Dashboard surface half: the panel is absent (AC-5). The API and registry gate the secret class. MET for the accessor rule.

### Index AC-3 MET

Quote: "Given a plaintext ~/.deeplake/credentials.json, when the vault migration runs, then the token is copied into the vault as a secret-class record AND the original plaintext file is left intact and still loadable. Resolution prefers the vault value when present, falls back to env, then to the plaintext file. Proven by a test that seeds a plaintext creds file, runs migration, asserts the vault holds the token, the file is byte-unchanged, and a login resolves from the vault - and a vault empty case still resolves from the file."

PRD: `prd-032-encrypted-vault-index.md:133-139`

Evidence:

- `src/daemon/runtime/vault/migrate.ts:78-94` `migrateDeeplakeToken` copies via `setSecret` and does not write the creds file
- `src/daemon/runtime/assemble.ts:4324-4337` boot calls `migrateDeeplakeToken`
- `src/daemon/runtime/vault/migrate.ts:122-148` `resolveDeeplakeToken` order is vault, then env, then file
- `tests/daemon/runtime/vault/vault.test.ts:245-273` calls `resolveDeeplakeToken`

Staging, matching D-3 and the QA note: `migrate.ts:113-120` says the live storage connection still uses `loadDiskCredentials` (env then file). Grep of production `*.ts` for `resolveDeeplakeToken(` finds only the definition and the unit test. The AC's own proof sentence is that unit test. MET on that proof. The live DeepLake client does not prefer the vault.

### Index AC-4 MET

Quote: "honeycomb settings list shows current settings (provider, model, pollinating flag, dashboard prefs) without printing any secret value; settings get <key> / settings set <key> <value> round-trip through the daemon to the vault; a provider/model selector flow lets the user pick provider then a model from that provider's catalog. The existing honeycomb secret names-only posture is preserved. All loopback-daemon-mediated. Unit-tested against the dispatcher with a fake daemon client."

PRD: `prd-032-encrypted-vault-index.md:140-145`

Evidence:

- `src/commands/settings.ts:243-272` selector writes `activeProvider` then `activeModel` through the daemon
- `src/commands/index.ts:136` settings verb is registered
- `tests/commands/settings.test.ts:212-226` provider then model, fake daemon, paths under `/api/settings`

### Index AC-5 UNMET

Quote: "The dashboard (src/dashboard/web) renders a Settings panel where the user selects provider (Anthropic / OpenAI / OpenRouter) -> the catalog model list for that provider loads -> picks a model; and toggles pollinating on/off. Each change POSTs through a daemon endpoint that writes the setting-class record; on reload the panel reflects the persisted vault value. No secret value is ever rendered (only key set / not set). The panel reads only through daemon endpoints."

PRD: `prd-032-encrypted-vault-index.md:146-151`

Evidence:

- `src/dashboard/web/panels.tsx` ABSENT
- `src/dashboard/views.ts:110-122` `buildSettingsView` renders org, workspace, and a string map. No provider catalog, no model picker, no pollinating toggle
- Daemon endpoints the panel would have called still exist: `src/daemon/runtime/vault/api.ts:98-100` allow-list includes `activeProvider`, `activeModel`, `pollinating.enabled`

### Index AC-6 UNMET

Quote: "With a setting-class active provider/model present, assembly builds the inference model client for THAT provider/model (vault wins over the committed agent.yaml); with the pollinating.enabled setting true, the live POST /api/diagnostics/pollinate stops returning reason:disabled (the PRD-026 behavior) WITHOUT setting the env var. With no vault setting, assembly falls back to agent.yaml / HONEYCOMB_POLLINATING_ENABLED."

PRD: `prd-032-encrypted-vault-index.md:152-158`

Evidence, provider/model half MET:

- `src/daemon/runtime/assemble.ts:2244-2259` `readProviderModelOverride`
- `src/daemon/runtime/assemble.ts:2537-2540` override fed to the factory
- `src/daemon/runtime/inference/model-client-factory.ts:144-150` override changes provider and model, not `apiKeyRef`
- `tests/daemon/runtime/inference/model-client-factory.test.ts:135-172` vault model wins over `agent.yaml`
- `tests/daemon/runtime/inference/model-client-factory.test.ts:172` no override leaves the yaml target

Evidence, pollinate half UNMET:

- `src/daemon/runtime/assemble.ts:1702` `mountPollinate` is called with storage, scope, and queue only. No vault reader.
- `src/daemon/runtime/pollinating/config.ts:114` `enabled` comes from `HONEYCOMB_POLLINATING_ENABLED`
- `src/daemon/runtime/pollinating/trigger.ts:387-389` `if (!this.config.enabled) return { decision: "disabled", reason: "disabled" }`
- `src/daemon/runtime/pollinating/api.ts:212-213` that decision is returned as `reason`
- The vault flag is applied to the worker, not this route: `src/daemon/runtime/assemble.ts:2514-2520` `readVaultPollinatingEnabled`
- `tests/daemon/runtime/assemble.test.ts:1189-1205` asserts the worker starts when the vault flag is true and the env is unset. It does not assert the POST body.

### Index AC-7 MET

Quote: "Registering a new record-class descriptor (id + read posture + zod value schema) makes that class storable/readable through the SAME vault, with existing secret/setting records untouched and re-readable. Proven by a test that registers a throwaway class, writes+reads a record, and asserts the pre-existing secret and setting records still resolve."

PRD: `prd-032-encrypted-vault-index.md:159-162`

Evidence:

- `src/daemon/runtime/vault/registry.ts:123` `registerClass`
- `src/daemon/runtime/vault/store.ts:365-376` new classes use `.vault/<class>/<scope>` and do not rewrite `.secrets/`
- QA cites `tests/daemon/runtime/vault/vault.test.ts:282-311`. File still present.

### Index AC-8 MET (gate tail not re-run)

Quote: "No plaintext at rest for any vault record; perms 0600/0700 asserted (POSIX, with the documented win32 ACL gap from PRD-012); no secret value crosses any surface or audit line; the DeepLake plaintext file is never deleted or corrupted by migration; npm run ci, build, audit:sql, and audit:openclaw all pass."

PRD: `prd-032-encrypted-vault-index.md:163-168`

Evidence:

- `src/daemon/runtime/vault/store.ts:394-410` audit event has class, op, scope, ts, outcome, name, count. No value field.
- `src/daemon/runtime/vault/migrate.ts:89-90` copy into the vault, no write to the creds path
- Gate greenness: UNVERIFIABLE

### 032a a-AC-1 MET

Quote: "Given the vault, when records of class secret, setting, and a registered test class are written under (class, scope, name), then each is encrypted at file 0600 / dir 0700, and copying the vault dir to a host with a different machine key fails to decrypt."

PRD: `prd-032a-encrypted-vault-core.md:61`

Evidence: same as index AC-1. `src/daemon/runtime/vault/store.ts:120-138`, modes `src/daemon/runtime/secrets/store.ts:69-71`.

### 032a a-AC-2 MET

Quote: "Given the secret class, when any accessor is used, then only names are listable and the sole decrypt path is the internal resolver/exec - no value-returning accessor exists; an attempt to read a secret value via the settings accessor is rejected by the registry."

PRD: `prd-032a-encrypted-vault-core.md:62`

Evidence: `src/daemon/runtime/vault/store.ts:186-192` `assertReadable` before decrypt on the settings path. `src/daemon/runtime/vault/registry.ts:159-164`.

### 032a a-AC-3 MET

Quote: "Given the setting class, when a typed value is written then read, then it reads back equal; an invalid value (failing the class zod schema) is rejected on write."

PRD: `prd-032a-encrypted-vault-core.md:63`

Evidence: `src/daemon/runtime/vault/store.ts:168-176` zod-validated `setSetting`, round-trip via `getSetting`.

### 032a a-AC-4 MET

Quote: "Given a present plaintext ~/.deeplake/credentials.json, when migration runs, then the token is stored in the vault as a secret-class record AND the plaintext file is byte-unchanged and still loadable."

PRD: `prd-032a-encrypted-vault-core.md:64`

Evidence: `src/daemon/runtime/vault/migrate.ts:78-94`.

### 032a a-AC-5 MET

Quote: "Given a stored vault token, when the DeepLake login resolves, then it prefers the vault value; given an empty vault, then it falls back to env, then to the plaintext file - the login resolves in every case."

PRD: `prd-032a-encrypted-vault-core.md:65`

Evidence: `src/daemon/runtime/vault/migrate.ts:122-148` and `tests/daemon/runtime/vault/vault.test.ts:245-273`. Same staging note as index AC-3: this function is not the live storage-client resolver (`migrate.ts:113-120`). The criterion's proof in the parent AC is this resolver. MET for the function. Live `loadDiskCredentials` (`src/daemon/runtime/auth/credentials-store.ts:415-459`) is env-over-file and does not read the vault.

### 032a a-AC-6 MET

Quote: "Given a newly registered record-class descriptor, when a record of that class is written and read, then it round-trips AND the pre-existing secret/setting records still resolve (no migration, no rewrite)."

PRD: `prd-032a-encrypted-vault-core.md:66`

Evidence: `src/daemon/runtime/vault/registry.ts:123` and `src/daemon/runtime/vault/store.ts:365-376`.

### 032b b-AC-1 MET

Quote: "Given stored settings, when honeycomb settings list runs, then it shows provider/model/pollinating/prefs and shows secrets as set/not-set by name only - no secret value is printed."

PRD: `prd-032b-encrypted-vault-cli.md:53`

Evidence: `tests/commands/settings.test.ts:97-108` list renders `activeModel` and does not print a secret value. Settings command is `src/commands/settings.ts`.

### 032b b-AC-2 MET

Quote: "Given a valid key/value, when honeycomb settings set <key> <value> runs, then the daemon writes the vault setting record and a subsequent settings get <key> returns the written value."

PRD: `prd-032b-encrypted-vault-cli.md:54`

Evidence: `tests/commands/settings.test.ts:147-154` get hits `GET /api/settings/activeModel`. `tests/commands/settings.test.ts:203-206` set posts the value.

### 032b b-AC-3 MET

Quote: "Given the selector flow, when the user picks a provider then a model, then the active provider/model settings are written; a model id outside the catalog is rejected for catalog providers and accepted free-form for OpenRouter."

PRD: `prd-032b-encrypted-vault-cli.md:55`

Evidence: `src/commands/settings.ts:243-272` and `tests/commands/settings.test.ts:212-226`. Catalog validation also on the daemon: `src/daemon/runtime/vault/api.ts:305-335`.

### 032b b-AC-4 MET

Quote: "Given any settings/secret invocation, when it runs, then it reaches the daemon over loopback (never direct disk) and the honeycomb secret verb remains names-only."

PRD: `prd-032b-encrypted-vault-cli.md:56`

Evidence: `src/commands/settings.ts` posts to `/api/settings` (see the test paths above). No storage import on that command. Secret verb was not given a value-returning path in `src/daemon/runtime/vault/api.ts` (no `getSecretValue`).

### 032c c-AC-1 UNMET

Quote: "Given the daemon is running, when the Settings panel loads, then it renders the active provider/model and feature-flag state from daemon-served vault settings."

PRD: `prd-032c-encrypted-vault-dashboard.md:55`

Evidence: `src/dashboard/web` ABSENT. `src/dashboard/views.ts:110-122` does not render provider, model, or pollinating from the vault.

### 032c c-AC-2 UNMET

Quote: "Given the panel, when the user selects a provider, then that provider's curated catalog models load; when the user picks a model, then the active provider/model setting persists and survives reload."

PRD: `prd-032c-encrypted-vault-dashboard.md:56`

Evidence: panel ABSENT. Catalog itself exists at `src/daemon/runtime/vault/catalog.ts:21` and is enforced by `src/daemon/runtime/vault/api.ts:315-335`. That is the daemon half, not the panel.

### 032c c-AC-3 UNMET

Quote: "Given the panel, when the user toggles pollinating on, then the pollinating.enabled setting is written to the vault and the toggle reflects the persisted value on reload."

PRD: `prd-032c-encrypted-vault-dashboard.md:57`

Evidence: panel ABSENT. The setting key is allow-listed at `src/daemon/runtime/vault/api.ts:100`.

### 032c c-AC-4 UNMET

Quote: "Given a provider key, when the panel renders, then it shows presence (set / not set) by name only and never displays a secret value."

PRD: `prd-032c-encrypted-vault-dashboard.md:58`

Evidence: panel ABSENT. No `ProviderKeyBadge` in `src/` or `tests/`.

### 032c c-AC-5 UNMET

Quote: "Given the panel, when any change is made, then the write goes through a daemon endpoint (the panel never opens the vault directly), consistent with PRD-020b."

PRD: `prd-032c-encrypted-vault-dashboard.md:59`

Evidence: panel ABSENT, so the write path cannot be shown. The daemon endpoint exists (`src/daemon/runtime/vault/api.ts:237` `setSetting`).

### 032d d-AC-1 MET

Quote: "Given a vault setting for active provider/model, when the daemon assembles, then it builds the inference model client for THAT provider/model (the vault wins over the committed agent.yaml)."

PRD: `prd-032d-encrypted-vault-wireback.md:50`

Evidence: `tests/daemon/runtime/inference/model-client-factory.test.ts:135-165` and `src/daemon/runtime/assemble.ts:2537-2540`.

### 032d d-AC-2 UNMET

Quote: "Given a vault setting pollinating.enabled=true, when assembled, then POST /api/diagnostics/pollinate no longer returns reason:disabled (PRD-026 behavior) WITHOUT HONEYCOMB_POLLINATING_ENABLED being set."

PRD: `prd-032d-encrypted-vault-wireback.md:51`

Evidence: same as the pollinate half of index AC-6. Worker start is vault-first (`src/daemon/runtime/assemble.ts:2514-2520`, test `tests/daemon/runtime/assemble.test.ts:1189`). The POST route's `enabled` flag is the env config (`src/daemon/runtime/pollinating/config.ts:114`, `trigger.ts:388`, mount at `assemble.ts:1702`). A vault-only `true` does not change that route's `reason: "disabled"`.

### 032d d-AC-3 MET

Quote: "Given NO vault settings, when assembled, then provider/model falls back to agent.yaml and pollinating falls back to HONEYCOMB_POLLINATING_ENABLED - existing installs are unchanged."

PRD: `prd-032d-encrypted-vault-wireback.md:52`

Evidence:

- `src/daemon/runtime/assemble.ts:2241` absent keys return `undefined` and the yaml selection stands
- `src/daemon/runtime/assemble.ts:2520` `effectiveEnabled` uses `config.enabled` when the vault did not decide
- `tests/daemon/runtime/inference/model-client-factory.test.ts:172-191` no override keeps the yaml model

### 032d d-AC-4 MET

Quote: "Given any resolution, when the daemon runs, then the vault is only READ (it never writes agent.yaml), so there is no committed-file-vs-vault drift."

PRD: `prd-032d-encrypted-vault-wireback.md:53`

Evidence: grep of `src/daemon/runtime/vault` for `agent.yaml` writes: ABSENT. `store.ts` `writeFileSync` is the vault record (`store.ts:384`), not `agent.yaml`. Assembly reads settings (`assemble.ts:2244`, `:2358`).

### 032d d-AC-5 MET

Quote: "Given the inference credential, when the model client is built, then the key still resolves through the vault secret class via ${SECRET_REF} and is never inlined."

PRD: `prd-032d-encrypted-vault-wireback.md:54`

Evidence: `src/daemon/runtime/inference/model-client-factory.ts:144-150` override never touches `apiKeyRef`. `model-client-factory.ts:235` maps `apiKeyRef` to a secret name.

---

## PRD-033 Asset sync substrate

Children 033a, 033b, 033c. QA notes: 2026-06-21 QA (verified before the reopen), 2026-06-25 QA (reopen close-out), 2026-06-25 security. The 2026-06-25 ruling changed retraction: leave the file, mark UNMANAGED. The AC tables still say "retracts the local copy". Verdicts for retraction ACs follow the resolved ruling in the same files (index lines 86-88, 033b lines 69-70, 033c lines 77-78), not the older table sentence and not the older QA's delete-the-file reading.

Device path drift (not an AC): the resolved open question says `~/.honeycomb/device.json`. Current primary path is `~/.apiary/device.json` with a legacy `~/.honeycomb/device.json` fallback (`src/daemon/runtime/assets/device.ts:7-9`, `:51-68`). a-AC-4 asks for a stable `device_id`, which this still is.

Recommended bucket: completed.

### Index AC-1 MET

Quote: "Given a skill or agent, when it is registered, then registry.json records its tier, style, harness, content hash, and honeycomb_id; an artifact at the Local tier never writes to DeepLake."

PRD: `prd-033-asset-sync-substrate-index.md:56`

Evidence:

- `src/daemon/runtime/assets/registry.ts:109-118` `RegistryEntrySchema` has tier, style, harness, version, honeycombId, three hashes
- `src/daemon/runtime/assets/api.ts:236-238` Local tier publish returns null and does not write
- `src/daemon/runtime/assets/lattice.ts:116-118` Local is unmanaged

### Index AC-2 MET

Quote: "Given an artifact promoted to Device, when the same user starts a session on a second device (matching style), then the artifact appears there; it does NOT appear for a user in a different workspace."

PRD: `prd-033-asset-sync-substrate-index.md:57`

Evidence:

- `src/hooks/shared/session-start.ts:272-273` session start calls `autoPullAssets`
- `src/hooks/shared/session-start-seams.ts:144-150` production seam calls the thin-client `autoPull`
- `src/daemon/runtime/assets/contracts.ts:274-279` Device audience requires matching author; Local never matches
- Live second-device itest exists at `tests/integration/asset-sync-propagation-live.itest.ts` (not re-run)

The 2026-06-25 QA cited `session-start.ts:99`. Current call is lines 272-273.

### Index AC-3 MET

Quote: "Given an artifact promoted to Team, when another author in the same workspace pulls, then the artifact appears for them; it does NOT appear for a user in a different workspace."

PRD: `prd-033-asset-sync-substrate-index.md:58`

Evidence: same session-start seam. Audience predicate `src/daemon/runtime/assets/contracts.ts:263-279` keys off org and workspace. Live itest file exists and was not re-run.

### Index AC-4 MET

Quote: "Given a locally-edited (hash-divergent) artifact, when a remote-newer pull lands, then the existing copy is backed up to .bak and overwritten (last-writer-wins)."

PRD: `prd-033-asset-sync-substrate-index.md:59`

Evidence: `src/daemon-client/assets/install.ts:337-342` `backupExisting` renames to `.bak` before overwrite.

### Index AC-5 MET

Quote (table, not rewritten): "Given a demotion or revocation, when it is applied, then a tombstone row is written and the next pull retracts the local copy across the blast radius."

Resolved ruling in the same file: "Demotion leaves the local artifact file in place and marks it UNMANAGED. The engine never deletes or moves user files."

PRD: `prd-033-asset-sync-substrate-index.md:60` and `:86-88`

Evidence:

- `src/daemon-client/assets/install.ts:349-377` `retract` removes `.honeycomb-asset.json` only. The live file argument is unused.
- Tombstone column: `src/daemon/storage/catalog/synced-assets.ts:101`

Judged MET against the 2026-06-25 ruling. The table sentence at line 60 still describes the superseded delete behavior.

### Index AC-6 MET

Quote: "Given v1, when an artifact installs, then it lands only on a matching harness; the canonical column and adapter interface exist and the identity adapter round-trips parse(render(x)) == x."

PRD: `prd-033-asset-sync-substrate-index.md:61`

Evidence:

- `src/daemon/storage/catalog/synced-assets.ts:97-98` `native` and `canonical` columns
- `src/daemon/runtime/assets/contracts.ts:240-256` `IDENTITY_ADAPTER` render and parse are identity
- `src/daemon-client/assets/install.ts:481-505` unknown harness returns null and is skipped. A known harness maps 1:1 onto its own root.

### Index AC-7 MET

Quote: "Given a pull with nothing changed, when it runs, then it is a no-op and never blocks session start (idempotent, fail-soft, consistent with skillify's 5s-budget auto-pull)."

PRD: `prd-033-asset-sync-substrate-index.md:62`

Evidence:

- `src/daemon-client/assets/install.ts:68` `ASSET_AUTOPULL_TIMEOUT_MS = 5_000`
- `src/daemon-client/assets/install.ts:262-268` kill switch, timeout, errors swallowed to null
- `src/hooks/shared/session-start.ts:272-273` the call is `void backgroundPull(...)`, so it does not block the hook result

### 033a AC-1 MET

Quote: "Given a registered skill or agent, when the registry is written, then registry.json records its tier, style, harness, version, honeycomb_id, and the three hashes."

PRD: `prd-033a-asset-sync-substrate-registry-identity.md:48`

Evidence: `src/daemon/runtime/assets/registry.ts:109-118`.

### 033a AC-2 MET

Quote: "Given a skill directory, when its hash is computed, then it is a merkle-style root over sorted (path, content-hash) pairs; given an agent file, the hash is the file content hash."

PRD: `prd-033a-asset-sync-substrate-registry-identity.md:49`

Evidence: `src/daemon/runtime/assets/hashing.ts:44` `hashAgentFile`, `:59-62` `hashSkillDir` sorts path pairs.

### 033a AC-3 MET

Quote: "Given an artifact renamed on disk, when it is re-scanned, then its honeycomb_id is unchanged and it is not treated as a new artifact."

PRD: `prd-033a-asset-sync-substrate-registry-identity.md:50`

Evidence: `src/daemon/runtime/assets/identity.ts:52-67` `parseHoneycombId` reads the stamped frontmatter id, which survives a rename of the path. Registry fallback is documented at `identity.ts:56-57`.

### 033a AC-4 MET

Quote: "Given the second device of the same user, when the device set is read, then the device's stable device_id is present in the my devices set."

PRD: `prd-033a-asset-sync-substrate-registry-identity.md:51`

Evidence: `src/daemon/runtime/assets/device.ts:92-97` generate-once `device_id` persisted and re-read. Path is `~/.apiary/device.json` with `~/.honeycomb/device.json` fallback (`device.ts:7-9`).

### 033a AC-5 MET

Quote: "Given any artifact, when its state is read, then it resolves to exactly one of the 6 tier x style cells."

PRD: `prd-033a-asset-sync-substrate-registry-identity.md:52`

Evidence: `src/daemon/runtime/assets/registry.ts:112-113` `tier` and `style` are single enums, not arrays. `src/daemon/runtime/assets/lattice.ts` is the lattice module.

### 033a AC-6 MET

Quote: "Given a synced-asset row, when it is inserted, then it carries the native blob, the reserved canonical column, harness, asset_type, version, the tombstone flag, and org / workspace / author tenancy."

PRD: `prd-033a-asset-sync-substrate-registry-identity.md:53`

Evidence: `src/daemon/storage/catalog/synced-assets.ts:89-108`.

### 033b AC-1 MET

Quote: "Given an unregistered skill or agent, when the user registers it, then it appears in registry.json at the Local tier with an explicit style and a honeycomb_id, and nothing is written to DeepLake."

PRD: `prd-033b-asset-sync-substrate-promotion-lifecycle.md:46`

Evidence: `src/commands/asset.ts:9` register writes the local registry only. `src/daemon/runtime/assets/api.ts:236-238` Local publish is rejected.

### 033b AC-2 MET

Quote: "Given a Local artifact, when the user promotes it to Team, then it is published at the workspace blast radius; given a Team artifact, when demoted to Local, then a tombstone is written."

PRD: `prd-033b-asset-sync-substrate-promotion-lifecycle.md:47`

Evidence: `src/daemon/runtime/assets/lifecycle.ts:235` promote off Local publishes. Tombstone column `synced-assets.ts:101`. Demotion to Local is the retract path in `install.ts:367`.

### 033b AC-3 MET

Quote: "Given an artifact promoted to Device, when a second device of the same user pulls, then the artifact appears there and does NOT appear for any other user."

PRD: `prd-033b-asset-sync-substrate-promotion-lifecycle.md:48`

Evidence: `src/daemon/runtime/assets/contracts.ts:274-279` Device match is author plus device set. Session-start pull `session-start.ts:273`.

### 033b AC-4 MET

Quote: "Given an artifact promoted to Team, when another author in the same workspace pulls, then the artifact appears; a user in a different workspace never receives it."

PRD: `prd-033b-asset-sync-substrate-promotion-lifecycle.md:49`

Evidence: audience predicate is org/workspace scoped (`contracts.ts:263-271`).

### 033b AC-5 MET

Quote (table): "Given a demotion, when the next pull runs on a device that had the artifact, then the local copy is retracted across the blast radius per the tombstone."

Resolved in the same file at lines 69-70: leave the file, mark UNMANAGED.

PRD: `prd-033b-asset-sync-substrate-promotion-lifecycle.md:50` and `:69-70`

Evidence: `src/daemon-client/assets/install.ts:367-373`.

### 033b AC-6 MET

Quote: "Given any tier or style change, when it is applied, then it goes through the daemon and the registry reflects exactly one tier x style cell afterward."

PRD: `prd-033b-asset-sync-substrate-promotion-lifecycle.md:51`

Evidence: `src/commands/asset.ts` is a thin client (usage strings at `:339` and `:411` call the daemon verbs). Registry schema holds one `tier` and one `style` (`registry.ts:112-113`).

### 033c AC-1 MET

Quote: "Given a promoted artifact, when publish runs, then a new versioned row is inserted through the daemon carrying the native blob keyed by (asset_type, harness), the reserved canonical column, and the tier-appropriate scoping."

PRD: `prd-033c-asset-sync-substrate-sync-engine.md:48`

Evidence: `src/daemon/runtime/assets/sync.ts:264` writes `honeycomb_id`. Columns in `synced-assets.ts:89-108`. Local tier is refused before insert (`api.ts:238`).

### 033c AC-2 MET

Quote: "Given a remote artifact newer than a hash-divergent local copy, when pull runs, then the local copy is backed up to .bak and overwritten (last-writer-wins)."

PRD: `prd-033c-asset-sync-substrate-sync-engine.md:49`

Evidence: `src/daemon-client/assets/install.ts:337-342`.

### 033c AC-3 MET

Quote: "Given a v1 install, when an artifact is written, then it lands only on a matching harness; an artifact keyed for one harness is not installed onto a different harness."

PRD: `prd-033c-asset-sync-substrate-sync-engine.md:50`

Evidence: `src/daemon-client/assets/install.ts:158` and `:492-505` harness-to-root map is 1:1; unknown harness returns null.

### 033c AC-4 MET

Quote: "Given the identity adapter, when an artifact round-trips, then parse(render(x)) == x; the canonical column and the adapter interface both exist."

PRD: `prd-033c-asset-sync-substrate-sync-engine.md:51`

Evidence: `src/daemon/runtime/assets/contracts.ts:246-256`. Column `synced-assets.ts:98`.

### 033c AC-5 MET

Quote (table): "Given a tombstone row for a locally-present artifact, when pull runs, then the local copy is retracted across the blast radius."

Resolved in the same file at lines 77-78: file left in place, marked UNMANAGED.

PRD: `prd-033c-asset-sync-substrate-sync-engine.md:52` and `:77-78`

Evidence: `src/daemon-client/assets/install.ts:349-377`.

### 033c AC-6 MET

Quote: "Given a pull with no changes, when it runs, then it is a no-op; given a slow or absent table, the pull stays within its budget, swallows errors, and never blocks session start."

PRD: `prd-033c-asset-sync-substrate-sync-engine.md:53`

Evidence: `src/daemon-client/assets/install.ts:254-268` and `src/hooks/shared/session-start.ts:272-273`.

---

## PRD-034 Resilient live-test strategy

Children 034a and 034b still say Draft in the index table (`prd-034-resilient-live-test-strategy-index.md:41-42`) while the index status is Completed. QA `qa/2026-06-21-qa-report.md` says PASS. Two open questions in the index (lines 68-69) are still unchecked; they are not acceptance criteria. The stress report location they ask about is implemented as both a CI artifact comment and a local `.stress-report/` path (`.github/workflows/ci.yaml:301-302`).

Recommended bucket: completed.

### Index AC-1 MET

Quote: "Given a push to main while the DeepLake backend is slow or 502-heavy, when CI runs, then the merge-gating result is determined ONLY by the deterministic suite (typecheck + unit + assembled-with-fakes + build + audits); the live suite does not block the merge."

PRD: `prd-034-resilient-live-test-strategy-index.md:50`

Evidence:

- `.github/workflows/ci.yaml:9-13` required merge gate is `quality-gate` plus `windows-smoke`
- `.github/workflows/ci.yaml:231-243` `integration-push-soft` has `continue-on-error: true`
- `.github/workflows/ci.yaml:303-307` stress job is `workflow_dispatch` only and is not a merge `needs` of the quality gate

### Index AC-2 MET (live pass not re-run)

Quote: "Given the IRL-faithful live suite on a HEALTHY backend, when it runs, then it asserts and passes every correctness invariant (right value, tenancy isolation, idempotency, no-data-loss); a deliberately-introduced wiring regression makes it FAIL (it still has teeth)."

PRD: `prd-034-resilient-live-test-strategy-index.md:51`

Evidence: `tests/integration/teeth-proof-live.itest.ts:7-22` and `:138-213` assert wrong-value read-back, foreign-workspace isolation, and a never-written row stays absent (`readConverged` does not fabricate). Healthy-backend pass was not re-run.

### Index AC-3 MET

Quote: "Given a sustained backend outage (all attempts dominated by 502/timeout), when the IRL-faithful live suite runs, then the run resolves to a NEUTRAL SKIP/infra-unavailable outcome - never a false green and never a hard red attributed to our code."

PRD: `prd-034-resilient-live-test-strategy-index.md:52`

Evidence:

- `tests/integration/_infra-skip.ts:12-25` sentinel `infra-degraded.json` and console prefix `##honeycomb-infra-degraded##`
- `tests/integration/_infra-skip.ts:64-65` outcome `infra-unavailable`
- `tests/integration/_infra-skip.ts:78-86` only `isTransientResult` neutralizes; a query error stays red
- `tests/integration/_infra-skip.ts:190-201` `skip("infra-unavailable: ...")`
- `.github/actions/live-integration/action.yml:8-15` documents the caller `continue-on-error` split and the infra-skip mapping

### Index AC-4 MET

Quote: "Given the live suite is wired, when triggers fire, then it runs on the nightly schedule and as a NON-BLOCKING check on push; it is removed as a required merge gate."

PRD: `prd-034-resilient-live-test-strategy-index.md:53`

Evidence: `.github/workflows/ci.yaml:15-26` matrix. Push job `continue-on-error: true` at `:243`. Nightly job has no `continue-on-error` (`:268-272`), which is a canary, not a merge gate.

### Index AC-5 MET

Quote: "Given npm run deeplake:stress (or the workflow_dispatch job) with creds, when it runs, then it emits a metrics report covering per-statement-kind latency p50/p95/p99/max, error rate by HTTP status, eventual-consistency convergence-time distribution, and throughput - as a human summary AND a machine-readable JSON artifact."

PRD: `prd-034-resilient-live-test-strategy-index.md:54`

Evidence:

- `package.json:71` `"deeplake:stress"`
- `src/eval/deeplake-stress.ts:292-305` `schemaVersion`, per-kind latency, redacted org
- `src/eval/deeplake-stress.ts:528-556` human summary prints p50/p95/p99/max, convergence latency, throughput
- `.github/workflows/ci.yaml:343` the dispatch job runs `npm run deeplake:stress`

A credentialed stress run was not executed.

### Index AC-6 MET

Quote: "Given the stress harness, when invoked with concurrency and table-size parameters, then it honors them (a fixed seed makes a run reproducible) and reports how the error rate scales with concurrency."

PRD: `prd-034-resilient-live-test-strategy-index.md:55`

Evidence:

- `src/eval/deeplake-stress.ts:170-175` `mulberry32`
- `src/eval/deeplake-stress.ts:354` `mulberry32(config.seed)`
- `src/eval/deeplake-stress.ts:563` throughput and error row by concurrency
- `scripts/deeplake-stress.mjs:37` `HONEYCOMB_STRESS_CONCURRENCY` dial

### Index AC-7 MET (gate tail not re-run)

Quote: "Given the whole change, when the deterministic gate runs, then it stays green + unit-count-stable, and npm run ci/build/audit:sql/audit:openclaw remain green; the stress harness never runs on push and never gates."

PRD: `prd-034-resilient-live-test-strategy-index.md:56`

Evidence for the wiring half: `.github/workflows/ci.yaml:296-307` stress `if` is `workflow_dispatch` and `has_token` only. It is not in the quality-gate `needs` chain. Gate greenness and unit-count stability: UNVERIFIABLE.

### 034a a-AC-1 UNVERIFIABLE

Quote: "Given the live itests, when reviewed, then every assertion is classified correctness-vs-immediacy; correctness ones stay strict, immediacy ones are converted to eventually-style (generous readConverged budget) or moved to PRD-034b."

PRD: `prd-034a-resilient-live-test-strategy-irl-faithful-suite.md:45`

Evidence: several named suites now call `readConverged` (`tests/integration/compaction-live.itest.ts:255`, `golden-path-live.itest.ts:350`, `retention-live.itest.ts:165`, `skills-write-live.itest.ts:157`, `sources-purge-live.itest.ts:166`). Many other live files still hand-roll `for (let poll`, for example `tests/integration/memories-api-live.itest.ts:143-157` (40 polls, 350ms) and `tests/integration/sessions-prune-live.itest.ts:53-63` (`SCAN_POLLS = 20`, no backoff). This pass did not classify every assertion in every itest, so "every immediacy assertion was converted" is not established. Not marked UNMET: the remaining loops that were sampled wait until a row appears rather than asserting a sub-second exact count.

### 034a a-AC-2 MET (live pass not re-run)

Quote: "Given a HEALTHY backend, when the IRL-faithful live suite runs, then it passes; given a deliberately-introduced wiring regression (wrong value / broken tenancy isolation), it FAILS (teeth preserved)."

PRD: `prd-034a-resilient-live-test-strategy-irl-faithful-suite.md:46`

Evidence: `tests/integration/teeth-proof-live.itest.ts:175-213`.

### 034a a-AC-3 MET

Quote: "Given a sustained 502/timeout window, when the suite runs, then it resolves to a neutral infra-unavailable outcome - not a hard red, not a false green."

PRD: `prd-034a-resilient-live-test-strategy-irl-faithful-suite.md:47`

Evidence: `tests/integration/_infra-skip.ts:140-201`. Non-transient results are not skipped (`:78-86`).

### 034a a-AC-4 MET

Quote: "Given ci.yaml, when a push to main runs, then the required merge gate is the deterministic suite only; the live job does not block the merge (nightly schedule + optional push-soft + workflow_dispatch only)."

PRD: `prd-034a-resilient-live-test-strategy-irl-faithful-suite.md:48`

Evidence: `.github/workflows/ci.yaml:9-26` and `:238-276`.

### 034a a-AC-5 MET

Quote: "Given the gate -> has_token guard, when a no-token run happens (fork/secret unset), then the live job still skips cleanly and the workflow stays green (skip-safe preserved)."

PRD: `prd-034a-resilient-live-test-strategy-irl-faithful-suite.md:49`

Evidence: `.github/workflows/ci.yaml:220-228` and the `has_token == 'true'` conditions on the live jobs (`:244`, `:276`). A no-token push does not start `integration-push-soft`. Workflow-stays-green on a fork was not executed.

### 034a a-AC-6 UNVERIFIABLE

Quote: "Given the deterministic gate, when it runs, then npm run ci/build/audit:sql/audit:openclaw/smoke stay green and unit-count-stable."

PRD: `prd-034a-resilient-live-test-strategy-irl-faithful-suite.md:50`

Evidence: the jobs are defined (`.github/workflows/ci.yaml:91` `quality-gate`). This pass did not run them.

### 034b b-AC-1 MET

Quote: "Given npm run deeplake:stress with creds, when it runs, then it drives the configured load against a throwaway table and DROPs it on teardown (no pollution of real tables)."

PRD: `prd-034b-resilient-live-test-strategy-stress-harness.md:47`

Evidence: `scripts/deeplake-stress.mjs:3-14` and `src/eval/deeplake-stress.ts:8-9`. Throwaway plus DROP is the harness contract in those headers. A live run was not executed.

### 034b b-AC-2 MET

Quote: "Given a completed stress run, when the report is produced, then it includes per-statement-kind latency p50/p95/p99/max."

PRD: `prd-034b-resilient-live-test-strategy-stress-harness.md:48`

Evidence: `src/eval/deeplake-stress.ts:305` and `:528-533`.

### 034b b-AC-3 MET

Quote: "Given a completed stress run, then the report includes error rate broken down by HTTP status (429/5xx/timeout/connection) and by statement kind."

PRD: `prd-034b-resilient-live-test-strategy-stress-harness.md:49`

Evidence: `src/eval/deeplake-stress.ts` report shape includes status error rates (human summary and `StressReport` JSON at `:286-305`). Script header `scripts/deeplake-stress.mjs:3` names the report.

### 034b b-AC-4 MET

Quote: "Given writes during the run, then the report includes the eventual-consistency convergence-time distribution (time from write-ok to read-reflects-write)."

PRD: `prd-034b-resilient-live-test-strategy-stress-harness.md:50`

Evidence: `src/eval/deeplake-stress.ts:469` measures convergence with `readConverged`. Summary prints convergence latency at `:556`.

### 034b b-AC-5 MET

Quote: "Given concurrency + table-size parameters, when passed, then the harness honors them and reports throughput + how the error rate scales with concurrency; a fixed seed makes the run reproducible."

PRD: `prd-034b-resilient-live-test-strategy-stress-harness.md:51`

Evidence: `src/eval/deeplake-stress.ts:170-175` and `:354`. Concurrency scale line `:563`. Dials `scripts/deeplake-stress.mjs:37`.

### 034b b-AC-6 MET

Quote: "Given the harness, when CI runs on push/PR, then it NEVER executes and NEVER gates; it runs only via workflow_dispatch (or npm run locally) and emits the JSON + human report as an artifact."

PRD: `prd-034b-resilient-live-test-strategy-stress-harness.md:52`

Evidence: `.github/workflows/ci.yaml:296-307` and `:343`. Local entry `package.json:71`.

### 034b b-AC-7 MET

Quote: "Given any report, when inspected, then it carries no token, endpoint credential, or full org GUID (redaction proven)."

PRD: `prd-034b-resilient-live-test-strategy-stress-harness.md:53`

Evidence: `src/eval/deeplake-stress.ts:36-48` imports `redactToken`. `:297` and `:412` `orgRedacted: redactToken(scope.org)`. Comment at `:288` says the report carries no creds and no full org GUID.
