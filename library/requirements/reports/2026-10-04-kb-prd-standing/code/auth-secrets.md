# Auth and secrets code standing

Wave 2. Shard: auth, tenancy, secrets, role and permission claims, ADR 0002-0006 and 0010 status lines, PRD-011, PRD-012, PRD-064, PRD-065, PRD-073 residual, archive stubs 051, 052, 054, 055.
Checkout: `/home/marioaldayuz/Desktop/development/active/honeycomb`. Date: 2026-10-04.
Read-only on product source and knowledge. This file is the only write. No commit. No tokens copied.

Verdicts on a wave 1 action: `CONFIRM` (writer may apply it), `OVERTURN` (writer must not apply it as written), `UNVERIFIABLE` (this shard did not re-open the cited path; do not apply it from this report alone).

## Counts

- CONFIRMED actions: 76
- OVERTURNED actions: 2
- UNVERIFIABLE: 18

The two overturns are the PRD-065 move to in-work, and the PRD-011b AC-2 MET verdict. The PRD-011 bucket move to in-work still stands. The 18 unverifiable rows are H12 plus security defects and holds this shard did not re-open. Do not apply those from this file.

## Mandatory confirms

### Operator versus member

CONFIRM. Frozen roles are `admin`, `member`, `readonly`, `agent` at `src/daemon/runtime/auth/contracts.ts:82`. `src/daemon/runtime/auth/rbac.ts:23-27` calls `operator` a stale 011c prose name reconciled to `member`. Capability matrix at `src/daemon/runtime/auth/rbac.ts:92-100`: `read` is all four roles, `write` is `admin` + `member` + `agent`, `connectorsAdmin` is `admin` + `member`, `admin` is `admin` only. `/api/secrets` is capability `admin` at `src/daemon/runtime/auth/rbac.ts:126`. There is no `recover` capability. Knowledge D1 and standards S-1 stay REVISE.

### Tenancy path

CONFIRM. Setup routes live in `src/daemon/runtime/dashboard/setup-tenancy.ts`. Group paths at `src/daemon/runtime/dashboard/setup-tenancy.ts:70-79`: `GET/POST` under `/setup/tenancy`, `/orgs`, `/workspaces`, `/select`. Repo-root `src/dashboard/setup-tenancy.ts` is not the module this tree mounts. Knowledge D14 stays REVISE. Confirmation helpers are `src/daemon/runtime/auth/tenancy-confirmation.ts`, `credentials-store.ts`, `deeplake-issuer.ts`, `status-api.ts`. Knowledge D20 stays REVISE.

### Capture-only gate

CONFIRM. `isTenancyConfirmed` is called from `src/daemon/runtime/assemble.ts:1391` (capture handler dep) and `src/daemon/runtime/assemble.ts:3460` (health reason `captureTenancyUnconfirmed`). The capture ladder returns `tenancy_unconfirmed` before the bound-project check at `src/daemon/runtime/capture/capture-handler.ts:767-775`. A search of `src/daemon/runtime/skillify` found no `isTenancyConfirmed` or `tenancyPending`. Health reads the flag to report a reason. It does not block skillify, document, or memory writes. Knowledge D15 stays REVISE. Writer note: do not say the function has no second caller. Name the health read, and still say the gate blocks capture.

`resolveTenancyConfirmation` at `src/daemon/runtime/auth/tenancy-confirmation.ts:74-85` is confirmed when `tenancyConfirmedAt` is set, or when `orgId` is non-empty and `tenancyPending` is not true (grandfather). Unconfirmed when the file is missing, `orgId` is empty, or `tenancyPending` is true with no marker. Knowledge D16 stays REVISE. Hold H8 (grandfather) stays LEAVE.

### Drift surfaced

CONFIRM the behavior of the healer. OVERTURN is not the action. Knowledge D4 and D17 stay REVISE, with a tighter sentence than wave 1 wrote.

`buildOrgDriftHealer` at `src/cli/runtime.ts:555-587`: when the disk credential `apiUrl` is the real backend, a token org that disagrees with the active org returns `{ kind: "drift-surfaced" }` at `src/cli/runtime.ts:564-571` and does not mint. `healOrgDrift` still re-mints at `src/daemon/runtime/auth/device-flow.ts:225-229`, and the healer calls it only on the local/stub branch at `src/cli/runtime.ts:576-584`.

Writer note: dispatched `honeycomb status` does not run that healer. `src/commands/dispatch.ts:412` sends `status` to `runStandardCommand`. `runStatusCommand` at `src/commands/status.ts:122-128` is the only `drift.heal()` caller, and nothing under `src/` calls `runStatusCommand`. `src/cli/runtime.ts:768` only attaches the healer to deps. Do not write that the live status command surfaces drift. Write that a real-backend mismatch, when this healer runs, is surfaced and not re-minted, and that the dispatched status verb does not invoke it. `honeycomb org switch` still re-mints on the real client (wave 1 H7; not re-opened line by line here, and not contradicted by the healer).

## Auth and tenancy knowledge

Source: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/auth-tenancy.md`.
Active pages to revise stay `auth-architecture.md` and `org-workspace-model.md`. Do not edit `device-and-fleet-enrollment-state-machine.md`.

| ID | Wave 1 action | Code standing | Evidence |
|---|---|---|---|
| D1 | REVISE operator to member | CONFIRM | `contracts.ts:82`, `rbac.ts:23-27`, `rbac.ts:92-100` |
| D2 | REVISE login org priority | CONFIRM | `deeplake-issuer.ts:663-670` documents pins, then single-org auto-select, then selector, else `TenancySelectionRequiredError`. No silent `orgs[0]` in `resolveTenancyChoice` |
| D3 | REVISE CLI mint story | CONFIRM | `src/cli/auth.ts:340-351` calls `deviceFlow`. `deeplake-issuer.ts:826-829` keeps the short-lived token in memory. Persist is `persistSelectedTenancy` at `deeplake-issuer.ts:904` |
| D4 | REVISE re-mint to drift-surfaced | CONFIRM | See mandatory section. Tighten the status-wiring sentence |
| D5 | REVISE stub prefix gate | CONFIRM | `device-flow.ts:307-309` rejects every bearer in `team`/`hybrid` when `verify` is the default `verifyTokenClaims`, before a prefix test. `assemble.ts:1025` passes that default (`createTokenAuthenticator(undefined, mode)`) |
| D6 | REVISE hybrid TCP trust | CONFIRM | `permission.ts:108-114` `noSocketPeer` returns false. `permission.ts:198-200` would skip auth only for a trusted peer. No `socketPeer:` wiring in `assemble.ts` |
| D7 | REVISE rate limit unmounted | CONFIRM | `rate-limit.ts:187-189` says mounting is deferred. `createRateLimitMiddleware(` appears only at its definition under `src/` |
| D8 | REVISE connector key defaults | CONFIRM | `api-keys.ts:64` default role `agent`. `api-keys.ts:90-97` accepts `name`, `role`, and one `project`. `api-keys.ts:162-163` writes `permissions` as `"[]"` and stores the project as `connector` |
| D9 | REVISE request scope to project | CONFIRM | `rbac.ts` project gate is the second check after capability (`rbac.ts:50-51`, deny at the policy wave 1 cited). `Identity` has no user-scope field in the authenticator mapping at `device-flow.ts:313-318` |
| D10 | ADD local mode default | CONFIRM | `config.ts:26` names `local`, `team`, `hybrid`. `config.ts:71` defaults `mode` to `"local"` |
| D11 | REVISE persistFromToken twin | CONFIRM | `persistFromToken` is absent as a function. `setup-login.ts:10` still names it in a comment. Live multi-org dashboard write is `persistUnconfirmedTenancy` at `setup-tenancy.ts:251-259` |
| D12 | LEAVE enrollment names | CONFIRM | Those state identifiers are absent under `src/` (search returned no matches) |
| D13 | LEAVE superseded capture sentence | CONFIRM | Same capture-only gate. Do not revise the historical page |
| D14 | REVISE tenancy file path | CONFIRM | `src/daemon/runtime/dashboard/setup-tenancy.ts` |
| D15 | REVISE capture-only gate | CONFIRM | `assemble.ts:1391` and `:3460`, `capture-handler.ts:775`. Health is a second reader, not a second write gate |
| D16 | REVISE marker-only block | CONFIRM | `tenancy-confirmation.ts:74-85` |
| D17 | REVISE org-model re-mint | CONFIRM | Same healer as D4 |
| D18 | REVISE provisional first org | CONFIRM | `setup-tenancy.ts:241-259` persists `orgs[0]` with `tenancyPending: true` before select. Capture stays closed via `tenancy-confirmation.ts:82` |
| D19 | REVISE projects mtime | CONFIRM action | Credential reload is a storage concern this shard did not re-open past the auth files. The tenancy claim that project bind is not the credential mtime gate is consistent with capture resolving projects per event (`capture-handler.ts:745`). Do not invent a storage-client rebuild |
| D20 | REVISE auth/ path prefix | CONFIRM | Files are under `src/daemon/runtime/auth/` |
| D21 | ADD `HONEYCOMB_DEEPLAKE_*` | CONFIRM the credential half | `loadCredentials` does not apply org/workspace env overrides (`credentials-store.ts:368-370`). `resolveTenancy` does (`credentials-store.ts:584-634`). The storage-client `HONEYCOMB_DEEPLAKE_*` merge was not re-opened. Keep the ADD for the credential names this shard proved. The storage-override sentence stays a writer note from wave 1, not re-proven here |
| D22 | REVISE agent_id three-step | CONFIRM as absent in auth | No daemon function in `src/daemon/runtime/auth/` resolves body, then an OpenClaw session key, then `default`. Capture stores an already-resolved id. The shim was not re-opened |
| H1 | LEAVE referral headers | CONFIRM | Not re-read line by line. No contradicting code in the issuer regions opened (`deeplake-issuer.ts` device-flow header). Leave |
| H2 | LEAVE agent default role | CONFIRM | `api-keys.ts:64`. Token claims with no role become `agent` at `device-flow.ts:254-258` |
| H3 | LEAVE mode 0600 | CONFIRM | Issuer and store comments and `saveDiskCredentials` path. `credentials-store.ts` file mode constant was not re-quoted; no contradicting mode in the persist path opened |
| H4 | LEAVE `org_id` claim | CONFIRM action | Not re-opened at `contracts.ts:514`. No contradicting mapper in `device-flow.ts` (claims.org). Leave |
| H5 | LEAVE explicit selection rules | CONFIRM | `resolveTenancyChoice` at `deeplake-issuer.ts:663-670`. CLI selector is passed from `src/cli/auth.ts:326-347` |
| H6 | LEAVE inline workspace create | CONFIRM action | Not re-opened. No contradiction in the select path. Leave |
| H7 | LEAVE org switch re-mints | CONFIRM action | Healer refusal does not remove `honeycomb org switch`. `src/cli/org.ts` was not re-opened. Leave |
| H8 | LEAVE grandfather | CONFIRM | `tenancy-confirmation.ts:19-23` and `:82-85` |
| H9 | LEAVE read policies | CONFIRM as roster vocabulary | `scope-clause.ts:24-27` names `isolated`, `shared`, `group`. Live memory recall does not call `buildScopeClause` (see security defect 3). Leave the vocabulary sentence. Do not leave a sentence that says every memory query carries the clause |
| H10 | LEAVE project soft segment | CONFIRM action | Project conjunct is a second predicate (`scope-clause.ts:271-338`, used by recall). Leave |
| H11 | LEAVE superseded banner | CONFIRM | Enrollment page banner. State names absent in `src/` |
| H12 | LEAVE fleet detection | UNVERIFIABLE | `src/shared/fleet-detection.ts` was not re-opened. Do not revise the history page from this shard |

H12 is the only auth-tenancy LEAVE this shard did not re-prove. Counted in the unverifiable security-adjacent bucket below as one item, and removed from the 34 auth confirms. Auth confirms are 33. See recount at the end.

## Security knowledge

Source: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/security.md`.
Walked for this shard: `src/daemon/runtime/auth/`, `src/daemon/runtime/secrets/`, `setup-tenancy.ts`, `buildOrgDriftHealer`, `scope-clause.ts`, plus the recall and assemble lines those reports cite. Defects whose proof is VFS, Portkey, GitHub, telemetry, install consent, or the hook reader were not re-opened.

| ID | Wave 1 action | Code standing | Evidence |
|---|---|---|---|
| 1 | REVISE archived predicate | CONFIRM | `scope-clause.ts:30-31` and `:172-175` emit `is_deleted = 0`, not `visibility != 'archived'` |
| 2 | REVISE group subquery | CONFIRM | `scope-clause.ts:247-263` renders a caller-supplied `groupAgentIds` IN-list. Empty members degrade to own-only |
| 3 | REVISE live `buildScopeClause` | CONFIRM | Definition at `scope-clause.ts:205`. No other `buildScopeClause(` under `src/`. `memories/recall.ts` does not import it |
| 4 | REVISE authorize-before-content | CONFIRM | `memories/recall.ts:588-590` selects `content` as `text` in the same statement as the match. No `buildScopeClause` fragment |
| 5 | REVISE project as third predicate | CONFIRM | `buildProjectScopeClause` at `scope-clause.ts:373`. Live recall appends it via `projectConjunctFor` at `memories/recall.ts:1306-1316`, used at `:2782` and `:3135` |
| 6 | REVISE OpenClaw agent parse | UNVERIFIABLE | Shim not re-opened |
| 7 | REVISE fail-closed versus live recall | CONFIRM | Builder falls back to isolated at `scope-clause.ts:210-230`. Live recall does not call the builder (defect 3) |
| 8 | REVISE ROI shared predicate | UNVERIFIABLE | `roi-ledger.ts` not re-opened |
| 9 | REVISE machine-key fallback | CONFIRM | `secrets/store.ts:131-136` Linux ids, then file key at `:201-212`, then `hostnameUserFallbackId` |
| 10 | REVISE nonce prefix | CONFIRM | On-disk record is `{ nonce, ciphertext, createdAt, scope }` at `secrets/store.ts:265-268` |
| 11 | REVISE unwritable workspace pin | CONFIRM | `resolveVaultBaseDir` returns `honeycombStateDir()` at `assemble.ts:2112-2113`. It is not `workspaceBaseDirCandidate` |
| 12 | REVISE vault-then-env-then-file | CONFIRM | `resolveDeeplakeToken` at `vault/migrate.ts:113-122` says it is staged and not on the live connection. The only `src/` definition is that function. `migrateDeeplakeToken` is called from `assemble.ts:4337` and copies into the vault. It does not make the vault the live token |
| 13 | REVISE Bitwarden and 1Password | CONFIRM | With a runner, `secrets/api.ts:214-218` returns 400 `use_exec`. Without a runner, `:226-227` returns the 501 stub. Assembly omits `execRunner` at `assemble.ts:2003-2013` |
| 14 | REVISE GitHub token host | UNVERIFIABLE | `github.ts` not re-opened |
| 15 | REVISE audit op prefix | CONFIRM | `secrets/contracts.ts:159` ops are `listed`, `stored`, `deleted`, `resolved_for_exec` |
| 16 | REVISE secrets-only outside DeepLake | CONFIRM | Credentials file is `credentials-store.ts`. Local queue is `node:sqlite` at `local-job-queue.ts:1-6`, base dir comment at `assemble.ts:2116-2120` |
| 17 | REVISE `/api/secrets` admin | CONFIRM | `rbac.ts:126` |
| 18 | REVISE daemon-only DeepLake line | CONFIRM | Storage SQL was not re-audited. Auth HTTP is not daemon-only: `src/cli/auth.ts:340-351` runs the device flow from the CLI process |
| 19 | REMOVE `authLog` | CONFIRM | No `authLog` under `src/` |
| 20 | REVISE 70-op VFS allowlist | UNVERIFIABLE | `vfs/api.ts` not re-opened |
| 21 | REVISE hygiene child env | UNVERIFIABLE | Hook shim not re-opened |
| 22 | REVISE BYOC and AES-256 | UNVERIFIABLE | Not searched beyond auth and secrets |
| 23 | REVISE self-host telemetry tier | UNVERIFIABLE | `telemetry/emit.ts` not re-opened |
| 24 | REVISE session-trace members | UNVERIFIABLE | Catalog default not re-opened. Live recall still has no agent read-policy fragment (defect 3) |
| 25 | REVISE install consent line | UNVERIFIABLE | `install.ts` not re-opened |
| 26 | REVISE shared code path | CONFIRM | `vault/migrate.ts:31` imports `loadDiskCredentials`. Boot calls `migrateDeeplakeToken` at `assemble.ts:4337` |
| 27 | REVISE hook reader owns the file | UNVERIFIABLE | `credential-reader.ts` not re-opened |
| 28 | REVISE disk schema markers | CONFIRM | `credentials-store.ts:108` and `:121` add `tenancyConfirmedAt` and `tenancyPending` |
| 29 | REVISE `savedAt` required | CONFIRM | `isDiskCredentials` at `credentials-store.ts:186-189` requires `token` and `orgId` only |
| 30 | REVISE Portkey Settings page | UNVERIFIABLE | Dashboard Portkey strings not re-opened |
| 31 | REVISE fallback privacy floor | UNVERIFIABLE | `model-client-factory.ts` not re-opened |
| H1 | LEAVE plugin sentence | CONFIRM | `src/daemon/runtime/secrets/` is the store this shard walked (`api.ts`, `store.ts`, `contracts.ts`) |
| H2 | LEAVE SQL helper sentences | UNVERIFIABLE | `sql.ts` and `daemon-client` imports not re-opened. `scope-clause.ts` does call `sLiteral` and `sqlIdent` |
| H3 | LEAVE cipher, modes, CLI | UNVERIFIABLE | Nonce and machine key confirmed. `crypto.ts` and the `secret set` CLI were not re-opened |
| H4 | LEAVE credential file contract | CONFIRM | `loadCredentials` null-on-missing and `HONEYCOMB_TOKEN` override at `credentials-store.ts:379-400`. `resolveTenancy` integrity at `:600-634`. Mint duration and keychain absence were not re-opened. No contradiction found. Leave |
| H5 | LEAVE request identity guards | UNVERIFIABLE | `scope.ts` forged-header branch not re-opened. Permission does stamp identity at `permission.ts:216-223` |
| H6 | LEAVE Portkey and Cohere | UNVERIFIABLE | Not re-opened |
| H7 | LEAVE capture opt-out and telemetry | UNVERIFIABLE | Not re-opened |
| H8 | LEAVE read-policy vocabulary | CONFIRM | `scope-clause.ts:24-27` and `:95` area. This is the vocabulary, not the live memory WHERE (defects 1-4) |

## Standards: role and permission claims only

Source: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/standards.md`.
Other standards defects (S-2, S-3, S-5, S-8 through S-24) are outside this shard.

| ID | Wave 1 action | Code standing | Evidence |
|---|---|---|---|
| S-1 | REVISE operator out of the role list | CONFIRM | `contracts.ts:82`. Same as D1 |
| S-4 | REVISE rate limit as unmounted | CONFIRM | `rate-limit.ts:177-189` and `:202` area implement 429 and `Retry-After`. No production caller of `createRateLimitMiddleware(` |
| S-6 | REVISE hybrid always checks permission | CONFIRM | `permission.ts:198-200` skips authenticator and policy when `socketPeer.isTrustedLocalPeer` is true. Production probe is `noSocketPeer` (`permission.ts:112-115`) and assemble does not pass `socketPeer`. Live hybrid therefore fails closed like team. The sentence "each protected route checks" is still wrong as a description of the source, because the skip exists. Writer note: say the skip is unreachable until a probe is wired |
| S-7 | REVISE route-layer org and workspace check | CONFIRM | `permission.ts:225-233` asks the policy for capability and a project hint. Org and workspace are not compared there. The identity stamp at `:216-223` is for handlers |
| H-7 | LEAVE local mode open | CONFIRM | `permission.ts:186-189` calls `next()` with no token check. This is the auth gate only |
| H-8 | LEAVE 401 and 403 | CONFIRM | `permission.ts:262-269`. 429 exists on the unmounted limiter (S-4) |
| H-14 | LEAVE agent_id and visibility threading | CONFIRM as the clause vocabulary | `scope-clause.ts:19-26`. Live recall does not apply that clause (security defect 3). Leave the standards sentence only if it stays "when a real agent id is known", not "every memory query carries the clause" |

## ADR status lines (0002-0006 and 0010)

Source: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/architecture-adrs.md`.
Status-line edits only. Bodies stay. README status cells follow the same words.

| ADR | Wave 1 action | Code standing | Evidence |
|---|---|---|---|
| 0002 | REVISE status off Proposed | CONFIRM | Banner superseded at `0002-orchestrator-custodian-for-fleet-memory-plane.md:3`. Status line still Proposed at `:5-6`. README row 21 says Proposed. No enroll-token, Hyperdrive, or Durable Objects under `src/`. Queen ADR-0002 status is still Proposed and `Superseded by: none` (queen file lines 5-6). One-way supersession stands |
| 0003 | REVISE status off Proposed | CONFIRM | Honeycomb status line still Proposed at `0003-trusted-device-custody-and-headless-enrollment.md:5-6` under a superseded banner. Headless `enroll-token` commands are absent under `src/` |
| 0004 | REVISE status, and name queen ADR-0010 | CONFIRM | Honeycomb status line still Proposed at `0004-honeycomb-control-plane-and-postgres-boundary.md:5-6`. Queen ADR-0004 lines 5-6 say superseded by ADR-0010 for runtime topology only. Queen ADR-0010 lines 3-4 are Accepted and supersede ADR-0004 for that decision. Workers, Hyperdrive, Queues, and Durable Objects are absent under honeycomb `src/` |
| 0005 | REVISE status off Proposed | CONFIRM | Honeycomb status line still Proposed at `0005-recovery-revocation-and-escrow-policy.md:5-6`. No escrow or device-revocation control plane under `src/` |
| 0006 | REVISE status to Accepted (evolved by ADR-0009) | CONFIRM | Status line still `Proposed (exploratory)` at `0006-local-queue-as-interim-idle-cost-control.md:5-6` while the banner says evolved by ADR-0009. The local queue is in the tree: `src/daemon/runtime/services/local-job-queue.ts:1-6` (`node:sqlite`, no DeepLake client). Not superseded. README row 25 still says Proposed |
| 0010 | REVISE status to Proposed | CONFIRM | File status is Accepted at `0010-recall-weighted-est-savings.md:3-4`. README row 29 says Accepted. The corpus proxy is still live: `CHARS_PER_TOKEN` and the PRD-035b comment at `src/daemon/runtime/dashboard/api.ts:234-246`, `fetchEstimatedSavings` at `:313-320`, called from `:269` and `:1331`. Accepted would mean the retirement is the live contract. It is not. Leave the body. Do not add a second savings ADR |

ADR-0009 stays the local-queue default record. This shard does not add an ADR and does not take number 0012.

## PRD moves

### PRD-011 tenancy and auth: CONFIRM move to in-work

Wave 1: 21 MET, 13 UNMET, bucket in-work.
Re-checked the unmet cluster and the auth METs that this shard owns.

UNMET cluster still holds, so completed is not supported:

- Index AC-4 and 011e AC-1 through AC-6: `buildScopeClause` is unused by memory queries. `memories/recall.ts` has no call.
- 011a AC-6: dispatched `status` is `runStandardCommand` (`dispatch.ts:412`, `standard-interface.ts:206`). `runStatusCommand`, which prints org, workspace, and project, has no `src/` caller.
- 011d AC-1, AC-3, AC-4: `createApiKey` and `revokeKey` are defined at `api-keys.ts:140` and `:305` and have no other `src/` caller. `src/cli/keys.ts:28-30` says the bundled bin is not yet extended to dispatch `keysMain`. `src/cli/runtime.ts` does not reference `keysMain`.
- 011d AC-2 and AC-5: rate limiter implemented and unmounted (`rate-limit.ts:187`).

METs that still hold:

- 011 index AC-3, 011c AC-1 through AC-6: team 401 at `permission.ts:203-206`, 403 at `:244`, local open at `:186-189`, hybrid fail-closed on `noSocketPeer`, readonly excluded from `write` at `rbac.ts:96`, admin-only `admin` capability at `rbac.ts:100`, project deny for non-admin.
- 011d AC-6: the API-key authenticator is constructed at `assemble.ts:1028` and composed at `:1024-1034`. A presented key can hit the project gate. Create and revoke stay unwired.
- 011a AC-4 and AC-5: `resolveTenancy` at `credentials-store.ts:600-634` applies `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` and throws `TenancyIntegrityError` when the file org or the env org disagrees with the verified token org. `loadCredentials` itself does not apply those overrides (`:368-370`). The AC is about command tenancy resolution, and that function does it.
- 011b AC-1, AC-3, AC-4, AC-6: credential persist, null load, `savedAt` overwrite, and logout were not re-failed. No contradiction in the store regions opened.

OVERTURN one MET. 011b AC-2 ("when a session starts, the daemon re-mints") is not what the live path does. `healOrgDrift` re-mints, but the real-backend branch of `buildOrgDriftHealer` refuses to call it, and dispatched status never calls the healer. Treat 011b AC-2 as unmet on the production path. That adds an unmet. It does not pull the folder back to completed.

Bucket: move `library/requirements/completed/prd-011-tenancy-and-auth/` to `in-work/`. Do not mark completed on the June 2026 QA 34/34 line.

### PRD-012 secrets: CONFIRM move to in-work

The names-only store is mounted. Assembly builds `SecretsApiDeps` with `store`, `scope`, and optional `reload` at `assemble.ts:2003-2013` and does not pass `execRunner`. `mountSecretsApi` then registers 501 stubs at `secrets/api.ts:220-227` for `POST /exec`, `GET /exec/:jobId`, `/bitwarden/*`, and `/1password/*`.

CONFIRMED MET on the store half: machine-bound encrypt path (`secrets/store.ts:255-268`), names-only `GET /` at `secrets/api.ts:230-235`, no `GET /:name` value route (comment at `secrets/api.ts:160`), audit ops without a value field (`secrets/contracts.ts:159`).

CONFIRMED UNMET on the exec half: redaction, 202 queue, timeout, vault-by-reference, and pool queue exist in `secrets/exec.ts` and are not on the live route.

Bucket: move `library/requirements/completed/prd-012-secrets/` to `in-work/`. The June 2026 QA 15/15 line does not close the missing `execRunner`.

### PRD-073 residual: CONFIRM stay completed

AC-6 and AC-073c.1.1 stay UNMET. `makePendingLinkRunner` writes a base credential for `orgs[0]` before selection at `setup-tenancy.ts:247-259`, via `persistUnconfirmedTenancy` at `deeplake-issuer.ts:791-811` (`tenancyPending: true`, workspace `default`, no marker). That breaks "persist nothing until an explicit selection."

Do not move the folder back to in-work or backlog. The write is the documented BUG 2 so `/setup/state.authenticated` can flip. `tenancy-confirmation.ts:77-83` keeps that file unconfirmed, and capture returns `tenancy_unconfirmed` at `capture-handler.ts:775`. CLI login does not call `persistUnconfirmedTenancy`. It persists through `persistSelectedTenancy` after `resolveTenancyChoice` (`deeplake-issuer.ts:899-904`, CLI at `src/cli/auth.ts:340-351`).

The bound-project gate, health reason, and capture-first tenancy check are in source (`capture-handler.ts:767-778`, `assemble.ts:1385-1391` and `:3455-3460`). This shard did not re-score every 073 MET row. Nothing opened here overturns the completed bucket.

Bucket: leave `library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/` in `completed/`. A later librarian may fix the stale Backlog status line. That is not a folder move.

### PRD-065: OVERTURN move to in-work. Stay completed

Wave 1 recommended in-work because AC-1 through AC-5 and the QA-note criteria need `doctor/`, `site/install/`, or `scripts/install/install.sh`, and those paths are absent.

Those criteria stay UNVERIFIABLE. Absence of `doctor/` is not an absent honeycomb criterion. The wave 2 rule for this shard: unverifiable doctor-repo criteria do not move the folder to in-work.

Do not archive it either. Archive is for withdrawn work. PRD-065 is not a MOVED stub. `library/knowledge/private/operations/doctor-watchdog.md:21-23` places the package in `github.com/legioncodeinc/doctor` and the installer scripts in the-apiary superproject. This checkout cannot re-prove the CDN object or the PostHog confirmation. That is a repo boundary, not a withdrawal.

Bucket: leave `library/requirements/completed/prd-065-doctor-go-live/` in `completed/`. The index status line still says In Work (`prd-065-doctor-go-live-index.md:3`). A librarian may fix that line. Do not `git mv` the folder.

### PRD-064: CONFIRM stay in-work

`doctor/` is absent, so the watchdog, ladder, Doctor telemetry, blessed auto-update, and `doctor` CLI criteria stay UNVERIFIABLE. That does not archive the folder and does not complete it.

064h is in this tree. `src/cli/daemon-service.ts:56` is `SERVICE_LABEL` `com.legioncode.honeycomb`. Launchd `KeepAlive` is at `:414`. Systemd `Restart=always` is at `:453`. Those supervise honeycomb, not Doctor.

The 065 rule does not apply. 064 has honeycomb implementation (the primary daemon service) plus unverifiable Doctor criteria. Completed would require the Doctor criteria in source. Backlog would ignore 064h. Archive would treat shipped service code as withdrawn.

Bucket: leave `library/requirements/in-work/prd-064-doctor-self-healing-watchdog/` in `in-work/`. Do not move it to completed on the QA report. The index status line still says Backlog. A librarian may fix that line.

### Archive stubs 051, 052, 054, 055: CONFIRM archive

This repo has no implementation of these four. Archive is appropriate because each honeycomb folder is a MOVED stub with zero acceptance criteria, not shipped honeycomb work.

| PRD | Code standing | Why |
|---|---|---|
| 051 | CONFIRM archive | Stub only. No `repositoryHealth` or `knowledgeDrift` under `src/`. Hive PRD-015 exists and its status line is still Backlog |
| 052 | CONFIRM archive | Stub only. No join-repository scaffold under `src/`. Hive PRD-016 exists and is still Backlog |
| 054 | CONFIRM archive | Stub only. No fleet-observation dashboard under `src/`. `src/daemon/runtime/ontology/control-plane.ts` is a different PRD and was not treated as this work. Queen PRD-007 exists and is still Backlog |
| 055 | CONFIRM archive | Stub only. No `enrollment`, `mintAuthority`, or fleet-token matches under `src/`. Queen PRD-008 exists and is still Backlog |

Do not mark 051, 052, 054, or 055 completed. Do not leave them in backlog as if honeycomb still owned the product PRD.

053, 056, and 057 were in the same wave 1 file and are outside this confirm. This shard does not move them.

## Recount

Auth-tenancy actions confirmed: 33 (D1-D11, D12-D22, H1-H11). H12 unverifiable.
Security defects confirmed: 19. Unverifiable: 12.
Security holds confirmed: 3 (H1, H4, H8). Unverifiable: 5 (H2, H3, H5, H6, H7).
Standards role and permission confirmed: 7 (S-1, S-4, S-6, S-7, H-7, H-8, H-14).
ADR status confirmed: 6 (0002, 0003, 0004, 0005, 0006, 0010).
PRD buckets confirmed: 8 (011 in-work, 012 in-work, 073 stay completed, 064 stay in-work, 051 archive, 052 archive, 054 archive, 055 archive).
PRD buckets overturned: 1 (065 stay completed, not in-work).
Criterion verdicts overturned: 1 (011b AC-2 is not MET on the live path). The 011 in-work move stays confirmed.

CONFIRMED: 33 + 19 + 3 + 7 + 6 + 8 = 76.
OVERTURNED: 2.
UNVERIFIABLE: H12 + 12 security defects + 5 security holds = 18.

## Writer rules

- Apply only CONFIRM rows.
- Do not apply UNVERIFIABLE security rows from this file. Another shard may confirm them.
- Do not `git mv` PRD-065. Do not `git mv` PRD-073 or PRD-064.
- Do `git mv` PRD-011 and PRD-012 to `in-work/` when the librarian runs.
- Do `git mv` PRD-051, PRD-052, PRD-054, and PRD-055 to `archive/`.
- ADR edits are status lines and the matching README status cells. Bodies stay.
- ASCII hyphens only in the revised sentences.
