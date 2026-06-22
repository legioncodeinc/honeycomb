# PRD-007e: Confidence Gate

> **Parent:** [PRD-007](./prd-007-retrieval-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S

## Scope

Build the recall confidence gate (phase 5 of recall): hydrate survivors, apply the caller's limit, track access, and decide whether the `user-prompt-submit` hook injects context based on the calibrated top score. This is the last phase, run over the shaped, authorized set from PRD-007d. The gate is what makes auto-injection trustworthy: it injects only when recall is confident, and an empty injection is a real answer, meaning no confident match was found, not that recall failed.

## Goals

- Hydrate the surviving IDs into full rows using the same scope filter as authorization.
- Apply the caller's limit and track access on primary results only.
- Decide injection from the reranker-calibrated top score against a minimum, preserving scores rather than synthesizing them from rank.
- Return an empty injection as a valid answer when nothing clears the minimum.
- Allow supplementary cards to ride along, clearly marked as synthetic.

## Non-Goals

- Collecting, authorizing, or shaping candidates (PRD-007a through PRD-007d).
- Building the `user-prompt-submit` hook itself (scaffolded in PRD-004); this consumes it.
- The explicit VFS browse path, which bypasses the inject-on-confidence rule.

## User stories

- As an agent, I want auto-injection only when recall is confident so that I am not fed weak, off-topic context every turn.
- As a developer, I want an empty injection to be a normal result so that "no confident match" is distinguishable from a recall error.
- As an agent, I want supplementary cards marked synthetic so that I can tell a graph context card from an ordinary memory row.

## Functional requirements

- **FR-1** The gate MUST hydrate the surviving IDs into full rows using the same org/workspace and agent scope filter that authorization (PRD-007c) applied, so hydration cannot widen the result set.
- **FR-2** The gate MUST apply the caller's limit after hydration, returning at most the requested number of primary results.
- **FR-3** Access tracking MUST update only the primary results, not supplementary cards or candidates dropped during shaping.
- **FR-4** The injection decision MUST use the reranker-calibrated top score, and that score MUST be preserved from shaping (PRD-007d), never synthesized from rank position.
- **FR-5** The `user-prompt-submit` hook MUST inject context only when the calibrated top score clears the configured minimum.
- **FR-6** When no result clears the minimum, the hook MUST return an empty injection as a valid answer, not an error or a failure signal.
- **FR-7** Supplementary material (source chunks, summaries, graph context cards, expanded transcripts) MAY ride along with the primary results, and each MUST be marked synthetic so the caller can distinguish it from an ordinary row.
- **FR-8** The minimum injection score MUST be configurable, and the gate MUST support per-agent tuning of the threshold.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given shaped results, when the gate runs, then context is injected only if the reranker-calibrated top score clears the minimum. |
| AC-2 | Given the calibrated scores, when the gate decides, then scores are preserved from shaping, not synthesized from rank. |
| AC-3 | Given nothing clears the minimum, when the hook returns, then an empty injection is returned as a valid answer, not a failure. |
| AC-4 | Given surviving IDs, when they are hydrated, then the same scope filter applies and the caller's limit caps the primary results. |
| AC-5 | Given hydration completes, when access is tracked, then only primary results are tracked. |
| AC-6 | Given supplementary cards, when they ride along, then each is marked synthetic and distinguishable from ordinary rows. |
| AC-7 | Given a per-agent threshold override, when the gate runs, then that agent's configured minimum is applied. |

## Implementation notes

- Re-applying the scope filter at hydration is belt-and-suspenders: the IDs are already authorized, but hydrating under the same filter keeps the safety property local to this phase too.
- Preserving calibrated scores is what lets the gate be a meaningful threshold; a score rebuilt from rank would make every recall look equally confident.
- An empty injection is a feature, not a fallback: agents treat it as "nothing confident here this turn" and proceed without polluted context.
- The production minimum injection score and per-agent tunability are tracked in the parent open questions and must be set before launch.

## Dependencies

- PRD-007d shaping (provides the shaped, authorized set with calibrated scores).
- PRD-004 hook scaffolding (`user-prompt-submit` hook this gate drives).
- PRD-003 schema (rows hydrated, access tracking columns).
- Per-agent configuration surface for the threshold.

## Open questions

- [ ] What is the production minimum injection score, and what is the per-agent override mechanism?
- [ ] Which supplementary card types are enabled by default versus opt-in?

## Related

- [parent index](./prd-007-retrieval-index.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
