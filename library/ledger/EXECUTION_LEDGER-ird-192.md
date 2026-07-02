# Execution Ledger — IRD-192: Doctor Windows Scheduled Task invalid restart interval

> Source: `library/issues/backlog/ird-192-doctor-windows-scheduled-task-invalid-restart-interval/`
> Owner Bee (primary): `typescript-node-worker-bee` (Doctor is a TS/Node/ESM/Vitest surface; no Deep Lake / harness / MCP changes in scope).
> Close-out: `security-worker-bee` then `quality-worker-bee`.

## Context (root cause, confirmed by reading the code)

- `doctor/src/service/templates.ts:157` renders `<Interval>PT${RESTART_SEC}S</Interval>` where `RESTART_SEC=5` (line 29). Windows Task Scheduler rejects `PT5S` — the minimum is **PT1M**. macOS launchd `ThrottleInterval` and systemd `RestartSec` correctly take seconds.
- `doctor/src/service/index.ts` `ServiceModule` returns only a `string`; `doctor/src/cli/service-stub.ts:16-21` types `install()`/`uninstall()` as `Promise<string>`. So failure cannot propagate as a non-zero exit.
- `doctor/src/cli/dispatch.ts:192-194` `runService` always returns `EXIT_OK` after printing the line.
- `doctor/src/cli/index.ts:197` hardcodes `serviceState: () => "unknown"`, ignoring the existing `serviceStatus()` export.
- `scripts/install/install.ps1:222-228` and `install.sh:217-223` already gate "Doctor is watching" on the exit code — they become honest automatically once the CLI is honest. AC-7 only needs the failure branch to name `doctor install-service`.

## AC Ledger

| ID | Criterion (from IRD) | Owning Bee | Status | Verification |
|---|---|---|---|---|
| AC-1 | Windows non-admin: `doctor install-service` -> `schtasks /Create` succeeds + `schtasks /Query /TN Doctor` finds the task. | typescript-node-worker-bee | BLOCKED (env) | Unit test proves argv (`/Create /XML <staged> /TN Doctor /F` + `/Run`). Live create blocked by sandbox-wide `E_ACCESSDENIED` (see External blockers). |
| AC-2 | Generated XML imported by `schtasks /Create /XML` is not rejected for any `RestartOnFailure` value. | typescript-node-worker-bee | VERIFIED | Unit test asserts exact `PT1M` + regression no-`PT5S`; LIVE control proves old `PT5S` rejected with `(29,24):Interval:PT5S` while the fixed `PT1M` passes schema validation (COM API parsed it and reached registration). |
| AC-3 | After successful install, `schtasks /Run` -> exactly one Doctor process; status page binds 127.0.0.1:3852. | typescript-node-worker-bee | VERIFIED (unit) | `installCommands` emits `/Run /TN Doctor` (argv.test.ts). Live run blocked by AC-1 env restriction. |
| AC-4 | Running task -> Doctor exits unexpectedly -> Task Scheduler restarts within configured window. | typescript-node-worker-bee | VERIFIED (design) | `RestartOnFailure` interval is now valid `PT1M`, `Count=999` (AC-2). Live crash-recovery blocked by AC-1 env restriction. |
| AC-5 | After install, `doctor status` reports non-`unknown` service state backed by the real service manager. | typescript-node-worker-bee | VERIFIED | `serviceStatus()` wired into CLI via bounded `serviceStateAsync`; a registered task resolves its real state. service-module.test.ts proves the classification. |
| AC-6 | `schtasks /Create` fails -> `doctor install-service` returns non-zero exit + clear failure line. | typescript-node-worker-bee | VERIFIED | `ServiceModule` -> `ServiceResult`; `dispatch` maps `ok:false` -> `EXIT_ERROR`; cli-delegation.test.ts proves both install + uninstall paths. |
| AC-7 | Windows installer: registration fails -> does NOT print "Doctor is watching"; prints non-fatal warning naming `doctor install-service`. | typescript-node-worker-bee | VERIFIED | install.ps1 + install.sh failure branches now name `doctor install-service`; success branch already gated on exit code (unchanged). |
| AC-8 | Repeated `install-service` stays idempotent -> one registered task, one running watchdog. | typescript-node-worker-bee | VERIFIED (unit) | `/F` (force overwrite) is in installCommands; argv.test.ts + service-module.test.ts. Live re-run blocked by AC-1 env restriction. |
| AC-9 | `uninstall-service` after install -> stops/removes the task + deletes staged XML. | typescript-node-worker-bee | VERIFIED | service-module.test.ts Windows uninstall test covers `/Delete` argv + staged-XML removal. |
| AC-10 | macOS + Linux templates/tests unchanged in behavior. | typescript-node-worker-bee | VERIFIED | `RESTART_SEC=5` preserved for launchd/systemd; templates.test.ts AC-10 assertions added; full suite 493/493 green. |

## Wave Plan

### Wave 1 — implementation (single Bee, coupled surface)

`typescript-node-worker-bee` (armed with `typescript-node-stinger`). Model: `claude-4.6-sonnet-medium-thinking` — balanced capability/cost for a coupled, well-specified multi-file TS change with strong existing test coverage; no 1M-context or deep-research need.

In-scope files:
- `doctor/src/service/templates.ts` — split restart timing: keep `RESTART_SEC=5` for POSIX, add `WINDOWS_RESTART_INTERVAL = "PT1M"` and render it into `<RestartOnFailure><Interval>`.
- `doctor/src/cli/service-stub.ts` — evolve `ServiceModule` from `string` to a structured `ServiceResult` (`{ ok: boolean; message: string }`) OR keep string-only and add an outcome signal; prefer structured result (cleaner CLI mapping). Backward-compatible with the injected `serviceModule` field.
- `doctor/src/service/index.ts` — return `ServiceResult` from `install()`/`uninstall()`; `serviceStatus()` already exported (used for AC-5).
- `doctor/src/cli/dispatch.ts` — `runService` maps `result.ok ? EXIT_OK : EXIT_ERROR`.
- `doctor/src/cli/index.ts` — wire `serviceState` to a bounded `await serviceStatus(...)` (or keep sync `unknown` only if bounded async is unsafe in this sync seam — Bee decides; AC-5 requires non-`unknown` for a registered task).
- `doctor/tests/service/templates.test.ts` — assert exact Windows interval `PT1M`, add `PT5S` regression.
- `doctor/tests/service/service-module.test.ts` — assert `install()` returns `{ ok: false }` on manager-command failure.
- `doctor/tests/service/cli-delegation.test.ts` — assert `install-service` returns non-zero exit on failure.
- `scripts/install/install.ps1` + `install.sh` — failure branch copy names `doctor install-service`.

Exit criteria: `cd doctor && npm run ci` green; live `schtasks /Create /XML` accepts the rendered XML.

### Wave 2 — close-out (after Wave 1 VERIFIED)

1. `security-worker-bee` (armed): OWASP/PII/credential scan over the diff. Low risk surface (no network, no auth, execFile no-shell already); confirm the structured-result change didn't open a reporting bypass.
2. `quality-worker-bee` (armed): verify implementation against IRD-192 AC-1..AC-10; writes QA report into `library/issues/backlog/ird-192-.../qa/`.

### Wave 3 — ship

- Bump `doctor/package.json` `0.1.9` -> `0.1.10` (patch; behavior fix only, no API contract break for external consumers — the bin surface is unchanged).
- Commit, push branch `ird/192-doctor-windows-task-fix`, open PR with this ledger.

## External blockers

**AC-1 live create on THIS machine (agent sandbox):** `schtasks /Create /XML <rendered-file> /TN Doctor /F` returns `Access is denied` (HRESULT `0x80070005 / E_ACCESSDENIED`). Isolation test: an identical create against a *trivial* per-user task XML (no `RestartOnFailure` at all) fails with the SAME `Access is denied`. Conclusion: this agent's Windows session is restricted from creating ANY per-user Scheduled Task, regardless of XML content — it is an environment/authorization restriction, NOT a defect in the rendered XML and NOT something a code change can address.

- **AC-2 is proven regardless:** the control test reproduces the original IRD failure exactly (old `PT5S` -> `(29,24):Interval:PT5S ... incorrectly formatted or out of range`), and the fixed `PT1M` XML passes schema validation cleanly (the Task Scheduler COM API parsed it and reached the registration step, where it hit the environment-wide authorization wall — no schema/interval error). The IRD root cause is eliminated.
- **ACs depending on a live registered task (AC-1, AC-3, AC-4, AC-8 live halves) require a non-sandboxed Windows session** (a real user desktop or a Windows CI runner whose service account permits per-user task creation) to run the IRD's live-validation block. The code path is unit-verified end-to-end; only the OS-level create cannot be exercised here.
- **Specific ask to unblock:** run the IRD "Windows live validation" block (lines ~278-306 of the index doc) on a normal Windows user session (not this agent sandbox) — `doctor install-service` then `schtasks /Query /TN Doctor`. Expected: success, since AC-2's schema blocker is removed.

No code-level work is blocked. All probe artifacts were cleaned up; no `Doctor*` task leaked.
