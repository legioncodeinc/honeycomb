# PRD-051b: "Open in Obsidian" — dashboard deep-link

> **Parent:** [PRD-051](./prd-051-memory-graph-obsidian-vault-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S
> **Schema changes:** None

---

## Overview

Close the loop: a button on the dashboard that exports/refreshes the vault (051a) and then **launches
Obsidian straight into it**, focused on the `Home.md` landing note. This needs **no custom plugin** —
Obsidian registers a core `obsidian://` URL protocol on install, and a plain anchor/`window.location`
to an `obsidian://open?…` URI is enough for the OS to hand off to the app.

This sub-PRD answers the three questions the feature request raised directly:
1. **Can the dashboard open Obsidian into the right vault?** Yes — `obsidian://open` with the vault
   path/name. (This PRD.)
2. **Is a plugin required?** No — the URI scheme and Markdown+wikilinks are both core Obsidian.
   (Plugins are the optional 051c layer.)
3. **A fixed area, or on-demand?** A **fixed canonical vault dir** per scope (051a), refreshed
   **on-demand** by this button — so Obsidian only needs registering once and the link is stable.

## How the deep-link works (grounded)

Per the [Obsidian URI docs](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI):

- **Open by vault name + file:** `obsidian://open?vault=<name>&file=<note>` (values URI-encoded).
- **Open by absolute path:** `obsidian://open?path=<abs-path>` — `path` overrides `vault`+`file`;
  Obsidian opens the most specific *registered* vault containing that path. This is what we use, because
  the daemon knows the absolute canonical path but not the user's chosen vault display name.
- **Registration:** on Windows/macOS, **running Obsidian once registers the `obsidian://` protocol**
  automatically; Linux needs a one-time `obsidian.desktop` `Exec` entry. Separately, the *folder* must
  be known to Obsidian as a vault — i.e. the user has "Open folder as vault" on our canonical dir once.
  v1 makes that a guided one-time step (see UX below); no plugin involved.

## Goals

- An **"Open in Obsidian"** action on the `#/graph` Memory view (and/or a small toolbar button) that:
  triggers `POST /api/vault/export` (051a), receives `{ vaultPath }`, and navigates to
  `obsidian://open?path=<encoded vaultPath>/Home.md`.
- A **first-run experience** that handles the "vault not registered yet" case: a short "Open this folder
  as a vault in Obsidian once" hint with the exact path (copy-to-clipboard), shown the first time / on
  failure — no silent dead button.
- An honest **not-installed fallback**: if Obsidian is absent (the OS can't handle `obsidian://`), show
  the vault path + a "reveal in file manager" affordance rather than hanging.
- Zero new secrets in the page; the link carries only a local filesystem path (no token/org/header).

## Non-Goals

- The export engine itself (051a).
- Auto-installing or auto-registering Obsidian / writing the user's `.obsidian` workspace (that veers
  into 051c's Advanced-URI territory). v1 guides the one-time manual registration.
- Detecting Obsidian reliably from the browser (not possible cross-platform) — we design for graceful
  failure, not detection.

## User stories

- *As a user*, I click "Open in Obsidian", Obsidian pops to the front showing my memory vault's Home
  note, and I explore the graph there.
- *As a first-time user*, the button tells me "open this folder as a vault once" with the exact path,
  then works on every subsequent click.
- *As a Linux/no-Obsidian user*, I get the vault path and a "reveal in folder" button instead of a
  silent no-op.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Clicking "Open in Obsidian" calls `POST /api/vault/export` exactly once, then navigates to a correctly URI-encoded `obsidian://open?path=…/Home.md`; double-clicks are guarded (one export). |
| b-AC-2 | When the memory graph is empty, the button is replaced by the honest "no memory graph yet — run `honeycomb pollinate trigger --compact`" state (no export, no dead link) — parity with 051a a-AC-3. |
| b-AC-3 | First-run / failure path shows the exact canonical vault path with a copy affordance and a one-line "Open folder as vault in Obsidian once" instruction; it never leaves a silent dead button. |
| b-AC-4 | The `obsidian://` URI contains only a local filesystem path — no token, org, workspace, or header — and the page renders the path as React text (XSS-safe), never `dangerouslySetInnerHTML`. |
| b-AC-5 | The action degrades safely when the daemon is down (the shell's existing daemon-down swap) and when the export returns `builtFalse` (shows b-AC-2 state). |

## Implementation notes

- **Where:** add the control to the Memory source on `src/dashboard/web/pages/graph.tsx` (it already
  branches Codebase/Memory), gated on `graph.built` / the new export response. Reuse the existing
  toolbar button styling and the `BuildGraphButton` busy/guard pattern
  (`src/dashboard/web/build-graph-button.tsx`) for the export-in-flight state.
- **Wire:** add `wire.exportVault()` → `POST /api/vault/export` in `src/dashboard/web/wire.ts`
  (zod-validated `{ vaultPath, entityCount, edgeCount, builtFalse? }`, fail-soft), stamping the same
  session/project headers the other writes use.
- **URI build:** `obsidian://open?path=` + `encodeURIComponent(join(vaultPath, "Home.md"))`. Navigate via
  a real `<a href>` (lets the OS handle the protocol) rather than `fetch`; a hidden anchor click avoids
  a blocked-popup. The browser shows its own "open external app?" prompt — acceptable, expected.
- **Fallback:** there is no reliable cross-platform "is Obsidian installed?" probe from a browser, so
  design for it: render the path + a copy button always (small, secondary), and surface the first-run
  hint. Optionally the daemon can expose "does `~/.honeycomb/obsidian/<scope>/.obsidian` exist?" as a
  weak "has been opened as a vault before" signal to decide whether to show the hint.

## Open questions

- [ ] **OQ-1:** `path=` (absolute, needs the folder registered as a vault) vs. shipping a tiny
  `.obsidian/` so the folder *is* a ready vault on first export — does writing a minimal `.obsidian/app.json`
  make first-run one-click, and does that step on user settings if they later customize? (Ties to 051a
  "preserve `.obsidian/`".)
- [ ] **OQ-2:** Should "Open in Obsidian" always re-export first (fresh but slower) or open-then-export
  (instant but possibly stale, with a "refresh" action)? Lean: export-then-open for correctness, with a
  spinner.
- [ ] **OQ-3:** Surface the same action in the CLI (`honeycomb vault open`) for headless users, or keep
  open-in-app dashboard-only?

## Related

- [PRD-051a: the export engine](./prd-051a-memory-graph-obsidian-vault-markdown-export.md) — provides `{ vaultPath }`.
- [Obsidian URI docs](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) · [Advanced URI plugin](https://github.com/Vinzent03/obsidian-advanced-uri) (optional, 051c).
- `src/dashboard/web/pages/graph.tsx` / `build-graph-button.tsx` — the patterns to reuse.
