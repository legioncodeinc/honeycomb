# PRD-073: Dormant-by-Default Capture and Explicit Tenancy Selection

> **Status:** Backlog
> **Priority:** P0 (data-safety: the silent-tenancy link flow wrote real capture data into the wrong org on the product owner's machine)
> **Effort:** XL (3-6d)
> **Schema changes:** None to Deeplake. Additive fields on the shared `~/.deeplake/credentials.json` (the confirmed-tenancy marker) and a new capture config flag (inbox opt-in). No new tables; no change to the `~/.deeplake/projects.json` binding surface.

---

## Overview

Two coupled product-owner decisions (2026-07-04) with one shared theme: **honeycomb must not write anything anywhere until the user has explicitly said where and for what.**

**Decision 1: honeycomb acts like nectar. Nothing happens until a project is added.** Nectar PRD-019 (repo path `nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md`) establishes the activation contract this PRD mirrors: dormant by default, activation by directory selection through the shared `~/.deeplake/projects.json` binding surface, honest `/health` surfacing while dormant. Honeycomb today is only half-way there. PRD-059a shipped a workspace-level FIRST-RUN capture gate: while a workspace has ZERO locally-bound projects, capture no-ops (`src/daemon/runtime/capture/capture-handler.ts:272-281`, gate predicate at `capture-handler.ts:555-575`, wired always-on by the assembly at `src/daemon/runtime/assemble.ts:955`). But the gate is one-shot: the moment the FIRST project is bound it opens permanently, and the per-session resolver's ladder (`src/hooks/shared/project-resolver.ts:38-47`) resumes falling through to the workspace `__unsorted__` inbox (`project-resolver.ts:67`, fallback return at `project-resolver.ts:598-601`), so a session in ANY unbound folder is still captured into the inbox. The new contract: capture, skillify, and every write-producing pipeline are gated PER SESSION on the cwd resolving to a BOUND project (a real folder binding in `~/.deeplake/projects.json`, the same surface nectar activates on and honeycomb's own `src/daemon/runtime/projects/onboarding-api.ts` bind flow writes). No binding means no capture, surfaced honestly (hook exit reason plus a `/health` / status slice saying "no active project; bind one in the Hive dashboard"), never a silent drop. Inbox capture becomes OPT-IN via config, default off (flagged as a decision below).

**Decision 2: explicit org and workspace selection at link time.** Today the device-flow issuer silently picks `orgs[0]` (the account's FIRST org) unless `HONEYCOMB_ORG_ID` pins it: the doc contract at `src/daemon/runtime/auth/deeplake-issuer.ts:506-509`, the token-persist pick at `deeplake-issuer.ts:524-527`, the device-flow mint pick at `deeplake-issuer.ts:601-604`. The workspace is hardcoded to `"default"` at persist time (`deeplake-issuer.ts:534`), and the CLI mirrors that default in its display fallback (`src/cli/auth.ts:190`) and its self-hosted path (`src/cli/auth.ts:277`). Neither the org nor the workspace is ever shown to the user before capture starts; this exact mechanism wrote real data to the wrong org on the product owner's machine. The new contract: the link flow ENUMERATES orgs and workspaces (both reads already exist on the auth client: `listOrgs` / `listWorkspaces`, `deeplake-issuer.ts:258-260`, impls at `deeplake-issuer.ts:331-336`) and pauses in a pending-selection state instead of persisting a guess; a selection API the hive onboarding consumes persists the CHOSEN `{orgId, workspaceId}` to `~/.deeplake/credentials.json`; the CLI headless path prompts (TTY) or requires explicit `--org` / `--workspace` flags (non-TTY); and capture stays blocked until tenancy is confirmed AND a project is bound (the tie to Decision 1).

The two decisions compose into one gate ladder for every write-producing path:

1. Tenancy confirmed (Decision 2): the credential carries an explicitly chosen or explicitly auto-selected-and-announced `{orgId, workspaceId}`.
2. Project bound (Decision 1): the session's cwd resolves to a real folder binding (resolver source `binding` or `git`, never `inbox`).

Until both hold, honeycomb writes nothing to Deeplake, and says so.

---

## Goals

- **Dormant by default, per session.** A session whose cwd resolves to no bound project produces zero Deeplake writes: no `sessions` row, no `memory` / `memory_jobs` row, no pipeline enqueue, no skillify mining input. The gate applies per session forever, not only before the first binding.
- **Never a silent drop.** Every gated capture is surfaced: the daemon returns an honest gated ack, the hook shim reports the skip reason on its exit path, session-start renders the existing bind-a-project notice, and `/health` plus the status surfaces carry a machine-readable "no active project" reason.
- **Inbox is opt-in.** The `__unsorted__` workspace inbox becomes an explicit configuration choice, default OFF. With the flag off, unbound-folder sessions are gated (not inboxed); with it on, the PRD-049a inbox behavior is restored verbatim.
- **Zero-bindings daemon is fully dormant for capture.** With no bindings at all, the daemon still boots, serves `/health` and the API, and performs no capture-side Deeplake writes, mirroring nectar PRD-019 AC-1.
- **No tenancy guess at link time.** The device-flow link never persists an org or workspace the user did not see. Selection is explicit in the dashboard onboarding (hive consumes the new selection API) and in the CLI (prompt or flags). Only a single-org, single-workspace account may auto-select, and the auto-selection is printed.
- **Back-compat for existing installs.** An install that already has folder bindings and a persisted credential behaves unchanged (its tenancy is grandfathered as confirmed; its bound projects keep capturing).

## Non-Goals

- **The hive onboarding UI.** The org/workspace picker screens, the folder-pick step ordering, and the dashboard header tenancy display are the parallel hive PRD (onboarding tenancy selection), authored in parallel in the hive repo. This PRD ships the daemon-side APIs and contracts hive consumes.
- **Changing the `~/.deeplake/projects.json` schema or the bind flow.** The binding surface (`bindFolderToProject`, `project-resolver.ts:387-420`; the bind routes in `onboarding-api.ts:10-17`) is consumed as-is.
- **Recall / read paths.** Recall, context rendering, and the dashboard read surfaces stay available regardless of the gates; only write-producing paths are gated.
- **The `~/.apiary` state-root migration.** PRD-072 owns on-disk relocation; this PRD does not move any file. Where both PRDs touch the same module the changes are additive and independent.
- **Multi-org token federation.** One credential, one active org, unchanged (PRD-011). Switching org/workspace after link keeps using the existing `org switch` / `workspace switch` mechanics (`src/cli/org.ts:9-19`) and the IRD-122 dashboard switch routes (`src/daemon/runtime/projects/scope-switch-api.ts:10-15`).
- **Retroactive cleanup of data already captured into a wrong org or the inbox.** Migration/pruning of historical rows is a follow-up decision (see open questions).

---

## Code-grounded current state

| # | Fact | Code |
|---|---|---|
| 1 | The per-session resolver ladder ends in the `__unsorted__` inbox so capture is never dropped for an unbound cwd | `src/hooks/shared/project-resolver.ts:38-47` (precedence doc), `:67` (`UNSORTED_PROJECT_ID`), `:598-601` (inbox return) |
| 2 | The first-run capture gate suppresses capture only while the workspace has ZERO bound projects; one binding opens it forever and the inbox fallback resumes | `src/daemon/runtime/capture/capture-handler.ts:158-173` (deps doc), `:272-281` (gate check), `:555-575` (`firstRunGateClosed`), `src/daemon/runtime/assemble.ts:951-955` (`firstRunGate: true`) |
| 3 | The gate predicate is a pure local read of `~/.deeplake/projects.json` bindings | `src/hooks/shared/project-resolver.ts:629-631` (`hasBoundProject`), `:649-662` (`hasBoundProjectOnDisk`) |
| 4 | Capture writes the `sessions` row, bumps per-turn cues, and enqueues the memory-pipeline entry job, all from one handler | `src/daemon/runtime/capture/capture-handler.ts:283-318` |
| 5 | Session-start renders a once-per-session bind-a-project notice when no project is bound | `src/hooks/shared/session-start.ts:43-45` (`BIND_PROJECT_NOTICE`), `:53-74` (notice gate) |
| 6 | The hook capture shim reports skip reasons when a gate prevents the daemon call | `src/hooks/shared/capture.ts:86-99` |
| 7 | The issuer picks `orgs[0]` unless `HONEYCOMB_ORG_ID` pins it, and hardcodes `workspaceId: "default"` | `src/daemon/runtime/auth/deeplake-issuer.ts:506-509`, `:524-527`, `:534`, `:601-604`; env pin `ENV_ORG_ID` at `:197` |
| 8 | The CLI defaults workspace to `"default"` (display fallback and self-hosted path) | `src/cli/auth.ts:190`, `:277` |
| 9 | Org and workspace enumeration already exist on the auth client and are already served to the dashboard | `deeplake-issuer.ts:258-260`, `:331-336`; `src/daemon/runtime/projects/scope-enumeration-api.ts:8-10`, `:56-63` |
| 10 | Post-hoc org/workspace switching already exists (CLI and dashboard) | `src/cli/org.ts:9-19`; `src/daemon/runtime/projects/scope-switch-api.ts:10-15` |
| 11 | The dashboard guided-setup surface has a state read and an on-page device-flow login route to extend | `src/daemon/runtime/dashboard/setup-state.ts:58` (`/setup/state`), `src/daemon/runtime/dashboard/setup-login.ts:37` (`/setup/login`) |
| 12 | The bind flow the gate keys on is the daemon's own onboarding API writing `~/.deeplake/projects.json` | `src/daemon/runtime/projects/onboarding-api.ts:10-17`, `:25-28` |
| 13 | The redacted auth-status read the dashboard shows tenancy from | `src/daemon/runtime/auth/status-api.ts:46` (`/api/auth/status`), body shape `:57-74` |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-073a-bound-project-capture-gate`](./prd-073a-dormant-capture-and-explicit-tenancy-bound-project-capture-gate.md) | Decision 1 core: the per-session bound-project gate on capture and every write-producing pipeline; the inbox opt-in config (default off); back-compat for bound installs | Draft |
| [`prd-073b-dormancy-surfacing-and-status`](./prd-073b-dormant-capture-and-explicit-tenancy-dormancy-surfacing-and-status.md) | Decision 1 surfacing: hook exit reasons, the `/health` / status "no active project" slice, gated-ack observability counters, session-start notice alignment | Draft |
| [`prd-073c-link-time-tenancy-selection`](./prd-073c-dormant-capture-and-explicit-tenancy-link-time-tenancy-selection.md) | Decision 2 daemon side: the two-phase link flow (enumerate, pause pending selection, persist the choice), the selection API hive's onboarding consumes, the confirmed-tenancy marker, capture blocked until confirmed | Draft |
| [`prd-073d-cli-explicit-tenancy`](./prd-073d-dormant-capture-and-explicit-tenancy-cli-explicit-tenancy.md) | Decision 2 CLI side: `honeycomb auth login` TTY prompts, non-TTY `--org` / `--workspace` requirement, single-org single-workspace auto-select with the choice printed | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given a session whose cwd resolves to NO bound project (resolver source would be `inbox`), when the hook posts a capture and the inbox opt-in is OFF (the default), then the daemon writes no `sessions` / `memory` / `memory_jobs` row and enqueues no pipeline or skillify job, and returns a gated ack naming the reason (`no_bound_project`). |
| AC-2 | Given the same gated capture, when the hook shim completes, then its exit path reports the gate reason (never a silent success-shaped drop), and session-start has rendered the bind-a-project notice once for that session. |
| AC-3 | Given zero folder bindings exist in `~/.deeplake/projects.json`, when the daemon runs, then it serves `/health` and the API normally, performs zero capture-side Deeplake writes, and `/health` (or its status slice) carries a machine-readable "no active project; bind one in the Hive dashboard" reason. |
| AC-4 | Given the inbox opt-in config is ON, when a session in an unbound folder captures, then the PRD-049a behavior is restored verbatim: the row lands in the workspace `__unsorted__` inbox and pipelines run. |
| AC-5 | Given an existing install with at least one folder binding and a persisted credential, when it upgrades to this PRD, then sessions in bound folders capture exactly as before (no re-onboarding, no new prompt) and the credential's tenancy is treated as confirmed. |
| AC-6 | Given a fresh `honeycomb login` device-flow link on an account with more than one org or more than one workspace, when the flow completes authentication, then NO org or workspace is persisted until an explicit selection is made; the flow surfaces the org and workspace lists (dashboard: via the selection API; CLI: via prompt or flags). |
| AC-7 | Given the selection API receives a chosen `{orgId, workspaceId}`, when it persists, then `~/.deeplake/credentials.json` carries the chosen pair plus the confirmed-tenancy marker, the org-bound token is minted for the CHOSEN org, and the choice is visible on `/api/auth/status`. |
| AC-8 | Given a single-org, single-workspace account, when the link flow runs, then it may auto-select that pair, MUST print/surface the auto-selection ("Using org X, workspace Y"), and stamps the confirmed marker. |
| AC-9 | Given tenancy is NOT yet confirmed (a pending link, or a legacy credential explicitly reset), when any capture arrives, then it is gated with reason `tenancy_unconfirmed` regardless of folder bindings. |
| AC-10 | Given `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` env pins are set (`src/daemon/runtime/auth/credentials-store.ts:112-114`), when the link or a capture runs, then the pins keep their existing precedence and count as explicit selection (CI/scripted parity), with the pinned choice surfaced in output. |

---

## Test plan

### Primary acceptance path: the owner's Windows dogfood (product-owner-specified)

Full fresh-install protocol on the product owner's Windows machine. Each step lists the expected observation; the PRD is not accepted until all pass.

1. **Stop and unregister all fleet services.** Stop and remove the doctor, honeycomb, nectar, and hive service units and scheduled tasks (`schtasks` entries and any launchd/systemd analogues do not apply on this machine; use the products' own `service uninstall` verbs where present). Expected: no fleet process running; `Get-ScheduledTask` shows no apiary/honeycomb/nectar/hive/doctor tasks; port 3850 unbound.
2. **Clear ALL local state.** Delete `%USERPROFILE%\.apiary`, `%USERPROFILE%\.honeycomb`, `%USERPROFILE%\.deeplake`, `%USERPROFILE%\.nectar` (legacy), and every per-repo `.honeycomb\` projection in the test repos. Expected: none of these paths exist afterward; this is the genuine zero-state.
3. **Run the one-line installer end to end** (`get.theapiary.sh` per its published invocation). Expected: install completes; the daemon boots; the dashboard is reachable; NO error requires manual state surgery.
4. **Verify onboarding REQUIRES an org and workspace choice before anything writes.** Walk the dashboard onboarding to the link step and authenticate with the owner's multi-org account. Expected: the flow pauses at an org+workspace selection (the hive onboarding consuming this PRD's selection API); `~/.deeplake/credentials.json` either does not exist yet or carries no confirmed tenancy; `/api/auth/status` does not report a guessed org.
5. **Probe for zero Deeplake writes before a project is bound.** Before binding any project, query the chosen workspace's `sessions` / `memory` / `memory_jobs` tables (row counts), open a coding session in an unbound test repo, produce several turns, then re-probe. Expected: counts unchanged; the hook reports the gated reason; `/health` reports "no active project".
6. **Bind a project.** Use the dashboard folder picker (the existing bind flow) on one test repo. Expected: the binding lands in `~/.deeplake/projects.json`; `/health` clears the no-active-project reason.
7. **Verify capture and brooding writes land ONLY in the chosen org and workspace.** Produce sessions in the bound repo; let the pipeline and skillify run. Probe the chosen org+workspace tables AND at least one other org the account can see. Expected: rows appear only under the chosen `{orgId, workspaceId}`, scoped to the bound project id; the other org's tables gain zero rows.
8. **Verify the unbound repo stays silent.** Produce turns in a second, unbound test repo. Expected: still zero new rows (inbox opt-in is off by default); gated acks observed.
9. **Verify the dashboard header shows the active tenancy.** Expected: the hive dashboard header displays the chosen org and workspace (the hive-PRD half of the contract), matching `/api/auth/status`.
10. **Restart resilience.** Reboot the daemon (service restart). Expected: confirmed tenancy and bindings persist; no re-prompt; capture in the bound repo resumes; the unbound repo remains gated.

### Suite-level (per sub-PRD, unit + integration)

- Gate matrix per 073a: bound cwd captures; unbound cwd gated (flag off); unbound cwd inboxed (flag on); zero-bindings dormancy; existing-install back-compat.
- Surfacing per 073b: gated ack shape, hook exit reason, `/health` slice, notice once-per-session.
- Link flow per 073c: multi-org pause, selection persist + re-mint for the chosen org, confirmed marker, `tenancy_unconfirmed` gating, single-org auto-select announce, env-pin precedence.
- CLI per 073d: TTY prompt paths, non-TTY flag requirement (hard error without flags), auto-select print, `--org`/`--workspace` validation against `listOrgs`/`listWorkspaces`.

---

## Data model and API changes

- **No Deeplake schema change.** The gates read the existing local binding surface.
- **`~/.deeplake/credentials.json` (additive):** the confirmed-tenancy marker (073c; exact field shape is a flagged decision). Legacy files without the marker are grandfathered as confirmed when they carry a non-empty `orgId` (AC-5).
- **Capture config (additive):** the inbox opt-in flag (073a; DEFAULT: an env flag plus the settings surface, default off).
- **New daemon routes (073c, exact paths proposed there):** a pending-link tenancy read (org + workspace lists for the authenticated-but-unconfirmed link) and a selection POST that persists the choice; both on the existing local-mode-only setup/diagnostics surface, mirroring `setup-state.ts` / `scope-enumeration-api.ts` / `scope-switch-api.ts` conventions.

---

## Open questions (flagged decisions)

- [ ] **Inbox fate (DEFAULT - confirm before implementation):** inbox capture becomes OPT-IN via config, default OFF. The alternative (keep inbox default-on, gate only the zero-bindings state) preserves PRD-049a's "capture is never dropped" but contradicts the owner's "nothing happens until a project is added". DEFAULT: opt-in, default off.
- [ ] **Existing `__unsorted__` rows (DEFAULT - confirm before implementation):** leave all historical inbox rows intact; no migration, no pruning. Cleanup stays a separate explicit action.
- [ ] **Legacy credential grandfathering (DEFAULT - confirm before implementation):** an existing credential with a non-empty `orgId` is treated as confirmed tenancy on upgrade (AC-5), even though it may have been minted by the old silent `orgs[0]` pick. The alternative (force every existing install through re-selection) is safer but breaks the "existing installs unchanged" requirement. DEFAULT: grandfather, and surface the active tenancy prominently so a wrong grandfathered org is visible.
- [ ] **Confirmed-tenancy marker location (DEFAULT - confirm before implementation):** an additive field on `~/.deeplake/credentials.json` (for example `tenancyConfirmedAt: <ISO>`), because the marker must travel with the credential it confirms and the file already has additive-field tolerance. Alternative: `~/.deeplake/onboarding.json`. DEFAULT: the credentials file.
- [ ] **Inbox opt-in flag name and surface (DEFAULT - confirm before implementation):** `HONEYCOMB_INBOX_CAPTURE` env flag read by the capture config (`src/daemon/runtime/capture/capture-config.ts`) plus a settings-page toggle. DEFAULT as stated.
- [ ] **Session-start table-ensure and placeholder writes (DEFAULT - confirm before implementation):** gate them with the same ladder (no confirmed tenancy or no bound project means no ensure, no placeholder). The current production seams are no-ops (`src/hooks/shared/session-start-seams.ts:122-127`), so this primarily constrains future wiring. DEFAULT: gated.
- [ ] **Skillify backlog mining (DEFAULT - confirm before implementation):** the skillify miner only mines sessions attributed to bound projects; inbox rows are mined only while the inbox opt-in is ON. DEFAULT as stated.

---

## Related

- **Nectar PRD-019** (the activation pattern being mirrored): `nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md`. Its AC-1 (dormant, honest `/health`) and AC-2 (activation via the shared bind flow) are the contract Decision 1 ports to honeycomb's capture side.
- **Hive PRD (onboarding tenancy selection), authored in parallel** in the hive repo: owns the org/workspace picker UI, the onboarding step ordering, and the dashboard header tenancy display. Consumes 073c's selection API.
- **Fleet ADR-0003, mirrored locally** as [`0008-fleet-directory-ownership-and-neutral-state-root.md`](../../../knowledge/private/architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md): the state-root context PRD-072 implements; this PRD adds no new home-anchored state family and is unaffected by the relocation.
- **Doctor ADR-0002** (`doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`): the service-registry contract is unaffected; the daemon stays registered and healthy while capture-dormant.
- **The shared `~/.deeplake/projects.json` binding surface:** written by `src/daemon/runtime/projects/onboarding-api.ts` and the CLI `project bind`, read by nectar's `project-scope.ts` and honeycomb's resolver; this PRD consumes it unchanged.
- [PRD-059 (projects onboarding)](../prd-059-projects-onboarding/) - the first-run gate, bind flow, and notice this PRD generalizes.
- PRD-049 (completed) - the per-session resolver and the `__unsorted__` inbox this PRD makes opt-in.
- PRD-050 (completed) - the guided-setup surface (`/setup/state`, `/setup/login`) 073c extends.
- IRD-122 - the dashboard scope-switch persistence routes whose mechanics 073c reuses for the selection persist.
- PRD-011 (completed) - the org-bound token mint (`reMint`) the chosen-org persist drives.
