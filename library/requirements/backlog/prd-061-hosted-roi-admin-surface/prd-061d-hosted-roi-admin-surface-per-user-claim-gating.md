# PRD-061d: Per-User Gating on the Verified Backend User-Claim

> **Parent:** [PRD-061](./prd-061-hosted-roi-admin-surface-index.md)
> **Status:** Backlog, draft (2026-06-26), **blocked on an external backend dependency**
> **Priority:** P2 (the gate that keeps per-user leaderboards honest; inert until the dependency lands)
> **Schema changes:** None. Consumes `roi_metrics.user_id` (060f) and the verified `backend-token` claim.

---

## Overview

This sub-PRD owns one rule and its consequences: **per-user reporting is inert until a verified backend user-claim exists, and there is no spoofable fallback.** It is the hosted-surface face of the gate that [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md) builds into the write path.

The hard fact underneath is that **Honeycomb has no person identity today.** The DeepLake token is **org-bound**: `author` = `agent_id` = the machine. There is no verified human behind a write, and therefore no honest way to attribute spend to a person yet. `roi_metrics.user_id` is populated **only** when `verifiedClaim?.source === 'backend-token'`, and is `''` otherwise, with **no** git-email / `$USER` / OS-login fallback (those are trivially spoofable and would poison a cross-org leaderboard) and **no** historical backfill (rows written before the claim stay `''` forever).

The consequence for this hosted surface is direct: **every per-user leaderboard and per-user rollup is inert until the claim lands.** Until then:

> The surface ships **org and team reporting**, which work the day the shared ledger has data (team via the `teams` roster's `agent` member rows, [060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md)).
> Per-user views render a **"per-user requires verified login"** empty state, never a `user_id=''` bucket dressed up as a person, and never a self-asserted name.

When the backend claim **does** land, per-user lights up **forward-only**: attribution begins the day verified claims begin; pre-claim spend is never retroactively assigned. This sub-PRD does **not** build the identity backend, it **consumes** the claim and enforces the gate; the backend that issues the verified `backend-token` claim is the external dependency this PRD is blocked on, and is also relevant to 061a's admin person-auth (an admin authenticates as a person even while per-user reporting stays gated, the two are related but distinct).

## Goals

- **Enforce the per-user gate on the hosted surface:** per-user rollups/leaderboards (061b/061c) are available **only** when the verified `backend-token` claim is present and `user_id` is populated.
- **No spoofable fallback:** never attribute spend to a git-email / `$USER` / OS-login or any client-asserted identity; the gate is exactly `user_id = verifiedClaim?.source === 'backend-token' ? claim.userId : ''`.
- **Graceful degradation to org/team:** with no claim, the surface is fully useful for org and team reporting and shows a clear per-user empty state, never a fabricated person.
- **Forward-only activation:** when the claim lands, per-user begins from that point; **no** historical backfill of pre-claim rows.
- **A single availability signal** the API (061b) and frontend (061c) read, so "is per-user live" is decided in one place, not re-derived per view.

## Non-Goals

- **Building the person-identity backend.** The backend that issues the verified `backend-token` claim is an external dependency; this sub-PRD consumes it.
- **Self-asserted identity of any kind.** Explicitly rejected as a `user_id` source.
- **Backfilling historical rows.** Pre-claim `user_id=''` rows stay unattributed.
- **The write path.** 060f writes (or does not write) `user_id`; this sub-PRD gates the **read/report** side on the hosted surface.
- **Admin person-auth.** 061a owns the admin's person-auth; this gate is about per-user *reporting*, which stays inert even for an authenticated admin until the claim exists.

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | With **no verified `backend-token` claim** (the state today), every per-user rollup/leaderboard is **inert**; a test asserts the surface shows org/team reporting + a **"per-user requires verified login"** empty state and **no** per-user row. |
| d-AC-2 | **No spoofable fallback:** a test asserts the surface never attributes spend to a git-email / `$USER` / OS-login / client-asserted identity, and that a `user_id=''` bucket is **never** rendered as a person. |
| d-AC-3 | When the claim **is** present, per-user lights up using **only** `user_id` values populated from `verifiedClaim.source === 'backend-token'`; a test asserts only verified-claim `user_id`s appear. |
| d-AC-4 | **Forward-only:** a test asserts pre-claim rows (`user_id=''`) are **not** retroactively attributed when a claim later arrives, no historical backfill. |
| d-AC-5 | A **single per-user availability signal** drives the API (061b) and frontend (061c); a test asserts both read the same flag and neither re-derives availability independently. |

## Files touched

- The per-user availability check + the gate logic, consumed by 061b (endpoints) and 061c (views).
- Reads `roi_metrics.user_id` ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts), 060f) and the verified `backend-token` claim (from the external dependency / 061a's person-auth context).
- Tests: inert-without-claim, no-spoofable-fallback, only-verified-user_ids, forward-only-no-backfill, single-availability-signal.

## Open questions

- [ ] **The verified backend user-claim (the dependency, gating).** What backend issues the `backend-token` claim, what is its shape/validation, and when does it land? This PRD is **blocked** on it for per-user; org/team ship without it. (auth-worker-bee + security-worker-bee; shared with [060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md) and [061a](./prd-061a-hosted-roi-admin-surface-hosted-surface-and-admin-auth.md).)
- [ ] **Claim ↔ admin-auth relationship.** Is the `backend-token` per-user claim issued by the same provider as 061a's admin person-auth, or distinct? Can an admin be identified while per-user reporting is still gated (yes, by design), and does that asymmetry need surfacing in the UI? (061a.)
- [ ] **Partial-claim coverage.** Once claims exist, some rows will have `user_id` and older ones `''`. How does a per-user leaderboard present the unattributed remainder (an "unattributed" bucket? hidden?) without implying the `''` rows belong to one person? (061c.)
- [ ] **Opt-out interaction.** If 061e gives users an opt-out, a verified `user_id` may still need to be excluded from leaderboards; confirm the gate and the opt-out compose (verified **and** not-opted-out). (061e.)

## Related

- [PRD-061](./prd-061-hosted-roi-admin-surface-index.md), the parent.
- [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md), builds the same gate into the write path (`user_id` populated only from the verified claim, no fallback, no backfill).
- [PRD-061a](./prd-061a-hosted-roi-admin-surface-hosted-surface-and-admin-auth.md), the admin person-auth, related to but distinct from this per-user reporting gate.
- [PRD-061b](./prd-061b-hosted-roi-admin-surface-aggregation-read-api.md) · [PRD-061c](./prd-061c-hosted-roi-admin-surface-hosted-frontend.md), the API and frontend that honor this availability signal.
- [PRD-061e](./prd-061e-hosted-roi-admin-surface-privacy-and-retention.md), the opt-out/visibility controls that compose with this gate.
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md), the org-bound DeepLake token that is precisely why there is no person identity today.
- **Security/quality handoff:** the gate must never leak a `user_id=''` bucket as a person or accept a spoofable identity; `security-worker-bee` (penultimate) then `quality-worker-bee` (last) before merge. Surfaced, not authored here.
