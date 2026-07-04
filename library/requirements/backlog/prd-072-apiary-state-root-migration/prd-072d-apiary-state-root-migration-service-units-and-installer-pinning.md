# PRD-072d: Service Units and Installer Root Pinning

> **Parent:** [PRD-072](./prd-072-apiary-state-root-migration-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None. The launchd/systemd/schtasks unit templates pin the resolved fleet root into the service environment; the installer records the `--home=` choice; the Windows LocalSystem opt-in captures the installing user's home at install time.

---

## Goals

Make the service-launched daemon resolve the SAME fleet root the installing CLI resolved. A service manager starts the daemon with its own environment and working directory; without pinning, an `APIARY_HOME`/`--home=`/XDG choice made at install time would silently not apply at runtime, and the LocalSystem enterprise opt-in would resolve `os.homedir()` to `System32\config\systemprofile`. This extends the exact pattern PRD-064h established for `HONEYCOMB_WORKSPACE` (pin both the working dir and the env var into every unit) to the fleet root.

## Scope

- **launchd:** `renderLaunchdPlist` (`src/cli/daemon-service.ts:251-280`) adds the resolved root to `EnvironmentVariables` beside the existing `HONEYCOMB_WORKSPACE` key (`daemon-service.ts:268-270`).
- **systemd --user:** `renderSystemdUnit` (`daemon-service.ts:287-299`) adds an `Environment=APIARY_HOME=...` line beside the existing `Environment=HONEYCOMB_WORKSPACE=...` (`daemon-service.ts:299`).
- **schtasks:** the `/TR` command prefix (`daemon-service.ts:350`) adds a `set APIARY_HOME=... &&` beside the existing `set HONEYCOMB_WORKSPACE=...`, and the pinned root value passes the same cmd-metacharacter guard that already refuses unsafe paths (`daemon-service.ts:324,340-344`).
- **Pin-what-was-resolved semantics.** The unit pins the RESOLVED root (the output of 072a's helper at registration time), not the raw override, so the daemon needs no re-derivation and the unit is self-contained. When the resolution came from the pure default chain (no env, no `--home=`, no XDG), pinning is still applied for determinism (DEFAULT - confirm before implementation: pin always, versus pin only when non-default; pin-always is simpler and immune to environment drift between logins).
- **XDG precedence alignment.** The helper's Linux XDG step must not contradict the existing user-systemd detection: `defaultServiceManager` requires an `XDG_RUNTIME_DIR` signal before choosing systemd-user (`daemon-service.ts:102-106`). The state-root XDG step keys off `$XDG_STATE_HOME` (state, not runtime) and applies only when that variable is explicitly set (RESOLVED per the fleet ADR's "Resolved decisions": no `~/.local/state/apiary` default), whether or not systemd manages the daemon; the two probes are related but independent, and this sub-PRD documents that relationship in the helper.
- **Installer `--home=` recording.** The install flow (`src/commands/install.ts`) accepts and records the chosen root where 072a's precedence step reads it, and re-registers the service so units carry the new pin. Honeycomb has no `scripts/install/` directory in this repo (the one-line installer lives in the superproject); the repo-side surfaces are `src/commands/install.ts` and `src/cli/daemon-service.ts`, and the superproject installer coordination is tracked cross-repo.
- **Windows LocalSystem opt-in.** For the enterprise `sc.exe` service path only (per the ADR; the schtasks default runs as the logged-in user and resolves the real profile), the installer captures the INSTALLING user's home at install time and pins the resolved root into the service environment so state never lands under `System32`. Honeycomb's current service surface is schtasks-only (`daemon-service.ts:45,100`); the LocalSystem capture lands as the contract for the future `sc.exe` backend and as validation that the pinned env var, when present, wins regardless of the service account (that is 072a's `APIARY_HOME` precedence doing the work).

## Out of scope

- The helper itself and its precedence chain (072a).
- The registry entry contents (072c).
- Migrating unit files' own locations (`~/Library/LaunchAgents/`, `~/.config/systemd/user/`; these are OS conventions, not honeycomb state, and stay put).
- The superproject one-line installer's own changes (cross-repo coordination; tracked in the parallel doctor PRD and the superproject installer ADR).

---

## User stories and acceptance criteria

### US-072d.1 - The service daemon agrees with the CLI

- AC-072d.1.1 Given registration ran with any resolved root, when the unit starts the daemon on each platform, then the daemon's helper resolves exactly that root (pin observed via the rendered plist/unit/TR string in tests).
- AC-072d.1.2 Given an operator changes the root (new `--home=`, changed `APIARY_HOME`) and re-registers, when the service restarts, then the new pin applies and the migration bootstrap (072a) handles any state found at the previous root per the additive rules.

### US-072d.2 - Poisoned paths never reach a unit

- AC-072d.2.1 Given a root value containing a cmd metacharacter on Windows, when the schtasks `/TR` string is built, then registration refuses exactly as the existing guard refuses a poisoned workspace (`daemon-service.ts:324`).
- AC-072d.2.2 Given a root value containing XML-significant characters on macOS, when the plist renders, then the value is escaped by the existing `xmlEscape` path (`daemon-service.ts:237`).

### US-072d.3 - LocalSystem never writes under System32

- AC-072d.3.1 Given the enterprise LocalSystem opt-in, when the service environment is prepared at install time, then it carries the resolved root derived from the INSTALLING user's home, and the daemon under LocalSystem resolves that pinned root rather than `os.homedir()`.

---

## Technical considerations

- Decision #32's legacy-label cleanup precedent (`daemon-service.ts:60-62,416`) shows re-registration safely rewrites units in place; root pinning rides the same register path, so an upgrade that re-registers picks up the pin with no new lifecycle verb.
- The plist/unit/TR renderers are pure functions of `ServiceSpec` (`daemon-service.ts:175-196`); the spec grows a `fleetRoot` field resolved by the caller in `src/cli/runtime.ts`, keeping the renderers injectable and the tests template-exact.
- systemd `Environment=` values with spaces need quoting; follow the existing quoting treatment used for `ExecStart` tokens (`daemon-service.ts:288-297`).

## Test plan

- Template-exact rendering tests per platform asserting the pinned root beside `HONEYCOMB_WORKSPACE`.
- Guard tests: metacharacter root refused on Windows; XML-escaped root on macOS.
- Re-registration test: changed root produces a changed pin; legacy-label cleanup unaffected.
- Precedence integration: a daemon spawned with the pinned env resolves the pinned root even when the ambient HOME differs (LocalSystem simulation via injected home).
