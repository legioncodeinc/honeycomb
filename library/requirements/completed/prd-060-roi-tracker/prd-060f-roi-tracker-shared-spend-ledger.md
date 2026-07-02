# PRD-060f: Shared Spend Ledger + Teams Roster

> **Parent:** [PRD-060](./prd-060-roi-tracker-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P1 (turns the device-local ROI numbers into a cross-device, per-org/team rollup; the data foundation the local dashboard and the hosted surface ([PRD-061](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md)) both read)
> **Schema changes:** Additive. Two **new tenant-scoped DeepLake tables**, `roi_metrics` (append-only) and `teams` (version-bumped), co-located with the telemetry-class tenant tables in [`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts). Every NOT NULL column carries a DEFAULT (additive-heal requirement).

---

## Overview

Sub-PRDs 060a-060e compute the ROI ledger from **device-local** data, the captured token columns live on the `sessions` group, and the page reads whatever this one machine recorded. That makes the headline number **device-specific**: it cannot answer "what did this org save", "which team is getting the most lift", or "roll this up across all my machines". This sub-PRD pushes the spend record into a **shared DeepLake table** so ROI aggregates across devices and rolls up per-org, per-workspace, per-project, per-agent, and per-team, with per-user **gated** behind a backend dependency that does not exist yet.

The pivotal design decision, taken with [deeplake-dataset-worker-bee](../../../knowledge/private/data/deeplake-schema.md), is that the ledger is a **tenant-scoped** table, not an agent-scoped one. Rollups need **queryable identity columns** (`org_id`, `workspace_id`, `team_id`, ...), not just a partition header, so `roi_metrics` carries explicit `org_id` + `workspace_id` columns exactly like the existing `recall_qa_ledger` and `telemetry_counters` tenant tables ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts), `scope: "tenant"`). An agent-scoped table could not answer a cross-device org question.

The grain is **per-session, append-only**. At summary/skillify time a session writes **one immutable ROI row** via [`appendOnlyInsert`](../../../../src/daemon/storage/writes.ts) (the same primitive `sessions` and raw events use, heal-aware via `withHeal`). Daily and period rollups are **read-time `GROUP BY`**, never stored, there is no stored ledger of record (consistent with 060c's "the ledger is derived" posture). A re-price (rates changed, a correction) is an **append of a new row with a new `price_ref`**; the read resolves by `MAX(created_at)` per `session_id`. We **never UPDATE** a row, the append-only ledger must reconcile to the penny and must never be silently rewritten.

Two honesty rules from the schema design are load-bearing and become acceptance criteria:

> **Money is BIGINT cents, never float.** A ledger must reconcile to the penny. `telemetry_counters.value` is `FLOAT4`, but that is the wrong type for a ledger; every money column here is BIGINT integer cents, matching the integer-cents discipline 060b/060e already enforce at the daemon edge.
> **Measured, modeled, and allocated are SEPARATE, self-describing columns.** Measured cache savings (060b) and modeled memory-injection savings (060b) are distinct columns. DeepLake infra cost (060c) is only measured at **org/workspace** level and **cannot be split per-user or per-team**, so any per-team/user net uses an **allocated** infra share, marked `cost_basis = 'allocated'` with the `allocation_method` recorded. A rollup that mixes bases is **detectable** (`COUNT(DISTINCT cost_basis) > 1`), and the dashboard (060e) must render allocated net **distinctly** from measured net. The shared ledger must not let an allocated estimate masquerade as a measured fact, the same spine as 060b's measured-vs-modeled contract, extended to cost.

### The per-user gate (the central constraint)

Honeycomb has **no person identity today.** The DeepLake token is **org-bound**: `author` = `agent_id` = the machine, there is no verified human behind a write. Per-user rollups are therefore **designed for but inert**: `roi_metrics` and `teams` both carry a `user_id`/`member_id` column, but it is populated **only from a verified backend user-claim** and stays `''` (empty) until that backend dependency lands.

> **No self-asserted, spoofable fallback.** Git email, `$USER`, OS login, and any other client-asserted identity are **explicitly rejected** as `user_id` sources, they are trivially spoofable and would poison a cross-device, cross-org leaderboard. The gate is exactly: `user_id = verifiedClaim?.source === 'backend-token' ? claim.userId : ''`. There is **no historical backfill**, rows written before the claim lands stay `''` forever; per-user attribution begins the day verified claims begin.

Until the backend claim exists, every per-user rollup is **unavailable** (the local page shows a "per-user requires verified login" empty state, 060e; the hosted leaderboards are inert, [PRD-061d](../prd-061-hosted-roi-admin-surface/prd-061d-hosted-roi-admin-surface-per-user-claim-gating.md)). Per-**team** does **not** wait on this: `team_id` is resolved from the new `teams` roster at ROI-write time, and **agent** rows in the roster work today (a `member_type='agent'` row maps an `agent_id` to a `team_id`); **user** rows only become meaningful once `user_id` is verified.

This sub-PRD owns the **data foundation** (the two tables + the write path); 060b/060c/060d still own the math that produces the cents; 060e reads the shared ledger at org/workspace scope governed by `read_policy`. It surfaces, but does not author, the security/PII handoffs that the shared-spend posture raises.

---

## Goals

- **A new `roi_metrics` tenant-scoped table** ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts) neighbour, `scope: "tenant"`), append-only, one immutable row per session at summary/skillify time, with explicit `org_id` + `workspace_id` identity columns so cross-device org/workspace/project/agent/team rollups are queryable `GROUP BY`s.
- **A new `teams` roster table** (also `scope: "tenant"`), **version-bumped** writes ([`appendVersionBumped`](../../../../src/daemon/storage/writes.ts)), one row per (team, member); `member_type` is an `'agent'|'user'` union so agent rows work today and user rows light up once `user_id` is verified.
- **Money as BIGINT cents** in every cost/savings column, never float; the ledger reconciles to the penny.
- **Measured / modeled / allocated as separate, self-describing columns:** measured cache savings, modeled savings + `modeled_assumption_ref`, gross cost, infra cost, `cost_basis` (`'measured'|'allocated'|'none'`), and `allocation_method`, so an allocated infra share is never read as a measured fact and a mixed-basis rollup is detectable.
- **The per-user gate:** a `user_id` column populated **only** from a verified `backend-token` claim, `''` otherwise, with **no** git-email/OS-user fallback and **no** historical backfill.
- **`team_id` resolved at ROI-write time** by a roster lookup against `teams`; `''` when the writing agent is unassigned.
- **The write path** appends one row per session under the active `QueryScope`, via [`appendOnlyInsert`](../../../../src/daemon/storage/writes.ts) + `withHeal`, with every interpolated value routed through the typed SQL guards ([`sqlStr`/`sqlLike`/`sqlIdent`](../../../../src/daemon/storage/sql.ts)).
- **Additive-heal safety:** every NOT NULL column has a DEFAULT (`validateColumnDefs`, [`types.ts`](../../../../src/daemon/storage/catalog/types.ts)); a legacy dataset without these tables/columns heals additively and the daemon boots, never a destructive migration.
- **Re-price by append, never UPDATE:** a corrected price appends a new row with a new `price_ref`; the canonical row per `session_id` is `MAX(created_at)`.
- **Indexing for rollups:** lookup indexes on `org_id`, `workspace_id`, `team_id`, `period_start`, then drill-down columns; **no BM25, no vector** (this is a ledger, not a search corpus).

## Non-Goals

- **No hosted or cross-org read.** This sub-PRD lands the **tables and the write path** and the **local** org/workspace-scoped read (consumed by 060e). The authenticated, cross-org, partition-crossing read is **[PRD-061](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md)** and is explicitly out of scope here.
- **No per-user attribution before the backend claim.** The `user_id` column ships, but populating it depends on a verified backend user-claim that does not exist yet; until then per-user is inert by construction. This sub-PRD does **not** build that backend.
- **No self-asserted identity.** Git email, `$USER`, OS login, and any client-asserted person identity are rejected as `user_id` sources.
- **No stored rollups.** Daily/period aggregates are read-time `GROUP BY`; an optional pre-aggregate (`roi_rollup_daily`) is noted as deferred and lives with the hosted aggregation API ([PRD-061b](../prd-061-hosted-roi-admin-surface/prd-061b-hosted-roi-admin-surface-aggregation-read-api.md)), not here.
- **No embedding/JSONB column.** `roi_metrics` is a flat, typed, numeric ledger; no `FLOAT4[]` vector and no JSONB blob.
- **No re-architecture of capture or the cost engines.** 060a still captures tokens; 060b/060c/060d still produce the cents. This sub-PRD persists the *result* of that math as a shared, queryable row.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| f-AC-1 | A new **`roi_metrics`** table is defined with **`scope: "tenant"`** and explicit `org_id` + `workspace_id` columns, co-located with `telemetry_counters`/`recall_qa_ledger` in [`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts); a test asserts it is tenant-scoped (not agent-scoped) and that `org_id`/`workspace_id` are queryable columns, not just partition header. |
| f-AC-2 | `roi_metrics` is **append-only**: exactly **one immutable row per session** is written via [`appendOnlyInsert`](../../../../src/daemon/storage/writes.ts) at summary/skillify time; a test asserts no UPDATE path exists and that a re-price **appends** a new row (new `price_ref`) rather than mutating the prior one. |
| f-AC-3 | The canonical row per `session_id` resolves by **`MAX(created_at)`**; a test asserts that with two rows for one `session_id` (original + re-price) the read picks the latest, and that the original is retained (auditable, not deleted). |
| f-AC-4 | **All money columns are BIGINT integer cents** (`measured_cache_savings_cents`, `modeled_savings_cents`, `gross_cost_cents`, `infra_cost_cents`); a test asserts no FLOAT money column and no float-cents on the write path. |
| f-AC-5 | **Measured / modeled / allocated are separate columns:** `measured_cache_savings_cents`, `modeled_savings_cents` + `modeled_assumption_ref`, and `cost_basis` (`'measured'|'allocated'|'none'`) + `allocation_method`; a test asserts a per-team/user row whose infra share is allocated carries `cost_basis='allocated'` and a non-empty `allocation_method`, and a mixed-basis rollup is detectable via `COUNT(DISTINCT cost_basis) > 1`. |
| f-AC-6 | **The per-user gate:** `user_id` is set **only** when `verifiedClaim?.source === 'backend-token'`, `''` otherwise; a test asserts that with no verified claim (the state today) every written `user_id` is `''`, and that git-email / `$USER` / OS-login are **never** consulted as a fallback. |
| f-AC-7 | **No historical backfill:** a test asserts rows written before a verified claim retain `user_id = ''` and are not retroactively populated when a claim later arrives. |
| f-AC-8 | A new **`teams`** roster table is defined with **`scope: "tenant"`** and **version-bumped** writes ([`appendVersionBumped`](../../../../src/daemon/storage/writes.ts)), one row per (team, member), with a `member_type` `'agent'|'user'` union; a test asserts an `agent` member row resolves a `team_id` for an `agent_id` today, and that a `user` member row is structurally valid but inert until `user_id` is verified. |
| f-AC-9 | **`team_id` is resolved at ROI-write time** by a roster lookup against `teams` for the writing `agent_id`; a test asserts an assigned agent's `roi_metrics` row carries the resolved `team_id` and an unassigned agent's row carries `''` (never throws, fail-soft to unassigned). |
| f-AC-10 | **Additive-heal safety:** every NOT NULL column has a DEFAULT (`validateColumnDefs`, [`types.ts`](../../../../src/daemon/storage/catalog/types.ts)); a test asserts both tables heal additively onto a legacy dataset and that a missing table/column degrades the ROI read to "shared ledger absent" rather than throwing, the daemon boots either way. |
| f-AC-11 | **SQL-guarded writes:** every interpolated value on the write/roster-lookup path routes through [`sqlStr`/`sqlLike`/`sqlIdent`](../../../../src/daemon/storage/sql.ts) under the active `QueryScope`; a test asserts no raw string interpolation reaches the query. |
| f-AC-12 | **Rollup indexing only:** lookup indexes exist on `org_id`, `workspace_id`, `team_id`, `period_start` (and drill-down `project_id`/`user_id`); a test/inspection asserts **no `deeplake_index` BM25 and no vector index** on either table. |
| f-AC-13 | **Local read at org/workspace scope governed by `read_policy`:** the 060e read of `roi_metrics` is scoped through the existing authorization chokepoint ([`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts), `isolated`/`shared`/`group`); a test asserts an `isolated` policy never returns another agent's ROI rows and a `shared` policy returns workspace-wide rows. |

---

## Data model changes

**Additive only. Two new tenant-scoped DeepLake tables. No destructive migration. Every NOT NULL column has a DEFAULT.**

### `roi_metrics`, append-only spend ledger (`scope: "tenant"`)

One immutable row per session, written at summary/skillify time via [`appendOnlyInsert`](../../../../src/daemon/storage/writes.ts). Co-located with the telemetry-class tenant tables in [`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts) for reviewer locality.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Row id. |
| `session_id` | TEXT | The session this ROI row prices; re-price appends a new row with the same `session_id`. |
| `org_id` | TEXT | Identity column (queryable), not just partition header. |
| `workspace_id` | TEXT | Identity column (queryable). |
| `agent_id` | TEXT | DEFAULT `'default'`; the writing machine. |
| `project_id` | TEXT | Multi-project scope ([PRD-049](../../completed/prd-049-multi-project-and-context-switching/prd-049-multi-project-and-context-switching-index.md)); `''` when none. |
| `team_id` | TEXT | FK to `teams.team_id`; `''` = unassigned. Resolved by roster lookup at write time. |
| `user_id` | TEXT | **GATED.** `''` until a verified `backend-token` claim populates it. No fallback, no backfill. |
| `input_tokens` | BIGINT | Measured usage. |
| `output_tokens` | BIGINT | Measured usage. |
| `cache_read_tokens` | BIGINT | Measured usage (the measured-savings driver, 060a/060b). |
| `cache_creation_tokens` | BIGINT | Measured usage. |
| `measured_cache_savings_cents` | BIGINT | **MEASURED** (060b); integer cents. |
| `modeled_savings_cents` | BIGINT | **MODELED** (060b); integer cents. |
| `modeled_assumption_ref` | TEXT | Pointer to 060b's assumption data field; the one source the disclosure copy reads. |
| `gross_cost_cents` | BIGINT | Integer cents. |
| `infra_cost_cents` | BIGINT | Integer cents (060c). |
| `cost_basis` | TEXT | `'measured'｜'allocated'｜'none'`; DEFAULT `'none'`. Marks whether the infra share is measured or an allocated estimate. |
| `allocation_method` | TEXT | How an allocated share was split (e.g. `by_session_count`, `by_token_share`); `''` when `cost_basis != 'allocated'`. |
| `price_ref` | TEXT | Provenance: which rate-table version priced this row; a re-price uses a new `price_ref`. |
| `period_start` | TEXT/BIGINT | Period bounds for read-time `GROUP BY`. |
| `period_end` | TEXT/BIGINT | Period bounds. |
| `created_at` | TEXT/BIGINT | Write time; `MAX(created_at)` per `session_id` resolves the canonical row. |

No embedding column. No JSONB. Indexes: `org_id`, `workspace_id`, `team_id`, `period_start` (+ drill-down `project_id`, `user_id`). No BM25, no vector.

### `teams`, roster (`scope: "tenant"`, version-bumped)

One row per (team, member), written via [`appendVersionBumped`](../../../../src/daemon/storage/writes.ts) (edit = INSERT version N+1, `ORDER BY version DESC` read).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Row id. |
| `team_id` | TEXT | The team. |
| `team_name` | TEXT | Display name. |
| `member_type` | TEXT | `'agent'｜'user'` union. Agent rows work today; user rows inert until `user_id` verified. |
| `member_id` | TEXT | `agent_id`, or `user_id` once verified. |
| `role` | TEXT | `'member'｜'lead'｜'admin'`; DEFAULT `'member'`. |
| `active` | BIGINT | `1`/`0`; DEFAULT `1`. |
| `org_id` | TEXT | Identity column. |
| `workspace_id` | TEXT | Identity column. |
| `version` | BIGINT | Version-bump discriminant. |
| `created_at` | TEXT/BIGINT | |
| `updated_at` | TEXT/BIGINT | |

Indexes: `org_id`, `workspace_id`, `team_id`, `member_id`. No BM25, no vector.

**Single-source the schema** in the catalog ([`tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts) for placement; column adds go through `healMissingColumns`, validated by `validateColumnDefs` in [`types.ts`](../../../../src/daemon/storage/catalog/types.ts)). No hand-written migration.

---

## API changes

**No new public surface in this sub-PRD.** The write path is internal (daemon-side, at summary/skillify time) and the read is the existing local loopback path.

- **Write path (internal):** a new ROI-row writer appends to `roi_metrics` under the active `QueryScope` via [`appendOnlyInsert`](../../../../src/daemon/storage/writes.ts) + `withHeal`, resolving `team_id` from `teams` and gating `user_id` on the verified claim, all interpolation through the SQL guards ([`sql.ts`](../../../../src/daemon/storage/sql.ts)).
- **Roster writes (internal):** `teams` rows via [`appendVersionBumped`](../../../../src/daemon/storage/writes.ts).
- **Local read (extends 060e):** the 060e composite read-model now reads `roi_metrics` at **org/workspace scope governed by `read_policy`** through the existing authorization chokepoint ([`scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts)). Still loopback, still no new public bind.
- **The cross-org, authenticated, partition-crossing read is [PRD-061](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md), not here.**

---

## Open questions

- [ ] **Verified backend user-claim, the gating dependency.** What backend issues the verified person claim, what is its shape, and how does the daemon obtain `claim.userId` with `source === 'backend-token'`? Until this lands, `user_id` is `''` everywhere and every per-user rollup is inert. This is the single dependency that unblocks per-user, shared with [PRD-061d](../prd-061-hosted-roi-admin-surface/prd-061d-hosted-roi-admin-surface-per-user-claim-gating.md). (Owner: needs a backend/auth decision; surface to auth-worker-bee + security-worker-bee.)
- [ ] **Team roster authorship + lifecycle.** Who creates teams and assigns members, and via what surface (a local dashboard admin page? the hosted surface? a CLI?)? Until a roster-authoring surface exists, `team_id` is `''` for everyone and per-team rollups are empty even though the table is ready. Confirm whether roster authoring ships with this sub-PRD or with [PRD-061](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md).
- [ ] **Allocation method for the per-team/user infra share.** DeepLake infra cost is only measured org/workspace-wide. What is the canonical `allocation_method` (`by_session_count` / `by_token_share` / `by_active_seats`) for splitting it down to a team or user, and is that split shown as an explicit estimate (`cost_basis='allocated'`) everywhere it appears? (Interacts with 060c's billing granularity question and 060e's allocated-vs-measured rendering.)
- [ ] **Re-price retention + ledger size.** Append-on-reprice means `roi_metrics` grows with every correction. Is there a retention/compaction policy, and does the `MAX(created_at)` read stay cheap as the row count climbs (does the `period_start` index suffice)? (deeplake-dataset-worker-bee.)
- [ ] **PII on an append-only ledger (erasure).** Once `user_id` is populated, a `roi_metrics` row is per-person spend, PII. An append-only ledger cannot UPDATE/DELETE a single field for a GDPR-style erasure. Is erasure a **tombstone** (append a redaction row) or a **purge** (out-of-band hard delete), and who owns that path? Surfaced here; the per-user-spend retention/erasure policy is authored in [PRD-061e](../prd-061-hosted-roi-admin-surface/prd-061e-hosted-roi-admin-surface-privacy-and-retention.md). (security-worker-bee.)
- [ ] **`period_start`/`period_end` type + timezone.** TEXT ISO vs BIGINT epoch for the period bounds, and the timezone the period boundary is computed in (org-local vs UTC), so cross-device rollups bucket consistently. (deeplake-dataset-worker-bee.)

---

## Related

- [PRD-060](./prd-060-roi-tracker-index.md), the parent; this sub-PRD turns its device-local ledger into a shared, queryable one.
- [PRD-060b](./prd-060b-roi-tracker-cost-and-savings-engine.md), produces the measured/modeled cents and the `modeled_assumption_ref` this ledger persists; the measured-vs-modeled honesty contract extends here into the measured-vs-allocated cost columns.
- [PRD-060c](./prd-060c-roi-tracker-deeplake-billing-integration.md), supplies `infra_cost_cents`; the org/workspace-only granularity is exactly why a per-team/user infra share must be `cost_basis='allocated'`.
- [PRD-060d](./prd-060d-roi-tracker-pollination-cost-metering.md), supplies the pollination contributors that roll into `gross_cost_cents`.
- [PRD-060e](./prd-060e-roi-tracker-roi-tracker-dashboard-page.md), now reads this **shared** ledger at org/workspace scope governed by `read_policy`, with rollup views and the per-user empty state and the allocated-vs-measured rendering.
- **[PRD-061: Hosted ROI Admin Surface](../prd-061-hosted-roi-admin-surface/prd-061-hosted-roi-admin-surface-index.md)**, the authenticated, cross-org reader of these same two tables; deliberately crosses the partition boundary this table sits behind.
- [PRD-011: Tenancy and Auth](../../completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md), the tenant-scope + `scope-clause.ts` authorization chokepoint ([PRD-011/007c](../../completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md)) the local read obeys and the partition boundary PRD-061 crosses.
- [PRD-049: Multi-Project and Context Switching](../../completed/prd-049-multi-project-and-context-switching/prd-049-multi-project-and-context-switching-index.md), the `project_id` scope the ledger records.
- [DeepLake Schema](../../../knowledge/private/data/deeplake-schema.md) · [tenancy.ts](../../../../src/daemon/storage/catalog/tenancy.ts), the tenant-scoped table pattern (`telemetry_counters`/`recall_qa_ledger`) `roi_metrics` and `teams` mirror; [writes.ts](../../../../src/daemon/storage/writes.ts) for `appendOnlyInsert`/`appendVersionBumped`/`withHeal`; [sql.ts](../../../../src/daemon/storage/sql.ts) for the guards.
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md) · [Trust Boundaries](../../../knowledge/private/security/trust-boundaries.md) · [Credential Storage](../../../knowledge/private/security/credential-storage.md), the `read_policy` model and partition discipline the local read obeys.
- **Security + PII handoffs (surfaced, not authored here):** per-user-spend visibility governed by `read_policy`; the verified-claim parsing/validation path (auth-worker-bee + security-worker-bee); PII retention/erasure on an append-only ledger (tombstone-vs-purge). Per house process `security-worker-bee` runs penultimate and `quality-worker-bee` last on each implementing branch; this sub-PRD surfaces the handoffs, it does not author the audits.
- Code touchpoints: [`src/daemon/storage/catalog/tenancy.ts`](../../../../src/daemon/storage/catalog/tenancy.ts) (new table defs) · [`src/daemon/storage/catalog/types.ts`](../../../../src/daemon/storage/catalog/types.ts) (`validateColumnDefs`) · [`src/daemon/storage/writes.ts`](../../../../src/daemon/storage/writes.ts) (`appendOnlyInsert`/`appendVersionBumped`) · [`src/daemon/storage/sql.ts`](../../../../src/daemon/storage/sql.ts) (guards) · [`src/daemon/runtime/recall/scope-clause.ts`](../../../../src/daemon/runtime/recall/scope-clause.ts) (read scoping).
