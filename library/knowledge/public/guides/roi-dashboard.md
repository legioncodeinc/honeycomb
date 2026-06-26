# Your ROI dashboard

> Category: Guides | Version: 1.0 | Date: June 2026 | Status: Active

Honeycomb has a page that answers the obvious question: *is this saving me money?* The **ROI** page on your dashboard shows what the memory layer saves you against what it costs to run, in plain dollars, and it is careful to tell you which numbers are measured and which are estimates.

**Related:**
- [Everyday use](everyday-use.md)
- [How Honeycomb works](../overview/how-it-works.md)
- [Honeycomb for teams](teams.md)
- [Glossary](../overview/glossary.md)

---

## What the page shows

At the top is the headline: **Net ROI**, the one number that nets everything out.

```
Net ROI = what you saved − what it cost to run
```

Underneath, that splits into the pieces it is made of:

- **What you saved** comes in two flavors:
  - **Measured cache savings** (the green headline). When your assistant reuses context it has already sent, that reused part is billed at a small fraction of the normal rate. Honeycomb reads the real token counts from your sessions and prices them, so this is an actual, billed saving, not a guess.
  - **Estimated memory savings** (clearly labeled as an estimate). When Honeycomb hands your assistant the right notes up front, it can reach an answer in fewer back-and-forths. We *model* what that would have cost you otherwise. It is shown next to the measured number but always marked as an estimate, never mixed in as if it were a hard fact.
- **What it cost to run** is Honeycomb's own running cost: the cloud compute behind storing and recalling your memory, plus the small amount of AI work Honeycomb does in the background to distill your sessions into clean notes.

## Measured vs estimated: why we split them

This is the most important thing about the page. Honeycomb deliberately keeps two kinds of number apart:

- A **measured** number is arithmetic over your real, billed usage. You can trust it like a receipt.
- An **estimated** number is a model of what *would* have happened. It is useful, but it is a projection, and we label it so.

Any total that includes an estimate inherits an **"est."** marker, so you always know when you are looking at a projection rather than a billed fact. We would rather show you an honest estimate clearly flagged than dress a guess up as a guarantee.

## When a number is missing

The page never invents a number to fill a gap. If something cannot be measured right now, you will see a **dash**, not a misleading `$0.00`:

- **Just getting started?** Until Honeycomb has captured a few sessions with token detail, the savings section shows dashes. A measured `$0` and an "unknown yet" are shown differently on purpose.
- **Token detail is captured for Claude Code first.** If you are mostly on Claude Code you will see the richest numbers; other tools are being added, and the page marks where data is partial.
- **If the cost service is unreachable**, the affected line shows a dash and offers a retry, rather than guessing.

A small **"rates as of"** date on the page tells you how current the pricing behind the math is.

## A negative number is not a bug

If you barely use the memory features, it is possible for the running cost to be higher than what you have saved so far, a negative net. That is honest, not broken: the value compounds the more you use it. The page shows this plainly and never colors a rising cost as if it were good news.

## Teams

ROI adds up **across your devices**, and if your workspace is organized into teams, it can roll up per team as well. Per-person breakdowns are intentionally switched off until a verified sign-in exists, Honeycomb will not guess who you are from your machine or your git email. Until then you will see a clear "needs verified login" note instead of a fabricated per-person figure. See [Honeycomb for teams](teams.md) for how team rollups work.

## Where to find it

Open your Honeycomb dashboard and choose **ROI** from the left navigation. The page runs locally on your own machine and reads only your own workspace's numbers.
