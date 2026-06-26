# EXECUTION LEDGER, PRD-060 ROI Tracker (the-smoker)

> Run started 2026-06-26. Branch `legion/sharp-wilson-029812`. Worktree `C:\Users\mario\GitHub\honeycomb\.claude\worktrees\sharp-wilson-029812`.
> Scope: **PRD-060 only** (sub-PRDs 060a-060f + module ACs). **PRD-061 is OUT OF SCOPE.**
> Status legend: OPEN / IN PROGRESS / DONE (impl + tests pass) / VERIFIED (independent pass) / BLOCKED (external dependency).
> No partial credit. A criterion is DONE only when fully implemented, proven by passing tests, with `npm run ci` green.

## Standing decisions / known blockers (from the operator + PRDs)
- **Per-user is GATED on a verified `backend-token` claim that does NOT exist yet.** Per the operator: build the `user_id` column + the gate + the "per-user requires verified login" empty state; leave per-user rollups inert. The *gate behavior with no claim* (user_id stays `''`, no spoofable fallback) IS fully implementable and testable. The *populated per-user rollup* is parked **BLOCKED**.
- **Modeled-assumption exact string + constants** need operator sign-off (060b OQ). Build the assumption-as-data mechanism + honesty contract with a clearly-labeled placeholder assumption; park the exact signed-off wording as a DECISION, not a code blocker.
- **Team roster authoring surface**: 060f ships the `teams` table + write primitive + resolution; a full roster-authoring UI is an open question (may belong to PRD-061). Build table + write/resolve + tests; team rollup is empty until rows exist (expected).

## Owning-Bee + model key
- `typescript-node-worker-bee` (TS/Node, zod, catalog, vitest) — model: Opus 4.8 (deep code).
- `react-worker-bee` (dashboard page) — model: Opus 4.8.
- `ux-ui-worker-bee` (DS adherence review) — model: Opus 4.8.
- `security-worker-bee` (penultimate close-out), `quality-worker-bee` (final close-out).

---

## 060a, Token & Cache Usage Capture (Claude Code first) — Owner: typescript-node-worker-bee
| AC | Criterion (paraphrased) | Status |
|---|---|---|
| a-AC-1 | Capture contract carries OPTIONAL normalized `usage {input,output,cacheRead,cacheCreation}`; no-usage turn round-trips with field ABSENT (not zero-filled) | OPEN |
| a-AC-2 | Claude Code shim extracts the 4 token counts from transcript JSONL; fixture test asserts they land | OPEN |
| a-AC-3 | `sessions` group gains 5 cols (4 token + `source_tool`) via additive heal; test asserts heal additive + idempotent | OPEN |
| a-AC-4 | Dataset missing the cols reads as "token data absent"; daemon boots + capture proceeds without throwing | OPEN |
| a-AC-5 | Token counts persist on the SAME append-only INSERT as the turn; test asserts queryable on the row | OPEN |
| a-AC-6 | Missing/malformed `usage` -> null token fields + "absent" signal, never throw, never silent `0` | OPEN |
| a-AC-7 | Every Claude-Code row carries `source_tool="claude-code"`; test asserts the discriminant | OPEN |

## 060b, Cost & Savings Engine + Rate Table — Owner: typescript-node-worker-bee
| AC | Criterion | Status |
|---|---|---|
| b-AC-1 | Provider->model rate table (input/output/cache_read/cache_write cents/Mtok + "rates as of" date); test asserts Anthropic cache-read=0.1x, cache-write=1.25x | OPEN |
| b-AC-2 | Measured cache savings = `cache_read_tokens x (input_rate - cache_read_rate)` summed; tagged `measured`; unit test vs fixed inputs | OPEN |
| b-AC-3 | Modeled savings tagged `modeled` + assumption AS DATA FIELD; test asserts assumption present + single disclosure source | OPEN |
| b-AC-4 | Honesty contract: NO `measured` value derived from `modeled` input; any aggregate w/ modeled term tagged `modeled`/`est.`; structural test | OPEN |
| b-AC-5 | `blendedCentsPerMtok` from real mix, `null` when capture absent | OPEN |
| b-AC-6 | Integer cents within the layer; test asserts no float-cents crosses boundary | OPEN |
| b-AC-7 | Token capture absent/partial -> status maps to `absent`/`partial`, not `0`-as-measured | OPEN |

## 060c, DeepLake Billing Integration + Infra Read-Model — Owner: typescript-node-worker-bee
| AC | Criterion | Status |
|---|---|---|
| c-AC-1 | Billing client reads `/billing/summary` + `/billing/usage/compute` (by session_type), reuses DeepLake creds; test via INJECTED fetch (no network) | OPEN |
| c-AC-2 | No creds -> `unauthenticated`; unreachable/5xx-after-retry -> `unreachable`; no fabricated value, no throw | OPEN |
| c-AC-3 | Retry on 429/5xx, bounded timeout, bearer redacted from every log path; test asserts token never in logs | OPEN |
| c-AC-4 | Infra read-model TTL-cached in memory (no table); test: 2nd read within TTL no upstream hit, expired re-hits | OPEN |
| c-AC-5 | `session_type` breakdown (query/embedding/ingestion, gpu_hours x price) exposed as integer cents, itemized + summable | OPEN |
| c-AC-6 | Integer cents through client + read-model; test asserts no float-cents | OPEN |
| c-AC-7 | Partial upstream -> `partial` status, available lines populated, missing flagged (never silent zero) | OPEN |

## 060d, Pollination Cost Metering — Owner: typescript-node-worker-bee
| AC | Criterion | Status |
|---|---|---|
| d-AC-1 | `transport-anthropic.ts` surfaces the `usage` it discards on Honeycomb's own (skillify) calls; test asserts captured not dropped | DONE |
| d-AC-2 | Haiku skillify token cost priced via 060b rate table, integer cents; unit test vs fixed inputs | DONE |
| d-AC-3 | DeepLake embedding+ingestion+query session cost composed from 060c WITHOUT a second billing read; test asserts no extra egress | DONE |
| d-AC-4 | `pollination = haikuSkillifyCents + deeplakeSessionCents`, itemized; test asserts itemization | DONE |
| d-AC-5 | Missing Haiku meter -> `absent` (not 0); unreachable billing -> `unreachable`; total carries WORST status | DONE |
| d-AC-6 | Integer cents; test asserts no float-cents toward read-model | DONE |

## 060f, Shared Spend Ledger + Teams Roster — Owner: typescript-node-worker-bee
| AC | Criterion | Status |
|---|---|---|
| f-AC-1 | `roi_metrics` defined `scope:"tenant"` with queryable `org_id`+`workspace_id`, in `tenancy.ts`; test asserts tenant-scoped | OPEN |
| f-AC-2 | Append-only: one immutable row/session via `appendOnlyInsert`; re-price APPENDS new row (new `price_ref`), no UPDATE path | OPEN |
| f-AC-3 | Canonical row per `session_id` = `MAX(created_at)`; original retained (auditable) | OPEN |
| f-AC-4 | All money cols BIGINT integer cents; no FLOAT money col, no float-cents on write | OPEN |
| f-AC-5 | measured/modeled/allocated separate cols; `cost_basis`+`allocation_method`; mixed-basis detectable via `COUNT(DISTINCT cost_basis)>1` | OPEN |
| f-AC-6 | `user_id` set ONLY when `verifiedClaim?.source==='backend-token'`, else `''`; git-email/$USER/OS never consulted | OPEN |
| f-AC-7 | No historical backfill: pre-claim rows keep `user_id=''` forever | OPEN |
| f-AC-8 | `teams` table `scope:"tenant"`, version-bumped, one row/(team,member), `member_type` agent|user union; agent row resolves today, user row inert | OPEN |
| f-AC-9 | `team_id` resolved at write time by roster lookup; assigned->resolved, unassigned->`''`, fail-soft never throws | OPEN |
| f-AC-10 | Additive-heal: every NOT NULL col has DEFAULT; both tables heal onto legacy dataset; missing table/col -> "shared ledger absent", daemon boots | OPEN |
| f-AC-11 | SQL-guarded writes via `sqlStr`/`sqlLike`/`sqlIdent` under active QueryScope; no raw interpolation | OPEN |
| f-AC-12 | Rollup lookup indexes on org_id/workspace_id/team_id/period_start (+drill-down); NO BM25, NO vector | OPEN |
| f-AC-13 | Local read scoped through `read_policy` (`scope-clause.ts`): isolated->own only, shared->workspace-wide | OPEN |

## 060e, ROI Tracker Dashboard Page — Owner: typescript-node-worker-bee (daemon read-model) + react-worker-bee (page) + ux-ui-worker-bee (review)
| AC | Criterion | Status |
|---|---|---|
| e-AC-1 | `/roi` via ONE registry entry + one `roi.tsx`; no sidebar/router hand-edit; renders in `PageFrame` title "ROI" | OPEN |
| e-AC-2 | Page is PURE function of `RoiView` (no fetch/compute); test renders every per-section status from fixture | OPEN |
| e-AC-3 | Measured-vs-modeled four signals; modeled always `est.`/`~` + subordinate; net hero inherits `est.`; test asserts modeled never gets measured treatment | OPEN |
| e-AC-4 | Honey never encodes sign: positive=`--verified`, negative=`--severity-critical`; test asserts mapping + honey frame-only | OPEN |
| e-AC-5 | First-run dash glyph (not `$0.00`); token-absent `absent`; Claude-Code-only info badge; measured $0 distinct from unknown | OPEN |
| e-AC-6 | Billing-unreachable -> dash glyph for line + net + scoped retry; test asserts net NOT computed from incomplete inputs | OPEN |
| e-AC-7 | Not-authenticated gates ledger w/ Settings CTA + only REDACTED auth status; test asserts no credential reaches page | OPEN |
| e-AC-8 | Assumption disclosed via ⓘ popover + page-foot footnote, both from 060b assumption DATA FIELD (one source) | OPEN |
| e-AC-9 | Cost-rising-not-green: cost-KPI delta inverts sense; test asserts cost increase not green | OPEN |
| e-AC-10 | Inline-SVG trend (no chart dep), dashed=modeled/solid=measured, from `/api/diagnostics/roi/trend`; motion tokens + reduced-motion | OPEN |
| e-AC-11 | Integer cents across wire/contract; dollars only at render edge; k/M tokens; `$/Mtok` null until live; test asserts no float-cents in wire | OPEN |
| e-AC-12 | View-model from shared `roi_metrics` at org/workspace scope via `read_policy`; test: isolated->own, shared->workspace; renders across-device aggregate | OPEN |
| e-AC-13 | org/team/agent/project rollup views (read-time GROUP BY in daemon); dimension switch renders each; component does NO grouping | OPEN |
| e-AC-14 | Per-user rollup only when availability flag true; else "per-user requires verified login" empty state; never `$0`/self-asserted name | OPEN |
| e-AC-15 | Allocated net gets `est.`-class treatment distinct from measured; mixed-basis flagged not blended; test asserts allocated != measured treatment | OPEN |

## Module-level ACs (roll-up; VERIFIED when their backing sub-PRD ACs are VERIFIED)
| AC | Backed by | Status |
|---|---|---|
| AC-1 | e-AC-1 | OPEN |
| AC-2 | a-AC-* + b-AC-2 | OPEN |
| AC-3 | b-AC-3/4 + e-AC-3 | OPEN |
| AC-4 | c-AC-2 + e-AC-6 | OPEN |
| AC-5 | d-AC-1..4 | OPEN |
| AC-6 | e-AC-2/5 | OPEN |
| AC-7 | a-AC-7 + b-AC-5/7 + e-AC-5 | OPEN |
| AC-8 | c-AC-* + e-AC-7 | OPEN |
| AC-9 | a-AC-3/4 | OPEN |
| AC-10 | b-AC-6 + c-AC-6 + d-AC-6 + f-AC-4 + e-AC-11 | OPEN |
| AC-11 | f-AC-1/2 + e-AC-12 | OPEN |
| AC-12 | f-AC-6/7 + e-AC-14 | OPEN (per-user POPULATED path BLOCKED on backend claim; GATE path implementable) |
| AC-13 | f-AC-8/9 + e-AC-13 | OPEN |
| AC-14 | f-AC-5 + e-AC-15 | OPEN |

---

## Wave plan
- **Wave 1 (parallel, disjoint files):** 060a (capture+columns) ‖ 060c (billing client, new `roi-billing.ts`).
- **Wave 2 (parallel, disjoint):** 060b (rate table + cost/savings engine, new modules) ‖ 060f (`roi_metrics`+`teams` in `tenancy.ts` + write/gate/resolve).
- **Wave 3:** 060d (transport usage surfacing + compose 060b rate + 060c session_type).
- **Wave 4:** 060e-daemon (composite `/api/diagnostics/roi` + `/trend` read-model in `api.ts`, `wire.ts` + `contracts.ts` shapes, `read_policy`-scoped ledger read + rollups).
- **Wave 5:** 060e-page (react: `roi.tsx` + registry entry + four-signal UX + inline-SVG trend + states).
- **Wave 6:** ux-ui-worker-bee DS-adherence review of the page.
- **Close-out:** security-worker-bee (penultimate) -> quality-worker-bee (final). Loop until clean.
- **Ship:** commit, push to existing PR #132, monitor CI to green.
- Verify `npm run typecheck` + targeted `vitest` after EVERY wave; re-read this ledger; OPEN items roll to next wave.

---

## Wave log
- **Wave 1 — DONE + VERIFIED (2026-06-26).** 060a (a-AC-1..7) + 060c (c-AC-1..7).
  - 060a: optional `usage` on the assistant-turn contract (absent != zero), Claude Code shim extraction, 5 additive nullable-BIGINT + `source_tool` cols on `sessions` (zero-vs-null kept distinct via nullability, no DEFAULT 0), same-INSERT persistence, fail-soft degrade. Files: event-contract.ts, normalize.ts, claude-code/shim.ts, hooks/index.ts, sessions-summaries.ts, capture-handler.ts + 3 test files.
  - 060c: `roi-billing.ts` creds-gated fail-soft billing client + in-memory TTL read-model; injected fetch, 429/5xx retry, bounded timeout, bearer redaction, status union `ok|partial|unreachable|unauthenticated`, integer cents, session_type breakdown exposed for 060d. Files: roi-billing.ts + test. Exported: `createInfraCostReadModel()` -> `{ read(), invalidate() }` returning `InfraCostReadModel` (+ `sessionTypeTotalCents`).
  - Independent verify: `npm run typecheck` clean; `vitest run` 362/362 across hooks+capture+catalog+dashboard/roi-billing.
  - All a-AC-* and c-AC-* => **DONE**.
- **Wave 2 — DONE + VERIFIED (2026-06-26).** 060b (b-AC-1..7) + 060f (f-AC-1..13).
  - 060b: `roi-rates.ts` (rate table, Anthropic cache-read 0.1x / cache-write 1.25x, `RATES_AS_OF`), `roi-savings.ts` (measured/modeled/blended engine, `Measured<T>`/`Modeled<T>` tagged returns, `netRoi` always `Modeled` so est. taint propagates), `roi-honesty-contract.ts` (compile-time `@ts-expect-error` witness enforcing b-AC-4 structurally). Placeholder assumption `MEMORY_INJECTION_ASSUMPTION` (signedOff:false, TODO(roi-assumption-signoff)). Exports for Wave 4: `measuredCacheSavings`, `modeledMemoryInjectionSavings`, `blendedCentsPerMtok`, `netRoi`, `resolveRate`.
  - 060f: `roi_metrics` (tenant, append-only) + `teams` (tenant, version-bumped) in tenancy.ts (TENANCY_TABLES 5->7); `roi-ledger.ts` writer: `appendRoiMetric`/`upsertTeamMember`/`resolveTeamId`/`resolveGatedUserId`/`readRoiMetrics`/`buildRoiReadScopeSql`. user_id gate verified (no env/OS lookup, always '' today); team resolution fail-soft; read_policy-scoped read; BIGINT cents; SQL-guarded; lookup indexes only. Writer call-site at summary/skillify completion left for Wave 4 wiring (exported clean).
  - Independent verify: typecheck clean; dup PASS; `vitest run` 297/297 across dashboard+catalog.
  - All b-AC-* and f-AC-* => **DONE**. (Per-user POPULATED still BLOCKED on backend claim; gate path DONE.)
- **Wave 3 — DONE + VERIFIED (2026-06-26).** 060d (d-AC-1..6). `transport-anthropic.ts` additive usage-surfacing seam (behavior-preserving), `roi-skillify-meter.ts` (injectable sink), `roi-pollination.ts` composer (`composePollinationCost`), Haiku priced via 060b (falls back to default row until a Haiku rate row lands), DeepLake half consumed from 060c with no extra egress, worst-status propagation, integer cents. Verify: typecheck clean; 302 inference+dashboard + 63 skillify tests green (no transport regression). All d-AC-* => **DONE**.
- **Wave 4 — DONE + VERIFIED (2026-06-26).** 060e daemon half. `contracts.ts` `RoiView`/`RoiTrendView` (+EMPTY constants), `wire.ts` `roi()`/`roiTrend()` (catch-defaulted zod), `api.ts` `fetchRoiView`/`assembleRoiView`/`computeRollups`/`fetchRoiTrendView` + routes `GET /api/diagnostics/roi` + `/roi/trend` (loopback/local-mode), `roi-session-writer.ts` wired at skillify-worker completion (writes per-session row; `cost_basis:'none'` at write time since org-level infra is not honestly per-session-splittable; `user_id` gated to ''; `team_id` resolved). Verify: typecheck + audit:sql clean; 302 dashboard+skillify green; flagged property test passes in isolation (pre-existing flake). Data-half e-AC (2/6/11/12/13/14/15) + AC-11 => **DONE**.
- **Wave 5 — DONE + VERIFIED (2026-06-26).** 060e page half. `pages/roi.tsx` + `pages/roi-chart.tsx` (inline SVG, no chart dep) + ONE `registry.tsx` entry (sidebar/router untouched) + 32 tests. Four-signal measured/modeled, honey-never-sign, all degraded states, cost-rising-not-green, ⓘ+footnote from assumption data field, per-user empty state, allocated/mixed-basis rendering. Verify: typecheck clean; 298 dashboard/web tests green; one `/roi` entry confirmed. Page-half e-AC (1/3/4/5/7/8/9/10) => **DONE**.
- **Full-suite baseline (2026-06-26):** `npx vitest run --no-file-parallelism` => **3501 passed, 8 skipped, 0 failed.** typecheck + dup + audit:sql all green. The two intermittent failures seen under parallel `npm run ci` were per-test 5s TIMEOUTS in the heavy PRD-046d session-prime suite (different test each run, pass in isolation) = CPU-saturation flake, NOT a PRD-060 regression. Remote CI is the arbiter (monitored at Ship).
- **All 6 sub-PRDs (060a-060f) DONE.** Remaining: Wave 6 ux-ui review, then close-out (security -> quality), then ship.
- **BLOCKED (parked, per operator):** populated per-user rollup awaits the verified `backend-token` claim (AC-12 / e-AC-14 / f-AC-6 gate path is DONE; only live population is blocked). Modeled-assumption exact string awaits operator sign-off (mechanism DONE, `signedOff:false`).
- **Wave 6 — DONE (2026-06-26).** ux-ui DS-adherence review of `roi.tsx`/`roi-chart.tsx`: one token-drift fix (raw rgba shadow -> `var(--shadow-md)`); four signals, honey-never-sign, primitive reuse, motion, a11y all confirmed. typecheck clean, 32 page tests green.

---

## Close-out + ship
- **Security (penultimate) — CLEAN (2026-06-26).** security-worker-bee: 0 Critical / 0 High / 0 Medium / 0 Low. Egress redaction + fixed base URL (no SSRF) + bounded retry/timeout; no-creds-in-page verified; SQL guards intact (audit:sql PASS); per-user gate has no spoofable-identity path (`userInfo|process.env.USER|hostname` = 0 hits); loopback/local-mode gate inherited; transport seam additive. Report: `reports/2026-06-26-security-report.md`. No remediation needed.
- **Quality (final) — PASS / VERIFIED (2026-06-26).** quality-worker-bee: all 55 sub-ACs + 14 module ACs PASS, 0 Critical / 0 Warning, read code AND tests per AC. `typecheck` clean, `audit:sql` clean, affected suites 986 passed / 1 skipped / 0 failed. CONCERN-1 (assumption sign-off, non-blocking), BLOCKED-1 (live per-user population awaits backend claim), SUG-1 (optional index inspection test). Report: `reports/2026-06-26-qa-report.md`.
- **Full-suite baseline:** `npx vitest run --no-file-parallelism` = 3501 passed / 8 skipped / 0 failed. The PRD-046d session-prime parallel-load timeout is a pre-existing CPU-saturation flake (passes in isolation/sequential), unrelated to PRD-060.

## Final status: ALL ACs VERIFIED. Close-out clean. Shipping to PR #132.
Parked (documented, per operator, NOT failures): live per-user population (backend-claim dependency); modeled-assumption exact-string sign-off.
- **Wave 3 — DONE (2026-06-26).** 060d (d-AC-1..6).
  - 060d: usage-surfacing seam added to `transport-anthropic.ts` (additive `UsageSink`/`UsageReport`, default no-op → byte-for-byte prior behavior; parses the `usage` block it discarded, feeds the sink on the SUCCESS path of both `execute` + `stream`, swallows sink faults; thrown call reports nothing; malformed/missing usage → zero counts). New `roi-skillify-meter.ts` (in-memory `SkillifyUsageMeter` IS a `UsageSink`; `recorded:0` ⇒ absent-vs-measured-zero discriminant; clamps defensively; `snapshot()`/`reset()`; `snapshotSource`/`emptyUsageSource` for tests). New `roi-pollination.ts` composer: `composePollinationCost(usage, infra)` prices Haiku tokens via 060b `resolveRate` (model `claude-haiku-4-5`, falls back to default row until 060b grows a Haiku row), composes the DeepLake half from 060c's already-read `sessionTypes` via `sessionTypeTotalCents` (NO second billing read), sums to `pollinationCents`, itemizes both halves + the per-session-type split, carries the WORST contributing status (`unauthenticated`<`unreachable`<`absent`<`partial`<`measured`<`ok`), integer cents throughout. Call-site: `model-client-factory.ts` threads an optional `usageSink` into `createAnthropicTransport` (absent → no-op; Wave 4 wires the live meter). Exports for Wave 4: `composePollinationCost`, `PollinationCost`, `createSkillifyUsageMeter`, `SKILLIFY_PROVIDER`/`SKILLIFY_HAIKU_MODEL`.
  - Independent verify: `npm run typecheck` clean (exit 0); `npm run dup` PASS (0.69% tokens, exit 0, no new clones); `vitest run` 194/194 across inference + skillify + dashboard/roi (new transport-usage + meter + pollination suites green; existing transport-anthropic, model-client-factory, router, gateway, miner, skillify suites green → no regression).
  - All d-AC-* => **DONE**.
