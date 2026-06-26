# PRD-061e: Privacy, Visibility Controls, and Data Retention / Erasure

> **Parent:** [PRD-061](./prd-061-hosted-roi-admin-surface-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P2, **privacy-critical** (per-user spend is PII; erasure on an append-only ledger is a genuine constraint)
> **Schema changes:** Possibly additive, visibility-control state and an erasure tombstone marker. Additive only, DEFAULTs per `validateColumnDefs` ([`types.ts`](../../../../src/daemon/storage/catalog/types.ts)); no new spend-ledger table.

---

## Overview

Once `user_id` is populated (061d), a `roi_metrics` row is **per-person spend**, and per-person spend is **PII**. A hosted, cross-org surface that shows who spent what is a privacy surface, and this sub-PRD owns its regime: **visibility controls** (who is allowed to see whose spend) and **data retention / erasure** (how a person's spend is removed on request).

The hard constraint is structural: **`roi_metrics` is append-only** ([060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md)). A GDPR-style "erase my data" request cannot be served by an UPDATE or a single-field DELETE, the ledger never mutates a row in place (a re-price *appends*; it never edits). So erasure must be one of two explicit mechanisms, and choosing between them is the central ruling:

> **Tombstone (append a redaction row the read honors).** Append a marker that the aggregation API (061b) reads as "exclude / null this user's identifying fields". Keeps the ledger append-only and auditable; the spend total may survive de-identified, but the **person link** is severed at read time. Risk: every reader must honor the tombstone, or the data leaks.
> **Purge (out-of-band hard delete).** A privileged, audited maintenance path that physically removes or rewrites the affected rows outside the normal append-only flow. Truly removes the data; breaks the append-only invariant and needs a tightly controlled, logged operator path.

The right answer depends on what "erasure" must legally guarantee (de-identification vs physical removal) and is a security-worker-bee + legal-shaped decision; this sub-PRD frames it and makes the open question explicit. It is **surfaced** in 060f (the ledger that holds the PII) and **authored** here (the regime that governs it).

Visibility is the other half: even before erasure, **not every admin should see every person's spend.** An org-scoped admin (061a) sees their org; a cross-org admin sees their entitled orgs; but within that, a per-user leaderboard can be a **surveillance surface**, so this sub-PRD owns the visibility-control policy (who sees whom, any per-user opt-out, whether a rank is ever shown without consent) that 061b enforces and 061c renders. The opt-out **composes** with 061d's claim gate: a user appears in a per-user view only if their `user_id` is **verified** (061d) **and** not opted-out (here).

## Goals

- A **visibility-control policy**: who is permitted to see whose per-user spend, layered on top of 061a's entitlement (entitlement says which *orgs*; visibility says which *people within them*).
- A **per-user opt-out** that composes with 061d's claim gate (appears only if verified **and** not opted-out), so a verified `user_id` can still be excluded from leaderboards.
- A **data-retention policy** for per-user spend (how long person-attributed rows are kept / shown).
- A **GDPR-style erasure path** against the **append-only** ledger via a defined **tombstone-or-purge** mechanism, with the aggregation API (061b) honoring it so erased data is not returned.
- A clear **controller / processor** framing across orgs (who is the data controller for a given person's spend), so the erasure path has an owner.

## Non-Goals

- **Mutating the append-only ledger in place.** Erasure is tombstone or out-of-band purge, never an in-place UPDATE/DELETE on the normal write path (which does not exist, 060f).
- **The entitlement model.** 061a owns which orgs an admin may read; this sub-PRD owns which people within them are visible and how erasure works.
- **The per-user claim gate.** 061d owns "is per-user live"; this sub-PRD owns "even when live, who is visible and how is a person erased".
- **Legal advice.** This sub-PRD frames the compliance requirement and the technical mechanism; the legal determination of what erasure must guarantee is a separate, human decision (legal-docs-worker-bee / counsel).
- **Rendering.** 061c renders the controls; this sub-PRD authors the policy they enforce.

## Acceptance criteria

| ID | Criterion |
|---|---|
| e-AC-1 | A **visibility-control policy** governs who sees whose per-user spend, layered on 061a's entitlement; a test asserts a principal without visibility for a given person gets no per-user row for them, even within an org they may read. |
| e-AC-2 | A **per-user opt-out composes with 061d's gate**: a user appears in a per-user view only if their `user_id` is **verified** (061d) **and** not opted-out; a test asserts an opted-out verified user is excluded from leaderboards. |
| e-AC-3 | A **GDPR-style erasure path** exists against the append-only ledger via a defined **tombstone-or-purge** mechanism; a test asserts the aggregation API (061b) **does not return** an erased user's per-user spend after erasure. |
| e-AC-4 | **No in-place mutation of the normal write path:** a test/inspection asserts erasure does **not** UPDATE/DELETE a `roi_metrics` row on the append-only flow (tombstone appends a marker, or purge is a separate audited out-of-band path). |
| e-AC-5 | A **retention policy** for person-attributed spend is defined and enforced (kept/shown for a bounded window or per policy); a test asserts rows past the policy are not surfaced per-user. |
| e-AC-6 | The **controller/processor** framing is documented per the cross-org model, so an erasure request has a defined owner and path; an inspection confirms the ownership is stated. |

## Files touched

- The visibility-control + opt-out policy module (enforced by 061b, rendered by 061c).
- The erasure mechanism: a tombstone marker the read honors (additive state via the version-bumped / append path, [`writes.ts`](../../../../src/daemon/storage/writes.ts)) **or** a privileged, audited out-of-band purge path; decision in the open question below.
- Reads/affects `roi_metrics.user_id` ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts), 060f); any additive visibility/tombstone state with DEFAULTs (`validateColumnDefs`, [`types.ts`](../../../../src/daemon/storage/catalog/types.ts)); SQL through the guards ([`sql.ts`](../../../../src/daemon/storage/sql.ts)).
- Tests: visibility scoping, opt-out ∘ claim-gate composition, erasure-then-not-returned, no-in-place-mutation, retention enforcement, controller/processor documented.

## Open questions

- [ ] **Tombstone vs purge (the central ruling).** Does legal "erasure" require **de-identification** (tombstone, sever the person link, keep de-identified totals, stay append-only and auditable) or **physical removal** (purge, out-of-band hard delete, breaks the invariant, needs a tightly controlled operator path)? This is a security + legal decision; the technical mechanism follows from it. (security-worker-bee + legal-docs-worker-bee / counsel.)
- [ ] **Controller vs processor across orgs.** For a given person's spend visible to a cross-org admin, who is the data controller (the person's org? Honeycomb? the reseller?) and who is the processor? This determines who owns the erasure obligation. (legal.)
- [ ] **Audit trail for erasure + cross-org reads.** Does an erasure (and a cross-org read, 061a) need an immutable audit log, and where does *that* live without becoming a second PII store? (security-worker-bee.)
- [ ] **Default visibility.** Is per-user spend visible to an org-admin by default (opt-out) or hidden by default (opt-in)? The default sets the privacy posture of the whole leaderboard feature. (Composes with 061d.)
- [ ] **Retention window.** How long is person-attributed spend retained/shown, and is the window org-configurable or fixed? Interacts with 060f's re-price retention question.
- [ ] **De-identified survival after tombstone.** If tombstoning keeps de-identified org/team totals (so org ROI is not distorted by an erasure), confirm that the de-identified remainder cannot be re-linked to the person. (security-worker-bee.)

## Related

- [PRD-061](./prd-061-hosted-roi-admin-surface-index.md), the parent.
- [PRD-060f](../prd-060-roi-tracker/prd-060f-roi-tracker-shared-spend-ledger.md), the append-only ledger that holds the per-user PII; surfaces this erasure question, which this sub-PRD authors.
- [PRD-061a](./prd-061a-hosted-roi-admin-surface-hosted-surface-and-admin-auth.md), the entitlement (which orgs) this visibility policy (which people) layers on.
- [PRD-061b](./prd-061b-hosted-roi-admin-surface-aggregation-read-api.md), the API that enforces visibility + honors the erasure tombstone.
- [PRD-061c](./prd-061c-hosted-roi-admin-surface-hosted-frontend.md), the frontend that renders the visibility controls and the opt-out.
- [PRD-061d](./prd-061d-hosted-roi-admin-surface-per-user-claim-gating.md), the claim gate the opt-out composes with (verified **and** not-opted-out).
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md) · [Trust Boundaries](../../../knowledge/private/security/trust-boundaries.md), the visibility + boundary discipline this regime extends to per-user PII.
- **Security/privacy + quality handoff:** per-user spend is PII and erasure on an append-only ledger is a genuine constraint; `security-worker-bee` (penultimate) audits the visibility + erasure mechanism (with legal/counsel for the compliance determination), `quality-worker-bee` (last) before merge. This sub-PRD authors the regime; it surfaces, and does not own, the legal determination.
