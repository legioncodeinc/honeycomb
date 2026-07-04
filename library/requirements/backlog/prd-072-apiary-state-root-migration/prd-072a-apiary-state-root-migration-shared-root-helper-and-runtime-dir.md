# PRD-072a: Shared Fleet-Root Helper and Runtime-Dir Cutover

> **Parent:** [PRD-072](./prd-072-apiary-state-root-migration-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-2d)
> **Schema changes:** None. New `src/shared/` module; runtime dir (pid, lock, workspace fallback) relocates to `~/.apiary/honeycomb/` behind the migration bootstrap.

---

## Goals

Give honeycomb the ONE fleet-root resolution helper ADR-0003 requires (identical precedence chain across the fleet, home-anchored, never cwd), cut the daemon runtime dir (pid + lock + unwritable-workspace fallback) over to `~/.apiary/honeycomb/`, and make the upgrade boot safe on a machine where the previous daemon is still running under the legacy lock. This sub-PRD also owns the migration bootstrap (trigger, marker, per-family move loop) that 072b's state families plug into.

## Scope

- A new Tier 1 module (for example `src/shared/fleet-root.ts`) exporting: the fleet-root resolver implementing the canonical `resolveFleetRoot` chain from the fleet ADR's "Resolved decisions" (`APIARY_HOME` env, with the installer's `--home=` pin delivered as `APIARY_HOME` in the service environment > `$XDG_STATE_HOME/apiary` on Linux only when explicitly set > `<os.homedir()>/.apiary`; no `~/.local/state` default), the honeycomb subdir join (`<root>/honeycomb`), the fleet-root join for shared files, and the legacy dir resolver (`<os.homedir()>/.honeycomb`) for fallback reads.
- `resolveRuntimeDir` (`src/daemon/runtime/assemble.ts:711-713`) and the CLI's `runtimeDir()` (`src/cli/runtime.ts:159-161`) resolve through the helper. The injectable `runtimeDir` test seam (`assemble.ts:278`) is unchanged.
- The unwritable-workspace fallback (`assemble.ts:1384`, `src/cli/runtime.ts:172-179`) falls back to the new honeycomb subdir instead of `~/.honeycomb`.
- The single-instance guard (`acquireSingleInstanceLock`, `assemble.ts:738-755`) checks the NEW lock, then the LEGACY lock, refusing on either live pid; stale locks at either path are reclaimed. During the compatibility window the guard dual-stamps the legacy pid file (DEFAULT per the index open question) and `releaseSingleInstanceLock` (`assemble.ts:771-779`) removes both.
- The migration bootstrap: runs once at assembly before state stores initialize, keyed by the `migration.json` marker in `~/.apiary/honeycomb/`, executing registered per-family movers (072b registers the families). Copy, atomic rename, mark; never delete an unmigrated legacy file.
- CLI pid reads (`src/cli/runtime.ts:203`) resolve new-path-first, legacy-second.

## Out of scope

- The individual state-family movers beyond pid/lock (072b).
- Registry, device.json, install-id (072c).
- Service-unit and installer pinning of the resolved root (072d); this sub-PRD only honors `APIARY_HOME` when a unit sets it.

---

## User stories and acceptance criteria

### US-072a.1 - One helper, one chain

**As** any honeycomb target (daemon, CLI, hooks), **I want** the fleet root resolved by one shared helper, **so that** every path decision agrees with the rest of the fleet.

- AC-072a.1.1 Given `APIARY_HOME` is set, when any target resolves the root, then that value wins over the installer config, XDG, and the home default.
- AC-072a.1.2 Given no override, when the root resolves on Linux with `$XDG_STATE_HOME` set, then the root is `$XDG_STATE_HOME/apiary`; unset, it is `<os.homedir()>/.apiary` (RESOLVED per the fleet ADR's "Resolved decisions": XDG is honored only when explicitly set; there is no `~/.local/state/apiary` default). On darwin/win32 the XDG leg is skipped entirely.
- AC-072a.1.3 Given any working directory (including `/` and `C:\WINDOWS\system32`), when the root resolves, then the result is independent of `process.cwd()`.
- AC-072a.1.4 Given the helper exists, when `npm run dup` runs, then no other module re-declares the root constants (single source of truth, matching the `src/shared/constants.ts` discipline).

### US-072a.2 - The runtime dir moves without losing single-instance safety

**As** an operator upgrading in place, **I want** the daemon to never double-start because the lock moved, **so that** port 3850 is never double-bound.

- AC-072a.2.1 Given a live pid in `~/.apiary/honeycomb/daemon.lock`, when a second daemon starts, then it throws `DaemonAlreadyRunningError` (unchanged semantics at the new path).
- AC-072a.2.2 Given a live pid in the LEGACY `~/.honeycomb/daemon.lock` and no new lock, when the upgraded daemon starts, then it throws `DaemonAlreadyRunningError` naming the legacy pid.
- AC-072a.2.3 Given stale locks at either or both paths, when the daemon starts, then both are reclaimed, the new lock is acquired at `~/.apiary/honeycomb/`, and (window open) the legacy pid file is stamped with the same pid.
- AC-072a.2.4 Given a graceful shutdown, when release runs, then pid and lock files at BOTH paths are removed.

### US-072a.3 - The migration bootstrap is one-time, idempotent, additive

**As** the state families of 072b, **I want** a single bootstrap with a marker, **so that** each family migrates exactly once and failures are non-destructive.

- AC-072a.3.1 Given a legacy layout and no marker, when the first boot runs, then each registered family's mover executes and the marker records per-family outcomes.
- AC-072a.3.2 Given a marker with a family marked complete, when boot runs again, then that family's mover is skipped.
- AC-072a.3.3 Given a mover fails, when the bootstrap finishes, then the legacy file remains, the family is marked failed (retryable next boot), reads fall back to the legacy path, and daemon boot proceeds (fail-soft; a migration error never blocks boot).

---

## Technical considerations

- The helper is Tier 1 (`src/shared/`) per the fixed build direction; the daemon, CLI, hooks, and harness bundles all import it downward. No target re-declares the `.apiary` literal.
- The `--home=` delivery mechanism: RESOLVED per the fleet ADR's "Resolved decisions" canonical chain: the installer's `--home=` pin is delivered as `APIARY_HOME` in the service environment (072d pins it into every rendered unit), so the daemon reads only env at boot and no `config.json` recording step exists in the chain. The earlier config.json default is superseded.
- `resolveWorkspaceBaseDir`'s stderr message (`assemble.ts:1385-1387`) names the fallback path; update the message with the new path so operator guidance stays truthful.
- The bootstrap must run before `fleet-store.ts` opens the telemetry SQLite and before the secrets store first reads the machine key, or those stores would mint fresh state at the new path and orphan the legacy data.
- Windows: `renameSync` across volumes fails (`EXDEV`); the mover copies then renames within the target volume, and treats a cross-volume legacy layout as copy-plus-mark (legacy file retained) rather than move.

## Test plan

- Precedence-chain unit matrix per AC-072a.1 (env, config, XDG set/unset per platform, home default), all on temp HOMEs.
- Lock-continuity suite per AC-072a.2: live-new, live-legacy, stale-both, dual-stamp, dual-release.
- Bootstrap suite per AC-072a.3: fresh, seeded-legacy, marker-skip, injected mover failure leaves legacy intact and boots anyway.
