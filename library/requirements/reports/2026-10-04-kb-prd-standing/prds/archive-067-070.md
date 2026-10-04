# Wave 1b standing: archive PRDs 067-070

- Shard: archive 067, 068, 069, 070 only
- Date: 2026-10-04
- Repo: honeycomb. Product source was read, not edited. Sibling repos `doctor` and `hive` were read because these PRDs name them as the owning trees.
- Scope skip: `node_modules`, `daemon/`, `bundle/`, `mcp/bundle/`, `harnesses/*/bundle/`, `embeddings/embed-daemon.js`

## Files read

No lettered children exist in any of these four folders.

| PRD | Files |
|---|---|
| 067 | `library/requirements/archive/prd-067-doctor-boot-grace-release-blocker/prd-067-doctor-boot-grace-release-blocker-index.md`; `library/requirements/archive/prd-067-doctor-boot-grace-release-blocker/qa/out-of-scope-discoveries.md` |
| 068 | `library/requirements/archive/prd-068-portal-daemon-boot-shell/prd-068-portal-daemon-boot-shell-index.md` |
| 069 | `library/requirements/archive/prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md` |
| 070 | `library/requirements/archive/prd-070-first-browser-load-experience/prd-070-first-browser-load-experience-index.md` |

Supporting records, not PRDs: `library/ledger/EXECUTION_LEDGER-prd-067.md`, `library/requirements/archive/README.md`.

## Counts

| PRD | ACs | MET | UNMET | UNVERIFIABLE | Recommended bucket |
|---|---:|---:|---:|---:|---|
| 067 | 11 | 11 | 0 | 0 | stay archive |
| 068 | 10 | 5 | 5 | 0 | stay archive |
| 069 | 10 | 0 | 10 | 0 | stay archive |
| 070 | 10 | 1 | 6 | 3 | stay archive |
| Total | 41 | 17 | 21 | 3 | |

Unmet count: **21**.

Verdict rule: `MET` means the quoted sentence is implemented in code that was read. A later hive or doctor screen that uses a different port, label, or route is cited as nearest code and stays `UNMET` when it does not satisfy the quote. `ABSENT` means no line implements the quoted behavior.

Honeycomb has no `doctor/` tree. PRD-067 proof lives in the sibling doctor repo at `/home/marioaldayuz/Desktop/development/active/doctor`. A honeycomb-only search will miss it.

## Bucket recommendation

All four stay in `library/requirements/archive/`.

- **067 stay archive.** All 11 criteria are met in the doctor repo. The canonical shipped PRD is already `doctor/library/requirements/completed/prd-003-doctor-boot-grace-release-blocker/`. This honeycomb folder is the withdrawn local copy after the July 2026 fleet split (`library/requirements/archive/README.md:16`). Moving it to honeycomb `completed/` would record a feature this tree does not contain. It is finished work, so `backlog` and `in-work` are the wrong buckets. Archive here means withdrawn from this repo. The shipped bucket is doctor's `completed/`.
- **068, 069, 070 stay archive.** They were superseded before the Doctor-hosted portal, `/health` dashboard, and graphical boot shell in this document were built (`library/requirements/archive/README.md:17-19`). Hive later shipped a different portal (`/buzzing` on `127.0.0.1:3853`, health rail and `/health`). Those successor PRDs are completed in hive. They do not satisfy these acceptance criteria. Leaving the folders in archive matches withdrawn work. Do not move them to `completed`, `in-work`, or `backlog`.

Stale banners for a later librarian, not a bucket change:

- Each index still has a second `Status: Backlog` line under the archive banner (067:5, 068:7, 069:7, 070:7).
- 068:3, 069:3, and 070:3 link the successor PRDs under hive or doctor `backlog/`. Those successors now live under `completed/` in the sibling repos (hive PRD-003, PRD-004, PRD-005; doctor PRD-001, PRD-002).

## PRD-067 Doctor boot grace

Status banner: completed and moved, archived 2026-07-03, canonical doctor PRD-003. QA note `qa/out-of-scope-discoveries.md` records OOS-1 (a second `doctor run` exiting when port 3852 is taken). The header says that item was accepted as AC-11 on 2026-06-29. The recommendation at the bottom of that note still talks about a follow-up PRD; the code for both mitigations is present (port override and process keepalive).

Honeycomb publishes the grace value into the doctor registry (`src/daemon/runtime/telemetry/fleet-registry.ts:103` `HONEYCOMB_REGISTRY_STARTUP_GRACE_MS = 60_000`, written at `:228`). That is the registry field. The watchdog behavior is in doctor.

### AC-1 MET

Quote (`prd-067-doctor-boot-grace-release-blocker-index.md:104`): Given Doctor starts and the primary daemon is not yet listening, when the first probe returns `unreachable-refused` inside the first 60 seconds, then Doctor logs a booting observation and does not invoke the remediation ladder.

Proof: `/home/marioaldayuz/Desktop/development/active/doctor/src/supervisor.ts:333-336` logs `tick.booting` and returns before `heal`. Test: `doctor/tests/supervisor.test.ts:200-217` expects `tick.booting`, no restart, no incident.

### AC-2 MET

Quote (`...index.md:105`): Given Doctor starts and `/health` times out inside the startup grace, when the supervisor tick completes, then no incident is written and restart failure counters remain unchanged.

Proof: same early return at `doctor/src/supervisor.ts:333-336` for every non-`ok` kind, including timeout. Test: `doctor/tests/supervisor.test.ts:220-232`.

### AC-3 MET

Quote (`...index.md:106`): Given Doctor starts and `/health` returns `degraded` inside the startup grace, when the supervisor tick completes, then no remediation runs and no escalation is emitted.

Proof: `doctor/src/supervisor.ts:333-336` runs before the unhealthy branch at `:339-346`. Test: `doctor/tests/supervisor.test.ts:235-249`.

### AC-4 MET

Quote (`...index.md:107`): Given the startup grace has expired and the primary daemon is still unreachable, when the next tick runs, then the existing unhealthy remediation path runs exactly as it does today.

Proof: `doctor/src/supervisor.ts:333-346` falls through to incident plus `heal` when `graceRemainingMs` is 0. Test: `doctor/tests/supervisor.test.ts:252-268` advances 60s and expects `restart-daemon` succeeded.

### AC-5 MET

Quote (`...index.md:108`): Given a restart rung returns `ok: true`, when the next probe occurs before the post-restart grace expires, then Doctor does not attempt a second restart.

Proof: `doctor/src/supervisor.ts:242-248` calls `armStartupGrace(now)` only when `result.ok`. Test: `doctor/tests/supervisor.test.ts:271-288`. Post-update re-arm is the same seam: `doctor/src/compose/index.ts:799-803`.

### AC-6 MET

Quote (`...index.md:109`): Given a restart action returns `false`, when the tick completes, then no post-restart grace is opened and the existing failed-restart/backoff logic applies.

Proof: `doctor/src/supervisor.ts:251-258` increments `consecutiveRestartFailures` and advances backoff, and does not call `armStartupGrace`. Test: `doctor/tests/supervisor.test.ts:291-308` expects a second restart and failures `2`.

### AC-7 MET

Quote (`...index.md:110`): Given `DOCTOR_STARTUP_GRACE_MS=90000`, when config resolves, then the supervisor uses a 90 second grace. Given the env value is malformed, zero, or negative, it falls back to 60 seconds.

Proof: default `doctor/src/config.ts:88` `startupGraceMs: 60_000`; parse `doctor/src/config.ts:110-113` and `:194` via `parsePositiveInt` (finite integer `> 0`, else fallback). Tests: `doctor/tests/config.test.ts:38-46` (90000), `:57-66` (malformed), `:72-78` (zero and negative).

### AC-8 MET

Quote (`...index.md:111`): Given the daemon becomes healthy during startup grace, when `/health` returns `ok`, then Doctor records healthy state and resets any stale backoff exactly as the existing healthy path does.

Proof: the `ok` branch at `doctor/src/supervisor.ts:277-294` resets backoff and counters before the grace check. Test: `doctor/tests/supervisor.test.ts:311-330`.

### AC-9 MET

Quote (`...index.md:112`): Given the status page is running while Doctor is inside grace, when `/status.json` is requested, then the page does not claim a terminal failure or show an escalation caused by the boot window.

Proof: grace returns before incident write (`doctor/src/supervisor.ts:333-336`). `/status.json` serves the injected state (`doctor/src/status-page/server.ts:268-276`). Test: `doctor/tests/compose/create-doctor.test.ts:351-366` expects `health: "unknown"` and `escalation: null` after a refused probe inside grace.

### AC-10 MET

Quote (`...index.md:113`): Given the packaged Honeycomb install starts Doctor and the primary daemon on this machine, when the primary takes about 30 seconds to boot, then Doctor does not restart, reinstall, or escalate during that boot.

Proof: `doctor/tests/supervisor.test.ts:333-352` keeps the probe refused until 30s, then `ok`, and expects `restart` not called and zero incidents. `probeTimeoutMs` stays `2_000` (`doctor/src/config.ts:87`), separate from the 60s grace.

The ledger's packaged live proof (`library/ledger/EXECUTION_LEDGER-prd-067.md:34`) is narrative. No packaged-smoke script for that run remains in either tree. The retained proof is the supervisor test above, which encodes the 30 second behavior.

### AC-11 MET

Quote (`...index.md:114`): Given the local status-page port is already bound when `doctor run` starts, when the status page fails to bind, then Doctor logs/swallow the bind failure and the watchdog process remains alive until SIGTERM/SIGINT while still probing/healing the primary daemon.

Proof: bind errors log `status-page.bind_failed` and do not throw (`doctor/src/status-page/server.ts:329-337`). `runWatchdog` starts the doctor assembly, then holds a referenced interval until SIGTERM or SIGINT (`doctor/src/cli/index.ts:401-427`). Compose starts the supervisor loops after the status page (`doctor/src/compose/index.ts:1017-1030`). Port override: `DOCTOR_STATUS_PAGE_PORT` at `doctor/src/config.ts:196`. Test: `doctor/tests/cli/run-watchdog.test.ts:74-96`.

## PRD-068 Portal daemon boot shell

Status banner: superseded by hive PRD-003 and PRD-004, archived 2026-07-03. No QA note. The Doctor status page on `127.0.0.1:3852` is the pre-existing comfort page (doctor PRD-064g). It was not extended into the boot portal this PRD specifies. Hive serves the human portal on `127.0.0.1:3853`.

### AC-1 MET

Quote (`prd-068-portal-daemon-boot-shell-index.md:119`): Given Doctor is installed and started, when the portal port is requested, then a browser-visible portal page responds before the primary daemon is required to answer `/health`.

Proof: `doctor/src/status-page/server.ts:279-287` serves HTML from the injected state provider. `doctor/src/compose/index.ts:1017-1019` starts that page before the supervisor loops at `:1030`. The handler does not call primary `/health`.

### AC-2 UNMET

Quote (`...index.md:120`): Given the primary daemon has not answered `/health` and the portal boot timer is under 60 seconds, when the portal renders, then it shows `booting` rather than `dead`, `failed`, or `needs attention`.

ABSENT. Status health is `ok | degraded | unreachable | unknown` (`doctor/src/status-page/server.ts:42`). The HTML has no `booting` string (`:206-225`). `unknown` shares the red style with `unreachable` (`:178`). The only `booting` string in doctor source is the log event `tick.booting` (`doctor/src/supervisor.ts:335`).

Nearest code: hive `/buzzing` heading is "Waiting for the hive" and body copy is "Starting required services" (`/home/marioaldayuz/Desktop/development/active/hive/src/dashboard/web/buzzing-screen.tsx:297-308`). That screen has no 60 second `booting` label.

### AC-3 UNMET

Quote (`...index.md:121`): Given the primary daemon becomes healthy during the first 60 seconds, when the portal polls status, then it transitions to ready and offers the regular dashboard URL.

ABSENT. Doctor status HTML links only to `/status.json` (`doctor/src/status-page/server.ts:220-223`).

Nearest code: hive `/buzzing` assigns `window.location` to `/` when `isFleetReady` (`hive/src/dashboard/web/buzzing-screen.tsx:241-248`). That is the hive origin on port 3853, and there is no offered link to `http://127.0.0.1:3850/dashboard`.

### AC-4 UNMET

Quote (`...index.md:122`): Given the primary daemon remains unreachable after 60 seconds and no PID/service signal says it is still starting, when the portal polls status, then it shows a clear action-oriented needs-attention state.

ABSENT. No portal timer switches copy at 60 seconds based on PID or service state.

Nearest code: hive shows "Still working. Some services take longer on first run; this is not stuck." after 45 seconds (`hive/src/dashboard/web/buzzing-screen.tsx:41-42` and `:313-320`). Doctor status can show "needs attention" only when an unresolved escalation record already exists (`doctor/src/status-page/server.ts:194`), which is a prior episode, not this timeout rule.

### AC-5 MET

Quote (`...index.md:123`): Given Doctor has an unresolved needs-attention record from a prior episode, when the portal opens during a new boot, then the prior escalation is shown without being overwritten by the booting state.

Proof: the status provider reads `needsAttention.read()` on each request (`doctor/src/compose/index.ts:902-917`). HTML renders unresolved rows as "needs attention" and dumps the record (`doctor/src/status-page/server.ts:194-202`). Grace skips new incidents (`doctor/src/supervisor.ts:333-336`) and does not clear the store.

### AC-6 MET

Quote (`...index.md:124`): Given port `3852` is occupied, when the portal attempts to bind, then Doctor logs the bind failure and continues running; the primary daemon is not affected.

Proof: default port `3852` (`doctor/src/status-page/server.ts:117`). Bind failure is logged and swallowed (`:329-337`). `runWatchdog` stays up on a referenced interval (`doctor/src/cli/index.ts:419-424`). The listener uses `127.0.0.1` only (`:120`, `:339`) and does not stop the primary daemon.

### AC-7 MET

Quote (`...index.md:125`): Given `DO_NOT_TRACK=1` or telemetry opt-out is configured, when the portal renders and polls local status, then no extra telemetry egress is introduced.

Proof: the status page is `node:http` only, read-only, and "never calls out" (`doctor/src/status-page/server.ts:20-26`). The HTML template has no script and no remote URL (`:206-225`). Opt-out gating of doctor's separate lifecycle emitter is in compose (`doctor/src/compose/index.ts:774-779`) and is not triggered by rendering `/` or `/status.json`.

### AC-8 UNMET

Quote (`...index.md:126`): Given the user is on a headless machine, when install cannot open a browser, then the CLI prints the portal URL, not only the primary dashboard URL.

ABSENT for this PRD's portal URL `http://127.0.0.1:3852/` (implementation note at `...index.md:145`).

Nearest code: when the opener returns false, install prints the hive loopback URL (`src/commands/install.ts:73-74` and `:351-356`). Fleet mode prints a sentence that hive owns the dashboard and opens nothing (`src/commands/install.ts:558-559`). Install still health-gates `127.0.0.1:3850` before that print (`src/commands/install.ts:500-513`).

### AC-9 UNMET

Quote (`...index.md:127`): Given the primary daemon is healthy, when the user opens the portal, then the portal links to `http://127.0.0.1:3850/dashboard` and does not proxy or duplicate the full dashboard.

ABSENT. Doctor status HTML has no `3850/dashboard` link (`doctor/src/status-page/server.ts:206-225`).

Nearest code: honeycomb's dashboard verb opens hive at `http://127.0.0.1:3853/` (`src/dashboard/launch.ts:149-178`, `src/shared/constants.ts:19-23`). Hive is the dashboard and proxies workload APIs (`hive/src/daemon/server.ts:19`, `hive/src/daemon/proxy.ts` mounted from that server).

### AC-10 MET

Quote (`...index.md:128`): Given local mode is not active or a future team/hybrid mode is running, then the portal remains loopback-only and exposes no tenant data or secret material.

Proof: status page binds `127.0.0.1` (`doctor/src/status-page/server.ts:119-120`, `:339`). The escalation record type is diagnosis, steps, recommended action, and timestamp (`doctor/src/rungs/escalation.ts:40-58`). The HTML template interpolates health, daemon names, that record, and suggested commands (`doctor/src/status-page/server.ts:185-225`). No token, authorization header, or tenant payload field is on that type.

Hive, the later human portal, does render product screens after its gate. That is a different surface and is why this PRD stays withdrawn. The Doctor page this criterion names stays loopback and secret-free.

## PRD-069 Application health dashboard

Status banner: superseded by doctor PRD-001, doctor PRD-002, and hive PRD-005, archived 2026-07-03. No QA note and no lettered child. The specified page is `http://127.0.0.1:3852/health` (`...index.md:87`). Doctor's status server 404s every path outside `/`, `/status.json`, and optional `/events` (`doctor/src/status-page/server.ts:261`, `:290-292`). Honeycomb `src/dashboard` has no health panel matching the layer table at `...index.md:62-72`.

Hive's completed `/health` page (`hive/src/dashboard/web/pages/health.tsx`) is the successor. It renders per-service metrics and a Deeplake connected bit from doctor telemetry. It does not implement the layer model in this PRD (portal, doctor, primary, service manager, storage, embeddings, schema, updates, telemetry).

### AC-1 UNMET

Quote (`prd-069-application-health-dashboard-index.md:116`): Given the primary daemon is down but Doctor/portal is running, when the user opens the health dashboard in Chrome, then the page renders and clearly marks primary as unavailable or booting.

ABSENT. `3852/health` is not a route. Hive `/health` labels a service `starting`, `warming up`, `active`, `degraded`, or `error` (`hive/src/dashboard/web/service-icons.tsx:143-149`). Those words are not "unavailable" or "booting", and the card is per registered service (`hive/src/dashboard/web/pages/health.tsx:109-115`).

### AC-2 UNMET

Quote (`...index.md:117`): Given the primary daemon is healthy, when the user opens the portal health dashboard, then it shows primary `ok`, storage status, embeddings status, service manager state, and a link to the regular dashboard.

ABSENT. No single page shows those five fields together. Hive health cards show service state, generic metric keys, and Deeplake `connected` / `unreachable` / `unknown` (`hive/src/dashboard/web/pages/health.tsx:90-159`).

### AC-3 UNMET

Quote (`...index.md:118`): Given embeddings are enabled but not warm, when the health dashboard renders, then embeddings show `starting` or `live, warming`, not `failed`.

ABSENT on a health dashboard. Honeycomb's `/health` reason enum includes `warming` (`src/daemon/runtime/health.ts:159`) and is not rendered as an embeddings tile with the copy `starting` or `live, warming`.

### AC-4 UNMET

Quote (`...index.md:119`): Given storage health is degraded after boot grace, when the health dashboard renders, then storage is marked degraded and the primary daemon status is not collapsed into a generic `dead`.

ABSENT. No storage-versus-primary tiles exist. Hive's Deeplake line can say `unreachable` for one service (`hive/src/dashboard/web/pages/health.tsx:149-152`) and does not mark a storage layer `degraded` beside a separate primary status.

### AC-5 UNMET

Quote (`...index.md:120`): Given Doctor has an unresolved needs-attention record, when the health dashboard renders, then the recommended action and attempted remediation steps are visible without exposing secrets.

ABSENT on the health dashboard route. The Doctor status page does dump `recommendedAction` and `steps` (`doctor/src/status-page/server.ts:199-202`, record shape `doctor/src/rungs/escalation.ts:44-58`). That page is `/`, not the `/health` dashboard this PRD specifies, and it is not the layered health view.

### AC-6 UNMET

Quote (`...index.md:121`): Given telemetry opt-out is enabled, when the health dashboard renders, then it shows telemetry disabled and performs no network egress beyond loopback.

ABSENT. No health view renders "telemetry disabled". A search of `hive/src/dashboard/web` for telemetry opt-out copy returned no match.

### AC-7 UNMET

Quote (`...index.md:122`): Given the portal cannot read a health signal because an endpoint is unavailable, when the page renders, then that tile shows `unknown` with a short reason and the page remains usable.

ABSENT for the layer tiles this PRD lists. Nearest code, a different page: hive shows "Telemetry unavailable. Waiting for doctor to report the fleet." when no service is known (`hive/src/dashboard/web/pages/health.tsx:175-195`), "No metrics reported yet." (`:119-121`), and Deeplake "not reported" or "unknown" (`:140-152`). The page component still returns a frame.

### AC-8 UNMET

Quote (`...index.md:123`): Given the regular dashboard is available, when the health panel renders there, then the labels and statuses match the portal health model.

ABSENT. There is no portal health model in this repo and no matching panel on a `3850` dashboard. Hive's rail and `/health` page share `SERVICE_STATE_LABEL` (`hive/src/dashboard/web/health-rail.tsx:19-20`, `hive/src/dashboard/web/pages/health.tsx:114`). That is one hive vocabulary, not the dual portal-and-primary model in `...index.md:85-108`.

### AC-9 UNMET

Quote (`...index.md:124`): Given a browser refresh occurs repeatedly, when the dashboard polls health, then it does not trigger DeepLake reads beyond already-cached primary health signals.

ABSENT. The specified portal poll of cached primary health does not exist, so the budget is not implemented. Hive `HealthPage` reads `useFleetTelemetry` (`hive/src/dashboard/web/pages/health.tsx:14-15`, `:186`) and does not open a Deep Lake client in that file. That does not install the quoted poll.

### AC-10 UNMET

Quote (`...index.md:125`): Given local mode is running, when the page serves, then it is loopback-only and includes no token, credential value, raw authorization header, or PII.

ABSENT. The page `http://127.0.0.1:3852/health` is not served. Hive's replacement shell is loopback (`hive/src/shared/constants.ts:4-5`, `hive/src/daemon/server.ts:100-101`, `:229-232`) and `renderShell` documents no inline token (`hive/src/daemon/dashboard/host.ts:101-106`). That is the successor page, not this route.

## PRD-070 First browser load experience

Status banner: superseded by hive PRD-003 and PRD-004, archived 2026-07-03. No QA note and no lettered child. Required copy in the same file (`...index.md:79-82`): "Honeycomb is starting.", "The primary daemon is still coming online.", "Honeycomb is ready.", "Honeycomb needs attention." None of those strings exist in `hive/src/dashboard/web/buzzing-screen.tsx`.

### AC-1 UNVERIFIABLE

Quote (`prd-070-first-browser-load-experience-index.md:105`): Given the portal opens before primary readiness, when Chrome loads the page, then a branded graphical boot experience paints within 1 second on a normal local machine.

The 1 second paint was not measured. No Playwright boot-screen timing test is in this shard's trees. Nearest screen: hive `/buzzing` renders the hive mark and a tile grid (`hive/src/dashboard/web/buzzing-screen.tsx:252-296`). Paint time is ABSENT as evidence.

### AC-2 UNMET

Quote (`...index.md:106`): Given the portal boot timer is under 60 seconds and primary is not ready, when the page renders, then it says Honeycomb is booting and shows real status chips without claiming failure.

ABSENT for the sentence "Honeycomb is booting". `/buzzing` says "Waiting for the hive" and "Starting required services" (`hive/src/dashboard/web/buzzing-screen.tsx:297-308`) and renders per-service state chips (`:44-81`). `starting` and `warming` are non-failure labels (`hive/src/dashboard/web/service-icons.tsx:143-148`). The required product sentence is absent.

### AC-3 UNMET

Quote (`...index.md:107`): Given primary becomes ready, when the status poll observes readiness, then the page transitions to a ready state and enables an "Open dashboard" action.

ABSENT. There is no "Open dashboard" control. `/buzzing` hard-navigates to `/` when `isFleetReady` (`hive/src/dashboard/web/buzzing-screen.tsx:211-248`).

### AC-4 UNMET

Quote (`...index.md:108`): Given boot exceeds 60 seconds and primary is still not ready, when the page updates, then it transitions to a calm "still starting" or "needs attention" state based on health data.

ABSENT as a 60 second transition. The progress bar's aria-label is always "Fleet still starting" (`hive/src/dashboard/web/buzzing-screen.tsx:114-120`). After 45 seconds the note is "Still working. Some services take longer on first run; this is not stuck." (`:41-42`, `:313-320`). That note does not switch on PID or health into "needs attention".

### AC-5 UNMET

Quote (`...index.md:109`): Given `prefers-reduced-motion: reduce`, when the page loads, then all nonessential animation is disabled while the page remains visually complete.

ABSENT on the boot screen. `/buzzing` sets infinite animations inline (`hive/src/dashboard/web/buzzing-screen.tsx:69`, `:105`, `:138`, `:291`, keyframes `:355-360`) with no reduced-motion guard. Hive shell CSS limits reduced motion to `.mem-enter` (`hive/src/daemon/dashboard/host.ts:93-97`). Onboarding hero motion is a different route (`hive/src/dashboard/web/onboarding/onboarding-hero.tsx:134`).

### AC-6 UNVERIFIABLE

Quote (`...index.md:110`): Given a mobile viewport, when the page renders, then health chips, event rail, and actions fit without overlap or horizontal scrolling.

No mobile render or screenshot of this boot screen was run. `/buzzing` uses `width: 100%` and `maxWidth: 560` (`hive/src/dashboard/web/buzzing-screen.tsx:270-272`). An event rail and action row of the kind this PRD describes are ABSENT (`...index.md:69-75`), so fit cannot be confirmed from source.

### AC-7 UNMET

Quote (`...index.md:111`): Given the regular dashboard is ready, when the user clicks "Open dashboard", then the browser navigates to `http://127.0.0.1:3850/dashboard` or the configured local dashboard URL.

ABSENT. No "Open dashboard" control. Ready navigation is `window.location.assign("/")` on the hive origin (`hive/src/dashboard/web/buzzing-screen.tsx:247`). The configured dashboard URL in honeycomb is `http://127.0.0.1:3853/` (`src/dashboard/launch.ts:149-178`).

### AC-8 UNMET

Quote (`...index.md:112`): Given the user clicks "View health details", then the browser navigates to the PRD-069 health dashboard route without requiring the primary daemon.

ABSENT on the boot screen. `/buzzing` has no "View health details" control (the component return ends at `hive/src/dashboard/web/buzzing-screen.tsx:252-363`).

Nearest code: the in-app health rail links to `/health` with the label "health details" (`hive/src/dashboard/web/health-rail.tsx:19-20`, `:110-122`). That rail is inside the authenticated shell, and `/health` is hive's page, not `http://127.0.0.1:3852/health`.

### AC-9 MET

Quote (`...index.md:113`): Given portal status JSON is temporarily unavailable, when the page polls, then the visual remains mounted and shows an unknown/offline state rather than blanking.

Proof: the `/buzzing` readiness poll catches fetch failures and keeps the screen (`hive/src/dashboard/web/buzzing-screen.tsx:221-227`). Zero registered services render "Waiting on doctor. No services are registered yet." (`:85-110`, used at `:325-326`) instead of an empty page.

### AC-10 UNVERIFIABLE

Quote (`...index.md:114`): Given a packaged install on this machine, when the first browser opens during boot, then screenshots at desktop and mobile sizes show a nonblank, polished, correctly framed experience.

ABSENT. No desktop or mobile screenshot artifact for this boot experience is in the honeycomb, doctor, or hive requirement trees that were read. The screen source exists (`hive/src/dashboard/web/buzzing-screen.tsx`). Packaged framing was not re-checked.

## QA notes

- 067 `qa/out-of-scope-discoveries.md`: OOS-1 is AC-11. Both listed mitigations (configurable status port, keepalive handle) are in doctor source. See AC-11.
- 068, 069, 070: no `qa/` directory.

## What wave 2 should re-check

- 067 MET lines are in the sibling doctor repo. Confirm `doctor/src/supervisor.ts:333-336` and `doctor/src/config.ts:88` still match before anyone treats this folder as open work.
- Do not move 067 into honeycomb `completed/` unless the librarian decides a pointer to doctor-owned shipped work belongs there. This report recommends stay archive.
- 068-070 unmet rows stay unmet even though hive PRD-003, PRD-004, and PRD-005 are completed. Completing the successor is not the same as meeting these quotes.
- 068 AC-1, AC-5, AC-6, AC-7, and AC-10 are met by the existing Doctor status page. That does not make the boot shell shipped.
- 070 AC-1, AC-6, and AC-10 need a browser or packaged run if a later wave wants to flip them to MET or UNMET.
