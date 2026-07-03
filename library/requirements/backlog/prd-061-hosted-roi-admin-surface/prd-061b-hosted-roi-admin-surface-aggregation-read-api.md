# PRD-061b: Aggregation Read API over `roi_metrics` / `teams`

> **SUPERSEDED (2026-07-03):** Cloud fleet/team management now belongs to Queen, the fleet orchestrator. The canonical copy of this document lives at `queen/library/requirements/backlog/prd-009-hosted-roi-admin-surface/prd-009b-hosted-roi-admin-surface-aggregation-read-api.md`. This copy is retained for history only; do not update it here.

> **Parent:** [PRD-061](./prd-061-hosted-roi-admin-surface-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P2 (the read layer the hosted frontend consumes)
> **Schema changes:** None in v1. A future `roi_rollup_daily` pre-aggregate is noted as **deferred**.

---

## Overview

This is the **read API** between the shared `roi_metrics` + `teams` tables ([PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md)) and the hosted frontend (061c). It serves **org / team / user / project / time** rollups as **read-time `GROUP BY`s**, exactly the grain the ledger was designed for (queryable `org_id`/`workspace_id`/`team_id`/`project_id`/`user_id` identity columns, not a partition header). It is **read-only** over the spend ledger and **does not write** `roi_metrics` rows.

Two correctness rules carry over from 060f and are load-bearing:

> **Resolve by `MAX(created_at)` per `session_id`.** A session may have multiple rows (original + re-price). Every aggregation must reduce to the **canonical** row per `session_id` before summing, never double-count a re-priced session.
> **Surface `cost_basis`, never silently blend.** Measured infra cost and allocated infra share are different kinds of number (060f). A rollup must carry each line's `cost_basis` (`measured`/`allocated`/`none`) and **flag a mixed-basis result** (`COUNT(DISTINCT cost_basis) > 1`) rather than collapsing it into one net, the cross-org analogue of 060b's measured-vs-modeled honesty contract.

Every endpoint passes through 061a's **admin-entitlement seam**, this API never serves a cross-org row without the explicit entitlement, and an org-scoped admin sees only their own org. Money stays **integer cents** across the wire until the render edge (061c). Per-user keyed endpoints are **claim-gated** (061d): they return the inert/empty state until the verified `backend-token` claim is available.

The optional **`roi_rollup_daily` pre-aggregate** is noted as a **deferred** future optimization (precompute daily rollups to keep large cross-org reads cheap), explicitly **not** built in v1; v1 aggregations are read-time `GROUP BY`s. If/when read cost becomes a problem at cross-org scale, that is the lever, and it is an additive table, not a change to the append-only ledger.

## Goals

- **Org / team / user / project / time rollup endpoints** over `roi_metrics`/`teams`, as read-time `GROUP BY`s, each reducing to the `MAX(created_at)` canonical row per `session_id` first.
- **`cost_basis` surfaced per line** (measured / allocated / none) with the `allocation_method`, and a **mixed-basis flag** when a rollup spans bases, never a silent blend.
- **Pagination** on every list/leaderboard endpoint (cross-org result sets can be large).
- **Entitlement-fenced:** every endpoint passes through 061a's admin-entitlement seam; org-scoped admins see only their org, cross-org admins only the orgs they are entitled to.
- **Integer cents on the wire**, formatted to dollars only at the render edge (061c).
- **Claim-gated per-user endpoints** (061d): `user_id`-keyed endpoints return the inert state until verified claims are live.
- **`roi_rollup_daily` pre-aggregate noted as deferred**, a documented future optimization, not a v1 deliverable.

## Non-Goals

- **Writing the spend ledger.** Read-only over `roi_metrics`; rows are written by the daemon (060f).
- **Re-pricing or re-computing savings/cost.** The API reports persisted figures and their `cost_basis`; the measured/modeled/allocated math is settled upstream (060b/060c/060f).
- **Building the pre-aggregate.** `roi_rollup_daily` is deferred; v1 is read-time `GROUP BY`.
- **The authorization model.** 061a owns the entitlement; this API **consumes** the seam, it does not define it.
- **Rendering.** 061c owns the UI; this API returns `cost_basis`-tagged, paginated, integer-cents rollups.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Endpoints return **org / team / user / project / time** rollups as read-time `GROUP BY`s over `roi_metrics`/`teams`; a test asserts each rollup dimension returns the expected aggregate from a fixture ledger. |
| b-AC-2 | Every aggregation reduces to the **`MAX(created_at)` canonical row per `session_id`** before summing; a test asserts a re-priced session (two rows) is counted **once**, at the latest price. |
| b-AC-3 | Each line carries its **`cost_basis`** (+ `allocation_method`), and a **mixed-basis rollup is flagged** (`COUNT(DISTINCT cost_basis) > 1`) rather than blended; a test asserts a mixed result is not collapsed into a single net. |
| b-AC-4 | Every endpoint passes through **061a's admin-entitlement seam**; a test asserts an org-scoped admin gets only their org's rows and a request without the entitlement gets no cross-org data. |
| b-AC-5 | **All money is integer cents** on the wire; a test asserts no float-cents in any response shape. |
| b-AC-6 | List/leaderboard endpoints are **paginated**; a test asserts a large result set paginates deterministically (stable ordering, no dup/skip across pages). |
| b-AC-7 | **Per-user endpoints are claim-gated** (061d): with no verified `backend-token` claim they return the inert/empty state, never a `user_id=''` row presented as a person; a test asserts the gated behavior. |
| b-AC-8 | **`roi_rollup_daily` is documented as deferred**, not implemented; an inspection confirms v1 uses read-time `GROUP BY` and no pre-aggregate table is created. |

## Files touched

- New hosted aggregation API module(s) in the hosted backend (061a's service), the rollup query builders + endpoint handlers.
- Reads the shared `roi_metrics` / `teams` tables ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts), 060f); all interpolation through the SQL guards ([`sql.ts`](../../../../src/daemon/storage/sql.ts)).
- Passes through 061a's admin-entitlement seam (consumed, not defined here).
- Tests: per-dimension rollups, `MAX(created_at)` dedup, `cost_basis` surfacing + mixed-basis flag, entitlement scoping, integer-cents wire, pagination stability, per-user claim gate, no-pre-aggregate-in-v1.

## Open questions

- [ ] **`MAX(created_at)` at cross-org scale.** Reducing to the canonical row per `session_id` across many orgs may get expensive; does the `period_start` index suffice, or is this the trigger for the deferred `roi_rollup_daily` pre-aggregate? (deeplake-dataset-worker-bee.)
- [ ] **Time-bucket timezone.** The `period_start`/`period_end` type + timezone is a 060f open question; this API must bucket consistently across orgs (UTC vs org-local), confirm the boundary semantics before building the time rollup.
- [ ] **Cross-org allocation comparability.** If orgs use different `allocation_method`s for their per-team/user infra share (060f), a cross-org leaderboard comparing allocated nets can mislead; does the API expose `allocation_method` per row so 061c can caveat the comparison, or normalize? (061c.)
- [ ] **Pagination contract.** Cursor vs offset, and the stable sort key for leaderboards (by net? by savings? by org?), so paging is deterministic over an append-only, growing ledger.
- [ ] **Pre-aggregate trigger.** What read-latency / row-count threshold justifies building `roi_rollup_daily`, and would it be an additive tenant-scoped table written by a scheduled daemon job (never altering the append-only ledger)?

## Related

- [PRD-061](./prd-061-hosted-roi-admin-surface-index.md), the parent.
- [PRD-061a](./prd-061a-hosted-roi-admin-surface-hosted-surface-and-admin-auth.md), supplies the admin-entitlement seam every endpoint passes through.
- [PRD-061c](./prd-061c-hosted-roi-admin-surface-hosted-frontend.md), the frontend that consumes these rollups.
- [PRD-061d](./prd-061d-hosted-roi-admin-surface-per-user-claim-gating.md), the per-user gate this API honors on `user_id`-keyed endpoints.
- [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md), the `roi_metrics`/`teams` schema, the `MAX(created_at)` re-price rule, and the `cost_basis` measured-vs-allocated distinction this API surfaces.
- [PRD-060b](../prd-060-roi-tracker/prd-060b-roi-tracker-cost-and-savings-engine.md), the measured-vs-modeled honesty contract this API mirrors for measured-vs-allocated cost.
- **Security/quality handoff:** the API must serve no cross-org row outside the entitlement and leak no PII before the claim gate; `security-worker-bee` (penultimate) then `quality-worker-bee` (last) before merge. Surfaced, not authored here.
