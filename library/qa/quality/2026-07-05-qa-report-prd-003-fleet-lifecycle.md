# QA Report: PRD-003 Fleet Lifecycle, Login Deferral, and One-Command Uninstall (honeycomb scope)

**Plan document:** `library/requirements/backlog/prd-003-fleet-lifecycle-login-and-uninstall/` (superproject; index + `prd-003a-...solo-vs-fleet-login-deferral.md` + `prd-003b-...lifecycle-command-parity.md`)
**AC ledger:** `library/ledger/EXECUTION_LEDGER-fleet-lifecycle.md` (superproject)
**Audit date:** 2026-07-05
**Base branch:** `main`
**Head:** `feature/fleet-lifecycle` (uncommitted working tree, honeycomb repo)
**Auditor:** quality-worker-bee (armed quality-stinger)
**Ordering pre-flight:** `security-worker-bee` ran first and verdicted CLEAN at Critical/High/Medium (report: `library/qa/security/2026-07-04-security-audit-prd-003-fleet-lifecycle.md`). Ordering is correct; this audit consumed that report's three Lows and two Infos as carried input.

## Summary

PASS WITH WARNINGS. All 15 honeycomb-scope acceptance criteria (a-AC-1/2/3/4/6/7, b-AC-1..6, module AC-8/9) trace to implementation and AC-named tests; one Medium finding was found and remediated in place during this audit (the dead Windows npm probe in fleet detection, now adopting nectar's audited `shell: true` win32 fix so the mirrored contract behaves identically in both products), and `npm run ci` is green after remediation (400 files, 4231 passed, 12 skipped, jscpd clean, SQL-safety audit clean, exit 0). Two Warnings and two Suggestions are documented below; none invalidates an acceptance criterion. Recommend ship.

Rulings on the three carried items:

1. **a-AC-2 integration-style test (W2 carry-over): ruled a documented Suggestion, not required.** The recovery chain is proven at every link by existing tests (details in S-1); the missing piece is only the end-to-end composition of already-tested parts, and the plan specified no integration test. Per the severity tree, a test gap the plan did not specify on plan-satisfied behavior is a Suggestion.
2. **Cross-repo S3 divergence (ledger 2026-07-05 00:20 carry-over): ruled ADOPT, Medium, remediated in place.** Rationale and diff in W-1 below. `npm run ci` re-run green after the fix.
3. **Regression sweep: PASS.** `daemon start|stop|status`, `login`, `install`, and connector `uninstall <harness>` behavior is unchanged for existing users except the documented additions. Evidence in the Regression Sweep section.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All 15 honeycomb-scope AC rows trace to code + AC-named tests; both PRD non-goal sets honored |
| Correctness   | ⚠️ | One Medium (dead win32 S3 probe, mirrored-contract divergence) found and REMEDIATED in place; one narrow honesty edge in uninstall service reporting documented (W-2) |
| Alignment     | ✅ | Verb spellings, step ordering, and the three-signal contract match the PRD; the nectar mirror is behavior-identical again post-remediation |
| Gaps          | ⚠️ | a-AC-2's end-to-end file-appears composition is untested as a single test (each link is proven); documented as S-1 |
| Detrimental   | ✅ | No anti-patterns; fail-soft postures consistent; no tier-boundary or DeepLake-confinement violations introduced; security's 3 Lows/2 Infos re-checked, one of them closed by W-1's fix |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [x] **W-1 (Medium, REMEDIATED IN THIS AUDIT): win32 S3 npm probe was dead code, diverging from nectar's half of the mirrored contract**, `src/shared/fleet-detection.ts:181-196` (fixed), previously `:162-166`

  Ruling on carried item 2: **adopt nectar's fix**. Before the fix, `defaultNpmGlobalHasHive` ran `execFile("npm.cmd", ...)` without `shell` on win32; Node's CVE-2024-27980 hardening (all Node >= 22) makes that throw EINVAL synchronously, the catch resolved `false`, and the S3 signal was silently always absent on Windows. Honeycomb and nectar implement one mirrored fleet-detection contract (both module headers say so), and nectar's security wave already fixed its identical probe with win32-only `shell: true` over compile-time-constant argv (`nectar/src/fleet-detection.ts:157-178`). The divergence was Medium, not Low, because on the identical Windows machine state (hive npm-installed, never registered, daemon down) nectar classified FLEET and deferred while honeycomb classified SOLO and auto-opened the login popup, which is precisely the bug PRD-003a exists to kill (orchestrator decision 1: popping wrongly is the bug), and it silently reduced honeycomb's documented three-signal contract to two signals on one OS, weakening a-AC-3 fidelity and a-AC-6's supportability claim.

  Remediation applied, matching nectar's audited pattern: win32-only `shell: true` with all-constant argv, an injectable `execFileImpl` seam so the exact cmd/argv/options are test-assertable without spawning, and updated module + function doc comments naming the CVE rationale and the nectar mirror. Four new tests in `tests/shared/fleet-detection.test.ts:140-190` prove win32 uses `npm.cmd` with `shell: true` and the constant argv, POSIX stays shell-free, an exec error resolves `false`, and a hive-less exit-0 resolves `false`. This also closes the security audit's Low finding 1 for this surface. `npm run ci` green after the change.

  ```ts
  exec(
  	win32 ? "npm.cmd" : "npm",
  	["ls", "-g", HIVE_NPM_PACKAGE, "--depth", "0"],
  	{ timeout: 5000, windowsHide: true, shell: win32 },
  ```

- [ ] **W-2 (Low-to-Medium, documented, ruled not AC-invalidating): `unregisterService` reports `removed: true` from prior registration, not from removal outcome**, `src/cli/runtime.ts:583-599` with `defaultServiceRunner.removeFile` at `src/cli/daemon-service.ts:159-165`

  The step captures `wasRegistered` before calling `controller.unregister(spec)`, swallows any throw, and returns `removed: wasRegistered`. Separately, the production runner's `removeFile` swallows every `rmSync` error by contract. Net effect: on a machine where the unit file (or a locked schtasks task) cannot actually be removed, `honeycomb uninstall` prints "removed the OS service unit" and exits 0 while a boot-resurrecting unit survives, the same observable outcome nectar's W2-Nfix and hive's W3-Vfix corrected on their surfaces with an alreadyAbsent/genuine-failure classifier. Ruled below the remediation bar for this audit because: the window requires a permission-broken file in the user's own home (nominal paths, including the already-absent case, behave correctly and are tested); honeycomb's seam never produces an explicit `ok: false` that gets discarded (nectar's actual bug class); the W2 honeycomb verifier VERIFIED b-AC-2 as written and security's destructive-path review issued no finding here; and the fix requires reworking the `ServiceRunner`/`ServiceOpResult` contracts shared with the install/register paths, an implementation-wave change, not a QA patch. Recommended follow-up: port the four-product failure-classifier contract (launchd exit 3, sc 1060, not-found text) to honeycomb's controller when the service seam next changes.

  ```ts
  try {
  	controller.unregister(spec);
  } catch {
  	// Best-effort: a manager stop/remove failure never aborts the uninstall.
  }
  ...
  return wasRegistered ? { removed: true, manager } : { removed: false, manager };
  ```

## Suggestions (consider improving)

- [ ] **S-1: add one integration-style a-AC-2 test where a credentials file appears under a temp `~/.deeplake` after boot** (ruling on carried item 1: Suggestion, not required), `tests/daemon/runtime/fleet-health-recovery.test.ts:89-120`

  The W2 verifier noted a-AC-2's strongest proof uses a mutable fake storage client. Ruled a Suggestion because every link of the production recovery chain is independently proven: (1) the assembled daemon's 15s cached-health probe flips /health 503 to 200 on the SAME running daemon when storage recovers (`fleet-health-recovery.test.ts:89-120`, real `assembleDaemon`, fake storage); (2) the production lazy storage client re-attempts its build on every query with a fresh provider read, never caching failure (`src/daemon/storage/index.ts:277-338`, proven by `tests/daemon/storage/lazy-client.test.ts:58-96`); (3) the default file provider re-reads `loadDiskCredentials` on each `read()` against the real shared file (`src/daemon/storage/config.ts:155-184`, proven by `tests/daemon/storage/config.test.ts:139-197`); and (4) the assembly wires exactly these parts (`src/daemon/runtime/assemble.ts:2152-2157`). The only untested thing is the composition of tested parts, and the plan specified no integration test, which the severity tree classifies as a Suggestion. A future test would boot `assembleDaemon` with the default lazy client pointed at a temp credentials dir, write the file mid-run, and poll /health to 200.

- [ ] **S-2: `stopDaemon`'s `stopped: true` is not folded into the b-AC-6 nothing-to-remove decision**, `src/commands/local-handlers.ts:169-176` and `:154-156`

  If the daemon was running (ad hoc spawn) but no unit, registry entry, state dir, or harness existed, the output prints "uninstall: stopped the daemon." followed by "uninstall: nothing to remove — Honeycomb was not installed here.", which is self-contradictory. Cosmetic, unusual machine state, exit code and per-step reports remain correct. Suggested: treat a `stopped: true` result as removal evidence, or reword the summary line.

## Plan Item Traceability

Scope per the audit dispatch: honeycomb-side a-AC-1/2/3/4/6/7, b-AC-1..6, module AC-8/9. (a-AC-5 is nectar-owned; b-AC-7 is doctor-verified; c-AC/d-AC are doctor/superproject surfaces. All out of honeycomb scope.)

| # | Plan Requirement (abridged) | Status | Implementation Location | Notes |
|---|---|---|---|---|
| a-AC-1 | Fleet install: no popup, no prompt; daemon serves 503 degraded on /health | ✅ | `src/commands/install.ts:416-445` (defer branch), `tests/commands/install-login.test.ts:100-129`, `tests/daemon/runtime/fleet-health-recovery.test.ts:103-105` | Fleet path returns before any credential read or login init |
| a-AC-2 | Credentials appearing flips /health healthy, no restart | ✅ | 15s cached-health probe verified same-daemon 503 to 200: `tests/daemon/runtime/fleet-health-recovery.test.ts:89-120`; lazy re-read chain: `src/daemon/storage/index.ts:277-338`, `src/daemon/storage/config.ts:155-184` | See S-1 (composition test ruled Suggestion) |
| a-AC-3 | Solo + no creds: auto popup; creds present: no popup | ✅ | `src/commands/install.ts:433-449`, `tests/commands/install-login.test.ts:131-176` | Only fires from the install path, never daemon boot (PRD impl note honored) |
| a-AC-4 | `honeycomb login` runs the device-flow popup directly, both modes | ✅ | `src/cli/auth.ts` (untouched), `tests/commands/install-login.test.ts:298-351` | login ignores fleet detection by design |
| a-AC-6 | Deterministic classification; fired signals visible | ✅ | `src/shared/fleet-detection.ts:200-212` (`classifyFleet` + `fleetSignalLine`), printed in install output (`install.ts:427`), `tests/shared/fleet-detection.test.ts:41-86` | Determinism + evidence-line tests; win32 S3 now live per W-1 |
| a-AC-7 | Headless: print URL + code, poll to completion, never hang | ✅ | `src/commands/install.ts:392-399` (`defaultInstallDeviceLogin`), proven against the REAL `loginWithDeviceFlow` with a headless opener: `tests/commands/install-login.test.ts:178-250` | Opener returns false, flow prints + polls |
| b-AC-1 | Bare `start`/`stop` on macOS/Linux/Windows | ✅ | `src/commands/dispatch.ts:250-253`, `src/commands/contracts.ts:124-125` (verb table), `tests/commands/lifecycle-verbs.test.ts:60-94` | Fronts the SAME DaemonLifecycle as `daemon start|stop` |
| b-AC-2 | Uninstall removes the OS service unit, current + best-effort legacy label | ✅ | `src/cli/runtime.ts:573-600`, `src/cli/daemon-service.ts` `unregisterLegacy` per manager (launchd `:466-468`, systemd `:532-534`, schtasks `:593-595`), `tests/cli/uninstall-lifecycle-steps.test.ts:179-201` | W-2 documents the narrow failure-reporting edge; nominal + already-absent paths correct |
| b-AC-3 | Uninstall deletes honeycomb's registry entry, others intact | ✅ | `src/daemon/runtime/telemetry/fleet-registry.ts:364-399` (`unregisterHoneycombFromDoctor`, atomic temp+rename, both fleet-root and legacy files), `tests/daemon/runtime/telemetry/fleet-registry-delete.test.ts:55-105` | Preserves unknown top-level keys; register round-trip test included |
| b-AC-4 | Uninstall removes ONLY honeycomb's state dir; no registry wholesale, no `~/.deeplake` | ✅ | `src/cli/runtime.ts:604-622` (`removeStateDir`, resolved absolute path, symlink-safe), `tests/cli/uninstall-lifecycle-steps.test.ts:73-127` | Sibling-dir + registry-survives + symlink-not-followed tests |
| b-AC-5 | Existing spellings keep working as aliases | ✅ | `daemon` verb kept in `src/commands/contracts.ts:126` and dispatch unchanged; `tests/commands/lifecycle-verbs.test.ts:96-115` | `daemon start|stop|status` proven same-lifecycle |
| b-AC-6 | Uninstall on a not-installed product: exit 0, nothing-to-remove message | ✅ | `src/commands/local-handlers.ts:151-156`, `tests/commands/lifecycle-verbs.test.ts:202-221`; per-step no-op reports in `runUninstallLifecycleSteps` | See S-2 for the stopped-daemon cosmetic edge |
| AC-8 | No deletion outside the enumerated allow-list; clean machine is a no-op | ✅ | `removeStateDir` = `join(resolveFleetRoot(), PRODUCT_SLUG)` only, never a glob; symlink test `tests/cli/uninstall-lifecycle-steps.test.ts:101-126`; registry delete never clobbers malformed files | Security audit item 2 independently verified containment |
| AC-9 | Every flow terminates: clear success or plain-language actionable error | ✅ | Install login fail-soft (`install.ts:411-414, 450-457`), per-step best-effort uninstall (`local-handlers.ts:160-210`), headless no-hang (a-AC-7 test), `tests/commands/lifecycle-verbs.test.ts:223-240`, `tests/commands/install-login.test.ts:252-296` | No raw stacks; exit codes stable |
| NG-a1 | Non-goal: no device-flow / credential-format / issuer change | ✅ | Install auto-login reuses the existing `loginWithDeviceFlow` + `defaultBrowserOpener` (`install.ts:392-399`); `deeplake-issuer.ts`, `credentials-store.ts` untouched | |
| NG-a2 | Non-goal: hive onboarding / login-step proxy untouched | ✅ | No hive-facing file in the diff | |
| NG-a3 | Non-goal: team/hybrid modes and tenancy untouched | ✅ | No tenancy file in the diff | |
| NG-b1 | Non-goal: uninstall does NOT remove the npm package | ✅ | No npm-uninstall call anywhere in the diff; comment records the split (`local-handlers.ts:120-123`) | Package removal is 003c/003d territory |
| NG-b2 | Non-goal: service REGISTRATION machinery unchanged | ✅ | `register` paths only refactored to share `cleanupLegacy` (byte-equivalent argv, proven by existing suites) | |
| NG-b3 | Non-goal: registry schema unchanged (delete writer only) | ✅ | `fleet-registry.ts` adds only the delete counterpart; upsert path untouched | |

## Regression Sweep (carried item 3)

Ruling: PASS. Verb-by-verb evidence, all on the post-remediation tree with `npm run ci` green:

- **`daemon start|stop|status`:** the `daemon` dispatch case is unchanged (`src/commands/dispatch.ts:254-255`); bare `start`/`stop` are additive cases that re-enter the same `runDaemonCommand`. `tests/commands/lifecycle-verbs.test.ts:96-115` proves the old spellings route through the same lifecycle; all pre-existing daemon suites pass.
- **`login`:** `src/cli/auth.ts` is not in the diff. `tests/commands/install-login.test.ts:298-351` proves `honeycomb login` still selects the device flow (not the token path) and ignores fleet detection.
- **`install`:** one additive step (2c, `src/commands/install.ts:502-505`) between the registry write and the dashboard probe; fail-soft by construction (it can never change the install exit code, `install.ts:411-414`). All pre-existing install suites (PRD-050a, PRD-064h, PRD-071, telemetry e-AC) pass with the seam injected; for real users the new login decision is the PRD-documented addition. Note: production installs now spend up to ~750ms on the hive-port probe plus a bounded npm read (concurrent), a documented cost of the feature.
- **Connector `uninstall <harness>`:** proven unchanged; the fleet steps never fire for a single-harness reversal (`tests/commands/lifecycle-verbs.test.ts:187-199`). The FULL uninstall keeps the hook reversal and the `product_removed` telemetry (telemetry-wiring suite green); when the `uninstallSteps` seam is unbound, behavior is exactly the old hooks-only path (`local-handlers.ts:88-92`).
- **Architecture boundaries:** no shared-contention file (`server.ts`, runtime `index.ts`, `config.ts`, `logger.ts`, `permission.ts`, `services/types.ts`) is in the diff; `fleet-detection.ts` sits in Tier 1 shared and imports only shared modules; no new DeepLake import outside `src/daemon` (security's OpenClaw bundle scan was clean and no import edges changed since).

## Remediations Made (in place, uncommitted)

1. `src/shared/fleet-detection.ts`: win32-only `shell: true` on the S3 npm probe (constant argv, nectar-pattern), new injectable `execFileImpl` seam + `ExecFileLike` type, module/function doc comments updated to state the CVE-2024-27980 rationale and the nectar mirror (W-1).
2. `tests/shared/fleet-detection.test.ts`: four new S3 tests (win32 `npm.cmd` + `shell: true` + constant argv, POSIX shell-free, error resolves false, package-not-named resolves false).

No other files were modified by this audit.

## Gate Output

`npm run ci` (typecheck + jscpd + vitest + SQL-safety audit) on the remediated tree, 2026-07-05 00:36 ET, exit 0:

```text
Test Files  400 passed (400)
     Tests  4231 passed | 12 skipped (4243)
  Duration  21.54s

SQL-safety audit: scanned 296 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.
```

Flake note: a first full-suite run failed one test in `tests/daemon/runtime/secrets/exec.test.ts:277` ("kills a runaway ... partial output"), a `vi.waitFor` on runaway-child partial-output capture. That area is untouched by this branch (not in the diff), the file passes in isolation (16/16), and the immediate full-suite re-run passed 400/400. Classified as a pre-existing load-dependent timing flake on this Windows host, not a branch regression.

## Files Changed

Working-tree inventory (`git status` in honeycomb), one line per file; (M) modified, (A) added/untracked, (QA) touched by this audit's remediation:

- `library/qa/security/2026-07-04-security-audit-prd-003-fleet-lifecycle.md` (A), the security wave's audit record (input to this report)
- `src/cli/daemon-service.ts` (M), `unregisterLegacy` seam per manager, extracted from the register-path legacy cleanup (b-AC-2)
- `src/cli/runtime.ts` (M), `buildUninstallLifecycleSteps` (stop, unregister + legacy, registry delete, symlink-safe state-dir removal) wired into `buildRuntimeDeps`
- `src/commands/contracts.ts` (M), `start`/`stop` verb-table rows; the rest is Biome reflow
- `src/commands/dispatch.ts` (M), bare `start`/`stop` dispatch cases + PRD-003a seam forwarding into `installVerbDeps`
- `src/commands/index.ts` (M), export-surface reordering plus the new `UninstallLifecycleSteps` export
- `src/commands/install.ts` (M), the install-time solo-vs-fleet login step (classify, log signals, defer / auto-login / already-signed-in; fail-soft)
- `src/commands/local-handlers.ts` (M), `UninstallLifecycleSteps` contract + ordered best-effort execution + b-AC-6 nothing-to-remove line
- `src/daemon/runtime/telemetry/fleet-registry.ts` (M), `unregisterHoneycombFromDoctor` atomic delete writer (both registry files)
- `src/shared/fleet-detection.ts` (A, QA), the three-signal classifier; win32 S3 `shell: true` fix + `execFileImpl` seam applied by this audit (W-1)
- `tests/cli/uninstall-lifecycle-steps.test.ts` (A), real-steps containment + legacy-argv proofs (b-AC-2/3/4, AC-8)
- `tests/commands/dispatch.test.ts` (M), fleet-defer seam injection so install tests never hit the network
- `tests/commands/install-login.test.ts` (A), a-AC-1/3/4/7 + AC-9 install-login decision suite
- `tests/commands/install.test.ts` (M), fleet-defer seam injection across existing install suites
- `tests/commands/lifecycle-verbs.test.ts` (A), b-AC-1/2/4/5/6 + AC-9 verb suite
- `tests/commands/telemetry-wiring.test.ts` (M), fleet-defer seam injection
- `tests/daemon/runtime/fleet-health-recovery.test.ts` (A), a-AC-1/a-AC-2 same-daemon 503-to-200 recovery proof
- `tests/daemon/runtime/telemetry/fleet-registry-delete.test.ts` (A), b-AC-3 delete-writer suite
- `tests/shared/fleet-detection.test.ts` (A, QA), a-AC-6 classifier suite; four S3 platform-spawn tests added by this audit
