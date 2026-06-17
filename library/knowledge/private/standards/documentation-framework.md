# Documentation Framework

> Category: Standards | Version: 1.0 | Date: June 2026 | Status: Canonical

The single source of truth for how documentation is written in the Honeycomb knowledge base. Every document, from feature PRDs and issue IRDs to QA reports, architecture docs, API references, and guides, must conform to the standards defined here. If a document type is not covered, add a new section to this file rather than inventing a local convention.

**Related:**
- [Overview](../overview.md)
- [System Overview](../architecture/system-overview.md)
- [Coding Standards (TypeScript)](coding-standards-typescript.md)
- [API Design Conventions](api-design-conventions.md)

---

## 1. Document Types

Honeycomb keeps a small, fixed catalog of document types. Each type has a single home and a single primary audience. Requirements docs live under `library/requirements/`, and everything meant to be read as reference lives under `library/knowledge/`.

| Type | Purpose | Location | Primary audience |
|---|---|---|---|
| Issue IRD | Implementation plan for a specific GitHub issue | `library/requirements/issues/issue-<###>-<title>/ird-issue-<###>-<title>.md` | Implementation engineer |
| Feature PRD | Planned feature spec, forward or retroactive | `library/requirements/features/feature-<###>-<title>/prd-feature-<###>-<title>.md` (or `prd-feature-<###>-<title>-ck-<clickupId>.md` if from ClickUp) | Implementation engineer |
| QA Report (tied) | Audit of an implementation against its plan | The plan's own `reports/<date>-qa-report.md` subfolder | Team lead, feature author |
| QA Report (standalone) | Audit not tied to a single plan | `library/qa/<domain>/<date>-qa-report.md` | Team lead, audit reviewer |
| Architecture Doc | System design, data flows, component relationships | `library/knowledge/.../architecture/` | Senior engineers, architects |
| API Reference | Endpoint-by-endpoint documentation with schemas | `library/knowledge/.../api/` | Frontend devs, API consumers |
| How-to Guide | Runbooks for setup, testing, deploying, adding features | `library/knowledge/.../how-to-guides/` | New engineers, DevOps |
| Integration Doc | Third-party service configuration and error handling | `library/knowledge/.../integrations/` | DevOps, engineers wiring services |
| UX/UI Standard | Visual design language: tokens, components, patterns | `library/knowledge/.../design/` | Designers, frontend devs |
| Feature Doc | Completed feature reference, post-ship | `library/knowledge/.../features/` | Any engineer joining the project |
| Spec | Feature-level handoff spec for a UI flow | `library/knowledge/.../specs/` | Frontend engineers |
| Product Brief | Product vision, scope, roadmap | `library/knowledge/.../product/` | Team, stakeholders |
| Standards Doc | Rules for writing the code and the docs themselves | `library/knowledge/.../standards/` | All contributors |
| Release Notes | What changed in each release | `library/knowledge/.../releases/` | All team members |

---

## 2. Universal Document Header

Every markdown file under `library/knowledge/` starts with the same header. This is the canonical Honeycomb format:

```markdown
# <Document Title>

> Category: <Type> | Version: <X.Y> | Date: <Month YYYY> | Status: <Active | Draft | Archived | Canonical>

<One-sentence description of what this document covers and who should read it.>

**Related:**
- [Title of related doc](../relative/path.md)
- [Source code: `src/path/to/file.ts`]
```

- Version starts at `1.0`. Patch bumps (`1.0` to `1.1`) cover additions; minor bumps (`1.x` to `2.0`) cover reorganizations.
- Date is the current month and year on the last meaningful edit, written as `Month YYYY`.
- The one-line description is a single sentence, no period required, that says what the doc covers.
- The `**Related:**` block carries three to six links, a mix of sibling docs (relative paths) and source code references.
- Status values:
  - `Active` for current docs that should be kept up to date.
  - `Draft` for work in progress that is not yet authoritative.
  - `Archived` for historical docs that are no longer maintained.
  - `Canonical` for standards docs only. This is the highest authority and overrides ad-hoc conventions.

Requirements-type docs (issue IRDs, feature PRDs, QA reports) use a different header format documented in their respective guides.

---

## 3. Filename Conventions

| Document type | Folder + filename pattern | Example |
|---|---|---|
| Issue IRD | `issue-<###>-<title>/ird-issue-<###>-<title>.md` (with sibling `reports/`) | `issue-046-stale-cached-responses/ird-issue-046-stale-cached-responses.md` |
| Feature PRD | `feature-<###>-<title>/prd-feature-<###>-<title>.md` (with sibling `reports/`) | `feature-007-agent-memory-export/prd-feature-007-agent-memory-export.md` |
| Feature PRD (from ClickUp) | `feature-<###>-<title>/prd-feature-<###>-<title>-ck-<clickupId>.md` | `feature-007-agent-memory-export/prd-feature-007-agent-memory-export-ck-86c8wq2k1.md` |
| QA report (tied to plan) | `<plan-folder>/reports/<date>-qa-report.md` | `feature-007-agent-memory-export/reports/2026-04-26-qa-report.md` |
| QA report (standalone) | `library/qa/<domain>/<date>-qa-report.md` | `library/qa/auth/2026-04-26-qa-report.md` |
| Knowledge base | `<domain>/<kebab-slug>.md` (no numeric prefix) | `architecture/system-overview.md` |

Numbering rules:

- `<###>` is three-digit zero-padded (`006`, `046`, `093`, `100`). Numbers wider than four digits use their natural width.
- Issue numbers follow the GitHub issue number.
- Feature numbers are repo-local sequential. Take `max + 1` from existing folders, counting both open and `completed/`.
- Titles are lowercase kebab-case, sixty characters or fewer.
- The optional ClickUp suffix `-ck-<clickupId>` goes on the main file only, never on the folder name.

---

## 4. Folder Location Rules

| Folder | Meaning |
|---|---|
| `library/requirements/features/feature-<###>-<title>/` | Feature work in progress. |
| `library/requirements/features/completed/feature-<###>-<title>/` | Feature has shipped. Move the entire folder (PRD plus `reports/`). |
| `library/requirements/issues/issue-<###>-<title>/` | Issue work in progress (GitHub issue OPEN). |
| `library/requirements/issues/completed/issue-<###>-<title>/` | Issue resolved (GitHub issue CLOSED). Move the entire folder (IRD plus `reports/`). Symmetric to features. |
| `<plan-folder>/reports/` | QA reports tied to that specific feature or issue. They travel with the folder when it moves. |
| `library/qa/<domain>/` | Standalone QA reports: broad audits not tied to a single plan. |

Move folders when status changes. Never edit lifecycle state in frontmatter alone.

---

## 5. Writing Rules (all doc types)

1. Ground every claim in code. Quote source with file path and line range; never paraphrase signatures.
2. One topic per document. Split if a doc exceeds roughly 500 lines.
3. Progressive disclosure. Open with why this exists and who should read it, then put deep details below.
4. Link out, do not duplicate. If another doc covers a subtopic, link to it.
5. Diagrams use mermaid. Prefer `flowchart TD` or `sequenceDiagram`. No explicit colors.
6. No time-sensitive language. Avoid "currently", "recently", "as of". Use explicit dates.
7. No personal opinions. Docs describe decisions and rationale, not preferences.
8. Write direct narrative prose. Favor paragraphs that explain over walls of bullets, and never use em dashes.
9. Product and docs are written Honeycomb. The CLI, package, path, and config are `honeycomb`. American spelling throughout.

---

## 6. Cross-Linking Conventions

Use relative paths for sibling docs, written as `[title](../relative/path.md)`. Link to code with file paths, and include line numbers where they help, written as `` `src/routes/memories.ts:42-80` ``. PRDs and IRDs link to their related issues, features, and QA reports in a `**Related:**` section. Knowledge base docs link to the PRDs that drove them, when applicable, and to the source code they describe. Every knowledge base doc carries three to six links in its header `**Related:**` block.

---

## 7. Diagram Rules

Mermaid is preferred because it renders everywhere GitHub does. Use `flowchart TD` (top-down) for process flows, `sequenceDiagram` for temporal flows, and `erDiagram` for data models. Node IDs use camelCase and carry no spaces. Do not set explicit colors, since that breaks dark mode, and do not use `click` events. Quote any label that contains parentheses, brackets, or colons.

---

## 8. Versioning and Dates

Versioning is per-document, not repo-wide; bump the version on a meaningful content change. Dates use the current month and year from the system clock, not arbitrary timestamps. Each document may optionally end with a `Changelog` section listing its version bumps.

---

## 9. Ownership

Requirements docs (issue IRDs, feature PRDs) are owned by the implementation author. QA reports are owned by the quality guardian. Knowledge base docs are owned by the team collectively, and anyone may edit them with a PR. Standards docs, this file included, require team consensus before changing.

---

## 10. Bootstrap

When the library guardian seeds a repo:

1. Replace the date placeholder in the header with the current month and year.
2. Replace any project-name placeholders in the seeded README files with Honeycomb.
3. Edit any section of this framework that does not match the team's conventions, then commit.
4. Start using the agent: ingest issues, plan features, document architecture.

---

## Changelog

- v1.0: Reconciled from the hivemind-v1 and otherhive-v1 documentation frameworks into the canonical Honeycomb standard.
