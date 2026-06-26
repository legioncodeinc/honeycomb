# PRD-059a: Capture Gating Until First Project Bind

> **Parent:** [PRD-059](./prd-059-projects-onboarding-index.md)
> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None (reads the 049a registry/cache; an optional additive onboarding marker).
> **Resolves:** [IRD-123](../../../issues/backlog/ird-123-gate-capture-until-first-project-bind/ird-123-gate-capture-until-first-project-bind-index.md)

---

## Overview

PRD-049a chose "capture is never dropped — an identity-less folder falls to the per-workspace `__unsorted__` inbox." That is the right default for a *set-up* user, but for a brand-new user with **zero** bound projects it means Honeycomb hoards unscoped sessions and memories before the user has chosen anything to track. This sub-PRD adds a **first-run capture gate**: while the active workspace has no bound project, the capture/recall hooks no-op (with a single "bind a project to start" notice) rather than writing to `__unsorted__`. The moment the first project is bound, normal capture — including, by default, the inbox fallback for genuinely unbound folders — resumes.

This is a deliberate, scoped reversal of 049a's "never drop", limited to the zero-projects pre-onboarding state. It is the behavioral half of the "pick a folder to start" onboarding (059b is the UI half).

## Goals

- When the active workspace has **no** bound projects (registry/cache shows only the reserved `__unsorted__` inbox and no real binding), the capture, summarization, skillify, and graph pipelines do **no work** and write **no rows**.
- The gate is read locally and cheaply (from `~/.deeplake/projects.json` / the resolver), with **no** network round-trip on the capture hot path — failing open is not acceptable here, but the check is a local count, not a DeepLake call.
- The user gets exactly one quiet, non-spammy notice that capture is paused until they bind a project (surfaced once per session, not per turn).
- After the first bind, the gate opens and stays open for that workspace; the existing 049a inbox-fallback for unbound folders resumes as the default (per the parent open question).

## Non-Goals

- Removing the `__unsorted__` inbox. The inbox stays as the post-onboarding fallback for unbound folders; this gate only suppresses it in the zero-projects first-run state.
- Deleting or re-filing data already in `__unsorted__` from before this ships (owned by the 049 inbox-hygiene open question).
- Any UI (059b/059c own the onboarding surfaces); this is the hook-side gate + notice.

## User stories

- As a brand-new user, I log in, start coding in Claude Code, and Honeycomb does **not** silently start recording — it tells me once "bind a project to start" and waits.
- As a set-up user with three projects, when I open a scratch folder with no binding, capture still falls to the inbox as before — the gate is invisible to me.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given a workspace with zero bound projects, when a capture hook fires, then it writes no row to `sessions`/`memory`/`memory_jobs` and enqueues no pipeline job. |
| a-AC-2 | Given that state, when capture is suppressed, then the user sees a single "bind a project to start" notice per session (not per turn), with the command/dashboard action to do so. |
| a-AC-3 | Given the gate check, when it runs on the capture hot path, then it resolves from the local binding store with no DeepLake network call. |
| a-AC-4 | Given the user binds their first project, when the next session under that folder runs, then capture proceeds normally and persists rows. |
| a-AC-5 | Given ≥1 bound project, when a session runs in an unbound folder, then the 049a `__unsorted__` inbox fallback applies as before (the gate is first-run-only). |

## Implementation notes

- The gate is a predicate over the 049a store: "are there any non-`__unsorted__` projects with a binding for this workspace/device?" Read it where the resolver already reads `projects.json` ([`src/hooks/shared/project-resolver.ts`](../../../../src/hooks/shared/project-resolver.ts)); the capture handler ([`src/daemon/runtime/capture/capture-handler.ts`](../../../../src/daemon/runtime/capture/capture-handler.ts)) consults it before writing.
- The notice must be idempotent per session — reuse the session-start seam ([`src/hooks/shared/session-start.ts`](../../../../src/hooks/shared/session-start.ts)) rather than emitting on every turn.
- Keep the gate **fail-safe-closed for writes but fail-open for the notice**: if the store read errors, prefer the existing 049a behavior (do not hard-block a set-up user because a cache read hiccuped) — the zero-state is unambiguous (empty/missing store), so a malformed store is treated as "not yet onboarded" only when it is genuinely empty, not on a transient error.

## Open questions

- [ ] Does the gate suppress the embeddings warmup / daemon pipeline workers too, or only the writes? (Lean: suppress writes + heavy pipeline jobs; let the daemon idle cheaply.)
- [ ] Per-workspace vs per-device gate: if the user is set up on device A but fresh on device B (same workspace, registry has projects but this device has no local binding), does B capture or gate? (Lean: gate on *local* binding so B onboards via import — ties to 059d.)

## Related

- [PRD-049a: Project Identity and Resolution](../../completed/prd-049-multi-project-and-context-switching/prd-049a-multi-project-and-context-switching-project-identity-and-resolution.md) — the inbox "never drop" policy this scopes.
- [IRD-123](../../../issues/backlog/ird-123-gate-capture-until-first-project-bind/ird-123-gate-capture-until-first-project-bind-index.md) — the reported defect this resolves.
- [`src/daemon/runtime/capture/capture-handler.ts`](../../../../src/daemon/runtime/capture/capture-handler.ts) · [`src/hooks/shared/project-resolver.ts`](../../../../src/hooks/shared/project-resolver.ts)
