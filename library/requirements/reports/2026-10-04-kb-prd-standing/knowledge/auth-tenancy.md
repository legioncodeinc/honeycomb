# Auth and tenancy knowledge standing

Shard: Wave 1a, `library/knowledge/private/auth/` plus `library/knowledge/private/multi-tenant/` only.
Branch: `legion/kb-sotu-and-prd-lifecycle`. Date: 2026-10-04.
Read-only. No doc or source edits in this shard.

## Coverage

Knowledge files read:

- `library/knowledge/private/auth/auth-architecture.md` (active)
- `library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md` (superseded history)
- `library/knowledge/private/multi-tenant/org-workspace-model.md` (active)

Related links in those pages all resolve inside this repo (`security/`, `architecture/`, `operations/`, `data/`, `ai/session-capture.md`, ADRs 0002-0005). The Queen path named on the superseded page is not in this repo.

Source checked (build outputs and `node_modules` skipped): `src/daemon/runtime/auth/{rbac,contracts,device-flow,tenancy-confirmation,credentials-store,deeplake-issuer,api-keys,rate-limit,status-api,tenancy-resolution}.ts`, `src/daemon/runtime/dashboard/{setup-tenancy,setup-login}.ts`, `src/daemon/runtime/{assemble,config,server,scope}.ts`, `src/daemon/runtime/middleware/permission.ts`, `src/daemon/runtime/capture/capture-handler.ts`, `src/daemon/runtime/recall/scope-clause.ts`, `src/daemon/runtime/onboarding/onboarding-store.ts`, `src/daemon/storage/{index,config}.ts`, `src/daemon/storage/catalog/tenancy.ts`, `src/cli/{runtime,org,auth}.ts`, `src/commands/{status,install}.ts`, `src/shared/{fleet-detection,constants}.ts`, `src/hooks/openclaw/shim.ts`, `src/hooks/shared/project-resolver.ts`.

## Defects

### D1. Role table names `operator`

- Quote: "`operator` | remember, recall, modify, forget, recover, documents, connectors, diagnostics, analytics"
- Doc: `library/knowledge/private/auth/auth-architecture.md:78`
- Grounding: `src/daemon/runtime/auth/contracts.ts:82` (`ROLES` is `admin`, `member`, `readonly`, `agent`); `src/daemon/runtime/auth/rbac.ts:15` and `src/daemon/runtime/auth/rbac.ts:23-27` (frozen role is `member`; `operator` is called stale)
- Verdict: FALSE
- Action: REVISE

Replace `operator` with `member`. Keep four rows. Align the permission words with the capability matrix in `src/daemon/runtime/auth/rbac.ts:92-100`: `read`, `write`, `connectorsAdmin` (`admin` + `member`), `admin` (`admin` only). `member` gets data writes plus connectors, sources, diagnostics, and analytics. `member` does not get token, org, workspace, or secrets admin. There is no `recover` capability.

### D2. Login org priority still says token claim, then first org

- Quote: "Org selection follows a priority order (environment override, then the token's org claim, then the first org)"
- Doc: `library/knowledge/private/auth/auth-architecture.md:24`
- Grounding: `src/daemon/runtime/auth/deeplake-issuer.ts:663-726` (`resolveTenancyChoice`: full env pins, org pin, single-org auto-select, selector, else `TenancySelectionRequiredError`). No token-claim step and no silent `orgs[0]` persist on the CLI path (`src/daemon/runtime/auth/deeplake-issuer.ts:899-900`)
- Verdict: STALE
- Action: REVISE

### D3. CLI device flow is drawn as the daemon minting the token

- Quote: "the CLI polls for a token, and the daemon mints a long-lived, org-bound token"
- Doc: `library/knowledge/private/auth/auth-architecture.md:24` (diagram `library/knowledge/private/auth/auth-architecture.md:32-36`)
- Grounding: `src/cli/auth.ts:340-351` calls `deviceFlow`, which is `loginWithDeviceFlow` against `api.deeplake.ai` (`src/daemon/runtime/auth/deeplake-issuer.ts:815-821`, `src/daemon/runtime/auth/deeplake-issuer.ts:891-904`). The short-lived Auth0 token stays in memory (`src/daemon/runtime/auth/deeplake-issuer.ts:826-829`); the persisted token is the long-lived mint.
- Verdict: STALE
- Action: REVISE

The dashboard path does enter through the daemon (`POST /setup/login`). The CLI path does not.

### D4. Drift heal re-mints on the daemon

- Quote: "The daemon heals a drifted org token on session start: it decodes the token's org claim, compares it to the active org, and re-mints if they disagree"
- Doc: `library/knowledge/private/auth/auth-architecture.md:40`
- Grounding: `src/cli/runtime.ts:555-571` (`buildOrgDriftHealer`: when `apiUrl` is `https://api.deeplake.ai`, a mismatched org returns `{ kind: "drift-surfaced" }` and does not mint). Wired from CLI status (`src/cli/runtime.ts:768`, `src/commands/status.ts:102`). `healOrgDrift` still re-mints only in the local/stub branch (`src/cli/runtime.ts:576-584`, `src/daemon/runtime/auth/device-flow.ts:225-229`). No daemon assembly call.
- Verdict: FALSE
- Action: REVISE

Say real `api.deeplake.ai` drift is surfaced and the user re-mints with `honeycomb org switch`. Keep best-effort: a surfaced or failed heal does not block status.

### D5. Stub rejection is not a prefix gate that lets real bearers through

- Quote: "In `team` and `hybrid` modes, any bearer that starts with the `hcmt.v1.` prefix is rejected before its claims are read"
- Doc: `library/knowledge/private/auth/auth-architecture.md:66` (case-sensitive bypass claim `library/knowledge/private/auth/auth-architecture.md:69`)
- Grounding: `src/daemon/runtime/auth/device-flow.ts:307-309` rejects every bearer in `team`/`hybrid` when the verifier is the default `verifyTokenClaims`, before any prefix test. Assembly passes that default (`src/daemon/runtime/assemble.ts:1025`). Prefix constant still exists (`src/daemon/runtime/auth/contracts.ts:434`) and is only a decode shape (`src/daemon/runtime/auth/contracts.ts:477-479`). No case-sensitive prefix reject in the authenticator.
- Verdict: FALSE
- Action: REVISE

`local` mode never consults the authenticator (`src/daemon/runtime/middleware/permission.ts:186-189`). An omitted mode still accepts the default decoder, including stubs.

### D6. Hybrid does not trust a TCP localhost peer

- Quote: "localhost requests are trusted based on the TCP peer address from the socket"
- Doc: `library/knowledge/private/auth/auth-architecture.md:58`
- Grounding: `src/daemon/runtime/middleware/permission.ts:108-114` (`noSocketPeer` returns false). `socketPeer` wiring in `src/daemon/runtime/assemble.ts`: ABSENT. Fail-closed "require a token" is what hybrid does today (`src/daemon/runtime/middleware/permission.ts:194-200`). Host-header trust is correctly rejected by that seam.
- Verdict: FALSE
- Action: REVISE

### D7. Rate limiting is not enforced

- Quote: "Rate limiting is enforced only in `team` and `hybrid` modes."
- Doc: `library/knowledge/private/auth/auth-architecture.md:112` (also "All operations are rate-limited" at `library/knowledge/private/auth/auth-architecture.md:56`)
- Grounding: middleware exists (`src/daemon/runtime/auth/rate-limit.ts:177-208`, `429` plus `Retry-After`, `anonymous` bucket, skipped when mode is `local`). Mount of `createRateLimitMiddleware` / `createRateLimiter` under `src/daemon/runtime/assemble.ts` and `src/daemon/runtime/server.ts`: ABSENT. Only `tests/daemon/runtime/auth/rate-limit.test.ts` constructs it. `src/daemon/runtime/auth/rate-limit.ts:187` still says mounting is deferred.
- Verdict: FALSE
- Action: REVISE

Describe the limiter as implemented and unmounted. Do not say shared deployments enforce it.

### D8. Connector keys do not default to a permission list

- Quote: "A key carries a role and can be narrowed with an explicit permission list; connector keys default to the narrow set of recall, remember, and documents, and can be bound to a connector, harness, agent, and allowed projects."
- Doc: `library/knowledge/private/auth/auth-architecture.md:86`
- Grounding: `src/daemon/runtime/auth/api-keys.ts:64` and `src/daemon/runtime/auth/api-keys.ts:149` (default role `agent`); `src/daemon/runtime/auth/api-keys.ts:162` writes `permissions` as `"[]"`; `src/daemon/runtime/auth/api-keys.ts:90-97` accepts `name`, `role`, and one `project` only. Schema columns `permissions`, `connector`, `harness`, `agent` exist (`src/daemon/storage/catalog/tenancy.ts:102-103`, `src/daemon/storage/catalog/tenancy.ts:133-136`) but create stores the project as `connector: "project:<id>"` (`src/daemon/runtime/auth/api-keys.ts:163`). The authenticator uses `role`, not the permissions array (`src/daemon/runtime/auth/api-keys.ts:270-275`).
- Verdict: STALE
- Action: REVISE

Keep: prefix `hc_sk_`, scrypt hash, printed once, revocable (`src/daemon/runtime/auth/api-keys.ts:62`, `src/daemon/runtime/auth/api-keys.ts:148`, `src/daemon/runtime/auth/api-keys.ts:285`).

### D9. Request scope is project-only, not agent or user

- Quote: "optionally a tighter `scope` of `project`, `agent`, or `user`. A request touching a different value for a set field gets `403`."
- Doc: `library/knowledge/private/auth/auth-architecture.md:106`
- Grounding: `src/daemon/runtime/auth/rbac.ts:229-241` (project binding only; `admin` bypasses). No `user` scope field on `Identity` (`src/daemon/runtime/auth/contracts.ts:108-117`). Org header mismatch returns null from `src/daemon/runtime/scope.ts:161-162`, which handlers treat as a failed resolve, not this RBAC 403.
- Verdict: STALE
- Action: REVISE

Keep: `admin` bypasses project scope, and `local` does not run the policy (`src/daemon/runtime/middleware/permission.ts:186-189`).

### D10. Shipped mode default is `local`

- Quote: "`team`: ... This is the default for a shared deployment."
- Doc: `library/knowledge/private/auth/auth-architecture.md:56`
- Grounding: `src/daemon/runtime/config.ts:26` (the three mode names) and `src/daemon/runtime/config.ts:71` (`mode` defaults to `"local"`)
- Verdict: HOLE
- Action: ADD

The three mode names are real. The page never says the config default is `local`, and the team sentence reads like the process default. Add the schema default. Unauthenticated `team` requests do get `401` (`src/daemon/runtime/middleware/permission.ts:203-206`).

### D11. Dashboard login is not a `persistFromToken` twin of the CLI

- Quote: "on approval it mints and persists the same shared credential through the identical `persistFromToken` path. ... The end state is byte-identical to a terminal login"
- Doc: `library/knowledge/private/auth/auth-architecture.md:44`
- Grounding: function `persistFromToken`: ABSENT. Dashboard multi-org login writes an unconfirmed base credential via `persistUnconfirmedTenancy` (`src/daemon/runtime/dashboard/setup-tenancy.ts:241-251`) before `POST /setup/tenancy/select`. CLI login does not persist until `resolveTenancyChoice` succeeds (`src/daemon/runtime/auth/deeplake-issuer.ts:899-904`). Confirmed persist is `persistSelectedTenancy` (`src/daemon/runtime/auth/deeplake-issuer.ts:752`).
- Verdict: STALE
- Action: REVISE

Keep the parts that hold: `POST /setup/login`, local-mode only, response is `user_code` plus verification URIs, reporter swallowed, https check (`src/daemon/runtime/dashboard/setup-login.ts:4-24`, `src/daemon/runtime/dashboard/setup-login.ts:159-168`, `src/daemon/runtime/assemble.ts:1447-1462`).

### D12. Enrollment state names are not in `src/`

- Quote: "`local_unregistered` | Honeycomb is installed locally, but the device has no cloud identity."
- Doc: `library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md:49` (full table `library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md:48-70`, including `login_deferred` at line 70 and `tenancy_pending` / `tenancy_confirmed` at lines 68-69)
- Grounding: those identifiers in `src/`: ABSENT. Also ABSENT: `custodian`, `rewrap`, `escrow`, `enrollment`. Live nearby strings are capture reason `tenancy_unconfirmed` (`src/daemon/runtime/capture/capture-handler.ts:775`), credential fields `tenancyPending` / `tenancyConfirmedAt` (`src/daemon/runtime/auth/credentials-store.ts:108-121`), and fleet mode `"solo" | "fleet"` (`src/shared/fleet-detection.ts:59`). `revoked` exists on API keys (`src/daemon/runtime/auth/api-keys.ts:261`), not as a device state.
- Verdict: STALE
- Action: LEAVE

The page banner says superseded and do not update (`library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md:3`). Do not revise the body in this repo. Do not delete it on this shard alone.

### D13. Superseded page says every write pipeline waits on tenancy

- Quote: "Capture, skillify, and every write pipeline stay dormant while the device is in `tenancy_pending`"
- Doc: `library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md:105`
- Grounding: same capture-only gate as D15 (`src/daemon/runtime/assemble.ts:1391`, `src/daemon/runtime/capture/capture-handler.ts:768-775`). State name `tenancy_pending`: ABSENT.
- Verdict: FALSE
- Action: LEAVE

Same reason as D12: historical page, banner says do not update.

### D14. Tenancy routes are not under `src/dashboard/`

- Quote: "written through the canonical `/setup/tenancy/*` API (`src/dashboard/setup-tenancy.ts`)"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:51`
- Grounding: `src/dashboard/setup-tenancy.ts`: ABSENT (`src/dashboard/` has other files only). Real file: `src/daemon/runtime/dashboard/setup-tenancy.ts:70-80` (`GET/POST /setup/tenancy`, `/orgs`, `/workspaces`, `/select`).
- Verdict: FALSE
- Action: REVISE

### D15. Confirmation gates capture, not every write

- Quote: "Capture, skillify, and every write pipeline are dormant until tenancy is confirmed"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:46`
- Grounding: `isTenancyConfirmed` is consumed by the capture handler only (`src/daemon/runtime/assemble.ts:1391`, `src/daemon/runtime/capture/capture-handler.ts:768-775`, reason `tenancy_unconfirmed`). No other `src/` caller. Skillify, document, and memory write routes do not read the flag. A gated capture also does not enqueue the skillify cue that capture would have produced (`src/daemon/runtime/capture/turn-counters.ts:140-150` runs only after a capture proceeds).
- Verdict: FALSE
- Action: REVISE

Say the flag blocks capture. Do not say it blocks every write.

### D16. Capture is not blocked until the marker alone

- Quote: "Capture stays BLOCKED until that marker is present."
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:51`
- Grounding: `src/daemon/runtime/auth/tenancy-confirmation.ts:74-85`. Confirmed when `tenancyConfirmedAt` is set, or when a credential has an org id and `tenancyPending` is not true (grandfather). Unconfirmed when the file is missing, org id is empty, or `tenancyPending` is true with no marker.
- Verdict: STALE
- Action: REVISE

The grandfather paragraph at `library/knowledge/private/multi-tenant/org-workspace-model.md:63` already matches `confirmedBy` (`src/daemon/runtime/dashboard/setup-tenancy.ts:98-102`). Fix line 51 so it does not contradict that paragraph.

### D17. Org-model drift paragraph still says re-mint

- Quote: "On session start the daemon decodes the token's org claim, compares it to the configured org, and re-mints if they disagree"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:81`
- Grounding: same as D4, `src/cli/runtime.ts:564-571`
- Verdict: FALSE
- Action: REVISE

Do not change the separate org-switch sentence. `honeycomb org switch` still re-mints on the real client (`src/cli/org.ts:243-244`). `honeycomb workspace use` updates the file only (`src/cli/org.ts:297-341`).

### D18. Dashboard still writes a provisional first org

- Quote: "the daemon enumerates the account's orgs and workspaces rather than picking one."
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:50`
- Grounding: CLI refuses a silent guess (`src/daemon/runtime/auth/deeplake-issuer.ts:899-900`). Dashboard multi-org login still persists the first enumerated org with `tenancyPending: true` and no marker (`src/daemon/runtime/dashboard/setup-tenancy.ts:241-251`, `src/daemon/runtime/auth/deeplake-issuer.ts:784-808`). Capture stays closed for that file.
- Verdict: STALE
- Action: REVISE

### D19. Projects file mtime does not rebuild the storage client

- Quote: "re-read the daemon tenancy scope and rebuild the storage client when the credential or projects file mtime changes"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:77`
- Grounding: credential mtime only (`src/daemon/storage/index.ts:344`, `src/daemon/runtime/assemble.ts:4744`). `projects.json` is read on each resolve (`src/hooks/shared/project-resolver.ts:270-282`), not as that mtime gate. Login-without-restart for org/workspace/token holds via the credential gate (`src/daemon/storage/index.ts:292-301`).
- Verdict: STALE
- Action: REVISE

Keep the no-restart outcome for credential changes. Attribute project bind to a fresh `projects.json` read, not a storage-client rebuild.

### D20. Confirmation modules are not at repo-root `auth/`

- Quote: "The confirmation plumbing lives in `auth/tenancy-confirmation.ts` alongside `auth/{credentials-store,deeplake-issuer,status-api}.ts`."
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:59`
- Grounding: repo-root `auth/tenancy-confirmation.ts`: ABSENT. Files are `src/daemon/runtime/auth/tenancy-confirmation.ts`, `src/daemon/runtime/auth/credentials-store.ts`, `src/daemon/runtime/auth/deeplake-issuer.ts`, `src/daemon/runtime/auth/status-api.ts`.
- Verdict: STALE
- Action: REVISE

### D21. Daemon storage overrides are `HONEYCOMB_DEEPLAKE_*`

- Quote: "Environment overrides (`HONEYCOMB_ORG_ID`, `HONEYCOMB_WORKSPACE_ID`, `HONEYCOMB_TOKEN`) take precedence"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:67`
- Grounding: those three names are real for login pins and `resolveTenancy` (`src/daemon/runtime/auth/deeplake-issuer.ts:586-593`, `src/daemon/runtime/auth/credentials-store.ts:132-136`, `src/daemon/runtime/auth/credentials-store.ts:584-634`). The storage client merge that wins per field is `HONEYCOMB_DEEPLAKE_ENDPOINT`, `HONEYCOMB_DEEPLAKE_TOKEN`, `HONEYCOMB_DEEPLAKE_ORG`, `HONEYCOMB_DEEPLAKE_WORKSPACE` (`src/daemon/storage/config.ts:110-113`, `src/daemon/storage/config.ts:187-193`). `loadCredentials` does not apply the org/workspace env overrides (`src/daemon/runtime/auth/credentials-store.ts:368-370`).
- Verdict: HOLE
- Action: ADD

Keep the three credential/login names. Add the `HONEYCOMB_DEEPLAKE_*` set as the storage-connection override.

### D22. `agent_id` is not one daemon lookup of body, then session key

- Quote: "`agent_id` is resolved from the request body, then from a harness session key (for example OpenClaw's `agent:alice:...` form), then defaults to `'default'`."
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:40`
- Grounding: OpenClaw session-key parse is in the shim (`src/hooks/openclaw/shim.ts:73-88`), before the daemon sees the event. Capture stores the already-resolved `meta.agentId` (`src/daemon/runtime/capture/capture-handler.ts:689`). Default `"default"` is real (`src/daemon/runtime/capture/event-contract.ts:164`, `src/daemon/runtime/auth/credentials-store.ts:223`). A single daemon function with that three-step order: ABSENT.
- Verdict: STALE
- Action: REVISE

## Claims that hold

These are checked so a later edit does not "fix" them. Action on each is LEAVE.

### H1. Referral headers on the device-code request

- Quote: "Honeycomb sends both `X-Hivemind-Referrer` ... and `X-Honeycomb-Referrer` ... both omitted when the ref is empty"
- Doc: `library/knowledge/private/auth/auth-architecture.md:48`
- Grounding: `src/daemon/runtime/auth/deeplake-issuer.ts:154-170` and `src/daemon/runtime/auth/deeplake-issuer.ts:855-859`. Precedence `--ref`, then `onboarding.ref`, then build default `mario` (`src/daemon/runtime/auth/deeplake-issuer.ts:186-190`, `src/daemon/runtime/onboarding/onboarding-store.ts:65-66`)
- Verdict: HOLDS
- Action: LEAVE

### H2. `agent` is the default connector role

- Quote: "`agent` is the default for harness connectors"
- Doc: `library/knowledge/private/auth/auth-architecture.md:81`
- Grounding: `src/daemon/runtime/auth/api-keys.ts:64`; token claims with no role also become `agent` (`src/daemon/runtime/auth/device-flow.ts:254-258`)
- Verdict: HOLDS
- Action: LEAVE

### H3. Credentials file mode `0600` and `default` workspace sentinel

- Quote: "credentials live in a local file at mode `0600`"
- Doc: `library/knowledge/private/auth/auth-architecture.md:24`
- Grounding: `src/daemon/runtime/auth/credentials-store.ts:127` and `src/daemon/runtime/auth/credentials-store.ts:577`
- Verdict: HOLDS
- Action: LEAVE

### H4. Real JWT org claim is `org_id`

- Quote: "`verifyTokenClaims` now decodes the real JWT and maps its `org_id` claim to the request org."
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:42`
- Grounding: `src/daemon/runtime/auth/contracts.ts:514-517`
- Verdict: HOLDS
- Action: LEAVE

### H5. Explicit tenancy selection rules

- Quote: "TTY CLI: the user is prompted ... Non-TTY CLI: `--org` and `--workspace` are required ... Single-tenancy account: the sole org/workspace pair is auto-selected"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:54-57`
- Grounding: `src/cli/auth.ts:214-216` and `src/cli/auth.ts:245-267`; auto-select `src/daemon/runtime/auth/deeplake-issuer.ts:602-626`. Non-TTY requires the flags only when the account is not single-tenant.
- Verdict: HOLDS
- Action: LEAVE

### H6. Inline workspace create

- Quote: "Workspace creation is supported inline through Deep Lake `POST /workspaces`"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:59`
- Grounding: `src/daemon/runtime/auth/deeplake-issuer.ts:349-364` and `src/daemon/runtime/dashboard/setup-tenancy.ts:86-87`
- Verdict: HOLDS
- Action: LEAVE

### H7. Org switch re-mints; workspace switch does not

- Quote: "Switching org re-mints a fresh org-bound token ... switching workspace updates the file only"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:67`
- Grounding: `src/cli/org.ts:243-262` and `src/cli/org.ts:297-341` (`workspace use` is the alias at `src/cli/org.ts:379`)
- Verdict: HOLDS
- Action: LEAVE

### H8. Grandfathering

- Quote: "Existing installs are grandfathered as confirmed"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:63`
- Grounding: `src/daemon/runtime/auth/tenancy-confirmation.ts:19-23` and `src/daemon/runtime/auth/tenancy-confirmation.ts:82-85`
- Verdict: HOLDS
- Action: LEAVE

### H9. Read policies `isolated`, `shared`, `group`

- Quote: "`isolated` agents see only their own memories, `shared` agents see workspace-global memories plus their own, and `group` agents see global memories from agents in the same `policy_group`"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:85`
- Grounding: `src/daemon/runtime/recall/scope-clause.ts:25-27` and `src/daemon/storage/catalog/tenancy.ts:68-84`
- Verdict: HOLDS
- Action: LEAVE

### H10. Project is a soft inner segment

- Quote: "a fourth segment, Project, that sits as a soft inner-ring divider between workspace and agent"
- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md:36`
- Grounding: `src/daemon/runtime/scope.ts:47-49`
- Verdict: HOLDS
- Action: LEAVE

### H11. Superseded banner

- Quote: "SUPERSEDED (2026-07-03): Relocated to Queen ... Retained here for history only; do not update."
- Doc: `library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md:3`
- Grounding: banner text is in the file. Canonical Queen copy: ABSENT in this repo.
- Verdict: HOLDS
- Action: LEAVE

### H12. Fleet detection behavior (history page, still true in `src/`)

- Quote: "`src/shared/fleet-detection.ts` reads three live signals, and any one of them means fleet"
- Doc: `library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md:75-81`
- Grounding: `src/shared/fleet-detection.ts:17-27` and `src/shared/fleet-detection.ts:214-225` (registry hive entry, `127.0.0.1:3853` with 750 ms, `@legioncodeinc/hive` global). Port constant `src/shared/constants.ts:20`. Install defers login and opens no browser in fleet mode (`src/commands/install.ts:431-433`). `honeycomb login` does not call `classifyFleet`. Health probe interval is 15 seconds (`src/daemon/runtime/assemble.ts:317`); `/health` is `503` when degraded and `200` otherwise (`src/daemon/runtime/server.ts:335`). The named state `login_deferred` is still ABSENT (D12).
- Verdict: HOLDS
- Action: LEAVE

## Counts

- Defects (FALSE, STALE, HOLE): 22
- Holds recorded above: 12
- Actions: REVISE D1-D9, D11, D14-D20, D22. ADD D10, D21. LEAVE D12, D13, and H1-H12.
- Active pages to revise: `auth-architecture.md`, `org-workspace-model.md`.
- Do not edit `device-and-fleet-enrollment-state-machine.md` in the writer wave. Its banner already marks it history, and the enrollment state names are absent from `src/`.
