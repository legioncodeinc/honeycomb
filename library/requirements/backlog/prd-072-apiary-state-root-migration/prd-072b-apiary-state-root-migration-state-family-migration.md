# PRD-072b: Per-Family State Migration (the Long Tail)

> **Parent:** [PRD-072](./prd-072-apiary-state-root-migration-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None. On-disk relocation of seven honeycomb-owned state families into `~/.apiary/honeycomb/`, each registered as a mover in 072a's bootstrap, each with a legacy-fallback read.

---

## Goals

Move every honeycomb-owned state family (beyond pid/lock, which 072a owns) from `~/.honeycomb/` to `~/.apiary/honeycomb/`, without losing a byte of operator data: the telemetry SQLite doctor polls, the asset registry that is the single source of truth for pulled skills, the skillify watermarks, the graph caches, the notifications ledger and claim locks, and (most delicately) the secrets machine key whose bytes gate every existing encrypted secret. Also follow nectar's parallel move for the one nectar-owned file honeycomb reads, and settle the agent-facing memory-mount path shape.

## Scope

Each family below gets: (1) its default path resolved through 072a's helper, (2) a registered mover in the bootstrap, (3) a new-path-first legacy-second read while the window is open.

| Family | Source of truth today | Mover notes |
|---|---|---|
| Fleet telemetry SQLite | `fleetTelemetryDbPath` -> `~/.honeycomb/telemetry/honeycomb.sqlite` (`src/daemon/runtime/telemetry/fleet-store.ts:57-59`) | Move the `.sqlite` file plus WAL/SHM siblings atomically while no daemon holds it open (the bootstrap runs before the store opens). The registry `telemetryDbPath` string must flip in the same release (072c coherence). |
| Asset registry | `~/.honeycomb/registry.json` (`src/daemon/runtime/assets/registry.ts:150-152`; readers at `src/commands/asset.ts:89,150`, `src/daemon-client/skillify/manifest.ts:46-52`) | Single JSON file; move-and-mark. The skillify manifest adapter already migrated a legacy file once (`src/daemon-client/skillify/migrate-manifest.ts:7-8`); reuse that pattern's tolerance. |
| Skillify state | `~/.honeycomb/state/skillify/` (`src/daemon-client/skillify/config.ts:35`, `src/daemon/runtime/skillify/watermark.ts:36-38`, `worker.ts:253`, `miner.ts:657`) | Recursive dir move (config.json, per-project watermark dirs). Watermark loss is not data loss but forces re-mining; the mover treats partial copies as failed (legacy retained). |
| Graph cache + ignore set | `~/.honeycomb/graphs/<repo-key>/` (`src/daemon/runtime/codebase/api.ts:102-109`, `snapshot.ts:195-199`); `~/.honeycomb/graph-ignore.json` (`discovery.ts:196-199`) | The cache is regenerable; DEFAULT - confirm before implementation: do NOT copy `graphs/` (rebuild at the new path lazily), but DO move `graph-ignore.json` (user-edited, not regenerable). |
| Notifications state + claims | `~/.honeycomb/notifications-state.json` + `claims/` (`src/notifications/state.ts:41-43,50-52,133-135`; hooks wiring `src/hooks/runtime.ts:288`) | Move the state file; claim files are transient session artifacts, safe to leave behind (they expire by design, `state.ts:5-8`). |
| Secrets machine key | `~/.honeycomb/.machine-key`, mode 0600 (`src/daemon/runtime/secrets/contracts.ts:228`, `store.ts:109,161,181`) | BYTE-PRESERVING move, never re-mint: a fresh key at the new path silently orphans every `.secrets/` blob. On any doubt the mover marks failed and the store keeps reading the legacy path. Preserve 0600/0700 modes on POSIX. |
| nectar.json read | `~/.honeycomb/nectar.json` read fail-soft (`src/daemon/runtime/memories/nectar-recall-config.ts:39-42,67`) | Honeycomb does NOT move this file (nectar owns it); the read resolves `~/.apiary/nectar/nectar.json` first, legacy second, coordinated with nectar's parallel PRD. |

Plus the memory-mount path convention: dual recognition of `.apiary/honeycomb/memory` and `.honeycomb/memory` shapes in `src/daemon-client/vfs/classify.ts:20-22` and `src/hooks/shared/pre-tool-use.ts:147,166`; generated overview text (`src/daemon-client/vfs/index-gen.ts:5`) emits the new shape (DEFAULT per the index open question).

## Out of scope

- pid/lock and the bootstrap machinery (072a).
- doctor registry entry, device.json, install-id (072c).
- The legacy credentials fallback (`~/.honeycomb/credentials.json`), which stays legacy by design.
- Deleting legacy directories wholesale; only successfully-moved files are removed, and `~/.honeycomb/` itself is left in place until the fleet-wide window closes.

---

## User stories and acceptance criteria

### US-072b.1 - No operator data is lost

- AC-072b.1.1 Given a legacy install with a populated telemetry SQLite, asset registry, skillify state, graph-ignore.json, notifications state, and machine key, when migration runs, then every family is readable at the new path with identical content (byte-identical for the machine key).
- AC-072b.1.2 Given any family's mover fails, when the boot completes, then the legacy file is untouched, reads of that family come from the legacy path, and every other family is unaffected.
- AC-072b.1.3 Given a secret stored before migration, when it is read after migration, then it decrypts (AC-7 of the index).

### US-072b.2 - Doctor keeps polling through the move

- AC-072b.2.1 Given doctor polls the telemetry SQLite path advertised in its registry entry, when honeycomb migrates the SQLite file, then the same release updates the advertised `telemetryDbPath` (072c) so the path doctor reads and the file honeycomb writes never disagree for a full release.

### US-072b.3 - Agents keep resolving memory paths

- AC-072b.3.1 Given an agent holds a legacy `~/.honeycomb/memory/...` path shape, when the pre-tool-use hook classifies it, then it still resolves to the mount (dual recognition).
- AC-072b.3.2 Given a fresh index overview is generated, when an agent reads it, then paths use the new `~/.apiary/honeycomb/memory/` shape.

### US-072b.4 - nectar's config follows nectar

- AC-072b.4.1 Given nectar has migrated and `~/.apiary/nectar/nectar.json` exists, when honeycomb resolves the RRF multiplier, then the new path wins; absent it, the legacy `~/.honeycomb/nectar.json` is read; absent both, the fail-soft default (`nectar-recall-config.ts:67-69`) applies unchanged.

---

## Technical considerations

- Ordering inside the bootstrap: the machine key and asset registry migrate before any store that would lazily create them; the telemetry SQLite migrates before `fleet-store.ts` opens it (072a guarantees bootstrap-before-stores).
- The graphs decision (rebuild versus copy) trades one-time re-index cost against copying a potentially large cache dir; the DEFAULT (rebuild lazily) matches the existing self-healing posture of the snapshot cache (`src/daemon/runtime/codebase/cache.ts:30,58`).
- Tests inject temp dirs through each store's existing seam (`registry.ts`, `state.ts`, `device.ts`, `watermark.ts` all already take injectable base dirs); no new global test hooks.

## Test plan

- Per-family round-trip: seed legacy, migrate, assert content at new path and marker entry; re-run, assert no-op.
- Failure injection per family (unreadable source, unwritable target): legacy intact, fallback read works, other families migrate.
- Machine-key byte identity plus decrypt-after-migrate proof.
- Path-shape matrix for classify/pre-tool-use covering both shapes and the test-mount shape.
- nectar.json precedence: new-only, legacy-only, both (new wins), neither (default).
