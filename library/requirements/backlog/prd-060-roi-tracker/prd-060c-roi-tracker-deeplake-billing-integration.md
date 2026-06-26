# PRD-060c: DeepLake Billing API Integration + Infra Cost Read-Model

> **Parent:** [PRD-060](./prd-060-roi-tracker-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P1 (the cost side of the ledger; the only outbound egress this module adds, and the sole holder of billing credentials)
> **Schema changes:** None. The infra read-model is an in-memory TTL cache in the daemon, not a new DeepLake table.

---

## Overview

The cost side of the ledger comes from DeepLake's billing API ([`api.deeplake.ai`](https://api.deeplake.ai/docs/doc.json), spec at `/docs/doc.json`), which exposes ~17 `/billing/*` endpoints, **all infra cost, all integer cents, with no token or cache notion**. DeepLake's "compute" is **its own GPU sessions** (Honeycomb's embeddings, ingestion, and recall queries), not the user's Claude/Codex/Cursor tokens, DeepLake never sees those. So this client reads exactly one of the two cost worlds: World 2, the infra DeepLake bills Honeycomb's machinery for.

The endpoints that matter:

- **`GET /billing/summary`**, compute / storage / transfer totals, projected end-of-period, and the prior-period delta (which feeds the cost KPIs, with the cost-rising-must-not-render-green inversion handled in 060e).
- **`GET /billing/usage/compute`**, GPU sessions **broken out by `session_type` (`query` | `embedding` | `ingestion`)**, each with `gpu_hours` and `price_cents_per_gpu_hour`. This breakdown is what 060d ties into pollination cost: embedding + ingestion + query sessions *are* the DeepLake half of pollination.
- **`GET /billing/account`**, unit rates per region; **`GET /billing/estimate`**; **`GET /billing/usage/{by-table,storage,transfer}`**; **`GET /billing/transactions`**, supporting reads for itemization and projection.

This sub-PRD builds a **daemon-side, creds-gated, fail-soft client** plus a **TTL-cached read-model**. It is the **sole holder of DeepLake billing credentials** and the **only outbound billing egress** the module adds, the page never calls it; the page reads the daemon read-model over loopback (060e). The client mirrors the hardened-fetch posture already proven in [`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts): injectable `fetch` for tests, retry on 429/5xx, bounded timeout, and **token redaction so the bearer never reaches a log line**.

Fail-soft is non-negotiable: no credentials → the read-model returns `unauthenticated`; an unreachable or erroring API → `unreachable`; a partial response → `partial`. None of these throw, none wedge the daemon, and crucially the read-model **never fabricates a `$0`** for a missing read, the status discriminant is how 060e distinguishes "billed $0" from "couldn't read billing". Billing moves slowly, so the read is cached behind a TTL (cadence is an open question, possibly a long TTL with a manual refresh rather than a 60s poll).

## Goals

- **A creds-gated, fail-soft DeepLake billing client** ([`src/daemon/runtime/dashboard/roi-billing.ts`](../../../../src/daemon/runtime/dashboard/roi-billing.ts), new) covering `GET /billing/summary`, `GET /billing/usage/compute` (the `session_type` breakdown), `GET /billing/account`, and the supporting `/billing/*` reads needed for itemization/projection, reusing the existing DeepLake auth credentials.
- **Hardened-fetch posture mirrored from [`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts):** injectable `fetch` (tests never hit the network), retry on 429/5xx, bounded timeout, and bearer-token redaction in every log path.
- **A TTL-cached infra read-model** in the daemon (in-memory, not a dataset) exposing compute/storage/transfer totals, projected end-of-period, the prior-period delta, and the `session_type` GPU-session breakdown, refreshed on TTL expiry.
- **Status discriminants, not fabricated values**, the read-model returns `ok` / `partial` / `unreachable` / `unauthenticated`, never a `$0` standing in for a failed read, so 060e can tell "billed $0" from "unknown".
- **Sole egress, sole creds-holder**, this is the only component making the outbound billing call and the only one holding billing creds; the page reads it over loopback.
- **Integer cents preserved**, the API returns integer cents; the read-model keeps them integer cents end to end (no float conversion until 060e's render edge).

## Non-Goals

- **Token or cache cost.** The billing API has no token notion; measured/modeled token savings are 060b. This client reads infra only.
- **Becoming a billing system.** We read and cache DeepLake's billing reads; we do not invoice, reconcile, or charge.
- **The pollination total.** This sub-PRD *exposes* the `session_type` GPU-session breakdown; 060d *composes* it with the Haiku skillify token cost into the pollination figure.
- **A persisted billing-cache table.** The read-model is in-memory TTL; no new DeepLake dataset and no on-disk billing ledger.
- **The page UI.** 060e renders the cost lines + the cost-rising delta inversion; this module supplies the numbers and the status.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | A daemon-side billing client reads `GET /billing/summary` (compute/storage/transfer + projected + prior-period delta) and `GET /billing/usage/compute` (GPU sessions by `session_type`), reusing the existing DeepLake auth credentials; a test drives it through an **injected fetch** (no live network). |
| c-AC-2 | With **no** credentials, the read-model returns **`unauthenticated`**; with the API **unreachable or 5xx after retries**, it returns **`unreachable`**, in both cases **no value is fabricated** and the daemon does not throw. |
| c-AC-3 | The client **retries on 429/5xx** with a bounded timeout and **redacts the bearer token** from every log path; a test asserts the token never appears in emitted logs (parity with [`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts)). |
| c-AC-4 | The infra read-model is **TTL-cached in memory** (no DeepLake table); a test asserts a second read within the TTL does not re-hit the upstream API and an expired read does. |
| c-AC-5 | The `session_type` breakdown (`query` / `embedding` / `ingestion`, each with `gpu_hours` × `price_cents_per_gpu_hour`) is exposed to 060d as integer cents; a test asserts the three types are itemized and summable. |
| c-AC-6 | All money stays **integer cents** through the client and read-model; a test asserts no float-cents value is produced. |
| c-AC-7 | A **partial** upstream response (some endpoints ok, some failed) yields a **`partial`** status with the available lines populated and the missing ones flagged, never a silent zero for the missing line. |

## Files touched

- [`src/daemon/runtime/dashboard/roi-billing.ts`](../../../../src/daemon/runtime/dashboard/roi-billing.ts), **new** billing client + TTL read-model.
- [`src/daemon/runtime/auth/deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts), reused for credentials + as the hardened-fetch pattern reference (injectable fetch, retry, redaction).
- [`src/daemon/runtime/dashboard/api.ts`](../../../../src/daemon/runtime/dashboard/api.ts), the read-model is surfaced into the composite `GET /api/diagnostics/roi` here (assembled in 060e).
- Tests under the dashboard/daemon test tree: injected-fetch reads, unauthenticated/unreachable/partial status mapping, TTL cache behavior, token-redaction assertion, integer-cents assertion.

## Open questions

- [ ] **TTL + poll cadence.** Billing moves slowly; is a ~60s `usePoll` (frontend brief) even warranted, or a much longer TTL (minutes/hours) with a manual "refresh" affordance? Pin the TTL and the 429 backoff.
- [ ] **Per-project vs workspace granularity.** Does `/billing/*` itemize per DeepLake project/dataset or only per workspace? If workspace-coarse, the read-model must label the figure "workspace-wide" so 060e doesn't imply per-project attribution (reconcile with [PRD-049](../../completed/prd-049-multi-project-and-context-switching/prd-049-multi-project-and-context-switching-index.md)).
- [ ] **Which `session_type`s count as pollination.** `embedding` + `ingestion` are clearly Honeycomb's pollination; is **`query`** (recall) pollination cost, or a separate "recall cost" line? Confirm with 060d/060e so the ledger's pollination total is defined identically everywhere.
- [ ] **Projection vs actuals.** `/billing/summary` returns projected end-of-period and a prior-period delta. Does the ledger show period-to-date actuals, projected, or both, and the delta's sign semantics feed the cost-rising-not-green rule in 060e.
- [ ] **Spec drift.** The `/docs/doc.json` spec is the source of truth for the ~17 endpoints; pin the exact response shapes (field names, cents vs dollars, session_type enum values) against the live spec at implementation time before coding the client.

## Related

- [PRD-060d](./prd-060d-roi-tracker-pollination-cost-metering.md), composes this module's `session_type` GPU-session breakdown with the Haiku skillify token cost into the pollination total.
- [PRD-060e](./prd-060e-roi-tracker-roi-tracker-dashboard-page.md), consumes the read-model's status discriminants + cost lines over loopback; renders the cost-rising delta inversion.
- [PRD-026: Pollinating Loop Enablement](../../completed/prd-026-pollinating-loop-enablement/prd-026-pollinating-loop-enablement-index.md), the embedding/ingestion/recall machinery whose GPU sessions *are* the compute this client bills.
- [PRD-023: DeepLake Connect Parity](../../completed/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md) · [PRD-011b: Device-Flow Auth](../../completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md), the `api.deeplake.ai` issuer + credentials this client reuses.
- [Trust Boundaries](../../../knowledge/private/security/trust-boundaries.md) · [Credential Storage](../../../knowledge/private/security/credential-storage.md), the egress + credential-isolation discipline this client enforces (sole egress, sole creds-holder, token redaction).
- **Security/quality handoff:** new outbound egress + a billing-credential holder is squarely security-relevant; `security-worker-bee` (penultimate) audits the egress, retry, and redaction before `quality-worker-bee` (last) verifies. This sub-PRD surfaces the handoff; it does not author the audit.
</content>
