# 0008, give the fleet a neutral home-anchored state root and split per-product state from shared coordination

> **MIRROR - not the authoritative copy.** This is a synced copy of the superproject (the-apiary) fleet-wide ADR, placed in honeycomb so the decision is visible when working inside this submodule. Authoritative source: `library/knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md` in the superproject. Edit the authoritative copy, then re-sync this mirror; do not edit this copy in isolation. (Numbered `0008` here to fit honeycomb's local ADR sequence; it is superproject `ADR-0003`.)

**Status:** Accepted (superproject ADR-0003) · **Date:** 2026-07-04
**Owners:** platform, doctor, honeycomb, nectar, hive

## Resolved decisions (confirmed 2026-07-04)

The three decisions this ADR left open are now resolved. These resolutions are **normative**: the four per-repo migration PRDs (doctor PRD-004, honeycomb PRD-072, nectar PRD-020, hive PRD-010) cite this section rather than restating it, so there is exactly one source of truth.

**1. Root name: `~/.apiary/`.** Confirmed over the supervisor-branded `~/.doctor/` alternative.

**2. XDG precedence: honor `$XDG_STATE_HOME` only when it is explicitly set; the default is `<homedir>/.apiary` on every OS, including Linux.** There is no `~/.local/state/apiary` default. Rationale: the fleet's support story depends on "inspect one directory" being true everywhere, and both existing precedents (`~/.deeplake`, the legacy `~/.honeycomb`) are dotfiles in home; honoring XDG when explicitly set still respects users who deliberately configured it. The chain is purely environmental and deterministic: no product ever scans the disk for existing roots to decide precedence, and a user who changes `$XDG_STATE_HOME` after install is handled by the same legacy-fallback read as any other move.

The canonical resolution chain every product implements (mirrored, never imported):

```
resolveFleetRoot(env, platform, home = os.homedir()):
  1. env.APIARY_HOME set, non-blank, and ABSOLUTE -> APIARY_HOME
     (the installer's --home= pin is delivered as APIARY_HOME in the service environment;
      the installer resolves a relative --home= against ITS cwd at capture time)
  2. platform is linux AND env.XDG_STATE_HOME set, non-blank, and ABSOLUTE
                                                  -> join(XDG_STATE_HOME, "apiary")
  3. otherwise                                    -> join(home, ".apiary")
```

Security amendment (2026-07-04, from the W3 security audits): env roots are honored ONLY when absolute; a relative value is ignored and the chain falls through. Honoring a relative value would anchor the fleet root, and everything derived from it (machine keys, trust roots, registry pidPaths), on `process.cwd()`, the exact footgun this ADR exists to prevent; the XDG Base Directory spec likewise requires ignoring relative values. Absoluteness is checked with `path.win32.isAbsolute` (a strict superset of the posix check) so a relative value is never mistaken for absolute on any host.

Per-product state is `resolveFleetRoot() + "/<product>"`; the shared surface (registry.json, device.json, install-id) sits at the root itself.

**3. The registry compatibility window contract.** One contract, stated once, binding all four repos during the migration window:

- **Ownership:** doctor creates `~/.apiary/` and migrates `~/.honeycomb/doctor.daemons.json` -> `~/.apiary/registry.json` during its own migration boot. doctor is the only product that migrates the shared file.
- **Write side (every product's installer):** write your registry entry to `~/.apiary/registry.json` when the fleet root directory exists; otherwise write to the legacy `~/.honeycomb/doctor.daemons.json`. Deterministic, no cross-product coordination required at write time.
- **Read side (doctor):** read new-first. When both files exist, the new file wins per daemon `name`; legacy-only entries merge additively. doctor never writes merged results back to the legacy file.
- **Window close:** the legacy fallback (read side and write side) is removed only when every supported install path ships its migration. That removal is the close-out gate tracked in the superproject execution ledger (`library/ledger/EXECUTION_LEDGER-apiary-state-root.md`).

## Context

The Apiary is four separately-installable products that run as a coordinated local fleet: **doctor** (the supervisor + cross-daemon registry), **hive** (the always-on portal/dashboard), and **honeycomb** + **nectar** (the workloads). Every one of them roots its on-disk state at `~/.honeycomb`:

- doctor's cross-daemon registry: `~/.honeycomb/doctor.daemons.json` (`doctor/src/registry.ts:105`).
- doctor's own workspace + install lock + device id: `~/.honeycomb/doctor/`, `~/.honeycomb/device.json` (`doctor/src/config.ts:154`, `doctor/src/device-id.ts:7`).
- the "primary daemon" pid doctor supervises: `~/.honeycomb/daemon.pid` (`doctor/src/registry.ts:118`).
- nectar's pid, lock, `nectar.json`, `pending-reviews.json`, telemetry SQLite, usage-telemetry state: all under `~/.honeycomb` via `RUNTIME_DIR_NAME = ".honeycomb"` (`nectar/src/config.ts:15`), with the code comment stating it is "shared with honeycomb + doctor" (PRD-002d).
- the shared anonymous install id every product's telemetry reads: `~/.honeycomb/install-id`.

This is **path dependence, not design.** Honeycomb shipped first, `~/.honeycomb` became the shared home, and the three-daemon topology (nectar ADR-0003) expanded the fleet *after* that directory was already load-bearing. The result is a naming lie: the fleet's shared coordination surface (a registry owned by the *supervisor*, plus device id and install id used by *everyone*) lives inside a directory named after *one workload*. If honeycomb were uninstalled while nectar + hive remained, the whole fleet would still live in `~/.honeycomb`.

Two forcing functions surfaced the problem now:

1. **nectar PRD-019** introduced new nectar-owned state (per-project brooding on/off) and asked where it should live. Putting it in `~/.nectar/` while everything else stays in `~/.honeycomb/` scatters state across two locations without fixing the underlying naming issue.
2. **The activation regression** (nectar broods `process.cwd()`, which as an OS service is `$HOME` / `/` / `System32`) prompted a review of how directories are chosen at all. That regression is about the *brooding root* (`process.cwd()`), not the *state root*: state is anchored on `os.homedir()` (`nectar/src/config.ts:114`), which is deterministic and never inherits the working directory. The two must not be conflated.

Separately, `~/.deeplake/` already sets the precedent for a **brand-neutral shared family directory** (credentials + `projects.json` for all products), so a neutral shared root is consistent with an existing pattern rather than a novelty.

## Decision

**Introduce one brand-neutral, home-anchored fleet root and split per-product runtime state from the fleet-shared coordination surface underneath it.**

### The layout

```
~/.apiary/                      # the fleet root (home-anchored; NEVER cwd)
  registry.json                 # doctor's cross-daemon registry (was ~/.honeycomb/doctor.daemons.json)
  device.json                   # shared per-install device id
  install-id                    # shared anonymous install id (installer-written)
  doctor/                       # doctor's own runtime state (workspace, install lock)
  honeycomb/                    # honeycomb's runtime state (pid, lock, config, telemetry)
  nectar/                       # nectar's runtime state (pid, lock, nectar.json, pending-reviews, telemetry, brooding projects.json)
  hive/                         # hive's runtime state
```

- **One discoverable top-level directory** (the benefit that motivated a single `~/.honeycomb`) is preserved: an operator, uninstaller, or support script inspects/clears exactly `~/.apiary/`.
- **Each product owns its own subdirectory.** No product writes into another product's subdir. nectar's state (including PRD-019's brooding `projects.json`) lives at `~/.apiary/nectar/`, so nectar's on-disk state never depends on honeycomb being installed (satisfying nectar ADR-0002's independence requirement).
- **The shared coordination surface lives at the fleet root, not inside a product subdir.** The registry, device id, and install id are fleet-level. doctor (the supervisor) remains their manager and the single writer/reader of the registry contract, but the file is named for the fleet, not for doctor or honeycomb.
- **`~/.deeplake/` is unchanged.** Credentials and the folder-binding `projects.json` stay where they are; they are a Deeplake-family surface, orthogonal to the local fleet root.

### The root is home-anchored, selectable, and never cwd

- The default root is `<os.homedir()>/.apiary`. It is resolved from `os.homedir()`, **never** `process.cwd()`, so it does not inherit the service manager's working directory and cannot land in `System32` / `/` by that path.
- A single override selects a non-default location, resolved with one precedence chain across the fleet: **`APIARY_HOME` env var (the installer's `--home=` pin is delivered as `APIARY_HOME` in the service environment) > `$XDG_STATE_HOME/apiary` on Linux only when `$XDG_STATE_HOME` is explicitly set > `<home>/.apiary`.** There is no `~/.local/state` default. Every product resolves the root through one mirrored helper so the chain is identical everywhere (see Resolved decisions for the canonical chain).
- **Windows LocalSystem edge (enterprise opt-in only):** on the default Windows install, `os.homedir()` returns the real user profile (`C:\Users\<name>`), because nectar's default is a per-user Scheduled Task running as the logged-in user (`InteractiveToken`, `LeastPrivilege`; `nectar/src/service/platform.ts:15`, `templates.ts:152,178`). The `System32\config\systemprofile` result occurs ONLY under the LocalSystem account, i.e. the `sc.exe` Windows Service backend, which is an enterprise opt-in requiring `preferSystemScope` plus a privileged process, "never the userland default" (`platform.ts:16,178-204`). For that opt-in path only, the installer captures the *installing user's* home at install time and pins the resolved root into the service environment so state never lands under `System32`. The default per-user path already resolves correctly at runtime.

### Migration and back-compat

- On first boot after upgrade, each product performs a **one-time migration**: if its new `~/.apiary/<product>/` state is absent but the legacy `~/.honeycomb` equivalent exists, it moves (or copies then marks) the legacy files into the new layout. doctor migrates the registry `~/.honeycomb/doctor.daemons.json` -> `~/.apiary/registry.json`.
- Until migration completes, readers **fall back to the legacy `~/.honeycomb` location** when the new path is absent, so a partially-migrated fleet never loses its pid/lock/registry continuity.
- The migration is idempotent and additive; it never deletes a legacy file it did not successfully migrate.

## Consequences

**Positive.**

- **Honest ownership.** The fleet's shared coordination surface no longer lives under one workload's brand. Uninstalling any single product leaves the shared root and the other products intact and correctly named.
- **Clean product independence.** Each product owns exactly one subdirectory; nectar's state no longer implies honeycomb. This makes nectar ADR-0002's "separately installable" claim true on disk, not just in code.
- **One selectable home.** `APIARY_HOME` (plus XDG on Linux) lets a user or fleet administrator place all state on a chosen volume with one setting, and the single-root layout keeps discovery/uninstall trivial.
- **The cwd footgun is structurally impossible for state.** State resolves from `os.homedir()` through one helper; the `process.cwd()` path that caused the brooding regression is not in the state-resolution chain at all.

**Negative.**

- **A four-repo change with a migration.** doctor, honeycomb, nectar, and hive each hardcode `~/.honeycomb` in multiple places and must adopt the shared root helper and the one-time migration. This is the real cost and is why it is an ADR, not a single sub-PRD.
- **A migration window to get right.** The legacy-fallback read must stay until the fleet is confidently migrated; removing it prematurely would strand old installs. It is accepted as temporary debt with a defined removal criterion (all supported install paths ship the migration).
- **Cross-dialect installer work.** Pinning the resolved root into the service unit (and the Windows system-service user-home capture) touches `install.sh`, `install.ps1`, and each product's service templates.

**Reversibility.** Low-to-moderate. Once installs write to `~/.apiary/` and the registry moves, reverting would require a reverse migration. The legacy-fallback read makes the *forward* step safe; the *backward* step is deliberately not designed for, because reverting reintroduces the naming lie this ADR exists to remove.

## Revisit triggers

- The shared-root name was confirmed as `~/.apiary/` on 2026-07-04 (see Resolved decisions); if it ever changes, re-sync all mirrors and update every reference.
- The legacy-fallback read is removed once all supported install paths ship the migration; record that removal as the trigger to close the migration window.
- A new product joins the fleet (or the supervisor changes), which would add a subdirectory and revalidate the "who owns the shared root" reasoning.

## Alternatives considered and rejected

### Keep everything in `~/.honeycomb` (REJECTED)

Leave the shared root as-is and put new nectar state there too. Rejected because it entrenches the naming lie (the fleet's shared registry living under one workload's brand) and blocks the clean per-product independence nectar ADR-0002 calls for. It is the zero-cost option, but it is the option this ADR exists to end.

### Supervisor-branded root `~/.doctor/` (REFINED INTO THE NEUTRAL ROOT)

Put the shared registry and coordination under `~/.doctor/`, since doctor owns the registry and supervises the fleet. This is a real improvement over `~/.honeycomb` (it names the surface after its actual owner), and it is the option originally proposed. It is refined rather than adopted because `doctor` is still a *product name*: if the supervisor were ever renamed, restructured, or made optional, the directory would lie again in exactly the way `~/.honeycomb` does today. A fleet-neutral name (`~/.apiary/`) survives any single product's fate and matches the existing neutral `~/.deeplake/` precedent. If the team prefers the supervisor-branded name for its explicit ownership signal, `~/.doctor/` is the drop-in alternative (see the DECISION TO CONFIRM note).

### Fully separate top-level dirs per product (`~/.nectar`, `~/.honeycomb`, `~/.doctor`, `~/.hive`) (REJECTED)

Give each product its own top-level home directory with no shared root. Rejected because it loses the single-discoverable-home property (an operator/uninstaller now hunts across four-plus directories) and still needs *some* agreed location for the shared registry, which would then live in one product's dir again. The single neutral root with per-product subdirs gives per-product ownership without sacrificing one-directory discovery.

### Make the user choose the top-level directory at install with no default (REJECTED)

Require the operator to pick the state location during install. Rejected because a deterministic home-anchored default (`~/.apiary`) is correct for the overwhelming majority and the `os.homedir()` anchor already avoids the cwd footgun. Forcing a choice adds install friction for no safety gain; the `APIARY_HOME` / `--home=` override covers the minority who need a non-default location.

## References

- `doctor/src/registry.ts:105` - `defaultRegistryPath` -> `~/.honeycomb/doctor.daemons.json`, the shared registry this ADR relocates to `~/.apiary/registry.json`.
- `doctor/src/config.ts:154` - doctor's workspace dir `~/.honeycomb/doctor`, moving under the neutral root.
- `doctor/src/device-id.ts:7` - the shared `~/.honeycomb/device.json` device id, moving to the fleet root.
- `nectar/src/config.ts:14-15,114` - `RUNTIME_DIR_NAME = ".honeycomb"` resolved from `homedir()`, replaced by the shared root helper (`~/.apiary/nectar/`).
- `nectar/src/telemetry/db.ts:42`, `nectar/src/telemetry-usage/emit.ts:167`, `nectar/src/config-file.ts:75` - nectar state paths that follow the root helper.
- `honeycomb/src/cli/daemon-service.ts` - existing XDG awareness to align the Linux precedence with.
- Superproject `library/knowledge/private/architecture/ADR-0002-one-line-installer-product-loading-and-install-time-telemetry.md` - the installer that writes the registry on every lifecycle transition; must write the relocated registry and pin the resolved root into service units.
- `doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` - the registry contract whose path this ADR changes.
- `nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md` - the nectar PRD whose brooding-state file location this ADR governs (`~/.apiary/nectar/projects.json`).
