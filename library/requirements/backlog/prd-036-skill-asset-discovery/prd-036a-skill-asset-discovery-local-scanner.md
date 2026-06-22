# PRD-036a: Local Skill/Agent Scanner

> **Status:** Draft
> **Priority:** P0
> **Effort:** M
> **Parent:** [PRD-036 — Skill & Asset Discovery](./prd-036-skill-asset-discovery-index.md)

## Overview

Define a **daemon-side discovery pass** that scans the workspace's harness asset directories for
installed skills and agents and returns a normalized inventory. This is the missing data source that
makes locally-present-but-unsynced skills visible. Today the daemon knows only what is in the DeepLake
`skills` table; this sub-PRD gives it eyes on the filesystem.

The scanner is the foundation: PRD-036b unions its output with `synced_assets`/`skills`-table rows, and
PRD-042 (the Sync page) consumes the same output. It is read-only — it never writes to disk and never
touches DeepLake.

## Goals

- **G-1** — Discover installed **skills**: a skill is a directory containing a `SKILL.md` (the
  `install-target.ts` convention, `<root>/<name>/SKILL.md`), or a single skill markdown where a harness
  uses that shape.
- **G-2** — Discover installed **agents**: a single agent markdown file under the harness `agents/`
  directory (matching the `synced_assets` `asset_type: "agent"` shape — see `synced-assets.ts`).
- **G-3** — Extract per asset: `name`, `description`, `scope`, `sourceHarness`, `path`, `assetType`.
- **G-4** — Dedupe the **same** skill discovered under multiple harnesses into a single logical asset that
  records every harness it is installed in.
- **G-5** — Find the real assets in **this** repo: 27 skills under `.claude/skills/` + the `.claude/agents/`
  agents.

## Non-Goals

- Not writing, installing, or modifying any on-disk asset (read-only scan).
- Not reading DeepLake — the union with the substrate is PRD-036b's job.
- Not parsing the full body of a `SKILL.md` — only enough frontmatter/header to get name + description.
- Not adding a new harness or new install target (the directory list is derived from existing harness wiring).

## Directories to scan (harness asset roots)

The scan covers the harness asset directories for the supported harnesses. The canonical list is derived
from the harness integration wiring (PRD-019) so it does not drift; at minimum it includes:

- `.claude/skills/` and `.claude/agents/` (Claude Code)
- `.cursor/skills/` and `.cursor/agents/` (Cursor)
- the equivalent skill/agent directories of the other supported harnesses (Codex, Hermes, pi, OpenClaw)
  as defined by their adapters.

Both the **project** root (workspace `cwd`) and the **global** root (`~`) are scanned, mirroring the
`install-target.ts` project-vs-global split (`install=project` → `<projectDir>/.claude/skills/`,
`install=global` → `<globalDir>/.claude/skills/`). The roots are **injectable** so a unit test points them
at temp dirs and asserts discovery without scanning the real home directory.

## Detection rules

- **Skill (dir convention):** a child directory of a skills root that contains a `SKILL.md`. The directory
  name is the skill `name`; `description` comes from the `SKILL.md` frontmatter/first heading; `scope` is
  derived from the root (project → `local`/`repository`, global → `user`).
- **Agent (file convention):** a `*.md` file directly under an agents root. The file basename is the agent
  `name`; `description` from its frontmatter.
- A skills root that does not exist or is empty contributes nothing (no error) — graceful, like the
  `harness-sync.ts` ENOENT handling.

## Output shape (the discovery inventory)

A normalized, serializable inventory (TS interface, in `src/dashboard/contracts.ts` or a discovery module
it imports). Illustrative shape:

```ts
/** One asset (skill or agent) discovered on disk by the local scanner (036a). */
interface DiscoveredAsset {
  /** The logical asset name (skill dir name or agent file basename). */
  readonly name: string;
  /** Short description from the asset's frontmatter/header ("" if none). */
  readonly description: string;
  /** "skill" | "agent" — matches synced_assets.asset_type. */
  readonly assetType: "skill" | "agent";
  /** Derived scope: "local"/"repository" (project root) | "user" (global root). */
  readonly scope: string;
  /** Every harness this asset is installed in (deduped union, e.g. ["claude-code","cursor"]). */
  readonly sourceHarnesses: readonly string[];
  /** The on-disk path(s) backing this asset (one per harness install). */
  readonly paths: readonly string[];
}

interface LocalAssetInventory {
  readonly skills: readonly DiscoveredAsset[];
  readonly agents: readonly DiscoveredAsset[];
}
```

## Where it runs (D-1)

**Recommendation: on-demand endpoint + short-lived cache.** A daemon read endpoint
(e.g. `GET /api/diagnostics/installed-assets`, attached the same way `mountDashboardApi` attaches the
other diagnostics handlers) runs the scan and returns the inventory, caching the result for a short TTL so
repeated dashboard refreshes do not re-walk the tree each time. A file-watcher-driven cache is a possible
future optimization but is **out of scope** here — the on-demand + TTL path is enough for the dashboard's
refresh cadence and is far simpler to test. PRD-036b's `fetchSkillSyncView` calls the scanner (or this
endpoint's underlying function) directly rather than over HTTP, since it runs in the daemon.

## Dedupe rule (D-2)

The same skill installed under multiple harnesses (e.g. `library-stinger` present in both `.claude/skills/`
and `.cursor/skills/`) is **one** `DiscoveredAsset`, keyed by `(assetType, name)`, with `sourceHarnesses`
and `paths` accumulating every install location. This prevents the panel and KPI from counting the same
logical skill N times.

## Decisions

- **D-1 — On-demand endpoint + TTL cache, not a watcher.** Simplest correct surface for the dashboard's
  refresh cadence; a watcher is a later optimization, not required for AC.
- **D-2 — Dedupe by `(assetType, name)`.** Accumulate `sourceHarnesses` + `paths`; never emit the same
  logical asset twice.
- **D-3 — Read-only, fail-soft.** Missing/empty roots and unreadable files contribute nothing and never
  throw (mirror `harness-sync.ts` ENOENT handling). A discovery error degrades to an empty inventory, not
  a 500.
- **D-4 — Injectable roots.** Project + global roots are injectable (default `process.cwd()` / `os.homedir()`)
  so tests scan temp dirs, mirroring `install-target.ts`.
- **D-5 — Path-safety on names.** Asset names used as map keys / display are sanitized; the scanner never
  follows a path outside the configured roots.

## Acceptance Criteria

- [ ] **a-AC-1 — Finds this repo's skills.** Pointed at this repo's project root, the scanner returns the
  27 skills under `.claude/skills/` (each detected via `<name>/SKILL.md`) — count > 0, names correct.
- [ ] **a-AC-2 — Finds agents.** It returns the agent files under `.claude/agents/` as `assetType: "agent"`.
- [ ] **a-AC-3 — Extraction.** Each `DiscoveredAsset` carries `name`, `description`, `scope`,
  `sourceHarnesses`, `paths`, `assetType`.
- [ ] **a-AC-4 — Dedupe.** A skill installed under two harness roots (temp-dir fixture) appears once with
  both harnesses in `sourceHarnesses` and both `paths`.
- [ ] **a-AC-5 — Fail-soft.** A missing/empty root yields an empty contribution, no throw; an unreadable
  file is skipped.
- [ ] **a-AC-6 — Injectable + tested.** Roots are injectable; a Vitest suite drives temp dirs to prove
  detection, extraction, dedupe, and fail-soft without touching the real home directory.

## Implementation notes

- Model the directory/ENOENT handling on `src/daemon/runtime/services/harness-sync.ts` (graceful reads).
- Reuse the `.claude/skills/<name>/SKILL.md` convention from `src/daemon/runtime/skillify/install-target.ts`
  for the skill detection rule.
- Align `assetType` strings with `SYNCED_ASSET_TYPES` (`["skill","agent"]`) in
  `src/daemon/storage/catalog/synced-assets.ts` so PRD-036b's join is type-clean.
- Attach the read endpoint via the same `daemon.group(...)` seam `mountDashboardApi` uses in
  `src/daemon/runtime/dashboard/api.ts` (no `server.ts` edit).

## Open Questions

- **OQ-1** — Should the global (`~`) root be scanned by default in local mode, or only the project root?
  (Project-only avoids surfacing a user's unrelated global skills in a repo dashboard; default leans
  project-only, global behind a flag.)
- **OQ-2** — Exact `description` source per harness: `SKILL.md` YAML frontmatter `description:` vs first
  `#` heading — confirm the dominant convention across harnesses before extraction.
- **OQ-3** — Is the canonical harness-directory list better sourced from the PRD-019 harness registry at
  runtime, or a small static list owned by the scanner? (Registry avoids drift; static is simpler.)
