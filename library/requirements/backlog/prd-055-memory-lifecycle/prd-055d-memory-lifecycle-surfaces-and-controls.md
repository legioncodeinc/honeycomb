# PRD-055d: Lifecycle config, audit, dashboard, and CLI surfaces

> **Parent:** [PRD-055 Memory Lifecycle](./prd-055-memory-lifecycle-index.md)
> **Surfaces:** the full retrieval-priority model of [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md): the per-term exponents `a, c, s`, every parameter in the "Parameters and defaults" table, the memory-health scalar `H(m,t)`, and the lifecycle eval suite.
> **Status:** Draft
> **Priority:** P2
> **Effort:** M
> **Schema changes:** None (reads the other terms' outputs: `memory_conflicts`, `ref_status`/`verified_at`/`stale_refs`, `freshnessScore`/`activation`/`calibratedConfidence`, `memory_history`, `memory_calibration`).

---

## Phase Overview

### Goals

Give the four lifecycle engines (recency/activation, conflicts, stale-references, calibration) one coherent operator surface so the whole model in [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md) is configurable, visible, and auditable from one place. Where 055a/055b/055c/055e *produce* the terms of the master equation `P(m | q, t) = R · A^a · C^c · (1 − σ)^s · κ`, 055d is the **operator surface for all of them**: a single typed `memory.lifecycle.*` config block (with `HONEYCOMB_LIFECYCLE_*` env overrides) that governs every exponent and parameter, an audit trail through `memory_history`, a lifecycle dashboard panel on the memories page that renders the query-independent health scalar `H(m,t)` plus per-term health (freshness, open-conflict count, stale-ref count, calibration ECE), and CLI parity for inspect-and-resolve. Each engine ships behind an explicit flag with a non-destructive default, so an operator opts in deliberately and can always see what a lifecycle action did and why, and can reverse it.

This sub-PRD owns no detection or resolution math. It owns the *knobs*, the *windows*, and the *audit*. The design rule it inherits from the scoring doc is the one that makes the whole model safe to ship: every term is a bounded multiplier that can only demote, and every unproven term ships dormant (exponent `0`, the identity). 055d's job is to make that posture the install default and to make any change away from it deliberate, documented, and visible.

### What it surfaces

055d configures and renders every term of the master equation. The table below reproduces the scoring doc's "Parameters and defaults" verbatim and maps each symbol to its `memory.lifecycle.*` config path and its `HONEYCOMB_LIFECYCLE_*` env override. The owning sub-PRD computes the value; 055d exposes the knob, the default, and the effect on the settings page and in the config reference.

| Parameter | Symbol | Master-equation role | Default | Config path (`memory.lifecycle.*`) | Env override (`HONEYCOMB_LIFECYCLE_*`) | Owner |
|---|---|---|---|---|---|---|
| Activation exponent | `a` | `A^a` | `1.0` | `activationExponent` | `ACTIVATION_EXPONENT` | 055a |
| Confidence exponent | `c` | `C^c` | `0` (dormant until calibrated) | `confidenceExponent` | `CONFIDENCE_EXPONENT` | 055e |
| Staleness exponent | `s` | `(1 − σ)^s` | `0` under `observe`, `1` under `execute` | `stalenessExponent` | `STALENESS_EXPONENT` | 055c |
| Half-life, distilled | `h(memories)` | shapes `A` | `180 d` | `halfLifeDaysByClass.memories` | `HALFLIFE_MEMORIES_DAYS` | 055a |
| Half-life, summary | `h(memory)` | shapes `A` | `45 d` | `halfLifeDaysByClass.memory` | `HALFLIFE_MEMORY_DAYS` | 055a |
| Half-life, raw | `h(sessions)` | shapes `A` | `10 d` | `halfLifeDaysByClass.sessions` | `HALFLIFE_SESSIONS_DAYS` | 055a |
| ACT-R decay | `d` | shapes `A` (Stage 2) | `0.5` | `actrDecay` | `ACTR_DECAY` | 055e |
| Activation floor | `A_min` | clamps `A` | `0.05` | `activationFloor` | `ACTIVATION_FLOOR` | 055e |
| Verification half-life | `h_verify` | shapes `σ` via `v(m,t)` | `14 d` | `verificationHalfLifeDays` | `VERIFICATION_HALFLIFE_DAYS` | 055c |
| Contradiction threshold | `θ_detect` | gates conflict detection | `0.6` | `contradictionThreshold` | `CONTRADICTION_THRESHOLD` | 055b |
| Corroboration weight | `γ` | shapes conflict vote `w_i` | `0.5` | `corroborationWeight` | `CORROBORATION_WEIGHT` | 055b |
| Supersede margin | `τ_supersede` | conflict verdict cut | `0.5` | `supersedeMargin` | `SUPERSEDE_MARGIN` | 055b |
| Review margin | `τ_review` | conflict verdict cut | `0.15` | `reviewMargin` | `REVIEW_MARGIN` | 055b |
| Open-conflict suppression | `ρ` | `κ` for the open-conflict loser | `0` (fully suppress, reversible) | `openConflictSuppression` | `OPEN_CONFLICT_SUPPRESSION` | 055b |

Two further posture flags govern *whether* the producing engines act at all, mirroring the pipeline's master switches:

| Flag | Effect | Default | Config path | Env override |
|---|---|---|---|---|
| Conflict auto-resolve | When off, conflicts are detected and queued only, never auto-superseded (human-in-the-loop). | off | `conflictAutoResolve` | `HONEYCOMB_LIFECYCLE_CONFLICT_AUTORESOLVE` |
| Stale-ref posture | `observe` (compute `σ`, `s = 0`, inert) or `execute` (`s > 0`, demote). | `observe` | `staleRefPosture` | `HONEYCOMB_LIFECYCLE_STALEREF_POSTURE` |

The dashboard renders the query-independent **memory health** scalar from the scoring doc directly from the already-emitted term fields:

```text
H(m,t) = A(m,t) · C(m) · (1 − σ(m,t)) · κ(m,t)      with  H ∈ [0,1]
```

`H` is computed read-side from `freshnessScore`/`activation` (`A`), `calibratedConfidence` (`C`), the stale-ref status (`σ`), and the conflict gate (`κ`). 055d adds no new write path to produce it; it is a pure projection of fields the other terms emit.

### Scope

- **Config.** A `memory.lifecycle.*` block in `agent.yaml` with matching `HONEYCOMB_LIFECYCLE_*` env overrides, following the established `memory.pipelineV2` / `HONEYCOMB_PIPELINE_*` precedent exactly: one typed config module is the source, env overrides yaml per-key, defaults live in one place. The block governs every exponent (`a`/`c`/`s`), every parameter in the table above (per-class half-lives, ACT-R `d`, `A_min`, `h_verify`, `θ_detect`, `γ`, `τ_supersede`, `τ_review`, `ρ`), and the two posture flags.
- **Audit.** Confirm every lifecycle action already writes to `memory_history` (actor, reason, confidence) per the conflict-resolution path in the scoring doc, and add a lifecycle-event filter so the history is queryable by action type.
- **Dashboard.** A lifecycle panel on the memories page: a per-memory health badge rendering `H`, a freshness indicator (from 055a/055e `A`), an open-conflict count and a per-conflict resolve action (from 055b), a stale-reference list and count (from 055c), and a calibration view (ECE plus a reliability diagram, from 055e).
- **CLI.** `honeycomb memory conflicts` (list/resolve), `honeycomb memory stale-refs` (list), and a `--lifecycle` flag on the existing memory inspection command to show freshness, calibrated confidence, ref status, and `H`.

### Out of scope

- The detection and resolution logic itself. Activation and decay belong to 055a, the conflict detector/resolver and the `κ` gate belong to 055b, the stale-reference resolver and `σ` belong to 055c, and reinforcement, ACT-R activation, and the calibration fit belong to 055e. 055d surfaces their outputs and configures their knobs; it computes none of them.
- New auth roles. Operator-scope resolution reuses the existing RBAC from PRD-011.
- Any new write path on the capture or controlled-write hot path. The only write 055d invokes is the already-defined 055b resolve endpoint.

### Dependencies

- **Blocked by:** sub-PRDs 055a (`freshnessScore`, the `a` exponent), 055b (`memory_conflicts`, the resolve endpoint, `κ`, the conflict parameters), 055c (`ref_status`/`stale_refs`/`verified_at`, `σ`, `h_verify`), 055e (`activation`, `calibratedConfidence`, `memory_calibration`, the reliability-diagram payload). This sub-PRD surfaces their outputs and cannot ship a term's control before that term emits a value.
- **Reuses:** PRD-029 degradation/observability surface (loading/empty/degraded states), the existing dashboard memories page (PRD-040), the CLI command architecture, and PRD-011 RBAC. Config precedence reuses the `memory.pipelineV2` / `HONEYCOMB_PIPELINE_*` pattern from [`memory-pipeline.md`](../../../knowledge/private/ai/memory-pipeline.md).

---

## User Stories

### US-55d.1 - One config block, safe defaults

**As an** operator, **I want** every lifecycle behavior governed by one documented config block that defaults to non-destructive, **so that** turning the module on is deliberate and reversible.

**Acceptance criteria:**
- AC-55d.1.1 Given a fresh install, when no lifecycle config is set, then the defaults are non-destructive: `a = 1`, `c = 0`, `s = 0` (stale-ref posture `observe`), and conflict auto-resolve is off (detect and queue only), so no lifecycle action demotes confidence-weighted (`c`) or staleness-weighted (`s`) ranking and no conflict is auto-superseded without a human.
- AC-55d.1.2 Given a `HONEYCOMB_LIFECYCLE_*` env var, when it is set, then it overrides the matching `agent.yaml` `memory.lifecycle.*` value per-key, following the documented `HONEYCOMB_PIPELINE_*` precedence (env over yaml, defaults last); the precedence order is documented in the config reference.
- AC-55d.1.3 Given any lifecycle flag in the parameter table, when it is documented, then it appears on the settings page and in the config reference with its symbol, default, and effect on the master equation.
- AC-55d.1.4 Given the stale-ref posture flips from `observe` to `execute`, when config reloads, then `s` moves from `0` to its configured value and the change is visible on the settings page; no other term's exponent changes implicitly.

### US-55d.2 - Lifecycle events are visible and auditable

**As an** operator, **I want** to see, trust, and audit what the lifecycle engines did, including each memory's health and the store's calibration, **so that** I can rely on the ranking and reverse a wrong action.

**Acceptance criteria:**
- AC-55d.2.1 Given lifecycle actions have run, when I open the memories page, then each memory shows a health badge rendering `H(m,t) ∈ [0,1]`, a freshness value, an open-conflict count, a stale-reference count, and the current calibration ECE; `H` is computed read-side from the emitted `A`/`C`/`σ`/`κ` fields with no new write.
- AC-55d.2.2 Given a conflict in the queue, when I resolve it from the dashboard, then it calls the 055b `POST .../resolve` endpoint and the row updates without a reload race, polling to convergence per the eventual-consistency rule, never a single immediate read-back.
- AC-55d.2.3 Given any lifecycle action (detection, resolution, re-verification), when I query `memory_history` filtered by lifecycle type, then I see the actor, reason, confidence, and timestamp for it.
- AC-55d.2.4 Given the calibration curve has been fit, when I open the calibration view, then it renders the reliability diagram and the current ECE/Brier from `memory_calibration` (the 055e introspection payload), so an operator can see whether stated confidence is trustworthy before relying on `c`.

### US-55d.3 - CLI parity

**As a** terminal-first user, **I want** CLI access to conflicts, stale refs, and lifecycle health, **so that** I am not forced into the dashboard.

**Acceptance criteria:**
- AC-55d.3.1 Given open conflicts exist, when I run `honeycomb memory conflicts`, then they list with ids, the conflicting pair, the verdict, and the status, scope-filtered to my org/workspace/agent.
- AC-55d.3.2 Given a conflict id, when I run `honeycomb memory conflicts resolve <id> --verdict supersede --winner <id>`, then it resolves through the same 055b endpoint and code path as the dashboard, with no parallel resolve logic.
- AC-55d.3.3 Given stale refs exist, when I run `honeycomb memory stale-refs`, then they list with the memory id and the unresolved references.
- AC-55d.3.4 Given a memory id, when I run the inspection command with `--lifecycle`, then it prints `freshnessScore`, `calibratedConfidence`, ref status, open-conflict status, and the computed `H` for that memory.

---

## Data Model Changes

None. This sub-PRD reads, it does not define. It consumes `memory_conflicts` (055b), the `ref_status` / `verified_at` / `stale_refs` columns (055c), `freshnessScore` / `activation` / `calibratedConfidence` (055a/055e, response-only fields), `memory_history` (existing, the audit substrate), and `memory_calibration` (055e, the reliability-diagram source). The health scalar `H(m,t)` is computed read-side from these fields and is not persisted.

---

## API / Endpoint Specs

All reads are scope-enforced (org/workspace/agent) **before any content column is returned**, identical to the recall authorization boundary, and all list endpoints are paginated.

- **Reuses** `POST /api/memories/conflicts/:id/resolve` (defined in 055b) for every resolve, from both dashboard and CLI. 055d defines no new write path.
- `GET /api/memories/conflicts?status=open` - list open conflicts for the dashboard and CLI (scoped, paginated). Returns ids, pair, verdict, status.
- `GET /api/memories/stale-refs` - list memories with `ref_status = 'stale'` and their unresolved references (scoped, paginated).
- `GET /api/memories/history?type=lifecycle` - filtered audit read over `memory_history`, returning actor, reason, confidence, timestamp for lifecycle-typed events (scoped, paginated).
- `GET /api/memories/calibration` - the current calibration curve's `ece`, `brier`, `n_samples`, and reliability-diagram payload (defined in 055e), surfaced for the calibration view (scoped).

The per-memory health fields (`freshnessScore`, `activation`, `calibratedConfidence`, ref status, conflict gate) ride the existing recall and memory-detail responses defined by 055a/055b/055c/055e; `H` is assembled from them on the read side.

---

## Technical Considerations

- **Config precedence mirrors the pipeline pattern exactly.** One typed config module owns `memory.lifecycle.*`; `agent.yaml` is the source, `HONEYCOMB_LIFECYCLE_*` env vars override per-key, defaults live in that one module. There is no second precedence model and no scattered toggle, just as `memory.pipelineV2` / `HONEYCOMB_PIPELINE_*` is single-sourced in [`memory-pipeline.md`](../../../knowledge/private/ai/memory-pipeline.md).
- **Dashboard reuse.** The lifecycle panel reuses the PRD-040 memories-page data-fetching and the PRD-029 degradation indicators, so it inherits the same loading, empty, and degraded states rather than inventing its own. A term whose producing engine is off renders as inert, not as an error.
- **Eventual consistency in the UI.** Resolve and re-list, and every health/calibration read-back after a write, poll to convergence; a single immediate read-back after a write can show a stale segment per the repo's DeepLake consistency rule.
- **No new write path on the hot path.** Every surface here is a read plus the one already-defined 055b resolve endpoint. Nothing in 055d touches the capture or controlled-write path, so the rule that a slow or failing step must never cost the user a memory is preserved.
- **`H` is a read-side projection.** The health scalar is computed from the already-emitted `A`/`C`/`σ`/`κ` fields at render time. 055d adds no column, no job, and no aggregation step to produce it; if a term is dormant its factor is the identity, so `H` degrades gracefully to the terms that are live.

---

## Files Touched

### New files
- `src/daemon/runtime/memories/lifecycle-config.ts` - the typed `memory.lifecycle.*` config module with `HONEYCOMB_LIFECYCLE_*` env overrides and the documented defaults.
- `src/daemon/runtime/memories/lifecycle-api.ts` - the list/history/calibration read endpoints and the read-side `H` assembly.
- `src/cli/commands/memory-conflicts.ts` - `honeycomb memory conflicts` (list/resolve).
- `src/cli/commands/memory-stale-refs.ts` - `honeycomb memory stale-refs` (list).
- the dashboard lifecycle panel component for the memories page (health badge, freshness, conflict queue, stale-ref list, calibration/reliability-diagram view).
- `tests/daemon/runtime/memories/lifecycle-config.spec.ts`, `tests/cli/memory-lifecycle.spec.ts`.

### Modified files
- `agent.yaml` schema / the settings page - register the `memory.lifecycle.*` flags with their defaults and effects.
- the dashboard memories page (PRD-040) - mount the lifecycle panel.
- the `--lifecycle` flag on the existing memory inspection command.
- the CLI command registry - register the two new commands.

---

## Test Plan

- **Unit:** config precedence (env over yaml, per-key, defaults last) for several flags; default posture (`a = 1`, `c = 0`, `s = 0`, auto-resolve off, posture `observe` per AC-55d.1.1); `memory_history` lifecycle-type filter; read-side `H` assembly from `A`/`C`/`σ`/`κ` including the dormant-term identity case.
- **Integration:** dashboard conflict resolve round-trips through the 055b `POST .../resolve` endpoint and polls to convergence; CLI resolve hits the same path (AC-55d.3.2); scope enforcement rejects out-of-scope conflict/stale-ref/history/calibration reads before any content is returned; the calibration view renders the 055e reliability-diagram payload.
- **Live dogfood:** run the full operator loop against a real daemon. Induce a conflict (two contradicting memories) and a stale ref (a memory naming deleted code), confirm both appear in the dashboard *and* the CLI with the expected counts and `H`, resolve one from the dashboard and one from the CLI, and confirm `memory_history` records each resolution (actor, reason, timestamp) and that the conflict count and `H` update after polling to convergence. Unit tests with isolated mounts structurally miss route collisions and consistency flaps, so the live loop is required before declaring this done.

---

## Risks and Open Questions

- **Risk:** flag sprawl makes the module hard to reason about, with so many exponents and parameters that an operator cannot tell what is on. **Mitigation:** one `memory.lifecycle.*` block, documented on the settings page and in the config reference with every symbol, default, and effect, mirroring the single `memory.pipelineV2` block. No scattered toggles, no second precedence model.
- **Open question:** should the dashboard auto-suggest a conflict winner (higher calibrated confidence / newer / higher activation) for one-click accept? Likely yes as a follow-on, but it ships **disabled** in this release: conflict auto-resolve defaults off and resolution stays human-in-the-loop for the first release, consistent with the scoring doc's reversible `supersede` and the safe-default posture.

---

## Related

- [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md) - the master equation, the parameter table, the `H(m,t)` health scalar, and the lifecycle eval suite this surface configures and renders.
- [`prd-055-memory-lifecycle-index.md`](./prd-055-memory-lifecycle-index.md) - the parent PRD index.
- [`memory-pipeline.md`](../../../knowledge/private/ai/memory-pipeline.md) - the `memory.pipelineV2` / `HONEYCOMB_PIPELINE_*` flag precedent this config mirrors exactly.
- PRD-040 (memories page, the dashboard host), PRD-029 (degradation observability, the loading/empty/degraded states), PRD-011 (RBAC, the reused scope/role model).
