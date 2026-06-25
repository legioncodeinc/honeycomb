# PRD-050b: Pre-Auth Dashboard and Guided Setup Shell

> **Parent:** [PRD-050](./prd-050-quick-install-and-guided-setup-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None. Adds local-only setup-state endpoints; reads an onboarding state file.

---

## Overview

This sub-PRD answers the question the parent poses directly — *"do we need the dashboard on a separate daemon before they log in, with the other daemons coming up after?"* — and the answer it implements is **one daemon, two phases, no second process**.

The daemon **already** serves a self-hydrating, token-free dashboard shell over loopback ([`renderShell` / `mountDashboardHost`](../../../../src/daemon/runtime/dashboard/host.ts)), and it does **not** require DeepLake credentials to *boot* — only to serve the surfaces that read DeepLake. So the lifecycle is: boot the daemon in a **pre-auth phase** (dashboard + guided-setup wizard render, DeepLake surfaces show an empty/"connect me" state), the user completes login (050c) which writes the shared credential, and the **same** daemon flips to the **authenticated phase** where capture/recall/graph hydrate. The embeddings runtime is a **lazily-warmed sub-daemon** — it is the closest thing to "another daemon," but it comes up in the **background** when first needed and never gates the dashboard or the login.

This module owns the phase model, the credential-presence detection that drives which setup state the dashboard shows, and the live transition from pre-auth to authenticated **on the same daemon, with no restart and no re-opening of the dashboard tab**. (050c *does* open a DeepLake verification/account tab to complete login — that browser launch is intentional; what this module rules out is a *second daemon* and a *dashboard reload/relaunch* after the credential lands.)

## Goals

- **Boot-without-credentials:** the daemon starts and serves `GET /dashboard` with zero credentials on disk; nothing in the pre-auth path throws or fails-closed on a missing token (it shows a "connect" state instead).
- **A guided-setup wizard** rendered in the dashboard when credentials are absent, fronted by a **"First time setup"** button (the click handler is 050c's login; the migration variant is 050d).
- **Credential-presence detection** via a local-only `GET /setup/state` that reports: are `~/.deeplake` / `~/.honeycomb` / `~/.hivemind` present, what onboarding phase are we in, and is a prior tool (Hivemind) detected — so the dashboard renders **fresh-install** vs **has-Hivemind** vs **already-linked** correctly.
- **Live phase transition:** when login completes and the credential is written, the DeepLake-backed surfaces hydrate against the **already-running** daemon — the page re-queries and lights up; no `honeycomb daemon restart`, no second tab.
- **Embeddings sequencing:** the `@huggingface/transformers` model warmup runs in the background; until it is warm, recall degrades to the BM25/lexical fallback — the dashboard and login never wait on the model.
- **No-secret, local-only, local-mode-only:** the new setup endpoints sit under the dashboard host group and obey the same `mode === "local"` gate; the shell still carries no token (parent AC-8).

## Non-Goals

- The device-flow mechanics + referral header (050c) and the Hivemind uninstall (050d) — this owns the phase model + detection + the wizard frame they plug into.
- Re-skinning the dashboard or adding product pages (PRD-024 / dashboard PRDs own that).
- The embeddings daemon's internal lifecycle — only its **non-blocking sequencing** relative to the dashboard is in scope.

## User stories

- As a fresh user, the dashboard loads instantly after install and clearly says "let's connect your account" with one button — not an error about missing credentials.
- As a user who just finished login in the browser, my dashboard fills with real data on its own, in the same tab, seconds later.
- As a user on a slow connection, the dashboard is responsive even while the embedding model is still downloading in the background.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | With **no** credentials on disk, the daemon boots and `GET /dashboard` returns 200 and renders the guided-setup state — no throw, no fail-closed, **no second daemon process** spawned to serve it. |
| b-AC-2 | `GET /setup/state` (loopback, local-mode-only) accurately reports presence of `~/.deeplake` / `~/.honeycomb` / `~/.hivemind`, the onboarding phase, and prior-tool detection, fail-soft on a missing/malformed onboarding file. |
| b-AC-3 | When a credential is written by the login flow, the running daemon serves the authenticated dashboard surfaces on the **next request** with **no restart** — a test drives pre-auth → write creds → authenticated query against one daemon instance. |
| b-AC-4 | The pre-auth shell carries no token/secret (byte-parity assertion with [`renderShell`](../../../../src/daemon/runtime/dashboard/host.ts)); the setup endpoints are unreachable in non-local mode. |
| b-AC-5 | The embedding model warmup is observably backgrounded: the dashboard responds and the login completes while the model is still loading, with recall falling back to lexical until warm. |
| b-AC-6 | The "First time setup" button is present in the fresh-install state and absent once a valid credential exists (the dashboard shows the linked/authenticated state instead). |

## Implementation notes

- **The boot-without-creds invariant is the crux.** Audit the daemon assembly path so the dashboard host + setup routes mount **before/independent of** any credential read, and the DeepLake-backed seams degrade to an empty state (not a 500) when `loadCredentials()` returns `null` ([`credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts) already returns `null`, not a throw, on a missing/malformed file — lean on that).
- **Phase is derived, not stored as truth:** "authenticated" = a valid credential loads; the onboarding file is a hint for *which wizard copy* to show, never the source of truth for auth. This avoids a stale-state bug where the file and the credential disagree.
- **Setup routes** (`GET /setup/state`, and 050c's `POST /setup/login`, 050d's `POST /setup/migrate-from-hivemind`) register beside [`mountDashboardHost`](../../../../src/daemon/runtime/dashboard/host.ts) under the same root group + local-mode gate.
- **Live hydration** is a front-end concern: the dashboard polls `GET /setup/state` (or a lightweight `/health`-style auth-status field) while on the setup screen, and on transition swaps to the authenticated views — reusing the existing self-hydration the shell already does from live endpoints.
- **Embeddings:** confirm the warmup is triggered lazily (first recall) or on a background timer post-boot, never synchronously in the daemon's listen path.

## Open questions

- [ ] The exact pre-auth empty-state UX for the DeepLake surfaces (blank cards + "connect" CTA vs a single full-screen wizard until linked).
- [ ] Poll vs server-push for the pre-auth→authenticated transition (poll `/setup/state` is simplest; SSE is nicer but heavier).
- [ ] Does any current daemon seam read credentials eagerly at assembly time and throw? (Audit + fix is part of b-AC-1.)
- [ ] Where the onboarding state file lives (`~/.deeplake/onboarding.json` vs the runtime dir) — coordinate with 050a which writes it first.

## Related

- [`src/daemon/runtime/dashboard/host.ts`](../../../../src/daemon/runtime/dashboard/host.ts) — the token-free self-hydrating shell + host group the setup routes join.
- [`src/daemon/runtime/auth/credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts) — `loadCredentials()` returns `null` (not a throw) on absent creds — the basis for boot-without-creds.
- [`src/commands/daemon.ts`](../../../../src/commands/daemon.ts) — the single-daemon lifecycle (no second process introduced).
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md) · [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md) — where the local-mode gate + assembly order live.
- [Adding a Page](../../../knowledge/private/dashboard/adding-a-page.md) — the dashboard wiring the wizard frame follows.
</content>
