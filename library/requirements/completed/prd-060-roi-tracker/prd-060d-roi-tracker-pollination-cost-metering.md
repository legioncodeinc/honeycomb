# PRD-060d: Pollination Cost Metering

> **Parent:** [PRD-060](./prd-060-roi-tracker-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P2 (completes the cost side; depends on 060c's billing breakdown and 060b's rate table)
> **Schema changes:** None to the DeepLake catalog. Honeycomb's own-inference token counts are metered at the transport and rolled up in the read-model.

---

## Overview

"Pollination cost" is what Honeycomb's **own** machinery costs to run, and it has two contributors from two different cost worlds:

1. **Honeycomb's own Haiku skillify token cost.** The skillify loop ([PRD-016](../../completed/prd-016-skillify/prd-016-skillify-index.md)) runs Honeycomb's *own* inference, a Haiku KEEP/MERGE/SKIP gate over captured sessions. That inference burns tokens Honeycomb pays for, and it flows through [`transport-anthropic.ts`](../../../../src/daemon/runtime/inference/transport-anthropic.ts), which **today parses only `content` and discards `usage`**, the exact same drop 060a fixes for the *user's* turns, but here for *our own* calls. Instrument the transport to surface its `usage`, price it with 060b's rate table, and you have the token half of pollination cost.
2. **The DeepLake embedding / ingestion / query GPU-session cost.** 060c's `GET /billing/usage/compute` already itemizes GPU sessions by `session_type` (`query` | `embedding` | `ingestion`). Those sessions *are* the DeepLake half of pollination, the compute DeepLake bills Honeycomb for embedding memories, ingesting them, and answering recall queries. This sub-PRD ties that breakdown into the pollination total rather than re-reading billing.

So pollination cost = **(Haiku skillify tokens × rate)** + **(DeepLake embedding + ingestion + query GPU sessions, in cents)**. The first is metered locally at the transport; the second comes from 060c's billing read. Both are integer cents; both must be itemized so the page can show *why* pollination costs what it does (and so a user can see that, e.g., embeddings dominate).

The same fail-soft discipline applies: if the transport meter has no data yet, the Haiku contribution is `absent`, not `0`; if 060c's billing read is `unreachable`, the DeepLake contribution is `unreachable`, and the pollination total inherits a non-`ok` status rather than under-reporting. Pollination must never be silently understated, because understating cost overstates net ROI, the dishonest direction.

## Goals

- **Meter Honeycomb's own Haiku skillify inference**, instrument [`transport-anthropic.ts`](../../../../src/daemon/runtime/inference/transport-anthropic.ts) to surface the `usage` it currently discards on Honeycomb's own calls, scoped to (at least) the skillify path, and roll the token counts up in the read-model.
- **Price the Haiku tokens** with 060b's provider rate table (Haiku input/output cents per Mtok) → the token half of pollination cost, in integer cents.
- **Tie in the DeepLake GPU-session cost**, consume 060c's `session_type` breakdown (`embedding` + `ingestion` + `query`) as the infra half of pollination cost; do **not** re-read billing here.
- **One itemized pollination total**, `pollination = haikuSkillifyCents + deeplakeSessionCents`, with both contributors itemized (and the `session_type` split visible) so the page can explain the figure.
- **Fail-soft contributors**, a missing Haiku meter → `absent` (not `0`); an unreachable billing read → the DeepLake contribution is `unreachable`; the total carries the worst contributing status so the page never shows a confidently-wrong low number.

## Non-Goals

- **Re-reading the billing API.** 060c owns the `/billing/*` egress and the `session_type` breakdown; this module *consumes* it. No second billing client.
- **The rate table.** Owned by 060b; reused here to price Haiku tokens.
- **Metering the user's assistant tokens.** That is 060a (the user's Claude Code turns). This module meters **Honeycomb's own** inference only.
- **Re-architecting the inference transport or the skillify gate.** We add a usage-surfacing seam to the transport (mirroring 060a's contract change); we do not change routing, the KEEP/MERGE/SKIP logic, or the model choice.
- **Defining which `session_type` counts as pollination vs recall.** That definitional call is shared with 060c/060e (open question there); this module composes whatever the agreed set is.

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | [`transport-anthropic.ts`](../../../../src/daemon/runtime/inference/transport-anthropic.ts) surfaces the `usage` object it currently discards on Honeycomb's own (skillify) calls; a test asserts input/output token counts are captured from a transport response instead of dropped. |
| d-AC-2 | Haiku skillify token cost is computed by pricing the metered tokens with 060b's rate table (Haiku rates), in **integer cents**; a unit test asserts the figure against fixed token inputs. |
| d-AC-3 | The DeepLake `embedding` + `ingestion` + `query` GPU-session cost (from 060c's `session_type` breakdown) is composed into the pollination total **without** a second billing read; a test asserts no extra outbound billing call originates here. |
| d-AC-4 | `pollination = haikuSkillifyCents + deeplakeSessionCents`, **itemized** so both contributors (and the `session_type` split) are individually readable in the read-model; a test asserts the itemization. |
| d-AC-5 | A missing Haiku meter yields an **`absent`** Haiku contribution (not `0`), and an **`unreachable`** billing read yields an `unreachable` DeepLake contribution; the pollination total carries the **worst** contributing status, never a confidently-low number. |
| d-AC-6 | All pollination values are **integer cents**; a test asserts no float-cents crosses the boundary toward the read-model. |

## Files touched

- [`src/daemon/runtime/inference/transport-anthropic.ts`](../../../../src/daemon/runtime/inference/transport-anthropic.ts), surface the `usage` it currently discards on Honeycomb's own inference calls.
- The skillify inference call site(s) ([Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md) / [PRD-016](../../completed/prd-016-skillify/prd-016-skillify-index.md)), thread the metered usage into the read-model rollup.
- The cost engine from [PRD-060b](./prd-060b-roi-tracker-cost-and-savings-engine.md), reused to price Haiku tokens.
- The billing read-model from [PRD-060c](./prd-060c-roi-tracker-deeplake-billing-integration.md), consumed for the `session_type` GPU-session cost.
- The composite read-model in [`src/daemon/runtime/dashboard/api.ts`](../../../../src/daemon/runtime/dashboard/api.ts), where the pollination total is assembled for the `RoiView`.
- Tests: transport usage-surfacing, Haiku pricing arithmetic, no-second-billing-call assertion, itemization, worst-status propagation, integer-cents.

## Open questions

- [ ] **Metering scope at the transport.** Meter only the skillify path, or all Honeycomb own-inference (so future own-inference features are costed too)? Scoping to skillify is the v1 minimum; a transport-wide meter is cleaner but wider. Confirm with the inference owner.
- [ ] **`query` (recall), pollination or its own line?** Shared with 060c/060e: is recall GPU cost part of pollination, or a separate "recall cost" the page itemizes? The pollination total's definition must match across c/d/e.
- [ ] **Attributing GPU sessions to skillify vs user-driven recall.** Billing's `session_type` is coarse; can embedding/ingestion sessions be attributed to the pollination loop specifically, or is it all-workspace compute? If coarse, the page must label pollination "workspace compute" honestly (ties to 060c's granularity question).
- [ ] **Haiku model identity in the rate table.** Confirm the exact Haiku model id the skillify path uses so 060b's table prices the right row (and survives a model swap in the router).

## Related

- [PRD-016: Skillify](../../completed/prd-016-skillify/prd-016-skillify-index.md) · [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md), the Haiku loop whose own token cost this meters.
- [PRD-060b](./prd-060b-roi-tracker-cost-and-savings-engine.md), the rate table that prices the metered Haiku tokens.
- [PRD-060c](./prd-060c-roi-tracker-deeplake-billing-integration.md), supplies the `session_type` GPU-session breakdown composed into pollination cost.
- [PRD-060e](./prd-060e-roi-tracker-roi-tracker-dashboard-page.md), renders the itemized pollination total in the ledger.
- [Model Provider Router](../../../knowledge/private/ai/model-provider-router.md), the transport + router the Haiku meter taps.
</content>
