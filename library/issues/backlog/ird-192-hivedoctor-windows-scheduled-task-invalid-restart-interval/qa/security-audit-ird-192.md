# Security Audit — IRD-192 (HiveDoctor Windows Scheduled Task Restart Interval)

| Field | Value |
|---|---|
| **Audit** | IRD-192 — `ird/192-hivedoctor-windows-task-fix` |
| **Bee** | `security-worker-bee` |
| **Date** | 2026-06-30 |
| **Scope** | `git diff HEAD` working-tree changes (13 files): `hivedoctor/src/cli/{context,dispatch,index,service-stub}.ts`, `hivedoctor/src/service/{index,templates}.ts`, the 6 test files, and `scripts/install/install.{ps1,sh}` |
| **Verdict** | **🟢 CLEAN — no security regressions introduced by this diff. No findings. No remediation required.** |

## Executive summary

This is a focused audit of the IRD-192 diff. The change is behavior-preserving at the security
boundary: it (a) swaps a Task-Scheduler-rejected restart interval for an accepted one, (b) changes
the service-module return type from `Promise<string>` to `Promise<ServiceResult>` and propagates
the new `ok` flag to an honest exit code, and (c) wires a bounded async OS-service status probe
into `hivedoctor status`. **None of the changed lines touch the command-launch path, the XML
escaping, or add any new interpolation of untrusted data.** The structured-result refactor is a
*reduction* of information flow (a string becomes a typed struct), not new exposure.

**Scope note (reduced fidelity).** The `security-stinger` catalog is tuned for the *Hivemind* stack
(Deep Lake SQL layer, pre-tool-use gate, captured-trace PII, OpenClaw supply chain). This audit
target is the **`hivedoctor/` subpackage** — a local-only TS/Node watchdog CLI with **no network
surface, no auth, and no Deep Lake access in the changed code**. I applied the Stinger's severity
rubric and its universal security principles (no-shell argv discipline, secret/PII leakage,
dependency hygiene) and verified them against the actual diff. The Hivemind-specific catalog items
(SQL injection, gate bypass, org-scope coercion) are **not applicable** to this surface and are
marked as such below.

**Ordering check.** No `*-qa-report.md` / `*-quality-report.md` for this branch exists in
`library/qa/` or this issue dir (the two reports present are for unrelated areas: `cursor-extension`
and `dashboard`). `security-worker-bee` therefore runs in correct order before `quality-worker-bee`;
no ordering inversion to flag.

## Per-area assessment

### 1. Command injection / shell-out safety — ✅ CLEAN

**What changed.** The `ServiceModule` interface now returns `Promise<ServiceResult>` instead of
`Promise<string>`, and `dispatch.ts` maps `ok:false → EXIT_ERROR`. Separately, `cli/index.ts`
wires `serviceStateAsync → serviceStatus()` for `hivedoctor status`.

**Verification.**
- The structured-result refactor is **type-only** at the command boundary. The actual command
  launch path is unchanged: `runAll()` calls `runner.run(cmd.command, cmd.args, {timeoutMs})`
  (`hivedoctor/src/service/index.ts:117`), passing **argv arrays**, not a concatenated string.
- `createExecFileRunner()` (`hivedoctor/src/rungs/command-runner.ts`) wraps `node:child_process.
  execFile` with `{ shell: false, windowsHide: true }` for every non-`npm` command — including
  `schtasks`, `launchctl`, `systemctl`, `sc`. **No shell = no metacharacter injection vector.**
- The new `serviceStateAsync` wiring reuses the **identical** no-shell runner with the **identical**
  bounded timeout (`SERVICE_COMMAND_TIMEOUT_MS = 15_000`, `hivedoctor/src/service/index.ts:43,253`).
  `serviceStatus()` (`hivedoctor/src/service/index.ts:241-265`) runs `statusCommand(p, uid)` — a
  fixed argv per manager — and never throws (resolves `"unknown"` on spawn error / unsupported
  platform). The probe is fail-safe and bounded; it cannot block `status` indefinitely.
- `argv.ts` builders construct only argv arrays of fixed-literal subcommands plus `plan.execPath`
  / `plan.unitPath` / `WINDOWS_TASK_NAME` / `SYSTEMD_UNIT_NAME` (all locally-resolved constants,
  never user input). No diff line introduced string interpolation into a command line — confirmed
  by `git diff | grep` for `run(`/`exec(`/`spawn` with `${` (NONE FOUND).

**No findings.** The new structured-result path and the async status probe did not introduce any
string interpolation into a command line; the no-shell + bounded-timeout discipline is intact.

### 2. XML injection — ✅ CLEAN

**What changed.** `renderScheduledTaskXml()` now emits `<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`
(was `PT${RESTART_SEC}S`).

**Verification.**
- `WINDOWS_RESTART_INTERVAL = "PT1M" as const` (`hivedoctor/src/service/templates.ts:41`) is a
  **fixed literal**, derived from no user/env input. The template interpolates only this constant.
- All executable paths in the XML still go through `escapeXml()`: `process.execPath`, `plan.execPath`,
  and `WINDOWS_TASK_NAME` (`templates.ts:69-70,149`). `escapeXml()` (`templates.ts:54-60`) escapes
  `& < > " '`, the full XML-special set. No exec path is interpolated raw.
- The change is a literal swap (`PT5S` → `PT1M`); it removed a seconds-derived interpolation and
  replaced it with a fixed constant, slightly *reducing* interpolation surface.

**No findings.** Exec paths remain escaped; the new interval is a fixed constant.

### 3. Error / secret leakage in messages — ✅ CLEAN

**What changed.** `ServiceResult.message` strings are now printed to stdout via `dispatch.ts`
(`io.out(result.message)`).

**Verification.**
- The 7 `message:` strings (`hivedoctor/src/service/index.ts:150,169,183,190,201,224,230`) interpolate
  only: `error.message` (FS/plan-resolution failures), `firstFailure?.command` (the binary name,
  e.g. `"schtasks"`), and `p.manager`/`scopePhrase(p)` (e.g. `"schtasks", "user"`). They contain
  **no tokens, credentials, org ids, or captured-trace content**, and they do **not** echo
  `result.stdout`/`result.stderr` (full command output is deliberately *not* surfaced — only a
  coarse binary-name failure description).
- **Parity with pre-diff behavior:** the old code returned the same strings (e.g. the HEAD version
  of `index.ts:148` was ``return `Could not register HiveDoctor service: ${error instanceof Error ?
  error.message : "unknown error"}.`;``). The refactor wrapped the *identical* string in
  `{ ok: false, message: <same string> }`. This is a **reduction** of information flow (a free-form
  string became a typed struct with an explicit `ok`), not new exposure.
- `error.message` here originates from node:fs / plan-resolution — local FS path errors only. No
  network, no auth, no PII source feeds these messages.
- Secret/token grep over the diff (`token|secret|password|authorization|bearer|api[_-]?key|credential`):
  **NONE FOUND.**

**No findings.** Messages carry only a coarse, local failure description; the change reduces
(rather than expands) the information surface.

### 4. Install-script safety — ✅ CLEAN

**What changed.** `install.ps1` and `install.sh` changed one line each: the failure branch now
prints `"... Run 'hivedoctor install-service' to see why."`.

**Verification.**
- Both diffs are **static string literals** written via `Write-Host` (PS) / `printf` (sh). No
  `Invoke-Expression`, `eval`, `$()`, backtick command substitution, or environment-variable echo
  was introduced.
- No sensitive env values (tokens, paths, org ids) are referenced. The new copy only names a
  user-actionable subcommand.
- The installers correctly consume the new non-zero exit code from `install-service` (IRD-192 AC-7):
  they treat a failed service registration as non-fatal (Honeycomb itself is already installed)
  while no longer falsely claiming "watching". This is an honesty improvement with no exec vector.

**No findings.** The new lines are inert static copy; no code-execution or value-leak vector.

### 5. OWASP / PII / credential catalog applicability — ✅ CLEAN (N/A surface)

The `security-stinger` catalogs (Deep Lake SQL injection, pre-tool-use gate bypass, org-scope
`me|team` coercion, captured-trace PII, OpenClaw supply chain) describe the **Hivemind** stack.
The changed code is entirely within `hivedoctor/` (a local loopback watchdog CLI) plus two install
scripts. Specifically, in the diff:

- **No network surface** — no `fetch`, `http`, `Authorization`, or Deep Lake calls added.
- **No auth surface** — no credentials, JWTs, org ids, or RBAC logic touched.
- **No captured-trace PII** — `hivedoctor` does not read or write `sessions`/`memory` tables.
- **No dependency change** — `package.json`/lockfile untouched by this diff; no new supply-chain
  surface. (`npm audit` / OpenClaw bundle scan are owned by `dependency-audit-worker-bee` and are
  not regressed by a no-dependency diff.)

**No findings.** The Hivemind-specific catalog items are not applicable to this surface; the
universal checks (no-shell argv, secret/PII leakage, no new deps) all pass.

## Findings table

| # | Severity | Area | Location | Finding | Status |
|---|---|---|---|---|---|
| — | — | (all 5 areas) | — | None detected. Each area verified against the actual diff with file:line evidence above. | N/A |

## Remediation applied

**None.** No security regression was introduced by this diff. No code was changed by this audit.
Per the Stinger directive ("Do NOT change behavior — only remediate genuine security regressions"),
and because there were zero Critical/High/Medium/Low findings, no remediation was warranted and
none was performed. The working tree is therefore unchanged by this audit (no `npm run ci` re-run
is triggered — the build state is exactly as the developer left it).

## Verification

- `git diff HEAD --stat` reviewed: 13 files, +272/−60, confined to `hivedoctor/src/{cli,service}/`,
  `hivedoctor/tests/`, and `scripts/install/`. No unrelated changes.
- Deterministic greps over the diff: command-interpolation patterns → NONE; secret/token patterns
  → NONE; `result.stdout`/`stderr` echo in messages → NONE.
- No-shell + bounded-timeout runner (`execFile`, `shell:false`, 15s timeout) confirmed intact for
  both the install/uninstall path and the new async status path.
