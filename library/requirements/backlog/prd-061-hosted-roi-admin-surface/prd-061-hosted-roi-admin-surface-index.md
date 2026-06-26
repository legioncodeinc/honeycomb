# PRD-061: Hosted ROI Admin Surface

> **Status:** Backlog, draft (2026-06-26). 5 sub-PRDs, not started.
> **Priority:** P2 (the multi-tenant reporting/leaderboard surface that monetizes the shared ROI ledger; gated behind the 060f data foundation and the highest-risk security surface in the set)
> **Effort:** XL (> 3d, a new authenticated hosted app spanning a cross-org admin auth model, an aggregation read API, a hosted frontend, the per-user claim gate, and a privacy/retention regime)
> **Schema changes:** Reuses the `roi_metrics` + `teams` tables from [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md). Any admin/roster additions are additive and noted per sub-PRD; this PRD adds **no** new spend-ledger table.

---

## Overview

PRD-060 built a **loopback, local-mode-only** ROI dashboard, and [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md) pushed the per-session spend record into a **shared, tenant-scoped DeepLake ledger** (`roi_metrics`) plus a `teams` roster, so ROI now aggregates **across devices** and rolls up per-org/workspace/project/agent/team. That shared ledger makes a **hosted, multi-tenant admin surface** possible, and that is what this PRD builds: an **authenticated web app** where an admin sees ROI **across organizations**, with per-user / per-team / per-org leaderboards.

This **deliberately flips PRD-060's local-only posture.** PRD-060's central Non-Goal was "no hosted or multi-tenant surface"; PRD-061 *is* that surface, and it is a **separate app**, not a new page on the loopback dashboard. The reason this is its own PRD, and the reason it is the **highest-risk surface in the whole ROI set**, is one sentence:

> **It reads the same `roi_metrics` + `teams` tables as a cross-org admin surface, deliberately crossing the partition boundary that protects every other tenant table.**

Every other read in Honeycomb is fenced by the `read_policy` authorization chokepoint ([`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts), `isolated`/`shared`/`group`), which fails **closed** to own-data-only and renders only the membership it is given. A cross-org admin read is, by definition, a read that steps **outside** a single org/workspace partition. That is the opposite of every other access path in the system, so the **authorization model is the spine of this PRD** (061a) and the partition-crossing read is fenced by an admin entitlement that is itself the central security question.

Two dependencies are inherited from 060f and are **not** re-litigated here:

> **Per-user is gated on a verified backend user-claim that does not exist today.** Honeycomb has no person identity (the DeepLake token is org-bound; `author` = `agent_id` = the machine). `roi_metrics.user_id` is `''` until a verified `backend-token` claim populates it, with **no** self-asserted (git-email / OS-user) fallback and **no** backfill. Therefore **per-user leaderboards are inert until that claim lands** (061d); per-org and per-team reporting works the day the shared ledger has data.
> **Identity is not invented here.** This PRD does not build the person-identity backend; it **consumes** the claim when it exists and degrades to org/team reporting until then.

The five sub-PRDs are: the hosted surface + admin auth/access-control model (061a), the aggregation read API over `roi_metrics`/`teams` (061b), the hosted frontend dashboards + leaderboards (061c), the per-user claim gate (061d), and privacy / visibility controls / data retention + erasure (061e).

---

## Goals

- A **hosted, authenticated, multi-tenant admin web app**, separate from the loopback dashboard, where an authorized admin views ROI **across orgs** with per-org / per-team / per-user leaderboards.
- A **cross-org admin authorization model** (061a) that answers "who is an admin", "org-scoped vs cross-org reporting", and "what entitlement permits a read that steps outside a single tenant partition", the partition-crossing seam, fenced explicitly rather than by the local `read_policy` (which fails closed to own-data).
- An **aggregation read API** (061b) over the shared `roi_metrics` + `teams` tables: org / team / user / project / time rollups as read-time `GROUP BY`s, with **allocated-vs-measured surfaced** (never blended silently), pagination, and an optional future `roi_rollup_daily` pre-aggregate noted as **deferred**.
- A **hosted frontend** (061c): org / team / user dashboards and leaderboards, a **separate hosted app** that reuses the design-system tokens/components where feasible but is explicit about where it **diverges** (auth, multi-tenant, hosting).
- **Per-user gating** (061d): leaderboards that involve `user_id` are **inert until the verified backend claim lands**; the surface degrades to org/team reporting and never shows a self-asserted person.
- A **privacy, visibility, and retention/erasure regime** (061e): per-user spend is PII; the surface honors visibility controls and a GDPR-style erasure path against an **append-only** ledger (tombstone vs purge).

## Non-Goals

- **Replacing the local dashboard.** PRD-060's `/roi` loopback page remains the local surface; this is an **additional**, hosted, cross-org surface, not a migration of the local one.
- **A billing system.** Like PRD-060, this surface *reads* DeepLake's billing-derived cost (via the shared ledger's persisted figures) and *reports* a derived ROI; it does not invoice, charge, meter for charge, or reconcile against DeepLake's statements.
- **Inventing person identity.** Per-user reporting depends on the verified `backend-token` claim from the (separate) backend dependency; this PRD **consumes** it and gates on it, it does **not** build the identity backend or any self-asserted fallback.
- **Writing the spend ledger.** `roi_metrics` rows are written by the daemon at summary/skillify time ([PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md)); this surface is **read-only** over the ledger (roster/admin metadata aside, per 061a/061e).
- **A live pricing oracle or re-pricing engine.** Pricing and the measured/modeled/allocated split are settled upstream (060b/060c/060f); this surface reports the persisted figures and their `cost_basis`, it does not re-price.
- **Stored rollups in v1.** Aggregations are read-time `GROUP BY`s; the `roi_rollup_daily` pre-aggregate is an explicit **deferred** item (061b), not a v1 deliverable.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-061a-…-hosted-surface-and-admin-auth`](./prd-061a-hosted-roi-admin-surface-hosted-surface-and-admin-auth.md) | **The surface + the authorization spine.** The hosted app shell and the admin auth/access-control model: who is an admin, org-scoped vs cross-org reporting, and the **partition-crossing authorization seam**, the entitlement that permits a read outside a single tenant partition, fenced explicitly (not via the local `read_policy`, which fails closed to own-data). Heavy **auth-worker-bee + security-worker-bee** handoff. | Backlog |
| [`prd-061b-…-aggregation-read-api`](./prd-061b-hosted-roi-admin-surface-aggregation-read-api.md) | The **read API** over `roi_metrics`/`teams`: org / team / user / project / time rollups as read-time `GROUP BY`s, **allocated-vs-measured surfaced** (`cost_basis`, never silently blended), pagination, and the optional future **`roi_rollup_daily` pre-aggregate noted as deferred**. Read-only; no ledger writes. | Backlog |
| [`prd-061c-…-hosted-frontend`](./prd-061c-hosted-roi-admin-surface-hosted-frontend.md) | The **hosted frontend**: org / team / user dashboards + leaderboards. A **separate hosted app**, NOT the loopback dashboard; reuses the design-system tokens/components where feasible but **calls out the divergence** (auth, multi-tenant, hosting). | Backlog |
| [`prd-061d-…-per-user-claim-gating`](./prd-061d-hosted-roi-admin-surface-per-user-claim-gating.md) | The **per-user gate**: leaderboards involving `user_id` are **inert until the verified `backend-token` claim lands** (the dependency from [060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md)); the surface degrades to org/team reporting and never shows a self-asserted person. | Backlog |
| [`prd-061e-…-privacy-and-retention`](./prd-061e-hosted-roi-admin-surface-privacy-and-retention.md) | **Privacy, visibility controls, and data retention/erasure.** Per-user spend is PII; visibility controls on who sees whom; **GDPR-style erasure vs the append-only ledger** (tombstone-vs-purge). The privacy regime for the per-user-spend surface. | Backlog |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | A **hosted, authenticated** admin app exists, **separate from the loopback dashboard**; an unauthenticated request reaches **no** ROI data, and a test asserts the surface is not mounted on the local `mode === "local"` loopback host (it is its own app). |
| AC-2 | **The cross-org read is fenced by an explicit admin entitlement** (061a), not by the local `read_policy` chokepoint (which fails closed to own-data); a test asserts a non-admin / wrong-org principal **cannot** read another org's rows, and that the partition-crossing path is reachable **only** with the admin entitlement. |
| AC-3 | The **aggregation API** returns org / team / user / project / time rollups as read-time `GROUP BY`s over `roi_metrics`/`teams`, with **`cost_basis` surfaced per line** (measured vs allocated) and **never silently blended**; a test asserts a mixed-basis rollup is flagged (`COUNT(DISTINCT cost_basis) > 1`) rather than summed into one net. |
| AC-4 | **Per-user leaderboards are inert until the verified claim lands** (061d): with no `backend-token` claim, every `user_id` is `''` and the surface shows org/team reporting with a **"per-user requires verified login"** state, never a self-asserted (git-email/OS-user) name; a test asserts no per-user row is fabricated. |
| AC-5 | The hosted frontend (061c) is a **separate app** that reuses design-system tokens/components where feasible and **documents its divergences** (auth, multi-tenant, hosting); a test/inspection confirms it does not import the loopback dashboard's local-only page registry or assume loopback auth. |
| AC-6 | **Per-user spend is treated as PII** (061e): visibility controls gate who sees whose spend, and a **GDPR-style erasure** path exists against the **append-only** ledger via a defined **tombstone-or-purge** mechanism; a test asserts an erased user's spend is not returned by the aggregation API after erasure. |
| AC-7 | **Read-only over the ledger:** the surface performs **no** `roi_metrics` spend-row writes (roster/admin metadata aside per 061a/061e); a test asserts no write path to the spend ledger exists in this surface. |
| AC-8 | **Allocated cost is never presented as measured:** any per-team/per-user net resting on an allocated infra share carries its `cost_basis='allocated'` + `allocation_method` through the API to the UI; a test asserts the allocated net is labeled distinctly from a measured net end to end. |

---

## Data model changes

**Reuses [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md)'s `roi_metrics` + `teams` tables; this PRD adds no new spend-ledger table.**

- **`roi_metrics` (read):** the append-only spend ledger (060f) is the read source for every rollup; this surface reads it cross-org under the 061a admin entitlement and never writes a spend row.
- **`teams` (read, possibly write for roster admin):** the roster (060f) backs the team dimension. If admin-side roster authoring lands here (open question), it uses the existing **version-bumped** write path ([`appendVersionBumped`](../../../../src/daemon/storage/writes.ts)) on the existing table, additive, no new table.
- **Possible admin/visibility metadata (061a/061e):** an admin-principal / entitlement record and any visibility-control or erasure-tombstone state. If these need persistence they are **additive** (new tenant-scoped or admin-scoped columns/tables with DEFAULTs per `validateColumnDefs`, [`types.ts`](../../../../src/daemon/storage/catalog/types.ts)), authored in the owning sub-PRD; this index does not pre-commit a shape.
- **Deferred `roi_rollup_daily` pre-aggregate (061b):** a future read-time-cost optimization, explicitly **not** built in v1; aggregations stay read-time `GROUP BY`s.

---

## API changes

**Unlike PRD-060 (loopback-only, no public surface), this PRD adds a real, authenticated, public hosted API.** This is the central new attack surface.

- **A new authenticated hosted aggregation API** (061b): cross-org / org / team / user / project / time rollup endpoints over `roi_metrics`/`teams`, returning `cost_basis`-tagged figures, paginated. Read-only over the spend ledger.
- **A new admin auth surface** (061a): the login/session and the **admin entitlement check** that fences the partition-crossing read; this is the seam every endpoint passes through, and it is the highest-risk surface in the ROI set.
- **No change to the loopback dashboard API.** PRD-060's `/api/diagnostics/roi*` loopback routes are unchanged; this is a parallel, hosted surface.
- **Per-user endpoints are claim-gated** (061d): endpoints that key on `user_id` return the inert/empty state until the verified `backend-token` claim is available.

---

## Open questions

- [ ] **The cross-org authorization model (gating, security-critical).** What grants the admin entitlement that permits a partition-crossing read, who can hold it (a Honeycomb-internal super-admin? a customer org-owner scoped to their own org only? a reseller across a set of orgs?), and how is it represented and checked so it cannot be confused with the local `read_policy` (which fails closed to own-data)? This is the spine of 061a and the single highest-risk decision in the set, **escalate to auth-worker-bee + security-worker-bee** before any cross-org read ships.
- [ ] **The verified backend user-claim dependency (inherited from 060f).** Per-user leaderboards are inert until a verified `backend-token` claim exists; what backend issues it, what is its shape, and when does it land? Until then PRD-061 ships **org/team reporting only**. (061d.)
- [ ] **Hosting / deploy target.** Where does this hosted app run (Honeycomb-operated SaaS? customer-self-hosted? a managed control plane?), and how does it reach the shared DeepLake tables (direct DeepLake SQL with an admin-scoped credential? a Honeycomb-operated API tier?)? The hosting choice drives the credential model and the partition-crossing trust boundary. (061a/061c.)
- [ ] **Privacy / erasure on an append-only ledger.** Per-user spend is PII; a GDPR-style erasure cannot UPDATE/DELETE a single field on an append-only ledger. Tombstone (append a redaction row the read honors) vs purge (out-of-band hard delete), retention windows, and who is the data controller vs processor across orgs? (061e; ties to 060f's surfaced erasure question.)
- [ ] **Org-scoped vs cross-org default.** Is the common case an **org-owner** seeing only their own org (a single-partition read that the local `read_policy` could almost serve) vs a **cross-org** super-admin (the genuinely partition-crossing case)? The answer shapes whether 061a is one entitlement with a scope or two distinct roles. (061a.)
- [ ] **Allocated-net presentation across orgs.** Per-user/team nets rest on an allocated infra share (060f); how is `allocation_method` surfaced in a cross-org leaderboard so comparisons between orgs with different allocation methods are not misleading? (061b/061c.)
- [ ] **Roster authoring home.** Does team-roster authoring live in this hosted surface (admin-side) or stay with the local surface / a CLI (060f open question)? If here, 061a's auth model must also gate roster writes. (061a/060f.)
- [ ] **Leaderboard ethics / opt-out.** A per-user spend leaderboard can be a surveillance surface; does an org or a user get an opt-out, and is a leaderboard rank ever shown without consent? (061e owns the policy; surfaced here.)

---

## Related

- **[PRD-060: ROI Tracker](../prd-060-roi-tracker/prd-060-roi-tracker-index.md)** · **[PRD-060f: Shared Spend Ledger + Teams Roster](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md)**, the local surface and the shared `roi_metrics` + `teams` data foundation this hosted surface reads; PRD-061 deliberately flips PRD-060's local-only Non-Goal and shares 060f's per-user backend-claim dependency.
- [PRD-011: Tenancy and Auth](../../completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md), the tenant-scope model and the `read_policy` authorization chokepoint ([`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts)) that fails **closed** to own-data, the exact boundary this cross-org surface must step outside under an explicit admin entitlement.
- [PRD-049: Multi-Project and Context Switching](../../completed/prd-049-multi-project-and-context-switching/prd-049-multi-project-and-context-switching-index.md), the `project_id` dimension the rollups expose.
- [Org / Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md), the tenancy model the cross-org admin entitlement reasons over.
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md), the auth foundation the new admin auth surface (061a) builds on; the org-bound DeepLake token that is precisely why there is no person identity today.
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md) · [Trust Boundaries](../../../knowledge/private/security/trust-boundaries.md) · [Credential Storage](../../../knowledge/private/security/credential-storage.md), the partition discipline, egress posture, and credential-isolation rules the cross-org read and the hosted credential model must respect.
- **Auth + security + privacy handoffs (surfaced prominently, not authored here):** the cross-org authorization seam (061a, **auth-worker-bee + security-worker-bee**), the per-user-spend PII + erasure regime (061e, **security-worker-bee**), and the verified-claim consumption path (061d). This is the **highest-risk surface in the ROI set**, it crosses the partition boundary every other table sits behind. Per house process, `security-worker-bee` runs **penultimate** and `quality-worker-bee` **last** before merge on each implementing branch; this index surfaces the handoffs, it does not author the audits.
- Code touchpoints: [`src/daemon/storage/catalog/tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts) (the shared `roi_metrics`/`teams` tables, read here) · [`src/daemon/runtime/recall/scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts) (the local chokepoint this surface deliberately steps outside) · [`src/daemon/storage/writes.ts`](../../../../src/daemon/storage/writes.ts) (`appendVersionBumped` if roster admin lands here) · [`src/daemon/storage/sql.ts`](../../../../src/daemon/storage/sql.ts) (guards) · [`src/daemon/storage/catalog/types.ts`](../../../../src/daemon/storage/catalog/types.ts) (`validateColumnDefs` for any additive admin/visibility metadata).
