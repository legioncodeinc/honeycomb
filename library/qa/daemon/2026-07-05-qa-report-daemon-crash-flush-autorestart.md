# QA Report: Daemon-crash hotfix — fail-soft capture flush + conhost-independent auto-restart

**Plan document:** none (standalone hotfix; source plan is the task brief, no PRD/IRD)
**Audit date:** 2026-07-05
**Base branch:** `main` (compared against working-tree HEAD of `fix-lease-discovery-on-paginated-scan`)
**Head:** uncommitted working-tree diff on `fix-lease-discovery-on-paginated-scan` (PR #248)
**Auditor:** quality-worker-bee
**Ordering:** `security-worker-bee` has already run and remediated one High (the `!` delayed-expansion gap). No ordering violation; QA proceeds.

## Summary

**Pass-with-warnings → fix-then-ship (one warning is a policy call, not a code defect).** Both required outcomes are met: a DeepLake capture-write failure can no longer kill the daemon (verified at three layers — timer `.catch`, chain-heal, and the process safety net), and the daemon auto-restarts via a conhost-independent inner relaunch loop whose clean-exit-breaks / non-zero-relaunches behavior I confirmed by **executing the exact generated cmd string on real cmd.exe**. All gates are green (tsc 0 errors, dup 0.66%, SQL audit clean, 3317 daemon+cli tests pass / 0 fail). The one substantive finding is a **bounded-recovery gap**: after 60 lifetime relaunches per logon session the inner loop exits 0, and because conhost masks the exit code the task's own `<RestartOnFailure>` cannot pick up the slack — so a daemon that exhausts the budget stays dead until next logon. That is a deliberate boot-loop cap, but the "auto-recovers" guarantee should be documented as bounded, not unconditional. Everything the brief flagged as possibly-wrong (double-count, chain-heal, non-zero exit after deferred `process.exit`, single-`%i` form, `^>nul` redirect) checked out **correct**.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | Both required outcomes fully addressed; four test files add regression coverage for each. |
| Correctness   | ✅ | Every probed claim verified — including live cmd.exe execution of the relaunch loop. |
| Alignment     | ✅ | Matches the codebase's fail-soft + `logger.event(...)` structured-event conventions. |
| Gaps          | ⚠️ | Bounded-recovery ceiling (60 relaunches/logon) + no time-based re-trigger; narrow but real. |
| Detrimental   | ✅ | No regression to ack / back-pressure / dropped-row accounting; no new duplication. |

## Required-Outcome Verdicts

**Outcome 1 — a DeepLake capture-write failure can NEVER end the daemon process: PASS.**
- The ownerless timer flush no longer escapes: `capture-buffer.ts:220` attaches `.catch((err) => this.onFlushError(err))` synchronously to the `flushNow()` promise, so the rejection is always handled (`src/daemon/runtime/capture/capture-buffer.ts:213-221`).
- The chain-poisoning bug is fixed: the swallowed `gate` promise (`capture-buffer.ts:185-190`) serializes appends without letting a prior rejection short-circuit later windows. Regression test proves window 2 flushes after window 1 fails (`tests/daemon/runtime/capture/capture-buffer.test.ts:189-206`).
- The process safety net is the backstop: `unhandledRejection` logs + keeps running (`src/daemon/index.ts:235-239`), installed on the main entry (`index.ts:255`).
- End-to-end regression (`tests/daemon/runtime/capture/capture-batching.test.ts:359-421`) asserts a timed-out timer flush yields a 201 ack, a logged+counted drop, and **zero** unhandled rejections. All pass.

**Outcome 2 — the daemon auto-recovers: PASS (bounded — see W-1).**
- The relaunch loop lives inside `cmd` where the real errorlevel is visible (`src/cli/daemon-service.ts:502-513`), correctly independent of conhost's masked exit code.
- I executed the exact generated loop on real cmd.exe: a **clean exit 0 runs node once and breaks** (deliberate `daemon stop` not fought); a **non-zero exit relaunches with the `>nul`-suppressed 5s backoff** up to the bound. Confirmed empirically, not just by reading.
- `uncaughtException` exits non-zero so an OS supervisor (or the inner loop's non-zero branch) re-ups (`src/daemon/index.ts:240-249`).

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Auto-restart is bounded to 60 relaunches per logon session; once exhausted the daemon stays dead until next logon**, `src/cli/daemon-service.ts:508`

  The inner loop is `for /l %i in (1,1,60)`. `%i` counts **total relaunches in that cmd/logon session**, not consecutive failures — a daemon that runs for hours and then crashes still consumes one iteration. When the 60 budget is exhausted the `for` loop completes and `cmd /c` exits **0**; because `conhost --headless` masks the exit code to 0 (the very reason this loop exists), the task's `<RestartOnFailure>` (`daemon-service.ts:548-551`, needs non-zero Last Result) **cannot** fire, and the only trigger is `<LogonTrigger>` (`daemon-service.ts:526-529`) — there is no time-based re-trigger. Net: after ~60 lifetime crashes the daemon is not restarted until the user logs off and back on. I verified on real cmd.exe that after the bound the outer exit is 0. This is an intentional boot-loop cap, so the remediation is a **documentation/policy** correction, not a code bug: state the "auto-recovers" guarantee as *bounded* (or add a periodic-restart trigger / `on-idle` re-arm), so on-call does not assume unconditional self-healing.

  ```
  for /l %i in (1,1,60) do ("NODE" "ENTRY" & if !errorlevel! equ 0 (exit /b 0) & timeout /t 5 /nobreak ^>nul)
  ```

## Suggestions (consider improving)

- [ ] **`inFlight` can retain a settled-rejected promise that resurfaces on an empty-buffer `close()`**, `src/daemon/runtime/capture/capture-buffer.ts:190`

  The healed `gate` correctly unblocks future flushes, but `this.inFlight` is still assigned the real (rejectable) `flush` (`capture-buffer.ts:190`). On an empty-window `flushNow()` (`capture-buffer.ts:175`) and thus `close()` (`capture-buffer.ts:205-207`), `await drained` re-throws the last flush's rejection. It is caught by `flushBatch`'s owner (`capture-handler.ts:522-531` wraps `close()` in try/catch and logs), so it is **not fatal** and does not become an unhandled rejection — hence a suggestion, not a warning. Consider mirroring the gate treatment for `inFlight` (store an always-resolving copy for the internal early-return, keep the real promise only for the triggering caller) so a stale rejection cannot resurface on a subsequent no-op drain.

- [ ] **The relaunch-loop tests assert XML substrings only, never runtime cmd semantics**, `tests/cli/daemon-service.test.ts:208-241`

  The new tests check that `for /l %i in (1,1,60)`, `if !errorlevel! equ 0 (exit /b 0)`, `timeout /t 5`, `&amp;`, and `&gt;nul` are present in the rendered XML — good structural coverage, but they cannot catch a cmd-parsing regression (a wrong caret, a `%%i` slip, an `&&`-vs-`&` mistake). I closed that gap manually this audit by executing the exact string on cmd.exe. Consider a Windows-gated smoke test that runs the generated loop against a stub that exits 0 then 7 and asserts run-once-then-break vs relaunch-then-bound, so the runtime contract is guarded in CI rather than by hand.

## Plan Item Traceability

| #   | Plan Requirement | Status | Implementation Location | Notes |
|-----|------------------|--------|-------------------------|-------|
| O1  | A DeepLake capture-write failure can NEVER end the daemon | ✅ | `capture-buffer.ts:220`, `capture-buffer.ts:185-190`, `index.ts:235-239` | Three-layer defense; regression tests green |
| O1a | Timer path `.catch`es the flush (no unhandled rejection) | ✅ | `capture-buffer.ts:213-221` | `.catch` attached synchronously to `flushNow()` |
| O1b | Gate serialization heals the chain (no poisoning, no drop, no deadlock) | ✅ | `capture-buffer.ts:185-190` | Gate always resolves; `flushFn` always invoked; test `capture-buffer.test.ts:189-206` |
| O1c | `onFlushError` sink wired → emits `capture.flush.failed` | ✅ | `capture-handler.ts:470-479` | Log-only sink; counting owned by `flushBatch` |
| O1d | No double-count of dropped rows | ✅ | `flushBatch` counts once (`capture-handler.ts:499`); `onFlushError` (`:470`) + `bufferRow` (`:449`) log-only | Verified: `capture-batching.test.ts` asserts `dropped.read()===1` on timer failure |
| O1e | Process safety net: `unhandledRejection` logs + keeps running | ✅ | `index.ts:235-239` | Test `entry-main.test.ts` asserts `exitCode` untouched |
| O1f | Process safety net: `uncaughtException` logs + exits non-zero | ✅ | `index.ts:240-249` | `exitCode=1` set immediately + deferred `exit(1)`; verified below |
| O2  | The daemon auto-recovers | ⚠️ | `daemon-service.ts:502-513` | Works; **bounded** to 60 relaunches/logon — see W-1 |
| O2a | Relaunch loop breaks on clean exit 0, relaunches on non-zero | ✅ | `daemon-service.ts:510` | **Verified on real cmd.exe**: run-once-break vs relaunch-3×-bound |
| O2b | `for /l %i` single-percent form correct for command-line `cmd /c` | ✅ | `daemon-service.ts:508` | Confirmed: `%i` (not `%%i`) executes without "unexpected at this time" |
| O2c | `^>nul` redirect suppresses `timeout` output inside the loop | ✅ | `daemon-service.ts:511` | Confirmed on cmd.exe: no countdown text; `>nul` active |
| O2d | `/v:on` + `!errorlevel!` delayed read captures node's real exit | ✅ | `daemon-service.ts:510,513` | Delayed expansion evaluated at runtime after node returns |
| O2e | Loop XML-escaped (`&`→`&amp;`, `>`→`&gt;`) | ✅ | `daemon-service.ts:515` via `xmlEscape` (`:259-266`) | Test `daemon-service.test.ts:238-239` |
| S1  | Security remediation: `!` added to `assertCmdSafe` blocklist | ✅ | `daemon-service.ts:357` (`/[&|<>^"%!\r\n]/`) | Guards workspace + entry + fleetRoot; test `daemon-service.test.ts:233-240` |
| R1  | No regression to capture ack / back-pressure semantics | ✅ | `capture-handler.ts:347-357` | Ack (201) returned before flush; unchanged by fail-soft timer change |
| R2  | Dropped-row accounting semantics unchanged | ✅ | `flushBatch` sole counter (`capture-handler.ts:499,506`) | C-4 counter tests pass |

Status legend: ✅ met · ⚠️ met-with-caveat · ❌ gap · 🟦 not-applicable.

## Files Changed

- `src/cli/daemon-service.ts` (M), adds `!` to `assertCmdSafe`; replaces the single `node` invocation with a bounded conhost-independent `for /l` relaunch loop under `cmd /v:on`.
- `src/daemon/index.ts` (M), adds exported `installProcessSafetyNet` (`unhandledRejection` → log + stay alive; `uncaughtException` → log + non-zero exit) and installs it on the main entry.
- `src/daemon/runtime/capture/capture-buffer.ts` (M), adds `FlushErrorSink`/`onFlushError`; timer path now `.catch`es to the sink; `flushNow` reworked to serialize via an always-resolving `gate` so a failed append no longer poisons the flush chain.
- `src/daemon/runtime/capture/capture-handler.ts` (M), `ensureBuffer` wires `onFlushError` → `capture.flush.failed` (log-only; `flushBatch` retains sole ownership of the dropped-row count).
- `tests/cli/daemon-service.test.ts` (M), asserts `cmd /v:on`, the relaunch-loop substrings + XML-escaping, and that `!` in workspace/entry throws.
- `tests/daemon/entry-main.test.ts` (M), asserts the safety-net contract: rejection keeps `exitCode` untouched; uncaught throw sets `exitCode=1` and calls `exit(1)` after the deferred 100ms timer.
- `tests/daemon/runtime/capture/capture-batching.test.ts` (M), regression: a timer-triggered flush failure is fail-soft (201 ack, logged, counted once, no unhandled rejection escapes).
- `tests/daemon/runtime/capture/capture-buffer.test.ts` (M), regression: timer-flush rejection routes to `onFlushError`; the flush chain heals so window 2 flushes after window 1 fails.

## Gate Results (independently run this audit)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npx tsc --noEmit` | ✅ 0 errors |
| Duplication | `npm run dup` | ✅ 34 clones, 0.66% dup tokens (all pre-existing, none in the changed files) |
| SQL safety | `npm run audit:sql` | ✅ scanned 302 files — every SQL interpolation routes through an escaping helper |
| Tests (scoped) | `npx vitest run tests/daemon/ tests/cli/` | ✅ 309 files, 3317 passed / 12 skipped / **0 failed** (12.9s) |

The known-flaky `tests/hooks/runtime/hook-runtime.test.ts` was out of scope for the scoped run and did not execute; no in-scope failures observed.

## Overall Verdict

**fix-then-ship.** No blocker. The two required outcomes both PASS on the code. Before merge, correct the "auto-recovers" wording to reflect the bounded (60/logon, no time-based re-trigger) recovery ceiling (W-1) — a policy/doc fix, not a code change — and optionally address the two suggestions (stale-`inFlight` on empty `close()`, and a CI smoke test for the cmd loop's runtime semantics). If the bounded ceiling is an accepted trade for this hotfix, it ships as-is with the doc note.
