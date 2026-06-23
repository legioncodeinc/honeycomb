# Honeycomb Dashboard — UI kit

A faithful, brand-elevated recreation of Honeycomb's **daemon-served dashboard** (`GET /dashboard`) and the Cursor extension webview. Both surfaces render the same canonical `ViewBlock` view-model from `src/dashboard/` in the [honeycomb repo](https://github.com/legioncodeinc/honeycomb).

## Screens
- `index.html` — the full dashboard: header (org/workspace + daemon health + Pollinate now), recall bar, recalled-memory results, KPI row, sessions table, rules list, codebase-graph canvas, skill-sync panel, and a streaming live log. Toggle the daemon pill to see the **connectivity-down banner** (the real daemon-unreachable state).

## Interactions (faked)
- **Recall** — type a query, press Enter / click Recall → memory cells animate in with score + provenance.
- **Pollinate now** — triggers the Pollinating consolidation loop: the graph's `pollinating()` node pulses violet, a memory cell enters the consolidating state, and the log streams the pass.
- **Daemon toggle** — the status pill flips the daemon up/down; down swaps the whole view for the connectivity banner + retry.

## Composition
Built from the design-system primitives — `Button`, `Badge`, `Input`, `Kpi`, `MemoryCard` (via `window.HoneycombDesignSystem_d60529`) — plus local panel components in `components.jsx`. Canned view-model data in `data.js` mirrors the contracts in `src/dashboard/contracts.ts` (`KpisView`, `SessionRow`, `SettingsView`, `GraphView`, `RuleRow`, `SkillSyncRow`).

## Files
| File | Role |
|---|---|
| `index.html` | Interactive dashboard app + state |
| `components.jsx` | Panels: Sessions, Rules, Skill-sync, Graph canvas, Live log, Connectivity banner |
| `data.js` | Canned view-model data (mirrors the daemon contracts) |
