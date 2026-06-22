# PRD-044: Settings Page (DeepLake auth · provider keys · search mode)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L
> **Owner:** `/the-smoker`

## Overview

The `#/settings` route of the multi-page dashboard shell (PRD-037). Today the only "settings" surface on the live
`/dashboard` is the small `SettingsPanel` in `src/dashboard/web/panels.tsx` (provider → model selector + a dreaming
on/off toggle + a names-only provider-key presence badge), wired through the vault `setting`/`secrets` endpoints
that PRD-032 stands up. This PRD promotes that widget into a real, full Settings PAGE and grows it into the place a
user configures their Honeycomb install end-to-end.

A user lands on `#/settings` and can:

1. **Connect to DeepLake and see their auth status** — connect/log in via the existing device-flow (or token) path
   (PRD-011 / PRD-023), and view, truthfully, what the daemon is connected as: org, workspace, agent, credentials
   source (file vs `HONEYCOMB_TOKEN` env), last-login timestamp, and token expiry when known. The token itself is
   NEVER shown.
2. **Manage provider API keys** — add or replace the API key for Anthropic (Claude), OpenAI (ChatGPT), OpenRouter,
   and Cohere, written WRITE-ONLY into the encrypted vault via the existing `POST /api/secrets/:name` path (PRD-032).
   The page shows only NAME presence ("set ✓" / "not set") from `GET /api/secrets` (names only); no endpoint ever
   returns a secret value.
3. **Pick a search (recall) mode and the existing inference settings** — choose keyword (lexical BM25/ILIKE) vs
   semantic (embeddings/vector) vs hybrid recall, persisted as a vault `setting` and honored by the recall pipeline;
   plus the migrated provider → model selector and dreaming toggle that live on the dashboard today.

This page OWNS the Settings route content; PRD-037 owns the shell, the nav slot, the router, and the page frame.
Everything reuses the EXISTING Honeycomb design system (the `var(--…)` tokens in the served `/dashboard/styles.css`)
and the ported primitives in `src/dashboard/web/primitives.tsx` — no new design system, no CDN React, no in-browser
Babel; bundled production-clean by the same esbuild entry (PRD-024 D-1 holds).

## Goals

- Ship a full Settings PAGE component (`src/dashboard/web/pages/settings.tsx`) on the `#/settings` route, hosting
  three sections — DeepLake auth, provider keys, search-mode + inference — built only from existing DS tokens and
  primitives, served production-clean by the existing esbuild entry.
- Surface DeepLake authentication status TRUTHFULLY (connected org/workspace/agent, credentials source, last login,
  token expiry when known) and offer a connect/login affordance that drives the REAL auth flow — never the token.
- Let a user add/replace the Anthropic, OpenAI, OpenRouter, and Cohere provider keys WRITE-ONLY into the encrypted
  vault, with names-only presence feedback and no value-returning route ever introduced.
- Add a recall-mode setting (`keyword` | `semantic` | `hybrid`) persisted in the vault `setting` class and honored by
  the recall pipeline, documenting how it composes with the embeddings-off lexical fallback (PRD-025 / PRD-029).
- Migrate the existing `SettingsPanel` (provider → model + dreaming toggle + key-presence) onto this page as its home,
  extending the provider-key presence model to Cohere (`COHERE_API_KEY`).
- Keep the LOCAL-MODE-ONLY + XSS-safe + no-secret-in-page posture (PRD-021d F-1 / PRD-024 D-4) intact; never render,
  return, or log a token or secret value anywhere on the page.

## Non-Goals

- The nav shell, the client-side router, the page frame, or the registry — those are PRD-037. This PRD adds ONE
  registry entry (`{ route: "#/settings", component: SettingsPage }`) and the page content behind it.
- Re-implementing the encrypted vault, the secrets crypto, or the device-flow auth machinery. This page is a thin
  loopback CLIENT of the daemon surfaces those PRDs already stand up (PRD-032 vault, PRD-011/023 auth); it adds no
  new crypto and no new persistence.
- Team / hybrid mode admin (RBAC, named API keys, rate-limit, org switching as an admin operation) — those are
  PRD-011c/011d. This page reads/shows the LOCAL connected identity and offers a single-user connect, not multi-tenant
  administration.
- Changing the recall RANKING, the RRF fusion, the embedding model, or the hybrid weighting — the mode setting only
  selects WHICH arms run; tuning the arms is PRD-007 / PRD-027 (recall) and PRD-025 / embeddings-runtime.
- Returning a secret value from any endpoint. There is, and remains, no value-returning secrets route (PRD-032 / D-2).
- The Cursor extension webview (`harnesses/cursor/extension/`) — a possible fast-follow, not in scope here.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-044a-settings-page-deeplake-auth](./prd-044a-settings-page-deeplake-auth.md) | DeepLake auth: login + status | Draft |
| [prd-044b-settings-page-provider-keys](./prd-044b-settings-page-provider-keys.md) | Provider API keys (write-only vault) | Draft |
| [prd-044c-settings-page-search-mode-and-misc](./prd-044c-settings-page-search-mode-and-misc.md) | Search mode + migrated inference settings | Draft |

## Acceptance Criteria

- [ ] **AC-1 — The page renders three sections.** On `#/settings`, the page renders inside the PRD-037 `<PageFrame>`
  with three sections — DeepLake auth, provider keys, search-mode + inference — on the honeycomb dark theme, built
  only from existing DS tokens/primitives. Served production-clean (no CDN React / no in-browser Babel) by the
  existing esbuild entry. A DOM/unit test asserts the three sections render.
- [ ] **AC-2 — Auth status is truthful (044a).** The auth section shows the daemon's real connected identity (org,
  workspace, agent, credentials source, last login, expiry when known) or an honest "not connected" state, and
  offers a connect/login affordance that drives the real device-flow/token path. The token is never rendered.
- [ ] **AC-3 — Provider keys are write-only (044b).** A user can add/replace each of the Anthropic, OpenAI,
  OpenRouter, and Cohere keys via `POST /api/secrets/:name`; presence is shown ("set ✓" / "not set") via
  `GET /api/secrets` (names only); no endpoint returns a secret value (grep-proven).
- [ ] **AC-4 — Search mode is selectable, persisted, and honored (044c).** The recall mode (`keyword` | `semantic` |
  `hybrid`) is selectable, persists as a vault `setting`, and is honored by the recall pipeline; the existing
  provider → model selector and dreaming toggle live on this page and continue to persist through `/api/settings`.
- [ ] **AC-5 — Thin client, reused wire.** The page uses the injected `PageProps.wire` (never `createWireClient`),
  reuses the existing `vaultSettings`/`setSetting`/`secretNames` wire methods plus the new auth/secret-write methods,
  and zod-parses every payload with `.catch()` defaults so a partial response degrades to a safe empty state — no
  `any` crosses the fetch boundary.
- [ ] **AC-6 — Security.** LOCAL-MODE-ONLY inherited from the shell; no token/secret value in the page, in any data
  response the page reads, or in a log line; provider-key inputs are write-only and cleared after submit. `npm run ci`
  / `build` / `audit:sql` / `audit:openclaw` / invariant all green.

## Decisions

- **D-1 — Page, not panel; reuse the wire.** The page is a new `src/dashboard/web/pages/settings.tsx` component on the
  `#/settings` registry entry (PRD-037c), receiving `PageProps` ({ `wire`, `daemonUp`, `assetBase` }) and rendering in
  `<PageFrame>`. It reuses the EXISTING `wire.ts` surface — `vaultSettings()`, `setSetting()`, `secretNames()` —
  already wired for the dashboard `SettingsPanel`, and adds only the new methods each sub-PRD needs (auth status/login,
  secret write). It never calls `createWireClient` itself.
- **D-2 — Write-only secrets, names-only reads (inherited, non-negotiable).** Provider keys go IN through
  `POST /api/secrets/:name` and are visible ONLY as name presence through `GET /api/secrets`. There is no
  value-returning secrets route, and this page never asks for one (PRD-032). This preserves the exact
  `PROVIDER_KEY_NAME` presence-badge model already in `panels.tsx`, extended to Cohere.
- **D-3 — The token is sacred.** Nothing in this page renders, returns, echoes, or logs a DeepLake token or a provider
  secret. Auth status is org/workspace/source/expiry metadata only; the auth section shows "connected"/"not
  connected", never the bearer token (PRD-023 D-4).
- **D-4 — Search mode is an additive vault `setting`, default-preserving.** A new `recallMode` key in the `setting`
  class (`keyword` | `semantic` | `hybrid`) is read by the recall pipeline. The DEFAULT (unset) preserves today's
  PRD-025 behavior (semantic-by-default with the embeddings-off lexical fallback), so shipping the selector changes
  nothing until a user picks a non-default mode. The page documents how the chosen mode composes with the
  embeddings-off fallback (see 044c).
- **D-5 — Migrate, don't fork.** The current `SettingsPanel` (provider → model + dreaming toggle + key-presence) moves
  ONTO this page as the inference section; the existing `SETTING_KEY` map and `PROVIDER_KEY_NAME` map are reused (the
  latter extended to add `cohere → COHERE_API_KEY`). The old in-grid panel is removed from the Dashboard home as part
  of PRD-038's reorg, or left until this page lands — coordinated, not duplicated.
- **D-6 — Security posture inherited.** The page is served only in `mode === "local"`, stays XSS-safe (all values
  rendered as escaped text, never `dangerouslySetInnerHTML`), and adds no token/secret to the page HTML, any data
  response, or any log line. `audit:openclaw` / `audit:sql` stay green by construction.

## Open Questions

- **OQ-1 (044a) — Connect affordance: in-page device-flow vs CLI hand-off.** The `/api/auth` route group is scaffolded
  but EMPTY today (`server.ts`, admin-only RBAC). Does 044a drive the device-flow IN the page (the page POSTs to a new
  `/api/auth/login` that returns the verification URI + user code to display, then polls), or does it show status only
  and hand off to the `honeycomb login` CLI for the actual connect? Proposed: ship status truthfully first, with the
  connect affordance driving an in-page device-flow ONLY if 044a also lands the `/api/auth` mount; otherwise the
  affordance deep-links/instructs the CLI. Confirm before build.
- **OQ-2 (044a) — Token expiry availability.** `TokenClaims.exp` is a Wave-2 (real JWT) field; the Wave-1 stub does
  not carry expiry. The status view must degrade gracefully ("expiry unknown") when `exp` is absent rather than
  fabricating one. Confirm the auth status read-model the daemon will expose.
- **OQ-3 (044b) — Cohere wiring depth.** Adding the Cohere KEY (write-only vault + presence badge) is in scope. Adding
  Cohere as a selectable INFERENCE provider in the model router/catalog (`vault/catalog.ts`, `PROVIDER_CATALOG`) is a
  larger change owned by PRD-010 (model-provider-router). Proposed: 044b adds the Cohere key + presence only; the
  catalog/router work is flagged for PRD-010. Confirm the split.
- **OQ-4 (044c) — Where the recall pipeline reads `recallMode`.** The mode setting must be consumed where the channels
  are assembled (`src/daemon/runtime/recall/collection.ts` `collectCandidates`) — `keyword` forces lexical-only (skip
  the vector channel even when embeddings are on), `semantic` runs the vector arm and honestly reports `degraded` when
  it cannot, `hybrid` runs both. Wiring the daemon-side read is a `retrieval` / `typescript-node` change this page
  depends on; confirm that seam (and whether `semantic` mode with embeddings off is "degraded fallback" or a hard
  empty) before build.

## Related

- **Hosting shell:** [PRD-037 Dashboard Nav Shell](../prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md)
  — the `#/settings` route, the `<PageFrame>`/`PageProps` contract, the route registry this page plugs into.
- **Prior art / house style:** [PRD-024 Dashboard UI Parity](../../in-work/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md)
  — the live brand dashboard, the production-clean bundle (D-1), the security posture (D-4), the wire-client pattern.
- **Encrypted vault (secrets + settings):** [PRD-032 Encrypted Vault](../../in-work/prd-032-encrypted-vault/prd-032-encrypted-vault-index.md)
  — `POST /api/secrets/:name` (write-only), `GET /api/secrets` (names only), `GET`/`POST /api/settings`, the provider
  catalog, the `setting` class scalar contract. Built on [PRD-012 Secrets](../../in-work/prd-012-secrets/prd-012-secrets-index.md).
- **DeepLake auth:** [PRD-011 Tenancy and Auth](../../in-work/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md)
  (device-flow, credentials, RBAC) and [PRD-023 DeepLake Connect Parity](../../in-work/prd-023-deeplake-connect-parity/prd-023-deeplake-connect-parity-index.md)
  (`honeycomb login`, the shared `~/.deeplake/credentials.json`, `whoami` never prints the token).
- **Recall modes:** [PRD-025 Semantic Recall Default](../../in-work/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md)
  (semantic-by-default, opt-out) and [PRD-029 Degradation Observability](../../in-work/prd-029-degradation-observability/prd-029-degradation-observability-index.md)
  (the `degraded` lexical-fallback signal + the per-subsystem `/health` reasons).
- **Source touched:** `src/dashboard/web/pages/settings.tsx` (new page), `src/dashboard/web/panels.tsx` (the migrated
  `SettingsPanel` + `SETTING_KEY` + `PROVIDER_KEY_NAME`), `src/dashboard/web/wire.ts` (reused
  `vaultSettings`/`setSetting`/`secretNames`; new auth-status + secret-write methods), `src/daemon/runtime/secrets/api.ts`
  + `src/daemon/runtime/vault/api.ts` (consumed), `src/daemon/runtime/auth/*` + `src/daemon/runtime/server.ts`
  (`/api/auth` group, consumed/extended), `src/daemon/runtime/recall/collection.ts` (the `recallMode` read seam).
