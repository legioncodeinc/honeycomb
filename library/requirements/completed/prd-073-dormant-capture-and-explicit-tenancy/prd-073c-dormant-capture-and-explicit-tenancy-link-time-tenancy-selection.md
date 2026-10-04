# PRD-073c: Link-Time Tenancy Selection (Daemon Side)

> **Parent:** [PRD-073](./prd-073-dormant-capture-and-explicit-tenancy-index.md)
> **Status:** Draft
> **Priority:** P0 (the silent `orgs[0]` pick wrote real data into the wrong org)
> **Effort:** L (1-2d)
> **Schema changes:** None to Deeplake. Additive confirmed-tenancy marker on `~/.deeplake/credentials.json`; new local-mode-only routes on the setup/diagnostics surface.

---

## Goals

No tenancy guess is ever persisted. The device-flow link authenticates, ENUMERATES the account's orgs and workspaces, and pauses in a pending-selection state; the hive onboarding (or the CLI, 073d) submits the explicit choice; only then is the org-bound token minted and the credential written with a confirmed-tenancy marker. Capture stays blocked until confirmed (parent AC-9).

## Scope

### The two-phase link flow

Today `loginWithDeviceFlow` runs poll-to-token, then IMMEDIATELY picks the org and persists: `listOrgs` then `chosen = pinned ?? orgs[0]` (`src/daemon/runtime/auth/deeplake-issuer.ts:601-604`), `reMint` for the guessed org (`:605`), and `persistFromToken` repeats the guess (`:524-527`) and hardcodes `workspaceId: "default"` (`:534`). The doc contract says so explicitly ("else the first org the account belongs to", `deeplake-issuer.ts:506-509`).

The flow splits into two phases:

1. **Authenticate + enumerate (no persist).** Poll to the short-lived token, call `listOrgs` (`deeplake-issuer.ts:331-333`), and for the candidate org(s) `listWorkspaces` (`:335-336`). Hold the short-lived token in memory as pending-link state (never on disk; the credential file is not written in this phase). Surface the lists.
2. **Persist the choice.** On an explicit `{orgId, workspaceId}` selection: validate against the enumerated lists, `reMint` the long-lived token bound to the CHOSEN org, `GET /me`, and write the full disk shape with the chosen pair plus the confirmed marker via the existing `saveDiskCredentials` discipline.

Auto-select short-circuit (parent AC-8): when `listOrgs` returns exactly one org AND its `listWorkspaces` returns exactly one workspace, phase 2 may run immediately with that pair, and the selection is surfaced ("Using org X, workspace Y"). The `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` env pins (`src/daemon/runtime/auth/credentials-store.ts:112-114`) count as explicit selection with the same surfacing (parent AC-10).

### The selection API (what the hive onboarding consumes)

CANONICAL CONTRACT (reconciled by the orchestrator 2026-07-04 against the parallel hive PRD-011; this document owns the shape, hive PRD-011 mirrors it field-for-field). The originally-proposed single `/setup/link/tenancy` route pair was superseded: a multi-org account must enumerate workspaces FOR THE CHOSEN ORG, which a single enumeration read cannot express. All routes sit beside `/setup/state` and `/setup/login` on the unprotected local-mode root group (`src/daemon/runtime/dashboard/setup-state.ts:58`, `setup-login.ts:37`); during the pending-link window they serve from the IN-MEMORY pending short-lived token (no credential exists yet, so the credential-scoped `/api/diagnostics/scope/*` reads cannot serve this window); NO token rides any body:

- `GET /setup/tenancy` -> `{ pending: boolean, selected: boolean, authenticated: boolean, org: {id, name} | null, workspace: {id, name} | null }`. `pending` is true only during an unconsumed link window; when not pending, it reports the persisted credential tenancy so an already-linked machine renders honestly. RECONCILED (orchestrator, 2026-07-04): `selected` reflects EFFECTIVE confirmation — the same rule the capture gate consumes — true for an explicit marker-stamped selection (a picker choice, env pins, or the single-tenancy auto-select) AND for a grandfathered pre-073 credential (non-empty `orgId`, no marker), so the hive portal gate never traps an upgraded install into re-onboarding (parent AC-5); a fresh pending link or absent credential reads `selected: false`. The additive optional `confirmedBy: "selection" | "grandfathered"` field surfaces the distinction for header display. STRUCK BY QA (2026-07-04): the originally-proposed `autoSelected?: {orgId, workspaceId}` field was removed as dead — an auto-selection persists immediately (never leaving a pending window), so it is reflected as `selected: true` + `confirmedBy: "selection"` + the org/workspace pair, and no `GET` could ever carry the field; hive's mirror drops it too.
- `GET /setup/tenancy/orgs` -> `{ orgs: [{id, name}] }` (pending-token or credential scoped).
- `GET /setup/tenancy/workspaces?org=<id>` -> `{ org: string, workspaces: [{id, name}], canCreate: boolean }`.
- `POST /setup/tenancy/select` body `{ orgId, workspaceId }`: phase 2. Validates against the enumerated lists, re-mints the long-lived token bound to the chosen org, persists via `saveDiskCredentials`, stamps the marker, returns `{ selected: true, org: {id, name}, workspace: {id, name}, reminted: boolean }` or `{ selected: false, error }` (redacted). Mechanics mirror the IRD-122 switch routes (`src/daemon/runtime/projects/scope-switch-api.ts:10-15`: reMint-then-`saveDiskCredentials`, zod-validated bodies, fail-soft redacted errors, never a token in a body).
- `POST /setup/tenancy/workspaces` body `{ org, name }` (workspace creation): DEFAULT - confirm before implementation; shipped only if the Deeplake API supports creation, and `canCreate` gates the UI affordance.

The existing enumeration reads for the POST-link dashboard switcher (`/api/diagnostics/scope/orgs|workspaces`, `src/daemon/runtime/projects/scope-enumeration-api.ts:56-63`) are unchanged; the setup routes serve the PRE-credential pending-link window those cannot (they require a persisted credential to read).

### The confirmed-tenancy marker and the capture tie

- Additive field on `~/.deeplake/credentials.json` (DEFAULT - confirm before implementation: `tenancyConfirmedAt: <ISO-8601>`), written only by phase 2 (and by 073d's CLI selection). The zod/shape tolerance of the credentials store already admits additive fields.
- **Grandfathering (parent AC-5):** a credential that exists at upgrade with a non-empty `orgId` and no marker is treated as confirmed. Only a link performed by a build carrying this PRD produces the pending state.
- **The capture tie (parent AC-9):** 073a's gate ladder consumes a `tenancyConfirmed` boolean seam; this sub-PRD implements it (marker present, or grandfathered). While false, captures gate with `tenancy_unconfirmed` regardless of bindings, and 073b surfaces it.
- `/api/auth/status` (`src/daemon/runtime/auth/status-api.ts:46`) additively reports the confirmation state so the dashboard header (hive PRD) can show "org X / workspace Y (confirmed)".

## Out of scope

- The CLI prompt/flag surface: 073d (it calls the same phase-2 persist internals).
- The hive onboarding screens consuming these routes (the parallel hive PRD).
- `honeycomb org switch` / `workspace switch` post-link semantics: unchanged (`src/cli/org.ts:9-19`); a switch after confirmation re-mints as today and keeps the marker.
- The self-hosted `--endpoint` login (`src/cli/auth.ts:274-307`): already fully explicit (`--org`/`--workspace` with local defaults); it gains the marker stamp but no flow change.

---

## User stories and acceptance criteria

### US-073c.1 - No guess is ever persisted

- AC-073c.1.1 Given a multi-org account with no env pins, when the device flow completes authentication, then NO credential file is written and the pending read reports the org list (parent AC-6).
- AC-073c.1.2 Given a pending link, when `POST /setup/tenancy/select` receives a valid `{orgId, workspaceId}` from the enumerated lists, then the long-lived token is minted for that org, the credential is written with the chosen pair + marker, and the ack echoes the choice as `{ selected: true, org, workspace, reminted }` (parent AC-7).
- AC-073c.1.3 Given a selection NOT in the enumerated lists, when the POST arrives, then it is rejected 400 with a redacted reason and nothing is persisted.
- AC-073c.1.4 Given the daemon restarts mid-pending-link, when the pending state is lost, then the flow degrades safely: no credential exists, the setup surface reports not-linked, and the user re-runs the link (the short-lived token was memory-only by design).

### US-073c.2 - Single-tenancy accounts stay frictionless

- AC-073c.2.1 Given exactly one org and one workspace, when the link completes, then the pair auto-selects, the marker is stamped, and the auto-selection is surfaced in the flow's output (parent AC-8).
- AC-073c.2.2 Given `HONEYCOMB_ORG_ID` (and optionally `HONEYCOMB_WORKSPACE_ID`) pins, when the link runs, then the pins select (existing precedence), the marker is stamped, and the pinned choice is surfaced (parent AC-10).

### US-073c.3 - Capture waits for confirmation

- AC-073c.3.1 Given a pending (unconfirmed) link and existing folder bindings, when a capture arrives, then it gates with `tenancy_unconfirmed` (parent AC-9).
- AC-073c.3.2 Given a pre-073 credential with a non-empty `orgId`, when the daemon upgrades, then tenancy reads confirmed and capture behavior is unchanged (parent AC-5).

---

## Technical considerations

- **The token is sacred (D-4), unchanged:** the pending enumeration bodies carry ids + names only; the short-lived token lives in daemon memory for the pending window and is discarded on selection or timeout. No new file ever holds it.
- The pending-link state is a small in-memory slice on the daemon (mirrors how `/setup/login` already backgrounds the poll loop via `onGrant`, `src/daemon/runtime/dashboard/setup-login.ts:4-11`); a bounded TTL expires an abandoned link.
- `listWorkspaces` for a NON-credential org may require the org-bound re-mint first (the 49e-AC-3 order, `scope-enumeration-api.ts:17-23`); the pending flow re-mints with the SHORT-LIVED token per candidate org only when the user expands that org's workspace list, or enumerates lazily per selection. Keep the happy path to one re-mint.
- Workspace `"default"` remains a legitimate CHOICE where the backend uses the default-workspace sentinel; what is removed is choosing it silently.
- The existing `persistFromToken` (`deeplake-issuer.ts:511-539`) is refactored to accept the chosen `{orgId, workspaceId}` instead of re-deriving `orgs[0]` + `"default"`; `loginWithToken` (the headless path) is covered by 073d's flag rules.

## Test plan

- Two-phase suite with a fake auth fetch: multi-org pause (no file written), valid selection persists + re-mints for the chosen org (call-order asserted, mirroring the IRD-122 suite), invalid selection 400s, TTL expiry cleans the pending slice.
- Auto-select and env-pin suites: single-org+single-workspace persists immediately with surfaced choice; pins select and surface.
- Grandfather suite: pre-existing credential reads confirmed; fresh pending link reads unconfirmed and gates capture (integration with 073a's seam).
- Security assertions: no route body, log line, or error message contains a token substring (the existing D-4 test discipline).
