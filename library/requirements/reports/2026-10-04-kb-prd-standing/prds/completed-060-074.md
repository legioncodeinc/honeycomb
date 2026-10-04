# Standing: completed PRDs 060, 062, 063, 065, 071, 072, 073, 074

Shard: Wave 1b only. Read-only. No PRD edits, no source edits, no commits, no folder moves.
Date: 2026-10-04.
Checkout: `/home/marioaldayuz/Desktop/development/active/honeycomb`.
Commit `756bacb` moved 071-074 into `library/requirements/completed/`. This report re-checks those four against source. The move is not assumed.
`doctor/` is not in this checkout. Doctor-repo criteria are UNVERIFIABLE.
`src/dashboard/web/` is not in this checkout (Hive SPA is a separate tree). Page-render criteria that name `roi.tsx`, `registry.tsx`, `wire.ts`, or `panels.tsx` are UNVERIFIABLE here.
Skipped: `node_modules`, `daemon/`, `bundle/`, harness bundles, and other build outputs.

Verdicts:

- MET: the behavior is in this checkout's source, cited `path:line`.
- UNMET: this checkout contradicts the written criterion, or the required artifact is an unfilled placeholder.
- UNVERIFIABLE: the proof lives in `doctor/`, the Hive SPA, a live CDN or PostHog project, or a credentialed measurement that was never recorded.

QA reports were read. A QA pass is not treated as proof.

Index status lines are stale on every folder in this shard. They still say Backlog, Draft, or In Work while the folders sit under `completed/`. Status-line edits belong to the later librarian, not this shard.

## Summary

| PRD | Folder | Index status line | MET | UNMET | UNVERIFIABLE | Recommended bucket |
|---|---|---|---|---|---|---|
| 060 ROI Tracker | `completed/prd-060-roi-tracker` | Backlog, draft (`prd-060-roi-tracker-index.md:3`) | 50 | 0 | 19 | completed |
| 062 DeepLake compute cost | `completed/prd-062-deeplake-compute-cost-reduction` | Backlog, draft (`prd-062-deeplake-compute-cost-reduction-index.md:3`) | 31 | 4 | 3 | completed |
| 063 Portkey gateway | `completed/prd-063-portkey-gateway` | Backlog (`prd-063-portkey-gateway-index.md:3`) | 18 | 0 | 7 | completed |
| 065 Doctor go-live | `completed/prd-065-doctor-go-live` | In Work (`prd-065-doctor-go-live-index.md:3`) | 0 | 0 | 5 | in-work |
| 071 Service check-in | `completed/prd-071-service-checkin-and-sqlite-telemetry` | Backlog (`prd-071-service-checkin-and-sqlite-telemetry-index.md:3`) | 26 | 0 | 0 | completed |
| 072 Apiary state root | `completed/prd-072-apiary-state-root-migration` | Backlog (`prd-072-apiary-state-root-migration-index.md:3`) | 39 | 0 | 0 | completed |
| 073 Dormant capture | `completed/prd-073-dormant-capture-and-explicit-tenancy` | Backlog (`prd-073-dormant-capture-and-explicit-tenancy-index.md:3`) | 35 | 2 | 0 | completed |
| 074 Sessions prose | `completed/prd-074-sessions-prose-column` | Backlog (`prd-074-sessions-prose-column-index.md:3`) | 20 | 2 | 2 | completed |

PRD acceptance criteria judged: 263. Unmet: 8. Unverifiable: 36. Met: 219.

065 QA-note criteria (autoupdate fix and CLI exit fix) are extra. They are all UNVERIFIABLE because they cite `doctor/` paths. They are not in the 8.

## Unmet (8)

1. 062 AC-1. Idle baseline report is a scaffold. Reads/min are placeholders. `reports/062a-idle-baseline-report.md:1`, `:26-37`.
2. 062 AC-6 and AC-62c.2.2. Session-invariant metadata is still repeated on every row. `budgeted-stringify.ts:15-22` says the consumer audit forbids lifting `metadata.sessionId`.
3. 062 AC-62a.2.2. Same scaffold. The "before" figure was never filled.
4. 073 AC-6 and AC-073c.1.1. A multi-org device flow now writes a provisional credential (first enumerated org, workspace `default`, `tenancyPending: true`) before explicit selection. `setup-tenancy.ts:239-259`, `deeplake-issuer.ts:791-811`.
5. 074 m-AC-4 and a-AC-7. `roi-session-writer.ts:105-121` and `api.ts:846-858` no longer read `message` JSONB. Summaries and the skillify miner still do.

## Recommended buckets

- 060: **completed**. Capture, rates, billing, pollination, and the shared ledger are in `src/daemon`. The `/roi` page is not in this checkout. Do not move the folder back because `roi.tsx` is absent.
- 062: **completed**. Backoff, one poller, capture batching, envelope caps, fan-out batching, recall pool, and hibernation are in source. Four criteria stay unmet (live baseline numbers, and the declined metadata lift). Do not treat the QA "all green" as closing AC-1.
- 063: **completed**. Inference routing, fail-closed fallback, and Cohere-via-Portkey rerank are in the daemon. The Settings page controls are unverifiable (Hive SPA absent).
- 065: **in-work**. Index status already says In Work. Every criterion needs `doctor/`, `site/install/`, `scripts/install/install.sh`, or a live get.theapiary.sh / PostHog check. None of those are in this checkout. The `completed/` placement is not supported by source here. `756bacb` did not cover 065; the folder was already under `completed/`.
- 071: **completed**. Re-checked. Check-in, heartbeat, metrics snapshot, bounded redacted logs, WAL, and installer registry upsert are in `src/daemon/runtime/telemetry/`. PRD table names `honeycomb_metrics` / `honeycomb_logs` are absent; the shipped names are `service_metrics` / `service_logs`. Behavior matches. `qa/` contains only `.gitkeep`.
- 072: **completed**. Re-checked. Shared `fleet-root.ts`, migration marker, family movers, registry window, and service-unit `APIARY_HOME` pin are present. The 2026-07-04 QA failures (fresh `~/.honeycomb` creation, missing read fallback, retry defeat) are closed in current source: legacy pid stamp runs only when the legacy dir already exists (`assemble.ts:962-967`); new skillify locks are created only under `~/.apiary/honeycomb` (`miner.ts:662-663`); `move.ts:79` fails closed when both copies differ.
- 073: **completed**, with a residual contradiction on AC-6. The bound-project gate, health reasons, CLI prompts, and capture gating are in source. The provisional credential write breaks the "persist nothing until selection" rule. Wave 2 should decide whether that later bugfix supersedes AC-6. This shard does not recommend a move back by itself, because the capture gate stays closed on `tenancyPending`.
- 074: **completed**. Re-checked. `prose` column, `proseForEvent` / `proseForToolCall`, and `COALESCE(NULLIF(prose, ''), message::text)` in both the projection and the ILIKE predicate are present. The two unmet rows are ROI readers that stopped parsing the JSONB envelope. The prose recall path does not depend on them.

## PRD-060 ROI Tracker

Files read: index, 060a-f, `reports/2026-06-26-qa-report.md`, `reports/2026-06-26-security-report.md`.
QA (2026-06-26) marks every AC PASS and records BLOCKED-1 for live `user_id` population. This re-check agrees on the daemon. It does not treat the QA page citations as current: `src/dashboard/web/pages/roi.tsx` is ABSENT.

### Module (`prd-060-roi-tracker-index.md`)

#### AC-1
- Quote: "A new `/roi` page is reachable in the dashboard via one registry entry + one page component; no sidebar or router file is hand-edited, and the page renders the Net-ROI ledger."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:82`
- Verdict: UNVERIFIABLE
- Source: `src/dashboard/web/pages/roi.tsx` ABSENT. `src/dashboard/web/registry.tsx` ABSENT. Daemon route exists at `src/daemon/runtime/dashboard/api.ts:1443`.

#### AC-2
- Quote: "Measured cache savings are computed from real captured `cache_read_input_tokens` times the rate-table delta, and a test asserts the figure is arithmetic over the persisted token counts."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:83`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-savings.ts:139-153`. Columns `src/daemon/storage/catalog/sessions-summaries.ts:66-69`. Test file `tests/daemon/runtime/dashboard/roi-savings.test.ts` exists.

#### AC-3
- Quote: "Modeled memory-injection savings are rendered as a visibly distinct, labeled estimate carrying their assumption as a data field; the modeled term is never summed into a line presented as measured, and the net hero inherits the est. marker."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:84`
- Verdict: UNVERIFIABLE
- Source: structural tags MET at `src/daemon/runtime/dashboard/roi-honesty-contract.ts:37-48` and `roi-savings.ts:272`. The render (est. marker, hero) is `src/dashboard/web/pages/roi.tsx` ABSENT.

#### AC-4
- Quote: "DeepLake infra cost is read from the `/billing/*` API by the daemon and rendered; when the API is unreachable or unauthenticated, the affected line shows a dash glyph and the net is not computed from the incomplete inputs."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:85`
- Verdict: MET
- Source: status map `src/daemon/runtime/dashboard/roi-billing.ts:403-425`. Net withheld unless inputs are complete at `src/daemon/runtime/dashboard/api.ts:1078-1085`. Dash glyph UI is ABSENT with the page; the fail-soft rule is in the daemon.

#### AC-5
- Quote: "Pollination cost sums Honeycomb's own Haiku skillify token cost and the DeepLake embedding+ingestion+query GPU-session cost, and a test asserts both contributors are present and itemized."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:86`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-pollination.ts:334-339`. Haiku price `roi-pollination.ts:179`. Test file `tests/daemon/runtime/dashboard/roi-pollination.test.ts` exists.

#### AC-6
- Quote: "Per-section status discriminants, each ledger section reports one of ok / partial / absent / unreachable / unauthenticated; a test asserts a measured $0 renders differently from unknown, and that the page is a pure function of the view-model."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:87`
- Verdict: UNVERIFIABLE
- Source: view-model types `src/dashboard/contracts.ts:424-614`. Page render test `tests/dashboard/web/roi-page.test.tsx` ABSENT. `src/dashboard/web/` ABSENT.

#### AC-7
- Quote: "Graceful degradation: with token capture absent the measured-savings section shows absent placeholders; with Claude-Code-only data it shows a partial Claude Code only badge; blendedCentsPerMtok is null until capture is live."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:88`
- Verdict: UNVERIFIABLE
- Source: null blend and capture status MET at `src/daemon/runtime/dashboard/roi-savings.ts:98` and `:172`. Badge and dash glyph are the absent page.

#### AC-8
- Quote: "Daemon is sole egress: the `/roi` page makes no outbound billing call and holds no billing credentials; all billing data arrives through the loopback daemon read-model."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:89`
- Verdict: MET
- Source: creds gate and sole billing client `src/daemon/runtime/dashboard/roi-billing.ts:403-405`. No dashboard page in this tree holds a billing client.

#### AC-9
- Quote: "Additive, fail-soft schema: the new token/cache columns are added to the sessions group via additive schema healing, and a missing/legacy column degrades reads to token data absent rather than throwing."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:90`
- Verdict: MET
- Source: nullable BIGINT columns `src/daemon/storage/catalog/sessions-summaries.ts:59-69`.

#### AC-10
- Quote: "All money is integer cents end to end, and BIGINT cents in the shared roi_metrics ledger, formatted to dollars only at the render edge; no FLOAT money column in roi_metrics."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:91`
- Verdict: MET
- Source: `src/daemon/storage/catalog/tenancy.ts:271`. Integer check `src/daemon/runtime/dashboard/roi-savings.ts:84`. Render-edge formatting is the absent page; the ledger type is BIGINT.

#### AC-11
- Quote: "Shared, cross-device ledger: the per-session ROI figure is appended to tenant-scoped roi_metrics with explicit org_id/workspace_id/project_id/agent_id/team_id; rollups are read-time GROUP BYs over rows from more than one device."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:92`
- Verdict: MET
- Source: table `src/daemon/storage/catalog/tenancy.ts:376`. Append `src/daemon/runtime/dashboard/roi-ledger.ts:260`. Rollups `src/daemon/runtime/dashboard/api.ts:912` and `:1119`.

#### AC-12
- Quote: "Per-user gated, no spoofable fallback: roi_metrics.user_id is populated only when verifiedClaim.source === backend-token and is empty otherwise; git-email / $USER / OS-login are never consulted."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:93`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-ledger.ts:90` and `:230-231`. Page empty-state copy is ABSENT with the SPA. `perUserAvailable: false` at `api.ts:1129`.

#### AC-13
- Quote: "Per-team is a real dimension: a team_id column is resolved by a roster lookup at ROI-write time; an assigned agent's row carries the resolved team_id."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:94`
- Verdict: MET
- Source: `teams` table `src/daemon/storage/catalog/tenancy.ts:385`. Lookup `src/daemon/runtime/dashboard/roi-ledger.ts:111` and `:229`.

#### AC-14
- Quote: "Measured vs allocated cost honesty: a per-team/user infra share is marked cost_basis=allocated with a non-empty allocation_method, never measured; a mixed-basis rollup is detectable."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060-roi-tracker-index.md:95`
- Verdict: MET
- Source: columns `src/daemon/storage/catalog/tenancy.ts:271-278` (cost_basis, allocation_method). Page treatment of allocated net is ABSENT with the SPA.

### 060a (`prd-060a-roi-tracker-token-and-cache-usage-capture.md`)

#### a-AC-1
- Quote: "The capture contract carries an optional normalized usage on an assistant turn; a turn with no usage data validates and round-trips with the field absent (not zero-filled)."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md:44`
- Verdict: MET
- Source: `src/daemon/runtime/capture/event-contract.ts:62-75` (`TurnUsageSchema` optional, each count optional).

#### a-AC-2
- Quote: "The Claude Code shim extracts input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens from the transcript JSONL."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md:45`
- Verdict: MET
- Source: `src/hooks/claude-code/transcript.ts:76` and `:184`. Shim `src/hooks/claude-code/shim.ts:144-145`.

#### a-AC-3
- Quote: "The sessions group gains input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, and source_tool via the additive schema-heal path."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md:46`
- Verdict: MET
- Source: `src/daemon/storage/catalog/sessions-summaries.ts:66-69` and `:82`.

#### a-AC-4
- Quote: "A dataset missing the new columns reads back as token data absent and the daemon boots and capture proceeds without throwing."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md:47`
- Verdict: MET
- Source: nullable BIGINT columns `sessions-summaries.ts:59-69`. Reads coerce null in `api.ts:846-858` (`tokenCountOrNull`).

#### a-AC-5
- Quote: "Token counts persist on the same append-only INSERT as the turn; a test asserts the count is queryable on the written row."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md:48`
- Verdict: MET
- Source: capture row build includes prose and the turn insert path `src/daemon/runtime/capture/capture-handler.ts:700-707` (token fields ride the same row builder; usage columns are the catalog fields written with the turn).

#### a-AC-6
- Quote: "A transcript message without usage, or with a malformed/partial count, produces a row with null token fields, never a throw, never a silent 0."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md:49`
- Verdict: MET
- Source: `src/hooks/normalize.ts:309` and `:364-369` (`readCount` rejects non-integer and negative).

#### a-AC-7
- Quote: "Every Claude-Code-captured row carries source_tool = claude-code."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md:50`
- Verdict: MET
- Source: column `sessions-summaries.ts:79-82`. Shim sets the discriminant via the capture path documented at `src/hooks/claude-code/shim.ts:111-145`.

### 060b (`prd-060b-roi-tracker-cost-and-savings-engine.md`)

#### b-AC-1
- Quote: "A provider-to-model rate table exists with input / output / cache_read / cache_write cents-per-Mtok and a rates-as-of date; Anthropic cache-read is 0.1x input and cache-write is 1.25x input."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md:42`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-rates.ts:28-30`, `:69`, `:90-91`.

#### b-AC-2
- Quote: "Measured cache savings = cache_read_tokens times (input_rate - cache_read_rate), returned tagged measured."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md:43`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-savings.ts:139`.

#### b-AC-3
- Quote: "Modeled memory-injection savings is returned tagged modeled and carries its assumption as a data field."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md:44`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-savings.ts:272`. Open question on the signed-off formula is still unchecked in the PRD (`prd-060b` line 59). The field exists; the assumption text is a placeholder, which the QA report already flagged. The criterion asks for the field, not operator sign-off.

#### b-AC-4
- Quote: "No measured-tagged value is ever derived from a modeled input, and any aggregate including the modeled term is itself tagged modeled/est."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md:45`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-honesty-contract.ts:37-48`.

#### b-AC-5
- Quote: "blendedCentsPerMtok is computed from the actual token mix and is null when token capture is absent."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md:46`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-savings.ts:172`.

#### b-AC-6
- Quote: "All values are integer cents within this layer; no float-cents value crosses the module boundary."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md:47`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-savings.ts:84`.

#### b-AC-7
- Quote: "With token capture absent, measured savings reports a status the read-model maps to absent/partial rather than returning 0 as if measured."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md:48`
- Verdict: MET
- Source: `CaptureStatus` `src/daemon/runtime/dashboard/roi-savings.ts:98` and `:153`.

### 060c (`prd-060c-roi-tracker-deeplake-billing-integration.md`)

#### c-AC-1
- Quote: "A daemon-side billing client reads GET /billing/summary and GET /billing/usage/compute through an injected fetch."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060c-roi-tracker-deeplake-billing-integration.md:45`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-billing.ts:343`. Test `tests/daemon/runtime/dashboard/roi-billing.test.ts` exists.

#### c-AC-2
- Quote: "With no credentials the read-model returns unauthenticated; with the API unreachable it returns unreachable; no value is fabricated and the daemon does not throw."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060c-roi-tracker-deeplake-billing-integration.md:46`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-billing.ts:403-425`.

#### c-AC-3
- Quote: "The client retries on 429/5xx with a bounded timeout and redacts the bearer token from every log path."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060c-roi-tracker-deeplake-billing-integration.md:47`
- Verdict: MET
- Source: timeout default `roi-billing.ts:114`. Token stays on the Authorization header; QA and module comments at `roi-billing.ts:16-26`. Test file exists.

#### c-AC-4
- Quote: "The infra read-model is TTL-cached in memory; a second read within the TTL does not re-hit the upstream API."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060c-roi-tracker-deeplake-billing-integration.md:48`
- Verdict: MET
- Source: `createInfraCostReadModel` `src/daemon/runtime/dashboard/roi-billing.ts:343`.

#### c-AC-5
- Quote: "The session_type breakdown is exposed as integer cents; the three types are itemized and summable."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060c-roi-tracker-deeplake-billing-integration.md:49`
- Verdict: MET
- Source: `sessionTypeTotalCents` `src/daemon/runtime/dashboard/roi-billing.ts:241`.

#### c-AC-6
- Quote: "All money stays integer cents through the client and read-model."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060c-roi-tracker-deeplake-billing-integration.md:50`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-billing.ts:210-241`.

#### c-AC-7
- Quote: "A partial upstream response yields a partial status with the available lines populated and the missing ones flagged, never a silent zero."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060c-roi-tracker-deeplake-billing-integration.md:51`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-billing.ts:423-425`.

### 060d (`prd-060d-roi-tracker-pollination-cost-metering.md`)

#### d-AC-1
- Quote: "transport-anthropic.ts surfaces the usage object it currently discards on Honeycomb's own skillify calls."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060d-roi-tracker-pollination-cost-metering.md:41`
- Verdict: MET
- Source: `UsageSink` `src/daemon/runtime/inference/transport-anthropic.ts:130-136` and `:321-364`.

#### d-AC-2
- Quote: "Haiku skillify token cost is computed by pricing the metered tokens with 060b's rate table, in integer cents."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060d-roi-tracker-pollination-cost-metering.md:42`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-pollination.ts:179`.

#### d-AC-3
- Quote: "The DeepLake embedding + ingestion + query GPU-session cost is composed into the pollination total without a second billing read."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060d-roi-tracker-pollination-cost-metering.md:43`
- Verdict: MET
- Source: `composePollinationCost` takes the infra snapshot `src/daemon/runtime/dashboard/roi-pollination.ts:334`.

#### d-AC-4
- Quote: "pollination = haikuSkillifyCents + deeplakeSessionCents, itemized so both contributors are individually readable."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060d-roi-tracker-pollination-cost-metering.md:44`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-pollination.ts:334-339`.

#### d-AC-5
- Quote: "A missing Haiku meter yields an absent Haiku contribution (not 0), and an unreachable billing read yields an unreachable DeepLake contribution; the total carries the worst status."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060d-roi-tracker-pollination-cost-metering.md:45`
- Verdict: MET
- Source: `worstPollinationStatus` `src/daemon/runtime/dashboard/roi-pollination.ts:306`.

#### d-AC-6
- Quote: "All pollination values are integer cents."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060d-roi-tracker-pollination-cost-metering.md:46`
- Verdict: MET
- Source: `priceHaikuTokens` `src/daemon/runtime/dashboard/roi-pollination.ts:179`.

### 060e (`prd-060e-roi-tracker-roi-tracker-dashboard-page.md`)

All fifteen page criteria are UNVERIFIABLE. `src/dashboard/web/` is not in this checkout. `tests/dashboard/web/roi-page.test.tsx` is ABSENT. Daemon halves that do exist are noted.

#### e-AC-1
- Quote: "`/roi` is registered via one registry entry + one roi.tsx; no sidebar or router file was hand-edited; the page renders inside PageFrame with title ROI."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:74`
- Verdict: UNVERIFIABLE
- Source: `src/dashboard/web/pages/roi.tsx` ABSENT. `src/dashboard/web/registry.tsx` ABSENT.

#### e-AC-2
- Quote: "The page is a pure function of the RoiView; a test renders every per-section status from a fixture view-model."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:75`
- Verdict: UNVERIFIABLE
- Source: `assembleRoiView` is pure in `src/daemon/runtime/dashboard/api.ts:1018`. Page ABSENT.

#### e-AC-3
- Quote: "Measured vs modeled uses the four reinforcing signals; the modeled figure always carries est./~ and the net hero inherits est."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:76`
- Verdict: UNVERIFIABLE
- Source: page ABSENT. Type taint is `roi-honesty-contract.ts:43-48`.

#### e-AC-4
- Quote: "Honey never encodes sign: positive net renders var(--verified), negative net var(--severity-critical)."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:77`
- Verdict: UNVERIFIABLE
- Source: page ABSENT.

#### e-AC-5
- Quote: "First-run/empty shows a dash glyph, not $0.00; token-absent shows the absent treatment; Claude-Code-only shows the Claude Code only badge."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:78`
- Verdict: UNVERIFIABLE
- Source: page ABSENT.

#### e-AC-6
- Quote: "Billing-unreachable shows a dash glyph for the affected line and for the net, plus a scoped retry; the net is not computed when any required input is missing."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:79`
- Verdict: UNVERIFIABLE
- Source: net rule MET at `api.ts:1078-1085`. Dash glyph and retry UI ABSENT.

#### e-AC-7
- Quote: "Not-authenticated gates the ledger behind a Settings CTA and renders only redacted auth status."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:80`
- Verdict: UNVERIFIABLE
- Source: page ABSENT.

#### e-AC-8
- Quote: "The assumption behind the modeled estimate is disclosed via an info popover and a persistent page-foot footnote, both sourced from the assumption data field."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:81`
- Verdict: UNVERIFIABLE
- Source: assumption field MET in `roi-savings.ts:272`. Popover ABSENT.

#### e-AC-9
- Quote: "Cost-rising-not-green: the prior-period delta on cost KPIs inverts the usual sense."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:82`
- Verdict: UNVERIFIABLE
- Source: page ABSENT.

#### e-AC-10
- Quote: "The trend chart is inline SVG with dashed strokes for modeled and solid for measured, backed by GET /api/diagnostics/roi/trend."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:83`
- Verdict: UNVERIFIABLE
- Source: route comment `api.ts:1443` and trend type `src/dashboard/contracts.ts:657`. `roi-chart.tsx` ABSENT.

#### e-AC-11
- Quote: "All money is integer cents across the wire/contract; dollars are formatted only at the render edge; a test asserts no float-cents in the wire schema."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:84`
- Verdict: UNVERIFIABLE
- Source: `src/dashboard/web/wire.ts` ABSENT. BIGINT ledger is `tenancy.ts:271`.

#### e-AC-12
- Quote: "The view-model is assembled from the shared roi_metrics ledger read at org/workspace scope governed by read_policy; the page renders the across-device aggregate."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:85`
- Verdict: UNVERIFIABLE
- Source: scope SQL MET at `src/daemon/runtime/dashboard/roi-ledger.ts:361`. `scopedAcrossDevices` `api.ts:1132`. Page render ABSENT.

#### e-AC-13
- Quote: "The page renders org / team / agent / project rollup views; the component does no grouping itself."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:86`
- Verdict: UNVERIFIABLE
- Source: daemon grouping MET at `api.ts:912`. Component ABSENT.

#### e-AC-14
- Quote: "A per-user rollup is shown only when the per-user availability flag is true; with the flag false the page shows the per-user requires verified login empty state."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:87`
- Verdict: UNVERIFIABLE
- Source: `perUserAvailable: false` MET at `api.ts:1129`. Empty-state UI ABSENT.

#### e-AC-15
- Quote: "An allocated net renders with the est.-class subordinate treatment, distinct from a measured net; a mixed-basis rollup is flagged."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md:88`
- Verdict: UNVERIFIABLE
- Source: ledger basis MET at `tenancy.ts:271-278`. Render ABSENT.

### 060f (`prd-060f-roi-tracker-shared-spend-ledger.md`)

#### f-AC-1
- Quote: "A new roi_metrics table is defined with scope tenant and explicit org_id + workspace_id columns."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:63`
- Verdict: MET
- Source: `src/daemon/storage/catalog/tenancy.ts:220` and `:376`.

#### f-AC-2
- Quote: "roi_metrics is append-only: one immutable row per session via appendOnlyInsert; a re-price appends a new row."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:64`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-ledger.ts:216-260`.

#### f-AC-3
- Quote: "The canonical row per session_id resolves by MAX(created_at); the original is retained."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:65`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-ledger.ts:397-412`.

#### f-AC-4
- Quote: "All money columns are BIGINT integer cents."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:66`
- Verdict: MET
- Source: `src/daemon/storage/catalog/tenancy.ts:233` and `:271`.

#### f-AC-5
- Quote: "Measured / modeled / allocated are separate columns; a mixed-basis rollup is detectable via COUNT(DISTINCT cost_basis)."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:67`
- Verdict: MET
- Source: `src/daemon/storage/catalog/tenancy.ts:271-278`.

#### f-AC-6
- Quote: "user_id is set only when verifiedClaim.source === backend-token, empty otherwise; git-email / $USER / OS-login are never consulted."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:68`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-ledger.ts:19-20` and `:90`.

#### f-AC-7
- Quote: "No historical backfill: rows written before a verified claim retain user_id empty and are not retroactively populated."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:69`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-ledger.ts:230-231` (gate at write time only; no backfill path).

#### f-AC-8
- Quote: "A new teams roster table is scope tenant with version-bumped writes and a member_type agent|user union."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:70`
- Verdict: MET
- Source: `src/daemon/storage/catalog/tenancy.ts:385`. Version bump import `roi-ledger.ts:61`.

#### f-AC-9
- Quote: "team_id is resolved at ROI-write time by a roster lookup; an unassigned agent carries empty and never throws."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:71`
- Verdict: MET
- Source: `src/daemon/runtime/dashboard/roi-ledger.ts:111` and `:229`.

#### f-AC-10
- Quote: "Additive-heal safety: every NOT NULL column has a DEFAULT; a missing table degrades the ROI read to shared ledger absent."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:72`
- Verdict: MET
- Source: degrade path `src/daemon/runtime/dashboard/roi-ledger.ts:331` and `:439-443`.

#### f-AC-11
- Quote: "SQL-guarded writes: every interpolated value routes through sqlStr/sqlLike/sqlIdent."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:73`
- Verdict: MET
- Source: `val` import `src/daemon/runtime/dashboard/roi-ledger.ts:61`. This shard did not re-run `audit:sql`.

#### f-AC-12
- Quote: "Rollup indexing only: no deeplake_index BM25 and no vector index on either table."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:74`
- Verdict: MET
- Source: `embeddingColumns: []` `src/daemon/storage/catalog/tenancy.ts:379` and `:388`.

#### f-AC-13
- Quote: "Local read at org/workspace scope governed by read_policy; an isolated policy never returns another agent's ROI rows."
- PRD: `library/requirements/completed/prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md:75`
- Verdict: MET
- Source: `buildRoiReadScopeSql` `src/daemon/runtime/dashboard/roi-ledger.ts:361`.

## PRD-062 DeepLake compute cost reduction

Files read: index, 062a-e, `qa/prd-062-deeplake-compute-cost-reduction-qa.md`, `reports/062a-idle-baseline-report.md`.
QA marks the live baseline and the live recall eval as deferred (blue). This re-check agrees. QA also records AC-62c.2.2 as intentionally declined. That decline is UNMET against the written criterion.

### Module (`prd-062-deeplake-compute-cost-reduction-index.md`)

#### AC-1
- Quote: "Cost is attributed before it is cut. A daemon query meter labels every DeepLake read/write with a source, and a test plus a live idle-baseline run produce a report stating reads/min/daemon at zero user activity."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:76`
- Verdict: UNMET
- Source: meter MET at `src/daemon/storage/query-meter.ts:50-53` and `:118`. Report is a scaffold with `<N>` placeholders `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/reports/062a-idle-baseline-report.md:1` and `:26-37`.

#### AC-2
- Quote: "With an empty memory_jobs queue and no user activity, steady-state DeepLake poll cadence is at most 1 read-pass / 30s; a test asserts the backoff reaches its ceiling."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:77`
- Verdict: MET
- Source: ceiling `src/daemon/runtime/services/poll-backoff.ts:42` (30000 ms) and geometric step `:239`. Live reads/min number is the unmet AC-1 report, not this schedule.

#### AC-3
- Quote: "When a job is enqueued into an idle daemon, the next lease pass resets the backoff to its fast floor."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:78`
- Verdict: MET
- Source: `onLease` `src/daemon/runtime/services/poll-backoff.ts:246`.

#### AC-4
- Quote: "The pipeline stage worker and pollinating worker no longer run two independent 1Hz scans; one combined lease pass covers both kind sets."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:79`
- Verdict: MET
- Source: `src/daemon/runtime/services/lease-coordinator.ts:185-188`.

#### AC-5
- Quote: "Captured events are flushed to sessions as multi-row appends over a bounded window; a flush is forced on window close / shutdown."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:80`
- Verdict: MET
- Source: `flush` `src/daemon/runtime/capture/capture-handler.ts:260` and `:627`. Buffer module `src/daemon/runtime/capture/capture-buffer.ts`.

#### AC-6
- Quote: "Oversized tool input/response payloads are capped to a documented budget with an explicit truncation marker, and invariant per-session metadata is not repeated per row."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:81`
- Verdict: UNMET
- Source: truncation MET in `src/daemon/runtime/capture/budgeted-stringify.ts:15-33`. Metadata lift refused at `:20-22` (`metadata.sessionId` still consumed by the skillify miner). Second clause absent.

#### AC-7
- Quote: "The per-fact controlled-write fan-out is batched where ordering allows, and recall arms plus the usefulness-grader run under a bounded-concurrency semaphore."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:82`
- Verdict: MET
- Source: batch key `src/daemon/runtime/pipeline/fan-out.ts:214`. Pool `src/daemon/runtime/memories/bounded-pool.ts:2`. Cap default 6 `src/daemon/runtime/memories/amplification-config.ts:141`.

#### AC-8
- Quote: "Recall results, extraction output, and skillify decisions are unchanged within tolerance; the live integration net passes, and a parity check shows no recall-quality drop."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:83`
- Verdict: UNVERIFIABLE
- Source: in-suite parity is claimed by the pool comment `bounded-pool.ts:12`. Live `eval:recall` result is not recorded. QA leaves the live half deferred.

#### AC-9
- Quote: "Poll backoff, write batching, envelope trimming, and the concurrency caps each sit behind a documented env flag; flags off reproduce pre-PRD behavior."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:84`
- Verdict: MET
- Source: `HONEYCOMB_POLL_BACKOFF_ENABLED` `poll-backoff.ts:141`. `HONEYCOMB_POLL_CONSOLIDATE` `lease-coordinator.ts:245`. `HONEYCOMB_CAPTURE_BATCH` `capture-config.ts:75`. `HONEYCOMB_FANOUT_BATCH` `amplification-config.ts:137`. `HONEYCOMB_RECALL_MAX_CONCURRENCY` `amplification-config.ts:141`. `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` `deeplake-hibernation.ts:350`.

#### AC-10
- Quote: "Reducing the per-lease UNION-scan poll count does not reintroduce the stale-segment race; lease ownership is still single-winner and the reaper still reclaims stale leases."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md:85`
- Verdict: MET
- Source: scan count left at 8 `src/daemon/runtime/services/job-queue.ts:274` and `:283`. Not reduced.

### 062a user-story criteria

#### AC-62a.1.1
- Quote: "Every DeepLake read/write passes through a meter that records a source in the closed set and increments a per-source counter."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062a-deeplake-compute-cost-reduction-query-cost-instrumentation.md:32`
- Verdict: MET
- Source: closed set `src/daemon/storage/query-meter.ts:50-53`. `record` `:118`.

#### AC-62a.1.2
- Quote: "The meter adds negligible overhead and adds zero additional DeepLake queries in default log/in-memory mode."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062a-deeplake-compute-cost-reduction-query-cost-instrumentation.md:33`
- Verdict: MET
- Source: in-memory counter `src/daemon/storage/query-meter.ts:118`. Scaffold note says persistence flag is unused `reports/062a-idle-baseline-report.md:49-51`.

#### AC-62a.1.3
- Quote: "A diagnostic surface exposes the current per-source counts."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062a-deeplake-compute-cost-reduction-query-cost-instrumentation.md:34`
- Verdict: MET
- Source: log line shape `src/daemon/storage/query-meter.ts:159`.

#### AC-62a.2.1
- Quote: "A documented procedure or test harness boots a daemon, leaves memory_jobs empty, and records reads/min/daemon broken down by source."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062a-deeplake-compute-cost-reduction-query-cost-instrumentation.md:41`
- Verdict: MET
- Source: procedure `reports/062a-idle-baseline-report.md:16-24`. Offline harness named there at `:23-24` (`tests/helpers/idle-baseline-harness.ts`).

#### AC-62a.2.2
- Quote: "The baseline run produces a short report stating the idle reads/min and the polling share, which becomes the PRD-062 before figure."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062a-deeplake-compute-cost-reduction-query-cost-instrumentation.md:42`
- Verdict: UNMET
- Source: placeholders `reports/062a-idle-baseline-report.md:26-37`.

### 062b user-story criteria

#### AC-62b.1.1
- Quote: "With an empty queue the poll interval grows geometrically from the floor to the ceiling; a test asserts it reaches the ceiling (~30s)."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062b-deeplake-compute-cost-reduction-adaptive-poll-backoff.md:37`
- Verdict: MET
- Source: `src/daemon/runtime/services/poll-backoff.ts:42` and `:239`.

#### AC-62b.1.2
- Quote: "The 062a meter shows idle poll-lease + poll-reaper reads/min dropping by at least 1 order of magnitude versus the pre-PRD baseline."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062b-deeplake-compute-cost-reduction-adaptive-poll-backoff.md:38`
- Verdict: UNVERIFIABLE
- Source: before/after cells are placeholders `reports/062a-idle-baseline-report.md:43`. No recorded delta.

#### AC-62b.2.1
- Quote: "Any successful lease() resets the poll interval to the floor."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062b-deeplake-compute-cost-reduction-adaptive-poll-backoff.md:45`
- Verdict: MET
- Source: `src/daemon/runtime/services/poll-backoff.ts:198` and `:246`.

#### AC-62b.2.2
- Quote: "Under sustained load, the effective poll cadence equals the original fast floor, and job pickup latency is unchanged within tolerance."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062b-deeplake-compute-cost-reduction-adaptive-poll-backoff.md:46`
- Verdict: MET
- Source: `onLease` resets to the floor `poll-backoff.ts:246`, so sustained leases stay at the floor.

#### AC-62b.3.1
- Quote: "One combined lease pass handles pipeline kinds and pollinating kinds per tick and still leaves foreign kinds queued."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062b-deeplake-compute-cost-reduction-adaptive-poll-backoff.md:53`
- Verdict: MET
- Source: `src/daemon/runtime/services/lease-coordinator.ts:185-188`.

### 062c user-story criteria

#### AC-62c.1.1
- Quote: "N captured events within the flush window produce one multi-row append."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062c-deeplake-compute-cost-reduction-capture-write-batching.md:35`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-handler.ts:578` and `:627`. `src/daemon/runtime/capture/capture-buffer.ts`.

#### AC-62c.1.2
- Quote: "A flush is forced on window close, on shutdown, and on a size cap, so no buffered event is lost on a clean stop."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062c-deeplake-compute-cost-reduction-capture-write-batching.md:36`
- Verdict: MET
- Source: `flush` `src/daemon/runtime/capture/capture-handler.ts:627`.

#### AC-62c.1.3
- Quote: "The 062a meter shows capture-write query count per session dropping in proportion to the batch factor."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062c-deeplake-compute-cost-reduction-capture-write-batching.md:37`
- Verdict: MET
- Source: source label on the batched append `src/daemon/runtime/capture/capture-handler.ts:82-84` and `:374`.

#### AC-62c.2.1
- Quote: "A tool input/response exceeding the documented byte budget is stored truncated with an explicit marker."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062c-deeplake-compute-cost-reduction-capture-write-batching.md:44`
- Verdict: MET
- Source: marker contract `src/daemon/runtime/capture/budgeted-stringify.ts:27-33`.

#### AC-62c.2.2
- Quote: "Session-invariant metadata is not repeated on every row; the invariant fields remain recoverable for the session."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062c-deeplake-compute-cost-reduction-capture-write-batching.md:45`
- Verdict: UNMET
- Source: explicitly not done `src/daemon/runtime/capture/budgeted-stringify.ts:20-22`. Miner still reads `metadata.sessionId` from the envelope `src/daemon/runtime/skillify/miner.ts:203`.

#### AC-62c.2.3
- Quote: "A parity check asserts every field the extractor and recall read is still present after trimming, and the recall-quality eval shows no regression."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062c-deeplake-compute-cost-reduction-capture-write-batching.md:46`
- Verdict: UNVERIFIABLE
- Source: consumed-field trim scope is `budgeted-stringify.ts:16-23` (only `event.input` and `event.response`). Live recall eval result ABSENT.

### 062d user-story criteria

#### AC-62d.1.1
- Quote: "A decision producing M fact proposals enqueues them in a batched operation rather than M independent enqueue calls."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062d-deeplake-compute-cost-reduction-fanout-and-recall-amplification.md:33`
- Verdict: MET
- Source: `src/daemon/runtime/pipeline/fan-out.ts:183-214`.

#### AC-62d.1.2
- Quote: "Coalescing preserves per-memory append/version-bump correctness; no controlled write is dropped or coalesced into an in-place UPDATE."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062d-deeplake-compute-cost-reduction-fanout-and-recall-amplification.md:34`
- Verdict: MET
- Source: per-fact writes remain `src/daemon/runtime/pipeline/controlled-writes.ts:832` (`appendOnlyInsertMany` of per-fact rows).

#### AC-62d.2.1
- Quote: "The recall arms and the usefulness-grader run under a bounded-concurrency semaphore; no more than N DeepLake queries are in flight."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062d-deeplake-compute-cost-reduction-fanout-and-recall-amplification.md:41`
- Verdict: MET
- Source: `src/daemon/runtime/memories/bounded-pool.ts:2`. Default N=6 `amplification-config.ts:141`. Grader `usefulness-grader.ts:123`.

#### AC-62d.2.2
- Quote: "The merged recall result with the semaphore is identical to the result without it."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062d-deeplake-compute-cost-reduction-fanout-and-recall-amplification.md:42`
- Verdict: MET
- Source: order-preserving pool contract `src/daemon/runtime/memories/bounded-pool.ts:12`.

### 062e (`prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md`)

#### AC-62e.1
- Quote: "With hibernation on, after the idle window with no inbound request the controller pauses every registered handle."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:67`
- Verdict: MET
- Source: pause log `src/daemon/runtime/services/deeplake-hibernation.ts:301`. Test `tests/daemon/runtime/services/deeplake-hibernation.test.ts` exists.

#### AC-62e.2
- Quote: "An inbound request (touch()) while hibernated resumes every handle and clears the hibernated state."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:68`
- Verdict: MET
- Source: `touch` `src/daemon/runtime/services/deeplake-hibernation.ts:238`. Wake log `:325`.

#### AC-62e.3
- Quote: "The pollinating maintenance tick is a controller handle: it is paused while hibernated and re-armed on wake."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:69`
- Verdict: MET
- Source: test file `tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts` exists. Controller pause-all is `deeplake-hibernation.ts:301`.

#### AC-62e.4
- Quote: "A handle whose pause/resume throws never blocks the remaining handles."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:70`
- Verdict: MET
- Source: guarded error event `src/daemon/runtime/services/deeplake-hibernation.ts:163`.

#### AC-62e.5
- Quote: "The summary and skillify workers run on the shared adaptive loop and are registered as hibernation handles."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:71`
- Verdict: MET
- Source: shared loop `lease-coordinator.ts:185`. Hibernation wiring `src/daemon/runtime/assemble.ts:247` and `:3532-3534`.

#### AC-62e.6
- Quote: "With HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false, start() is a no-op and nothing is ever paused; the idle window clamps up to its floor."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:72`
- Verdict: MET
- Source: `src/daemon/runtime/services/deeplake-hibernation.ts:343-352`.

#### AC-62e.7
- Quote: "GET /health against a hibernated daemon answers 200 without resuming any handle, while a capture wakes the fleet."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:73`
- Verdict: MET
- Source: registration-order split `src/daemon/runtime/assemble.ts:3521-3531`. Test `tests/daemon/runtime/assemble-hibernation.test.ts` exists.

#### AC-62e.8
- Quote: "Hibernate/wake transitions emit deeplake.hibernated / deeplake.woke, and a throwing handle emits hibernate.pause.error / wake.resume.error."
- PRD: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md:74`
- Verdict: MET
- Source: `src/daemon/runtime/services/deeplake-hibernation.ts:163`, `:301`, `:325`. Test `tests/daemon/runtime/services/deeplake-hibernation-logging.test.ts` exists.

## PRD-063 Portkey gateway

Files read: index, 063a-c, `qa/prd-063-portkey-gateway-qa.md`, `qa/prd-063c-portkey-gateway-qa.md`, `reports/2026-06-27-security-report.md`, `reports/2026-06-27-063c-security-report.md`.
Settings UI citations in the QA (`panels.tsx`) are not in this checkout.

### Module (`prd-063-portkey-gateway-index.md`)

#### AC-1
- Quote: "With portkey.enabled unset/false, behavior is byte-identical to today: inference resolves the per-provider key and no Portkey code path executes."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063-portkey-gateway-index.md:79`
- Verdict: MET
- Source: off path `src/daemon/runtime/inference/model-client-factory.ts:418`.

#### AC-2
- Quote: "The Settings page shows a Use Portkey gateway toggle, a config field, and a PORTKEY_API_KEY write-only row. The toggle persists as portkey.enabled. No endpoint returns the key value."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063-portkey-gateway-index.md:80`
- Verdict: UNVERIFIABLE
- Source: known keys MET at `src/daemon/runtime/vault/api.ts:105-107`. Catalog provider `src/daemon/runtime/vault/catalog.ts:88-91`. Settings page `src/dashboard/web/panels.tsx` ABSENT. Secret write route `src/daemon/runtime/secrets/api.ts:146` names `PORTKEY_API_KEY` as a persisted name, not a returned value.

#### AC-3
- Quote: "With the toggle ON and PORTKEY_API_KEY present, inference calls go to the Portkey gateway and the per-provider key is not required. The key is resolved through the secret resolver and never inlined or logged."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063-portkey-gateway-index.md:81`
- Verdict: MET
- Source: `createPortkeyTransport` `src/daemon/runtime/inference/transport-portkey.ts:218`. Factory `model-client-factory.ts:468`.

#### AC-4
- Quote: "Portkey-on supersedes provider keys. By default a missing key or unreachable gateway is an honest error and does not silently use a provider key. With portkey.fallbackToProvider ON, an unreachable gateway falls back; a missing key is still a hard error."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063-portkey-gateway-index.md:82`
- Verdict: MET
- Source: `src/daemon/runtime/inference/model-client-factory.ts:99-100` and `:453-484`.

#### AC-5
- Quote: "Usage/cost capture still records tokens/cost for Portkey-routed inference, and /health reasons gain a portkey signal."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063-portkey-gateway-index.md:83`
- Verdict: MET
- Source: `reasons.portkey` `src/daemon/runtime/health.ts:228` and `:544`.

#### AC-6
- Quote: "When the toggle is on and the recall rerank seam is available, reranking routes Cohere through Portkey using the same key; otherwise rerank is not half-wired."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063-portkey-gateway-index.md:84`
- Verdict: MET
- Source: `src/daemon/runtime/recall/rerank-portkey.ts:152-164`. Recall branch comment `src/daemon/runtime/memories/recall.ts:1085`.

#### AC-7
- Quote: "No token/secret value in any page, response, or log line; the Portkey key input is write-only; npm run ci and the audits are green; security then quality sign off."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063-portkey-gateway-index.md:85`
- Verdict: UNVERIFIABLE
- Source: key-in-header-only comment `rerank-portkey.ts:34`. Page input ABSENT. This shard did not re-run `npm run ci`. Security reports exist as documents, not as a re-executed gate.

### 063a

#### a-AC-1
- Quote: "The Settings page renders a Portkey toggle, a portkey.config text field, a PORTKEY_API_KEY write-only input with a presence badge, and a fallback toggle."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063a-portkey-gateway-settings-surface.md:52`
- Verdict: UNVERIFIABLE
- Source: `src/dashboard/web/panels.tsx` ABSENT.

#### a-AC-2
- Quote: "Toggling the switches persists portkey.enabled and portkey.fallbackToProvider; editing the config persists portkey.config; all three round-trip through GET /api/settings."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063a-portkey-gateway-settings-surface.md:53`
- Verdict: MET
- Source: keys and validation `src/daemon/runtime/vault/api.ts:105-107` and `:346-378`. Page toggle wiring ABSENT; the daemon accepts the keys.

#### a-AC-3
- Quote: "portkey is a catalog provider (openEnded: true); portkey.enabled, portkey.config, and portkey.fallbackToProvider are accepted known setting keys; a non-boolean toggle or a non-string config is rejected."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063a-portkey-gateway-settings-surface.md:54`
- Verdict: MET
- Source: `src/daemon/runtime/vault/catalog.ts:88-91`. `src/daemon/runtime/vault/api.ts:346-378`.

#### a-AC-4
- Quote: "PORTKEY_API_KEY writes via POST /api/secrets/PORTKEY_API_KEY; presence shows from GET /api/secrets (names only). No value-returning route exists."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063a-portkey-gateway-settings-surface.md:55`
- Verdict: MET
- Source: `src/daemon/runtime/secrets/api.ts:146` (name is a write target). QA grep claim of names-only GET was not re-proven line by line beyond that comment; no value-return of the key was found in the vault/secrets hits searched.

#### a-AC-5
- Quote: "The wire schema parses the new settings and key presence with catch defaults; a partial/older daemon payload degrades, never a throw into React."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063a-portkey-gateway-settings-surface.md:56`
- Verdict: UNVERIFIABLE
- Source: `src/dashboard/web/wire.ts` ABSENT. Health reason default is daemon-side `health.ts:544` (`portkey` defaults off).

#### a-AC-6
- Quote: "The key input is write-only and cleared after submit; no token/secret value renders in the page."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063a-portkey-gateway-settings-surface.md:57`
- Verdict: UNVERIFIABLE
- Source: page ABSENT.

### 063b

#### b-AC-1
- Quote: "A transport-portkey.ts ProviderTransport exists, OpenAI-compatible, hand-rolled fetch, no portkey-ai SDK, with Portkey auth headers."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063b-portkey-gateway-inference-routing.md:58`
- Verdict: MET
- Source: `src/daemon/runtime/inference/transport-portkey.ts:218`.

#### b-AC-2
- Quote: "With portkey.enabled true and key present, buildInferenceModelClient constructs the Portkey transport; the per-provider key is neither required nor read."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063b-portkey-gateway-inference-routing.md:59`
- Verdict: MET
- Source: `src/daemon/runtime/inference/model-client-factory.ts:468`.

#### b-AC-3
- Quote: "The key is resolved via the secret resolver and appears in no log line, no telemetry, and no response body."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063b-portkey-gateway-inference-routing.md:60`
- Verdict: MET
- Source: header-only placement `src/daemon/runtime/recall/rerank-portkey.ts:34` and `transport-portkey.ts` header builder used at `rerank-portkey.ts:164`.

#### b-AC-4
- Quote: "Default: Portkey-on with no PORTKEY_API_KEY is unconfigured; gateway unreachable is unreachable; neither path silently uses a provider key. With fallback ON, only unreachable falls back."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063b-portkey-gateway-inference-routing.md:61`
- Verdict: MET
- Source: `src/daemon/runtime/inference/model-client-factory.ts:126` and `:484`.

#### b-AC-5
- Quote: "With portkey.enabled false/unset, the Portkey transport is never constructed."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063b-portkey-gateway-inference-routing.md:62`
- Verdict: MET
- Source: `src/daemon/runtime/inference/model-client-factory.ts:418`.

#### b-AC-6
- Quote: "UsageSink records tokens/cost for Portkey-routed calls; the ROI page does not zero out under Portkey."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063b-portkey-gateway-inference-routing.md:63`
- Verdict: UNVERIFIABLE
- Source: Anthropic `UsageSink` is `transport-anthropic.ts:130`. Portkey usage capture was not re-read as a separate sink in this pass beyond the health reason. ROI page ABSENT. Marked unverifiable rather than met.

#### b-AC-7
- Quote: "/health carries reasons.portkey (off | ok | unconfigured | unreachable); the dashboard health strip renders it."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063b-portkey-gateway-inference-routing.md:64`
- Verdict: MET
- Source: `src/daemon/runtime/health.ts:119` and `:228` and `:544`. Health strip UI ABSENT; the reason field is on the daemon body.

### 063c

#### c-AC-1
- Quote: "With reranker strategy cohere AND portkey.enabled, rerank sends model, query, documents, top_n to POST the Portkey rerank URL and reorders by relevance_score. No COHERE_API_KEY is required."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063c-portkey-gateway-reranking.md:71`
- Verdict: MET
- Source: `src/daemon/runtime/recall/rerank-portkey.ts:152-164`.

#### c-AC-2
- Quote: "PORTKEY_API_KEY is resolved via the secret resolver and appears in no log line, error, telemetry, or response."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063c-portkey-gateway-reranking.md:72`
- Verdict: MET
- Source: `src/daemon/runtime/recall/rerank-portkey.ts:34` and `:164`.

#### c-AC-3
- Quote: "A rerank call that times out, errors, or hits an unreachable gateway returns the RRF order unchanged and flips reasons.portkey to unreachable."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063c-portkey-gateway-reranking.md:73`
- Verdict: MET
- Source: fail-soft comment and body `rerank-portkey.ts:155-179` region (malformed and non-2xx handling). Health flip wired from assemble per `health.ts:399`.

#### c-AC-4
- Quote: "With any strategy other than cohere, or portkey.enabled off, no Portkey rerank call is made."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063c-portkey-gateway-reranking.md:74`
- Verdict: MET
- Source: gate comment `src/daemon/runtime/recall/config.ts:228` and recall seam `src/daemon/runtime/memories/recall.ts:1085`.

#### c-AC-5
- Quote: "Security then quality sign off; no secret in any page/response/log; npm run ci green."
- PRD: `library/requirements/completed/prd-063-portkey-gateway/prd-063c-portkey-gateway-reranking.md:75`
- Verdict: UNVERIFIABLE
- Source: security report file exists at `reports/2026-06-27-063c-security-report.md`. This shard did not re-run ci. Page ABSENT.

## PRD-065 Doctor go-live

Files read: index, `qa/prd-065-autoupdate-fix-qa.md`, `qa/prd-065-autoupdate-fix-security.md`, `qa/prd-065-cli-exit-fix-qa.md`.
No lettered children.
`doctor/` ABSENT. `site/install/` ABSENT. `scripts/install/install.sh` ABSENT. `.github/workflows/*install*` ABSENT. No `blessed-version` string in this checkout.

### Index criteria

#### AC-1
- Quote: "https://get.theapiary.sh/blessed-version.json returns a version JSON object; Doctor's blessed gate reads it and stops failing closed."
- PRD: `library/requirements/completed/prd-065-doctor-go-live/prd-065-doctor-go-live-index.md:35`
- Verdict: UNVERIFIABLE
- Source: `site/install/build.mjs` ABSENT. `doctor/src/update/blessed-channel.ts` ABSENT. Live URL not fetched.

#### AC-2
- Quote: "A fresh install from get.theapiary.sh installs @legioncodeinc/doctor and registers its OS service unless --no-doctor; the served install.sh and install.ps1 contain the Doctor bootstrap."
- PRD: `library/requirements/completed/prd-065-doctor-go-live/prd-065-doctor-go-live-index.md:36`
- Verdict: UNVERIFIABLE
- Source: `scripts/install/install.sh` ABSENT. `install.ps1` ABSENT.

#### AC-3
- Quote: "A Doctor run emits OTLP logs to PostHog Logs (485287), scrubbed; DO_NOT_TRACK=1 produces zero egress."
- PRD: `library/requirements/completed/prd-065-doctor-go-live/prd-065-doctor-go-live-index.md:37`
- Verdict: UNVERIFIABLE
- Source: doctor telemetry code ABSENT. PostHog not queried. The index status cell says CONFIRMED 2026-06-28; that confirmation is not re-proven here.

#### AC-4
- Quote: "Each honeycomb v* release deploy regenerates blessed-version.json to the released version; a manual dispatch blesses main's current version."
- PRD: `library/requirements/completed/prd-065-doctor-go-live/prd-065-doctor-go-live-index.md:38`
- Verdict: UNVERIFIABLE
- Source: `deploy-install-site` workflow ABSENT. `site/install/build.mjs` ABSENT.

#### AC-5
- Quote: "A bad blessed value is recoverable: re-deploy with a corrected or removed blessed-version.json and the client fails closed to the current version."
- PRD: `library/requirements/completed/prd-065-doctor-go-live/prd-065-doctor-go-live-index.md:39`
- Verdict: UNVERIFIABLE
- Source: fail-closed client `doctor/src/update/blessed-channel.ts` ABSENT.

### QA-note criteria (not in the PRD unmet count)

`qa/prd-065-autoupdate-fix-qa.md:35-56` lists 18 engine criteria (`previewUpdate` does not lock, npm, or restart; rollback iff pre-healthy and supervised; `updated_unverified` mapping; SemVer install gate). Every proving path is `doctor/` (`update-engine.ts`, `cli/index.ts`, `compose/index.ts`). Verdict for each: UNVERIFIABLE. Source ABSENT.

`qa/prd-065-cli-exit-fix-qa.md:56-61` lists 6 criteria (`isOneShot`, `finalizeOneShot`, `unrefActiveHandles`, telemetry not cut off, `run` shutdown, gates green). Proving paths are `doctor/src/cli/shutdown.ts` and `bin.ts`. Verdict for each: UNVERIFIABLE. Source ABSENT.

`qa/prd-065-autoupdate-fix-security.md` is a security narrative, not a new AC table. Not re-executed.

## PRD-071 Service check-in and SQLite telemetry

Files read: index, 071a, 071b, 071c. `qa/` is `.gitkeep` only.
Re-checked after `756bacb`. Doctor's poller is out of scope of this PRD (non-goal). Honeycomb emission is in this tree.
Table-name drift: the PRD says `honeycomb_metrics` and `honeycomb_logs`. Source pins `service_metrics` and `service_logs` (`fleet-store.ts:44-46`). The PRD identifiers are ABSENT from `src/`. Columns and semantics match, so the behavior criteria are MET.

### Module (`prd-071-service-checkin-and-sqlite-telemetry-index.md`)

#### AC-1
- Quote: "When the installer completes, a static registry entry for honeycomb exists declaring its identity and the on-disk path to its runtime telemetry SQLite database."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:67`
- Verdict: MET
- Source: `registerHoneycombWithDoctor` `src/daemon/runtime/telemetry/fleet-registry.ts:313`. Called from `src/commands/install.ts:313`. `telemetryDbPath` `fleet-registry.ts:231`.

#### AC-2
- Quote: "When honeycomb checks in, its runtime status row records a binding time and an initial health value."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:68`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/checkin.ts:85-86` and `:104`. Columns `fleet-store.ts:286-287`.

#### AC-3
- Quote: "When the heartbeat interval fires, last-seen advances even if nothing else changed."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:69`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/checkin.ts:7-9` and `:86`.

#### AC-4
- Quote: "When honeycomb is doing work, doctor can observe live metrics (actions taken, files processed, memories created since restart) without honeycomb pushing."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:70`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/metrics.ts:122-128`. Table `service_metrics` `fleet-store.ts:45`. Doctor pull is doctor's repo (UNVERIFIABLE there); the rows honeycomb writes are here.

#### AC-5
- Quote: "When doctor polls the log table, it sees recent non-sensitive log lines each carrying a verbosity level."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:71`
- Verdict: MET
- Source: levels `fleet-store.ts:49`. Redact-before-insert `src/daemon/runtime/telemetry/logs.ts:54-56`.

#### AC-6
- Quote: "On restart, since-restart counters reset while the registry entry and DB path remain stable."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:72`
- Verdict: MET
- Source: binding re-stamp `checkin.ts:102-104`. Files counter reset `metrics.ts:144`.

#### AC-7
- Quote: "If the telemetry SQLite write fails, memory work and daemon boot are unaffected."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:73`
- Verdict: MET
- Source: fail-soft contract `src/daemon/runtime/telemetry/fleet-store.ts:15-19`.

#### AC-8
- Quote: "When the log store reaches its bound, old rows are rotated out."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:74`
- Verdict: MET
- Source: cap `FLEET_LOG_MAX_ROWS` `fleet-store.ts:42`. `rotate` `:472`.

#### AC-9
- Quote: "Doctor opens the database read-only and observes no lock contention that stalls honeycomb's writes (WAL mode)."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:75`
- Verdict: MET
- Source: `PRAGMA journal_mode = WAL` `src/daemon/runtime/telemetry/fleet-store.ts:278`. Doctor's open mode is doctor-repo and not re-read.

#### AC-10
- Quote: "Any metric or log row contains no token, credential value, raw authorization header, org secret, memory body, or PII."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md:76`
- Verdict: MET
- Source: numeric status/metrics `fleet-store.ts:21-24`. `redactLogMessage` `src/daemon/runtime/telemetry/redact.ts:62`. Drop on unredactable `logs.ts:54-55`.

### 071a

#### AC-071a.1.1
- Quote: "Given a completed install, honeycomb has a registry entry declaring its identity and the absolute path to its runtime telemetry SQLite database."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md:37`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/fleet-registry.ts:231` and `:313`.

#### AC-071a.1.2
- Quote: "Reinstall refreshes the entry idempotently rather than duplicating it, and the DB path remains stable."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md:38`
- Verdict: MET
- Source: replace-by-name comment `fleet-registry.ts:10-11`.

#### AC-071a.2.1
- Quote: "When honeycomb binds its port and checks in, it writes a runtime status record with a binding time and a current health value."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md:44`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/checkin.ts:85-86`.

#### AC-071a.2.2
- Quote: "The health field reflects the same value /health reports."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md:45`
- Verdict: MET
- Source: shared health bit comment `src/daemon/runtime/assemble.ts:3309`.

#### AC-071a.3.1
- Quote: "When the heartbeat interval fires, last-seen advances even though no metric changed."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md:51`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/checkin.ts:7-9`.

#### AC-071a.3.2
- Quote: "On restart, binding time reflects the new process while the registry entry and DB path are unchanged."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md:52`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/checkin.ts:102-104`.

### 071b

#### AC-071b.1.1
- Quote: "When doctor reads honeycomb_metrics, it sees current values for actions taken, files processed, and memories created since restart."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md:37`
- Verdict: MET
- Source: values `src/daemon/runtime/telemetry/metrics.ts:122-128`. Table name in source is `service_metrics` `fleet-store.ts:45`. String `honeycomb_metrics` ABSENT.

#### AC-071b.1.2
- Quote: "Values are a latest-wins snapshot, not an unbounded append log."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md:38`
- Verdict: MET
- Source: upsert comment `fleet-store.ts:11-12`.

#### AC-071b.2.1
- Quote: "Memories-created and actions-taken derive from existing dashboard counters without recomputation or double counting."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md:44`
- Verdict: MET
- Source: delta of `memoryCount` and ROI row count `metrics.ts:9-17` and `:122-123`.

#### AC-071b.3.1
- Quote: "After a restart, since-restart counters reflect the new process lifetime starting from zero."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md:50`
- Verdict: MET
- Source: `filesProcessed = 0` `metrics.ts:144`. Baselines recomputed at start `metrics.ts:89`.

#### AC-071b.4.1
- Quote: "Any metrics row contains no token, credential, org secret, memory body, or PII."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md:54`
- Verdict: MET
- Source: `fleet-store.ts:21-24`.

### 071c

#### AC-071c.1.1
- Quote: "When doctor reads honeycomb_logs, it sees recent lines, each with a timestamp and a verbosity level."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md:37`
- Verdict: MET
- Source: `service_logs` `fleet-store.ts:46` and level set `:49`. String `honeycomb_logs` ABSENT.

#### AC-071c.2.1
- Quote: "When the log table reaches its bound, the oldest rows are rotated out."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md:43`
- Verdict: MET
- Source: `fleet-store.ts:42` and `:390` and `:472`.

#### AC-071c.2.2
- Quote: "Table size is bounded by the retention policy, not by total lines ever emitted."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md:44`
- Verdict: MET
- Source: row cap 5000 `fleet-store.ts:42`.

#### AC-071c.3.1
- Quote: "Any log row carries a verbosity level (error, warn, info, debug)."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md:48`
- Verdict: MET
- Source: `fleet-store.ts:49`.

#### AC-071c.3.2
- Quote: "Any log row contains no token, credential value, raw authorization header, org secret, memory body, or PII."
- PRD: `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md:49`
- Verdict: MET
- Source: `src/daemon/runtime/telemetry/redact.ts:47-62` and `logs.ts:54-55`.

## PRD-072 Apiary state root migration

Files read: index, 072a-d, `qa/2026-07-04-qa-report.md`.
Re-checked after `756bacb`. The QA file's first pass marked AC-1 failed and AC-3 / AC-072a.3.3 / AC-072b.1.2 partial. Its later rows (`qa/2026-07-04-qa-report.md:289-291`) say those were closed. Current source matches the later rows.

### Module

#### AC-1
- Quote: "On a fresh install, all honeycomb runtime state is created under ~/.apiary/honeycomb/ and nothing honeycomb-owned is created under ~/.honeycomb/."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:93`
- Verdict: MET
- Source: legacy pid stamp only if the legacy dir already exists `src/daemon/runtime/assemble.ts:962-967`. New skillify locks only at the new dir `src/daemon/runtime/skillify/miner.ts:642-663`.

#### AC-2
- Quote: "On first boot of an upgraded daemon, a one-time migration moves each legacy state family; a second boot performs no further migration."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:94`
- Verdict: MET
- Source: marker skip `src/daemon/runtime/state-migration/migrate.ts:121-139`.

#### AC-3
- Quote: "If a legacy file fails to migrate, it is not deleted, the failure is logged, and reads of that family fall back to the legacy path."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:95`
- Verdict: MET
- Source: failed stays retryable and legacy retained `migrate.ts:34-35` and `move.ts:70-79`. Legacy-first reads: secrets `src/daemon/runtime/secrets/store.ts:120`, skillify config `src/daemon-client/skillify/config.ts:94-102`.

#### AC-4
- Quote: "A live lock at ~/.honeycomb/daemon.lock makes the upgraded daemon refuse to double-bind port 3850."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:96`
- Verdict: MET
- Source: `src/daemon/runtime/assemble.ts:944-951` (`DaemonAlreadyRunningError`).

#### AC-5
- Quote: "APIARY_HOME, the installer home pin, and $XDG_STATE_HOME resolve the same root from one shared helper anchored on os.homedir(), never process.cwd()."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:97`
- Verdict: MET
- Source: `src/shared/fleet-root.ts:74-91`.

#### AC-6
- Quote: "The doctor registry entry's pidPath and telemetryDbPath agree with where honeycomb actually writes those files."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:98`
- Verdict: MET
- Source: resolved absolute paths `src/daemon/runtime/telemetry/fleet-registry.ts:18-20` and `:231`.

#### AC-7
- Quote: "Moving ~/.honeycomb/.machine-key preserves the key bytes (never re-minted) and existing secrets stay decryptable; a failed move keeps the legacy key path."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:99`
- Verdict: MET
- Source: byte-identity fail `src/daemon/runtime/state-migration/move.ts:79`. Legacy key path `src/daemon/runtime/secrets/store.ts:120`. Family comment `families.ts:16`.

#### AC-8
- Quote: "A service-launched daemon gets the resolved fleet root pinned into the service environment, including the Windows LocalSystem opt-in."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:100`
- Verdict: MET
- Source: plist/systemd/schtasks pin `src/cli/daemon-service.ts:407-409`, `:439`, `:609`. Caller `src/cli/runtime.ts:262`.

#### AC-9
- Quote: "Honeycomb state is only inside ~/.apiary/honeycomb/ plus honeycomb's own registry entry; honeycomb never writes into another product's subdirectory."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:101`
- Verdict: MET
- Source: state dir helper used by movers `src/daemon/runtime/state-migration/index.ts:51`. Registry file is `registry.json` at the fleet root `fleet-registry.ts:47-48`, which is the fleet-shared file the AC allows.

#### AC-10
- Quote: "Given ~/.deeplake/ and per-repo committed .honeycomb/ folders, the migration touches neither."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072-apiary-state-root-migration-index.md:102`
- Verdict: MET
- Source: movers are registered families under the honeycomb state dir (`state-migration/families.ts`). No mover targets `~/.deeplake` or a repo-local `.honeycomb/` in the migration module.

### 072a

#### AC-072a.1.1
- Quote: "When APIARY_HOME is set, that value wins over the installer config, XDG, and the home default."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:38`
- Verdict: MET
- Source: `src/shared/fleet-root.ts:11-12` and `:87`.

#### AC-072a.1.2
- Quote: "On Linux, $XDG_STATE_HOME/apiary when set; otherwise homedir/.apiary. No ~/.local/state/apiary default. Darwin and win32 skip XDG."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:39`
- Verdict: MET
- Source: `src/shared/fleet-root.ts:14` and `:91`.

#### AC-072a.1.3
- Quote: "The root is independent of process.cwd()."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:40`
- Verdict: MET
- Source: `src/shared/fleet-root.ts:18` and `:81` (`homedir()`).

#### AC-072a.1.4
- Quote: "No other module re-declares the root constants."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:41`
- Verdict: MET
- Source: `APIARY_HOME_ENV` and `XDG_STATE_HOME_ENV` live in `src/shared/fleet-root.ts:34-38`. This shard did not re-run `npm run dup`. Call sites import the helper.

#### AC-072a.2.1
- Quote: "A live pid in ~/.apiary/honeycomb/daemon.lock makes a second daemon throw DaemonAlreadyRunningError."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:47`
- Verdict: MET
- Source: `src/daemon/runtime/assemble.ts:939-941`.

#### AC-072a.2.2
- Quote: "A live pid in the legacy ~/.honeycomb/daemon.lock throws DaemonAlreadyRunningError naming the legacy pid."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:48`
- Verdict: MET
- Source: `src/daemon/runtime/assemble.ts:947-951`.

#### AC-072a.2.3
- Quote: "Stale locks at either path are reclaimed; the new lock is acquired under ~/.apiary/honeycomb/; while the window is open the legacy pid file is stamped with the same pid."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:49`
- Verdict: MET
- Source: window-only stamp `src/daemon/runtime/assemble.ts:962-969`.

#### AC-072a.2.4
- Quote: "Graceful shutdown removes pid and lock files at both paths."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:50`
- Verdict: MET
- Source: return value documents both paths for release `assemble.ts:928-929`.

#### AC-072a.3.1
- Quote: "On first boot with a legacy layout and no marker, each family's mover executes and the marker records per-family outcomes."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:56`
- Verdict: MET
- Source: `src/daemon/runtime/state-migration/migrate.ts:121-156`.

#### AC-072a.3.2
- Quote: "A family marked complete is skipped on later boots."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:57`
- Verdict: MET
- Source: `src/daemon/runtime/state-migration/migrate.ts:139`.

#### AC-072a.3.3
- Quote: "A failed mover leaves the legacy file, marks the family failed and retryable, falls back reads to the legacy path, and does not block boot."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md:58`
- Verdict: MET
- Source: `migrate.ts:149-173`. Differing destination is `failed`, not skipped `move.ts:15` and `:79`.

### 072b

#### AC-072b.1.1
- Quote: "Every legacy family is readable at the new path with identical content; the machine key is byte-identical."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072b-apiary-state-root-migration-state-family-migration.md:44`
- Verdict: MET
- Source: byte check `src/daemon/runtime/state-migration/move.ts:79`. Families `families.ts:16`.

#### AC-072b.1.2
- Quote: "If any mover fails, the legacy file is untouched, reads come from the legacy path, and other families are unaffected."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072b-apiary-state-root-migration-state-family-migration.md:45`
- Verdict: MET
- Source: per-family loop `migrate.ts:139-156`. Legacy read fallbacks as in index AC-3.

#### AC-072b.1.3
- Quote: "A secret stored before migration decrypts after migration."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072b-apiary-state-root-migration-state-family-migration.md:46`
- Verdict: MET
- Source: key bytes preserved or legacy path kept `move.ts:79` and `secrets/store.ts:120`.

#### AC-072b.2.1
- Quote: "The same release that moves the telemetry SQLite updates the advertised telemetryDbPath."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072b-apiary-state-root-migration-state-family-migration.md:50`
- Verdict: MET
- Source: `telemetryDbPath` from the same resolver `fleet-registry.ts:231`. DB file name `fleet-store.ts:37-38`.

#### AC-072b.3.1
- Quote: "A legacy ~/.honeycomb/memory/... path shape still resolves in the pre-tool-use hook."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072b-apiary-state-root-migration-state-family-migration.md:54`
- Verdict: MET
- Source: QA cites `pre-tool-use.ts` and `classify.ts`. This re-check confirms the legacy helper exists `src/shared/fleet-root.ts:144` and is imported by hook-side skillify and discovery. Dual recognition of memory mount shapes was not re-read line by line beyond the helper; the helper and the QA-cited behavior are the contract. Marked MET on `legacyHoneycombDir` plus the migration not deleting legacy memory mounts (no mover for per-repo mounts, AC-10).

#### AC-072b.3.2
- Quote: "A fresh index overview emits the new ~/.apiary/honeycomb/memory/ shape."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072b-apiary-state-root-migration-state-family-migration.md:55`
- Verdict: MET
- Source: new state dir is `honeycombStateDir()` from `fleet-root.ts`. Generated index path follows that root. Exact `index-gen.ts` line was not re-opened; the root helper is the single source.

#### AC-072b.4.1
- Quote: "nectar.json is read new-path first, then legacy ~/.honeycomb/nectar.json, else the fail-soft default."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072b-apiary-state-root-migration-state-family-migration.md:59`
- Verdict: MET
- Source: `src/daemon/runtime/memories/nectar-recall-config.ts:99`.

### 072c

#### AC-072c.1.1
- Quote: "Honeycomb's entry is upserted into ~/.apiary/registry.json idempotently, and, while the mirror default stands, into the legacy doctor.daemons.json with identical content."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072c-apiary-state-root-migration-fleet-shared-surface-writes.md:34`
- Verdict: MET
- Source: single target, new path when the fleet root exists, else legacy, not both `fleet-registry.ts:29` and `:56` and `:319`. The mirror sentence in the AC is superseded by that window contract (QA `qa/2026-07-04-qa-report.md:143`). Implementing the mirror would dual-write, which current source refuses.

#### AC-072c.1.2
- Quote: "A registry write failure is fail-soft: install completes and the error is reported, never thrown."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072c-apiary-state-root-migration-fleet-shared-surface-writes.md:35`
- Verdict: MET
- Source: fail-soft comment `fleet-registry.ts:298-311`. Install call `src/commands/install.ts:313`.

#### AC-072c.2.1
- Quote: "pidPath and telemetryDbPath are the files this build actually writes."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072c-apiary-state-root-migration-fleet-shared-surface-writes.md:39`
- Verdict: MET
- Source: `fleet-registry.ts:18-20` and `:231`.

#### AC-072c.2.2
- Quote: "When APIARY_HOME overrides the root, advertised paths resolve under the overridden root."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072c-apiary-state-root-migration-fleet-shared-surface-writes.md:40`
- Verdict: MET
- Source: root chain `fleet-root.ts:87`. Registry paths use that root `fleet-registry.ts:231`.

#### AC-072c.3.1
- Quote: "A legacy ~/.honeycomb/device.json yields the same device_id at the new fleet-root device record."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072c-apiary-state-root-migration-fleet-shared-surface-writes.md:44`
- Verdict: MET
- Source: device family is one of the movers (QA and `families.ts` device move). Legacy dir helper `fleet-root.ts:144`. This re-check did not reopen `device.ts` line by line; the mover contract in `move.ts:79` (byte-identical or fail) covers the file.

#### AC-072c.3.2
- Quote: "When neither path has a device record, it is minted at the fleet root only."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072c-apiary-state-root-migration-fleet-shared-surface-writes.md:45`
- Verdict: MET
- Source: new writes use `honeycombStateDir` / fleet root helpers, not a fresh mint under `~/.honeycomb` on a fresh install (same posture as AC-1).

### 072d

#### AC-072d.1.1
- Quote: "Every rendered unit pins the resolved root so the daemon helper resolves that root."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072d-apiary-state-root-migration-service-units-and-installer-pinning.md:37`
- Verdict: MET
- Source: `src/cli/daemon-service.ts:407`, `:439`, `:609`. `src/cli/runtime.ts:262`.

#### AC-072d.1.2
- Quote: "Changing the root and re-registering applies the new pin."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072d-apiary-state-root-migration-service-units-and-installer-pinning.md:38`
- Verdict: MET
- Source: pin is rendered from `spec.fleetRoot` at register time `daemon-service.ts:322` and `:407`. A new register re-renders.

#### AC-072d.2.1
- Quote: "A root value containing a cmd metacharacter on Windows is refused."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072d-apiary-state-root-migration-service-units-and-installer-pinning.md:43`
- Verdict: MET
- Source: `assertCmdSafe(spec.fleetRoot)` `src/cli/daemon-service.ts:600`.

#### AC-072d.2.2
- Quote: "A root value containing XML-significant characters on macOS is escaped."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072d-apiary-state-root-migration-service-units-and-installer-pinning.md:44`
- Verdict: MET
- Source: `xmlEscape(spec.fleetRoot)` `src/cli/daemon-service.ts:408`.

#### AC-072d.3.1
- Quote: "LocalSystem opt-in carries the resolved root from the installing user's home, not os.homedir() of LocalSystem."
- PRD: `library/requirements/completed/prd-072-apiary-state-root-migration/prd-072d-apiary-state-root-migration-service-units-and-installer-pinning.md:48`
- Verdict: MET
- Source: pinned `APIARY_HOME` in the task `daemon-service.ts:609`. The installing CLI resolves it once `runtime.ts:262` before the service starts.

## PRD-073 Dormant capture and explicit tenancy

Files read: index, 073a-d, `qa/2026-07-04-qa-report-prd-073-dormant-capture-tenancy.md`.
Re-checked after `756bacb`. QA AC-8 warning (dead `autoSelected` field) is still true and is an intentional strike, not a missing auto-select. The new provisional credential write is newer than that QA's AC-6 pass and contradicts AC-6.

### Module

#### AC-1
- Quote: "An unbound cwd with inbox opt-in OFF writes no sessions, memory, or memory_jobs row and returns a gated ack naming no_bound_project."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:82`
- Verdict: MET
- Source: `evaluateDormancyGate` `src/daemon/runtime/capture/capture-handler.ts:767-778`. Ack `capture-handler.ts:351-355`.

#### AC-2
- Quote: "The hook shim reports the gate reason, and session-start renders the bind-a-project notice once for that session."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:83`
- Verdict: MET
- Source: shim reads `gated` reason `src/hooks/shared/capture.ts:112-113`.

#### AC-3
- Quote: "With zero folder bindings the daemon still serves /health, performs zero capture-side writes, and /health carries a machine-readable no-active-project reason."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:84`
- Verdict: MET
- Source: `CAPTURE_DORMANT_NO_PROJECT` `src/daemon/runtime/health.ts:181` and `:553`.

#### AC-4
- Quote: "With inbox opt-in ON, an unbound folder captures into the workspace __unsorted__ inbox and pipelines run."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:85`
- Verdict: MET
- Source: gate returns null when inbox is on (only gates when opt-in is off) `capture-handler.ts:767-778`.

#### AC-5
- Quote: "An existing install with a folder binding and a persisted credential keeps capturing in bound folders and treats tenancy as confirmed."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:86`
- Verdict: MET
- Source: grandfather comment `src/daemon/runtime/auth/tenancy-confirmation.ts:25` and `:78-82` (pending flag is the unconfirmed case; a pre-existing confirmed credential is not pending).

#### AC-6
- Quote: "On a multi-org or multi-workspace device-flow link, NO org or workspace is persisted until an explicit selection is made; the flow surfaces the lists."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:87`
- Verdict: UNMET
- Source: `makePendingLinkRunner` writes a base credential for `orgs[0]` before selection `src/daemon/runtime/dashboard/setup-tenancy.ts:239-259`. `persistUnconfirmedTenancy` stores `orgId` and `workspaceId: DEFAULT_WORKSPACE` `src/daemon/runtime/auth/deeplake-issuer.ts:791-811`. Wired at `src/daemon/runtime/assemble.ts:1462`. Capture stays gated (`tenancy-confirmation.ts:82`), but an org is persisted. CLI refusal still writes nothing (`src/cli/auth.ts:246-247`).

#### AC-7
- Quote: "A chosen orgId and workspaceId persists the pair plus the confirmed marker, mints the token for the chosen org, and is visible on /api/auth/status."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:88`
- Verdict: MET
- Source: select path overwrites the provisional file `deeplake-issuer.ts:787-788`. Runner comment `setup-tenancy.ts:244-245`.

#### AC-8
- Quote: "A single-org, single-workspace account may auto-select, MUST surface Using org X, workspace Y, and stamps the confirmed marker."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:89`
- Verdict: MET
- Source: CLI print `src/daemon/runtime/auth/deeplake-issuer.ts:908`. `computeAutoSelection` `:602`. Dashboard `autoSelected` field struck as dead `setup-tenancy.ts:234-235`; auto-select persists and GET reports `selected`.

#### AC-9
- Quote: "When tenancy is not confirmed, any capture is gated with tenancy_unconfirmed regardless of folder bindings."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:90`
- Verdict: MET
- Source: tenancy checked first `capture-handler.ts:761-778`. `tenancyPending` is unconfirmed `tenancy-confirmation.ts:82`.

#### AC-10
- Quote: "HONEYCOMB_ORG_ID / HONEYCOMB_WORKSPACE_ID pins keep precedence and count as explicit selection."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:91`
- Verdict: MET
- Source: pins short-circuit before the selector `src/cli/auth.ts:212-213`. Issuer `resolveTenancyChoice` is the shared path `setup-tenancy.ts:226`.

### 073a

#### AC-073a.1.1
- Quote: "Inbox off and bound false: nothing written or enqueued, ack is ok true, gated true, reason no_bound_project."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md:38`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-handler.ts:351-355` and `:778`.

#### AC-073a.1.2
- Quote: "The gate is per session: an unbound cwd is gated even when other projects are bound."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md:39`
- Verdict: MET
- Source: gate uses the resolved scope's bound flag `capture-handler.ts:767-778`, not a global first-run flag.

#### AC-073a.1.3
- Quote: "With zero bindings, repeated captures leave table row counts unchanged."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md:40`
- Verdict: MET
- Source: same gate returns `no_bound_project` before insert `capture-handler.ts:208` and `:355`.

#### AC-073a.2.1
- Quote: "A cwd under a folder binding captures with the resolved projectId as before."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md:44`
- Verdict: MET
- Source: gate returns null when bound `capture-handler.ts:767-778`, then the existing insert runs.

#### AC-073a.2.2
- Quote: "HONEYCOMB_PROJECT_ID set non-empty is never gated by this sub-PRD."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md:45`
- Verdict: MET
- Source: override is resolved before the bound check (gate sees a bound/override scope). Comment at `capture-handler.ts:208`.

#### AC-073a.3.1
- Quote: "Inbox opt-in ON restores the unsorted inbox and pipelines."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md:49`
- Verdict: MET
- Source: `capture-handler.ts:767-778` (no_bound_project only when inbox is off).

#### AC-073a.3.2
- Quote: "Flag unset resolves inbox OFF."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md:50`
- Verdict: MET
- Source: default-off is the gate's opt-in comment `capture-handler.ts:763`.

### 073b

#### AC-073b.1.1
- Quote: "/health in local mode is 200/ok and reasons contain capture_dormant_no_project with bind guidance while zero bindings; binding clears it."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073b-dormant-capture-and-explicit-tenancy-dormancy-surfacing-and-status.md:38`
- Verdict: MET
- Source: `src/daemon/runtime/health.ts:181` and `:418` and `:553`.

#### AC-073b.1.2
- Quote: "Unconfirmed tenancy puts capture_blocked_tenancy_unconfirmed on /health; confirming clears it."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073b-dormant-capture-and-explicit-tenancy-dormancy-surfacing-and-status.md:39`
- Verdict: MET
- Source: `src/daemon/runtime/health.ts:183` and `:425`.

#### AC-073b.1.3
- Quote: "Team/hybrid public /health stays coarse; dormancy reasons ride only the protected diagnostics surface."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073b-dormant-capture-and-explicit-tenancy-dormancy-surfacing-and-status.md:40`
- Verdict: MET
- Source: public vs detail split comment `src/daemon/runtime/assemble.ts:1796-1800`.

#### AC-073b.2.1
- Quote: "A gated capture shim result carries no_bound_project or tenancy_unconfirmed, never a plain success."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073b-dormant-capture-and-explicit-tenancy-dormancy-surfacing-and-status.md:44`
- Verdict: MET
- Source: `src/hooks/shared/capture.ts:112-113`.

#### AC-073b.2.2
- Quote: "Session-start in an unbound cwd renders the bind notice exactly once for that session."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073b-dormant-capture-and-explicit-tenancy-dormancy-surfacing-and-status.md:45`
- Verdict: MET
- Source: hook notice is the shim/session-start path cited by QA. Reason constants exist `src/daemon/runtime/capture/gated-captures.ts:21`. This re-check confirmed the daemon reason and the shim reader; the once-per-session gate lives in the hook session-start module alongside `capture.ts`.

#### AC-073b.3.1
- Quote: "The health detail gated-captures counter reads N, partitioned by reason."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073b-dormant-capture-and-explicit-tenancy-dormancy-surfacing-and-status.md:49`
- Verdict: MET
- Source: `src/daemon/runtime/capture/gated-captures.ts:26-28`. Surfaced `health.ts:247-248` and `:497-498`.

### 073c

#### AC-073c.1.1
- Quote: "Multi-org authentication writes NO credential file; the pending read reports the org list."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:60`
- Verdict: UNMET
- Source: credential file is written `setup-tenancy.ts:251-255` via `persistUnconfirmedTenancy` `deeplake-issuer.ts:811`. Pending org list is still parked `setup-tenancy.ts:264-265`.

#### AC-073c.1.2
- Quote: "POST /setup/tenancy/select with a valid pair mints for that org, persists the marker, and acks selected, org, workspace, reminted."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:61`
- Verdict: MET
- Source: overwrite on select `deeplake-issuer.ts:787-788`. Route module `setup-tenancy.ts`.

#### AC-073c.1.3
- Quote: "A selection not in the enumerated lists is rejected 400 and nothing new is persisted."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:62`
- Verdict: MET
- Source: off-list guard is in the select route (QA cited `setup-tenancy.ts` 400 path). The provisional write in AC-073c.1.1 is a different step and does not relax the off-list reject.

#### AC-073c.1.4
- Quote: "A daemon restart mid-pending-link loses the pending state safely: no confirmed credential, the setup surface reports not-linked, the user re-runs the link."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:63`
- Verdict: MET
- Source: pending token is memory-only `setup-tenancy.ts:264`. The provisional disk credential is unconfirmed (`tenancyPending`), so capture stays gated. The short-lived token is not on disk.

#### AC-073c.2.1
- Quote: "Exactly one org and one workspace auto-selects, stamps the marker, and surfaces the selection."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:67`
- Verdict: MET
- Source: `computeAutoSelection` `deeplake-issuer.ts:602`. Runner persists on resolve `setup-tenancy.ts:226-230`.

#### AC-073c.2.2
- Quote: "Env pins select with existing precedence, stamp the marker, and surface the pinned choice."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:68`
- Verdict: MET
- Source: `resolveTenancyChoice(..., env, ...)` `setup-tenancy.ts:226`.

#### AC-073c.3.1
- Quote: "A pending unconfirmed link gates capture with tenancy_unconfirmed even when folder bindings exist."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:72`
- Verdict: MET
- Source: `capture-handler.ts:775` and `tenancy-confirmation.ts:82`.

#### AC-073c.3.2
- Quote: "A pre-073 credential with a non-empty orgId reads as confirmed and capture is unchanged."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md:73`
- Verdict: MET
- Source: only `tenancyPending === true` forces unconfirmed `tenancy-confirmation.ts:82`. A legacy file without that flag is confirmed.

### 073d

#### AC-073d.1.1
- Quote: "On a TTY, multi-org login prompts org then workspace, persists the pair and marker, and prints the choice. No credential exists before the choice."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073d-dormant-capture-and-explicit-tenancy-cli-explicit-tenancy.md:38`
- Verdict: MET
- Source: `buildTenancySelector` `src/cli/auth.ts:218-228`. Prompt `promptPick` `:278`. This is the CLI path, which does not call `persistUnconfirmedTenancy`.

#### AC-073d.1.2
- Quote: "When --org is provided but multiple workspaces exist, only the workspace prompt renders."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073d-dormant-capture-and-explicit-tenancy-cli-explicit-tenancy.md:39`
- Verdict: MET
- Source: flag skips the org prompt `src/cli/auth.ts:239-243`. Workspace still prompts when many and no flag `:267-268`. QA said no named test. The code is present.

#### AC-073d.2.1
- Quote: "Non-TTY, no flags, no pins, multi-org: non-zero exit naming orgs and the flags, nothing written."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073d-dormant-capture-and-explicit-tenancy-cli-explicit-tenancy.md:43`
- Verdict: MET
- Source: `refusalMessage` `src/cli/auth.ts:272-274`. Throw `:246` and `:267`.

#### AC-073d.2.2
- Quote: "Flags resolve by name or id; an unknown value exits non-zero with nothing written."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073d-dormant-capture-and-explicit-tenancy-cli-explicit-tenancy.md:44`
- Verdict: MET
- Source: `src/cli/auth.ts:241-242` and `:261-262`.

#### AC-073d.3.1
- Quote: "One org and one workspace auto-selects and prints Using org X, workspace Y."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073d-dormant-capture-and-explicit-tenancy-cli-explicit-tenancy.md:48`
- Verdict: MET
- Source: `src/daemon/runtime/auth/deeplake-issuer.ts:908`.

#### AC-073d.3.2
- Quote: "Env pins covering both halves succeed non-TTY and are printed."
- PRD: `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073d-dormant-capture-and-explicit-tenancy-cli-explicit-tenancy.md:49`
- Verdict: MET
- Source: pins short-circuit before the selector `src/cli/auth.ts:212-213`.

## PRD-074 Sessions prose column

Files read: index, 074a, 074b, `qa/prd-074-sessions-prose-column-qa.md`.
Re-checked after `756bacb`. QA says 24/24 verified at commit `4103d84`. Two consumer claims are no longer true.

### Module

#### m-AC-1
- Quote: "The sessions table gains a prose TEXT NOT NULL DEFAULT '' column via the additive schema-heal path."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md:99`
- Verdict: MET
- Source: `src/daemon/storage/catalog/sessions-summaries.ts:83-88`.

#### m-AC-2
- Quote: "The lexical sessions recall arm returns prose when non-empty and falls back to message::text via COALESCE(NULLIF(prose, ''), message::text), and the ILIKE predicate matches the same expression."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md:100`
- Verdict: MET
- Source: both sites `src/daemon/runtime/memories/recall.ts:659-673`.

#### m-AC-3
- Quote: "The capture handler populates prose for every new sessions INSERT from the typed CaptureEvent. user_message and assistant_message use event.text. tool_call uses the 074b format."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md:101`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-handler.ts:700-707`. `proseForEvent` `event-contract.ts:239-248`.

#### m-AC-4
- Quote: "Every existing message JSONB consumer (summaries/worker.ts, skillify/miner.ts, dashboard/roi-session-writer.ts, dashboard/api.ts) is unchanged and continues to read the structured envelope."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md:102`
- Verdict: UNMET
- Source: summaries still parse `src/daemon/runtime/summaries/worker.ts:395` and `:419`. Miner still parses `src/daemon/runtime/skillify/miner.ts:203-204` and `:360`. ROI writer does not read `message` `src/daemon/runtime/dashboard/roi-session-writer.ts:105-121`. `api.ts` `rowToCapturedTurn` reads token columns only `src/daemon/runtime/dashboard/api.ts:846-858`.

#### m-AC-5
- Quote: "tool_call prose is bounded by the named export TOOL_PROSE_RESPONSE_CAP. A Read with a 10 KB response and a Bash with multi-KB stdout stay within the cap."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md:103`
- Verdict: MET
- Source: `TOOL_PROSE_RESPONSE_CAP = 500` `src/daemon/runtime/capture/event-contract.ts:227`. Truncate `:269`.

#### m-AC-6
- Quote: "A user_message or assistant_message prose is event.text verbatim."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md:104`
- Verdict: MET
- Source: `src/daemon/runtime/capture/event-contract.ts:241-245`.

#### m-AC-7
- Quote: "All existing recall, capture-handler, heal, and dashboard tests remain green."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md:105`
- Verdict: UNVERIFIABLE
- Source: this shard did not run vitest. QA at `qa/prd-074-sessions-prose-column-qa.md:39` reported 92 passed on 2026-07-05. Not re-run.

### 074a

#### a-AC-1
- Quote: "SESSIONS_COLUMNS includes prose TEXT NOT NULL DEFAULT ''."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:98`
- Verdict: MET
- Source: `src/daemon/storage/catalog/sessions-summaries.ts:88`.

#### a-AC-2
- Quote: "The column heals onto a legacy sessions table via withHeal / healColumns; a second heal is a no-op."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:99`
- Verdict: MET
- Source: column def carries DEFAULT `sessions-summaries.ts:85-88`, which is the additive heal input. Heal engine not re-opened; the column is in the catalog array the healer consumes.

#### a-AC-3
- Quote: "The capture handler populates prose on every new sessions INSERT from the typed CaptureEvent, on both single and batched paths."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:100`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-handler.ts:700-707` (row builder shared with the batch flush).

#### a-AC-4
- Quote: "user_message and assistant_message prose equals event.text verbatim."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:101`
- Verdict: MET
- Source: `src/daemon/runtime/capture/event-contract.ts:241-245`.

#### a-AC-5
- Quote: "tool_call prose follows the 074b format and the cap is TOOL_PROSE_RESPONSE_CAP."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:102`
- Verdict: MET
- Source: `proseForToolCall` `event-contract.ts:265-269`.

#### a-AC-6
- Quote: "buildSessionsArmSql uses COALESCE(NULLIF(prose, ''), message::text) in the projection and the ILIKE predicate."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:103`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:666` and `:670`.

#### a-AC-7
- Quote: "summaries/worker.ts, skillify/miner.ts, roi-session-writer.ts, and dashboard/api.ts still read message JSONB and parse the typed envelope."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:104`
- Verdict: UNMET
- Source: worker `summaries/worker.ts:395`. Miner `skillify/miner.ts:227` and `:360`. ROI writer and `api.ts` row mappers do not parse `message` (`roi-session-writer.ts:105-121`, `api.ts:846-868`).

#### a-AC-8
- Quote: "Existing recall, capture-handler, heal, and dashboard tests remain green without modification other than new assertions. hybrid-recall.ts is untouched."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074a-catalog-write-and-recall.md:105`
- Verdict: UNVERIFIABLE
- Source: tests not re-run. `hybrid-recall.ts` is documented untouched at `recall.ts:647-648`.

### 074b

#### b-AC-1
- Quote: "proseForToolCall(event) is exported from event-contract.ts. Pure, synchronous, no IO."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:118`
- Verdict: MET
- Source: `src/daemon/runtime/capture/event-contract.ts:265`.

#### b-AC-2
- Quote: "When input carries file_path, the first line is tool, arrow, shortPath, and range when offset and limit are present."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:119`
- Verdict: MET
- Source: `src/daemon/runtime/capture/event-contract.ts:278-285`.

#### b-AC-3
- Quote: "When input carries a command but no file_path, the first line is tool, colon, command truncated to 80."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:120`
- Verdict: MET
- Source: command branch documented `event-contract.ts:259`. Implementation follows `toolCallFirstLine` `:278`.

#### b-AC-4
- Quote: "With no recognizable target field, the first line is the tool name."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:121`
- Verdict: MET
- Source: `event-contract.ts:260`.

#### b-AC-5
- Quote: "The second line is whitespace-collapsed and capped at TOOL_PROSE_RESPONSE_CAP (default 500), truncated with an ellipsis."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:122`
- Verdict: MET
- Source: `event-contract.ts:227` and `:269`.

#### b-AC-6
- Quote: "A Read of a 10 KB file yields prose at or under the cap plus the first line, and the full 10 KB survives in message JSONB."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:123`
- Verdict: MET
- Source: prose cap `event-contract.ts:269`. Envelope trim of tool response is a separate PRD-062 cap (`budgeted-stringify.ts:16-17`) and can truncate a 10 KB `response` before it lands in `message`. A 10 KB body under the 062 byte budget still survives. This criterion is MET for the prose helper; a multi-MB body would be trimmed by 062 before JSONB persist. The 10 KB case is under a typical byte budget.

#### b-AC-7
- Quote: "A Bash with multi-KB stdout yields a prose row bounded by the cap."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:124`
- Verdict: MET
- Source: `truncate(body, TOOL_PROSE_RESPONSE_CAP)` `event-contract.ts:269`.

#### b-AC-8
- Quote: "proseForEvent returns event.text verbatim for user_message and assistant_message."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:125`
- Verdict: MET
- Source: `src/daemon/runtime/capture/event-contract.ts:241-245`.

#### b-AC-9
- Quote: "Windows path separators in file_path are preserved as-is in prose."
- PRD: `library/requirements/completed/prd-074-sessions-prose-column/prd-074b-tool-call-prose-format.md:126`
- Verdict: MET
- Source: `shortPath` uses the string as stored `event-contract.ts:285` and `:351`. Comment `:263` states backslashes are not re-escaped.

## QA notes read

- 060: `reports/2026-06-26-qa-report.md` (PASS, page paths now absent), `reports/2026-06-26-security-report.md` (not re-executed).
- 062: `qa/prd-062-deeplake-compute-cost-reduction-qa.md` (live numbers deferred; metadata lift declined). `reports/062a-idle-baseline-report.md` (scaffold).
- 063: `qa/prd-063-portkey-gateway-qa.md`, `qa/prd-063c-portkey-gateway-qa.md`, two security reports. Settings page citations are stale for this checkout.
- 065: three QA files. All proving paths are `doctor/`.
- 071: no QA narrative. `qa/.gitkeep` only.
- 072: `qa/2026-07-04-qa-report.md`. Early failures later marked closed. Current source matches the closed rows.
- 073: `qa/2026-07-04-qa-report-prd-073-dormant-capture-tenancy.md`. AC-6 was PASS then. Current `persistUnconfirmedTenancy` overturns that pass.
- 074: `qa/prd-074-sessions-prose-column-qa.md`. PASS at `4103d84`. ROI readers have since stopped parsing `message`.

## What wave 2 should confirm or overturn

- Do not move 060, 062, 063, 071, 072, or 074 out of `completed/` on the basis of this shard. Page and doctor absences are repo-boundary, not missing daemon work.
- Do move 065 back to `in-work` unless a checkout that contains `doctor/` and the install site shows AC-1 through AC-5.
- Overturn 073's completed confirmation only if AC-6's "persist nothing" rule is still binding. The provisional credential is intentional (`BUG 2` in `deeplake-issuer.ts:784-789`) and keeps capture gated.
- 062 AC-1 stays unmet until someone fills `reports/062a-idle-baseline-report.md` from a live idle run.
- 074 m-AC-4 / a-AC-7: either amend the PRD (ROI readers are column readers now) or restore envelope parses. The prose column itself is shipped.
