# Auth and tenancy lens

Date: 2026-10-04. Lens: auth-tenancy. Read-only. No process was started, no package was installed, and no credential file was opened.

Fact labels: VERIFIED (read in this pass, with path and line), REPORTED (a doc or comment states it; this pass did not re-prove the whole claim), UNVERIFIABLE-HERE (needs a live login, a remote service, or a file outside this repository).

Live login against `api.deeplake.ai` is UNVERIFIABLE-HERE. Nothing in this pass requested a device code, opened a browser, or minted a token.

## How auth and tenancy work in code

Two device-flow files live under `src/daemon/runtime/auth/`. Production login uses `deeplake-issuer.ts`. The older seam is `device-flow.ts`.

| File | Role |
|---|---|
| `deeplake-issuer.ts` | HTTP client for `https://api.deeplake.ai`: device code, poll, org and workspace lists, re-mint, and the login functions `authenticateDeviceFlow`, `loginWithDeviceFlow`, `loginWithToken` |
| `device-flow.ts` | `TokenIssuer` seam: `deviceFlowLogin`, `healOrgDrift`, `createTokenAuthenticator`. Production `honeycomb login` does not call `deviceFlowLogin` |
| `credentials-store.ts` | Shared file `~/.deeplake/credentials.json` at mode `0600`, legacy read of `~/.honeycomb`, `resolveTenancy` |
| `tenancy-confirmation.ts` | `tenancyConfirmedAt` versus `tenancyPending` versus grandfathered `orgId` |
| `tenancy-resolution.ts` | Credentials plus env into the storage `QueryScope` |
| `contracts.ts` | Roles `admin`, `member`, `readonly`, `agent`; stub prefix `hcmt.v1.`; `verifyTokenClaims` |
| `rbac.ts` | `createRbacPolicy` |
| `api-keys.ts` | Keys prefixed `hc_sk_`, secret hashed via `scryptHashSecret` |
| `rate-limit.ts` | Sliding-window middleware. Production assembly does not mount it |
| `status-api.ts` | `GET /api/auth/status` |
| `CONVENTIONS.md` | Wave-1 contract. Its "assembly is deferred" section is behind `assemble.ts` |

### Device flow that ships

`loginWithDeviceFlow` (`deeplake-issuer.ts:891`) calls `authenticateDeviceFlow` (`deeplake-issuer.ts:842`).

1. `resolveApiUrl` uses `HONEYCOMB_DEEPLAKE_ENDPOINT` when set, otherwise `https://api.deeplake.ai` (`deeplake-issuer.ts:211-214`, `credentials-store.ts:270`).
2. `POST /auth/device/code` goes to that API (`deeplake-issuer.ts:385-398`). Referral headers `X-Honeycomb-Referrer` and `X-Hivemind-Referrer` are attached only on that request, and only when the trimmed ref is non-empty (`deeplake-issuer.ts:167-170`, `deeplake-issuer.ts:855-859`). Precedence is an explicit ref, then `onboarding.ref`, then the build-injected default (`deeplake-issuer.ts:186-190`).
3. The reporter prints `verification_uri` and `user_code`. `verification_uri_complete` is opened only when `validateVerificationUrl` accepts an `https:` URL (`deeplake-issuer.ts:470-476`, `deeplake-issuer.ts:866-875`).
4. The client polls `POST /auth/device/token` until a short-lived access token arrives (`deeplake-issuer.ts:401-417`, `deeplake-issuer.ts:877-888`). That token is held in memory.
5. `resolveTenancyChoice` picks org and workspace (`deeplake-issuer.ts:671`).
6. `persistSelectedTenancy` re-mints via `POST /users/me/tokens` with `organization_id`, calls `GET /me`, and writes the shared file with `tenancyConfirmedAt` (`deeplake-issuer.ts:366-383`, `deeplake-issuer.ts:752-773`).

Callers of `loginWithDeviceFlow`: `src/cli/auth.ts` (the `honeycomb login` verb) and `src/commands/install.ts:390` (solo install with no credentials). `deviceFlowLogin` (`device-flow.ts:126`) is called from tests (`tests/daemon/runtime/auth/device-flow.test.ts`, `tests/cli/runtime.test.ts`). No production caller was found.

`src/cli/token-issuer.ts` still builds a local stub issuer when `HONEYCOMB_AUTH_URL` is unset (`token-issuer.ts:12-17`, `token-issuer.ts:69-71`). `buildAuthPassthrough` routes `login` through `authMain` and the deeplake flows (`cli/runtime.ts:509-512`). The stub issuer remains on the drift-heal path (`cli/runtime.ts:556`).

### How org and workspace are selected

`resolveTenancyChoice` (`deeplake-issuer.ts:663-726`) never persists a silent `orgs[0]` as a confirmed choice. Order:

1. Both `HONEYCOMB_ORG_ID` and `HONEYCOMB_WORKSPACE_ID` set: those pins (`deeplake-issuer.ts:682-691`).
2. Org pin only: one or zero workspaces resolve (zero becomes the `default` sentinel); several workspaces need a selector or throw `TenancySelectionRequiredError` (`deeplake-issuer.ts:694-708`).
3. One org: `computeAutoSelection` accepts one workspace, or zero workspaces mapped to `default`. Several workspaces need a selector (`deeplake-issuer.ts:602-626`, `deeplake-issuer.ts:711-722`).
4. Several orgs: selector, or `TenancySelectionRequiredError` (`deeplake-issuer.ts:724-726`).

The CLI selector (`src/cli/auth.ts:211-248`) resolves `--org` and `--workspace` by name or id, prompts on a TTY, and refuses a non-TTY multi-tenant account that has no flags. `loginWithToken` uses the same choice function (`deeplake-issuer.ts:934-947`).

The dashboard path is different. `assembleDaemon` creates one in-memory pending-link store (`assemble.ts:3286`) and, in `local` mode, wires `POST /setup/login` to `makePendingLinkRunner` (`assemble.ts:1447-1462`). That runner calls `authenticateDeviceFlow`, then `resolveTenancyChoice` with no selector. A resolved choice is persisted. `TenancySelectionRequiredError` writes a provisional credential bound to `err.orgs[0]` with `tenancyPending: true` and no `tenancyConfirmedAt` (`setup-tenancy.ts:247-264`, `deeplake-issuer.ts:791-811`), then parks the short-lived token in memory for `POST /setup/tenancy/select`.

`resolveTenancyConfirmation` (`tenancy-confirmation.ts:65-85`):

- Marker `tenancyConfirmedAt` present: confirmed, not grandfathered.
- `tenancyPending: true` and no marker: not confirmed.
- Non-empty `orgId` and neither of those: confirmed and grandfathered.

`isTenancyConfirmed` is passed into the capture handler (`assemble.ts:1388-1391`). Capture returns `tenancy_unconfirmed` when it is false (`capture-handler.ts:768-775`). Health exposes `captureTenancyUnconfirmed` (`assemble.ts:3460`). No other writer in `src/` calls `isTenancyConfirmed`.

After a credential exists, `resolveTenancy` (`credentials-store.ts:600-636`) decodes the token with `verifyTokenClaims`. The file `orgId` must equal the token `org` claim. `HONEYCOMB_ORG_ID`, when set, must equal that same claim or the function throws `TenancyIntegrityError`. `HONEYCOMB_WORKSPACE_ID` overrides the stored workspace with no token workspace check. `resolveRequestTenancy` turns that result into the storage scope, or `denied` (`tenancy-resolution.ts:102-128`).

Switching: `honeycomb org switch` re-mints (`cli/org.ts:206` area, `deeplake-issuer.ts:366`). `honeycomb workspace switch` and the alias `honeycomb workspace use` update `workspaceId` in the file and do not re-mint (`cli/org.ts:296-301`). The dashboard switcher posts `POST /api/diagnostics/scope/org-switch` and `POST /api/diagnostics/scope/workspace-switch` (`projects/scope-switch-api.ts:5-18`, `scope-switch-api.ts:57`).

### Modes and the loopback assumption

Default listen address is `127.0.0.1:3850`. Default mode is `local` (`config.ts:67-71`). `HONEYCOMB_BIND` can change the host. A non-loopback bind sets `widened` (`config.ts:143-168`). Mode and bind are separate fields.

`permissionMiddleware` (`permission.ts:184-201`):

- `local`: the handler runs with no authenticator and no RBAC.
- `hybrid`: a trusted local peer may pass with no credential, and only when `socketPeer.isTrustedLocalPeer` is true.
- `team`, and `hybrid` without that signal: missing credentials are 401; the authenticator then the policy decide allow versus 403.

`server.ts:256-263` passes authenticator and policy. It does not pass `socketPeer`. The default is `noSocketPeer` (`permission.ts:112-113`), which trusts no peer. In the assembled daemon, `hybrid` therefore follows the token path.

`authForMode` (`assemble.ts:1045-1054`) installs `composeAuthenticator` plus `createRbacPolicy` for `team` and `hybrid`. `local` installs the same authenticator and `defaultDenyPolicy`, which the middleware does not consult because `local` returns before it.

`createTokenAuthenticator(undefined, mode)` (`assemble.ts:1025`, `device-flow.ts:307-309`) rejects every bearer in `team` and `hybrid` when the verifier is the default `verifyTokenClaims`. The function returns `null` before claims are read. `verifyTokenClaims` decodes a `hcmt.v1.` body or a JWT payload and does not check a signature (`contracts.ts:475-488`). The comment at `device-flow.ts:300-306` says that default is a tenancy decoder, so production mode refuses it. API keys are the second half of `composeAuthenticator` (`assemble.ts:1028-1033`) and still run.

Setup routes mount only when `mode === "local"` (`assemble.ts:1447`). Each `/setup/tenancy` handler also returns 404 when the mode is not `local` (`setup-tenancy.ts:374-378`). They attach to group `"/"` (`setup-tenancy.ts:71`, `setup-login.ts:40`). The server comment states there is no CORS middleware because the browser talks to Hive on port 3853 and Hive fetches the daemon on loopback (`server.ts:286-291`).

Install-time fleet detection is `src/shared/fleet-detection.ts`. Any one of a hive registry entry, an HTTP answer from `127.0.0.1:3853` within 750 ms, or `@legioncodeinc/hive` in the npm global tree means fleet (`fleet-detection.ts:17-27`, `fleet-detection.ts:55-56`). Fleet install prints that login is deferred and does not open a browser (`install.ts:431-434`). Solo install with no credentials runs `loginWithDeviceFlow` (`install.ts:389-393`, `install.ts:437-446`).

## Comparison to the three knowledge docs

Aligned with the code:

- Shared credential path `~/.deeplake/credentials.json` at mode `0600` (`auth-architecture.md:24`, `credentials-store.ts:66-73`, `credentials-store.ts:127`).
- Dual referral headers on the device-code request only, trim-and-omit (`auth-architecture.md:48`, `deeplake-issuer.ts:145-170`).
- `https` gate before opening the verification URL (`auth-architecture.md:44`, `deeplake-issuer.ts:470-476`).
- `POST /setup/login` returns `user_code` and verification URIs (`auth-architecture.md:44`, `setup-login.ts:47-54`).
- CLI tenancy rules: TTY prompt, non-TTY flags required, single tenant auto-selected (`org-workspace-model.md:54-57`, `cli/auth.ts:211-248`, `computeAutoSelection`).
- `honeycomb org switch` re-mints; workspace switch updates the file (`org-workspace-model.md:65-72`, `cli/org.ts:296-301`).
- Env names `HONEYCOMB_ORG_ID`, `HONEYCOMB_WORKSPACE_ID`, `HONEYCOMB_TOKEN` exist (`credentials-store.ts:132-136`).
- Grandfathering: a pre-marker credential with an `orgId` counts as confirmed (`org-workspace-model.md:61-63`, `tenancy-confirmation.ts:84-85`).
- Fleet detection's three signals and the install branch match the solo-versus-fleet section of the enrollment doc (`device-and-fleet-enrollment-state-machine.md:72-97`, `fleet-detection.ts`, `install.ts:398-446`).
- Role set in code matches `auth/CONVENTIONS.md` (`admin`, `member`, `readonly`, `agent`), and `rbac.ts:23-27` already says the old `operator` name was reconciled to `member`.

Stale or over-wide. Details are the findings below.

## Findings

### auth-tenancy-1

Severity: high. The knowledge doc describes a prefix gate that lets real signed bearers through in `team` and `hybrid`. The assembled authenticator rejects every bearer that uses the default decoder.

- VERIFIED: `auth-architecture.md:64-69` says bearers that start with `hcmt.v1.` are rejected in `team` and `hybrid` before claims are read, and that non-stub bearers flow to the normal verifier.
- VERIFIED: `device-flow.ts:307-309` returns `null` for every token when `mode` is `team` or `hybrid` and `verify === verifyTokenClaims`. There is no prefix test in that branch.
- VERIFIED: `assemble.ts:1025` calls `createTokenAuthenticator(undefined, mode)`, so the default verifier is the one in production.
- VERIFIED: `contracts.ts:475-488` decodes stub bodies and JWT payloads and does not check a signature. That decoder still serves `resolveTenancy` (`credentials-store.ts:605`).
- VERIFIED: `composeAuthenticator` still tries `createApiKeyAuthenticator` after a null token result (`assemble.ts:1028-1033`).

### auth-tenancy-2

Severity: high. `local` is described as "no authentication" and "binds to localhost" together. The process default is both, and the two knobs move separately.

- VERIFIED: `auth-architecture.md:54` pairs full access with a localhost bind for mode `local`.
- VERIFIED: `config.ts:71` defaults mode to `local`. `config.ts:67` defaults host to the shared loopback constant. `config.ts:156-168` sets `widened` from `HONEYCOMB_BIND` when the bind is not `127.0.0.1`, `::1`, or `localhost`. Mode is a different field (`config.ts:71`).
- VERIFIED: `permission.ts:187-189` opens the request when `mode === "local"` and does not read the bind address.
- REPORTED: `server.ts:373` includes `widened` on `/api/status`. This pass did not re-read that handler body past the field name in the daemon-runtime lens notes; the config object carries the flag (`config.ts:73`).

### auth-tenancy-3

Severity: high. Hybrid localhost trust is described as a TCP-peer check that is already in force. The running daemon never installs that probe.

- VERIFIED: `auth-architecture.md:58` says localhost requests in `hybrid` are trusted from the TCP peer address, and that a missing socket fails closed.
- VERIFIED: `permission.ts:194-201` implements the peer branch only through `socketPeer.isTrustedLocalPeer`.
- VERIFIED: `permission.ts:109-113` documents `noSocketPeer` as the default and says hybrid then behaves like team.
- VERIFIED: `server.ts:256-259` builds `permissionOptions` with authenticator and policy only. A repo search for `isTrustedLocalPeer` found the interface and `noSocketPeer` in `permission.ts` and no production probe.

### auth-tenancy-4

Severity: medium. Rate limiting is specified for `team` and `hybrid`. The middleware exists and is not mounted on the daemon.

- VERIFIED: `auth-architecture.md:110-112` says a sliding window in `team` and `hybrid` returns 429 with `Retry-After`.
- VERIFIED: `rate-limit.ts:177-208` implements that behavior, and line 187 says mounting is deferred assembly.
- VERIFIED: `createRateLimitMiddleware` is imported by `auth/index.ts` and by `tests/daemon/runtime/auth/rate-limit.test.ts`. No call site under `src/daemon/runtime/assemble.ts` or `server.ts` was found.

### auth-tenancy-5

Severity: medium. `auth-architecture.md` still describes the pre-selection login and a daemon-mediated device flow.

- VERIFIED: `auth-architecture.md:24` says org selection is environment override, then the token org claim, then the first org, and that workspace resolves from a `default` sentinel.
- VERIFIED: the sequence diagram at `auth-architecture.md:26-38` shows the CLI requesting a device code from the daemon, the browser approving at the daemon, and the CLI polling the daemon.
- VERIFIED: production login calls `api.deeplake.ai` (or `HONEYCOMB_DEEPLAKE_ENDPOINT`) from `createDeeplakeAuthClient` (`deeplake-issuer.ts:302-312`, `deeplake-issuer.ts:385`). The CLI entry is `loginWithDeviceFlow` (`cli/auth.ts:9`, `cli/runtime.ts:509-512`).
- VERIFIED: confirmed selection is `resolveTenancyChoice` (`deeplake-issuer.ts:671-726`). An env org that disagrees with the token claim is rejected by `resolveTenancy` (`credentials-store.ts:619-628`), so an env org does not outrank the token.
- UNVERIFIABLE-HERE: whether the live Activeloop device-code endpoint accepts the referral headers.

### auth-tenancy-6

Severity: medium. The org and workspace doc says the link no longer assumes `orgs[0]` and that every write pipeline stays dormant until confirmation. The dashboard pending path still mints against the first org, and the confirmation boolean gates capture.

- VERIFIED: `org-workspace-model.md:44-51` says enumeration then an explicit `/setup/tenancy/*` persist, and that capture, skillify, and every write pipeline stay dormant until `tenancyConfirmedAt`. It cites `src/dashboard/setup-tenancy.ts`.
- VERIFIED: the file on disk is `src/daemon/runtime/dashboard/setup-tenancy.ts`. Routes are `GET /setup/tenancy`, `GET /setup/tenancy/orgs`, `GET /setup/tenancy/workspaces`, `POST /setup/tenancy/select`, `POST /setup/tenancy/workspaces` (`setup-tenancy.ts:73-80`).
- VERIFIED: `makePendingLinkRunner` persists `err.orgs[0]` through `persistUnconfirmedTenancy` when selection is required (`setup-tenancy.ts:247-258`). That record sets `tenancyPending: true` and `workspaceId` `default` (`deeplake-issuer.ts:799-810`).
- VERIFIED: `isTenancyConfirmed` is wired on the capture handler (`assemble.ts:1391`) and the health detail (`assemble.ts:3460`). A search of `src/` found no skillify or memories-route caller.
- VERIFIED: `auth-architecture.md:44` says the dashboard end state is byte-identical to a terminal login through `persistFromToken`. `persistFromToken` has no function definition in `src/`. Production `mountSetupLogin` receives `makePendingLinkRunner` (`assemble.ts:1461-1462`). The CLI `loginWithDeviceFlow` throws `TenancySelectionRequiredError` instead of writing the pending record (`deeplake-issuer.ts:898-901`).
- VERIFIED: `setup-login.ts:10-11` still names `persistFromToken` and `loginWithDeviceFlow` as the persist path, and line 13 names `mountDashboardHost`. `src/daemon/runtime/dashboard/host.ts` is absent (same absence recorded by the daemon-runtime lens).

### auth-tenancy-7

Severity: medium. The auth doc's role table still says `operator`. The frozen role is `member`.

- VERIFIED: `auth-architecture.md:75-80` lists `admin`, `operator`, `agent`, `readonly`, and gives `operator` remember, recall, modify, forget, recover, documents, connectors, diagnostics, and analytics.
- VERIFIED: `contracts.ts:82` freezes `admin`, `member`, `readonly`, `agent`.
- VERIFIED: `rbac.ts:23-27` says the PRD prose name `operator` was reconciled to `member`. `connectorsAdmin` is `admin` and `member` (`rbac.ts:98`). Diagnostics, connectors, sources, and harnesses use that capability (`rbac.ts:131-141`).
- VERIFIED: `agent` is the default API-key role (`api-keys.ts:64`, `api-keys.ts:137-149`).

### auth-tenancy-8

Severity: medium. Both auth docs say a drifted org token is re-minted on session start. Real Deep Lake credentials are left in place and the drift is only reported.

- VERIFIED: `auth-architecture.md:40` and `org-workspace-model.md:81` say the daemon decodes the org claim, compares it to the active org, re-mints on disagreement, and on failure logs a warning and continues.
- VERIFIED: `healOrgDrift` still re-mints through its `TokenIssuer` and warns without throwing (`device-flow.ts:207-238`).
- VERIFIED: `buildOrgDriftHealer` (`cli/runtime.ts:555-574`) skips that healer when `apiUrl` is `https://api.deeplake.ai`. A mismatched org returns `drift-surfaced` and does not write the file. The comment says `honeycomb org switch` is the real re-mint.

### auth-tenancy-9

Severity: medium. The enrollment state machine is marked superseded, and almost none of its states exist in this tree. The fleet-detection section still matches.

- VERIFIED: `device-and-fleet-enrollment-state-machine.md:3` says the canonical copy is `queen/library/knowledge/private/auth/device-and-fleet-enrollment-state-machine.md` and that this file is history.
- VERIFIED: a search of `src/` found no identifiers `pending_approval`, `memory_ready`, `login_deferred`, `tenancy_pending`, `enrollment_token`, `custodian_state`, or `rewrap`.
- VERIFIED: install fleet mode prints "login is deferred to Hive onboarding" (`install.ts:431-434`). Confirmation is the boolean from `tenancy-confirmation.ts`, not a `tenancy_pending` or `tenancy_confirmed` API enum. The string `tenancy_unconfirmed` is a capture gate reason (`capture/gated-captures.ts:21`).
- VERIFIED: the three fleet signals and the solo versus fleet install branch in that doc match `fleet-detection.ts:17-27` and `install.ts:398-446`.
- UNVERIFIABLE-HERE: the queen canonical file is not in this repository, so this pass cannot say whether that copy matches Honeycomb.

### auth-tenancy-10

Severity: low. `auth/CONVENTIONS.md` still says daemon assembly of the authenticator, RBAC policy, and socket probe is deferred. `assemble.ts` wires the first two.

- VERIFIED: `CONVENTIONS.md:169-176` says `createDaemon` still uses `alwaysUnauthenticated` and `defaultDenyPolicy`, with a TODO, and that the CLIs are not on the bin yet.
- VERIFIED: `assemble.ts:3500` calls `authForMode`, and `authForMode` returns the composed authenticator and `createRbacPolicy` for `team` and `hybrid` (`assemble.ts:1050-1051`). `mountAuthStatusApi` is called (`assemble.ts:3782`). `buildAuthPassthrough` dispatches login, logout, whoami, org, and workspace (`cli/runtime.ts:504-529`).
- VERIFIED: the socket probe and the rate-limit mount from that same deferred paragraph are still absent (auth-tenancy-3, auth-tenancy-4). `createDaemon` still defaults the options to the fail-closed pair when a caller omits them (`server.ts:250-253`, `permission.ts:179-180`). Production `assembleDaemon` does not omit them.

### auth-tenancy-11

Severity: low. Org and workspace administration is classified on `/api/org` and `/api/workspace`. The live switch routes are under `/api/diagnostics`.

- VERIFIED: `rbac.ts:124-125` maps `/api/org` and `/api/workspace` to capability `admin`.
- VERIFIED: the daemon-runtime lens found those prefixes as scaffolds with no handler attach. This pass did not re-walk every `ROUTE_GROUPS` row. It did find the live switch at `projects/scope-switch-api.ts:55-60` (`POST /api/diagnostics/scope/org-switch` and `POST /api/diagnostics/scope/workspace-switch`).
- VERIFIED: `/api/diagnostics` is capability `connectorsAdmin` (`rbac.ts:137`), which `member` and `admin` hold (`rbac.ts:98`). In `local` mode that table is not consulted (`permission.ts:187-189`).

### auth-tenancy-12

Severity: low. `org-workspace-model.md` says env overrides take precedence for org id. The integrity gate refuses an org env value that disagrees with the token.

- VERIFIED: `org-workspace-model.md:67` says `HONEYCOMB_ORG_ID`, `HONEYCOMB_WORKSPACE_ID`, and `HONEYCOMB_TOKEN` take precedence for scripted and CI use.
- VERIFIED: `resolveTenancy` uses `HONEYCOMB_TOKEN` in place of the file token when it is non-empty (`credentials-store.ts:601-602`). A non-empty `HONEYCOMB_ORG_ID` that differs from `claims.org` throws `TenancyIntegrityError` (`credentials-store.ts:619-628`). A non-empty `HONEYCOMB_WORKSPACE_ID` replaces the workspace (`credentials-store.ts:632-634`).
- VERIFIED: link-time pins in `resolvePinnedTenancy` (`deeplake-issuer.ts:587-593`) are a different step. They choose which org to mint for. They do not let a stored file org override the token after mint.

## Could not verify

- A live device-code grant, browser approval, poll, and `/users/me/tokens` mint. UNVERIFIABLE-HERE.
- Whether Activeloop honors `X-Honeycomb-Referrer`. UNVERIFIABLE-HERE. The header is sent (`deeplake-issuer.ts:167-170`). `auth-architecture.md:48` reports that the backend recognizes `X-Hivemind-Referrer` today. REPORTED.
- The queen copy of the enrollment state machine. UNVERIFIABLE-HERE.
- Any deployed host that sets `HONEYCOMB_BIND` or `HONEYCOMB_MODE`. This pass read the resolver only.

## Punch list

1. Rewrite `auth-architecture.md` login section so the CLI and the daemon both call `deeplake-issuer.ts` against `api.deeplake.ai`, and so org choice is `resolveTenancyChoice` (auth-tenancy-5, auth-tenancy-12).
2. Replace the role table's `operator` with `member`, matching `contracts.ts` (auth-tenancy-7).
3. Describe the `team` and `hybrid` bearer gate as "default `verifyTokenClaims` is refused entirely; API keys still authenticate" until a signature-checking verifier is injected (auth-tenancy-1).
4. State that hybrid peer trust is unimplemented and that `hybrid` currently matches `team` (auth-tenancy-3).
5. State that rate limiting is implemented and not mounted (auth-tenancy-4).
6. Separate mode from bind: `local` is open even if `HONEYCOMB_BIND` leaves loopback (auth-tenancy-2).
7. Point tenancy routes at `src/daemon/runtime/dashboard/setup-tenancy.ts`. Describe the provisional `orgs[0]` credential and say the confirmation flag gates capture, not every write route (auth-tenancy-6).
8. Say real-backend drift is surfaced by `buildOrgDriftHealer` and re-minted by `honeycomb org switch` (auth-tenancy-8).
9. Leave the enrollment doc's superseded banner. Treat the custody, rewrap, and enrollment-token states as absent from this repo. Keep the fleet-detection section, which still matches (auth-tenancy-9).
10. Update `auth/CONVENTIONS.md` so assembly of authenticator and RBAC is current, and so the socket probe and rate limiter stay marked unwired (auth-tenancy-10).
11. Point org and workspace switching at the CLI and at `POST /api/diagnostics/scope/*` (auth-tenancy-11).
12. Delete the `persistFromToken` and `mountDashboardHost` sentences in `setup-login.ts` when that file is next edited (auth-tenancy-6).
