# Operations runtime and cost - knowledge standing

Wave 1a shard. Read-only. Branch `legion/kb-sotu-and-prd-lifecycle`. No other `library/knowledge/private/operations/*.md` exists outside this shard and the excluded install/CLI set (`install-and-onboarding.md`, `cli-command-architecture.md`, `developer-workflow.md`, `doctor-watchdog.md`).

Grounding roots: `src/daemon/runtime/services/local-queue-diagnostics.ts`, `src/daemon/runtime/telemetry/`, `src/notifications/state.ts`, `src/shared/fleet-root.ts`, `src/daemon/runtime/dashboard/`. Build outputs and `node_modules` were not used.

Verdicts below are FALSE, STALE, HOLE, or HOLDS. Actions are REVISE, ADD, LEAVE, or REMOVE. Defect count is FALSE + STALE + HOLE only. HOLDS entries are recorded so a later writer does not undo passages that already match source.

## Coverage

| Doc | Page action | Why |
|---|---|---|
| `library/knowledge/private/operations/local-queue-idle-cost-control.md` | REVISE | Kinds, columns, flags, and the diagnostics builder match source. Default-on is already shipped, the diagnostics body omits `queryMeter`, and the path chain omits the Linux XDG leg. |
| `library/knowledge/private/operations/deeplake-compute-cost.md` | REVISE | Backoff, capture, and fan-out knobs match. The present-tense scan constant name is gone, and the cited playbook path is absent. |
| `library/knowledge/private/operations/fleet-and-usage-telemetry.md` | REVISE | SQLite store, registry window, redaction, and the PostHog allow-list match. Uninstall emit order is reversed, and the CLI event set is incomplete. |
| `library/knowledge/private/operations/notifications-and-health.md` | REVISE | State prose that names `honeycombStateDir()` is current. The quoted functions, Cursor hook map, and D1-D5 strategies are not. |
| `library/knowledge/private/operations/roi-tracker.md` | REVISE | Daemon read-model, rates, honesty witness, and billing client match. The 060e module map still cites pages that are not in this checkout. The later disclaimer that those files are absent should stay. |
| `library/knowledge/private/operations/observability-and-degradation.md` | REVISE | Outbox blocks, jobs route, and mode gating match. Embeddings vocabulary, the dashboard badge, one log field list, and the redrive counts do not. Several `/health` reasons are missing. |
| `library/knowledge/private/operations/deeplake-idle-hibernation.md` | REVISE | Controller, flags, wake order, and events match. The handle table is behind `assemble.ts`, and the "future queue PRD" sentence is behind PRD-066. |

No page in this shard should be removed. No new operations page is required.

## Defects

### 1. Local queue default-on is described as a future rollout

- Quote: "This is the gate that keeps a future default-on rollout from silently breaking cross-device coordination."
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:73`
- Grounding: `src/daemon/runtime/services/hybrid-job-queue.ts:46-59` (unset `HONEYCOMB_LOCAL_QUEUE_ENABLED` uses `resolveLocalQueueTopology().eligibleForDefaultOn`); `src/daemon/runtime/services/local-queue-diagnostics.ts:111-121` (undeclared topology is eligible).
- Verdict: STALE
- Action: REVISE

The same file's flag table at line 83 already says undeclared and single-machine default on. Line 73 still talks about a future rollout. ADR-0009 is the reversal; it is cited in the body at line 78 and omitted from Related (see defect 4).

### 2. Diagnostics response is four sections, source returns five

- Quote: "The response reports four things:"
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:70`
- Grounding: `src/daemon/runtime/services/local-queue-diagnostics.ts:58-69` (`LocalQueueUpgradeDiagnostics` also has `queryMeter`).
- Verdict: HOLE
- Action: REVISE

`queryMeter` is null when no meter reader is injected (`local-queue-diagnostics.ts:159`). The other four sections match: local state, topology, rollback (`localWorkWillNotProcess` at lines 136 and 152-156), and the 5-second pending-shared timeout (`PENDING_SHARED_LOCAL_JOBS_TIMEOUT_MS` at line 17, `unavailable` at lines 173-178). The pending query uses `sqlIdent` plus `MAX(version)` at lines 214-225.

### 3. Queue path is written as only `~/.apiary/...`

- Quote: "The database file is `~/.apiary/honeycomb/.daemon/local-queue.db`."
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:79`
- Grounding: `src/daemon/runtime/assemble.ts:2128-2129` (`resolveLocalQueueBaseDir` returns `honeycombStateDir()`); `src/shared/fleet-root.ts:78-104` (`APIARY_HOME`, then Linux `XDG_STATE_HOME/apiary`, else `join(home, ".apiary")`).
- Verdict: HOLE
- Action: REVISE

Line 46 names `os.homedir()` / `APIARY_HOME` and skips the XDG leg. The home default is correct only when `APIARY_HOME` is unset and, on Linux, `XDG_STATE_HOME` is unset. Production assembly passes that base dir (`assemble.ts:3179`); the private helper in `local-job-queue.ts:291-292` still falls back to `process.cwd()` when `baseDir` is omitted, which is not the assembled path.

### 4. Related list omits ADR-0009

- Quote: "[`../architecture/adr/0006-local-queue-as-interim-idle-cost-control.md`](../architecture/adr/0006-local-queue-as-interim-idle-cost-control.md)"
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:10`
- Grounding: `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md` exists. Body line 78 already says ADR-0009 reversed the opt-in.
- Verdict: HOLE
- Action: ADD

Add ADR-0009 to Related. Keep ADR-0006. Do not delete ADR-0006.

### 5. `DISCOVERY_SCAN_POLLS` is not the current symbol

- Quote: "`DISCOVERY_SCAN_POLLS` exists to defeat DeepLake's stale-segment flapping"
- Doc: `library/knowledge/private/operations/deeplake-compute-cost.md:81`
- Grounding: ABSENT as `DISCOVERY_SCAN_POLLS`. Current names are `DISCOVER_POLLS` and `RESOLVE_POLLS` in `src/daemon/runtime/services/job-queue.ts:274-283`. Discovery is a paginated scan union, not the old per-id point-read loop (`job-queue.ts:668-676`).
- Verdict: STALE
- Action: REVISE

The pre-PRD-062 table at line 40 can keep the historical name if it stays labeled pre-PRD. The present-tense rail cannot.

### 6. Cost-anomaly playbook path is not in this checkout

- Quote: "the [`cost-anomaly-diagnosis`](../../../../.claude/skills/cost-anomaly-diagnosis/SKILL.md) playbook"
- Doc: `library/knowledge/private/operations/deeplake-compute-cost.md:23`
- Grounding: ABSENT (no `.claude/skills/cost-anomaly-diagnosis/SKILL.md`).
- Verdict: FALSE
- Action: REVISE

Drop the link or point at a file that exists. Do not invent a replacement playbook.

### 7. `honeycomb_uninstalled` fires after reversal, not before

- Quote: "It fires *before* the connector engine reverses anything, fire-and-forget, so a slow or broken telemetry hop can never delay or fail the uninstall."
- Doc: `library/knowledge/private/operations/fleet-and-usage-telemetry.md:98`
- Grounding: `src/commands/local-handlers.ts:154-161` ("emit only after every required removal phase and connector reversal succeeded").
- Verdict: FALSE
- Action: REVISE

The emit is still fire-and-forget and still limited to the full uninstall verb (`isFullUninstall`). A failed transaction must not consume the one-time event. The "before reversal" clause is the false part.

### 8. Packaged CLI lifecycle set is larger than two events

- Quote: "The **packaged CLI** emits two more lifecycle events through the Node-side chokepoint"
- Doc: `library/knowledge/private/operations/fleet-and-usage-telemetry.md:95`
- Grounding: `src/daemon/runtime/telemetry/emit.ts:129-135` (`TIER1_EVENTS` also includes `honeycomb_installed`, `honeycomb_first_link`, and `honeycomb_hivemind_upgrade`). `honeycomb_installed` still emits from `src/commands/install.ts:576-582`.
- Verdict: HOLE
- Action: REVISE

`honeycomb_updated` (`version-check.ts:70-83`) and the dedupe key `honeycomb_updated@<version>` match the doc. The allow-list at `emit.ts:165-174` matches the listed keys. `installId` is a UUID from `randomUUID()` at `src/daemon/runtime/onboarding/onboarding-store.ts:240`.

### 9. Installer-script PostHog behavior is not in this tree

- Quote: "The **installer scripts** ([the-apiary `scripts/install`](https://github.com/legioncodeinc/the-apiary/tree/main/scripts/install), kept at parity)"
- Doc: `library/knowledge/private/operations/fleet-and-usage-telemetry.md:93`
- Grounding: ABSENT in this repo (`scripts/install/` has no files). `src/commands/install.ts:585-586` still names `scripts/install/install.sh`, which is also absent here.
- Verdict: HOLE
- Action: REVISE

Keep the external pointer if the fleet still owns those scripts. Do not state curl timeouts, event names, or parity as facts proven by this checkout.

### 10. Quoted `drainSessionStart` is not the current module

- Quote: "```77:104:src/notifications/index.ts" through `export async function drainSessionStart`
- Doc: `library/knowledge/private/operations/notifications-and-health.md:34`
- Grounding: ABSENT. `src/notifications/index.ts` is a barrel (re-exports through line 70). The drain lives in `src/notifications/pipeline.ts:32-33` (`DEFAULT_PIPELINE_TIMEOUT_MS = 1500`) and does not export `drainSessionStart`.
- Verdict: FALSE
- Action: REVISE

Replace the fence with the current pipeline. The 1.5s bound and fail-soft posture still match `pipeline.ts`.

### 11. Quoted `tryClaim` and `~/.honeycomb/notifications-claims` are gone

- Quote: "```114:133:src/notifications/state.ts" through `join(home, ".honeycomb", "notifications-claims")`
- Doc: `library/knowledge/private/operations/notifications-and-health.md:70`
- Grounding: ABSENT as `tryClaim`. Current claim lock is `createClaimLock` in `src/notifications/state.ts:158-170`. Claim dir name is `claims` (`CLAIM_DIR_NAME` at line 52) under `honeycombStateDir()` (`state.ts:133-135`).
- Verdict: FALSE
- Action: REVISE

The prose at line 96 (state file `~/.apiary/honeycomb/notifications-state.json` via `honeycombStateDir()`) matches `state.ts:50` and `state.ts:197-205`, including the legacy read of `~/.honeycomb/notifications-state.json`. Leave that prose. The exclusive-create claim is still `openSync(path, "wx")` at `state.ts:123`. `mkdir` failure no longer returns true; other FS errors throw `StateFsError` (`state.ts:128`).

### 12. Cursor hook map is not `buildHookConfig` in `install-cursor.ts`

- Quote: "```44:61:src/cli/install-cursor.ts" and the `preToolUse` / `afterAgentResponse` / `graph-on-stop.js` block
- Doc: `library/knowledge/private/operations/notifications-and-health.md:145`
- Grounding: ABSENT (`src/cli/install-cursor.ts` does not exist). Current set is `CURSOR_HANDLERS` in `src/connectors/cursor.ts:73-80`: `sessionStart` (10s), `beforeSubmitPrompt` (10s), `beforeShellExecution` (60s, Shell matcher at lines 155-158), `postToolUse` (15s), `stop` via `assistant_message` (30s), `sessionEnd` (60s). No `graph-on-stop.js`. No `afterAgentResponse` registration (the shim still accepts that event at `src/hooks/cursor/shim.ts:40`).
- Verdict: FALSE
- Action: REVISE

Foreign-preserve, idempotent `writeJsonIfChanged`, and reversible uninstall still exist on the connector base (`src/connectors/contracts.ts:295` and `314`, used by `src/connectors/cursor.ts:181`). Auto-wiring delegates to that connector (`src/notifications/auto-wiring.ts:38-46`). Keep those three rules. Replace the event list and the file path.

### 13. D1-D5 resolving strategies do not match the probes

- Quote: "PATH resolution with version probing" / "TCP probe with a fast-start fallback" / "fallbacks to known IDE directories" / "Checks `hooks.json` for matches against the current bundle."
- Doc: `library/knowledge/private/operations/notifications-and-health.md:110-114`
- Grounding: `src/cli/health-probes.ts:35-40` (D1 is the in-process version, no PATH spawn); `src/cli/health-probes.ts:155-157` (D2 is `daemon.ping()`, detail `127.0.0.1:3850`, no launch inside the probe); `src/cli/health-probes.ts:43-51` (D3 is `which`/`where` only); `src/cli/health-probes.ts:126-138` (D5 is Claude plugin enabled, else `hooks.json` exists, not a bundle-content match).
- Verdict: STALE
- Action: REVISE

D4 (`cursor-agent status`, 5s timeout) at `health-probes.ts:81-88` matches the table's "lightweight status query." The five dimension ids still exist (`src/notifications/contracts.ts:47`).

### 14. Embeddings `/health` is not "ready" or "BM25"

- Quote: "`/health` reports the real state, ready, failed, or falling back to BM25, rather than echoing the enabled flag."
- Doc: `library/knowledge/private/operations/notifications-and-health.md:133`
- Grounding: `src/daemon/runtime/health.ts:159` (`EmbeddingsHealth = "off" | "warming" | "on" | "suspect" | "failed"`). `pickEmbedEntry` still probes the bundled sibling and the dev five-up path (`src/daemon/runtime/services/embed-supervisor.ts:345-354`).
- Verdict: STALE
- Action: REVISE

The spawn-path bug narrative matches `embed-supervisor.ts:326-330`. The wire vocabulary does not. There is no `/health` literal `ready` or `BM25`.

### 15. Environment health is not a continuous monitor

- Quote: "Continuously monitors local prerequisites, verifies compiler tools and helper CLIs, confirms the daemon is up, and auto-wires lifecycle hooks"
- Doc: `library/knowledge/private/operations/notifications-and-health.md:24`
- Grounding: `src/cli/health-probes.ts:1-4` and `src/commands/status.ts:119-145` (D1-D5 run when `honeycomb status` evaluates). `createHealthCheck` (`src/notifications/health.ts:110-127`) has no timer.
- Verdict: STALE
- Action: REVISE

### 16. 060e module map cites pages that are not in this checkout

- Quote: "[`roi.tsx`](../../../../src/dashboard/web/pages/roi.tsx), [`roi-chart.tsx`](../../../../src/dashboard/web/pages/roi-chart.tsx)"
- Doc: `library/knowledge/private/operations/roi-tracker.md:62`
- Grounding: ABSENT. No `src/dashboard/web/pages/roi.tsx`. No `src/dashboard/web/pages/roi-chart.tsx`. `mountDashboardHost` is not a function in this tree (comments only, for example `src/daemon/runtime/dashboard/CONVENTIONS.md:48`).
- Verdict: STALE
- Action: REVISE

Do not put those paths back as current sources. The daemon routes are current: `GET /api/diagnostics/roi` and `GET /api/diagnostics/roi/trend` in `src/daemon/runtime/dashboard/api.ts:1471-1478`.

### 17. Sign colors are described as the live `/roi` page

- Quote: "The honey brand color **never encodes sign** (positive net = `var(--verified)`, negative = `var(--severity-critical)`)"
- Doc: `library/knowledge/private/operations/roi-tracker.md:136`
- Grounding: tokens exist in `assets/tokens/colors.css:61` and `:71`. No ROI page in this checkout applies them. `RoiView` is assembled in `src/daemon/runtime/dashboard/api.ts:1018-1040` with status discriminants, not CSS.
- Verdict: STALE
- Action: REVISE

Attribute rendering to the Hive portal, or drop the CSS rule until a page in this repo owns it. Lines 140-143 already say the browser UI is the Hive portal and that `roi-chart.tsx` is absent. Leave that disclaimer (see holds).

### 18. Embeddings reason is not a two-value assembly flag

- Quote: "`embeddings` | `on` / `off` | The embed-seam state known at assembly, `on` when the real embedder is wired, `off` for the no-op or an explicit `HONEYCOMB_EMBEDDINGS=false`."
- Doc: `library/knowledge/private/operations/observability-and-degradation.md:55`
- Grounding: `src/daemon/runtime/health.ts:159` and `509-526` (coarse `embeddings` mirrors `off | warming | on | suspect | failed` when supervisor signals are wired). `HONEYCOMB_EMBEDDINGS=false` still forces off (`src/daemon/runtime/services/embed-supervisor.ts:61`).
- Verdict: STALE
- Action: REVISE

### 19. `/health` reasons omit portkey, dormancy, and the supervisor block

- Quote: the reasons table listing only `storage`, `embeddings`, `schema`, and `capture.droppedEvents`
- Doc: `library/knowledge/private/operations/observability-and-degradation.md:52-57`
- Grounding: `src/daemon/runtime/health.ts:228` (`portkey`), `236` (`portkeyUnreachableStatus`), `218` (`embeddingsState`), `224` (`embedSupervisor`), `256` (`captureDormant`).
- Verdict: HOLE
- Action: ADD

`captureOutbox` and `memoryOutbox` later in the same doc match `health.ts:278` and `293`. `publicHealthDetail` still returns full detail only when `mode === "local"` (`health.ts:652-656`). That gating paragraph holds.

### 20. Dashboard recall bar is not in this checkout

- Quote: "the dashboard recall bar renders a "lexical fallback" badge"
- Doc: `library/knowledge/private/operations/observability-and-degradation.md:44`
- Grounding: ABSENT (`src/dashboard/web/` has no pages). The in-repo marker is the CLI line `"(lexical fallback)"` in `src/commands/storage-handlers.ts:302`. Recall still sets `degraded` (`src/daemon/runtime/memories/api.ts:214`).
- Verdict: STALE
- Action: REVISE

Same for "open the dashboard" / "per-subsystem health strip" at line 123. The daemon surfaces are `/health` and `/api/diagnostics/health` (`src/daemon/runtime/diagnostics-health.ts`).

### 21. `lease.coordinator.started` does not carry `leaseKinds`

- Quote: "carries `leaseKinds` / `unionKinds` and the participant count"
- Doc: `library/knowledge/private/operations/observability-and-degradation.md:90`
- Grounding: `src/daemon/runtime/services/lease-coordinator.ts:220` emits `{ unionKinds, participants }` only. `lease.coordinator.dispatched` is `{ id, kind }` at line 205.
- Verdict: FALSE
- Action: REVISE

`HONEYCOMB_POLL_CONSOLIDATE` default-on when absent is real (`lease-coordinator.ts:272-276`). `stage.worker.started` exists (`src/daemon/runtime/pipeline/stage-worker.ts:267`). `GET /api/diagnostics/jobs` matches `src/daemon/runtime/dashboard/jobs-diagnostics-api.ts:30-31`. Local status mapping `retrying` to `failed` and terminal `failed` to `dead` matches `src/daemon/runtime/services/local-job-queue.ts:101-103`.

### 22. Memory redrive reports `redriven` and `skipped`

- Quote: "reports the re-enqueued and skipped counts"
- Doc: `library/knowledge/private/operations/observability-and-degradation.md:106`
- Grounding: `src/daemon/runtime/pipeline/memory-redrive-api.ts:49-56` returns `{ ok, redriven, skipped }`. CLI prints those names (`src/commands/memory.ts:302`).
- Verdict: STALE
- Action: REVISE

`POST /api/diagnostics/memory-redrive` and `honeycomb memory redrive` are real. `maxAttempts` default 10 and `maxAgeMs` default 24h match `src/daemon/runtime/pipeline/memory-outbox.ts:130-132`. The "~101 already-dropped memories" figure is not in these sources; do not treat it as a current code fact.

### 23. Hibernation handle table is behind assembly

- Quote: the handle table (`summary`, `skillify`, `lease-coordinator` or `pipeline` + `pollinating`, `pollinating-maintenance-tick`, `health-probe`, `graph-build`)
- Doc: `library/knowledge/private/operations/deeplake-idle-hibernation.md:47-53`
- Grounding: `src/daemon/runtime/assemble.ts:4429-4550` also registers `lifecycle-reverify-tick`, `lifecycle-compact-access-tick`, `lifecycle-calibrate-tick`, `capture-outbox-drain`, and `memory-outbox-drain`. `health-probe` is pushed only when `storageHealthProbeEnabled` (`assemble.ts:4491`), and that flag is false when the local queue is on and drain is off (`assemble.ts:3174`).
- Verdict: HOLE
- Action: REVISE

The listed handles that do exist match the same block. `graph-build` stays opt-in (`assemble.ts:4503`). Pollinating maintenance interval is 60s (`src/daemon/runtime/pollinating/maintenance-tick.ts:21`).

### 24. Moving the job queue off DeepLake is not still a future PRD

- Quote: "The deeper structural fix, moving the job queue off DeepLake so idle equals zero DeepLake reads by construction rather than by pausing, is a separate future PRD."
- Doc: `library/knowledge/private/operations/deeplake-idle-hibernation.md:137`
- Grounding: `src/daemon/runtime/services/hybrid-job-queue.ts:15-26` and `141-145` (local kinds, shared reaper left stopped unless `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED`). Non-drain lease of only local kinds does not call the shared queue (`hybrid-job-queue.ts:179-184`).
- Verdict: STALE
- Action: REVISE

PRD-066 already moved local-classified coordination off DeepLake for undeclared and single-machine topologies. What remains on DeepLake is the shared queue for `multi_device` / `fleet`, drain mode, and the non-queue timers hibernation pauses. Line 22 of the same doc already says PRD-066 removed local coordination reads. Make line 137 agree with that. The controller, idle default `120000`, floor `5000`, and explicit `false`/`0` off-switch match `src/daemon/runtime/services/deeplake-hibernation.ts:67-76` and `145-146`. Wake middleware order matches `src/daemon/runtime/assemble.ts:3521-3554`. `/health` is registered in `createDaemon` before that middleware (`src/daemon/runtime/server.ts:331`).

## Checked claims that hold

### H1. ROI disclaimer must stay

- Quote: "`mountDashboardHost` and `host.ts` are not in this checkout. The browser UI is the Hive portal." and "`src/dashboard/web/pages/roi-chart.tsx` is not in this checkout."
- Doc: `library/knowledge/private/operations/roi-tracker.md:140-143`
- Grounding: ABSENT for those files. Routes remain in `src/daemon/runtime/dashboard/api.ts:1471-1478`.
- Verdict: HOLDS
- Action: LEAVE

Do not cite `roi-chart.tsx` or `mountDashboardHost` as current. Defect 16 is the module-map line that still does.

### H2. Persistent notification state path

- Quote: "`~/.apiary/honeycomb/notifications-state.json` ... `src/notifications/state.ts` resolves the directory with `honeycombStateDir()`"
- Doc: `library/knowledge/private/operations/notifications-and-health.md:96`
- Grounding: `src/notifications/state.ts:133-135` and `197-205`.
- Verdict: HOLDS
- Action: LEAVE

### H3. Local-queue kind list, columns, and diagnostics SQL

- Quote: `DEFAULT_LOCAL_JOB_KINDS` list and the `local_job` column list
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:46-54`
- Grounding: `src/daemon/runtime/services/hybrid-job-queue.ts:15-26`; `src/daemon/runtime/services/local-job-queue.ts:25-47`.
- Verdict: HOLDS
- Action: LEAVE

`GET /api/diagnostics/local-queue` is `src/daemon/runtime/local-queue-diagnostics-api.ts:12-13`. CLI spawn flags include `--experimental-sqlite` (`src/cli/runtime.ts:148`).

### H4. Query-meter labels and unimplemented persist

- Quote: "`fan-out-enqueue` and `controlled-write` are declared but not yet threaded" and "`HONEYCOMB_QUERY_METER_PERSIST`"
- Doc: `library/knowledge/private/operations/deeplake-compute-cost.md:48-61`
- Grounding: labels in `src/daemon/storage/query-meter.ts:49-58`. No call site passes `"fan-out-enqueue"` or `"controlled-write"`. `queryMeterPersist` is parsed in `src/daemon/storage/config.ts:116-117` and not consumed elsewhere. `query-meter.ts:100-101` still says persistence is unimplemented.
- Verdict: HOLDS
- Action: LEAVE

Backoff defaults (`1000` / `30000` / `0.1`, env absent means on) match `src/daemon/runtime/services/poll-backoff.ts:40-47` and `149-151`. Capture defaults match `src/daemon/runtime/capture/capture-config.ts:37-41`. Recall ceiling default 6 matches `src/daemon/runtime/memories/amplification-config.ts:50`.

### H5. Fleet SQLite contract

- Quote: database `~/.apiary/honeycomb/telemetry/honeycomb.sqlite`, legacy `~/.honeycomb/telemetry/honeycomb.sqlite`, heartbeat 7.5s, metrics 10s, log cap 5000
- Doc: `library/knowledge/private/operations/fleet-and-usage-telemetry.md:55-77`
- Grounding: `src/daemon/runtime/telemetry/fleet-store.ts:37-42` and `62-68`; `src/daemon/runtime/telemetry/checkin.ts:31`; `src/daemon/runtime/telemetry/metrics.ts:61`. Registry write target: `src/daemon/runtime/telemetry/fleet-registry.ts:78-79`, called from `src/commands/install.ts:56`.
- Verdict: HOLDS
- Action: LEAVE

`recordFilesProcessed` still has no production caller outside telemetry tests (`src/daemon/runtime/telemetry/metrics.ts:26-29`). Redaction to `[REDACTED]` and the 80-character drop match `src/daemon/runtime/telemetry/redact.ts:32-54`.

### H6. ROI rates and honesty witness

- Quote: Sonnet `300/1500`, Opus `1500/7500`, Haiku `100/500`, `RATES_AS_OF`
- Doc: `library/knowledge/private/operations/roi-tracker.md:113`
- Grounding: `src/daemon/runtime/dashboard/roi-rates.ts:69` and `84-112`. Witness `@ts-expect-error` shape matches `src/daemon/runtime/dashboard/roi-honesty-contract.ts:35-42`. Session token columns are nullable BIGINT and `model` is `TEXT NOT NULL DEFAULT ''` (`src/daemon/storage/catalog/sessions-summaries.ts:66-77`). `user_id` stays gated on `backend-token` (`src/daemon/runtime/dashboard/roi-ledger.ts:90-92`). Billing `session_type` values are `query`, `embedding`, `ingestion` (`src/daemon/runtime/dashboard/roi-billing.ts:176`).
- Verdict: HOLDS
- Action: LEAVE

PRD-061 is still under `library/requirements/backlog/prd-061-hosted-roi-admin-surface/`.

## Files read

Knowledge:

- `library/knowledge/private/operations/local-queue-idle-cost-control.md`
- `library/knowledge/private/operations/deeplake-compute-cost.md`
- `library/knowledge/private/operations/fleet-and-usage-telemetry.md`
- `library/knowledge/private/operations/notifications-and-health.md`
- `library/knowledge/private/operations/roi-tracker.md`
- `library/knowledge/private/operations/observability-and-degradation.md`
- `library/knowledge/private/operations/deeplake-idle-hibernation.md`

Source and catalogs used to ground claims:

- `src/shared/fleet-root.ts`
- `src/daemon/runtime/services/local-queue-diagnostics.ts`
- `src/daemon/runtime/services/local-job-queue.ts`
- `src/daemon/runtime/services/hybrid-job-queue.ts`
- `src/daemon/runtime/services/poll-backoff.ts`
- `src/daemon/runtime/services/poll-loop.ts`
- `src/daemon/runtime/services/job-queue.ts`
- `src/daemon/runtime/services/lease-coordinator.ts`
- `src/daemon/runtime/services/deeplake-hibernation.ts`
- `src/daemon/runtime/services/embed-supervisor.ts`
- `src/daemon/runtime/local-queue-diagnostics-api.ts`
- `src/daemon/runtime/assemble.ts`
- `src/daemon/runtime/server.ts`
- `src/daemon/runtime/health.ts`
- `src/daemon/runtime/diagnostics-health.ts`
- `src/daemon/runtime/telemetry/emit.ts`
- `src/daemon/runtime/telemetry/fleet-store.ts`
- `src/daemon/runtime/telemetry/fleet-registry.ts`
- `src/daemon/runtime/telemetry/checkin.ts`
- `src/daemon/runtime/telemetry/metrics.ts`
- `src/daemon/runtime/telemetry/logs.ts`
- `src/daemon/runtime/telemetry/redact.ts`
- `src/daemon/runtime/telemetry/version-check.ts`
- `src/daemon/runtime/dashboard/api.ts`
- `src/daemon/runtime/dashboard/roi-rates.ts`
- `src/daemon/runtime/dashboard/roi-honesty-contract.ts`
- `src/daemon/runtime/dashboard/roi-billing.ts`
- `src/daemon/runtime/dashboard/roi-ledger.ts`
- `src/daemon/runtime/dashboard/jobs-diagnostics-api.ts`
- `src/daemon/runtime/dashboard/CONVENTIONS.md`
- `src/daemon/storage/query-meter.ts`
- `src/daemon/storage/config.ts`
- `src/daemon/storage/catalog/sessions-summaries.ts`
- `src/daemon/runtime/capture/capture-config.ts`
- `src/daemon/runtime/capture/capture-outbox.ts`
- `src/daemon/runtime/pipeline/memory-outbox.ts`
- `src/daemon/runtime/pipeline/memory-redrive-api.ts`
- `src/daemon/runtime/pipeline/stage-worker.ts`
- `src/daemon/runtime/pipeline/fan-out.ts`
- `src/daemon/runtime/memories/amplification-config.ts`
- `src/daemon/runtime/pollinating/maintenance-tick.ts`
- `src/daemon/runtime/onboarding/onboarding-store.ts`
- `src/notifications/index.ts`
- `src/notifications/state.ts`
- `src/notifications/pipeline.ts`
- `src/notifications/health.ts`
- `src/notifications/auto-wiring.ts`
- `src/notifications/contracts.ts`
- `src/cli/health-probes.ts`
- `src/cli/runtime.ts`
- `src/commands/install.ts`
- `src/commands/local-handlers.ts`
- `src/commands/status.ts`
- `src/commands/memory.ts`
- `src/commands/storage-handlers.ts`
- `src/connectors/cursor.ts`
- `src/connectors/contracts.ts`
- `src/hooks/cursor/shim.ts`
- `src/hooks/claude-code/transcript.ts`
- `assets/tokens/colors.css`
- `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md` (existence)

Defect count: 24.
