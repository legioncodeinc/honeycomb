# Security Audit Report: feature/prd-072-apiary-state-root (uncommitted working tree)

**Audit date:** 2026-07-04
**Auditor:** security-worker-bee subagent
**Scope:** Uncommitted PRD-072 changes in the honeycomb repo: `src/shared/fleet-root.ts` (new), `src/daemon/runtime/state-migration/` (new), `src/hooks/shared/pre-tool-use.ts`, `src/daemon-client/vfs/index-gen.ts`, `src/cli/daemon-service.ts`, `src/cli/runtime.ts`, `src/commands/install.ts`, `src/commands/asset.ts`, `src/daemon/runtime/telemetry/fleet-registry.ts`, `src/daemon/runtime/telemetry/fleet-store.ts`, `src/daemon/runtime/secrets/store.ts`, `src/daemon/runtime/assets/device.ts`, `src/daemon/runtime/assets/registry.ts`, `src/daemon/runtime/assemble.ts`, `src/daemon/runtime/codebase/{api,discovery,snapshot}.ts`, `src/daemon/runtime/memories/nectar-recall-config.ts`, `src/daemon/runtime/skillify/watermark.ts`, `src/daemon-client/skillify/{config,manifest}.ts`, `src/notifications/state.ts`, plus the new PRD-072 test files.
**Node version audited:** >= 22.5.0 (package.json engines)
**`npm audit` result:** clean (0 vulnerabilities at `--audit-level=high`)
**OpenClaw bundle scan:** not re-run standalone; `npm run ci` (the repo gate) passed, and no changed file touches the OpenClaw bundle inputs
**Ordering pre-flight:** no QA report for this branch exists (newest entries in `library/qa/security/` predate the branch), so the run-before-quality rule holds

---

## Executive Summary

The PRD-072 state-root branch is in good shape: no Critical or High findings. Two Medium findings were found and remediated in this session: (1) `resolveFleetRoot` honored a RELATIVE `APIARY_HOME` / `XDG_STATE_HOME`, which re-anchored every state path (machine key, telemetry SQLite, pid/lock, registry write target) on `process.cwd()`, the exact service-manager System32 footgun the ADR-0003 chain exists to close; (2) the pre-tool-use memory-mount gate matched only forward-slash, case-sensitive shapes, so a Windows backslash or case-varied path (`C:\Users\ada\.apiary\honeycomb\memory\x`) bypassed both the read interception and the Write/Edit deny and reached the real filesystem. Both are fixed, with regression tests, and `npm run ci` (typecheck + jscpd + vitest 4096 passed + SQL audit) is green. The state migration movers, registry window writes, and service-unit pinning all checked out clean.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deeplake SQL API) | OK | 0 |
| Dependency & OpenClaw Bundle | OK | 0 |
| Configuration (fleet-root resolution, file modes, service units) | ATTN | 2 Medium (fixed), 2 Low (documented) |
| Pre-Tool-Use Gate & Prompt Injection | ATTN | 1 Medium (fixed) |

Legend: **OK** = zero findings. **ATTN** = Medium/Low findings documented. **FAIL** = Critical/High findings (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings (fixed in this session under the trivial-fix exception)

- [x] **CWD-ANCHORED STATE ROOT (config / insecure design)** `src/shared/fleet-root.ts:70,74` - `resolveFleetRoot` returned `APIARY_HOME` (and honored `XDG_STATE_HOME`) verbatim, including RELATIVE values. A relative value made `honeycombStateDir()`, `fleetRootFile()`, `resolveRegistryWritePath()`, the machine-key path, and the telemetry SQLite path resolve against `process.cwd()`, so a service-launched daemon (cwd `System32` or `/`) would scatter state, including the secrets machine key, into the service manager's working directory, directly contradicting the module's own "structurally impossible" guarantee. The XDG Base Directory spec also requires relative `XDG_*` values to be ignored. **Fix:** env roots are now honored only when absolute (`win32.isAbsolute`, a strict superset of the posix check, rejects `apiary`, `./x`, and drive-relative `C:x` on every host); a relative value falls through the chain. The installer's `--home=` capture (`src/commands/install.ts` `applyHomeOverride`) now resolves a relative flag value against the installer's cwd at capture time so user intent survives the stricter resolver. Regression tests added in `tests/shared/fleet-root.test.ts` and `tests/commands/install-home.test.ts`.
- [x] **GATE BYPASS VIA WINDOWS PATH SHAPES (pre-tool-use gate)** `src/hooks/shared/pre-tool-use.ts:167-184` - `mentionsMount` matched only forward-slash, case-sensitive shapes (`.apiary/honeycomb/memory`, `.honeycomb/memory`). A backslash-separated path (`C:\Users\ada\.apiary\honeycomb\memory\notes.md`, the shape a Windows harness actually hands over) or a case-varied path (`.APIARY\HONEYCOMB\MEMORY`, which names the same real directory on Windows) escaped the gate entirely: the read was NOT intercepted (fell through to the real filesystem) and the Write/Edit deny never fired, so an injected prompt could materialize real files under a mount-looking path that gate-mediated reads then shadow. The same hole existed for the legacy shape before this branch, but the branch ships explicit Windows service support (schtasks pinning), putting the Windows shape squarely on the supported surface. **Fix:** `mentionsMount` now normalizes `\` to `/` before matching and compares the two honeycomb-owned host-absolute shapes case-insensitively. The fix is confined to the gate predicate; `classifyPath` / `toMountRelative` semantics are untouched (a backslash path now intercepts and resolves through the VFS seam, never the real FS). Regression tests added in `tests/hooks/shared/memory-mount-migration.test.ts`. Prefix-confusion probes were verified non-bypassing: `.apiary/honeycombX/memory/f` and traversal shapes (`.../memory/../../etc/passwd`) are still captured by the `/memory/` check and resolve only to Deeplake row keys through `sLiteral`, never to the real filesystem.

---

## Low Findings (documentation only)

- [ ] **SYSTEMD UNIT VALUE ESCAPING** `src/cli/daemon-service.ts:302-316` - `renderSystemdUnit` embeds `spec.workspace` (pre-existing) and the new `spec.fleetRoot` into the unit body with quoting but no rejection of embedded quotes, newlines, or `%` specifiers. A hostile value could inject unit directives. The value derives from the same user's own environment and the unit runs as that user (systemd-user), so this is not a privilege boundary; the schtasks path (where cmd.exe re-parses the stored string on every logon) does apply the `assertCmdSafe` metacharacter guard to `fleetRoot`. Recommended hardening: extend a control-character guard to the systemd and launchd renderers for symmetry.
- [ ] **LEGACY DIR RESURRECTION VIA DUAL-STAMP** `src/daemon/runtime/assemble.ts:788-796` - the single-instance lock dual-stamps `~/.honeycomb/daemon.pid` and `mkdirSync`s the legacy dir on every real boot during the window, so a fully migrated machine keeps an otherwise-empty `~/.honeycomb/` alive. Mode is `DIR_MODE` (0700) and the content is only a pid; hygiene item for the window close-out, not a vulnerability.

---

## Audit-Focus Verification (requested surface, item by item)

1. **Pre-tool-use dual recognition:** bypass found on Windows separator/case shapes; FIXED (Medium above). Both the hook path (`mentionsMount` gates `runPreToolUse`) and the classify path were checked: `classifyPath` is only reached after the gate matches, reduces by the LAST `/memory/` marker, and its goal/kpi shape validation falls back to `memory` (never drops or escapes). Traversal remainders become Deeplake keys through `sLiteral`; the graph tier uses the injected snapshot loader, not the path, for FS access. The generated index now advertises `~/.apiary/honeycomb/memory/` only (display string, no injection surface).
2. **State migration (machine key):** clean. Copy to a temp sibling on the destination volume, explicit `chmod 0600` on the temp BEFORE the atomic `renameSync`, byte-verification against the legacy file with abort-and-keep-legacy on mismatch, destination-exists and legacy-missing short-circuits, legacy file never deleted unless the new file landed, engine fail-soft with retryable `failed` marker entries. `cpSync` for the skillify dir does not dereference symlinks by default. Created state dirs use mode 0700. No mode weakening at either path; the legacy key is left byte-identical if anything fails.
3. **Registry window writes:** clean. Entries are built from constants plus resolver outputs and serialized with `JSON.stringify` (no structural injection from `APIARY_HOME`-derived strings); the write is the pre-existing atomic temp + rename; write target is new-root-if-exists else legacy, never both. schtasks: `assertCmdSafe` (blocks `& | < > ^ " % \r \n`) is applied to `fleetRoot` exactly as to workspace/nodePath/entry, and a throw falls back to the safe fixed-argv spawn; verified by the branch's own poisoned-root test. launchd: `xmlEscape` covers the pinned value.
4. **fleet-root resolution:** relative-value hole found and FIXED (Medium above). No shell interpolation anywhere in the resolver (pure string/`join`); anchored on `os.homedir()`, never `process.cwd()`; the seams are injectable and the test harness clears `APIARY_HOME`/`XDG_STATE_HOME` for hermetic runs. Full containment of an absolute `APIARY_HOME` is intentionally NOT enforced (it is the documented operator override); the file mode (0600) on the machine key protects content even if the root is placed in a shared location.
5. **SQL safety:** green. `npm run audit:sql` passed (292 files scanned, every interpolation through an escaping helper). The one new SQL builder touched by the branch (`buildRecentMemoriesSql` in `src/daemon-client/vfs/index-gen.ts`) routes identifiers through `sqlIdent`; the VFS read path routes values through `sLiteral`.

---

## Dependency Audit

```text
npm audit --audit-level=high: found 0 vulnerabilities
```

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| SQL guards (`src/daemon/storage/sql.ts`) | every interpolation wrapped | `npm run audit:sql` clean, 292 files | OK |
| Pre-tool-use gate | mount shapes cannot reach the real FS | fixed separator/case bypass; VFS-confined | OK (after fix) |
| Credential / key file modes | 0600 file / 0700 dir, explicit | machine-key mover chmods temp 0600 pre-rename; dirs 0700 | OK |
| Token in logs | none | no tokens or secrets in any changed line | OK |
| schtasks /TR metacharacter guard | `assertCmdSafe` on every embedded value | applied to `fleetRoot` too | OK |
| plist XML escaping | `xmlEscape` on embedded values | applied to `fleetRoot` | OK |
| Registry write atomicity | temp + rename | unchanged, verified | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/shared/fleet-root.ts` | Honor only ABSOLUTE `APIARY_HOME` / `XDG_STATE_HOME` (dialect-agnostic `win32.isAbsolute`); relative values fall through the chain |
| `src/commands/install.ts` | `applyHomeOverride` resolves a relative `--home=` against the installer cwd at capture time |
| `src/hooks/shared/pre-tool-use.ts` | `mentionsMount` normalizes backslashes and matches the two host-absolute mount shapes case-insensitively |
| `tests/shared/fleet-root.test.ts` | Regression tests: relative `APIARY_HOME` (posix, dot-relative, drive-relative) and relative `XDG_STATE_HOME` are ignored |
| `tests/commands/install-home.test.ts` | Regression test: relative `--home` is pinned as an absolute path |
| `tests/hooks/shared/memory-mount-migration.test.ts` | Regression tests: backslash shapes intercept (both mount shapes); case-varied Write hits the deny |

Diff reviewed with `git diff` on 2026-07-04 and confirmed security-scoped.

---

## Recommended Follow-Up (architectural)

- Extend a control-character rejection guard to the systemd and launchd unit renderers (Low finding above) so all three service writers share the schtasks posture.
- When the ADR-0003 compatibility window closes, remove the legacy dual-stamp and the `~/.honeycomb` fallbacks in one sweep so the legacy dir stops being re-created.
- The gate's `/memory/` substring check over-captures any path containing a `memory` directory (pre-existing, now consistent across separators); if that ever bites, tighten to the two host-absolute shapes plus mount-relative prefixes.

---

## Gate Evidence

`npm run ci` (typecheck + jscpd + vitest + SQL-safety audit) after remediation:

```text
Test Files  380 passed (380)
Tests       4096 passed | 12 skipped (4108)
SQL-safety audit: scanned 292 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.
```

No Critical or High findings remain.
