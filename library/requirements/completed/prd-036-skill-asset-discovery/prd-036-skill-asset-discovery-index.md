# PRD-036: Skill & Asset Discovery (local skills are invisible — fix the count)

> **Status:** Completed
> **Priority:** P0
> **Effort:** M

## Overview

The dashboard's **Skill-sync** panel and the **Team skills** KPI both show **0** in a repo that
has **many** skills installed. This repo alone carries **27 real skills** under `.claude/skills/`
(each a `<name>/SKILL.md`) plus a directory of agents under `.claude/agents/` — yet the dashboard
reports zero. The skill surface looks broken to every user who opens it.

The root cause is a missing data source, not a rendering bug. `fetchSkillSyncView` in
`src/daemon/runtime/dashboard/api.ts` reads **only** the DeepLake `skills` table (the team-synced
skills written by the skillify install/publish path). The `SkillSyncPanel`
(`src/dashboard/web/panels.tsx`) and the `Team skills` KPI (`src/dashboard/web/app.tsx`) faithfully
reflect that single source. **Nothing scans the local filesystem** for installed skills/agents, so
every skill that is present-but-unsynced — the overwhelming majority in a fresh or solo repo — is
invisible. On a workspace whose `skills` table is empty, the entire surface reads 0.

This PRD adds the **missing half of the picture**: a daemon-side local discovery pass that scans the
harness asset directories, a merged skill-sync view-model that is the **union** of installed-and-local
skills with team-synced skills (each tagged with an honest state), and a corrected KPI with a defined
meaning. It is purely additive to the PRD-033 `synced_assets` substrate and the PRD-016 skillify
miner — it does not replace either; it surfaces what is on disk and joins it to what is in the team
substrate.

## Goals

- **G-1 — See what is installed.** A daemon discovery pass finds the skills and agents actually present
  on disk across the harness asset directories (`.claude/skills/`, `.cursor/skills/`, `.claude/agents/`,
  `.cursor/agents/`, and the other harness equivalents). In **this** repo it finds the 27 `.claude/skills/`
  skills and the agents — not 0.
- **G-2 — One honest union.** The skill-sync view becomes `installed ∪ synced`: every row carries a clear
  state (`local`, `shared`/`synced`, `pulled`) so a user can tell at a glance what is theirs-only vs
  shared with the team. No double-counting when a local skill is also in the substrate.
- **G-3 — A correct, defined KPI.** The `Team skills` KPI counts a **defined** thing (team-shared skills),
  documented and tested — never an accidental `skills.length` from a single-table query that happens to be 0.
- **G-4 — A data backbone for the Sync page.** The discovery + union layer is the shared substrate the
  full **Sync page (PRD-042)** builds on for viewing, promoting, and controlling skills **and** agents.

## Non-Goals

- **Not** a replacement for the `synced_assets` substrate (PRD-033) or the skillify miner / install /
  publish path (PRD-016). This PRD reads disk and joins; it does not change how skills get published or
  pulled.
- **Not** the Sync page UI itself (view / promote / control of skills and agents) — that is **PRD-042**,
  which consumes this discovery layer as its data backbone.
- **Not** new harness wiring or new install targets. Discovery reads existing harness directories; it does
  not add a harness.
- **Not** writing to disk. Discovery is read-only scanning. Promotion/publish flows stay where they are
  (PRD-016 / PRD-033).
- **Not** a change to the DeepLake `skills` or `synced_assets` schema. The union is assembled in the
  view-model layer from existing tables + the new local scan.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-036a-skill-asset-discovery-local-scanner](./prd-036a-skill-asset-discovery-local-scanner.md) | Local skill/agent scanner (daemon-side discovery pass) | Draft |
| [prd-036b-skill-asset-discovery-union-view](./prd-036b-skill-asset-discovery-union-view.md) | Skill-sync view = installed ∪ synced, with honest state | Draft |
| [prd-036c-skill-asset-discovery-kpi-correctness](./prd-036c-skill-asset-discovery-kpi-correctness.md) | "Team skills" KPI correctness | Draft |

## Acceptance Criteria

- [ ] **AC-1 — Discovery finds the real skills.** Run against **this** repo, the daemon discovery pass
  returns the 27 skills under `.claude/skills/` (each detected by its `<name>/SKILL.md`) plus the agents
  under `.claude/agents/`, with name/description/scope/source-harness/path extracted. Not 0.
- [ ] **AC-2 — The panel shows the union.** `SkillSyncPanel` lists **local** installed skills with state
  `local` and team-synced skills with their existing state (`shared`/`synced`/`pulled`). A skill that is
  both installed locally and present in the substrate appears **once** (no double-count).
- [ ] **AC-3 — The KPI is correct and defined.** The `Team skills` KPI reflects a documented count
  (D-3: team-shared skills) sourced from the agreed table — proven by a test, never an incidental
  single-table `.length` that reads 0 when the `skills` table is empty.
- [ ] **AC-4 — Additive, no regressions.** The `synced_assets` substrate (PRD-033) and the skillify
  install/publish path (PRD-016) are unchanged; existing synced-skill rows keep their state and counts.
  `npm run ci` (typecheck + jscpd + vitest) stays green.
- [ ] **AC-5 — Backbone ready for PRD-042.** The discovery output shape and the union view-model are a
  stable contract the Sync page (PRD-042) can consume for both skills **and** agents.

## Related

- **PRD-024 — Dashboard UI Parity** (`library/requirements/in-work/prd-024-dashboard-ui-parity/`) — owns
  the `SkillSyncPanel` + `Team skills` KPI surface this PRD corrects.
- **PRD-035 — Dashboard Data Fixes** (`library/requirements/backlog/prd-035-dashboard-data-fixes/`) —
  sibling dashboard-data correctness work.
- **PRD-033 — Asset-Sync Substrate** (`library/requirements/in-work/prd-033-asset-sync-substrate/`) — the
  `synced_assets` table (skill + agent) this PRD joins against; **not** replaced.
- **PRD-016 — Skillify** (`library/requirements/in-work/prd-016-skillify/`) — the miner +
  install/publish path that writes the `skills` table; **not** replaced.
- **PRD-019 — Harness Integrations** (`library/requirements/in-work/prd-019-harness-integrations/`) — the
  source of truth for which harness asset directories exist (input to the scanner's directory list).
- **PRD-042 — Sync Page** *(forward reference; not yet authored)* — the view/promote/control UI for skills
  and agents that consumes this discovery + union layer as its data backbone.

## Reference (grounding code paths)

- `src/daemon/runtime/dashboard/api.ts` — `fetchSkillSyncView` (reads `skills` table only — the bug) and
  `fetchKpisView`.
- `src/dashboard/contracts.ts` — `SkillSyncView` / `SkillSyncRow` / `KpisView` view-model contracts.
- `src/dashboard/web/panels.tsx` — `SkillSyncPanel` (renders `skills`, `SYNC_TONE` state badges).
- `src/dashboard/web/app.tsx` — the `Team skills` KPI (`<Kpi label="Team skills" value={skills.length} />`).
- `src/dashboard/web/wire.ts` — `ENDPOINTS.skills` / `SkillRowSchema` wire client.
- `src/daemon/storage/catalog/synced-assets.ts` — `synced_assets` table (asset_type `skill` + `agent`).
- `src/daemon/runtime/skillify/` — the miner (`miner.ts`), `skills-write.ts`, `install-target.ts`
  (the `.claude/skills/<name>/SKILL.md` convention), `publish-endpoint.ts`.
- `src/daemon/runtime/services/harness-sync.ts` — per-harness asset rendering / target paths.
