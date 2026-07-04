# PRD-072c: Fleet-Shared Surface Writes (Registry Entry, Device Id, Install Id)

> **Parent:** [PRD-072](./prd-072-apiary-state-root-migration-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None. Honeycomb's writes to fleet-shared files relocate to the fleet root `~/.apiary/` per doctor's compatibility window; honeycomb does not own those files.

---

## Goals

Move honeycomb's participation in the fleet-shared coordination surface to the fleet root, respecting the ADR ownership split: doctor manages `registry.json`, `device.json`, and `install-id`; honeycomb WRITES its own registry entry there, reads/mints the device id there with a legacy fallback, and needs no code for the install-id relocation (it has no read site today). The hard requirement is write-side coherence with doctor's compatibility window: at every moment in the window, the paths honeycomb advertises in its registry entry must match the paths honeycomb actually writes.

## Scope

- **Registry entry relocation.** `doctorRegistryPath` (`src/daemon/runtime/telemetry/fleet-registry.ts:35-37`) targets `~/.apiary/registry.json` per doctor's window. The upsert shape (read-tolerant, replace-by-name, atomic temp-file rename, mirroring hive's `hive/src/install/registry.ts` per `fleet-registry.ts:11-16`) is unchanged. Mid-window behavior follows the fleet ADR's registry compatibility window contract (RESOLVED 2026-07-04): write to `~/.apiary/registry.json` when the fleet root exists, else the legacy file; never dual-write; doctor's reader merges (new wins per `name`, legacy-only merges additively). The install-time call site is `src/commands/install.ts:366`.
- **Advertised path strings.** The literal un-expanded constants `HONEYCOMB_REGISTRY_PID_PATH = "~/.honeycomb/daemon.pid"` (`fleet-registry.ts:60`) and `HONEYCOMB_REGISTRY_TELEMETRY_DB_PATH = "~/.honeycomb/telemetry/honeycomb.sqlite"` (`fleet-registry.ts:66`) flip to the `~/.apiary/...` equivalents in the SAME release that 072a moves the pid and 072b moves the SQLite, preserving the documented invariant that the advertised string and `fleetTelemetryDbPath` name the same on-disk file (`fleet-registry.ts:18-24`). Note the ADR root override wrinkle: these are literal `~`-strings doctor expands; when `APIARY_HOME` overrides the root, the advertised string must reflect the RESOLVED root, not the literal default (DEFAULT - confirm with doctor's PRD whether the registry contract carries resolved absolute paths or stays `~`-literal with doctor applying the same override).
- **Device id.** `deviceDirPath`/`device.json` (`src/daemon/runtime/assets/device.ts:40-45`) resolves to the fleet root `~/.apiary/device.json` with a legacy-fallback read of `~/.honeycomb/device.json`; an existing legacy id is migrated (moved), never re-minted, so the per-device asset-pull identity (`src/hooks/shared/session-start-seams.ts:43,102,197`) is stable across the migration. Long-term ownership transfers to doctor; honeycomb keeps read/mint-if-absent semantics until doctor's PRD lands its management.
- **Install id.** Documentation-only: honeycomb has no read site for `~/.honeycomb/install-id` (its telemetry `distinct_id` is the onboarding-store `installId` in `~/.deeplake/onboarding.json`, `src/daemon/runtime/onboarding/onboarding-store.ts:50,104-108`, `src/daemon/runtime/telemetry/emit.ts:470-471`). The file's relocation to `~/.apiary/install-id` is installer/doctor work. This sub-PRD records the posture and the adoption open question; it ships no install-id code.

## Out of scope

- Owning, creating, or garbage-collecting `registry.json`, `device.json`, or `install-id` (doctor's parallel PRD).
- The registry entry's non-path fields (health URL, probe intervals; unchanged from PRD-071a).
- The onboarding store or any `~/.deeplake/` file.

---

## User stories and acceptance criteria

### US-072c.1 - Doctor finds honeycomb at the fleet root

- AC-072c.1.1 Given the window permits new-path writes, when install or upgrade runs, then honeycomb's entry is upserted into `~/.apiary/registry.json` idempotently (replace-by-name, atomic), and, while the mirror DEFAULT stands, into the legacy `~/.honeycomb/doctor.daemons.json` with identical content.
- AC-072c.1.2 Given a registry write fails (locked file, unwritable root), when install runs, then the failure is fail-soft exactly as today (`src/commands/install.ts:216-224`): install completes and the error is reported, never thrown.

### US-072c.2 - Advertised paths never lie

- AC-072c.2.1 Given any release in the window, when doctor expands the entry's `pidPath` and `telemetryDbPath`, then the files at those paths are the ones this honeycomb build actually writes (pid via 072a, SQLite via 072b), verified by a coherence test importing both constants and both resolvers.
- AC-072c.2.2 Given `APIARY_HOME` overrides the root, when the entry is written, then the advertised paths resolve to files under the overridden root per the contract confirmed with doctor.

### US-072c.3 - The device identity survives the move

- AC-072c.3.1 Given a legacy `~/.honeycomb/device.json`, when migration runs, then the SAME `device_id` is readable at `~/.apiary/device.json` and hooks report an unchanged device identity.
- AC-072c.3.2 Given neither path has a device record, when one is needed, then it is minted at the fleet root only.

---

## Technical considerations

- The registry mirror write reuses the existing `RegistryFs` seam (`fleet-registry.ts:69-75`) so tests drive both targets with the in-memory fake.
- `device.ts` documents that `device.json` sits BESIDE `.machine-key` (`device.ts:9`); after this PRD they separate (device.json at the fleet root, machine key in the honeycomb subdir per 072b). Update the module docs so the co-location claim does not go stale.
- Sequencing with doctor: honeycomb must not write `~/.apiary/registry.json` before doctor's reader knows to look there, unless the mirror DEFAULT stands (in which case early new-path writes are harmless). Land after doctor's window contract is published; the mirror makes honeycomb's side order-independent.

## Test plan

- Upsert-to-both-targets: identical entries, replace-by-name on re-install, atomic rename observed via the fake fs.
- Fail-soft registry write per AC-072c.1.2 (mirrors the existing install.ts test posture, `tests/commands/install.test.ts`).
- Path-coherence test per AC-072c.2.1 tying `HONEYCOMB_REGISTRY_PID_PATH`/`HONEYCOMB_REGISTRY_TELEMETRY_DB_PATH` to 072a/072b resolvers.
- Device-id stability: legacy migrate keeps the id; fresh mint lands at the fleet root; hooks seam sees one stable id across the move.
