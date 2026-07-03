# Archived Requirements

> Status: Archived | Date: June 2026 (fleet-realignment additions July 2026)

Pre-merge PRDs, kept for reference. These were set aside when Honeycomb began a fresh PRD effort and do not reflect the current plan.

- `backlog/` — the original honeycomb backlog scaffolds (prd-001 through prd-010): install scripts, service core, web onboarding, library standardizer, repository scanner, dashboard, auto-start hooks, auto-update and skill sync, bundled skills and agents, brand application.
- `completed/` — Hivemind-era completed PRDs for the Cursor extension line (prd-002 through prd-005): extension core, dashboard, graph visualizer, skillify bridge.

## Fleet-realignment moves (July 2026)

These PRDs were authored in honeycomb's backlog but belong to other repos under the three-daemon fleet realignment. Each was archived here and copied to its owning repo:

| Archived PRD | Owning repo | Canonical location | Notes |
|---|---|---|---|
| `prd-067-doctor-boot-grace-release-blocker/` | doctor | `doctor/library/requirements/completed/prd-003-doctor-boot-grace-release-blocker/` | Implemented and verified 2026-06-29 (see `library/ledger/EXECUTION_LEDGER-prd-067.md`) |
| `prd-068-portal-daemon-boot-shell/` | hive | `hive/library/requirements/archive/prd-006-portal-daemon-boot-shell/` | Superseded by hive PRD-003/PRD-004 before implementation |
| `prd-069-application-health-dashboard/` | hive + doctor | `hive/library/requirements/archive/prd-007-application-health-dashboard/` | Superseded by doctor PRD-001/PRD-002 and hive PRD-005 |
| `prd-070-first-browser-load-experience/` | hive | `hive/library/requirements/archive/prd-008-first-browser-load-experience/` | Superseded by hive PRD-003/PRD-004 before implementation |

Honeycomb PRD numbers 067-070 stay burned; they are not reused.

New PRDs are authored under `requirements/backlog/` and move through `in-work/` to `completed/`. See [`../../knowledge/private/standards/documentation-framework.md`](../../knowledge/private/standards/documentation-framework.md) for the PRD format.
