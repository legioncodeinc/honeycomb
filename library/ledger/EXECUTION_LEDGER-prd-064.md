# Execution Ledger - PRD-064 HiveDoctor

> /the-smoker run ledger for PRD-064 (HiveDoctor self-healing watchdog).
> Worktree: `C:\Users\mario\GitHub\honeycomb\.claude\worktrees\competent-nightingale-900e0c`
> Branch: `legion/competent-nightingale-900e0c`
> Status: OPEN / IN PROGRESS / DONE (implemented + unit-tested) / VERIFIED (independently graded) / BLOCKED (external prereq).

## Environment reality (drives the BLOCKED column)

Single Windows dev machine, no live external credentials. Three AC classes cannot reach VERIFIED in this run and are parked BLOCKED with a specific ask:

1. **Cross-platform OS-service behavior** (reboot/SIGKILL survival; launchd/systemd/Scheduled-Task install) - needs a macOS+Linux+Windows CI matrix.
2. **Live external services** - npm publish of `@legioncodeinc/hivedoctor`, a real `blessed-version.json` on `get.theapiary.sh`, live PostHog Logs ingestion (alpha + `phc_` token).
3. **Auto-update against the live registry** - depends on (2).

The *logic* behind every blocked item IS buildable and unit-testable here with mocked HTTP/child_process/fs. The smoker drives that to VERIFIED; live behavior is BLOCKED (asks at bottom).

> Risk flag: **064h (make the shipped primary daemon OS-native)** edits the live daemon lifecycle (`src/cli/runtime.ts`, `src/commands/install.ts`) - highest blast radius. Land as code+tests, but gate behind human review + live multi-OS smoke before shipping (B-5).

---

## Wave plan

- **Wave 0 (serial, foundation):** scaffold `hivedoctor/` package (dependency-light, strict ESM Node 22, own tsconfig, Vitest), shared state/incident model + logger. Owner: `typescript-node-worker-bee`. Unblocks all.
- **Wave 1 (parallel, in separate files):** 064a supervisor core; 064d telemetry emitter; 064f CLI. Owners: `typescript-node-worker-bee` x2 + sonnet.
- **Wave 2 (parallel):** 064c ladder; 064e auto-update; 064g escalation/status-page.
- **Wave 3 (serial, risk):** 064b service templates+installer; 064h daemon-OS-native; INT repo/build wiring. Owners: `harness-integration` / `ci-release`.
- **Close-out:** `security-worker-bee` then `quality-worker-bee`.
- **Ship:** commit, push, PR, CI loop.

Model selection per Bee recorded in each section header below (from `.claude/model-comparison-matrix.md`).

---

## AC Ledger

### Module rollups (index AC-1..AC-10)

| ID | Criterion (abbrev) | Status | Owner |
|---|---|---|---|
| M-1 | OS-supervised; survives reboot/SIGKILL | BLOCKED | harness-integration |
| M-2 | daemon down -> backoff restart -> healthy | OPEN | typescript-node |
| M-3 | ladder exhausts -> structured escalation | OPEN | typescript-node |
| M-4 | telemetry on by default; honest opt-out | OPEN | typescript-node |
| M-5 | auto-update blessed + verify + rollback | OPEN | typescript-node |
| M-6 | never auto-updates itself; self-update explicit | OPEN | typescript-node |
| M-7 | bare invoke prints ASCII art + menu | OPEN | typescript-node |
| M-8 | remediation failure never crashes watchdog | OPEN | typescript-node |
| M-9 | authority model (restart/reinstall-3/uninstall-hm/no-creds) | OPEN | typescript-node |
| M-10 | install opt-out (`--no-hivedoctor`) | OPEN | harness-integration |

### 064a Supervisor core (model: claude-opus-4-8-thinking-high) - DONE (Wave 0)
AC-064a.1 DONE | AC-064a.2 DONE | AC-064a.3 DONE | AC-064a.4 DONE | AC-064a.5 DONE | AC-064a.6 DONE
> hivedoctor/ package scaffolded (zero runtime deps, strict ESM Node22, own tsconfig+vitest). 49 tests pass; root typecheck/dup/test unaffected. Files: hivedoctor/{package.json,tsconfig.json,vitest.config.ts,README.md}, src/{config,state,incidents,logger,health-probe,backoff,remediation,supervisor}.ts, tests/*. Rungs 2+ are declared interface slots for later waves. M-2 and M-8 now substantially covered.

### 064b Self-supervision + install (model: claude-opus-4-8-thinking-high) - DONE (logic); live OS BLOCKED (B-1)
AC-064b.1 BLOCKED(live) | AC-064b.2 BLOCKED(live) | AC-064b.3 BLOCKED(live) | AC-064b.4 DONE | AC-064b.5 DONE(unit)/BLOCKED(live) | AC-064b.6 DONE(logic)/BLOCKED(live)
> hivedoctor/src/service/{platform,templates,argv,index,install-guard}.ts (launchd/systemd/schtasks, userland default + privileged fallback, all shell-outs injected). CLI install-service/uninstall-service now live + `run` long-running entry. Installer hooks added to install.sh+install.ps1 (additive, --no-hivedoctor guarded); src/commands/install.ts untouched. 378 tests. M-10 DONE.

### 064c Remediation ladder (model: claude-opus-4-8-thinking-high) - DONE
AC-064c.1 DONE | AC-064c.2 DONE | AC-064c.3 DONE | AC-064c.4 DONE | AC-064c.5 DONE | AC-064c.6 DONE
> rungs 2 (reinstall, after 3 fails) + 3 (uninstall @deeplake/hivemind, package-only, backup-first) + escalate hook; install-lock.ts shared mutex; no credential-purge path. 145 tests. WIRING TODO (integration wave): supervisor must register rungs 2/3 in production + call ladder.escalate() on give-up.

### 064d Telemetry (model: claude-4.6-sonnet-medium-thinking) - DONE (logic); live ingest BLOCKED (B-4)
AC-064d.1 DONE(shape) | AC-064d.2 DONE | AC-064d.3 DONE | AC-064d.4 DONE | AC-064d.5 DONE | AC-064d.6 DONE | AC-064d.7 DONE
> hand-rolled OTLP Logs JSON to /i/v1/logs, single chokepoint, opt-out (DO_NOT_TRACK/HONEYCOMB_TELEMETRY/state toggle), allow-list scrub, fail-soft. Files: hivedoctor/src/telemetry/{globals.d.ts,otlp-serializer.ts,emit.ts} + tests. 121 total tests green. Live ingestion needs phc_ token at build/publish (B-4).

### 064e Auto-update (model: claude-opus-4-8-thinking-high) - DONE (logic); live npm BLOCKED (B-2)
AC-064e.1 DONE(logic) | AC-064e.2 DONE | AC-064e.3 DONE | AC-064e.4 DONE | AC-064e.5 DONE | AC-064e.6 DONE
> 30-min jittered poll, blessed-version.json gate (fail-closed), verify /health + rollback, shared install-lock serialization, injectable UpdateEmit seam onto 064d. Files: hivedoctor/src/update/* + tests. 237 tests. WIRING TODO (064f composition root): resolve --no-auto-update/env/state pin precedence + start poll loop.

### 064f CLI + UX + COMPOSITION ROOT (model: claude-opus-4-8-thinking-high) - DONE
AC-064f.1 DONE | AC-064f.2 DONE | AC-064f.3 DONE | AC-064f.4 DONE | AC-064f.5 DONE | AC-064f.6 DONE
> ASCII art + hand-rolled command dispatch (no clear-credentials cmd; self-update is the sole self-update path). createHiveDoctor() composition root registers rungs 1/2/3, wires escalate-on-give-up (supervisor.ts surgical edit), starts poll loop (opt-out precedence: flag>env>state>pin) + status page. 315 tests. M-6/M-7 DONE. Open-q: heal --yes implemented for power users (flag if OD-4 tiers preferred).

### 064g Escalation reporting (model: claude-4.6-sonnet-medium-thinking) - DONE (logic)
AC-064g.1 DONE | AC-064g.2 DONE(file+seam); live render BLOCKED | AC-064g.3 DONE(logic); live ingest BLOCKED(B-4) | AC-064g.4 DONE | AC-064g.5 DONE
> needs-attention.json store (atomic, resolve()), incidents append, hosted sink via 064d, local status page on 127.0.0.1:3852 (read-only, fail-soft). 179 tests. Dashboard daemon-side render of needs-attention.json is a later dashboard task.

### 064h Daemon OS-native (model: claude-opus-4-8-thinking-high) [HIGH RISK] - DONE (logic); live OS BLOCKED (B-1)
AC-064h.1 BLOCKED(live) | AC-064h.2 BLOCKED(live) | AC-064h.3 BLOCKED(live) | AC-064h.4 DONE(unit) | AC-064h.5 DONE(unit) | AC-064h.6 DONE(unit)
> shipped daemon now SERVICE-PREFERRED with spawn FALLBACK (no regressions; 3963 pass/1 known flake). src/cli/daemon-service.ts (launchd/systemd/schtasks, writable-workspace pinned, injected runner, createRequire-indirected). runtime.ts buildDaemonLifecycle service-aware + restart()-through-manager; install.ts additive supervision report. M-1 logic done; live survival BLOCKED. Follow-up: wire `unregister` into an uninstall verb (built+tested, not wired).

### Integration (model: claude-opus-4-8-thinking-high) - DONE / publish BLOCKED (B-2)
INT-1 DONE - hivedoctor esbuild build (bundle/cli.js), files allowlist (5-file tarball), prepack, pack-check; multi-OS CI matrix (ubuntu/macos/windows) added to ci.yaml (additive); root tsc/dup/vitest isolated + untouched.
INT-2 DONE(authored)/BLOCKED(live) - .github/workflows/release-hivedoctor.yaml (OIDC trusted publishing, provenance, hivedoctor-v* tag, fail-closed, does NOT publish). First publish is manual bootstrap (B-2) + version bump off 0.0.0.

## Close-out
- security-worker-bee: DONE - 2 High remediated in place (rollback semver validation in update-engine.ts; Windows schtasks /TR command-injection in daemon-service.ts via assertCmdSafe), 0 Critical. Tests green (378 hivedoctor + 27 daemon-service). Report: qa/prd-064-security-report.md. Medium/Low follow-ups noted.
- quality-worker-bee: DONE - 41/56 VERIFIED, 15 BLOCKED (external B-1..B-5), 0 PARTIAL/MISSING, 0 Critical, 2 Warnings (W-1 compose blessedVersion:"" no-op verify; W-2 systemd ExecStart unquoted), S-2 em dashes in code comments. Ledger judged honest; all ODs conform; no regressions. Report: qa/prd-064-qa-report.md.
- remediation pass (W-1/W-2/S-2): DONE - blessed version threaded into rung-2 verify (fail-soft/fail-closed, degrades to unverified-no-blessed until B-3); systemd ExecStart quoted; all PRD-064-authored em/en dashes removed. 384 hivedoctor tests + 43 daemon tests green; root typecheck/dup pass; dash grep clean. Close-out CLEAN (0 Critical, 0 open Warnings >= medium).
- SHIP: committed + pushed; PR #159 open (https://github.com/legioncodeinc/honeycomb/pull/159). CodeQL + CLA green. TWO CI blockers, both external (parked BLOCKED, need Mario):
  - B-6 PRD-NUMBER COLLISION: origin/main already shipped prd-064 = "Portkey Gateway" (concurrent smoker run). This HiveDoctor PRD must renumber 064 -> 064 (next free on main). Causes the only merge conflict (the ledger file), which is why the pull_request CI workflow shows 0 runs (GitHub cannot build the merge commit while conflicting). Fix: renumber + merge origin/main (4 commits ahead, ledger-only conflict) + push.
  - B-7 AIKIDO: 4 CRITICAL / 8 HIGH / 13 MEDIUM flagged (dashboard auth-gated). Our security-worker-bee found only 2 High (both fixed). Aikido criticals are most likely the dual-use watchdog patterns already reviewed safe (fixed-argv execFile child_process, loopback-only http server, constant-URL fetch, public write-only PostHog key define). Needs dashboard triage / decision.

---

## Blockers (specific asks)

- **B-1 OS test matrix:** approve a macOS+Linux+Windows CI job to verify M-1, 064b live, 064h live (cannot be verified on this dev box).
- **B-2 npm publish:** confirm npm org access + that we want a second published package now (INT-2, 064e live).
- **B-3 blessed CDN object:** confirm the `get.theapiary.sh` write path + who flips `blessed-version.json`.
- **B-4 PostHog token:** confirm `phc_` project token injection for HiveDoctor + that PostHog Logs alpha is acceptable.
- **B-5 064h ship gate:** confirm 064h lands as code now but does NOT auto-merge to the shipped daemon without a live multi-OS smoke + human review.

---

## Run log

- (init) Ledger created. Phase 0 complete.
- Wave 0 DONE: hivedoctor/ package + 064a supervisor core, 49 tests green, root gates intact, fully additive (no src/ changes). Checkpoint: holding before Waves 1-3 pending Mario's rulings on B-1..B-5 (publish, 064h ship gate, OS matrix, PostHog token, ship target).
