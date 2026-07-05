# Security Audit Report: feature/fleet-lifecycle (uncommitted working tree, PRD-003)

**Audit date:** 2026-07-04
**Auditor:** security-worker-bee subagent (armed security-stinger)
**Scope:** Uncommitted PRD-003 fleet-lifecycle changes in the honeycomb repo: `src/shared/fleet-detection.ts` (new), `src/commands/install.ts` (install-path solo/fleet auto-login), `src/commands/local-handlers.ts` + `src/commands/contracts.ts` + `src/commands/dispatch.ts` + `src/commands/index.ts` (bare `start`/`stop` verbs, three-part `uninstall`), `src/cli/runtime.ts` (`buildUninstallLifecycleSteps` incl. state-dir removal), `src/cli/daemon-service.ts` (`unregisterLegacy` seam), `src/daemon/runtime/telemetry/fleet-registry.ts` (`unregisterHoneycombFromDoctor` delete writer), plus the seven new/modified test files.
**Node version audited:** >= 22.5.0 (package.json engines)
**`npm audit` result:** clean (0 vulnerabilities at `--audit-level=high --omit=dev`)
**OpenClaw bundle scan:** `npm run audit:openclaw` clean ("Bundle is clean against ClawHub's static-analysis rules"); `fleet-detection.ts` is imported only by `src/commands/install.ts` (CLI target), never by a harness/MCP bundle, and its lazy `createRequire` child_process load mirrors the established `daemon-service.ts` ClawHub-clean posture.
**Ordering pre-flight:** no QA report for this branch exists (`library/qa/` grep for fleet-lifecycle/prd-003 matches only the unrelated 2026-06-12 cursor-extension report), so the run-before-quality rule holds.
**Scope note:** the Stinger's catalogs are tuned for the Hivemind repo; honeycomb shares the identical stack and threat model (TypeScript/Node 22 ESM loopback daemon, Deeplake credentials at `~/.deeplake/credentials.json`, device-flow auth, hand-escaped Deeplake SQL, OS service management), so catalog fidelity is effectively full for this branch. The one surface the catalogs do not model verbatim (OS service-unit lifecycle) was audited against the universal patterns (fixed-argv discipline, no derived strings into argv, destructive-path containment).

---

## Executive Summary

The PRD-003 fleet-lifecycle branch is clean at the Critical/High bar: no credential exposure, no injection path, no destructive-path escape, and no weakening of the device-flow guarantees. Zero remediations were required, so the working tree is byte-identical to what the implementation workers left; `npm run ci` (typecheck + jscpd + vitest 4227 passed / 12 skipped + SQL-safety audit) is green. Three Low findings and two Info notes are documented below for the QA pass: the Windows `npm.cmd` probe in fleet detection is dead code on Node >= 22 (EINVAL, silently degrades toward SOLO, the popup-opening direction), the registry delete writer lacks the register side's optimistic verify loop (bounded last-writer-wins race, ecosystem-convergent), and a non-ENOENT read error on the first registry candidate skips the legacy candidate (best-effort contract still honored).

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 (surface untouched by this branch) |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deeplake SQL API) | OK | 0 (no SQL touched; `npm run audit:sql` clean, 296 files) |
| Command Execution (child processes) | ATTN | 1 Low (documented) |
| Destructive FS Paths (uninstall) | OK | 0 (2 Info notes) |
| Registry Write Atomicity / TOCTOU | ATTN | 2 Low (documented) |
| Dependency & OpenClaw Bundle | OK | 0 |
| Hidden-Unicode / Rules Backdoor | OK | 0 (bidi/invisible scan of all changed files: 0 hits) |
| Pre-Tool-Use Gate & Prompt Injection | OK | 0 (gate untouched by this branch) |

Legend: **OK** = zero findings. **ATTN** = Medium/Low findings documented. **FAIL** = Critical/High findings (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings

None detected.

---

## Low Findings (documentation only)

- [ ] **WINDOWS `npm.cmd` PROBE IS DEAD CODE, FAILS TOWARD SOLO** `src/shared/fleet-detection.ts:162-166` - `defaultNpmGlobalHasHive` runs `execFile("npm.cmd", [...])` without `shell` on win32. Since Node's CVE-2024-27980 hardening (all Node >= 22), spawning a `.cmd`/`.bat` file without `shell: true` throws `EINVAL` synchronously; empirically verified on this host (`SYNC THROW: EINVAL spawn EINVAL`). The surrounding try/catch resolves `false`, so the S3 signal is silently always absent on Windows. The failure direction is toward SOLO, which is the popup-opening direction (orchestrator decision 1: popping wrongly is the bug), but S1 (registry entry, which a hive install writes) and S2 (live 3853 probe) still classify, so the practical window is a Windows machine where hive is npm-installed but has never registered and its daemon is down. This mirrors the deviation already accepted for nectar in the execution ledger (run log 2026-07-04 22:56). Not remediated here: the argv is 100% constant literals so there is no injection exposure either way, and the only quick fix (`shell: true`) would introduce a shell into a module whose documented contract is "NEVER a shell". Recommended fix for the implementation pass: resolve the npm prefix via `process.execPath` + `npm-cli.js`, or accept the two-signal posture on Windows and update the module doc comment to say so.
- [ ] **REGISTRY DELETE LACKS THE REGISTER-SIDE VERIFY LOOP** `src/daemon/runtime/telemetry/fleet-registry.ts:362-397` - `registerHoneycombWithDoctor` documents and implements a 5-round optimistic read-merge-write-verify loop precisely because two concurrent temp+rename writers can silently drop each other's entries (last-writer-wins). `unregisterHoneycombFromDoctor` performs a single read-filter-write round per candidate file with no post-rename verification, so a concurrent writer (for example `nectar install` upserting its entry) whose rename lands between the delete's read and its rename loses that update transiently. Convergence relies on the other products' writers running their own verify loops (the hive reference writer this module mirrors does), which re-add the dropped entry; a concurrent honeycomb re-install racing the uninstall can likewise resurrect the honeycomb entry, which is semantically ambiguous but harmless. Same-user, loopback-coordination file, no privilege boundary, convergent ecosystem: Low. Recommended hardening: mirror the register loop's shape (re-read after rename; if a foreign entry set changed underneath, re-filter against the fresh document and rewrite, bounded attempts).
- [ ] **FIRST-CANDIDATE READ ERROR SKIPS THE LEGACY CANDIDATE** `src/daemon/runtime/telemetry/fleet-registry.ts:377-378` with `readRegistryDocument` at `:235-243` - `readRegistryDocument` rethrows any non-ENOENT read error (for example EACCES on `~/.apiary/registry.json`). Inside `unregisterHoneycombFromDoctor`'s candidate loop that throw propagates immediately, so the legacy `~/.honeycomb/doctor.daemons.json` candidate is never examined. The caller (`deleteRegistryEntry` in `src/cli/runtime.ts:601-607`) catches it and reports `{ removed: false }`, so the uninstall still completes best-effort and nothing is clobbered; the residual effect is a stale legacy entry surviving an uninstall on a machine with a permission-broken fleet-root file. A per-candidate try/catch-continue would close it.

---

## Info Notes

- **TOCTOU window between `lstatSync` and `rmSync` in `removeStateDir` is benign** (`src/cli/runtime.ts:608-626`). If the state dir is swapped for a symlink between the lstat and the recursive `rmSync`, Node's `fs.rm` still unlinks the symlink itself rather than traversing into its target, so no content outside the fleet root can be deleted through the race; the threat model is also same-user-only. The explicit lstat branch remains valuable as the documented intent (symlinked dir: remove only the link).
- **S2 treats ANY HTTP responder on 127.0.0.1:3853 as Hive** (`src/shared/fleet-detection.ts:134-146`). A same-user process squatting the port suppresses the solo login popup (classification flips to FLEET). This fails toward deferral, the cheap direction by explicit orchestrator decision 1, and the probe is loopback-only with a 750ms `AbortController` budget, an unref'd timer, and `clearTimeout` in a finally block. No action needed.

---

## Audit-Focus Verification (requested surface, item by item)

1. **Command execution.** Every child-process call in the diff is fixed-argv and shell-free. The npm probe (`fleet-detection.ts:163-174`) passes only the five constant literals `["ls", "-g", "@legioncodeinc/hive", "--depth", "0"]` with `timeout: 5000` and `windowsHide` (dead on Windows per the Low finding, but injection-free in all cases). All service-manager calls route through the injected `ServiceRunner` whose production default is `execFileSync(cmd, [...args])` (`daemon-service.ts:146-154`, 15s timeout, never a shell string); the new `unregisterLegacy` paths pass only the compile-time constants `LEGACY_SERVICE_LABEL`, `LEGACY_SERVICE_SYSTEMD_UNIT`, and `LEGACY_SERVICE_TASK_NAME`. No user-derived or registry-derived string reaches any argv. The bare `start`/`stop` verbs re-enter `runDaemonCommand` with the caller's flag tail parsed by `parseDaemonArgs`, never a shell.
2. **Destructive fs paths.** `removeStateDir` deletes only `honeycombStateDir()` = `join(resolveFleetRoot(), PRODUCT_SLUG)`: a resolved absolute path (the resolver honors only absolute `APIARY_HOME`/`XDG_STATE_HOME` per the 2026-07-04 PRD-072 audit fix and anchors on `os.homedir()`, never cwd) with a constant product segment, so it can never name the fleet root wholesale, another product's dir, or `~/.deeplake`. Symlink-safe: an lstat'd symlink has only the link removed, and `rmSync` recursive never follows symlinks inside the tree. No glob anywhere. The registry delete never clobbers a malformed file destructively: a file that fails to parse as `{ daemons: [...] }` degrades to an empty daemon list, `findIndex` misses, and the loop `continue`s without writing; a rewrite happens only when a honeycomb entry was actually found, is atomic (same-directory temp + `renameSync`), preserves every other entry and every unknown top-level key verbatim, and removes the temp file if the rename throws. Verified by `tests/daemon/runtime/telemetry/fleet-registry-delete.test.ts` and `tests/cli/uninstall-lifecycle-steps.test.ts` (including the symlink-out-of-root case against a temp `APIARY_HOME`).
3. **Credential surfaces.** No token, org id, or credential content appears in any changed log/output line (diff-wide sweep for token/bearer/password/secret/credential matched only type imports, verb summaries, and flag names). The install auto-login reuses the exact `loginWithDeviceFlow` that `honeycomb login` runs, with the https-only `defaultBrowserOpener` (`deeplake-issuer.ts:436-462` refuses any non-https URL; `validateVerificationUrl` gates the server-derived URL before the opener is even consulted). The reporter prints only the verification URL, user code, and the resolved org/workspace names+ids; the failure branch prints `AuthHttpError` messages, which are redacted by construction (status + 200-char truncated body, never the token). Credentials are persisted by the existing 0600 store; the install path adds no new write. The dashboard opener admitting `http:` is a separate function (`openLocalDashboardUrl`) allowlisted to loopback/`localhost`/`honeycomb.local` hosts only and is not reachable from the auth flow.
4. **Fleet detection.** The 3853 probe targets the constant `HIVE_HOST` = `127.0.0.1` only, with a 750ms bounded `AbortController` timeout, an unref'd timer, and cleanup in finally. Registry reads are malformed-tolerant at every layer (existsSync guard, readFileSync + JSON.parse inside try/catch, shape checks on `daemons[]` and entry objects), so a corrupt registry can never crash the install; `classifyFleet`'s caller additionally wraps the whole classification in try/catch and defers to FLEET (no popup) on any error, the safe direction.
5. **Registry TOCTOU/race.** Each individual write is atomic (temp + rename, unique temp name per pid+timestamp, same directory). The register path carries the documented 5-round verify loop; the delete path's missing loop is the Low finding above (bounded, convergent, same-user). No lock file is introduced, matching the module's dependency-free posture.

---

## Dependency Audit

```text
npm audit --audit-level=high --omit=dev: found 0 vulnerabilities
npm run audit:openclaw: OK - no findings. Bundle is clean against ClawHub's static-analysis rules.
```

Hidden-Unicode sweep (bidi controls, zero-width, BOM, soft hyphen) over all nine changed source files: 0 hits.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| SQL guards (`src/daemon/storage/sql.ts`) | every interpolation wrapped | `npm run audit:sql` clean, 296 files (branch touches no SQL) | OK |
| Child-process argv | fixed argv, never a shell, no derived strings | npm probe + all ServiceRunner calls constant-argv | OK |
| Uninstall state-dir containment | resolved-absolute, product-scoped, symlink-safe | `join(resolveFleetRoot(), PRODUCT_SLUG)`, lstat symlink branch, no glob | OK |
| Registry delete on malformed file | tolerate, never clobber | parse-degrade to empty list, no write when entry absent | OK |
| Registry write atomicity | temp + rename, temp cleanup on failure | verified both register and delete paths | OK |
| Device-flow guarantees (https-only opener, no token in output) | unchanged | auto-login reuses `loginWithDeviceFlow` + `defaultBrowserOpener`; redacted errors | OK |
| Token in logs | none | diff-wide sweep clean | OK |
| Fleet probe | loopback-only, bounded timeout | `127.0.0.1:3853`, 750ms abort, unref'd timer | OK |
| Test hygiene | no real home/registry touched | all new suites run under `mkdtempSync` temp roots with `APIARY_HOME` save/restore | OK |

---

## Files Changed (remediation)

None. Zero Critical/High findings meant zero remediation edits; the working tree is exactly as the implementation workers left it. `git status` re-checked after the audit: only the pre-existing PRD-003 changes and this report are present.

---

## Recommended Follow-Up

- Fix or explicitly document the Windows S3 posture in `fleet-detection.ts` (Low finding 1); prefer a shell-free resolution (`process.execPath` + npm-cli.js) over `shell: true`.
- Add the register-side verify loop (or a per-candidate try/catch-continue plus verify) to `unregisterHoneycombFromDoctor` (Low findings 2 and 3) when the registry writer next changes.
- When the ADR-0003 compatibility window closes, retire the legacy registry candidate from both the detection read and the delete writer in one sweep.

---

## Gate Evidence

`npm run ci` (typecheck + jscpd + vitest + SQL-safety audit) on the audited tree, 2026-07-05 00:01 ET:

```text
Test Files  400 passed (400)
     Tests  4227 passed | 12 skipped (4239)
  Duration  23.44s

SQL-safety audit: scanned 296 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.

exit_code: 0
```
