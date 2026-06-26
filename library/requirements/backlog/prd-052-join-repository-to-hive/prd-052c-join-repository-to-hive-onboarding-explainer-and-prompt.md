# PRD-052c: Onboarding Explainer and Copy-Paste Prompt

> **Parent:** [PRD-052](./prd-052-join-repository-to-hive-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S (< 1d)
> **Schema changes:** None.

---

## Overview

The teaching half of the join. After the scaffold (052a) and the starter assets (052b) land, the user needs to understand what they just got and what to do first, written for someone who has never seen a Stinger or the Bee Army. This sub-PRD produces a short **onboarding explainer** (a generated doc plus a dashboard panel) and a single **copy-paste prompt** that runs `/knowledge-stinger` against the user's first real change, so their opening move produces a knowledge doc and turns a drift signal green.

Progressive disclosure is the whole design brief: explain the one loop that matters now, point at where the rest lives, and stop. Overwhelm is the failure mode.

## Goals

- Generate a concise **onboarding explainer** that covers: what each `library/` folder is for; what the starter command(s) provisioned in 052b do; and *why* `/library-stinger` (plan work) and `/knowledge-stinger` (capture knowledge, clear drift) exist and when to reach for each.
- Render the same explainer as a **dashboard panel** so the user sees it in the product, not only on disk.
- Produce a **copy-paste prompt** the user can drop into their agent that invokes `/knowledge-stinger` to document their first change and produce their first knowledge doc.
- Keep all of it **progressive**: one loop, plainly explained, with a clear "there is more when you want it" pointer rather than a dump of the full roster.
- Make the explainer **generic and repo-agnostic** (it runs in an arbitrary user repo) while still naming the user's actual harness and the actual starter commands that were installed.

## Non-Goals

- Scaffolding (052a) or asset install (052b).
- Teaching the full Bee Army, `/the-smoker`, security/quality Stingers, or the multi-agent SDLC. Those are deferred, opt-in, later.
- Firing the prompt automatically or nudging the user to run it (that is PRD-053; here we only hand it over).

## User stories

- As a first-time user, after joining I read a short panel that tells me what I got and exactly one thing to do next, and it does not overwhelm me.
- As a user ready to try it, I copy one prompt, paste it into my agent, and get my first knowledge doc, which I then see clear a drift signal on the health page.
- As a curious user, the explainer tells me where the rest of the toolkit lives so I can go deeper on my own schedule.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Join produces an onboarding explainer doc covering the `library/` folders, the starter command(s) actually installed, and the rationale for `/library-stinger` and `/knowledge-stinger`. |
| c-AC-2 | The same explainer renders as a dashboard panel reachable right after a successful join. |
| c-AC-3 | The flow surfaces a copy-paste prompt that invokes `/knowledge-stinger`; pasting it into a supported agent produces a knowledge doc under `library/knowledge/`. |
| c-AC-4 | The explainer names the user's detected harness and the actual installed starter commands (not a generic placeholder list), while remaining repo-agnostic in its examples. |
| c-AC-5 | The explainer practices progressive disclosure: it teaches one loop and links to where the rest of the toolkit lives, without enumerating the full roster. |
| c-AC-6 | Producing the explainer + prompt performs no write outside `library/` and the harness asset folder (consistent with the parent's write-confinement AC). |

## Implementation notes

- Generate the explainer from a template that interpolates the detected harness + the 052b starter allow-list, so it always matches what was actually installed.
- The dashboard panel can reuse existing primitives/panels ([`panels.tsx`](../../../../src/dashboard/web/panels.tsx), [`primitives.tsx`](../../../../src/dashboard/web/primitives.tsx)); this is content, not new UI machinery.
- The copy-paste prompt should be a single self-contained block (the user has no context to add), phrased so a fresh agent session can act on it, naming `/knowledge-stinger` and pointing at the user's recent change.
- Keep tone plain and encouraging; this is the first impression of the workflow.

## Open questions

- [ ] Where the explainer doc lives (a `library/README`-adjacent onboarding file vs `library/knowledge/`), keeping in mind the scaffold is otherwise content-free.
- [ ] Whether the panel is a one-time post-join screen, a dismissible card, or a permanent help entry.
- [ ] Exact wording of the `/knowledge-stinger` prompt and how it references "your most recent change" without the daemon over-reaching.

## Related

- [PRD-052 index](./prd-052-join-repository-to-hive-index.md) — parent flow and write-confinement contract.
- [`src/dashboard/web/panels.tsx`](../../../../src/dashboard/web/panels.tsx) and [`primitives.tsx`](../../../../src/dashboard/web/primitives.tsx) — the UI primitives the panel reuses.
- [Library guide / knowledge authoring conventions](../../../knowledge/private/standards/) — the conventions the explainer summarizes for the user.
- Sibling sub-PRDs: [052a non-destructive library scaffold](./prd-052a-join-repository-to-hive-non-destructive-library-scaffold.md), [052b harness asset provisioning](./prd-052b-join-repository-to-hive-harness-asset-provisioning.md).
- Successor: [PRD-053: Coaching and Reminder Loop](../prd-053-coaching-and-reminder-loop/prd-053-coaching-and-reminder-loop-index.md) — turns this one-time prompt into an ongoing nudge.
