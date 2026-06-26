# PRD-060e: ROI Tracker Dashboard Page

> **Parent:** [PRD-060](./prd-060-roi-tracker-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P1 (the surface the whole module exists to deliver; the operator-facing credibility page)
> **Schema changes:** None of its own. Reads the shared `roi_metrics` ledger + `teams` roster defined in [PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md); adds the composite read-model wire + contract shapes (now carrying rollups + `cost_basis` + the per-user availability flag) and a new page component.

---

## Overview

This is the `/roi` page, the surface the rest of PRD-060 feeds. It composes 060b's measured/modeled savings, 060c's infra cost, and 060d's pollination cost into the Net-ROI ledger and renders it honestly, degrading section-by-section when an input is absent, partial, or unreachable. It is added to the dashboard the house way: **one registry entry + one page component** per [adding-a-page.md](../../../knowledge/private/dashboard/adding-a-page.md), touching **no** sidebar or router file by hand ([PRD-037](../../completed/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md) nav-shell seam).

The page now **reads the shared `roi_metrics` ledger** ([PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)) at **org/workspace scope, governed by the existing `read_policy`** (`isolated`/`shared`/`group`, [`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts)), so the numbers aggregate **across devices**, not just this machine. It is still a **loopback, local-mode-only** surface, the loopback dashboard remains the local reader; the hosted, cross-org admin surface is **[PRD-061](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md)** and is a separate app. The page presents **rollup views**, org / team / agent / project, computed by the daemon as read-time `GROUP BY`s over `roi_metrics`. A **per-user** rollup is shown **only when verified backend user-claims are live** ([PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md) gate); until then it renders a **"per-user requires verified login"** empty state, never a `$0` or a self-asserted name.

Because the shared ledger separates **measured** from **allocated** cost (`cost_basis`, [PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)), the page must render an **allocated net distinctly from a measured net**: a per-team or per-user net whose infra share is an allocated estimate carries the same `est.`-class subordination as a modeled savings line, and a rollup that mixes bases (`COUNT(DISTINCT cost_basis) > 1`) is flagged rather than silently summed.

The page is a **pure function of a view-model**. The daemon assembles a single composite `RoiView` with **explicit per-section status discriminants** (`ok` / `partial` / `absent` / `unreachable` / `unauthenticated`) so that a **measured `$0` is visibly different from `unknown`**; the page switches each section on its status and never fetches or computes in the component. Two `usePoll` loops drive it: a slow one for billing (~60s, or a longer TTL per 060c) and a per-session one for token data. All money is integer cents until the render edge; `blendedCentsPerMtok` is `null` until capture is live; modeled savings carries its assumption as a data field.

The two briefs below, frontend architecture (react-worker-bee) and UX/UI (ux-ui-worker-bee), are folded into this sub-PRD's contract and visual language.

### Frontend architecture (folded in)

- **One composite `GET /api/diagnostics/roi`** returning a `RoiView` with **explicit per-section status discriminants** (`ok` / `partial` / `absent` / `unreachable` / `unauthenticated`), a measured `$0` differs from "unknown". A **separate `GET /api/diagnostics/roi/trend`** backs the chart.
- **The view-model is assembled from the shared `roi_metrics` ledger** ([PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)) read at **org/workspace scope governed by `read_policy`** ([`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts)); the daemon computes the **org / team / agent / project rollups** as read-time `GROUP BY`s and folds in a **`rollups` shape** (one entry per dimension) plus a **per-user availability flag** that is `false` until verified claims are live.
- **Allocated vs measured cost is carried on the wire:** each net/cost line exposes its `cost_basis` (`measured`/`allocated`/`none`); the page renders an **allocated net subordinate** (the same `est.`-class treatment as a modeled line) and flags a **mixed-basis** rollup.
- **All money is integer cents.** Modeled savings carries its **assumption as a data field**. `blendedCentsPerMtok` is **null until capture is live**.
- **Two `usePoll` loops** at ~60s (billing slow) and per-session (token), see [`page-frame.tsx`](../../../../src/dashboard/web/page-frame.tsx) for the existing `usePoll` idiom.
- **The page is a pure function of the view-model**, switching per-section on `status`; no fetching in the component.
- **New files:** [`src/dashboard/web/pages/roi.tsx`](../../../../src/dashboard/web/pages/) (page), a registry entry in [`registry.tsx`](../../../../src/dashboard/web/registry.tsx) (**do NOT** edit sidebar/router), wire schemas in [`wire.ts`](../../../../src/dashboard/web/wire.ts), contracts in [`contracts.ts`](../../../../src/dashboard/contracts.ts), daemon fetchers in [`api.ts`](../../../../src/daemon/runtime/dashboard/api.ts), new billing client [`roi-billing.ts`](../../../../src/daemon/runtime/dashboard/roi-billing.ts) (060c), tests under `tests/dashboard/web/`.
- **Inline-SVG trend chart** in the GraphCanvas idiom ([`panels.tsx`](../../../../src/dashboard/web/panels.tsx)), **no charting dependency**.
- **Daemon is the sole egress** holding billing creds; **no creds in the page**.
- **React 18 patterns** (not React 19), matching the existing dashboard.

### UX/UI (folded in)

- **`PageFrame` title="ROI"**, eyebrow set; reuse the **existing design system only** (zero new tokens/components): `Kpi`, `Badge`, `Card`, `Panel`, `Button`, `ConnectivityBanner` ([`primitives.tsx`](../../../../src/dashboard/web/primitives.tsx) / [`panels.tsx`](../../../../src/dashboard/web/panels.tsx)), inline-SVG chart like GraphCanvas.
- **Measured-vs-estimated solved with FOUR reinforcing existing signals:** (1) **Badge tone**, `verified` (green) = measured, `warning` (amber) = modeled; (2) **numeric weight**, `--text-primary` for measured, `--text-secondary` for modeled (subordinate, indented row); (3) a literal **`est.`** marker + leading **`~`** on every modeled figure; (4) **dashed vs solid** chart strokes. **The same four signals also distinguish allocated cost from measured cost:** an `allocated` net (per-team/user infra share, [PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)) renders with the `warning`/subordinate/`est.` treatment, so an allocated estimate never reads as a measured fact.
- **Rollup views:** a dimension switch (org / team / agent / project) over the shared ledger; **per-user is shown only when claims are live**, otherwise a **"per-user requires verified login"** empty state (info, not error; never a `$0` or a self-asserted name). A **mixed-basis** rollup (`COUNT(DISTINCT cost_basis) > 1`) shows a small "mixed measured + allocated" caption rather than a single blended net.
- **The Net-ROI hero inherits `est.`** because it sums a modeled term (enforced jointly with [060b](./prd-060b-roi-tracker-cost-and-savings-engine.md)'s honesty contract).
- **Honey is brand-frame only, never encodes sign:** positive net = `var(--verified)`, negative net = `var(--severity-critical)`.
- **The assumption is disclosed** in an **ⓘ popover** + a **persistent page-foot footnote**, both reading from 060b's assumption data field (one source).
- **States:** first-run/empty shows a **dash glyph placeholder, not `$0.00`**; partial = info badge **"Claude Code only"**; billing-unreachable shows a **dash glyph** for net + a **scoped retry** (never compute net from incomplete inputs); not-authenticated **gates the ledger** with a Settings CTA, rendering only **redacted** auth status.
- **Number formatting:** cents→dollars thresholds, k/M tokens, `$/Mtok` blended, prior-period delta via `Kpi`, but **cost-rising must not render green** (invert the delta sense for cost KPIs).
- **Motion** reuses `--dur-fast` / `--dur-base` only; **no count-up odometer**; respect `prefers-reduced-motion`.
- **Possible additive `Kpi` `delta-label`/`sense` prop** for the cost inversion, **escalate to design-system-worker-bee** if it exceeds an additive change.

## Goals

- Register **`/roi`** via one registry entry + one `roi.tsx` component ([adding-a-page.md](../../../knowledge/private/dashboard/adding-a-page.md)); no hand-edit of the sidebar or router.
- Render the **Net-ROI ledger** (`saved - (infra + pollination)`) with the measured headline, the modeled estimate clearly subordinate and labeled, the infra cost, and the itemized pollination cost, computed from the **shared `roi_metrics` ledger** ([PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)) read at org/workspace scope governed by `read_policy`, so the numbers aggregate **across devices**.
- Present **rollup views** (org / team / agent / project) as read-time `GROUP BY`s assembled in the daemon; show a **per-user** rollup **only when verified claims are live**, otherwise a **"per-user requires verified login"** empty state.
- Render **allocated net distinctly from measured net** (allocated infra share gets the `est.`-class treatment) and flag a **mixed-basis** rollup rather than silently blending.
- Drive the page as a **pure function** of the composite `RoiView`, switching each section on its `status` discriminant; assemble the view-model + the `roi`/`roi/trend` reads in the daemon, not the component.
- Apply the **four-signal measured-vs-estimated language** and the **honey-never-encodes-sign** rule; the net hero inherits `est.`
- Render every degraded state honestly: a **dash glyph placeholder** (not `$0.00`) on first-run, a **"Claude Code only"** partial badge, a **dash glyph + scoped retry** on billing-unreachable (net not computed from incomplete inputs), and an **auth-gated** ledger with a redacted-status Settings CTA.
- Reuse the **existing design system only** (no new tokens/components) and an **inline-SVG** trend chart (no charting dep); honor `prefers-reduced-motion`.

## Non-Goals

- **New design tokens or components.** Existing DS primitives only; the single *possible* exception is an additive `Kpi` delta-sense prop, which escalates to design-system-worker-bee if non-additive.
- **A charting dependency.** Inline SVG in the GraphCanvas idiom.
- **Editing the sidebar or router.** Page registration is via the registry entry alone ([PRD-037](../../completed/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md)).
- **Computing cost/savings in the page.** The component renders a view-model; all math is upstream (060b/060c/060d), the shared-ledger rollups are read-time `GROUP BY`s assembled in the daemon read-model (060f), and the page never queries `roi_metrics` directly.
- **A hosted or cross-org surface.** This page stays **loopback, local-mode-only**, reading its own org/workspace rows under `read_policy`. The authenticated, cross-org, leaderboard surface is **[PRD-061](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md)**, a separate hosted app.
- **Per-user attribution before the backend claim.** Per-user rollups stay an empty state until verified claims land (060f gate); the page never falls back to a git-email / OS-user name.
- **Holding credentials or making outbound calls from the page.** Daemon is sole egress; the page reads loopback only.
- **React 19 idioms.** Match the existing React 18 dashboard.

## Acceptance criteria

| ID | Criterion |
|---|---|
| e-AC-1 | `/roi` is registered via **one registry entry + one `roi.tsx`** ([adding-a-page.md](../../../knowledge/private/dashboard/adding-a-page.md)); a test/inspection confirms **no sidebar or router file was hand-edited**, and the page renders inside `PageFrame` with title "ROI". |
| e-AC-2 | The page is a **pure function of the `RoiView`**, it does no fetching/computation; a test renders every per-section status (`ok`/`partial`/`absent`/`unreachable`/`unauthenticated`) from a fixture view-model and asserts the correct treatment for each. |
| e-AC-3 | **Measured vs modeled** uses the four reinforcing signals (Badge tone, numeric weight, `est.`+`~` marker, dashed/solid stroke); the **modeled figure always carries `est.`/`~`** and is visually subordinate, and the **net hero inherits `est.`** A test asserts the modeled term never renders with the measured (verified/`--text-primary`) treatment. |
| e-AC-4 | **Honey never encodes sign:** positive net renders `var(--verified)`, negative net `var(--severity-critical)`; a test asserts the sign→color mapping and that honey is frame-only. |
| e-AC-5 | **First-run/empty** shows a **dash glyph placeholder, not `$0.00`**; **token-absent** shows the `absent` treatment; **Claude-Code-only** shows the **"Claude Code only"** info badge, so a measured `$0` is visibly distinct from `unknown`. |
| e-AC-6 | **Billing-unreachable** shows a **dash glyph** for the affected line **and for the net**, plus a **scoped retry**; a test asserts the **net is not computed** when any required input is missing/unreachable. |
| e-AC-7 | **Not-authenticated** gates the ledger behind a Settings CTA and renders **only redacted** auth status (no token/secret); a test asserts no credential value reaches the page. |
| e-AC-8 | The **assumption** behind the modeled estimate is disclosed via an **ⓘ popover + a persistent page-foot footnote**, both sourced from 060b's assumption **data field** (one source, not hardcoded copy). |
| e-AC-9 | **Cost-rising-not-green:** the prior-period delta on cost KPIs inverts the usual sense (rising cost is **not** green); a test asserts a cost increase does not render as a positive/green delta. |
| e-AC-10 | The trend chart is **inline SVG** (no charting dep) in the GraphCanvas idiom, with **dashed strokes for modeled / solid for measured**, backed by `GET /api/diagnostics/roi/trend`; motion reuses `--dur-fast`/`--dur-base` and respects `prefers-reduced-motion`. |
| e-AC-11 | All money is **integer cents** across the wire/contract; dollars are formatted only at the render edge, k/M for tokens, `$/Mtok` for the blended rate (**null** until capture live); a test asserts no float-cents in the wire schema. |
| e-AC-12 | The view-model is assembled from the **shared `roi_metrics` ledger** ([PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)) read at **org/workspace scope governed by `read_policy`** ([`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts)); a test asserts an `isolated` policy yields only own rows and a `shared` policy yields workspace-wide rows, and that the page renders the **across-device** aggregate (not just this machine). |
| e-AC-13 | The page renders **org / team / agent / project rollup views** (read-time `GROUP BY`s assembled in the daemon); a test asserts the dimension switch renders each rollup from a fixture view-model and the component does **no** grouping itself. |
| e-AC-14 | A **per-user** rollup is shown **only when the per-user availability flag is true** (verified claims live, 060f); a test asserts that with the flag false the page shows the **"per-user requires verified login"** empty state and **never** a `$0` or a self-asserted name. |
| e-AC-15 | An **allocated** net (per-team/user infra share, `cost_basis='allocated'`) renders with the `est.`-class subordinate treatment, **distinct** from a `measured` net; a **mixed-basis** rollup (`COUNT(DISTINCT cost_basis) > 1`) is flagged rather than blended; a test asserts allocated never renders with the measured (verified/`--text-primary`) treatment. |

## Files touched

- [`src/dashboard/web/pages/roi.tsx`](../../../../src/dashboard/web/pages/), **new** page component (pure function of `RoiView`).
- [`src/dashboard/web/registry.tsx`](../../../../src/dashboard/web/registry.tsx), **one** new registry entry (no sidebar/router hand-edit).
- [`src/dashboard/web/wire.ts`](../../../../src/dashboard/web/wire.ts), wire schemas for `RoiView` + trend (integer cents, status discriminants, assumption field, nullable blended rate).
- [`src/dashboard/contracts.ts`](../../../../src/dashboard/contracts.ts), contract types for the `RoiView` + per-section status.
- [`src/daemon/runtime/dashboard/api.ts`](../../../../src/daemon/runtime/dashboard/api.ts), the composite `GET /api/diagnostics/roi` + `GET /api/diagnostics/roi/trend` fetchers that assemble 060b/060c/060d **plus the shared-ledger rollups (060f)** into the view-model.
- [`src/daemon/runtime/recall/scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts), the `read_policy` authorization chokepoint the shared `roi_metrics` read is scoped through (read, not edited).
- The shared `roi_metrics` / `teams` tables ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts), defined in [PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)), read for the org/team/agent/project rollups.
- [`src/dashboard/web/page-frame.tsx`](../../../../src/dashboard/web/page-frame.tsx), the `PageFrame` + `usePoll` idiom reused (read, not necessarily edited).
- [`src/dashboard/web/primitives.tsx`](../../../../src/dashboard/web/primitives.tsx) · [`src/dashboard/web/panels.tsx`](../../../../src/dashboard/web/panels.tsx), existing `Kpi`/`Badge`/`Card`/`Panel`/`ConnectivityBanner`/GraphCanvas reused; a *possible* additive `Kpi` delta-sense prop (escalates if non-additive).
- `tests/dashboard/web/`, per-section status rendering, measured-vs-modeled treatment, honey-sign mapping, degraded states, cost-rising-not-green, integer-cents wire, no-creds-in-page.

## Open questions

- [ ] **Trend backfill before capture-start.** No token history exists before 060a; does the trend show infra-only history with a "savings tracked from \<date\>" marker, start empty, or hide until there is data? (Shared with 060c.)
- [ ] **Net-with-missing-input ruling (confirm).** Locked direction: **do not compute net from incomplete inputs, show a dash glyph + scoped retry.** Confirm the operator agrees this beats showing a partial net with a caveat (e-AC-6).
- [ ] **Are any *cost* inputs themselves estimates?** If `/billing/summary`'s projected end-of-period is shown, it is an estimate and must also carry `est.`; confirm which cost lines are actuals vs projections (ties to 060c projection question).
- [ ] **`Kpi` delta-sense prop.** Does the cost-rising-not-green inversion fit as an additive `Kpi` prop, or does it require a component change that **escalates to design-system-worker-bee**? Decide before building the cost KPIs.
- [ ] **Negative-net copy.** Exact framing for a user whose infra+pollination exceeds savings, so it reads as "low memory usage" rather than "this tool costs you money" (module open question; UX owns the copy).
- [ ] **Light-theme / export legibility.** Confirm the four measured-vs-modeled signals (esp. amber `warning` tone + dashed strokes) survive light theme and any screenshot/export the operator shares.
- [ ] **Assumption sign-off string.** The exact ⓘ/footnote wording comes from 060b's signed-off assumption; this page renders it but does not author it.
- [ ] **Default rollup dimension + scope.** Does the page default to the org rollup or the agent (this-device) view, and does the `read_policy` default (`isolated` vs `shared`) make the across-device aggregate visible by default, or does a user on `isolated` only ever see their own device until they opt into `shared`? (Ties to 060f's read scoping.)
- [ ] **Per-team without a roster surface.** If the `teams` roster ([PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)) has no authoring surface yet, the team rollup is empty for everyone. Does the page hide the team dimension until a roster exists, or show it with a "no teams configured" empty state?
- [ ] **Allocated-net copy.** Exact wording for a per-team/per-user net that rests on an allocated infra share, so it reads as "estimated split of shared infra cost" and not a measured per-person bill. (UX owns the copy; ties to 060f's `allocation_method`.)

## Related

- [PRD-060b](./prd-060b-roi-tracker-cost-and-savings-engine.md), supplies the `measured`/`modeled` tags + assumption field; the honesty contract is enforced jointly here and there.
- [PRD-060c](./prd-060c-roi-tracker-deeplake-billing-integration.md) · [PRD-060d](./prd-060d-roi-tracker-pollination-cost-metering.md), supply the infra and pollination cost lines + their status discriminants.
- **[PRD-060f](./prd-060f-roi-tracker-shared-spend-ledger.md)**, the shared `roi_metrics` ledger + `teams` roster this page now reads at org/workspace scope governed by `read_policy`; supplies the rollup dimensions, the per-user gate, and the `cost_basis` measured-vs-allocated distinction.
- **[PRD-061: Hosted ROI Admin Surface](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md)**, the separate hosted, cross-org reader of the same shared ledger; this loopback page is the **local** surface, PRD-061 is the hosted one.
- [PRD-037: Dashboard Nav Shell](../../completed/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md), the page-registration seam `/roi` plugs into ([registry.tsx](../../../../src/dashboard/web/registry.tsx)).
- [PRD-024: Dashboard UI Parity](../../completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md), the diagnostics read-model + token-free loopback shell the `roi` read-model and page extend.
- [Adding a Dashboard Page](../../../knowledge/private/dashboard/adding-a-page.md), the one-registry-entry + one-component contract followed here.
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md), the loopback read-model conventions the new routes obey.
- **Security/quality handoff:** the page must never surface credentials or compute a misleading net; `security-worker-bee` (penultimate) confirms no creds/secret reach the page and the egress stays daemon-only, then `quality-worker-bee` (last) verifies the build before merge. This sub-PRD surfaces the handoff; it does not author the audit.
</content>
