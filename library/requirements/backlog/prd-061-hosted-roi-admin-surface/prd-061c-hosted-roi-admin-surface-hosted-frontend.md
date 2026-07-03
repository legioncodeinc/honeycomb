# PRD-061c: Hosted Frontend (Dashboards + Leaderboards)

> **SUPERSEDED (2026-07-03):** Cloud fleet/team management now belongs to Queen, the fleet orchestrator. The canonical copy of this document lives at `queen/library/requirements/backlog/prd-061-hosted-roi-admin-surface/prd-061c-hosted-roi-admin-surface-hosted-frontend.md`. This copy is retained for history only; do not update it here.

> **Parent:** [PRD-061](./prd-061-hosted-roi-admin-surface-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P2 (the admin-facing UI; the visible product of the hosted surface)
> **Schema changes:** None. Consumes 061b's aggregation API.

---

## Overview

This is the **hosted frontend**: org / team / user dashboards and leaderboards over the shared ROI ledger, consuming 061b's aggregation API behind 061a's auth. The single most important framing is that it is a **separate hosted app, NOT the loopback dashboard.** PRD-060's `/roi` page is a token-free, loopback, local-mode-only surface that self-hydrates over `127.0.0.1`; this is a **public, authenticated, multi-tenant** app. They look related and share a design language, but they are different applications with different trust models.

The design ruling is: **reuse the design-system tokens/components where feasible, but call out the divergence explicitly.** The visual language (the four-signal measured-vs-estimated treatment, honey-never-encodes-sign, integer-cents-to-dollars formatting, the GraphCanvas inline-SVG chart idiom) should carry over so the two surfaces feel like one product. But the divergences are real and must be named, not glossed:

> **Auth.** The loopback page assumes no auth (loopback is the boundary); this app is authenticated and gates every view behind 061a's entitlement. There is a real login, a real session, and a forbidden state.
> **Multi-tenant.** The loopback page renders one org/workspace; this app renders **across** orgs (for a cross-org admin) or selects among an admin's orgs. The org/tenant selector is a first-class control with no analogue locally.
> **Hosting.** The loopback page is served by the daemon over `127.0.0.1` and holds no credentials; this app is a hosted, deployed frontend talking to a hosted backend (061a) that holds the admin-scoped credential. The "daemon is sole egress" rule becomes "the **hosted backend** is sole egress"; the frontend still holds no DeepLake credential.

The measured-vs-modeled **and** measured-vs-allocated honesty carries through: a leaderboard rank built on an **allocated** per-team/user net (060f/061b) must render that net with the subordinate `est.`-class treatment and caption its allocation, so a leaderboard never presents an allocated estimate as a measured per-person bill. Per-user leaderboards are **inert until claims are live** (061d): until then the frontend shows org/team leaderboards and a "per-user requires verified login" empty state, never a self-asserted name.

This sub-PRD owns the UI; the API is 061b, the auth is 061a, the gate is 061d, the privacy controls it renders are owned by 061e.

## Goals

- A **hosted, authenticated** frontend with **org / team / user** dashboards and leaderboards, consuming 061b's paginated, `cost_basis`-tagged rollups.
- **Reuse the design-system tokens/components where feasible**, carrying the PRD-060 visual language (four-signal measured-vs-estimated, honey-never-encodes-sign, integer-cents formatting, inline-SVG charts) so the surfaces feel like one product.
- **Explicitly document the divergences** from the loopback dashboard, auth, multi-tenant (org/tenant selector), and hosting, so the frontend is not mistaken for, or coupled to, the local page.
- **Render allocated net distinctly from measured net** (the `est.`-class treatment + allocation caption), so a leaderboard never presents an allocated estimate as a measured fact.
- **Per-user leaderboards inert until claims are live** (061d): org/team leaderboards plus a "per-user requires verified login" empty state until then.
- **Hold no credentials and make no direct DeepLake call**, the hosted backend (061a) is sole egress; the frontend reads 061b only.

## Non-Goals

- **Being the loopback dashboard or sharing its page registry.** This is a separate app; it does not import the local-only registry ([PRD-037](../../completed/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md)) or assume loopback (no-auth) access.
- **Computing rollups.** All aggregation is 061b (read-time `GROUP BY` in the hosted backend); the frontend renders a view-model.
- **Defining auth or the entitlement.** 061a owns auth; this app renders behind it.
- **Inventing identity.** No self-asserted person names; per-user is gated (061d).
- **Authoring the privacy/visibility policy.** 061e owns the policy; this app renders the controls and honors the resulting visibility.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | The frontend is a **separate hosted, authenticated app**; a test/inspection asserts it does **not** import the loopback dashboard's local-only page registry and does **not** assume loopback (no-auth) access. |
| c-AC-2 | It renders **org / team / user** dashboards + leaderboards from **061b's** paginated rollups; a test asserts the views are a pure function of the API responses (no aggregation in the client). |
| c-AC-3 | It **reuses the design-system tokens/components where feasible** and a short **divergence note** (auth / multi-tenant / hosting) is documented; an inspection confirms the divergences are named, not glossed. |
| c-AC-4 | **Allocated net renders distinctly from measured net** (the `est.`-class subordinate treatment + allocation caption); a test asserts an allocated leaderboard net never renders with the measured (verified/`--text-primary`) treatment. |
| c-AC-5 | **Per-user leaderboards are inert until claims are live** (061d): a test asserts that with the per-user flag false the app shows org/team leaderboards + the "per-user requires verified login" empty state and **never** a self-asserted name. |
| c-AC-6 | The frontend **holds no DeepLake credential** and makes **no** direct DeepLake call; a test asserts all data arrives via 061b and the hosted backend is the sole egress. |
| c-AC-7 | **Honey never encodes sign** and money formats integer-cents→dollars only at the render edge, carried over from PRD-060; a test asserts the sign→color mapping and no float-cents in the client view-model. |

## Files touched

- New hosted frontend app (separate from `src/dashboard/web/`), org/team/user dashboard + leaderboard views.
- Reuses design-system tokens/components where feasible (the PRD-060 visual language; a documented divergence note for auth/multi-tenant/hosting).
- Consumes 061b's aggregation API behind 061a's auth; holds no credentials.
- Tests: separate-app (no local registry import), pure-function-of-API, divergence-note presence, allocated-vs-measured rendering, per-user-inert-until-claim, no-creds-in-client, honey-sign + integer-cents.

## Open questions

- [ ] **App framework / hosting alignment with 061a.** Which framework and host (ties to 061a's hosting decision)? Does it share a repo/build with the existing dashboard or stand alone? This determines how much design-system code is literally reused vs re-exported.
- [ ] **Org/tenant selector UX.** For a cross-org admin, how is "which org(s) am I viewing" presented, a selector, a multi-org rollup, or both, and how does it make the partition-crossing nature visible (so an admin always knows when they are looking across orgs)?
- [ ] **Leaderboard ethics surface.** A per-user spend leaderboard can read as surveillance; what does the UI do to keep it framed as "memory lift", and does it honor 061e's opt-out/visibility controls in the ranking itself (e.g. hide opted-out users)? (Policy owned by 061e; UI owns the rendering.)
- [ ] **Allocated-comparison caveat.** How does the UI caption a cross-org leaderboard whose nets rest on different `allocation_method`s (061b), so the comparison is not misread as exact?
- [ ] **Light-theme / export legibility.** Confirm the carried-over four-signal language (amber `warning` tone, dashed strokes, `est.` markers) survives this app's theme and any exported/shared screenshot, same concern as the loopback page.

## Related

- [PRD-061](./prd-061-hosted-roi-admin-surface-index.md), the parent.
- [PRD-061a](./prd-061a-hosted-roi-admin-surface-hosted-surface-and-admin-auth.md), the auth/entitlement this app renders behind; the hosting decision it inherits.
- [PRD-061b](./prd-061b-hosted-roi-admin-surface-aggregation-read-api.md), the aggregation API this app consumes.
- [PRD-061d](./prd-061d-hosted-roi-admin-surface-per-user-claim-gating.md), the per-user gate this app honors in leaderboards.
- [PRD-061e](./prd-061e-hosted-roi-admin-surface-privacy-and-retention.md), the visibility controls this app renders and honors.
- [PRD-060e](../prd-060-roi-tracker/prd-060e-roi-tracker-roi-tracker-dashboard-page.md), the loopback dashboard page whose visual language this app reuses and **diverges from** (auth / multi-tenant / hosting).
- [PRD-037: Dashboard Nav Shell](../../completed/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md), the **local-only** page registry this app does **not** import.
- **Security/quality handoff:** the frontend must hold no credential and never render a self-asserted person or an allocated net as measured; `security-worker-bee` (penultimate) then `quality-worker-bee` (last) before merge. Surfaced, not authored here.
