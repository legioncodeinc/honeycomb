# PRD-044a: DeepLake auth — login + status

> **Parent:** [PRD-044 Settings Page](./prd-044-settings-page-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The DeepLake-authentication section of the Settings page. It does two things: it SHOWS, truthfully, what the daemon
is connected to DeepLake as, and it OFFERS a connect/login affordance that drives the real auth path.

Honeycomb already has the auth machinery. A user connects via the device-flow (`honeycomb login` — browser
verification-code flow) or headlessly via a `HONEYCOMB_TOKEN` env var; the resolved credentials persist in the shared
`~/.deeplake/credentials.json` (mode `0600`), in Hivemind's exact shape, and the daemon auto-connects from that file
at its composition root (PRD-011 device-flow + credentials, PRD-023 connect-parity). The in-memory `Credentials`
shape the daemon resolves carries everything the status view needs — `orgId`, `orgName`, `workspace`, `agentId`,
`savedAt` — plus the credentials SOURCE (file vs `HONEYCOMB_TOKEN` env) and, on a real (Wave-2) JWT, a `TokenClaims.exp`
expiry. The one thing it must NEVER carry into the page is the `token` itself.

This section is a thin loopback CLIENT of that machinery. It reads an auth-STATUS read-model the daemon exposes (a new
small `GET /api/auth/status` handler on the scaffolded-but-empty `/api/auth` group), renders it honestly, and — per
OQ-1 of the parent — either drives an in-page device-flow connect or hands off to the `honeycomb login` CLI.

## Goals

- Render the daemon's real DeepLake auth STATUS: connected org (id + name), workspace, agent id, credentials source
  (`file` | `env` | `none`), last-login timestamp (`savedAt`), and token expiry when known — or an honest "not
  connected" state when no credentials resolve.
- Offer a connect/login affordance that drives the REAL device-flow (or token) auth path — never a mock, never a
  fabricated success.
- Reflect the credentials SOURCE truthfully: when `HONEYCOMB_TOKEN` is set, say so (the env token wins; the file's
  identity still describes the org/workspace) versus a file-resolved login.
- NEVER render, return, echo, or log the DeepLake bearer token (PRD-023 D-4) — the status view is metadata only.
- Reuse the injected `PageProps.wire` and the `<PageFrame>` section pattern; add no new design system.

## Non-Goals

- Org / workspace SWITCHING as an admin operation, RBAC role management, named API keys, or rate-limit config — those
  are PRD-011c / PRD-011d. This section shows the LOCAL connected identity and offers a single-user connect.
- Implementing the device-flow itself or the credentials store — those exist (PRD-011 / PRD-023). This section
  consumes them.
- Returning or displaying the token under any circumstance (PRD-023 AC-3: `whoami` prints user + org + workspace,
  never the token — this page holds the same line).
- Team / hybrid mode auth surfaces — LOCAL-MODE-ONLY inherited from the shell.

## User Stories

- As a developer setting up Honeycomb, I want to see whether the daemon is connected to DeepLake and as which
  org/workspace, so I know my memories are landing in the right place.
- As a developer, I want a clear "connect" button when I'm NOT logged in, so I can start the login without hunting for
  a CLI command.
- As a developer, I want to know WHERE my credentials came from (a saved login vs a `HONEYCOMB_TOKEN` env var) and
  when they were saved, so I can debug a wrong-org situation.
- As a security-conscious user, I want to be certain the page never shows my token, so I can screenshot my settings
  without leaking a credential.

## Implementation Notes

- **Section component:** a `DeeplakeAuthSection` rendered by `src/dashboard/web/pages/settings.tsx`, composing the
  existing primitives (`Badge`, `Button`) on the DS tokens. It receives the injected `wire` (never `createWireClient`).
- **Daemon read-model (new, small):** a `GET /api/auth/status` handler mounted on the existing scaffolded `/api/auth`
  route group (`src/daemon/runtime/server.ts` declares the group `{ path: "/api/auth", protect: true }`; it has no
  handlers today). The handler resolves credentials via the existing `loadCredentials(...)` / tenancy-resolution path
  (`src/daemon/runtime/auth/credentials-store.ts`, `tenancy-resolution.ts`) and returns a REDACTED status body —
  `{ connected, orgId, orgName, workspace, agentId, source, savedAt, expiresAt? }` — with NO `token` field by
  construction. `source` is `"env"` when `HONEYCOMB_TOKEN` is set, `"file"` when resolved from
  `~/.deeplake/credentials.json`, `"none"` when no credentials resolve. `expiresAt` is present only when
  `verifyTokenClaims(...)` yields a `TokenClaims.exp` (Wave-2 real JWT); absent → the view shows "expiry unknown"
  (OQ-2). This handler is the single auth surface the page reads.
- **Wire method to add (`src/dashboard/web/wire.ts`):** `authStatus(): Promise<AuthStatusWire>` → `GET /api/auth/status`,
  stamping `DASHBOARD_SESSION_HEADERS`, zod-parsing an `AuthStatusSchema` with EVERY field `.catch()`-defaulted (the
  established wire.ts posture), degrading to a `{ connected: false, source: "none", ... }` empty status on any failure
  — never a throw into React. The schema has NO token field; a token in the body would simply be ignored by the schema.
- **Connect affordance (OQ-1):** two shapes, gated on whether 044a also lands the `/api/auth/login` mount:
  - *In-page device-flow:* a "Connect to DeepLake" `Button` POSTs `/api/auth/login` (device-grant), which returns the
    `verification_uri` + short `user_code` ONLY (never the token); the section displays "Open {uri} and enter
    {user_code}", then polls `authStatus()` until `connected` flips true. The token never crosses the wire to the page.
  - *CLI hand-off:* if the in-page mount is deferred, the affordance shows the exact `honeycomb login` command (and
    `HONEYCOMB_TOKEN=…` for headless) and the section re-reads `authStatus()` on focus/poll so a CLI login reflects
    here. Confirm the choice in OQ-1 before build.
- **Source/expiry honesty:** render EXACTLY what the read-model serves. If `source === "env"`, label it "via
  HONEYCOMB_TOKEN" so a user understands the file identity is descriptive, not authoritative for the token. If
  `expiresAt` is absent, show "expiry unknown" — never compute or fake one.
- **Empty / disconnected state:** when `connected` is false (no credentials), the section renders an honest "Not
  connected to DeepLake" state with the connect affordance — not a blank panel, not a fabricated org.
- **XSS / secret discipline:** all status fields render as escaped text (React default), never
  `dangerouslySetInnerHTML`. The token is never in the read-model, the wire schema, the rendered DOM, or a log line
  (the grep-proven invariant of AC-4).

## Acceptance Criteria

- [ ] **AC-1 — Status renders truthfully.** When the daemon is connected, the section shows the real org (id + name),
  workspace, agent id, credentials source, and last-login `savedAt` (plus expiry when known) read from
  `GET /api/auth/status`; when not connected it shows an honest "Not connected" state. Unit-tested with a mocked `wire`
  for both connected and disconnected payloads.
- [ ] **AC-2 — A connect affordance drives the real flow.** A "Connect to DeepLake" affordance drives the real
  device-flow/token path (in-page device-grant returning only the verification URI + user code, or the CLI hand-off
  per OQ-1); on a successful connect the status section re-reads and flips to "connected". No mock success path exists.
- [ ] **AC-3 — Source + expiry are honest.** The section distinguishes a `HONEYCOMB_TOKEN` env source from a
  file-resolved login, and shows "expiry unknown" (not a fabricated date) when the token carries no `exp`. Unit-tested
  across `source: file | env | none` and present/absent `expiresAt`.
- [ ] **AC-4 — The token is never exposed.** No token appears in the `/api/auth/status` body, the `AuthStatusSchema`,
  the rendered DOM, or any log line — grep-proven. The wire degrades to a disconnected status (never a throw) on any
  read failure.
- [ ] **AC-5 — Thin client, reused wire.** The section uses the injected `PageProps.wire`, adds the `authStatus`
  (and, per OQ-1, `authLogin`) wire method with zod-defaulted parsing, and renders inside the PRD-037 page frame;
  LOCAL-MODE-ONLY inherited from the shell.

## Open Questions

- **OQ-1 (parent OQ-1) — In-page device-flow vs CLI hand-off.** Mount `GET /api/auth/status` is in scope regardless.
  Driving the connect IN the page requires also mounting `/api/auth/login` (the device-grant returning only the
  verification URI + user code, never the token), on the admin-gated `/api/auth` group. Proposed: status-first; in-page
  connect ONLY if the login mount lands in 044a, else CLI hand-off. Confirm before build.
- **OQ-2 (parent OQ-2) — Expiry availability.** `TokenClaims.exp` is a Wave-2 (real JWT) field; the Wave-1 stub omits
  it. The view must degrade to "expiry unknown" when absent. Confirm the read-model the daemon exposes carries
  `expiresAt` optionally, never fabricated.
- **OQ-3 — `/api/auth` RBAC in local mode.** The `/api/auth` group is admin-gated (`rbac.ts`). In LOCAL mode the
  dashboard viewer is effectively the admin, but confirm the status read does not trip a cross-tenant/role guard for
  the loopback `dashboard-web` session, and that a non-local body (mode-gated) simply yields a disconnected/absent
  status rather than an error.
