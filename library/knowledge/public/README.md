---
ai_description: |
  This folder contains customer-facing / end-user documentation.
  Approved sub-folders: overview/, guides/, faqs/, and any domain
  folder explicitly designated public by the team.
  Do NOT file internal engineering docs, ADRs, pricing strategy, or
  security-sensitive material here.
  Write path: library/knowledge/public/<domain>/<kebab-slug>.md.
  All files here may eventually be surfaced in the public help center
  (Phase 2). Mark each doc with the standard knowledge-base header:
  Category / Version / Date / Status.
human_description: |
  Customer-facing documentation. Content here may be published externally.
  - overview/: what this product is, glossary, elevator pitch
  - guides/: how-to guides written for users, not developers
  - faqs/: frequently asked questions
  Only add content here that you are comfortable sharing publicly.
  Internal notes, pricing strategy, and architecture docs belong in
  knowledge/private/ instead.
---

# Knowledge, Public

Customer-facing documentation. Anything in this folder may eventually be published.

## Approved sub-folders

| Folder | Contents |
|---|---|
| `overview/` | What this product is, glossary, elevator pitch, high-level FAQs |
| `guides/` | Step-by-step user guides (written for customers, not developers) |
| `faqs/` | Frequently asked questions from customers |

## Contents

Start here, then follow the cross-links:

- **overview/**
  - [What is Honeycomb?](overview/what-is-honeycomb.md): the plain-language introduction; start here
  - [How Honeycomb works](overview/how-it-works.md): the capture, distill, recall, compound loop without jargon
  - [Glossary](overview/glossary.md): plain definitions of every term
- **guides/**
  - [Getting started](guides/getting-started.md): install, connect, and save your first memory
  - [Everyday use](guides/everyday-use.md): the day-to-day flow
  - [Your ROI dashboard](guides/roi-dashboard.md): the page that shows whether the memory layer pays for itself
  - [Honeycomb for teams](guides/teams.md): sharing memory and skills across a team
- **faqs/**
  - [Frequently asked questions](faqs/faq.md): short answers to the common questions

## What does NOT belong here

- Internal architecture docs or ADRs
- Pricing strategy or competitive analysis
- Engineering standards
- Anything you would not want a customer to read
