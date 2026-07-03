# PRD-061a: Hosted Surface + Admin Auth / Access-Control Model

> **SUPERSEDED (2026-07-03):** Cloud fleet/team management now belongs to Queen, the fleet orchestrator. The canonical copy of this document lives at `queen/library/requirements/backlog/prd-009-hosted-roi-admin-surface/prd-009a-hosted-roi-admin-surface-hosted-surface-and-admin-auth.md`. This copy is retained for history only; do not update it here.

> **Parent:** [PRD-061](./prd-061-hosted-roi-admin-surface-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P2, **security-critical** (the authorization spine; the partition-crossing seam is the highest-risk decision in the ROI set)
> **Schema changes:** Possibly additive, an admin-principal / entitlement record and any session state. Additive only, with DEFAULTs per `validateColumnDefs` ([`types.ts`](../../../../src/daemon/storage/catalog/types.ts)); no new spend-ledger table.

---

## Overview

This is the **surface plus its authorization spine**, and the authorization spine is the reason PRD-061 is its own PRD. The hosted app is an **authenticated, multi-tenant** web app, separate from the loopback dashboard, and every byte of ROI data it serves passes through one question: **is this principal allowed to read across the tenant partition?**

Every other read in Honeycomb answers a *narrower* question through the `read_policy` chokepoint ([`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts)): own-data (`isolated`), workspace-wide (`shared`), or same-group (`group`), and it **fails closed** to own-data when membership is unresolved, rendering only the membership it is given. That chokepoint is **structurally incapable** of, and must never be repurposed for, a cross-org read. A cross-org admin read steps **outside** a single org/workspace partition, the exact thing the chokepoint exists to prevent. So this sub-PRD introduces a **separate, explicit admin entitlement** that fences the partition-crossing read, and the central design ruling is **how that entitlement is defined, who can hold it, and how it is checked so it can never be confused with or satisfied by the local `read_policy`.**

The model must distinguish (at least) two principal shapes, and the open question is whether they are one entitlement-with-scope or two roles:

> **Org-scoped admin (the common case):** an org-owner who sees only **their own** org's ROI across that org's devices/teams/users. This is a single-partition read, almost what `read_policy` `shared` already does, but served through the hosted surface.
> **Cross-org admin (the genuinely dangerous case):** a principal who reads **across** orgs (a Honeycomb-internal super-admin, or a reseller scoped to a defined set of orgs). This is the partition-crossing read, and it is the one that must be impossible to reach without the explicit entitlement.

Because Honeycomb has **no person identity today** (the DeepLake token is org-bound; `author` = `agent_id` = the machine), this surface needs a **real auth foundation** ([Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)), not the org-bound token, to know *which human* is the admin. That is itself a dependency, and it is closely related to (but not the same as) the per-user `backend-token` claim that gates leaderboards (061d): an admin must authenticate as a person even while per-user *reporting* stays gated.

This sub-PRD owns the surface shell and the auth/entitlement model; the read API is 061b, the frontend is 061c, the claim gate is 061d, the privacy regime is 061e. It carries a **heavy auth-worker-bee + security-worker-bee handoff**, the partition-crossing seam is exactly the kind of authorization boundary those audits exist for.

## Goals

- A **hosted, authenticated** app shell, separate from the loopback dashboard (not mounted on the `mode === "local"` host), into which 061b's API and 061c's frontend plug.
- An **explicit admin entitlement** that fences the partition-crossing read, **distinct from** the local `read_policy` chokepoint and impossible to satisfy by it.
- A **principal model** distinguishing org-scoped admin (own-org only) from cross-org admin (a defined set of orgs / super-admin), with the cross-org path reachable **only** with the explicit entitlement.
- A **real person-auth foundation** for the admin (built on [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)), separate from the org-bound DeepLake token, so the surface knows which human is acting.
- **Fail-closed by construction:** an unauthenticated request reaches no ROI data; an authenticated non-admin reaches no cross-org data; an org-scoped admin reaches only their org.
- A **clean security handoff:** the entitlement check is the single seam every endpoint passes through, auditable in one place (the posture mirror of how `scope-clause.ts` is the one chokepoint for local reads).

## Non-Goals

- **Reusing the local `read_policy` for cross-org reads.** The chokepoint fails closed to own-data and must not be widened; the cross-org entitlement is a separate mechanism.
- **Building the per-user identity backend.** The admin authenticates as a person, but the per-user *reporting* claim (`backend-token`) is the 060f/061d dependency, not built here.
- **The read API and the frontend.** 061b owns the aggregation endpoints; 061c owns the UI. This sub-PRD owns the shell + the entitlement seam they pass through.
- **The privacy/erasure regime.** 061e owns visibility controls and erasure; this sub-PRD owns who-can-read-across-the-partition, not what-must-be-hidden-or-erased.
- **Choosing the hosting/credential topology unilaterally.** The hosting target (SaaS vs self-hosted vs control plane) and the admin-scoped credential that reaches the shared DeepLake tables are an open question here, decided with security-worker-bee.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | The hosted app is **authenticated and separate from the loopback dashboard**; a test asserts it is **not** mounted on the `mode === "local"` loopback host and that an unauthenticated request reaches **no** ROI data. |
| a-AC-2 | A **cross-org read requires an explicit admin entitlement** that is **distinct from** the local `read_policy`; a test asserts the partition-crossing path is **unreachable** without the entitlement and that no `read_policy` value (`isolated`/`shared`/`group`) can satisfy it. |
| a-AC-3 | The **principal model distinguishes org-scoped from cross-org admin**; a test asserts an org-scoped admin reads **only** their own org's rows and a cross-org admin reads only the orgs its entitlement names (never "all orgs" by accident). |
| a-AC-4 | A **non-admin authenticated principal** reaches **no** admin data; a test asserts a logged-in non-admin gets a fail-closed (empty/forbidden) result, never another org's or another user's spend. |
| a-AC-5 | The **entitlement check is a single seam** every endpoint passes through (the cross-org analogue of the one local chokepoint); a test/inspection asserts every aggregation endpoint (061b) routes through it and none bypasses it. |
| a-AC-6 | The admin **authenticates as a person** via the real auth foundation ([auth-architecture.md](../../../knowledge/private/auth/auth-architecture.md)), **not** the org-bound DeepLake token; a test asserts the org-bound token alone cannot grant admin access. |
| a-AC-7 | **Credential isolation:** any admin-scoped credential that reaches the shared DeepLake tables is held only by the hosted backend, never the frontend (parity with the daemon-sole-egress posture of PRD-060); a test asserts no DeepLake credential reaches the 061c client. |

## Files touched

- New hosted-app shell + auth module (location depends on the hosting decision below; a new hosted backend service, not the loopback daemon dashboard).
- The admin-entitlement check module, the single partition-crossing seam every 061b endpoint passes through.
- Reads the shared `roi_metrics` / `teams` tables ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts), 060f) under the entitlement, never via the local [`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts) chokepoint.
- Any additive admin-principal / entitlement persistence (additive columns/table with DEFAULTs, `validateColumnDefs`, [`types.ts`](../../../../src/daemon/storage/catalog/types.ts)); SQL interpolation through the guards ([`sql.ts`](../../../../src/daemon/storage/sql.ts)).
- Tests: unauth→no-data, cross-org-requires-entitlement, org-scoped-only-own-org, non-admin-fail-closed, single-seam coverage, person-auth-not-org-token, no-creds-in-client.

## Open questions

- [ ] **Who can hold the cross-org entitlement (gating, security-critical).** Honeycomb-internal super-admin only? A customer org-owner scoped to their own org? A reseller across a named set of orgs? And is this **one entitlement with a scope** or **two distinct roles** (org-admin vs cross-org-admin)? This is the single highest-risk ruling in the ROI set, **escalate to auth-worker-bee + security-worker-bee.**
- [ ] **Hosting / deploy + credential topology.** Honeycomb-operated SaaS, customer-self-hosted, or a managed control plane, and how does the backend reach the shared DeepLake tables (direct admin-scoped DeepLake SQL credential? a Honeycomb-operated API tier in front)? The hosting choice drives the credential model and the partition-crossing trust boundary. (security-worker-bee.)
- [ ] **Person-auth provider.** Which auth foundation does the admin person-auth use ([auth-architecture.md](../../../knowledge/private/auth/auth-architecture.md)), and how does it relate to the per-user `backend-token` claim (061d), same provider issuing both, or distinct? (auth-worker-bee.)
- [ ] **Audit logging of cross-org reads.** A partition-crossing read is sensitive enough that it likely needs its own audit trail (who read which org's data, when). Is that in scope here or in 061e's privacy regime?
- [ ] **Roster-write gating.** If admin-side `teams` roster authoring lands in this surface (060f/061 open question), the entitlement model must also gate roster **writes**, not just reads; confirm whether roster admin is in scope for 061a.

## Related

- [PRD-061](./prd-061-hosted-roi-admin-surface-index.md), the parent; this sub-PRD owns the authorization spine the whole surface rests on.
- [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md), the shared tables this surface reads cross-org under the entitlement.
- [PRD-061b](./prd-061b-hosted-roi-admin-surface-aggregation-read-api.md), the read API whose every endpoint passes through this entitlement seam.
- [PRD-061d](./prd-061d-hosted-roi-admin-surface-per-user-claim-gating.md), the per-user claim gate, related to but distinct from admin person-auth.
- [PRD-011: Tenancy and Auth](../../completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md) · [`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts), the local `read_policy` chokepoint that fails closed to own-data, the exact boundary this entitlement deliberately and explicitly steps outside.
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md) · [Org / Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md), the person-auth foundation and the tenancy model the entitlement reasons over.
- [Trust Boundaries](../../../knowledge/private/security/trust-boundaries.md) · [Credential Storage](../../../knowledge/private/security/credential-storage.md), the egress + credential-isolation discipline the hosted credential model must respect.
- **Security/quality handoff:** the partition-crossing entitlement is the highest-risk authorization boundary in the set; `security-worker-bee` (penultimate) audits the seam and the credential model, `quality-worker-bee` (last) verifies the build before merge. This sub-PRD surfaces the handoff; it does not author the audit.
