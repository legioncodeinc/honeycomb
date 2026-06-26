# PRD-060b: Cost and Savings Calculation Engine + Provider Rate Table

> **Parent:** [PRD-060](./prd-060-roi-tracker-index.md)
> **Status:** Backlog, draft (2026-06-26)
> **Priority:** P1 (the math layer; owns the measured-vs-modeled honesty contract that the whole module's credibility rests on)
> **Schema changes:** None to the DeepLake catalog. Adds a maintained provider→model rate table in source.

---

## Overview

This is the arithmetic between captured token counts (060a) and the dollar figures the page renders. It owns three computations and one piece of reference data, and, most importantly, it owns the **measured-vs-modeled honesty contract** that keeps the credible number and the counterfactual number from blurring into each other.

1. **The provider rate table**, a maintained map of provider→model→rate (`input`, `output`, `cache_read`, `cache_write`, all integer cents per Mtok). Anthropic bills cache reads at **0.1×** input and cache writes at **1.25×** input; the table encodes those as first-class columns, not a fudge factor.
2. **Measured cache savings (the headline, defensible)**, `cache_read_input_tokens × (input_cents_per_mtok - cache_read_cents_per_mtok) / 1e6`, summed over captured turns. This is arithmetic over billed fact: it is what the user *actually* saved because cached tokens billed at the cache-read rate instead of the full input rate. It is the green, headline number.
3. **Modeled memory-injection savings (the estimate, clearly labeled)**, a *counterfactual*: an estimate of what the user would have spent **without** memory injection (more turns, more re-explaining, more tokens). This is **not** a billed fact; it is a model. It carries its **assumption as a data field** so the page can disclose exactly what the estimate rests on, and it must **never** be summed into a line the UI presents as "measured".
4. **The effective blended $/Mtok**, the realized blended rate across input/output/cache-read/cache-write given the actual token mix, `null` until capture is live (so the page knows to show a placeholder, not a fabricated `0`).

The honesty contract is the spine: measured and modeled are **different kinds of number**, computed by different functions, tagged distinctly in the output, and the modeled term taints any aggregate it touches (the Net-ROI hero, which sums a modeled term, inherits the `est.` marker, enforced jointly with 060e). A modeled number that renders as if billed is the single worst failure mode this module can have, and a test guards against it.

## Goals

- **A maintained provider→model rate table** (provider, model, `input_cents_per_mtok`, `output_cents_per_mtok`, `cache_read_cents_per_mtok`, `cache_write_cents_per_mtok`) as config-shaped source data, with a "rates as of \<date\>" stamp surfaced so a stale or wrong rate is auditable on the page, not buried.
- **Measured cache-savings computation**, pure arithmetic over the persisted `cache_read_input_tokens` (060a) and the rate-table delta; deterministic, unit-tested against fixed token inputs, tagged `measured` in the output.
- **Modeled memory-injection estimator**, a single, named model whose **assumption is a data field** (e.g. `{ kind, turnsSavedPerSession, ... , assumptionText }`), tagged `modeled` in the output, never folded into a measured line.
- **Effective blended $/Mtok**, computed from the actual token mix; `null` until token capture is live.
- **The honesty contract, enforced in code**, measured and modeled live in separate functions returning separately-tagged results; any aggregate that includes a modeled term is itself tagged `modeled`/`est.`; a test asserts no measured-tagged field was derived from a modeled input.
- **Integer cents end to end**, every internal value is integer cents; dollars appear only at the render edge (060e), and a test asserts no float-cents escape this layer.

## Non-Goals

- **A live pricing feed or a pricing oracle.** The table is maintained in source and versioned with the code; staleness is a maintenance task with a visible "rates as of" stamp, not a runtime fetch. (Reaffirms the module Non-Goal.)
- **Token capture.** Consumes 060a's persisted counts; does not capture anything.
- **Infra or pollination cost.** Those are 060c (billing) and 060d (pollination metering). This module owns the **savings** half plus the rate table the others may reuse for token-priced lines.
- **Rendering.** Produces tagged numbers and an assumption field; the page (060e) decides how `measured` vs `modeled` look. This module never decides pixels, only the tag.
- **Choosing the modeled formula's exact constants.** The *mechanism* (assumption-as-data, the tag discipline) is in scope; the *signed-off assumption string and constants* are the gating open question below.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | A provider→model rate table exists with `input` / `output` / `cache_read` / `cache_write` cents-per-Mtok columns and a "rates as of" date; a test asserts the Anthropic cache-read rate is encoded at 0.1× input and cache-write at 1.25× input. |
| b-AC-2 | **Measured cache savings** = `cache_read_tokens × (input_rate - cache_read_rate)`, summed over captured turns, returned **tagged `measured`**; a unit test asserts the figure against fixed token inputs (arithmetic, not a guess). |
| b-AC-3 | **Modeled memory-injection savings** is returned **tagged `modeled`** and carries its **assumption as a data field**; a test asserts the assumption is present in the output and is the single source the disclosure copy reads. |
| b-AC-4 | A test asserts **no `measured`-tagged value is ever derived from a `modeled` input**, and that any aggregate including the modeled term (e.g. the net) is itself tagged `modeled`/`est.`, the honesty contract is structurally enforced, not stylistic. |
| b-AC-5 | `blendedCentsPerMtok` is computed from the actual token mix and is **`null`** when token capture is absent (so 060e shows a placeholder, not `$0.00`). |
| b-AC-6 | All values are **integer cents** within this layer; a test asserts no float-cents value crosses the module boundary toward the read-model. |
| b-AC-7 | With token capture **absent** (060a not yet live or `source_tool` partial), measured savings reports a status the read-model maps to `absent`/`partial` rather than returning `0` as if measured. |

## Files touched

- New rate-table module (location is an open question, fresh module under the dashboard read-model dir, or reuse of [`src/daemon/runtime/vault/catalog.ts`](../../../../src/daemon/runtime/vault/catalog.ts)'s pattern). Config-shaped, versioned in source.
- New cost/savings engine module(s) under the daemon read-model area (e.g. beside [`src/daemon/runtime/dashboard/api.ts`](../../../../src/daemon/runtime/dashboard/api.ts)), the measured computation, the modeled estimator, the blended-rate computation, each returning tagged results.
- Reads the persisted token columns from the `sessions` group ([`sessions-summaries.ts`](../../../../src/daemon/storage/catalog/sessions-summaries.ts)) added by 060a.
- Tests: fixed-input measured arithmetic, modeled tag + assumption-field presence, the measured-not-from-modeled structural assertion, integer-cents boundary, blended-null-when-absent.

## Open questions

- [ ] **The modeled formula and its signed-off assumption (gating).** What is the memory-injection model, turns-saved × avg-turn-cost? a fixed % of measured spend? recall-hit-rate × per-hit token estimate? Where does the assumption constant live (one editable place), and what is the **exact assumption string** the operator signs off for the UX to surface? Until this is pinned the modeled number is a placeholder.
- [ ] **Rate-table source + staleness policy.** Fresh module vs reuse [`vault/catalog.ts`](../../../../src/daemon/runtime/vault/catalog.ts); a dated constant with a visible "rates as of" stamp; and the cadence/owner for updating rates when providers change pricing.
- [ ] **Output-token savings, in or out?** Cache savings are unambiguously input-side. Does the modeled estimate also claim output-token savings (fewer turns → fewer output tokens), and if so does that make the modeled number meaningfully larger than measured, sharpening the need to keep them visually separate?
- [ ] **Multi-provider blend.** If a user's sessions span providers (Claude Code on Anthropic, a Cursor turn on a different model), does the blended $/Mtok blend across providers or report per-provider? (Interacts with 060a's `source_tool` and the Cursor-cache reality.)

## Related

- [PRD-060a](./prd-060a-roi-tracker-token-and-cache-usage-capture.md), supplies the persisted `cache_read_input_tokens` this module prices; hard upstream dependency for the measured path.
- [PRD-060e](./prd-060e-roi-tracker-roi-tracker-dashboard-page.md), consumes the `measured`/`modeled` tags and the assumption field to drive the four-signal visual language and the ⓘ/footnote disclosure; the honesty contract is enforced jointly with this page.
- [PRD-060d](./prd-060d-roi-tracker-pollination-cost-metering.md), reuses this rate table to price Honeycomb's own Haiku skillify tokens.
- [Model Provider Router](../../../knowledge/private/ai/model-provider-router.md), the provider/model surface the rate table mirrors.
</content>
