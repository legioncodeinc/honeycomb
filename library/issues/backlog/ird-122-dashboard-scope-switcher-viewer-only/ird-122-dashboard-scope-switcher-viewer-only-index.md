# IRD-122: Dashboard scope switcher is viewer-only — switching does not persist

> **GitHub Issue:** [#122](https://github.com/legioncodeinc/honeycomb/issues/122) - Bug
>
> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Reporter:** Mario Aldayuz (@legioncodeinc)

---

## Problem

**Observed:** Switching **Org → Workspace → Project** in the dashboard switcher persists nothing. After selecting "Legion Code Inc." in the dashboard UI, `honeycomb whoami` and `~/.deeplake/credentials.json` still reported the previous org (OSPRY), and the daemon kept capturing into the old scope. The user concluded, correctly, "it's not persisting."

**Expected:** A user reads the Org/Workspace/Project switcher as "set where Honeycomb reads and writes." Either it should actually change the active scope, or it should be unmistakably presented as a view-only filter.

**Reproduction steps:**

1. Log in (lands in the account's first org, e.g. OSPRY/default).
2. In the dashboard switcher, select a different org/workspace (e.g. Legion Code Inc.).
3. Run `honeycomb whoami` (or inspect `~/.deeplake/credentials.json`).
4. Observe it still reports the original org/workspace; the daemon's capture scope is unchanged.

---

## Root cause

The switcher is viewer-side **by design** (PRD-049e), but nothing communicates that to the user:

- [`src/dashboard/web/scope-context.tsx:22`](../../../../src/dashboard/web/scope-context.tsx) — the selection is persisted **only to `localStorage`** (`honeycomb.dashboard.scope`).
- [`src/dashboard/web/scope-context.tsx:101`](../../../../src/dashboard/web/scope-context.tsx) — `selectProject … re-scope the pages (viewer-side; no registry write — 49e-AC-4)`.
- [`src/daemon/runtime/projects/scope-enumeration-api.ts`](../../../../src/daemon/runtime/projects/scope-enumeration-api.ts) — the scope API is all **GET reads**; the org-change "re-mint" only enumerates the other org's workspaces for the dropdown, it never calls `saveDiskCredentials`.

The only paths that persist active tenancy are CLI: `honeycomb org switch` (re-mints an org-bound token + saves) and `honeycomb workspace switch` (saves). The **project** axis has no persisted "active project" at all — capture is resolved per-session from cwd — so the dashboard project dropdown can never mean "capture here," only "view this."

---

## Fix plan

1. Decide the contract per axis (see open question) and make the switcher honest:
   - **Org/Workspace:** wire the dashboard selection to the daemon `org switch` / `workspace switch` code paths so it persists to `credentials.json` (org switch re-mints, per [`src/cli/org.ts:206`](../../../../src/cli/org.ts)). Surface the re-mint/loading state.
   - **Project:** present the project dropdown explicitly as a **view filter** (it cannot set capture scope — that is cwd-driven), and point the user to binding (Hive PRD-014) for "make Honeycomb source this."
2. Add a visible label/affordance distinguishing "viewing scope" from "active capture scope" wherever the switcher renders.
3. If org/workspace persistence is wired, ensure it is session-safe and reflects in `honeycomb whoami` immediately.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the dashboard org/workspace switcher, when the user selects a new value, then either `~/.deeplake/credentials.json` is updated via the daemon switch path (and `whoami` reflects it) or the control is unambiguously labeled view-only. |
| AC-2 | Given an org change wired to persist, when it completes, then the org-bound token is re-minted (PRD-011 mechanic) exactly as `honeycomb org switch` does. |
| AC-3 | Given the project dropdown, when the user reads the UI, then it is clear that selecting a project changes the **view**, not where capture is written (which is folder/binding-driven). |
| AC-4 | Given any switcher change, when it occurs, then it is never a silent no-op — the user gets feedback that it persisted or that it is a view filter. |

---

## Files touched

- [`src/dashboard/web/scope-context.tsx`](../../../../src/dashboard/web/scope-context.tsx)
- [`src/daemon/runtime/projects/scope-enumeration-api.ts`](../../../../src/daemon/runtime/projects/scope-enumeration-api.ts) (add a persist/switch route if org/workspace is wired)
- [`src/cli/org.ts`](../../../../src/cli/org.ts) (reuse the `org switch` / `workspace switch` persistence)
- Dashboard switcher slot component(s) rendering the dropdowns + labels.

---

## Out of scope

- Building the Projects page / folder binding (that is [Hive PRD-014](../../../../../hive/library/requirements/backlog/prd-014-projects-onboarding/prd-014-projects-onboarding-index.md)).
- Changing the underlying tenancy model or the cwd-driven project resolution (PRD-049 is unchanged).
- Workspace/org creation.

---

## Related

- [PRD-049e: Dashboard Scope Switcher](../../../requirements/completed/prd-049-multi-project-and-context-switching/prd-049e-multi-project-and-context-switching-dashboard-scope-switcher.md) — the viewer-only design this corrects.
- [Hive PRD-014: Project Onboarding and the Projects Page](../../../../../hive/library/requirements/backlog/prd-014-projects-onboarding/prd-014-projects-onboarding-index.md) — the positive feature this defect motivates (AC-6).
- [`src/cli/org.ts`](../../../../src/cli/org.ts) — `org switch` / `workspace switch` persistence mechanics.
