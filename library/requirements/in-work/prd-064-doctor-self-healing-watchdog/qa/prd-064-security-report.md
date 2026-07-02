# Security Audit Report: PRD-064 Doctor Self-Healing Watchdog

**Audit date:** 2026-06-27
**Auditor:** security-worker-bee subagent
**Scope:** the entire PRD-064 change set - the new `doctor/` package (`src/{config,state,incidents,logger,health-probe,backoff,remediation,supervisor,install-lock,version}.ts`, `src/telemetry/*`, `src/rungs/*`, `src/update/*`, `src/escalation/*`, `src/status-page/*`, `src/service/*`, `src/cli/*`, `src/compose/*`, `esbuild.config.mjs`, `scripts/pack-check.mjs`, `package.json`); shipped-daemon edits (`src/cli/daemon-service.ts` NEW, `src/cli/runtime.ts`, `src/commands/install.ts`, `src/commands/daemon.ts`); installer edits (`scripts/install/install.sh`, `scripts/install/install.ps1`); workflows (`.github/workflows/ci.yaml`, `.github/workflows/release-doctor.yaml`).
**Node version audited:** >=22.5.0 (doctor engines) / Node 22 (daemon).
**`npm audit` result:** clean - 0 vulnerabilities (doctor ships zero runtime deps; dev-only deps clean).
**OpenClaw bundle scan:** N/A to this change set (Doctor is a standalone npm package, not part of the OpenClaw harness bundle). The deliberate lazy-`createRequire` child_process indirection in `src/cli/daemon-service.ts` mirrors the documented gate-runner discipline and stays fixed-argv.
**CVE watchlist last refreshed:** 2026-04-24 (64 days; within the 120-day window).

---

## Executive Summary

Doctor is an unusually disciplined change set: zero runtime dependencies, fixed-argv `execFile`/`execFileSync` everywhere, a single deny-by-default telemetry allow-list, a loopback-only read-only status page, fail-closed auto-update, and an explicit "never touch `~/.deeplake/`" credential boundary. Two High findings were found and remediated in this session, both the same root cause: a version/path string reaching a subprocess without strict validation. (1) The auto-update **rollback path** passed the daemon's `/health`-reported version (network-sourced, unvalidated) straight into `npm install -g <name>@<version>`, so a spoofed `/health` `version` could make rollback resolve an attacker-chosen npm spec (the gate path was already semver-validated; rollback was the gap). (2) The Windows Scheduled-Task `/TR` builder interpolated `HONEYCOMB_WORKSPACE`/cwd-derived paths into a `cmd /c "..."` string that cmd.exe re-parses at every logon, so a path with cmd metacharacters meant persistent local command execution. Both are now fixed with strict validation; the affected test suites (doctor 378 tests, repo-root daemon-service 27 tests) pass green after the fixes. No Critical findings. No credential exposure, no captured-trace PII egress, no credential purge. Running in the correct order: no PRD-064 QA report exists yet, so `quality-worker-bee` has not run for this branch.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Command Injection (child_process: npm / launchctl / systemctl / schtasks / sc) | FAIL (fixed) | 2 High (1 in update-engine, 1 in daemon-service); the rest clean |
| Supply-Chain / Auto-Update (blessed channel, @latest, semver gate, fail-closed) | OK | 0 |
| Telemetry Exfil / PII (OTLP allow-list, opt-out, PostHog key) | OK | 0 |
| Local Status Page (loopback bind, read-only, traversal, reflected injection) | OK | 0 |
| Credentials (no read/write/clear of `~/.deeplake/`; rung-3 scope) | OK | 0 |
| File Writes (state / incidents / needs-attention / install-lock / removed-packages) | OK | 0 |
| Publish Surface (pack-check, files allowlist, build-injected PostHog key) | OK | 0 |
| Shipped-Daemon Service Code (daemon-service.ts, runtime.ts) | FAIL (fixed) | 1 High (counted above), workspace resolution otherwise sound |

Legend: **OK** = zero findings · **ATTN** = Medium/Low documented · **FAIL** = Critical/High (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

- [x] **Command Injection / Arbitrary-npm-spec (auto-update rollback)** `doctor/src/update/update-engine.ts:135` (`installVersion`) - the gate path semver-validates `toVersion`, but the **rollback path** (`rollback()` -> `installVersion(installedVersion)`) passed the daemon's `/health`-reported version verbatim. That version comes from `readDaemonVersion` (`doctor/src/cli/daemon-version.ts:25` `parseDaemonVersion`), which returns the raw `version` JSON field (only trimmed/non-empty checked) from `http://127.0.0.1:3850/health` (operator-overridable via `DOCTOR_HEALTH_URL`). A spoofed/poisoned `/health` `version` (`latest`, a range like `>=0.0.0`, or any non-semver) would flow into `npm install -g @legioncodeinc/honeycomb@<version>`, letting npm resolve an attacker-chosen spec and defeating the rollback's pin-to-prior-version safety. `execFile` already blocks shell metacharacters; this closed the npm argument/spec-injection gap. **Fix:** `installVersion` now rejects any `version` that fails `parseVersion(...)` (strict SemVer) before composing the npm spec - an unparseable version returns `false` (failed install), so no poisoned source can ever reach `npm install`. Logs `autoupdate.install_rejected_bad_version`. Verified by `doctor npm run test` (update-engine.test.ts 13/13, suite 378/378 green).

- [x] **Command Injection (Windows Scheduled-Task `/TR` cmd.exe string)** `src/cli/daemon-service.ts:273` (`buildSchtasksCreateArgs`) - the `/TR` value is the one place this module composes a SHELL string instead of fixed argv: `cmd /c "cd /d "${spec.workspace}" && set HONEYCOMB_WORKSPACE=${spec.workspace} && "${spec.nodePath}" ... "${spec.entry}""`. schtasks stores it and cmd.exe RE-PARSES it at every logon. `spec.workspace` is derived from `HONEYCOMB_WORKSPACE`/cwd (`src/cli/runtime.ts:161` `resolveDaemonWorkspace`) and `spec.entry` is overridable via `HONEYCOMB_DAEMON_ENTRY`, so a path containing a cmd metacharacter (`& | < > ^ " %` or CR/LF) breaks out of the intended command and runs arbitrary commands under the user's login session on every boot - a persistent local command execution via a stored, auto-running task. **Fix:** added `assertCmdSafe(value)` which throws on any cmd metacharacter / CR / LF, and call it on `spec.workspace`, `spec.nodePath`, and `spec.entry` at the top of `buildSchtasksCreateArgs`. A throw is this module's documented "service path unavailable" signal, so `runtime.ts` falls back to the safe detached spawn (which passes the workspace as a real argv/env value, never a shell string) rather than registering a poisoned task. Legitimate Windows paths never contain these characters. Verified by repo-root `npm run test` (daemon-service.test.ts 19/19 + daemon-lifecycle-service.test.ts 8/8 green).

---

## Medium Findings (follow-up required)

- [ ] **systemd `ExecStart` quoting (robustness / defense-in-depth)** `src/cli/daemon-service.ts:245` (`renderSystemdUnit`) and `doctor/src/service/templates.ts:86` (`renderSystemdUnit`) - the daemon-service variant quotes each argv token (`"${a}"`), which is correct; the doctor-package variant builds `ExecStart=${plan.execPath} ${DOCTOR_RUN_COMMAND}` with no quoting, so an exec path containing a space would mis-split. systemd `ExecStart` does NOT invoke a shell, so this is not a command-injection vector (no shell metachar risk), only a robustness gap for space-bearing paths. The paths are trusted (`process.execPath` / the install path), so severity is Medium. Recommendation: quote the token (`ExecStart="${plan.execPath}" ${DOCTOR_RUN_COMMAND}`) for parity with the daemon-service template. Not fixed in-session (no security exposure; > the 5-line bar once tests are adjusted).

- [ ] **`escapeHtml` omits the single-quote** `doctor/src/status-page/server.ts:187` - the status-page HTML escaper covers `& < > "` but not `'`. All dynamic values are placed in element text or double-quoted attributes, so there is no current XSS path, and the page is loopback-only and read-only. Recommendation: add `.replace(/'/g, "&#39;")` for completeness so a future single-quoted attribute cannot regress. Documentation-only (no exploitable path today).

---

## Low Findings (documentation only)

- [ ] **`reinstall.ts` blessed-version verification is a no-op in compose** `doctor/src/compose/index.ts:184` wires `blessedVersion: options.blessedVersion ?? ""`, so rung-2's post-install verify (`after === deps.blessedVersion`) will not match a real version and returns `unverified`. This is a functionality gap (the reinstall still happens; it just reports unverified), not a security issue - flagged for the implementer, not for remediation here.

---

## Dependency Audit

```text
doctor: found 0 vulnerabilities (npm audit --audit-level=high)
  - zero runtime dependencies (Node built-ins only, by design)
  - devDependencies: @types/node, @vitest/coverage-v8, esbuild, typescript, vitest (all clean)
```

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **Fixed-argv child_process** (rungs, service, command-runner) | `execFile`/`execFileSync`, `shell:false`, no string interpolation of untrusted input | All call sites use argv arrays; `createExecFileRunner` sets `shell:false` explicitly; service argv built from a pure `ServicePlan` | OK |
| **Blessed version semver-validated before `npm i`** | strict SemVer gate on every install spec | Gate path validated; **rollback path was NOT** -> fixed (parseVersion guard in `installVersion`) | OK (fixed) |
| **Fail-closed auto-update** | unreachable/non-2xx/unparseable channel = stay on current; HTTPS; TLS not disabled | `fetchBlessedVersion` returns `{ok:false}` on any error; `decideUpdate` requires `latest===blessed` AND strictly-newer; HTTPS URL, no TLS opts touched | OK |
| **Deny-by-default telemetry allow-list** | only allow-listed keys leave the box; tokens/PII structurally impossible | `buildAllowedAttributes` keeps only `ALLOWED_ATTRIBUTE_KEYS` string values; `BANNED_ATTRIBUTE_KEYS` negative set; bucketed heal-age; `rung:outcome` facts only | OK |
| **Opt-out suppresses all egress** | env (`HONEYCOMB_TELEMETRY=0`, `DO_NOT_TRACK`) + state toggle = no POST | single chokepoint `emitTelemetry` with 3 gates; empty key = hard-disabled | OK |
| **PostHog key is public write-only + build-injected** | not committed; `Authorization: Bearer` header; unset = disabled | injected via esbuild `define` from CI env only; `""` default = disabled; sent in header not query; never logged | OK |
| **Status page loopback-only + read-only** | binds 127.0.0.1 only; GET-only; no traversal; escaped HTML | `s.listen(port, LOOPBACK)` with `LOOPBACK="127.0.0.1"`; exact-string routes only; `req.url` never used as a path; output escaped | OK |
| **No credential purge / no `~/.deeplake/` writes** | Doctor never reads/writes/clears `~/.deeplake/`; rung-3 removes only the package | every `~/.deeplake/` mention is a comment or a recommendation string; `clear-credentials` is recommend-only (deferred); rung-3 uninstalls the npm package only | OK |
| **Safe file writes** (state/incidents/needs-attention/install-lock/removed-packages) | safe paths under workspace dir; atomic; no traversal/symlink | all under `~/.honeycomb/doctor`; temp+rename atomic writes; install-lock uses `wx` exclusive-create + body-timestamp staleness | OK |
| **Publish surface** | tight `files` allowlist; pack-check forbids secrets + source leak; bin present | `files` = bundle/cli.js + bundle/package.json + README + LICENSE; pack-check blocks `.npmrc/.env/secrets/.github/.git/*.pem/credentials.json/src/tests/dist` and requires the bin | OK |
| **Release workflow** | OIDC Trusted Publishing (no NPM_TOKEN); least-privilege; fail-closed | `id-token: write` + `contents: write` only; no caching on publish; preflight aborts on 0.0.0/wrong-name; dry-run default; tag/version guard | OK |
| **Windows schtasks `/TR` no shell injection** | trusted, validated paths into the cmd string | paths were interpolated unvalidated -> fixed (`assertCmdSafe` rejects cmd metacharacters, falls back to spawn) | OK (fixed) |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `doctor/src/update/update-engine.ts` | `installVersion` now rejects non-SemVer `version` (via `parseVersion`) before composing the `npm i -g name@version` spec; closes the unvalidated-rollback-version spec-injection gap. Added `parseVersion` import. |
| `src/cli/daemon-service.ts` | Added `assertCmdSafe(value)` (throws on cmd metacharacters / CR / LF) and call it on `spec.workspace`, `spec.nodePath`, `spec.entry` in `buildSchtasksCreateArgs`, so a poisoned `HONEYCOMB_WORKSPACE`/cwd/`HONEYCOMB_DAEMON_ENTRY` cannot inject a command into the stored Scheduled Task; a throw makes `runtime.ts` fall back to the safe detached spawn. |

Both edited files are part of the (untracked) PRD-064 change set; `git status` confirms no unrelated tracked file was modified and the main checkout at `C:\Users\mario\GitHub\honeycomb` is clean (only a pre-existing unrelated untracked asset). Diff reviewed and confirmed security-scoped on 2026-06-27.

---

## Post-fix test results (no regression)

```text
doctor (cd doctor && npx vitest run):
  Test Files  40 passed (40)
       Tests  378 passed (378)
  - tests/update/update-engine.test.ts ... 13 passed (HIGH-1 fix)
  - tests/service/templates.test.ts ...... 17 passed

repo-root (npx vitest run tests/cli/daemon-service.test.ts tests/cli/daemon-lifecycle-service.test.ts):
  Test Files  2 passed (2)
       Tests  27 passed (27)
  - tests/cli/daemon-service.test.ts ............ 19 passed (HIGH-2 fix)
  - tests/cli/daemon-lifecycle-service.test.ts ... 8 passed

Typecheck: doctor `tsc --noEmit` exit 0; repo-root `tsc --noEmit` reports no daemon-service / new TS errors.
```

---

## Recommended Follow-Up (architectural)

1. **Quote the doctor systemd `ExecStart` token** (`doctor/src/service/templates.ts:86`) for parity with the daemon-service template (Medium; robustness for space-bearing paths).
2. **Harden `escapeHtml` to cover `'`** in the status page (`doctor/src/status-page/server.ts:187`) as defense-in-depth against a future single-quoted attribute.
3. **Wire a real `blessedVersion`** into `compose/index.ts` so rung-2's post-install verification is meaningful (Low; functionality, not security).
4. **Consider applying the same `assertCmdSafe` / semver discipline as a shared helper** if more cmd.exe-string or npm-spec composition sites are added in later waves, so the validate-before-subprocess rule is enforced in one place.
