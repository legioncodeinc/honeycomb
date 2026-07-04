# PRD-072: Migrate Honeycomb Runtime State to the `~/.apiary/honeycomb/` Fleet Root

> **Status:** Backlog
> **Priority:** P1
> **Effort:** XL (3-6d)
> **Schema changes:** None to Deeplake. On-disk relocation of honeycomb's local runtime state (pid, lock, telemetry SQLite, asset registry, skillify state, graph cache, notifications state, machine key) from `~/.honeycomb/` to `~/.apiary/honeycomb/`, plus fleet-shared surface writes (doctor registry entry, device id) relocating to the fleet root `~/.apiary/`.

---

## Overview

Fleet ADR-0003 (mirrored locally as [`0008-fleet-directory-ownership-and-neutral-state-root.md`](../../../knowledge/private/architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md)) introduces one brand-neutral, home-anchored fleet root, `~/.apiary/`, and splits per-product runtime state from the fleet-shared coordination surface underneath it. Each product owns exactly one subdirectory (`~/.apiary/honeycomb/`, `~/.apiary/nectar/`, `~/.apiary/doctor/`, `~/.apiary/hive/`); the shared registry, device id, and install id live at the fleet root and are doctor-managed. The root name `~/.apiary/` was confirmed over the `~/.doctor/` alternative on 2026-07-04, alongside the per-product subdirectory layout, the doctor-managed shared surface, and the decision that `~/.deeplake/` is unchanged.

Honeycomb is special in this migration: it is the ORIGINAL owner of `~/.honeycomb`. The directory is named after this product, honeycomb shipped first, and the rest of the fleet moved in afterward. That history means honeycomb has the largest `~/.honeycomb` surface of any product (the code-grounded inventory below counts eleven distinct state families) and the highest legacy-compat burden: real installs exist whose live daemon holds a lock at the legacy path, whose doctor registry entry advertises literal `~/.honeycomb/...` strings, and whose secrets are decryptable only through a machine key sitting at `~/.honeycomb/.machine-key`. A careless move bricks secrets, double-starts the daemon across an upgrade, or strands doctor's health probing. This PRD relocates honeycomb's per-product runtime state to `~/.apiary/honeycomb/`, moves its fleet-shared writes to the fleet root, and does both behind a one-time, idempotent, additive migration with legacy-fallback reads, per the ADR's migration contract.

AGENTS.md's FR-8 rule (durable state goes in Deeplake, not JSON sidecars) is not in tension with this PRD: the files being moved are local process/runtime state (pid, lock, caches, local telemetry SQLite, local bookkeeping registries), which are the legitimate local exceptions FR-8 carves out, exactly as `src/daemon/runtime/assemble.ts:197-200` documents for the runtime dir today.

---

## Goals

- Introduce one shared fleet-root helper in `src/shared/` that resolves the root with the canonical `resolveFleetRoot` chain in the fleet ADR's "Resolved decisions" (confirmed 2026-07-04): `APIARY_HOME` env (the installer's `--home=` pin is delivered as `APIARY_HOME` in the service environment) > `$XDG_STATE_HOME/apiary` on Linux only when `$XDG_STATE_HOME` is explicitly set > `<os.homedir()>/.apiary`. There is no `~/.local/state` default. Anchored on `os.homedir()` and never `process.cwd()`.
- Relocate every honeycomb-owned runtime state family from `~/.honeycomb/` to `~/.apiary/honeycomb/` behind a one-time, idempotent, additive first-boot migration with legacy-fallback reads.
- Preserve single-instance continuity across the upgrade boot: a daemon still running under the legacy lock must be detected, and the upgraded daemon must never double-bind port 3850 because the lock moved.
- Relocate honeycomb's fleet-shared writes: the doctor registry entry moves to `~/.apiary/registry.json` (doctor-managed; honeycomb writes only its own entry) following doctor's compatibility window, and the shared device id moves to `~/.apiary/device.json`.
- Pin the resolved root into the launchd/systemd/schtasks service units so a service-launched daemon resolves the same root the CLI resolved, including the Windows LocalSystem enterprise opt-in that captures the installing user's home at install time.
- Never delete a legacy file that was not successfully migrated; never re-mint an identity or key that already exists at the legacy path.

## Non-Goals

- Moving `~/.deeplake/` (credentials, `onboarding.json`, projects bindings). It is a Deeplake-family surface and is explicitly unchanged by ADR-0003.
- Moving the per-project committed `.honeycomb/` folder inside user repos (for example nectar's `.honeycomb/nectars.json` projection). That is a shared family format committed to user repositories, not home-anchored runtime state.
- Removing the legacy `~/.honeycomb` fallback reads. The removal criterion (all supported install paths ship the migration) is a follow-up governed by the ADR's revisit trigger, not this PRD.
- Relocating the legacy credentials read-fallback at `~/.honeycomb/credentials.json`. That path is a legacy-compat surface by definition (the canonical store moved to `~/.deeplake/credentials.json` in PRD-023) and stays pointed at the legacy directory until the fallback itself is retired.
- doctor's own migration (registry file relocation, device-id ownership, install-id relocation), nectar's, and hive's. Those are parallel PRDs in their repos; this PRD covers only honeycomb's side and its write-side compatibility with doctor's window.
- Any change to Deeplake storage, memory pipelines, or the daemon's network surface.

---

## Code-grounded current state: the `~/.honeycomb` usage inventory

Every honeycomb-side `~/.honeycomb` dependency found by searching the src tree, grouped by disposition.

### Moves to `~/.apiary/honeycomb/` (honeycomb-owned runtime state)

| # | State family | Current code fact | New location |
|---|---|---|---|
| 1 | Daemon pid + lock | `LOCK_FILE_NAME = "daemon.lock"`, `PID_FILE_NAME = "daemon.pid"` under the runtime dir (`src/daemon/runtime/assemble.ts:192-195`); `resolveRuntimeDir` defaults to `join(homedir(), LEGACY_CREDENTIALS_DIR_NAME)` (`assemble.ts:711-713`); acquired/released at `assemble.ts:738-755,771-779`; the CLI resolves the same dir (`src/cli/runtime.ts:159-161`) and reads `daemon.pid` from it (`src/cli/runtime.ts:203`). | `~/.apiary/honeycomb/daemon.pid`, `daemon.lock` |
| 2 | Workspace fallback dir | `resolveWorkspaceBaseDir` falls back to `join(homedir(), ".honeycomb")` when the candidate workspace is unwritable (`assemble.ts:1384`); the CLI's `resolveDaemonWorkspace` uses `runtimeDir()` as its last-resort writable workspace (`src/cli/runtime.ts:172-179`). | `~/.apiary/honeycomb/` |
| 3 | Fleet telemetry SQLite | `fleetTelemetryDbPath` resolves `~/.honeycomb/telemetry/honeycomb.sqlite` (`src/daemon/runtime/telemetry/fleet-store.ts:57-59`), the PRD-071 Contract B store. | `~/.apiary/honeycomb/telemetry/honeycomb.sqlite` |
| 4 | Asset registry | `.honeycomb/registry.json` under home, the single source of truth for registered assets and pulled skills (`src/daemon/runtime/assets/registry.ts:150-152`; consumed at `src/commands/asset.ts:89,150` and via the skillify manifest adapter `src/daemon-client/skillify/manifest.ts:46-52`). | `~/.apiary/honeycomb/registry.json` |
| 5 | Skillify state | `~/.honeycomb/state/skillify/` (config, per-project watermarks, worker state: `src/daemon-client/skillify/config.ts:35`, `src/daemon/runtime/skillify/watermark.ts:36-38`, `worker.ts:253`, `miner.ts:657`). | `~/.apiary/honeycomb/state/skillify/` |
| 6 | Codebase graph cache + ignore set | `~/.honeycomb/graphs/<repo-key>/` (`src/daemon/runtime/codebase/api.ts:102-109`, `snapshot.ts:195-199`) and `~/.honeycomb/graph-ignore.json` (`discovery.ts:196-199`). | `~/.apiary/honeycomb/graphs/`, `graph-ignore.json` |
| 7 | Notifications state + claim locks | `~/.honeycomb/notifications-state.json` plus the `claims/` exclusive-create dir (`src/notifications/state.ts:41-43,50-52,133-135`), also used by the hooks pipeline (`src/hooks/runtime.ts:288`). | `~/.apiary/honeycomb/notifications-state.json`, `claims/` |
| 8 | Secrets machine key | The generate-once fallback key at `~/.honeycomb/.machine-key`, mode 0600 (`src/daemon/runtime/secrets/contracts.ts:228`, `store.ts:109,161,181`). Moving this file wrong makes existing `.secrets/` blobs undecryptable. | `~/.apiary/honeycomb/.machine-key` |

### Moves to the fleet root `~/.apiary/` (fleet-shared, doctor-managed; honeycomb reads/writes per contract)

| # | Surface | Current code fact | New posture |
|---|---|---|---|
| 9 | doctor registry entry | Honeycomb upserts its own entry into `~/.honeycomb/doctor.daemons.json` (`doctorRegistryPath`, `src/daemon/runtime/telemetry/fleet-registry.ts:35-37`), called from install (`src/commands/install.ts:48,366`). The entry carries literal un-expanded strings `HONEYCOMB_REGISTRY_PID_PATH = "~/.honeycomb/daemon.pid"` (`fleet-registry.ts:60`) and `HONEYCOMB_REGISTRY_TELEMETRY_DB_PATH = "~/.honeycomb/telemetry/honeycomb.sqlite"` (`fleet-registry.ts:66`). | Honeycomb writes its entry into `~/.apiary/registry.json` (doctor owns the file); the literal `pidPath`/`telemetryDbPath` strings change to the `~/.apiary/...` equivalents, following doctor's compatibility window (sub-PRD 072c). |
| 10 | Shared device id | `~/.honeycomb/device.json`, minted beside `.machine-key` (`src/daemon/runtime/assets/device.ts:40-45`), read by hooks for the per-device asset pull identity (`src/hooks/shared/session-start-seams.ts:43,102,197`). ADR-0003 makes this a fleet-root shared file. | Reads/mints at `~/.apiary/device.json` with legacy fallback; doctor manages the file long-term. |
| 11 | Shared install id | Honeycomb src has NO read site for `~/.honeycomb/install-id` today: its telemetry `distinct_id` is the `installId` inside `~/.deeplake/onboarding.json` (`src/daemon/runtime/onboarding/onboarding-store.ts:50,104-108`; `src/daemon/runtime/telemetry/emit.ts:470-471`). The `~/.honeycomb/install-id` file is written by the superproject one-line installer. | No honeycomb code change required for the relocation to `~/.apiary/install-id` itself; documented posture only (sub-PRD 072c), with an open question on whether honeycomb telemetry should adopt the fleet id. |

### Stays where it is (explicitly out of scope)

- The legacy credentials read-fallback `~/.honeycomb/credentials.json` (`src/hooks/shared/credential-reader.ts:53`, `src/daemon/runtime/auth/credentials-store.ts:71`, `src/daemon/storage/config.ts:131,139`, logout cleanup at `src/cli/auth.ts:76,311`). Canonical credentials are `~/.deeplake/credentials.json`; the legacy fallback keeps reading the legacy path.
- `~/.deeplake/` in full: credentials, `onboarding.json` (install id, telemetry ledger), projects bindings.
- The per-project committed `.honeycomb/` folder inside user repos (shared family format; for example nectar's `.honeycomb/nectars.json` projection).

### Special cases

- **The agent-facing memory mount path convention.** The VFS presents memory as a directory at `~/.honeycomb/memory/` (`src/daemon-client/vfs/fs.ts:4`, `classify.ts:20-22`, `index-gen.ts:5`), and the pre-tool-use hook classifies paths by the `.honeycomb/memory` shape (`src/hooks/shared/pre-tool-use.ts:147,166`). This is a virtual path contract visible to agents, not on-disk state. DEFAULT - confirm before implementation: recognize BOTH `.apiary/honeycomb/memory` and `.honeycomb/memory` path shapes in classification, and switch generated text (the index overview) to the new path; do not break agents holding the old path shape.
- **Honeycomb reads nectar's config.** `~/.honeycomb/nectar.json` is read fail-soft for the recall RRF multiplier (`src/daemon/runtime/memories/nectar-recall-config.ts:39-42,67`). After nectar's parallel migration that file lives at `~/.apiary/nectar/nectar.json`. Honeycomb's read must follow (new path first, legacy fallback), coordinated with nectar's PRD (sub-PRD 072b).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-072a-shared-root-helper-and-runtime-dir`](./prd-072a-apiary-state-root-migration-shared-root-helper-and-runtime-dir.md) | The `src/shared/` fleet-root helper (precedence chain, home-anchored, never cwd), the runtime-dir cutover (pid/lock/workspace fallback), the one-time migration bootstrap, and pid/lock continuity across the upgrade boot | Draft |
| [`prd-072b-state-family-migration`](./prd-072b-apiary-state-root-migration-state-family-migration.md) | The per-family migration long tail: telemetry SQLite, asset registry, skillify state, graph cache + ignore set, notifications state + claims, machine key (move-not-remint), the memory-mount path convention, and the nectar.json read | Draft |
| [`prd-072c-fleet-shared-surface-writes`](./prd-072c-apiary-state-root-migration-fleet-shared-surface-writes.md) | Fleet-root surfaces: the doctor registry-entry write relocation with doctor's compatibility window, the literal `pidPath`/`telemetryDbPath` string updates, device.json relocation with legacy fallback, and the install-id posture | Draft |
| [`prd-072d-service-units-and-installer-pinning`](./prd-072d-apiary-state-root-migration-service-units-and-installer-pinning.md) | Pinning `APIARY_HOME` into launchd/systemd/schtasks units, XDG precedence alignment with the existing detection in `src/cli/daemon-service.ts`, the Windows LocalSystem install-time home capture, and installer coordination | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a fresh install with no legacy `~/.honeycomb` state, when the daemon boots, then all honeycomb runtime state is created under `~/.apiary/honeycomb/` and nothing honeycomb-owned is created under `~/.honeycomb/`. |
| AC-2 | Given an existing install with legacy state and no `~/.apiary/honeycomb/`, when the upgraded daemon first boots, then a one-time migration moves (or copies then marks) each legacy state family into the new layout, and a second boot performs no further migration work (idempotent). |
| AC-3 | Given a legacy file fails to migrate (unreadable, locked, copy error), when migration completes, then that legacy file is NOT deleted, the failure is logged, and reads of that family fall back to the legacy path (additive, never destructive). |
| AC-4 | Given a daemon of the previous version is RUNNING with a live lock at `~/.honeycomb/daemon.lock`, when the upgraded daemon starts, then it detects the live legacy lock and refuses to double-bind port 3850, exactly as `acquireSingleInstanceLock` refuses today for a live lock at the current path (`src/daemon/runtime/assemble.ts:738-746`). |
| AC-5 | Given every product resolves the fleet root, when `APIARY_HOME` is set, or the installer `--home=` flag was recorded, or `$XDG_STATE_HOME` applies on Linux, then honeycomb resolves the identical root the ADR precedence chain defines, from one shared helper, anchored on `os.homedir()` and never `process.cwd()`. |
| AC-6 | Given honeycomb installs or upgrades, when the doctor registry entry is written, then it lands per doctor's compatibility window (new `~/.apiary/registry.json` location once doctor reads it), and the entry's `pidPath` and `telemetryDbPath` strings agree with where honeycomb ACTUALLY writes those files at that moment in the window. |
| AC-7 | Given existing `.secrets/` blobs encrypted with the fallback machine key, when migration moves `~/.honeycomb/.machine-key` to `~/.apiary/honeycomb/.machine-key`, then the key bytes are preserved (moved, never re-minted) and every existing secret remains decryptable; if the move fails, the store keeps reading the legacy key path. |
| AC-8 | Given a service-launched daemon (launchd, systemd --user, or schtasks), when the unit starts the daemon, then the resolved fleet root is pinned into the service environment so the daemon resolves the same root the installing CLI resolved, including the Windows LocalSystem opt-in capturing the installing user's home at install time. |
| AC-9 | Given the migration ran, when an operator inspects `~/.apiary/`, then honeycomb state is only inside `~/.apiary/honeycomb/` plus honeycomb's own entry in the fleet-root registry: honeycomb never writes into another product's subdirectory. |
| AC-10 | Given `~/.deeplake/` and per-repo committed `.honeycomb/` folders, when the migration runs, then neither is touched. |

---

## Migration mechanics (the contract all sub-PRDs implement)

Per the ADR's migration section, plus honeycomb-specific hardening because honeycomb is the product most likely to have live state on real installs:

1. **Trigger:** first boot (daemon assembly or CLI verb that touches state) of a build that ships this PRD. The migration runs before any state-family store initializes.
2. **Idempotence marker:** a `migration.json` bookkeeping file inside `~/.apiary/honeycomb/` records which families migrated and when. Presence of a family's completed entry skips it forever. (Runtime bookkeeping, not durable app state; FR-8 is not implicated.)
3. **Per-family move:** if the new path is absent and the legacy path exists, copy then atomically rename into place, then mark. Never delete a legacy file that did not successfully land at the new path. The machine key is byte-preserved, never re-minted (AC-7).
4. **Legacy-fallback reads:** every reader resolves new-path-first, legacy-path-second, for the whole compatibility window. A partially migrated machine never loses pid/lock/registry/key continuity.
5. **The upgrade-boot single-instance sequence (the live-daemon case):**
   1. Resolve the fleet root and the new runtime dir.
   2. Check the NEW lock; if a live pid holds it, refuse (unchanged semantics).
   3. Check the LEGACY lock at `~/.honeycomb/daemon.lock`; if a live pid holds it, refuse with the same `DaemonAlreadyRunningError` so an in-place upgrade never double-binds while the old daemon still runs (AC-4).
   4. Only when neither lock is live: acquire the lock at the NEW path, then run the state migration.
   5. During the compatibility window, also stamp the legacy pid file with the same pid (DEFAULT - confirm before implementation) so an old doctor or an operator's `cat ~/.honeycomb/daemon.pid` still resolves the live process; shutdown removes both.
6. **What never migrates:** anything in the "stays where it is" table above.

---

## Files expected to change

| File | Expected change |
|---|---|
| `src/shared/` (new module, for example `src/shared/fleet-root.ts`) | The single fleet-root helper: precedence chain, `~/.apiary` default from `os.homedir()`, per-product subdir join, legacy-dir resolution for fallbacks. Tier 1 so every target imports it without upward imports. |
| `src/daemon/runtime/assemble.ts` | `resolveRuntimeDir` (line 711) and the workspace fallback (line 1384) resolve through the helper; `acquireSingleInstanceLock` grows the legacy-lock liveness check; the migration bootstrap runs at assembly. |
| `src/cli/runtime.ts` | `runtimeDir()` (line 159) and `resolveDaemonWorkspace()` (line 172) resolve through the helper; pid reads (line 203) fall back to the legacy path during the window. |
| `src/daemon/runtime/telemetry/fleet-store.ts` | `fleetTelemetryDbPath` (line 57) resolves under the new subdir with migration of the existing SQLite file. |
| `src/daemon/runtime/telemetry/fleet-registry.ts` | `doctorRegistryPath` (line 35) targets the fleet-root registry per doctor's window; the literal `pidPath`/`telemetryDbPath` constants (lines 60, 66) change in lockstep with where those files actually live. |
| `src/daemon/runtime/assets/registry.ts`, `src/commands/asset.ts`, `src/daemon-client/skillify/manifest.ts` | The asset-registry base dir (registry.ts line 150) resolves through the helper with legacy fallback. |
| `src/daemon-client/skillify/config.ts`, `src/daemon/runtime/skillify/watermark.ts`, `worker.ts`, `miner.ts` | The skillify state root moves under the new subdir with migration. |
| `src/daemon/runtime/codebase/api.ts`, `snapshot.ts`, `discovery.ts` | Graph cache base and ignore-set path move under the new subdir. |
| `src/notifications/state.ts` | State dir (line 135) resolves through the helper with migration of `notifications-state.json` and `claims/`. |
| `src/daemon/runtime/secrets/store.ts`, `contracts.ts` | Machine-key path moves with byte-preserving migration and legacy-read fallback. |
| `src/daemon/runtime/assets/device.ts` | Device store base dir (line 42) targets the fleet root with legacy fallback. |
| `src/daemon/runtime/memories/nectar-recall-config.ts` | Reads `~/.apiary/nectar/nectar.json` first, legacy second. |
| `src/daemon-client/vfs/classify.ts`, `index-gen.ts`, `src/hooks/shared/pre-tool-use.ts` | Dual path-shape recognition for the memory mount; generated index text emits the new path. |
| `src/cli/daemon-service.ts` | Unit templates pin the resolved root (env) alongside the existing `HONEYCOMB_WORKSPACE` pinning (plist lines 264-270, systemd lines 297-299, schtasks line 350); Linux precedence aligns with the existing XDG detection (lines 102-106). |
| `src/commands/install.ts` | Install-time registry write follows the window (line 366); the LocalSystem home capture threads through. |
| `tests/` (mirrors of the above) | Migration idempotence, additive-never-destructive, legacy-lock refusal, machine-key byte preservation, precedence-chain resolution, dual pid stamping, unit-template pinning. |

---

## Test plan

- Unit: the helper resolves each precedence step exactly (`APIARY_HOME` > `--home=` config > XDG on Linux > `~/.apiary`), from `os.homedir()`, ignoring `process.cwd()` (AC-5).
- Unit: fresh boot on a temp HOME creates state only under `~/.apiary/honeycomb/` (AC-1); a seeded legacy layout migrates each family once, and a second boot is a no-op (AC-2).
- Unit: an injected copy failure leaves the legacy file in place, marks the family failed, and reads fall back (AC-3).
- Unit: a live pid in the LEGACY lock file makes the upgraded boot throw `DaemonAlreadyRunningError` (AC-4); a stale legacy lock is reclaimed and migration proceeds.
- Unit: machine-key migration preserves bytes; a secret encrypted pre-migration decrypts post-migration (AC-7).
- Unit: registry-entry `pidPath`/`telemetryDbPath` strings always match the paths the same build actually writes (AC-6 coherence).
- Unit: rendered launchd/systemd/schtasks units carry the pinned root env var; the schtasks metacharacter guard still rejects poisoned paths (AC-8).
- Integration (packaged upgrade smoke, mirroring `scripts/local-queue-packaged-upgrade-smoke.mjs`): install old build, start daemon, upgrade in place, confirm no double-start, stop, reboot new build, confirm state landed under the new root and legacy files that migrated are gone while unmigrated ones remain.
- Live proof: on a real machine with an existing `~/.honeycomb`, upgrade, verify `honeycomb status`, doctor probing, asset list, skillify state, graph cache, and secrets all keep working, then inspect `~/.apiary/` layout (AC-9, AC-10).

---

## Open questions

- [ ] **Dual pid stamping during the window** (migration mechanics step 5.5): also writing the legacy pid file keeps old doctors and operator muscle memory working, at the cost of a lingering legacy artifact. DEFAULT: dual-stamp while the compatibility window is open; confirm with doctor's PRD owner.
- [x] **Registry write target mid-window:** RESOLVED per the fleet ADR's "Resolved decisions" registry compatibility window contract (confirmed 2026-07-04): honeycomb writes its entry to `~/.apiary/registry.json` when the fleet root directory exists, otherwise to the legacy `~/.honeycomb/doctor.daemons.json`; it never dual-writes. Doctor's reader handles the merge (new wins per daemon `name`, legacy-only entries merge additively). The earlier mirror-to-legacy default is superseded.
- [ ] **Memory-mount path shape** (special cases above): confirm dual recognition plus new-path emission, versus keeping `.honeycomb/memory` as a frozen agent-facing namespace indefinitely. DEFAULT: dual recognition, emit new path.
- [ ] **Install-id adoption:** honeycomb's telemetry `distinct_id` today is the `~/.deeplake/onboarding.json` `installId`, not the fleet `install-id` file. Should honeycomb consolidate onto the fleet-root `~/.apiary/install-id` once doctor manages it, or keep the onboarding-store id? DEFAULT: no change in this PRD; document the posture and revisit with the fleet telemetry consolidation.
- [ ] **`HONEYCOMB_WORKSPACE` fallback semantics:** the unwritable-workspace fallback currently lands secrets/logs/agent.yaml in `~/.honeycomb` (`assemble.ts:1384`). Moving the fallback to `~/.apiary/honeycomb/` is assumed here; confirm no operator depends on the old fallback location for `agent.yaml` discovery.
- [ ] **Env var naming:** `APIARY_HOME` per the ADR. If the fleet root name were ever re-litigated, the helper is the single place the name lives in honeycomb; confirm no additional honeycomb-specific override (for example `HONEYCOMB_RUNTIME_DIR`) is wanted for test seams beyond the existing injectable `runtimeDir` option (`assemble.ts:278`).

---

## Related

- Fleet ADR (local mirror): [`0008-fleet-directory-ownership-and-neutral-state-root.md`](../../../knowledge/private/architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md); authoritative copy is superproject `ADR-0003-fleet-directory-ownership-and-neutral-state-root.md`.
- [PRD-071: Service Check-in and SQLite Telemetry](../prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md): the registry entry and telemetry SQLite whose paths this PRD relocates.
- PRD-023 (completed): moved credentials to `~/.deeplake/` and deliberately kept the runtime dir at `~/.honeycomb` (`src/daemon/runtime/assemble.ts:197-200`); this PRD completes that story under the neutral root.
- PRD-064 (in-work): the service-unit hardening (`src/cli/daemon-service.ts`) this PRD extends with root pinning.
- Parallel PRDs (cross-repo coordination): doctor (owns the shared-surface relocation, the registry compatibility window, and device/install-id management), nectar (its `~/.apiary/nectar/` migration, including `nectar.json` this repo reads), and hive (its `~/.apiary/hive/` migration and its reference registry writer `hive/src/install/registry.ts` that `fleet-registry.ts` mirrors).
