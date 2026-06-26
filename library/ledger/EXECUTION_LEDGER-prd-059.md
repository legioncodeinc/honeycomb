# Execution Ledger — PRD-059: Project Onboarding and the Projects Page

> Source of truth for the `/the-smoker` run. Survives context loss.
> Branch: `docs/prd-059-projects-onboarding` (docs PR [#124](https://github.com/legioncodeinc/honeycomb/pull/124)); implementation lands on a fresh `feat/` branch.
> Status legend: OPEN · IN PROGRESS · DONE · VERIFIED · BLOCKED

## Routing reality (read first)

- The **beekeeper-suit roster is TypeScript/Node-only** — there is **no React/UI Bee**. All daemon/hooks TS is roster-ownable by `typescript-node-worker-bee`. All dashboard React UI is **BLOCKED** on a routing decision (authorize `react-worker-bee`/`ux-ui-worker-bee` as substitutes, or register a UI Bee).
- Several sub-PRDs carry **unresolved design forks** with only "Lean:" defaults (gate granularity, folder-picker mechanism, switcher persist-vs-relabel). Implementation will encode the lean unless overridden.
- **Parallelism is bounded by shared files:** the daemon route surface (`server.ts`, `projects/scope-enumeration-api.ts`) and dashboard scope (`scope-context.tsx`) are touched by nearly every item. Concurrent bees in one tree corrupt each other; true parallel needs worktree isolation + integration.

## Ledger

| ID | Source | Criterion (abbrev) | Layer | Owner | Status |
|---|---|---|---|---|---|
| M-AC-1 | 059 | Zero bound projects → no row written, "bind to start" prompt | daemon+hooks | typescript-node-worker-bee | OPEN |
| M-AC-2 | 059 | Zero-state → dashboard shows "Pick a folder to start" CTA | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| M-AC-3 | 059 | Pick folder → absolute path bound, capture begins, project appears | daemon + UI | split | OPEN |
| M-AC-4 | 059 | Projects page lists sourced projects + Add a project | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| M-AC-5 | 059 | Import existing registry project → this device binds same project_id | daemon + UI | split | OPEN |
| M-AC-6 | 059 | Switcher persists a real scope change or is labeled view-filter | daemon + UI | split | OPEN |
| a-AC-1 | 059a | Zero projects → no `sessions`/`memory`/`memory_jobs` row, no job | hooks/daemon | typescript-node-worker-bee | OPEN |
| a-AC-2 | 059a | Suppressed → one "bind a project" notice per session | hooks | typescript-node-worker-bee | OPEN |
| a-AC-3 | 059a | Gate check resolves from local store, no DeepLake call | hooks | typescript-node-worker-bee | OPEN |
| a-AC-4 | 059a | After first bind → capture proceeds and persists | hooks/daemon | typescript-node-worker-bee | OPEN |
| a-AC-5 | 059a | ≥1 project → unbound folder still hits `__unsorted__` inbox | hooks | typescript-node-worker-bee | OPEN |
| b-AC-1 | 059b | Zero projects → CTA is primary dashboard content | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| b-AC-2 | 059b | Picker enumerated by daemon (loopback), yields absolute path | daemon | typescript-node-worker-bee | OPEN |
| b-AC-3 | 059b | Git folder → name pre-filled from canonical remote | daemon | typescript-node-worker-bee | OPEN |
| b-AC-4 | 059b | Confirm → bind written, gate opens, advances to Projects page | daemon + UI | split | OPEN |
| b-AC-5 | 059b | Daemon down/local-mode off → plain message + CLI fallback | daemon + UI | split | OPEN |
| c-AC-1 | 059c | Projects page lists projects + state (paths, remote, counts) | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| c-AC-2 | 059c | `__unsorted__` inbox shown distinctly with size | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| c-AC-3 | 059c | Add a project (top-right) runs folder-pick→bind | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| c-AC-4 | 059c | Unbind → folder binding removed, registry+data untouched | daemon + UI | split | OPEN |
| c-AC-5 | 059c | Open project → other surfaces re-scope | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| d-AC-1 | 059d | Import lists registry projects without a local binding | daemon + UI | split | OPEN |
| d-AC-2 | 059d | Select registry project + folder → binds same project_id | daemon | typescript-node-worker-bee | OPEN |
| d-AC-3 | 059d | Imported project recall includes other-device memories | daemon | typescript-node-worker-bee | OPEN |
| d-AC-4 | 059d | Git-remote match surfaced as suggestion (hint only) | daemon | typescript-node-worker-bee | OPEN |
| 122-AC-1 | IRD-122 | Org/workspace switch persists via daemon, or labeled view-only | daemon + UI | split | OPEN |
| 122-AC-2 | IRD-122 | Org change persists → re-mints org-bound token | daemon | typescript-node-worker-bee | OPEN |
| 122-AC-3 | IRD-122 | Project dropdown clearly a view filter | dashboard UI | **BLOCKED (no UI Bee)** | BLOCKED |
| 122-AC-4 | IRD-122 | No switcher change is a silent no-op | daemon + UI | split | OPEN |
| 123-AC-1 | IRD-123 | Zero projects → no capture rows/jobs (== a-AC-1) | hooks/daemon | typescript-node-worker-bee | OPEN |
| 123-AC-2 | IRD-123 | One "bind a project" notice per session (== a-AC-2) | hooks | typescript-node-worker-bee | OPEN |
| 123-AC-3 | IRD-123 | Gate from local store, no network (== a-AC-3) | hooks | typescript-node-worker-bee | OPEN |
| 123-AC-4 | IRD-123 | After first bind → capture proceeds (== a-AC-4) | hooks/daemon | typescript-node-worker-bee | OPEN |
| 123-AC-5 | IRD-123 | ≥1 project → inbox fallback resumes (== a-AC-5) | hooks | typescript-node-worker-bee | OPEN |

**Totals:** 34 ACs · 13 cleanly roster-ownable (TS/Node) · 8 BLOCKED (pure UI, no Bee) · 13 split (daemon part ownable now, UI part blocked).

## Wave plan

- **Wave 1 — daemon/hooks foundation (`typescript-node-worker-bee`, Opus-class for deep daemon reasoning).** One bee, coherent slice (avoids self-conflict on the shared route surface): capture gate (059a/IRD-123), daemon `fs/browse` + `projects bind|bind-existing|unbind` routes, org/workspace switch-persist route (IRD-122 backend), zero-projects predicate. DoD: `npm run ci` green (tsc + jscpd + vitest with fakes). Verifies offline — no live DeepLake needed.
- **Wave 2 — dashboard UI. BLOCKED:** empty-state picker (059b), Projects page + Add (059c), import modal (059d), switcher relabel (IRD-122). No roster Bee.
- **Close-out:** `security-worker-bee` → `quality-worker-bee` on whatever lands.

## Parked blockers (specific asks)

1. **No UI Bee.** Ask: authorize `react-worker-bee` + `ux-ui-worker-bee` as substitutes for Wave 2 (overriding the smoker's no-substitute rule for this run), or defer all UI to a separate effort.
2. **Design forks** (implementation encodes the "Lean" unless told otherwise): (a) gate per-device vs per-workspace; (b) folder-picker = daemon-served browse vs paste-path; (c) IRD-122 = wire org/workspace persist now vs relabel-only for v1.
3. **Branch/PR shape.** Docs PR #124 is open + docs-only. Implementation should land on a fresh `feat/` branch (off the docs branch so PRDs are present), not piled onto #124.
