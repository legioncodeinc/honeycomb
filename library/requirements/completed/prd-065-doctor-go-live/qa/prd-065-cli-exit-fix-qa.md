# QA Report — PRD-065 Doctor one-shot CLI exit fix (`UV_HANDLE_CLOSING`)

- **Auditor:** quality-worker-bee
- **Date:** 2026-06-28
- **Plan / source:** PRD-065 Doctor go-live (`library/requirements/backlog/prd-065-doctor-go-live/`)
- **Scope:** the just-made fix for the Windows libuv exit assertion
  (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`)
  on Doctor's one-shot CLI commands.
- **Base:** `main` @ `fb714db` (working-tree change, uncommitted)
- **Verified in:** `C:\Users\mario\GitHub\honeycomb` (main checkout)
- **Files under review:**
  - `doctor/src/cli/bin.ts` (modified)
  - `doctor/src/cli/shutdown.ts` (new)
  - `doctor/tests/cli/shutdown.test.ts` (new)

---

## Summary

The fix is **ship-ready**. A new `src/cli/shutdown.ts` isolates the one-shot teardown
(`isOneShot`, `closeGlobalDispatcher`, `unrefActiveHandles`, `finalizeOneShot`) and `bin.ts`
wires it onto the one-shot path while explicitly excluding the long-running `run` watchdog.
Every claim in the brief was traced to code and to a proving test: `run` cannot be
force-finalized, the happy path sets `exitCode` and never calls `process.exit()` synchronously,
handles are only `unref`'d (never destroyed), and the one-shot live-repro path (`update --check`)
emits no telemetry so nothing legitimate is cut off by exiting. Gates are green: `tsc --noEmit`
clean and `vitest run` reporting **48 files / 474 tests passed** (the new suite contributes 18).

> Honest caveat (called out in the brief and confirmed here): a libuv abort **cannot be
> unit-asserted** because it aborts the process before any assertion can run. The testable
> surface is therefore the exit-path *logic* (close-before-exit, unref-not-destroy, no synchronous
> force-exit on the happy path, bounded close, unref'd backstop). The behavioral proof that the
> abort is gone is the implementer's live Windows repro of `doctor update --check`. This QA
> verifies the logic exhaustively; it does not and cannot re-run the native abort.

**Verdict: SHIP-READY.**

---

## Scorecard

| Axis | Status | Notes |
|------|--------|-------|
| Completeness | VERIFIED | All four exported functions present, wired, and covered. |
| Correctness | VERIFIED | `run` excluded; happy path is set-exitCode + return; unref-only; bounded close + unref'd backstop. |
| Alignment | VERIFIED | Implementation matches the brief's intended design point-for-point. |
| Gaps | NONE | No fire-and-forget telemetry on the one-shot path; no missing exclusion; no destroy. |
| Detrimental patterns | NONE | Fail-soft everywhere; injectable seams; no new runtime deps; `run` lifecycle untouched. |

---

## Per-criterion verification

| # | Criterion | Status | Proving evidence (file:line / test) |
|---|-----------|--------|-------------------------------------|
| 1 | `isOneShot` returns **false** for `run` (and variants), **true** for one-shot commands; `run` cannot be force-finalized | VERIFIED | `shutdown.ts:61-63` (`argv[0] !== "run"`). Tests: `shutdown.test.ts:41-44` (`run`, `run --no-auto-update` → false), `:27-31` (status/diagnose/update/logs/self-update/heal/help → true), `:33-39` (`update --check` and bare `[]` → true). Wiring: `bin.ts` calls `process.exit(code)` in the `!isOneShot` branch and only the one-shot branch reaches `finalizeOneShot`. |
| 2 | `finalizeOneShot` happy path does **not** call `process.exit()` synchronously; sets `exitCode` + lets loop drain; force-exit only on an unref'd backstop timer | VERIFIED | `shutdown.ts:236` sets `process.exitCode` (Step 3), `:240-241` arms the `unref`'d backstop (Step 4); no synchronous `forceExit` on the happy path. Test: `shutdown.test.ts:155-185` asserts order `["close","unref","setExitCode"]` and `expect(forceExit).not.toHaveBeenCalled()`. Backstop behavior: `:201-225` (timer armed, unref'd, fires `forceExit(code)` only when manually triggered). |
| 3 | `unrefActiveHandles` only unrefs, **never destroys** | VERIFIED | `shutdown.ts:123-145` calls `h.unref()` only; no `destroy` reference anywhere in the sweep. Test: `shutdown.test.ts:105-111` provides a handle with both `unref` and `destroy` and asserts `expect(sock.destroy).not.toHaveBeenCalled()`. |
| 4 | No telemetry is cut off by exiting (one-shot path emits no fire-and-forget telemetry, or a bounded flush exists) | VERIFIED | The live-repro one-shot path `update --check` → `checkPrimaryUpdate` → `engine.previewUpdate()` is READ-ONLY and emits nothing (`update-actions.ts:30-38`, doc `:7-10`). Telemetry is emitted **only** inside `runUpdateTransaction` and is **awaited** before the handler returns (`update-engine.ts:202,220,317,336,359` via `await emitEvent(...)`; default emit is fail-soft, `update-telemetry.ts:59-72`). `status`/`diagnose`/`logs`/`self-update`/bare/help emit no telemetry. Therefore `finalizeOneShot` only runs after any emit has resolved — nothing fire-and-forget is lost. |
| 5 | `run` path still uses its own shutdown (not `finalizeOneShot`); existing tests still green | VERIFIED | `index.ts:215-227` `runWatchdog` blocks on SIGTERM/SIGINT then calls `await doctor.stop()`; `runCli` routes `argv[0]==="run"` there (`index.ts:234-235`). `bin.ts` `!isOneShot(["run"])` → plain `process.exit(code)`, never `finalizeOneShot`. Full suite green (see gates). |
| 6 | Gates: `npm run typecheck && npm run test` green; honest counts | VERIFIED | `tsc --noEmit` exits clean (no output). `vitest run` → **48 test files / 474 tests passed**. Matches the expected ~48/~474. |

---

## Findings

### Critical (must fix)
None.

### Warnings (should fix)
None.

### Suggestions (consider improving)

- **[Suggestion] No automated regression guard that `bin.ts` actually routes through `isOneShot` / `finalizeOneShot`.**
  `bin.ts` (`doctor/src/cli/bin.ts:30-41`) is top-level module code executed on import, so it is
  not unit-tested directly; the gate logic (`isOneShot`, `finalizeOneShot`) is fully covered in
  isolation but the *wiring* in `bin.ts` (one-shot → `finalizeOneShot`, `run` → plain `process.exit`)
  is verified only by reading. This matches the existing repo pattern (other bin/entry code is also
  thin and untested), so it is not a blocker. If a future refactor wants belt-and-suspenders, extract
  the two-line decision into a tested `selectExit(argv, code, deps)` helper. Low priority.

- **[Suggestion] `_getActiveHandles` is an undocumented internal Node API.**
  `unrefActiveHandles` (`shutdown.ts:124`) reads `process._getActiveHandles`, which is not a stable
  public API and could change across Node majors. The code already guards this correctly
  (`typeof`-guarded, per-handle try/catch, returns `0`/no-op on absence — `shutdown.ts:124-131`,
  tested at `shutdown.test.ts:113-115`), so a future removal degrades gracefully to "no extra unref"
  rather than a crash. Worth a one-line comment noting the Node-version assumption if this ships
  long-lived. No action required.

---

## Gate results

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | PASS (clean, no output) |
| Test suite | `npm run test` (`vitest run`) | PASS — **48 files / 474 tests** |
| New suite (isolated) | `npx vitest run tests/cli/shutdown.test.ts` | PASS — **18 tests** |

Environment: Node `v25.2.1`, run in `doctor/` under the main checkout on branch `main`.

---

## Detrimental-pattern / robustness review (positives observed)

- **Fail-soft throughout.** `closeGlobalDispatcher` swallows a rejecting `close()` (`shutdown.ts:98-102`,
  tested `:74-81`); `finalizeOneShot` wraps the close race in try/catch (`:217-223`) and the unref sweep
  in try/catch (`:228-232`); a teardown failure can never turn an already-printed correct result into a crash.
- **Bounded so it can never hang.** The pool-close step races a `settleTimeoutMs` bound (`:211-218`),
  tested with a never-resolving close (`shutdown.test.ts:244-266`).
- **No new runtime dependency.** undici is reached via `Symbol.for("undici.globalDispatcher.1")`
  (`shutdown.ts:48,82-86`) rather than importing undici — built-ins only, consistent with the rest of Doctor.
- **`run` watchdog lifecycle is genuinely untouched.** No edit to `runWatchdog`/`doctor.stop()`; the
  only `run`-adjacent change is the `bin.ts` guard that keeps `run` on its plain-exit path.

---

## Files changed

| File | Change | One-line summary |
|------|--------|------------------|
| `doctor/src/cli/bin.ts` | modified | Awaits `runCli`, then branches: `run` → `process.exit(code)`; one-shot → `await finalizeOneShot(code)`. |
| `doctor/src/cli/shutdown.ts` | new (+243) | One-shot teardown: `isOneShot`, `closeGlobalDispatcher`, `unrefActiveHandles`, `finalizeOneShot` (close pool → unref → set exitCode → unref'd backstop). All seams injectable. |
| `doctor/tests/cli/shutdown.test.ts` | new (+267) | 18 tests: gate truth table, close fail-soft + destroy fallback, unref-not-destroy, graceful no-force-exit order, bounded close, unref'd backstop. |

---

## Ordering note

`security-worker-bee` ordering was not in scope of this single-fix verification request and no active
security findings appear in the reviewed diff (the change is pure process-exit lifecycle, no new I/O,
no new dependency, no credential/PII surface). If this fix is bundled into the broader PRD-065 go-live
merge, run `security-worker-bee` on the full branch before the final merge gate per the standard loop.
