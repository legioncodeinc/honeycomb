# PRD-064 standing (in-work)

Shard: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/` including `qa/`.
Checkout: no `doctor/` tree, no `scripts/install/`, no `.github` workflow whose name or body mentions doctor.
Rule used: Doctor package internals are UNVERIFIABLE unless the criterion is implemented in honeycomb `src/`. Build outputs and `node_modules` were not used. QA notes from 2026-06-27 cite a Windows worktree (`doctor/src/...`) that is not this checkout; those paths are ABSENT and are not proof.

Counts: 58 acceptance-criterion bullets. MET 5. UNMET 0. UNVERIFIABLE 53.

Recommended bucket: **stay in-work**.

Why: PRD-064h (primary daemon as an OS service) is present in `src/cli/daemon-service.ts`, `src/cli/runtime.ts`, and the install/daemon verbs. The other 52 criteria are the `@legioncodeinc/doctor` watchdog (watch loop, Doctor's own service, remediation ladder, Doctor telemetry, blessed auto-update, `doctor` CLI, escalation file and status page). That package is not in this tree, so those criteria cannot be marked met. Completed would require them in source. Backlog would ignore the shipped 064h daemon service. Archive is for withdrawn work; the index and children are still the v1 watchdog, not a withdrawal. The index status line still says Backlog (`prd-064-doctor-self-healing-watchdog-index.md:3`) while the folder is `in-work/`; a later librarian can fix that line. This shard does not edit the PRD.

Adjacent honeycomb code that does not satisfy a Doctor criterion (cited under the relevant AC, not counted as MET):

- `src/cli/route.ts:431-442` is `honeycomb route doctor` (router account health), not the hive-doctor CLI.
- `src/cli/standard-ops.ts:133-195` updates `@legioncodeinc/honeycomb` from `npm view` `@latest`, then health-checks and rolls back. No blessed-version gate and no 30-minute poll.
- `src/daemon/runtime/telemetry/emit.ts` is the daemon telemetry chokepoint, not Doctor's three OTLP streams.
- `src/daemon/runtime/health.ts` exposes `/health` `reasons` (including `schema`). Nothing in this tree classifies those reasons into Doctor rungs.
- `src/commands/install.ts:533-538` writes honeycomb's fleet registry entry for a Doctor reader. That is PRD-071 registration, not the watchdog.

## Index (`prd-064-doctor-self-healing-watchdog-index.md`)

### AC-1

- Quote: "Given Doctor is killed (SIGKILL) or the machine reboots, when the OS service manager runs, then Doctor is back up within its restart window without any user action."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:62`
- Verdict: UNVERIFIABLE
- Source: ABSENT (`doctor/` service unit and supervisor are not in this checkout). The primary-daemon units in `src/cli/daemon-service.ts` supervise honeycomb, not Doctor (064h).

### AC-2

- Quote: "Given the primary daemon stops answering `/health`, when Doctor's watch loop fires, then it restarts the daemon with exponential backoff and the daemon returns to `healthy`, with the whole episode logged locally."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:63`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `/health` exists at `src/daemon/runtime/server.ts:331-352` (`status` `ok` or `degraded`). No Doctor watch loop, backoff, or local episode log.

### AC-3

- Quote: "Given the primary daemon cannot be restored after the full remediation ladder, when the ladder exhausts, then Doctor records a structured "needs attention" report (diagnosis + ordered steps attempted + outcomes) reachable by the dashboard and emitted to telemetry."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:64`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No needs-attention store, ladder, or Doctor telemetry emitter. `src/dashboard/` has no needs-attention render (search returned no match).

### AC-4

- Quote: "Given telemetry is at its default (enabled), when Doctor acts, then error events reach PostHog and installation-health + troubleshooting spans are emitted as OTLP; given `DO_NOT_TRACK=1`, `HONEYCOMB_TELEMETRY=0`, or the install opt-out, then zero telemetry leaves the box."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:65`
- Verdict: UNVERIFIABLE
- Source: ABSENT for Doctor's three streams. Daemon opt-out exists at `src/daemon/runtime/telemetry/emit.ts:95-107` and is a different emitter.

### AC-5

- Quote: "Given a new blessed `@legioncodeinc/honeycomb@latest`, when the 30-min poll observes it and auto-update is enabled, then Doctor updates the primary daemon, verifies `/health`, and on a failed verify rolls back to the prior version."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:66`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No blessed-version fetch and no 30-minute poll. `src/cli/standard-ops.ts:141-180` installs npm `version` (not a blessed channel) and can roll back after a failed `/health` ping; that is an explicit honeycomb update, not this criterion.

### AC-6

- Quote: "Given any condition whatsoever, Doctor never auto-updates its own package; `doctor self-update` is the only code path that bumps `@legioncodeinc/doctor`."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:67`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No `@legioncodeinc/doctor` package and no `doctor self-update` path. `package.json` does not name that package.

### AC-7

- Quote: "Given a user runs `doctor` (no args), then the hive-doctor ASCII art renders followed by a menu of diagnostic and repair commands."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:68`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `src/cli/route.ts:431-442` prints router account counts for `honeycomb route doctor`. It does not render hive-doctor ASCII art or a repair menu.

### AC-8

- Quote: "Given any single remediation step throws (network error, permission error, missing binary), when it fails, then the error is caught and logged and Doctor stays alive and continues the loop - a remediation failure never crashes the watchdog."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:69`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No Doctor remediation loop.

### AC-9

- Quote: "Given a remediation rung, when Doctor reaches it, then it runs per the resolved authority model - restart auto; reinstall auto after 3 failed restarts; uninstall conflicting Hivemind auto whenever detected; credential purge NOT performed (escalate instead) - and every rung is idempotent and logged with before/after state."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:70`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No rung implementation. Hivemind uninstall under `src/daemon/runtime/onboarding/hivemind-uninstall.ts` is the setup migration, not Doctor rung 3.

### AC-10

- Quote: "Given a user opted out at install (`--no-doctor` or the auto-action opt-out), when installation completes, then Doctor is either not installed or installed in observe-only mode per the chosen granularity, and it takes no auto-actions."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md:71`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `scripts/install/` is not in this checkout. `src/commands/install.ts` parses `--ref` and `--home` (`install.ts:207-260`) and always attempts Doctor registry registration (`install.ts:533-538`). It has no `--no-doctor` flag. The bootstrap installer that the PRD names is not here to verify.

## 064a supervisor core (`prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md`)

### AC-064a.1

- Quote: "Given the daemon answers `/health` `ok`, when the loop fires, then Doctor takes no action and logs at low verbosity."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md:35`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `/health` can return `status: "ok"` at `src/daemon/runtime/server.ts:345`. No Doctor loop.

### AC-064a.2

- Quote: "Given `/health` is unreachable, when the loop fires, then Doctor invokes rung 1 (restart) and, on success, the next probe reads `healthy` and the backoff resets."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md:36`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `buildDaemonLifecycle().restart` at `src/cli/runtime.ts:471-480` is the service restart seam Doctor would call. Nothing here is the watch loop or backoff reset.

### AC-064a.3

- Quote: "Given **3** consecutive failed restarts (OD-4 resolved), when the threshold is hit, then Doctor advances to rung 2 (reinstall) rather than restarting forever."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md:37`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064a.4

- Quote: "Given `/health` reports a specific failing subsystem (e.g. `schema`), when the loop classifies it, then the chosen rung matches the reason (targeted, not blind)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md:38`
- Verdict: UNVERIFIABLE
- Source: ABSENT for the classifier. Subsystem reasons, including `schema`, are built at `src/daemon/runtime/health.ts:520-542` and attached on local `/health` at `src/daemon/runtime/server.ts:343-349`.

### AC-064a.5

- Quote: "Given a remediation step throws, when it fails, then the exception is caught, recorded in the incident, and the loop continues (AC-8 parent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md:39`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No incident recorder.

### AC-064a.6

- Quote: "Given Doctor restarted the daemon, when it did so, then a cooldown prevents fighting the daemon's own lock/restart-helper, respecting `~/.honeycomb/daemon.pid`."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md:40`
- Verdict: UNVERIFIABLE
- Source: ABSENT for the Doctor cooldown. The daemon lock now lives under the fleet runtime dir (`src/daemon/runtime/assemble.ts:923-941`), with a window-only legacy `daemon.pid` stamp at `assemble.ts:962-969`. `src/cli/runtime.ts:226-228` still reads the legacy pid as a fallback. That is the lock Doctor would have to respect; the cooldown itself is not here.

## 064b self-supervision (`prd-064b-doctor-self-healing-watchdog-self-supervision-and-install-integration.md`)

### AC-064b.1

- Quote: "Given a clean install on each OS, when bootstrap completes (without opt-out), then a Doctor service is registered and running."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064b-doctor-self-healing-watchdog-self-supervision-and-install-integration.md:33`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `src/cli/daemon-service.ts` registers the primary daemon (`SERVICE_LABEL` `com.legioncode.honeycomb` at `daemon-service.ts:56`), not a Doctor unit. Header at `daemon-service.ts:35-37` says Doctor's own service is out of this module.

### AC-064b.2

- Quote: "Given Doctor is SIGKILLed, when the service manager notices, then it restarts Doctor within the configured window (AC-1 parent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064b-doctor-self-healing-watchdog-self-supervision-and-install-integration.md:34`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064b.3

- Quote: "Given a reboot, when the machine comes back, then Doctor starts automatically before/independently of the primary daemon."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064b-doctor-self-healing-watchdog-self-supervision-and-install-integration.md:35`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064b.4

- Quote: "Given `--no-doctor` at install, when bootstrap completes, then no service is registered and no Doctor process runs (AC-10 parent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064b-doctor-self-healing-watchdog-self-supervision-and-install-integration.md:36`
- Verdict: UNVERIFIABLE
- Source: ABSENT. Same installer gap as AC-10. `scripts/install/` is not in this checkout.

### AC-064b.5

- Quote: "Given `doctor uninstall-service`, when run, then the OS unit is removed and does not resurrect on next boot."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064b-doctor-self-healing-watchdog-self-supervision-and-install-integration.md:37`
- Verdict: UNVERIFIABLE
- Source: ABSENT. Honeycomb can unregister its own daemon unit (`src/cli/daemon-service.ts:791-799`, `860-872`, `943-961`). That is not `doctor uninstall-service`.

### AC-064b.6

- Quote: "Given a non-admin/unprivileged context, when service registration is not possible, then Doctor falls back to a userland-scoped service (systemd `--user`, launchd LaunchAgent, Windows per-user Scheduled Task) rather than failing the install."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064b-doctor-self-healing-watchdog-self-supervision-and-install-integration.md:38`
- Verdict: UNVERIFIABLE
- Source: ABSENT for Doctor. The same three userland managers exist for the primary daemon at `src/cli/daemon-service.ts:11-13` and `187-209`.

## 064c remediation ladder (`prd-064c-doctor-self-healing-watchdog-remediation-ladder.md`)

### AC-064c.1

- Quote: "Given 3 failed restarts, when rung 2 fires, then Doctor reinstalls the primary and a stale-route symptom is gone (version reported by `/health` matches the blessed version)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064c-doctor-self-healing-watchdog-remediation-ladder.md:37`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `/health` includes `version` at `src/daemon/runtime/server.ts:347`. No reinstall rung and no blessed-version compare.

### AC-064c.2

- Quote: "Given a conflicting `@deeplake/hivemind` global is detected, when rung 3 fires, then it is removed automatically and Honeycomb's shared `~/.deeplake/` state is left intact."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064c-doctor-self-healing-watchdog-remediation-ladder.md:38`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064c.3

- Quote: "Given a suspected credential fault, when Doctor reaches that condition, then it does NOT delete credentials and instead escalates (rung 4) noting the action it would have taken."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064c-doctor-self-healing-watchdog-remediation-ladder.md:39`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No Doctor credential-fault branch to inspect. Absence of a purge path cannot be shown without the package.

### AC-064c.4

- Quote: "Given any rung runs twice, when re-run, then the second run is a safe no-op (idempotent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064c-doctor-self-healing-watchdog-remediation-ladder.md:40`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064c.5

- Quote: "Given rung 3 removes a package, when it does, then a timestamped record of what was removed is written before deletion."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064c-doctor-self-healing-watchdog-remediation-ladder.md:41`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064c.6

- Quote: "Given any rung, when it completes, then before/after state is recorded in `incidents.ndjson`."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064c-doctor-self-healing-watchdog-remediation-ladder.md:42`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No `incidents.ndjson` writer in `src/`.

## 064d telemetry (`prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md`)

### AC-064d.1

- Quote: "Given default settings, when Doctor catches an error, then a scrubbed ERROR-severity OTLP log record reaches PostHog Logs at `/i/v1/logs`."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md:34`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064d.2

- Quote: "Given default settings, when the install-health timer fires, then an INFO OTLP log record (version, health, OS, last-heal age, `device_id`) is emitted."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md:35`
- Verdict: UNVERIFIABLE
- Source: ABSENT. Device id minting for fleet assets is `src/daemon/runtime/assets/device.ts` (PRD-072), not this install-health timer.

### AC-064d.3

- Quote: "Given a remediation episode completes, when it ends, then an OTLP log record is emitted reflecting the ordered steps and outcomes, carrying the `device_id`."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md:36`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064d.7

- Quote: "Given the emitter runs, when it sends, then it uses no OpenTelemetry SDK dependency (hand-rolled OTLP/JSON over `fetch`), verified by the dependency list."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md:37`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No Doctor `package.json` in this checkout to verify.

### AC-064d.4

- Quote: "Given `DO_NOT_TRACK=1` or `HONEYCOMB_TELEMETRY=0` or `--no-telemetry`, when any of the three streams would fire, then nothing leaves the box (verifiable at the single chokepoint) (AC-4 parent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md:38`
- Verdict: UNVERIFIABLE
- Source: ABSENT for Doctor's chokepoint. Daemon opt-out is `src/daemon/runtime/telemetry/emit.ts:95-107`.

### AC-064d.5

- Quote: "Given any emission, when serialized, then no credential, token, or PII field is present (allow-list enforced)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md:39`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No Doctor allow-list serializer.

### AC-064d.6

- Quote: "Given the telemetry sink is unreachable, when emission fails, then Doctor swallows the error and continues healing (telemetry never blocks)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064d-doctor-self-healing-watchdog-telemetry-and-observability.md:40`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

## 064e auto-update (`prd-064e-doctor-self-healing-watchdog-auto-update-engine.md`)

### AC-064e.1

- Quote: "Given a blessed version newer than installed, when the poll fires and auto-update is on, then the daemon is updated to the blessed version within ~30 min."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064e-doctor-self-healing-watchdog-auto-update-engine.md:34`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No poll, no `blessed-version.json` client.

### AC-064e.2

- Quote: "Given npm `@latest` is newer but NOT blessed, when the poll fires, then Doctor does NOT update (gate holds)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064e-doctor-self-healing-watchdog-auto-update-engine.md:35`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `updateHoneycomb` at `src/cli/standard-ops.ts:141-157` installs whatever `npm view @legioncodeinc/honeycomb version` returns. That path does not implement the blessed gate, so it is not this criterion.

### AC-064e.3

- Quote: "Given an update whose post-update `/health` fails, when verify fails, then Doctor rolls back to the prior version and the daemon returns to healthy on the old version."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064e-doctor-self-healing-watchdog-auto-update-engine.md:36`
- Verdict: UNVERIFIABLE
- Source: ABSENT for Doctor. A honeycomb CLI rollback with `/health` verify is `src/cli/standard-ops.ts:156-188`. It is not Doctor's update transaction.

### AC-064e.4

- Quote: "Given `--no-auto-update` or a pinned version, when a newer blessed version exists, then no update occurs."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064e-doctor-self-healing-watchdog-auto-update-engine.md:37`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No `--no-auto-update` parse in `src/`.

### AC-064e.5

- Quote: "Given any update or rollback, when it completes, then a telemetry event records from-version, to-version, and outcome."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064e-doctor-self-healing-watchdog-auto-update-engine.md:38`
- Verdict: UNVERIFIABLE
- Source: ABSENT. `updateHoneycomb` returns those fields in a CLI `details` object (`standard-ops.ts:152`, `171`, `188`) and does not emit a Doctor telemetry event.

### AC-064e.6

- Quote: "Given an update is in progress, when the watch loop also wants to act, then they are serialized (no concurrent npm installs / restarts)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064e-doctor-self-healing-watchdog-auto-update-engine.md:39`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No install lock shared with a watch loop.

## 064f CLI (`prd-064f-doctor-self-healing-watchdog-cli-and-ux.md`)

### AC-064f.1

- Quote: "Given `doctor` with no args, when run, then the ASCII art renders and a command menu is shown (AC-7 parent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064f-doctor-self-healing-watchdog-cli-and-ux.md:43`
- Verdict: UNVERIFIABLE
- Source: ABSENT. See AC-7. `src/cli/route.ts:431-442` is a different command.

### AC-064f.2

- Quote: "Given `doctor status`, when run, then it prints daemon health, service state, both package versions, last heal, and opt-out flags."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064f-doctor-self-healing-watchdog-cli-and-ux.md:44`
- Verdict: UNVERIFIABLE
- Source: ABSENT. Honeycomb daemon status (`src/commands/daemon.ts:132-149`) prints process and `/health` reachability only. It does not print both package versions, last heal, or Doctor opt-out flags.

### AC-064f.3

- Quote: "Given `doctor diagnose`, when run, then it reports the recommended rung and takes NO action."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064f-doctor-self-healing-watchdog-cli-and-ux.md:45`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

### AC-064f.4

- Quote: "Given `uninstall-hivemind`, when run interactively, then it confirms before removing the conflicting package and never deletes shared `~/.deeplake/` state. (No `clear-credentials` command in v1 - credential purge is deferred, OD-4.)"
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064f-doctor-self-healing-watchdog-cli-and-ux.md:46`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No `uninstall-hivemind` command on the Doctor CLI in this tree.

### AC-064f.5

- Quote: "Given `doctor self-update`, when and only when run explicitly, then `@legioncodeinc/doctor` is updated; no other code path updates it (AC-6 parent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064f-doctor-self-healing-watchdog-cli-and-ux.md:47`
- Verdict: UNVERIFIABLE
- Source: ABSENT. See AC-6.

### AC-064f.6

- Quote: "Given the daemon is down, when `doctor status`/`diagnose` run, then they still work (Doctor does not depend on the daemon to report)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064f-doctor-self-healing-watchdog-cli-and-ux.md:48`
- Verdict: UNVERIFIABLE
- Source: ABSENT.

## 064g dashboard escalation (`prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md`)

### AC-064g.1

- Quote: "Given the ladder exhausts, when escalation fires, then a structured needs-attention record (diagnosis + steps + outcomes + recommended action) is persisted locally (AC-3 parent)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md:32`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No local needs-attention file writer.

### AC-064g.2

- Quote: "Given the daemon recovers after an escalation, when the dashboard loads, then it renders the most recent needs-attention report and its resolution state."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md:33`
- Verdict: UNVERIFIABLE
- Source: ABSENT. The dashboard lives in this repo and has no needs-attention report or resolution state (no match under `src/dashboard/`). The record the page would render is Doctor state, also absent, so the criterion cannot be marked met or unmet from a partial page.

### AC-064g.3

- Quote: "Given the user is credentialed and the hosted sink is enabled, when escalation fires, then the report reaches the hosted surface so we see it remotely."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md:34`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No Doctor hosted escalation sink.

### AC-064g.4

- Quote: "Given the daemon is down and the local status page is enabled, when the user hits Doctor's loopback port, then they see current health + the escalation + suggested commands."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md:35`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No Doctor status-page server. Daemon `/health` (`src/daemon/runtime/server.ts:331`) is a different port and is down in this given.

### AC-064g.5

- Quote: "Given an escalation is later resolved (heal succeeds on a subsequent loop), when resolution occurs, then the report is marked resolved so the dashboard banner clears."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md:36`
- Verdict: UNVERIFIABLE
- Source: ABSENT. No resolution mark and no dashboard banner.

## 064h primary daemon OS service (`prd-064h-doctor-self-healing-watchdog-primary-daemon-os-native-service.md`)

This child is implemented in honeycomb `src/`. Spawn fallback when no manager is available, or when register throws, is `src/cli/runtime.ts:407-413` (`HONEYCOMB_DAEMON_SERVICE=spawn` forces it, `src/cli/daemon-service.ts:69-74`). That fallback is the PRD open question left in code. The criteria below are the service-preferred path.

### AC-064h.1

- Quote: "Given a clean install, when bootstrap completes, then the primary daemon runs as an OS service and answers `/health`."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064h-doctor-self-healing-watchdog-primary-daemon-os-native-service.md:33`
- Verdict: MET
- Source: `src/commands/install.ts:501-505` calls `ensureDaemonRunning`, which calls `lifecycle.start()` at `src/commands/daemon.ts:177-184`. `start` registers the unit and waits for `/health` at `src/cli/runtime.ts:394-402`. `/health` is `src/daemon/runtime/server.ts:331-352`. Per-OS register: launchd `src/cli/daemon-service.ts:781-789`, systemd `849-858`, schtasks `920-941`.

### AC-064h.2

- Quote: "Given the daemon process is killed, when the OS service manager notices, then it restarts the daemon without Doctor having to intervene (liveness floor)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064h-doctor-self-healing-watchdog-primary-daemon-os-native-service.md:34`
- Verdict: MET
- Source: launchd `KeepAlive` `src/cli/daemon-service.ts:414-415`; systemd `Restart=always` `src/cli/daemon-service.ts:453`; Windows in-action relaunch loop `src/cli/daemon-service.ts:637-642` plus `RestartOnFailure` `src/cli/daemon-service.ts:678-681`. The file states Task Scheduler cannot see a crash under `conhost --headless` (exit 0), so the cmd loop is the Windows floor (`daemon-service.ts:580-591`). No Doctor process is required.

### AC-064h.3

- Quote: "Given a reboot, when the machine returns, then the daemon starts automatically."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064h-doctor-self-healing-watchdog-primary-daemon-os-native-service.md:35`
- Verdict: MET
- Source: launchd `RunAtLoad` `src/cli/daemon-service.ts:412-413`; systemd `WantedBy=default.target` `src/cli/daemon-service.ts:456-457` with `systemctl --user enable --now` at `src/cli/daemon-service.ts:856-857`; Windows `LogonTrigger` `src/cli/daemon-service.ts:656-659`. These are user-session start (LaunchAgent, systemd user, logon task), matching the resolved per-user model in the index, not a system-wide pre-login unit.

### AC-064h.4

- Quote: "Given the service starts the daemon, when it does, then cwd/`HONEYCOMB_WORKSPACE` is a writable repo-root workspace (never `system32`), closing the "secrets 502" class."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064h-doctor-self-healing-watchdog-primary-daemon-os-native-service.md:36`
- Verdict: MET
- Source: `resolveDaemonWorkspace` picks the first writable of `HONEYCOMB_WORKSPACE`, cwd, then the runtime dir (`src/cli/runtime.ts:195-201`). `buildServiceSpec` pins that workspace (`src/cli/runtime.ts:253-264`). Units set cwd and `HONEYCOMB_WORKSPACE`: launchd `src/cli/daemon-service.ts:401-406`, systemd `src/cli/daemon-service.ts:451-452`, schtasks `cd /d` plus `set HONEYCOMB_WORKSPACE` `src/cli/daemon-service.ts:643`.

### AC-064h.5

- Quote: "Given Doctor performs a rung-1 restart, when it does, then it goes through the service manager and the PID/lock guard prevents any double-bind."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064h-doctor-self-healing-watchdog-primary-daemon-os-native-service.md:37`
- Verdict: UNVERIFIABLE
- Source: Honeycomb has a service-manager restart seam (`src/cli/runtime.ts:471-480`, launchd `kickstart -k`, systemd `restart`, schtasks `/End` then `/Run`). This checkout does not show Doctor invoking that seam, so the criterion is not met here and is not unmet inside honeycomb source.

### AC-064h.6

- Quote: "Given `honeycomb` start/stop/status, when run, then they reflect and control the service state (not a stray detached process)."
- PRD: `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064h-doctor-self-healing-watchdog-primary-daemon-os-native-service.md:38`
- Verdict: MET
- Source: `buildDaemonLifecycle` start registers (`src/cli/runtime.ts:394-402`), stop goes through the manager (`src/cli/runtime.ts:432-444`), status sets `serviceManager` when the unit is registered (`src/cli/runtime.ts:447-468`). Verbs: `src/commands/daemon.ts:91-164`. Structured status includes `details.serviceManager` at `src/commands/standard-interface.ts:78-101`. Install prints the manager at `src/commands/install.ts:367-374`. Note for wave 2: `honeycomb daemon status` text at `src/commands/daemon.ts:142-147` does not print the manager name; the lifecycle object and the standard status details do.

## QA notes (not acceptance criteria)

Read, not scored as ACs. All three cite `doctor/` paths that are ABSENT here.

- `qa/prd-064-qa-report.md:14` claims 41 of 56 criteria verified on branch `legion/competent-nightingale-900e0c` in a Windows worktree. This checkout cannot confirm that. Bullet count in the current PRD files is 58 (10 index + 48 child bullets, including `AC-064d.7`).
- `qa/prd-064-qa-report.md:49-50` warns `doctor/src/compose/index.ts:184` leaves `blessedVersion` empty. ABSENT.
- `qa/prd-064-security-report.md:5` scopes `doctor/src/**` plus `src/cli/daemon-service.ts`. Only the daemon-service half is in this tree.
- `qa/prd-064-aikido-triage.md:26-36` lists Doctor file sinks A1-A6 as ABSENT. A7 (`src/cli/daemon-service.ts`) is present; path containment for unit files is `containedUnitPath` / `stagedTaskXmlPath` at `src/cli/daemon-service.ts:348-366` and `557-565`.

## Bucket action for wave 2

Confirm stay in `in-work`. Do not move to `completed` on the QA report. Do not move to `backlog` unless a later pass shows the 064h service code is gone. Do not archive.
