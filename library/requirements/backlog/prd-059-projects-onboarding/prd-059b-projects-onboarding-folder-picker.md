# PRD-059b: First-Run Empty State and the Folder Picker

> **Parent:** [PRD-059](./prd-059-projects-onboarding-index.md)
> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None (writes the 049a binding store via the daemon).

---

## Overview

The dashboard's answer to a zero-projects workspace today is an empty switcher and nothing to do. This sub-PRD replaces that with a purposeful first-run state — *"No active projects? Pick a folder to start"* — and the mechanism behind it: a **daemon-served folder picker** that returns a real, absolute, bindable path and writes the 049a binding.

The mechanism matters because of a hard browser constraint: a web page **cannot** read an absolute filesystem path. The File System Access API (`showDirectoryPicker`) returns an opaque handle, not a path, by design. So the picker cannot live purely in the browser. The local daemon, which already has filesystem access, serves a directory-browse endpoint; the dashboard renders that browse tree and posts the chosen absolute path back to bind. This is loopback-only and local-mode-gated, consistent with the rest of the dashboard control surface.

## Goals

- A new user with zero bound projects sees one primary call-to-action — **"Pick a folder to start"** — with one or two sentences of plain instruction: *point Honeycomb at the repo or folder you want it to remember.*
- The folder picker is **path-correct**: it returns the real absolute path of the chosen folder (via the daemon), not a browser handle, so the binding is usable by the cwd resolver.
- Picking a folder with a git remote pre-fills the suggested project name from the canonical remote (reusing 049d's `suggestProjectId`), which the user can accept or rename.
- On bind, the empty state is replaced by the Projects page (059c) and capture begins (059a gate opens).

## Non-Goals

- The Projects management page itself (059c) and cross-device import (059d).
- Auto-scanning for repos to pre-populate choices (explicit non-goal of the parent).
- A native OS file dialog — the picker is the daemon-served browse tree rendered in the dashboard, not an OS dialog the browser cannot invoke for paths.

## User stories

- As a new user, the dashboard says "No active projects? Pick a folder to start." I click it, browse to `C:\Users\me\GitHub\my-repo`, accept the suggested name `my-repo`, and Honeycomb starts remembering that project.
- As a user pointing at a non-git folder, I pick it, type a name, and it binds just the same (git is optional).

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given zero bound projects, when the dashboard loads, then the primary content is the "Pick a folder to start" CTA with instructions — not an empty switcher or a blank page. |
| b-AC-2 | Given the picker, when the user browses, then folders are enumerated by the **daemon** (loopback, local-mode-gated) and the selected item yields a real absolute path. |
| b-AC-3 | Given a chosen folder under a git repo, when the picker resolves it, then the project-name field is pre-filled from the canonical git remote (049d parity), editable before confirm. |
| b-AC-4 | Given the user confirms, when the bind completes, then the absolute path → project is written to the 049a store, the 059a gate opens, and the UI advances to the Projects page. |
| b-AC-5 | Given the daemon is unreachable or local-mode is off, when the user opens the picker, then they get a plain message (and the CLI `honeycomb project bind` fallback), never a hang or a silent failure. |

## Implementation notes

- **Daemon browse endpoint:** a new loopback `GET /api/.../fs/browse?path=<dir>` returning immediate children (dirs only, with a marker for git repos), rooted sensibly (home dir by default) and refusing to traverse outside an allowed root. Guard exactly like the other dashboard control routes (local-mode + loopback).
- **Bind:** `POST /api/.../projects/bind { path, name }` → writes via the same code path as `honeycomb project bind` ([`src/cli/project.ts`](../../../../src/cli/project.ts)) so the dashboard and CLI never diverge on the store format.
- **Name suggestion:** reuse `suggestProjectId` (049d) so the dashboard and CLI suggest identically.
- **Empty-state detection:** the same 059a "zero bound projects" predicate drives whether the dashboard shows the CTA vs the Projects page.

## Open questions

- [ ] Browse root + traversal policy: start at home dir and allow anywhere under it, or let the user type/paste a root? Security: the daemon must not become an arbitrary-filesystem reader for a non-local caller (loopback + local-mode is the guard, but confirm the allowed-root policy).
- [ ] Should the picker also accept a pasted absolute path (power-user fast path) in addition to the browse tree?
- [ ] First-run vs returning-empty: identical CTA, or does a returning user who unbound everything get a lighter prompt?

## Related

- [PRD-059a: Capture Gating](./prd-059a-projects-onboarding-capture-gating.md) — the gate this CTA resolves by binding.
- [PRD-049d](../../completed/prd-049-multi-project-and-context-switching/prd-049d-multi-project-and-context-switching-org-workspace-switching.md) — `bind` store + `suggestProjectId` reused here.
- [PRD-050a: Quick Install](../../completed/prd-050-quick-install-and-guided-setup/prd-050-quick-install-and-guided-setup-index.md) — the guided-setup dashboard this empty state lives inside.
- [`src/dashboard/web/scope-context.tsx`](../../../../src/dashboard/web/scope-context.tsx) · [`src/cli/project.ts`](../../../../src/cli/project.ts)
