---
ai_description: |
  Contains PRD folders planned but not yet started. This is where
  library-guardian creates new PRD folders on "write a PRD for X".
  PRD folder naming: prd-<###>-<kebab-slug>/ (3-digit zero-padded).
  PRD number: take max+1 from all prd-* folders across backlog/,
  in-work/, and completed/ in this repo.
  Each PRD folder must contain: prd-<###>-<slug>-index.md (always),
  prd-<###><letter>-<slug>-<feature>.md (one per sub-feature, optional),
  qa/ subfolder (empty on creation; quality-guardian writes QA reports here).
  Move entire folder to in-work/ when implementation begins.
human_description: |
  PRDs planned but not yet started. Create new PRDs here.
  - Naming: prd-007-feature-name/ with prd-007-feature-name-index.md inside
  - Sub-features: prd-007a-feature-name-backend.md, prd-007b-feature-name-ui.md
  - QA folder: qa/prd-007-feature-name-qa.md (created by quality-guardian)
  Move to in-work/ when implementation begins.
---

# Requirements: Backlog

Planned PRDs not yet in implementation. All new PRD folders are created here. The current Honeycomb build plan is 20 modules across six phases, foundation first, each module a `prd-<###>-<slug>/` folder with an index and scoped sub-PRDs.

## Current backlog

| Phase | PRD | Module | Priority |
|---|---|---|---|
| 0 Foundation | prd-001 | monorepo-foundation | P0 |
| 0 Foundation | prd-002 | deeplake-storage-adapter (critical path) | P0 |
| 0 Foundation | prd-003 | core-data-model | P0 |
| 1 Runtime | prd-004 | daemon-runtime | P0 |
| 1 Runtime | prd-005 | capture-intake | P0 |
| 2 Engine | prd-006 | memory-pipeline | P0 |
| 2 Engine | prd-007 | retrieval | P0 |
| 2 Engine | prd-008 | knowledge-graph-ontology | P1 |
| 2 Engine | prd-009 | pollinating-loop | P2 |
| 2 Engine | prd-010 | model-provider-router | P1 |
| 3 Tenancy + security | prd-011 | tenancy-and-auth | P0 |
| 3 Tenancy + security | prd-012 | secrets | P1 |
| 4 Sources + knowledge product | prd-013 | sources-and-documents | P1 |
| 4 Sources + knowledge product | prd-014 | codebase-graph | P2 |
| 4 Sources + knowledge product | prd-015 | virtual-filesystem | P2 |
| 5 Learning + sharing | prd-016 | skillify | P1 |
| 5 Learning + sharing | prd-017 | wiki-summaries | P1 |
| 5 Learning + sharing | prd-018 | team-skill-sharing | P2 |
| 6 Integrations + surfaces | prd-019 | harness-integrations | P0 |
| 6 Integrations + surfaces | prd-020 | surfaces | P1 |

Pre-merge PRDs are kept under [`../archive/`](../archive/README.md).

## Creating a new PRD

1. Find `max_n` across `backlog/prd-*/`, `in-work/prd-*/`, `completed/prd-*/`.
2. Create `prd-<max_n + 1>-<kebab-slug>/`.
3. Create `prd-<###>-<slug>-index.md` (module overview + feature list).
4. Create `qa/` subfolder (empty; `quality-guardian` writes reports here).
5. Add sub-PRDs `prd-<###>a-<slug>-<feature>.md` etc. as needed.
