# Security Audit: Doctor Auto-Update Fix (PRD-065)

- **Date:** 2026-06-28
- **Auditor:** security-worker-bee
- **Branch:** main (uncommitted diff)
- **Scope:** ONLY the uncommitted Doctor auto-update fix (dry-run preview + verify/rollback semantics). The npm/auto-update surface was audited in prior passes; this is a focused delta audit.
- **Files reviewed (the diff + new files):**
  - `doctor/src/cli/update-actions.ts` (NEW) - `createUpdateActions`: `checkPrimaryUpdate` -> `previewUpdate`, `applyPrimaryUpdate` -> `runUpdateTransaction`.
  - `doctor/src/update/update-engine.ts` - new `previewUpdate()`, `gatherDecision()`, `updated_unverified` status, pre-update health baseline.
  - `doctor/src/update/update-telemetry.ts` - new `updated_unverified` outcome.
  - `doctor/src/update/index.ts` - exports `UpdatePreview`.
  - `doctor/src/cli/index.ts`, `doctor/src/compose/index.ts` - wiring; `restartDaemon` seam returns boolean.
  - `doctor/tests/cli/update-actions.test.ts` (NEW), `doctor/tests/update/update-engine.test.ts`, `poll-loop.test.ts`, `compose/create-doctor.test.ts`.
- **Supporting (read for context, not in diff):** `src/update/update-policy.ts` (gate), `src/telemetry/emit.ts` (egress chokepoint).

## Executive Summary

**No Critical or High findings.** No remediation required. The change is a security-positive refactor: it removes a real footgun (a `--check` that mutated state) and tightens the rollback rule so it cannot strand a previously-healthy daemon on a broken version. The npm install spec still flows through the existing strict-SemVer guard + fixed-argv path. Telemetry for the new outcome carries only version strings through the closed allow-list. One LOW (informational) note is recorded below; no fix applied.

All 456 tests pass after the audit (no code changed during this audit).

## Findings by Severity

### Critical
None detected.

### High
None detected.

### Medium
None detected.

### Low
- **L1 (informational, no fix) - `updated_unverified` is a deliberately weaker terminal state, by design.**
  `doctor/src/update/update-engine.ts:340-365`. When the daemon was already unhealthy before the update, OR there was no supervised service to restart through, a post-update unhealthy `/health` does NOT roll back; the new version is KEPT and labeled `updated_unverified`. This is the correct and intended behavior (rolling back here would only discard a version that may be the fix, for no safety gain - the update cannot make an already-down daemon worse). It is recorded as informational only so a downstream reader knows the state is intentional, observable (distinct telemetry outcome + `autoupdate.verify_skipped` log), and not an un-verified-version regression on a healthy box. No action recommended.

## Focus-Area Confirmations

### 1. `previewUpdate()` performs NO mutation - a `--check` cannot mutate

**CONFIRMED.** `previewUpdate()` (`update-engine.ts:251-270`) calls `gatherDecision()` (`update-engine.ts:236-253`), which performs reads only: `readInstalledVersion()`, `readLatestVersion()`, `fetchBlessedVersion()`, then the pure `decideUpdate()` gate. It then returns an `UpdatePreview`. It never calls `installLock.acquire()`, never calls `deps.runner.run("npm", ...)`, never calls `restartDaemon()`, never calls `verifyHealthy()`, and never reaches the `rollback()`/`installVersion()` paths. It is `try`-wrapped and crash-safe (a throwing read seam resolves to `{ eligible: false, reason: "latest_unknown" }`, never throws).

The CLI is wired so `update --check` -> `checkPrimaryUpdate` -> `previewUpdate()` ONLY, and `update` -> `applyPrimaryUpdate` -> `runUpdateTransaction()` (`update-actions.ts:30-45`). The previous live bug (the old `checkPrimaryUpdate` in `cli/index.ts` called `runUpdateTransaction()` - which installed, failed verify, and rolled back) is removed; the old mutating block is deleted in the diff.

This is proven by spy tests over a fake engine: `update-actions.test.ts:36-56` asserts `checkPrimaryUpdate` calls `previewUpdate` exactly once and `runUpdateTransaction` never; `update-engine.test.ts:286-...` ("previewUpdate is a pure dry-run") asserts `runner.calls` is empty, `installLock.acquire` not called, `restartDaemon`/`verifyHealthy` not called across the eligible, not-blessed, already-current, installed-unknown, opted-out, and throwing-seam cases.

### 2. `updated_unverified` never strands a previously-healthy daemon on an unverified version, and the install path still semver-validates the target

**CONFIRMED.** The pre-update health baseline `wasHealthyBefore = await deps.verifyHealthy()` is captured BEFORE npm runs (`update-engine.ts:301`). On a post-update unhealthy `/health`, the rollback-vs-keep rule (`update-engine.ts:340-365`) is:

- Roll back **iff** `wasHealthyBefore && restartSupervised`. A healthy-before daemon that was restarted through a supervised OS service and is now unhealthy is a real healthy->unhealthy regression -> destructive rollback to the recorded prior version (AC-064e.3 preserved).
- Otherwise (`!wasHealthyBefore` OR `!restartSupervised`) -> KEEP the install, return `updated_unverified`.

So `updated_unverified` is reachable ONLY when the daemon was already unhealthy, or when there was no supervised daemon to restart through (the CLI's own `restartDaemon` returns `false`; compose forwards `restart()`'s boolean). It is structurally impossible for a healthy, supervised daemon to be left on an unverified broken version - that case always rolls back. The state is observable (distinct `updated_unverified` telemetry outcome + `autoupdate.verify_skipped` structured log with `wasHealthyBefore`/`restartSupervised`), so it is not a silent un-verified ship.

Install path target validation is intact: the target is always `decision.toVersion`, which `decideUpdate()` sets to the blessed manifest version (never raw `@latest`; `update-policy.ts:91-109`). `installVersion()` (`update-engine.ts:173-193`) additionally rejects any non-strict-SemVer string via `parseVersion(version) === null` BEFORE composing the `name@version` spec - this also guards the rollback path, where the prior version is read from the daemon's network-sourced `/health` JSON. No arbitrary npm spec (`latest`, a range like `>=0.0.0`, a tag) can reach `npm install`.

### 3. No new command-injection / shell / network / file-write surface

**CONFIRMED.** The diff introduces no new `exec`/`spawn`/`fetch`/`fs` calls. `previewUpdate()` reuses the same already-audited read seams (`readInstalledVersion`, `readLatestVersion`, `fetchBlessedVersion`) the transaction already uses; it adds no I/O of its own. The npm spec still flows through the unchanged `deps.runner.run("npm", ["install", "-g", spec], ...)` fixed-argv path (`update-engine.ts:186-191`) behind the strict-SemVer guard; the comment at `update-engine.ts:175-184` documents that `execFile` blocks shell-metacharacter injection and the SemVer guard closes the npm argument/spec-injection gap. The `restartDaemon` seam change is purely a `Promise<void>` -> `Promise<void | boolean>` return-type widening (the boolean is consumed to decide rollback); it adds no new process or network call. No file writes are introduced.

### 4. No secrets / PII / log leakage in the new telemetry outcome or preview output

**CONFIRMED.** The new `updated_unverified` outcome flows through the existing single egress chokepoint (`telemetry/emit.ts`) via `createDefaultUpdateEmit` (`update-telemetry.ts:59-72`): it sets `errorClass = "auto_update_updated_unverified"` and `errorDetail = "from=<ver>;to=<ver>;outcome=updated_unverified"`. Both are version strings + a stable label - no token, path, org id, prompt, or credential. The chokepoint additionally enforces a CLOSED allow-list (`buildAllowedAttributes`, `ALLOWED_ATTRIBUTE_KEYS`) that drops anything off-list, so even a future mistake cannot smuggle `token`/`authorization`/`orgId`/`path`/etc. (the `BANNED_ATTRIBUTE_KEYS` negative enumeration is test-asserted absent).

The new structured log `autoupdate.verify_skipped` (`update-engine.ts:353-358`) carries only `to` (version), `reason` (`no-healthy-baseline`/`no-supervised-daemon`), and two booleans - no secrets. The preview's CLI output (`update-actions.ts:34-37`) is `"Update available: <ver> -> <ver>."` or `"No update: <reason>."` - version strings and a fixed gate-reason enum (`already_current`, `latest_not_blessed`, `opted_out`, etc.), no sensitive data.

## Post-Audit Test Result

`cd doctor && npm run test` -> **47 files passed, 456 tests passed** (0 failed). No code was modified during this audit (no Critical/High to remediate), so this confirms the audited tree is green as-shipped.

## Ordering Note

No `*-qa-report.md` for this branch exists yet (pre-flight check clean), so the security-before-quality ordering is intact. **`quality-worker-bee` should run next** to verify the implementation against PRD-065 before merge.
