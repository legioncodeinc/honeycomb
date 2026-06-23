# PRD-044c: Search mode + migrated inference settings

> **Parent:** [PRD-044 Settings Page](./prd-044-settings-page-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The search-mode + inference-settings section of the Settings page. It adds a NEW control — a recall-mode selector
(keyword vs semantic vs hybrid) — and folds in the EXISTING dashboard inference settings (the provider → model
selector and the pollinating toggle) so they live on this page as the section's home.

Today recall has no user-facing mode. The pipeline silently decides semantic-vs-lexical from whether embeddings are
available: `collectCandidates` always runs the lexical FTS (BM25/ILIKE) arm, additionally runs the semantic `<#>`
cosine vector arm when a usable 768-dim query vector exists, and sets `degraded: true` when it cannot (embeddings off
/ unreachable / wrong-dim) — the silent fallback PRD-025 made semantic-by-default and PRD-029 surfaced as the
"lexical fallback" badge. This section makes that choice EXPLICIT: a `recallMode` vault `setting` —
`keyword` | `semantic` | `hybrid` — that the recall pipeline reads. The DEFAULT (unset) preserves today's PRD-025
behavior exactly, so the selector changes nothing until a user picks a non-default mode.

The provider → model selector and pollinating toggle already exist as the dashboard `SettingsPanel` (`panels.tsx`),
wired through `GET`/`POST /api/settings` and the `setting` class (`activeProvider`, `activeModel`,
`pollinating.enabled`). This section is their new home: the panel migrates here, the home page sheds its in-grid copy
(coordinated with PRD-038's reorg), and the controls keep their exact persist-then-re-read contract.

## Goals

- Add a recall-mode selector (`keyword` | `semantic` | `hybrid`) persisted as a vault `setting` (`recallMode`) via
  the existing `POST /api/settings/:key` path, reflecting the persisted value on reload (never a local-only toggle).
- Have the recall pipeline HONOR the chosen mode: `keyword` forces lexical-only, `semantic` runs the vector arm,
  `hybrid` runs both — with the embeddings-off interaction documented (below).
- Preserve PRD-025 behavior by DEFAULT: an unset `recallMode` behaves exactly as today (semantic-by-default with the
  embeddings-off lexical fallback), so shipping the selector is behavior-neutral until a user opts in.
- Migrate the existing provider → model selector and pollinating toggle onto this page as the inference settings, reusing
  `SETTING_KEY`, the provider catalog, and the persist-then-re-read pattern unchanged.
- Document how `recallMode` composes with the embeddings-off lexical fallback (PRD-025 / PRD-029) so the chosen mode
  and the `degraded` signal stay coherent.

## Non-Goals

- Changing the recall RANKING, the RRF fusion (`RRF_K = 60`), the arm weights, or the over-fetch multiplier — the mode
  selects WHICH arms run, not how their results are scored or fused (that is PRD-007 / PRD-027).
- Changing the embedding model, dimension, or the embeddings on/off env default — that is PRD-025 /
  embeddings-runtime. `recallMode` is orthogonal to whether the embed daemon is enabled; it composes with it (below).
- Adding new inference providers or models to the catalog — the migrated selector reads the existing
  `PROVIDER_CATALOG` (`vault/catalog.ts`) verbatim.
- Re-implementing the `setting` class, its scalar schema, or the catalog validation — those are PRD-032. This section
  adds one new known key (`recallMode`) with an enum-validated value and consumes the rest.

## User Stories

- As a developer, I want to force keyword-only recall when I know I'm searching for an exact token (a function name, an
  error string), so semantic drift does not bury the literal match.
- As a developer, I want semantic or hybrid recall for fuzzy natural-language questions, and I want to choose, so I
  control the recall behavior instead of it being decided silently by whether embeddings happen to be on.
- As a developer, I want my provider, model, and pollinating settings on the same Settings page, so configuration lives in
  one place instead of in a panel buried in the dashboard grid.
- As a developer, I want the chosen mode to persist and survive a reload, so I set it once.

## Implementation Notes

- **Section component:** a `SearchAndInferenceSection` rendered by `src/dashboard/web/pages/settings.tsx`. It composes
  the migrated `SettingsPanel` content (provider/model/pollinating) plus the new recall-mode `Select`, all on the DS
  tokens via the existing primitives. It receives the injected `wire`, `vaultSettings`, and `secretNames`, and calls
  the existing `saveSetting` (persist-then-re-read) for every change.
- **New setting key:** add `recallMode` to the known `setting` keys (`KNOWN_SETTING_KEYS` in
  `src/daemon/runtime/vault/api.ts`, alongside `activeProvider`, `activeModel`, `pollinating.enabled`) and to the page's
  `SETTING_KEY` map (`panels.tsx`). Its value is the closed enum `keyword | semantic | hybrid`; the daemon-side
  semantic validation (`validateSettingSemantics` in `vault/api.ts`) rejects any other value (fail-closed), the same
  way `activeModel` is validated against the catalog. The `setting` class scalar contract (string) holds.
- **Wire:** no new wire method — `recallMode` persists through the existing `setSetting(key, value)` /
  `vaultSettings()` surface (the same one `activeProvider`/`activeModel`/`pollinating.enabled` use). The selector is a
  controlled `<select>` whose value is `String(settings.recallMode ?? "")`, with an explicit "default" option that
  maps to leaving the key unset (preserving PRD-025 default).
- **Daemon-side read (the consuming seam — OQ-1):** the recall pipeline reads `recallMode` where the channels are
  assembled — `collectCandidates` in `src/daemon/runtime/recall/collection.ts`. The mode gates the vector channel:
  - `keyword` → SKIP the vector arm even when embeddings are on (lexical FTS only); `degraded` is NOT set (this is an
    intentional lexical run, not a fallback — see the fallback-vs-mode note below).
  - `semantic` → run the vector arm; when no usable query vector exists (embeddings off/unreachable), fall back to
    lexical and report `degraded: true` exactly as today (PRD-025 D-4 / PRD-029). Whether `semantic` with embeddings
    off is a degraded fallback or a hard-empty result is OQ-1 — proposed: degraded fallback, to match PRD-025.
    `hybrid` → run BOTH arms (the current default behavior when embeddings are on). This daemon-side read is a
    `retrieval` / `typescript-node` change this section depends on; the page persists the setting, the pipeline honors
    it.
- **Fallback-vs-mode coherence (the PRD-025 / PRD-029 interaction, documented):** `degraded: true` means the engine
  WANTED semantic but could not run it (embeddings off/unreachable). An EXPLICIT `keyword` mode is NOT degraded — the
  user chose lexical, so the "lexical fallback" badge (PRD-029 AC-1) must NOT show for a deliberate keyword run. Only a
  `semantic`/`hybrid` mode that could not run its vector arm sets `degraded` and shows the badge. The section's copy
  makes this explicit so the mode selector and the degraded badge never contradict each other.
- **Migration coordination (D-5):** the existing in-grid `SettingsPanel` on the Dashboard home is removed as part of
  PRD-038's home reorg (or left until this page lands — coordinated, not duplicated). The component itself is REUSED
  here (provider/model/pollinating render identically); only its mount location moves.

## Acceptance Criteria

- [ ] **AC-1 — Recall mode selectable + persisted.** The section renders a `keyword | semantic | hybrid` selector
  (plus a "default" option mapping to unset); choosing a value POSTs `POST /api/settings/recallMode` and reflects the
  PERSISTED value on reload (re-read, never a local-only toggle). The daemon rejects an invalid value (fail-closed).
  Unit-tested with a mocked `wire`.
- [ ] **AC-2 — Recall honors the mode.** With `recallMode` set, the recall pipeline runs the selected arms — `keyword`
  lexical-only, `semantic` vector (with the documented embeddings-off fallback), `hybrid` both — verified against the
  `collectCandidates` channel assembly. An unset mode preserves today's PRD-025 default exactly (behavior-neutral
  ship).
- [ ] **AC-3 — Fallback coherence.** An explicit `keyword` run does NOT set `degraded` and does NOT show the PRD-029
  "lexical fallback" badge; a `semantic`/`hybrid` run that cannot run its vector arm DOES set `degraded: true` and
  shows the badge. Unit-tested that the badge and the chosen mode never contradict.
- [ ] **AC-4 — Inference settings migrated.** The provider → model selector and the pollinating toggle live on this page,
  reuse `SETTING_KEY` + the provider catalog, persist through `/api/settings`, and reflect the persisted value on
  reload — no regression versus the dashboard `SettingsPanel` behavior. The home page does not also render a duplicate
  copy (coordinated with PRD-038).
- [ ] **AC-5 — Thin client + security.** The section uses the injected `PageProps.wire` and the existing
  `vaultSettings`/`setSetting` surface (no new wire method for `recallMode`), renders inside the PRD-037 page frame,
  carries no token/secret, and is LOCAL-MODE-ONLY. `npm run ci` / `build` / invariant green.

## Open Questions

- **OQ-1 (parent OQ-4) — The daemon-side `recallMode` read + `semantic`-with-embeddings-off semantics.** Wiring
  `collectCandidates` to read `recallMode` is a `retrieval` / `typescript-node` change this section depends on.
  Confirm: (a) the exact seam (read the `setting` at recall time vs thread it through recall config), and (b) whether
  `semantic` mode with embeddings OFF is a degraded lexical fallback (proposed, matches PRD-025) or a hard-empty
  result. Confirm before build.
- **OQ-2 — Default option vs explicit `hybrid`.** Should the selector's "default" (unset key) and an explicit `hybrid`
  be distinct, or collapse to the same behavior? Proposed: keep them distinct — "default" defers to PRD-025's runtime
  decision (semantic when embeddings on, lexical when off), while explicit `hybrid` always asks for both arms. Confirm
  the UX.
- **OQ-3 — Per-scope vs global mode.** Is `recallMode` a single global `setting`, or could it be per-workspace/agent?
  Proposed: global `setting` (the vault `setting` class is already scope-partitioned by org/workspace headers, so it
  is effectively per-tenant). Flagged, not blocking.
