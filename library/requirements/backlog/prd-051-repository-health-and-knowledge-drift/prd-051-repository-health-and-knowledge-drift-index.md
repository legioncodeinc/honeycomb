# PRD-051: Repository Health and Knowledge Drift

> **Status:** Backlog
> **Priority:** P1 (the wedge for the AI Augmented Developer evolution; ships value with zero workflow change)
> **Effort:** L (1-3d) for the read-only slice; XL if the engine grows beyond the v1 signals below
> **Schema changes:** None to the DeepLake catalog. Adds a machine-local, per-project health snapshot cache, derived entirely from data the daemon already holds.

---

## Overview

Honeycomb today wins by being invisible: a memory layer that makes any harness smarter with zero workflow change. This module is the first deliberate step toward making that memory **visible and self-evidencing**, without abandoning the invisible-by-default posture that drives adoption.

The deliverable is a **read-only Repository Health page** on the existing loopback dashboard, scoped to the project already selected in the top-left scope switcher ([`scope-context.tsx`](../../../../src/dashboard/web/scope-context.tsx), shipped in [PRD-049e](../../completed/prd-049-multi-project-and-context-switching/prd-049e-multi-project-and-context-switching-dashboard-scope-switcher.md)). It surfaces a small set of honest, computable signals about the selected repository: **knowledge drift** (knowledge docs whose subject code has changed since the doc was last touched), **documentation staleness**, **PRD-to-knowledge gaps** (a PRD moved to `completed/` with no corresponding knowledge-base update), and **skill freshness** (skillify watermarks lagging session activity).

The strategic point, and the reason this is sequenced first: **drift is the one signal a competitor without a memory substrate cannot cheaply build.** Computing "what the code is actually doing" versus "what the knowledge base claims" requires exactly what Honeycomb already has on disk: the tree-sitter codebase graph ([`src/daemon/runtime/codebase/`](../../../../src/daemon/runtime/codebase/index.ts)), the captured `sessions` and `memory` tables, and the skillify watermarks ([`src/daemon/runtime/skillify/watermark.ts`](../../../../src/daemon/runtime/skillify/watermark.ts)). The page is the proof that the memory is working, and it earns its place even for a user who never adopts a single Stinger.

Two principles govern every decision here:

> **Principle 1 (diagnose before you ask):** this module only *reports*. It never writes to the user's repo, never mutates a knowledge doc, never runs a Stinger. The invitation to adopt the workflow (PRD-052) and the coaching nudges (PRD-053) ride on top of these signals later; they are explicitly out of scope here.
> **Principle 2 (honest signals only):** every signal must be defensible and explainable on hover. A drift flag the user cannot trace back to a specific code change and a specific stale doc is worse than no flag. No score is shown that the engine cannot justify with its inputs.

The three sub-PRDs split the work along the repo's established daemon-runtime / read-API / dashboard-page seam: the **signal engine** that computes drift and staleness, the **read-only health API** that serves it over loopback, and the **Repository Health dashboard page** that renders it.

---

## Goals

- A **read-only Repository Health page** in the dashboard, registered through the existing page registry ([`registry.tsx`](../../../../src/dashboard/web/registry.tsx) / [`router.tsx`](../../../../src/dashboard/web/router.tsx) / [`sidebar.tsx`](../../../../src/dashboard/web/sidebar.tsx)), scoped to the project in the top-left switcher and showing a clear empty state when no project is selected ([`needs-project.tsx`](../../../../src/dashboard/web/needs-project.tsx)).
- A **knowledge-drift signal**: for each knowledge doc that references code (a path or a uniquely-resolving symbol from the committed symbol roster), detect when the referenced code has **changed** (its content hash moved after the doc's last edit) or been **deleted/renamed** (the symbol no longer resolves in the roster), and rank the doc by how much of its subject has moved or disappeared. Deletion is the highest-confidence drift state.
- A **documentation-staleness signal**: knowledge docs untouched for longer than a threshold while their subject area shows active session/commit activity.
- A **PRD-to-knowledge gap signal**: a PRD or IRD that has moved to `completed/` whose related code areas changed without any corresponding edit under `library/knowledge/`, i.e. shipped-but-undocumented.
- A **skill-freshness signal**: skillify watermarks ([`watermark.ts`](../../../../src/daemon/runtime/skillify/watermark.ts)) lagging meaningfully behind recent session volume, indicating sessions that were never mined into skills.
- A single **repository health summary** (a small banded score, not a vanity number) that rolls the signals up, with every contributing signal expandable to the exact evidence (which doc, which code change, which PRD).
- All of it computed **fail-soft and offline**: missing inputs degrade a signal to "unknown / not enough data," never to a thrown error or a misleadingly green state.

## Non-Goals

- **Any write to the user's repository.** No doc edits, no scaffold, no Stinger invocation, no auto-fix. This module is read-only by contract. The scaffold is [PRD-052](../prd-052-join-repository-to-hive/prd-052-join-repository-to-hive-index.md); the nudges are [PRD-053](../prd-053-coaching-and-reminder-loop/prd-053-coaching-and-reminder-loop-index.md).
- **A hosted or remote dashboard.** This stays a loopback, local-mode-only surface served by the one daemon, exactly like every other dashboard page ([`host.ts`](../../../../src/daemon/runtime/dashboard/host.ts)). No new server, no new bind, no new auth surface.
- **A new persistence store.** The health snapshot is a derived, machine-local cache that can be deleted and recomputed at any time. It is not a source of truth and does not touch the DeepLake catalog.
- **Semantic "is this doc still correct" judgement by an LLM.** v1 drift is structural and evidence-based (code referenced by a doc has changed). An LLM-graded "is the prose still accurate" pass is a deliberate future option, called out in open questions, not built here.
- **Cross-repository / fleet rollups.** Health is computed for the single selected project. The multi-repo fleet view is a separate thread (see [`fleet-observation-and-on-demand-skills.md`](../../../knowledge/private/collaboration/asset-sync-substrate.md) and the active fleet-observation design).
- **Defining the coaching thresholds that trigger reminders.** The engine computes signals; what nudge fires at what threshold is PRD-053's decision.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-051a-…-drift-and-staleness-signal-engine`](./prd-051a-repository-health-and-knowledge-drift-signal-engine.md) | The daemon-side engine that computes the four signals (knowledge drift, doc staleness, PRD-to-knowledge gap, skill freshness) by joining the codebase graph, the knowledge-doc set, the PRD/IRD lifecycle state, and the skillify watermarks. Produces an explainable, fail-soft per-project health snapshot. | Draft |
| [`prd-051b-…-read-only-health-api`](./prd-051b-repository-health-and-knowledge-drift-read-only-health-api.md) | The loopback, local-mode-only read endpoints that serve the health snapshot and per-signal evidence to the dashboard, beside the existing dashboard host group. Read-only, no-secret, scope-aware. | Draft |
| [`prd-051c-…-repository-health-dashboard-page`](./prd-051c-repository-health-and-knowledge-drift-dashboard-page.md) | The read-only Repository Health page: the rolled-up health band, the per-signal cards, the expand-to-evidence interaction, the no-project and not-enough-data empty states, scoped to the top-left switcher. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | The dashboard exposes a **Repository Health** page, reachable from the sidebar, scoped to the project selected in the top-left switcher; selecting a different project recomputes/reloads the view for that project, and selecting none shows the standard needs-project empty state. |
| AC-2 | For the selected project, the page shows a **knowledge-drift** list: knowledge docs whose referenced code has changed since the doc was last modified, each row expandable to the specific doc, the specific code reference, and what changed (the evidence). |
| AC-3 | The page shows **documentation-staleness**, **PRD-to-knowledge gap**, and **skill-freshness** signals, each with the same expand-to-evidence guarantee; no signal is shown without traceable inputs. |
| AC-4 | A **repository health summary** (a small banded indicator, e.g. Healthy / Watch / Drifting, not a single misleading percentage) rolls up the signals and links down to the contributing ones. |
| AC-5 | The entire surface is **read-only**: a test asserts that loading and interacting with the page performs no write to the repository, no knowledge-doc mutation, and no Stinger/skillify invocation. |
| AC-6 | Every signal **degrades fail-soft**: with the codebase graph not yet built, no knowledge docs present, or no PRDs in the library, the relevant signal renders an honest "not enough data" state rather than a green all-clear or a 500. |
| AC-7 | The health endpoints are **loopback + local-mode-only and carry no secret** (parity with the existing dashboard host gate), and they are scope-aware (they answer for the requested project only). |
| AC-8 | The health snapshot is a **derived cache**: deleting it and reloading reproduces the same signals from the underlying codebase graph + library + skillify state, proving it is not a source of truth. |

---

## Data model changes

**No DeepLake catalog changes.** All inputs already exist; this module reads and joins them.

- **Inputs (read-only):** the tree-sitter codebase graph, its extracted **symbol roster**, and content hashes ([`src/daemon/runtime/codebase/extract.ts`](../../../../src/daemon/runtime/codebase/extract.ts), [`hash.ts`](../../../../src/daemon/runtime/codebase/hash.ts), [`snapshot.ts`](../../../../src/daemon/runtime/codebase/snapshot.ts), [`query.ts`](../../../../src/daemon/runtime/codebase/query.ts)); the `library/knowledge/` doc set on disk (paths, last-modified, and the code references inside each doc); the PRD/IRD lifecycle state derived from `library/requirements/` and `library/issues/` folder placement; the skillify watermarks ([`watermark.ts`](../../../../src/daemon/runtime/skillify/watermark.ts)) and recent `sessions` volume.
- **New (derived, machine-local):** a **health snapshot cache** under the runtime dir, **keyed by the codebase graph's `SnapshotIdentity` (worktree + commit)** and grouped/displayed under `project_id`, holding the most recent computed signals + evidence pointers + a computed-at timestamp. Keying on the worktree+commit (not `project_id` alone) is how two worktrees of one repo, which resolve to the same `project_id`, avoid colliding on one cache (see Resolved decision 6). Deletable and fully reconstructable; carries no secret and is never authoritative.

---

## API changes

All new surface is **loopback + local-mode-only**, mounted beside [`mountDashboardHost`](../../../../src/daemon/runtime/dashboard/host.ts) under the same gate:

- `GET /health/repo?project=<id>` returns the rolled-up health band plus the per-signal summaries for the selected project.
- `GET /health/repo/signal/<signal>?project=<id>` returns the evidence rows for one signal (drift, staleness, prd-gap, skill-freshness), for the expand-to-evidence interaction.
- An optional `POST /health/repo/recompute?project=<id>` (loopback-only) that invalidates the derived cache and recomputes, for an explicit "refresh" affordance. Read-only with respect to the repository; it only rebuilds the derived cache.

No change to the partition boundary, the auth backend, or any existing endpoint. No outbound network calls are added.

---

## Resolved decisions

> Settled with the operator on 2026-06-26. Recorded as fixed contracts so `/the-smoker` implements against them, not against leanings.

1. **Reference extraction: explicit, roster-backed, precision over recall.** A doc reference resolves only as an explicit relative path or a **uniquely-resolving symbol** in the committed symbol roster (built from every committed file via the graph's tree-sitter extractors). Ambiguous symbols and fuzzy prose-to-symbol matches are dropped. A missed drift is safer than a wrong one, the entire wedge rests on the user trusting the signal.
2. **Deletion is a first-class, highest-confidence drift state.** Each referenced symbol resolves to one of three states: **live** (resolves, hash unchanged since the doc's edit), **changed** (resolves, hash moved after the doc's edit), or **deleted/renamed** (no longer in the roster, e.g. its file was removed). Deletion ranks above change. Computed off committed state so a dirty working tree never produces phantom drift.
3. **Staleness: relative is the real signal.** "Stale" = the doc's last-modified predates the most recent change to the code it references. A fixed-age heuristic (90 days) applies **only** to docs that reference no resolvable code, and is labeled visibly as the weaker secondary signal.
4. **Health band: worst-contributing-signal drives the band, never an average.** The band (Healthy / Watch / Drifting) is set by the worst signal and always links to the specific offenders. No single averaged percentage is ever shown.
5. **PRD-to-knowledge gap: join on the PRD's own Related links, flag conservatively.** Use the PRD's declared Related/code-touchpoints links as the join key (not an inferred file set); flag only when those referenced areas changed **and** no file under `library/knowledge/` changed between the PRD entering `completed/` and now.
6. **Snapshot cache identity = the graph's `SnapshotIdentity` (worktree + commit), grouped under `project_id`. This is how worktrees are handled.** Two worktrees of one repo resolve to the **same** `project_id` (shared git remote signal) but hold different checked-out code and different `library/` trees; keying on `project_id` alone would collide them. Reusing [`resolveSnapshotIdentity`](../../../../src/daemon/runtime/codebase/identity.ts) (`worktree` = `git rev-parse --show-toplevel`, `commit` = HEAD) gives each worktree its own correct snapshot, and the `commit` in the key self-invalidates the cache on a new commit. The dashboard groups/displays under the selected `project_id` and shows the snapshot for the worktree that daemon session is rooted in.
7. **Compute trigger: serve cache instantly, recompute in the background after a capture event, plus a manual refresh.** Never block the page on a large-repo recompute.
8. **Skill-freshness: per-project only in v1.** Team-propagation lag is a separate concern and is excluded to keep the signal honest and local.

## Deferred (no v1 work)

- **LLM-graded semantic drift** ("the prose itself reads inconsistent with the current code") is out of scope for v1; noted as a future signal that would reuse the model router.
- **Evidence-row caps (051b), card ordering and top-N (051c), and standalone-page vs dashboard-home-section (051c)** are implementation details left to `/the-smoker`'s judgement (lean: cap ~20 rows with "N more"; standalone sidebar page for discoverability). Lock any of these only if a later decision requires it.

---

## Related

- [PRD-049: Multi-Project and Context Switching](../../completed/prd-049-multi-project-and-context-switching/prd-049-multi-project-and-context-switching-index.md) and [`scope-context.tsx`](../../../../src/dashboard/web/scope-context.tsx) — the top-left project switcher this page scopes to.
- [PRD-014: Codebase Graph](../../completed/prd-014-codebase-graph/prd-014-codebase-graph-index.md) and [`src/daemon/runtime/codebase/`](../../../../src/daemon/runtime/codebase/index.ts) — the tree-sitter graph + content hashes that make structural drift computable.
- [PRD-016: Skillify](../../completed/prd-016-skillify/prd-016-skillify-index.md) and [`src/daemon/runtime/skillify/watermark.ts`](../../../../src/daemon/runtime/skillify/watermark.ts) — the watermark the skill-freshness signal reads.
- [PRD-017: Wiki Summaries](../../completed/prd-017-wiki-summaries/prd-017-wiki-summaries-index.md) — prior art for deriving doc-shaped artifacts from memory.
- [PRD-024: Dashboard UI Parity](../../completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md) and [PRD-037: Dashboard Nav Shell](../../completed/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md) — the self-hydrating, token-free dashboard shell + page registry this page joins.
- [Adding a Page](../../../knowledge/private/dashboard/adding-a-page.md) — the dashboard wiring this page follows.
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md) and [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md) — the local-mode gate and assembly order the health endpoints obey.
- Successor modules: [PRD-052: Join Repository to Hive](../prd-052-join-repository-to-hive/prd-052-join-repository-to-hive-index.md) (the non-destructive scaffold) and [PRD-053: Coaching and Reminder Loop](../prd-053-coaching-and-reminder-loop/prd-053-coaching-and-reminder-loop-index.md) (the nudges) both consume these signals.
