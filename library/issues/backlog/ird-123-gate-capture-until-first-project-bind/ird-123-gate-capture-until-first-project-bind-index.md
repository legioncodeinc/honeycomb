# IRD-123: Honeycomb captures before any project is bound — gate until first bind

> **GitHub Issue:** [#123](https://github.com/legioncodeinc/honeycomb/issues/123) - Enhancement
>
> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Reporter:** Mario Aldayuz (@legioncodeinc)

---

## Problem

**Observed:** On a fresh login with zero bound projects, the daemon still captures sessions/memories — they accrue to the per-workspace `__unsorted__` inbox (PRD-049a's "never drop" policy). The user has chosen no scope, yet data is being collected behind an empty Projects view.

**Expected:** Honeycomb should **not** collect memories (or run the capture / summarization / skillify / graph pipelines) until the user has explicitly bound at least one project. Onboarding should first ask the user to point at a repo/folder; capture begins only after a bind.

**Reproduction steps:**

1. Fresh install + login; do not bind any project.
2. Work a session in a harness (Claude Code, Cursor, etc.) in any folder.
3. Inspect the active workspace's `sessions` / `memory_jobs` tables.
4. Observe rows accruing under the `__unsorted__` project despite no user-chosen scope.

---

## Root cause

By design: [PRD-049a](../../../requirements/completed/prd-049-multi-project-and-context-switching/prd-049a-multi-project-and-context-switching-project-identity-and-resolution.md) chose "capture is never dropped — an identity-less folder falls to the per-workspace `__unsorted__` inbox" ([`src/hooks/shared/project-resolver.ts`](../../../../src/hooks/shared/project-resolver.ts), `UNSORTED_PROJECT_ID`). That is correct for a set-up user, but for the **zero-projects, pre-onboarding** state it means the product hoards unscoped data before the user has opted into anything.

---

## Fix plan

(Implemented as [PRD-059a](../../../requirements/backlog/prd-059-projects-onboarding/prd-059a-projects-onboarding-capture-gating.md) — this IRD is the reported-defect view of that sub-PRD.)

1. Add a first-run **capture gate**: a local predicate "does the active workspace have ≥1 non-`__unsorted__` project with a binding?" read from `~/.deeplake/projects.json` (no network on the hot path).
2. While the predicate is false, the capture handler ([`src/daemon/runtime/capture/capture-handler.ts`](../../../../src/daemon/runtime/capture/capture-handler.ts)) no-ops — no rows written, no pipeline jobs enqueued.
3. Emit a single per-session "bind a project to start" notice (via the session-start seam, not per turn).
4. Once the first project is bound, open the gate; the 049a `__unsorted__` inbox fallback resumes as the default for genuinely unbound folders.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a workspace with zero bound projects, when a capture hook fires, then no row is written to `sessions`/`memory`/`memory_jobs` and no pipeline job is enqueued. |
| AC-2 | Given that state, when capture is suppressed, then the user sees exactly one "bind a project to start" notice per session (not per turn). |
| AC-3 | Given the gate check, when it runs on the hot path, then it resolves from the local store with no DeepLake network call. |
| AC-4 | Given the user binds their first project, when the next session under that folder runs, then capture proceeds and persists rows. |
| AC-5 | Given ≥1 bound project, when a session runs in an unbound folder, then the 049a `__unsorted__` inbox fallback applies as before (the gate is first-run-only). |

---

## Files touched

- [`src/daemon/runtime/capture/capture-handler.ts`](../../../../src/daemon/runtime/capture/capture-handler.ts)
- [`src/hooks/shared/project-resolver.ts`](../../../../src/hooks/shared/project-resolver.ts) (expose/reuse the zero-projects predicate)
- [`src/hooks/shared/session-start.ts`](../../../../src/hooks/shared/session-start.ts) (per-session notice)

---

## Out of scope

- The onboarding UI ("Pick a folder to start") — [PRD-059b](../../../requirements/backlog/prd-059-projects-onboarding/prd-059b-projects-onboarding-folder-picker.md).
- Re-filing or deleting data already in `__unsorted__` from before the gate ships.
- Removing the inbox as a post-onboarding fallback (it stays).

---

## Related

- [PRD-059a: Capture Gating Until First Project Bind](../../../requirements/backlog/prd-059-projects-onboarding/prd-059a-projects-onboarding-capture-gating.md) — the implementing sub-PRD.
- [PRD-049a: Project Identity and Resolution](../../../requirements/completed/prd-049-multi-project-and-context-switching/prd-049a-multi-project-and-context-switching-project-identity-and-resolution.md) — the "never drop → inbox" policy this scopes for the first-run state.
