# How to add a dashboard page

> Category: Frontend | Version: 1.0 | Date: June 2026 | Status: Active

A contributor how-to: adding a page to the daemon-served dashboard is one registry entry plus one component. Owner of the seam: PRD-037 (Dashboard Nav Shell); consumers: PRD-038 (home reorg), PRD-039 (Harnesses), PRD-040 (Memories), PRD-041 (Graph), PRD-042 (Sync), PRD-043 (Logs), PRD-044 (Settings).

**Related:**
- [`../frontend/dashboard-architecture.md`](../frontend/dashboard-architecture.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)

The `/dashboard` mini-site is a left-nav multi-page app shell (PRD-037). The shell, the sidebar
(`src/dashboard/web/sidebar.tsx`), the hash router (`src/dashboard/web/router.tsx`), and the app-shell
split (`src/dashboard/web/app.tsx` → `<Shell>`), is built once. Adding a page is **one registry entry
plus one component**. You do **not** edit the sidebar or the router.

## The 3-step recipe

### 1. Write a page component

A page takes the shared `PageProps` (`src/dashboard/web/page-frame.tsx`) and wraps its content in
`<PageFrame>`:

```tsx
import React from "react";
import { PageFrame, usePoll, type PageProps } from "../page-frame.js";

export function LogsPage({ wire, daemonUp }: PageProps): React.JSX.Element {
  const [lines, setLines] = React.useState<string[]>([]);
  // Hydrate the SAME way the dashboard does: fetch-on-mount + poll + cleanup-on-unmount.
  usePoll(async () => {
    const records = await wire.logs(40);
    setLines(records.map((r) => `${r.method} ${r.path}`));
  }, 2500);

  return (
    <PageFrame title="Logs" eyebrow="live stream">
      {/* your panels here */}
    </PageFrame>
  );
}
```

Rules:

- **Use the shared `wire`** the shell passes in `PageProps`, never call `createWireClient()` yourself
  (the shell builds exactly one client and hands it down).
- **The shell owns the daemon-down state** (D-5). When the daemon is unreachable the shell swaps the
  whole content region for the `ConnectivityBanner`; your page only ever renders for an up daemon. Use
  `daemonUp` only if you want to gate your own polling further.
- **DS tokens only.** Every color/space/font is an existing `var(--…)` token (the same set the rest of
  the dashboard uses). No new design system, no new dependency.
- **No secret in the page.** The shell stays local-mode-only and XSS-safe; render subsystem state, never
  a token/credential/header (D-9).
- **`usePoll(fn, ms)`** is the documented hydration recipe (fetch-on-mount + interval + cleanup). Reuse
  it instead of re-deriving the lifecycle.

### 2. Add one registry entry

In `src/dashboard/web/registry.tsx`, add a `RouteEntry` to the `ROUTES` array, in nav order:

```tsx
{ route: "/logs", label: "Logs", icon: LogsIcon, component: LogsPage },
```

That is it. The sidebar renders the nav item from the registry; the router outlet mounts your component
when the hash matches the route. The icon is an inline-SVG `ReactNode` stroked in `currentColor` (the
sidebar tints it active/resting by row color), no icon-font, no icon registry.

### 3. (Optional) Declare a dynamic group

If your page's nav children come from **live install state** rather than a fixed list, e.g. the
per-installed-harness items under Harnesses (PRD-039), set `dynamic` on the entry:

```tsx
{
  route: "/harnesses",
  label: "Harnesses",
  icon: HarnessesIcon,
  component: HarnessesPage,
  dynamic: { resolve: (live) => /* compute SubItem[] from live install state */ },
}
```

`dynamic.resolve(live)` returns `SubItem[]` (`{ route, label }`) computed at render. These are
**children** of a static top-level entry, distinct from the seven fixed routes. The registry defines the
**contract**; the live data source is the consuming PRD's call (PRD-037 OQ-3). "Dynamically loaded" here
means "registry entries computed from live state at render", **not** lazy code-splitting, the bundle
stays one file (`/dashboard/app.js`).

## Why this seam exists

- **Hash routing, not History API** (PRD-037 D-1): the daemon host (`src/daemon/runtime/dashboard/host.ts`)
  serves the dashboard at exactly four GET routes with no catch-all. A refresh on a real path
  (`/dashboard/graph`) would 404; the hash fragment (`/dashboard#/graph`) is client-only, so deep links
  are refresh-safe with zero host changes. Do not add a daemon route.
- **One registry, two consumers** (D-7): the sidebar and the router outlet both read `ROUTES`. Editing
  the list in one place updates both, which is exactly why adding a page never touches `sidebar.tsx` or
  `router.tsx`.
- **Lift-and-shift, then reorganize** (D-6): PRD-037 moved the old single-page content verbatim onto the
  Dashboard route (`pages/dashboard.tsx`) with zero regression. Reorganizing that home page is PRD-038's
  job; the other six pages (039-044) fill the empty-framed placeholders.

## Proof the seam works

`tests/dashboard/web/registry.test.tsx` adds a **throwaway** registry entry in a test and proves it
appears in the nav **and** routes to its component without editing `sidebar.tsx` or `router.tsx`
(PRD-037c AC-6). That is the guarantee PRDs 038-044 build against.
