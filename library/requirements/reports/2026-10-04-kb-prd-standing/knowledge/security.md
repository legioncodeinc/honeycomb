# Security knowledge standing (Wave 1a)

Shard: `library/knowledge/private/security/` only. Branch `legion/kb-sotu-and-prd-lifecycle`. Working tree read. No source or knowledge edits in this pass.

Uncommitted and kept as the text under test:

- `library/knowledge/private/security/secrets.md` (plugin path sentence)
- `library/knowledge/private/security/trust-boundaries.md` (two SQL-helper sentences)

Those two sentences match the tree. Later writers should leave them. Do not revert the dirty files.

No security page should be removed. No new security page is warranted. Every page below stays, and six of six need a revision. Sibling links in the Related blocks resolve to files that exist.

Defect count: 31 (FALSE, STALE, or HOLE). Holds are listed after the defects so a later pass does not undo them.

## Coverage

| File | Page action | Why |
|---|---|---|
| `library/knowledge/private/security/scoping-and-visibility.md` | REVISE | Sample SQL still excludes `visibility != 'archived'`. Live recall uses `is_deleted = 0` and does not call `buildScopeClause`. Project scope is missing. |
| `library/knowledge/private/security/secrets.md` | REVISE | Vault path, cipher, CLI, and the working-tree plugin sentence hold. Key fallback, on-disk nonce, live token precedence, and external vaults do not. |
| `library/knowledge/private/security/trust-boundaries.md` | REVISE | Daemon storage chokepoint and the working-tree SQL sentences hold. `authLog`, the 70-op VFS allowlist, BYOC, and the self-host telemetry special case do not. |
| `library/knowledge/private/security/credential-storage.md` | REVISE | Shared `~/.deeplake/credentials.json` contract holds. "Only this module touches the file" and the disk schema are incomplete. |
| `library/knowledge/private/security/request-identity-validation.md` | REVISE | The three guards and their tests match. The org reader is not the single parser. |
| `library/knowledge/private/security/portkey-privacy-tier.md` | REVISE | Public-tier bypass and Cohere rerank egress match. The Settings-page sentence and the fallback advice do not. |

## Defects

### 1. Archived exclusion is `is_deleted = 0`

- Quote: "AND m.agent_id = '<id>' AND m.visibility != 'archived'" (same predicate on the shared and group samples)
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:51` and `:54` and `:60`
- Grounding: `src/daemon/runtime/recall/scope-clause.ts:30` and `:171` through `:176` (`is_deleted = 0`). Catalog column `src/daemon/storage/catalog/memories.ts:74`. A search of `src/` for the visibility token `archived` hits only the comment in `scope-clause.ts:30`.
- Verdict: FALSE
- Action: REVISE

### 2. Group policy is not a roster subquery

- Quote: "m.agent_id IN (SELECT id FROM \"agents\" WHERE policy_group = '<group>')"
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:57` through `:59`
- Grounding: `src/daemon/runtime/recall/scope-clause.ts:33` through `:38` and `:247` through `:263`. The builder renders a caller-supplied `groupAgentIds` IN-list. An empty member list degrades to own-only (`:249` through `:257`).
- Verdict: FALSE
- Action: REVISE

### 3. Live memory queries do not carry `buildScopeClause`

- Quote: "The inner ring is compiled into a SQL clause that every memory query carries"
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:45`
- Grounding: `src/daemon/runtime/recall/collection.ts:129` through `:134` ("The agent READ-POLICY clause is NOT applied here"). Live lexical SQL is `src/daemon/runtime/memories/recall.ts:573` through `:591` (`is_deleted = 0` plus an optional project clause, no read-policy fragment). `buildScopeClause` is defined at `src/daemon/runtime/recall/scope-clause.ts:205` and re-exported from `src/daemon/runtime/recall/index.ts`. No other file under `src/` calls it. Callers are tests, including `tests/daemon/runtime/auth/scope-clause-policy.test.ts:11` through `:17`, which records that the five-phase engine was removed.
- Verdict: FALSE
- Action: REVISE

### 4. Recall does not authorize IDs with that clause before content loads

- Quote: "those channels produce memory IDs only, and the scope clause authorizes candidates before any content loads"
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:67`
- Grounding: `src/daemon/runtime/memories/recall.ts:587` through `:590` selects `content` as `text` in the same statement as the match. That statement has no `buildScopeClause` fragment.
- Verdict: FALSE
- Action: REVISE

### 5. Project scope is a third predicate

- Quote: "Honeycomb scopes memory in two rings."
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:20`
- Grounding: `src/daemon/runtime/recall/scope-clause.ts:271` through `:338` (`buildProjectScopeClause`). Live recall ANDs it in `src/daemon/runtime/memories/recall.ts:585` through `:590`.
- Verdict: HOLE
- Action: REVISE

### 6. Agent id resolution is not a daemon OpenClaw parser

- Quote: "The daemon resolves it from an explicit field, then from a harness session key (OpenClaw's `agent:alice:...` form parses automatically), then defaults to `'default'`."
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:31`
- Grounding: `src/hooks/openclaw/shim.ts:84` through `:88` parses `agent:<name>:` in the hook shim. Daemon header fallback is `src/daemon/runtime/ontology/api.ts:179` through `:182` and `src/daemon/runtime/vfs/api.ts:129` through `:132` (header, else `default`). Live `buildMemoriesArmSql` does not apply either step.
- Verdict: STALE
- Action: REVISE

### 7. Fail-closed on the builder is not the live recall posture

- Quote: "A malformed caller falls back to `isolated` instead of widening access. ... Errors are not swallowed"
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:80` through `:81`
- Grounding: `src/daemon/runtime/recall/scope-clause.ts:105` through `:109` and `:210` through `:230` attach a `ScopeClauseError` and still return isolated SQL. Live recall does not call the builder (defect 3). `src/daemon/runtime/recall/collection.ts:132` through `:138` maps a blank agent id to `'default'`.
- Verdict: STALE
- Action: REVISE

### 8. ROI `shared` is workspace-wide, not the memory visibility predicate

- Quote: "`shared` | workspace-global memories plus its own"
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:40`
- Grounding: the unused memory builder does match that row at `src/daemon/runtime/recall/scope-clause.ts:240` through `:244`. The live ledger sibling does not: `src/daemon/runtime/dashboard/roi-ledger.ts:347` through `:356` renders `shared` as `'1' = '1'` and degrades `group` to own-only.
- Verdict: STALE
- Action: REVISE

### 9. Machine-key fallback is a key file, then hostname

- Quote: "derived from a machine-bound identifier (`/etc/machine-id` on Linux, `IOPlatformUUID` on macOS, with a hostname-plus-username fallback)"
- Doc: `library/knowledge/private/security/secrets.md:26`
- Grounding: `src/daemon/runtime/secrets/store.ts:131` through `:165` reads Linux `/etc/machine-id` then `/var/lib/dbus/machine-id`, macOS `IOPlatformUUID`, and Windows `MachineGuid`. `src/daemon/runtime/secrets/store.ts:201` through `:212` falls back to `~/.apiary/honeycomb/.machine-key` (`:114` through `:116`), and only then to `hostnameUserFallbackId` (`src/daemon/runtime/secrets/contracts.ts:232` through `:244`).
- Verdict: STALE
- Action: REVISE

### 10. Nonce is a sibling field, not a prefix

- Quote: "Each value gets a random nonce prepended to its ciphertext."
- Doc: `library/knowledge/private/security/secrets.md:26`
- Grounding: `src/daemon/runtime/secrets/contracts.ts:11` through `:12` and `src/daemon/runtime/secrets/store.ts:250` through `:266`. On-disk record is `{ nonce, ciphertext, createdAt, scope }`.
- Verdict: FALSE
- Action: REVISE

### 11. An unwritable workspace does not pin secret writes

- Quote: "A daemon that comes up pinned to an unwritable directory makes every secret write fail with a `502 store_failed`"
- Doc: `library/knowledge/private/security/secrets.md:26`
- Grounding: `src/daemon/runtime/secrets/api.ts:252` returns 502 `store_failed` when `setSecret` fails. The vault base is `resolveVaultBaseDir` at `src/daemon/runtime/assemble.ts:2112` through `:2113`, which returns `honeycombStateDir()`. The cwd fallback lives on `workspaceBaseDirCandidate` at `src/daemon/runtime/assemble.ts:2071` through `:2074` and is not the vault base (`:2099` through `:2110`).
- Verdict: STALE
- Action: REVISE

### 12. Vault-then-env-then-file is not the live login path

- Quote: "Token resolution then follows a fixed precedence, vault, env, plaintext file"
- Doc: `library/knowledge/private/security/secrets.md:55`
- Grounding: `src/daemon/runtime/vault/migrate.ts:97` through `:120`. The copy into `DEEPLAKE_TOKEN` is real (`:78` through `:94`) and writes only the vault. `resolveDeeplakeToken` is documented there as staged and not wired to the live connection. The only call sites are `tests/daemon/runtime/vault/vault.test.ts`. Live storage still uses `loadDiskCredentials` (`src/daemon/storage/config.ts:159`).
- Verdict: FALSE
- Action: REVISE

### 13. Bitwarden and 1Password routes do not pull vault items

- Quote: "the subsystem can pull from external secret managers, with routes under `/api/secrets/bitwarden/*` and `/api/secrets/1password/*`. These let a workspace reference items in an existing vault"
- Doc: `library/knowledge/private/security/secrets.md:101`
- Grounding: `src/daemon/runtime/secrets/api.ts:211` through `:227`. With an exec runner the routes return 400 `use_exec`. Without one they return 501. `src/daemon/runtime/secrets/exec.ts:372` through `:373` defaults the vault seam to a reject-every-ref provider.
- Verdict: FALSE
- Action: REVISE

### 14. GitHub token host is the configured host

- Quote: "Git sync resolves a `GITHUB_TOKEN` for `github.com` only and never injects it into a non-GitHub remote."
- Doc: `library/knowledge/private/security/secrets.md:104`
- Grounding: `src/daemon/runtime/sources/providers/github.ts:60` through `:94` (`githubTokenForRemote`). Default host is `github.com`. A configured GitHub host, including Enterprise, also receives the token. `src/daemon/runtime/services/git-sync.ts` is the workspace auto-commit path and does not resolve `GITHUB_TOKEN`.
- Verdict: STALE
- Action: REVISE

### 15. Audit op names have no `secret.` prefix

- Quote: "The audit log for secret operations (`secret.listed`, `secret.stored`, `secret.resolved_for_exec`, `secret.exec_started`, and so on)"
- Doc: `library/knowledge/private/security/secrets.md:104`
- Grounding: `src/daemon/runtime/secrets/contracts.ts:159` (`listed`, `stored`, `deleted`, `resolved_for_exec`). Exec ops at `src/daemon/runtime/secrets/exec.ts:182`. The NDJSON file is `secrets-audit.ndjson` under `.daemon/` relative to the vault base (`src/daemon/runtime/secrets/store.ts:75` through `:78` and `:398` through `:410`).
- Verdict: STALE
- Action: REVISE

### 16. Secrets are not the only data outside DeepLake

- Quote: "Secrets are the one class of data that does not live in DeepLake"
- Doc: `library/knowledge/private/security/secrets.md:17`
- Grounding: the device-flow file is `src/daemon/runtime/auth/credentials-store.ts:6`. The local job queue is SQLite under the fleet state root (`src/daemon/runtime/assemble.ts:2116` through `:2129`). Operator telemetry has its own SQLite store (`src/daemon/runtime/telemetry/fleet-store.ts`).
- Verdict: FALSE
- Action: REVISE

### 17. `/api/secrets` is an admin route

- Quote: "An agent cannot read a value through the API" (the route table does not say who may call it)
- Doc: `library/knowledge/private/security/secrets.md:63` through `:71`
- Grounding: `src/daemon/runtime/auth/rbac.ts:126` maps `/api/secrets` to capability `admin`. Roles are `admin`, `member`, `readonly`, `agent` at `src/daemon/runtime/auth/contracts.ts:82`.
- Verdict: HOLE
- Action: REVISE

### 18. The CLI dials the DeepLake API

- Quote: "no process other than the daemon has a line into DeepLake" and "Only the daemon makes the network call to the backend"
- Doc: `library/knowledge/private/security/trust-boundaries.md:39` and `:95`
- Grounding: storage SQL stays on the daemon. Auth HTTP does not. `src/cli/auth.ts:4` through `:8`, `src/cli/whoami.ts:4`, and `src/cli/org.ts:5` dial `api.deeplake.ai` from the CLI process.
- Verdict: STALE
- Action: REVISE

### 19. `authLog` is absent

- Quote: "`authLog` writes to `process.stderr`, not `stdout`"
- Doc: `library/knowledge/private/security/trust-boundaries.md:96`
- Grounding: ABSENT. A repo search for `authLog` hits this page and an unrelated `authLogin` mention in a PRD. Hook stderr writes exist (`src/hooks/shared/daemon-client.ts:141`) under other names.
- Verdict: FALSE
- Action: REMOVE

### 20. VFS is five read routes, not a 70-op allowlist

- Quote: "Commands routed through this layer are matched against an allowlist of approximately 70 built-in operations. Any command not on the allowlist is denied with an error."
- Doc: `library/knowledge/private/security/trust-boundaries.md:119`
- Grounding: `src/daemon/runtime/vfs/api.ts:13` through `:28` mounts cat, grep, ls, find, classify, and a write-deny (405). No command allowlist of about 70 exists under `src/daemon/runtime/vfs/` or `src/daemon-client/vfs/`.
- Verdict: FALSE
- Action: REVISE

### 21. A hygiene child inherits the parent env

- Quote: "It is never passed as a command-line argument ... or written to `process.env` (visible to child processes)."
- Doc: `library/knowledge/private/security/trust-boundaries.md:94`
- Grounding: the hook reader does not assign the file token into `process.env` (`src/hooks/shared/credential-reader.ts:83` through `:102`). `src/hooks/claude-code/shim.ts:301` through `:305` spawns the hygiene child with `env: { ...process.env, ... }`, so an existing `HONEYCOMB_TOKEN` is inherited.
- Verdict: STALE
- Action: REVISE

### 22. BYOC and AES-256 are not in this tree

- Quote: "Org/Workspace Partition | ... AES-256 at rest" and the BYOC table (GCS, Azure, S3, creds in the DeepLake vault)
- Doc: `library/knowledge/private/security/trust-boundaries.md:53` and `:141` through `:152`
- Grounding: ABSENT. No `BYOC` or `AES-256` string under `src/`.
- Verdict: STALE
- Action: REVISE

### 23. Self-host does not get a special telemetry tier

- Quote: "A session against BYOC/self-hosted DeepLake defaults Tier-2 off (and Tier-1 minimal)"
- Doc: `library/knowledge/private/security/trust-boundaries.md:180`
- Grounding: ABSENT. Tier-2 is opt-in for every session at `src/daemon/runtime/telemetry/emit.ts:461` through `:464`. No self-host or BYOC branch under `src/daemon/runtime/telemetry/`.
- Verdict: FALSE
- Action: REVISE

### 24. Session-trace access is not "all workspace members"

- Quote: "Session traces (prompts, tool calls, responses) | ... | All members of the org workspace"
- Doc: `library/knowledge/private/security/trust-boundaries.md:192`
- Grounding: catalog default `read_policy` is `isolated` (`src/daemon/storage/catalog/tenancy.ts:75` through `:83`). Live recall filters org/workspace via `QueryScope` plus `project_id` (`src/daemon/runtime/memories/recall.ts:51` and `:585` through `:590`) and does not apply the agent read policy (defect 3).
- Verdict: STALE
- Action: REVISE

### 25. Install does not print a one-line consent notice

- Quote: "The install command (`honeycomb install`) displays a one-line consent notice before opening the browser for authentication." The platform table also states Codex "Trust all and continue", OpenClaw ClawHub approval, Hermes `config.yaml`, and pi `AGENTS.md` as the consent mechanisms.
- Doc: `library/knowledge/private/security/trust-boundaries.md:106` through `:113`
- Grounding: `src/commands/install.ts:444` prints "no credentials found; opening sign-in..." and then runs the device flow (`:389` through `:393`). ABSENT for the quoted host consent strings. Paths that do exist: Cursor `~/.cursor/hooks.json` at `src/connectors/cursor.ts:100` through `:102`, Claude marketplace install at `src/connectors/claude-code.ts:151` through `:152`, Codex `~/.codex/hooks.json` at `src/connectors/codex.ts:65` through `:67`.
- Verdict: STALE
- Action: REVISE

### 26. Credentials and the vault share a code path

- Quote: "They share neither a file nor a code path."
- Doc: `library/knowledge/private/security/credential-storage.md:21`
- Grounding: files stay separate. `src/daemon/runtime/vault/migrate.ts:29` through `:32` imports `loadDiskCredentials` and `migrateDeeplakeToken` copies the token into the vault (`:78` through `:94`). Boot calls it from `src/daemon/runtime/assemble.ts:4324` through `:4337`.
- Verdict: FALSE
- Action: REVISE

### 27. The hook reader opens the credentials file itself

- Quote: "The functions in `src/daemon/runtime/auth/credentials-store.ts` own all disk access. No other module reads or writes the credentials file directly."
- Doc: `library/knowledge/private/security/credential-storage.md:123`
- Grounding: `src/hooks/shared/credential-reader.ts:41` through `:46` and `:128` through `:155` read `~/.deeplake/credentials.json` with `readFileSync` and do not import the daemon store. `src/hooks/runtime.ts:232` uses that reader.
- Verdict: FALSE
- Action: REVISE

### 28. Disk schema omits tenancy markers

- Quote: the on-disk field table ends at `token`, `orgId`, `orgName`, `userName`, `workspaceId`, `apiUrl`, `agentId`, `savedAt`
- Doc: `library/knowledge/private/security/credential-storage.md:91` through `:100`
- Grounding: `src/daemon/runtime/auth/credentials-store.ts:100` through `:121` adds `tenancyConfirmedAt` and `tenancyPending`.
- Verdict: HOLE
- Action: REVISE

### 29. `savedAt` is not required on read

- Quote: "`savedAt` | `string` | yes | ... not validated at load time."
- Doc: `library/knowledge/private/security/credential-storage.md:100`
- Grounding: `src/daemon/runtime/auth/credentials-store.ts:186` through `:189`. `isDiskCredentials` requires `token` and `orgId` only. Writes stamp `savedAt` at `:496` through `:497`.
- Verdict: STALE
- Action: REVISE

### 30. Portkey has vault keys, not a Settings-page control in this tree

- Quote: "The toggle + key live in the Settings page (PRD-063a); routing is in `transport-portkey.ts` + the factory supersession (PRD-063b)."
- Doc: `library/knowledge/private/security/portkey-privacy-tier.md:58` through `:59`
- Grounding: keys are `src/daemon/runtime/vault/api.ts:97` through `:108` (`portkey.enabled`, `portkey.config`, `portkey.fallbackToProvider`). Routing is `src/daemon/runtime/inference/transport-portkey.ts:1` through `:10` and `src/daemon/runtime/inference/model-client-factory.ts:505` through `:513`. ABSENT: no `portkey` string under `src/dashboard/`. `SettingsView` is org, workspace, and a generic map (`src/dashboard/contracts.ts:104` through `:114`).
- Verdict: STALE
- Action: REVISE

### 31. Leaving fallback off does not restore the privacy floor

- Quote: "If you require Honeycomb-side enforcement of a privacy floor, do NOT enable Portkey, or keep `portkey.fallbackToProvider` off and use the per-provider path whose tier the router enforces."
- Doc: `library/knowledge/private/security/portkey-privacy-tier.md:34` through `:35`
- Grounding: `src/daemon/runtime/inference/model-client-factory.ts:505` through `:513` stamps `privacyTier: "public"` whenever the Portkey config is built. `fallbackToProvider` defaults false at `src/daemon/runtime/assemble.ts:2271` and only selects the provider client when the gateway is unreachable (`src/daemon/runtime/inference/model-client-factory.ts:453` area and `:484`). While `portkey.enabled` is true and the gateway answers, the floor stays bypassed.
- Verdict: STALE
- Action: REVISE

## Holds

These matched the working tree. Action LEAVE.

### H1. Working-tree plugin sentence

- Quote: "Secrets live in `src/daemon/runtime/secrets/`. There is no `plugins/core/secrets` tree in this checkout."
- Doc: `library/knowledge/private/security/secrets.md:22`
- Grounding: `src/daemon/runtime/secrets/` exists (`api.ts`, `store.ts`, `crypto.ts`, `exec.ts`). Glob for `plugins/core/secrets` returned no files.
- Verdict: HOLDS
- Action: LEAVE

### H2. Working-tree SQL helper sentences

- Quote: "SQL helpers live in `src/daemon/storage/sql.ts`. The daemon is the DeepLake client. `src/daemon-client` can build SQL strings with those helpers and still has no DeepLake transport handle." And: "`src/daemon-client` imports those helpers for VFS and skillify SQL. The DeepLake transport client is still constructed in the daemon."
- Doc: `library/knowledge/private/security/trust-boundaries.md:65` and `:126`
- Grounding: `src/daemon/storage/sql.ts:42`, `:77`, `:100`, `:132` (`sqlStr`, `sqlLike`, `sqlIdent`, `sLiteral`). `src/daemon-client/vfs/read.ts:21` and `src/daemon-client/vfs/write-buffer.ts:48` and `src/daemon-client/skillify/pull-client.ts:21` import those helpers. No `src/daemon-client` import of `daemon/storage/transport` or `createStorageClient`. VFS SQL uses `sLiteral` and `eLiteral` more often than a raw `sqlStr` call. The helper names in the doc exist.
- Verdict: HOLDS
- Action: LEAVE

### H3. Vault root, cipher, modes, CLI, exec bounds, copy-not-move

- Quote: fleet state root `~/.apiary/honeycomb/` via `src/shared/fleet-root.ts`; XSalsa20-Poly1305 via `@noble/ciphers`; modes 0600/0700; classes `secret` and `setting`; `.secrets/<scope>/<name>` vs `.vault/<class>/<scope>/<name>`; no SQLite vault; `secret set` maps to `POST /api/secrets/<name>`; exec timeout 5 minutes default, 30 max; migration copies `DEEPLAKE_TOKEN` and does not rewrite `~/.deeplake`.
- Doc: `library/knowledge/private/security/secrets.md:26`, `:32` through `:43`, `:75` through `:81`, `:87`
- Grounding: `src/shared/fleet-root.ts:78` through `:104`; `src/daemon/runtime/assemble.ts:1998` through `:2004` and `:2112`; `src/daemon/runtime/secrets/crypto.ts:29` and `:57` through `:65`; `src/daemon/runtime/secrets/store.ts:69` through `:71`; `src/daemon/runtime/vault/registry.ts:42` through `:45` and `:67` through `:78`; `src/daemon/runtime/vault/store.ts:20` through `:26`; `src/daemon/runtime/vault/api.ts:97` through `:108`; `src/commands/storage-handlers.ts:120` through `:141`; `src/daemon/runtime/secrets/exec.ts:55` through `:57` and `:16`; `src/daemon/runtime/secrets/api.ts:12` through `:13` (no `GET /api/secrets/:name`); `src/daemon/runtime/vault/migrate.ts:6` through `:18`.
- Verdict: HOLDS
- Action: LEAVE

### H4. Credential file contract

- Quote: shared `~/.deeplake/credentials.json`, legacy `~/.honeycomb` read fallback, three probed dirs including `~/.hivemind`, modes 0700/0600, `loadCredentials` null on missing, `HONEYCOMB_TOKEN` overrides the file token when a file loads, `resolveTenancy` rejects an org mismatch, 365-day mint, default API `https://api.deeplake.ai`, no OS keychain.
- Doc: `library/knowledge/private/security/credential-storage.md:29` through `:39`, `:46` through `:52`, `:63` through `:67`, `:76` through `:79`, `:125` through `:139`, `:150`
- Grounding: `src/daemon/runtime/auth/credentials-store.ts:66` through `:73`, `:127` through `:129`, `:270`, `:379` through `:400`, `:564` through `:627`; `src/daemon/runtime/dashboard/setup-state.ts:167` through `:172`; `src/daemon/runtime/auth/deeplake-issuer.ts:201`; `src/hooks/shared/credential-reader.ts:51` through `:55` and `:77` through `:86`. Keychain search under `src/` returned no matches.
- Verdict: HOLDS
- Action: LEAVE

### H5. Request identity guards

- Quote: forged `x-honeycomb-org` returns null; authenticated workspace comes from `identity.workspace`; `isAuthorizedForResolvedProject` allows local mode, `admin`, and an unbound project, and 403s on a project mismatch.
- Doc: `library/knowledge/private/security/request-identity-validation.md:47` through `:78` and `:99` through `:104`
- Grounding: `src/daemon/runtime/scope.ts:157` through `:171`; `src/daemon/runtime/capture/capture-handler.ts:437` through `:450`; `src/daemon/runtime/memories/api.ts:488` through `:494` and `:714` through `:723`. Copies of the project guard: `src/daemon/runtime/dashboard/api.ts:1275`, `src/daemon/runtime/product/api.ts:110`, `src/daemon/runtime/vfs/api.ts:172`. Tests exist: `tests/daemon/runtime/scope-cross-workspace.test.ts`, `tests/daemon/runtime/capture/capture-cross-tenant-guard.test.ts`, `tests/daemon/runtime/memories/project-scope-cwd-bypass.test.ts`, `tests/daemon/runtime/secrets/api.test.ts`, `tests/daemon/runtime/sources/api.test.ts`. `getRequestIdentity` is `src/daemon/runtime/middleware/permission.ts:75`.
- Verdict: HOLDS
- Action: LEAVE

### H6. Portkey public tier and Cohere rerank

- Quote: `buildPortkeyConfig` stamps `privacyTier: "public"`; Cohere rerank sends the query plus fused candidate texts only when strategy is `cohere` and the gateway is on; default reranker is `none`; failures keep RRF order; local `embedding-cosine` does not egress.
- Doc: `library/knowledge/private/security/portkey-privacy-tier.md:39` through `:57`
- Grounding: `src/daemon/runtime/inference/model-client-factory.ts:505` through `:513`; `src/daemon/runtime/recall/config.ts:85` and `:223` through `:231`; `src/daemon/runtime/memories/recall.ts:1818` through `:1824` and `:1916`; `src/daemon/runtime/recall/rerank-portkey.ts:1` through `:7` and `:151` through `:156`.
- Verdict: HOLDS
- Action: LEAVE

### H7. Capture opt-out and the telemetry chokepoint

- Quote: `HONEYCOMB_CAPTURE=false` skips table ensure and the placeholder write, and recall still renders. Telemetry leaves through `emitTelemetry`, `DO_NOT_TRACK=1` or `HONEYCOMB_TELEMETRY=0` silences it, Tier-2 is opt-in, and `honeycomb telemetry --show` renders the glass box.
- Doc: `library/knowledge/private/security/trust-boundaries.md:157` through `:178`
- Grounding: `src/hooks/shared/session-start.ts:173` through `:201`; `src/shared/capture-gate.ts:25` and `:125`; `src/daemon/runtime/telemetry/emit.ts:95` through `:98`, `:191` through `:218`, and `:461` through `:464`; `src/daemon/runtime/telemetry/glass-box.ts:139` through `:148`. Daemon bind is `src/shared/constants.ts:14` through `:17` (`127.0.0.1:3850`).
- Verdict: HOLDS
- Action: LEAVE

### H8. Read-policy vocabulary still exists on the agents roster

- Quote: "`isolated` (fail-closed default)", "`shared`", "`group`"
- Doc: `library/knowledge/private/security/scoping-and-visibility.md:39` through `:41`
- Grounding: `src/daemon/storage/catalog/tenancy.ts:67` through `:84`. The builder implements the same three names at `src/daemon/runtime/recall/scope-clause.ts:95`. This holds as the roster vocabulary. It does not hold as the live memory-recall WHERE clause (defects 1 through 4 and 8).
- Verdict: HOLDS
- Action: LEAVE

## Files read

Knowledge:

- `library/knowledge/private/security/scoping-and-visibility.md`
- `library/knowledge/private/security/secrets.md`
- `library/knowledge/private/security/trust-boundaries.md`
- `library/knowledge/private/security/credential-storage.md`
- `library/knowledge/private/security/request-identity-validation.md`
- `library/knowledge/private/security/portkey-privacy-tier.md`

Grounding (working tree, no `node_modules`, no build output):

- `src/daemon/runtime/recall/scope-clause.ts`
- `src/daemon/runtime/recall/collection.ts`
- `src/daemon/runtime/recall/config.ts`
- `src/daemon/runtime/recall/rerank-portkey.ts`
- `src/daemon/runtime/memories/recall.ts`
- `src/daemon/runtime/memories/api.ts`
- `src/daemon/storage/catalog/memories.ts`
- `src/daemon/storage/catalog/tenancy.ts`
- `src/daemon/storage/sql.ts`
- `src/daemon/runtime/secrets/api.ts`
- `src/daemon/runtime/secrets/store.ts`
- `src/daemon/runtime/secrets/crypto.ts`
- `src/daemon/runtime/secrets/exec.ts`
- `src/daemon/runtime/secrets/contracts.ts`
- `src/daemon/runtime/vault/registry.ts`
- `src/daemon/runtime/vault/store.ts`
- `src/daemon/runtime/vault/api.ts`
- `src/daemon/runtime/vault/migrate.ts`
- `src/daemon/runtime/assemble.ts` (vault base, Portkey selection, token migration call)
- `src/shared/fleet-root.ts`
- `src/shared/constants.ts`
- `src/shared/capture-gate.ts`
- `src/hooks/shared/credential-reader.ts`
- `src/hooks/shared/session-start.ts`
- `src/hooks/openclaw/shim.ts`
- `src/hooks/claude-code/shim.ts`
- `src/daemon/runtime/auth/credentials-store.ts`
- `src/daemon/runtime/auth/contracts.ts`
- `src/daemon/runtime/auth/rbac.ts`
- `src/daemon/runtime/auth/deeplake-issuer.ts` (mint duration)
- `src/daemon/runtime/scope.ts`
- `src/daemon/runtime/middleware/permission.ts`
- `src/daemon/runtime/capture/capture-handler.ts`
- `src/daemon/runtime/vfs/api.ts`
- `src/daemon/runtime/dashboard/api.ts` (project guard)
- `src/daemon/runtime/dashboard/roi-ledger.ts`
- `src/daemon/runtime/dashboard/setup-state.ts`
- `src/daemon/runtime/product/api.ts` (project guard)
- `src/daemon/runtime/ontology/api.ts`
- `src/daemon/runtime/inference/model-client-factory.ts`
- `src/daemon/runtime/inference/transport-portkey.ts`
- `src/daemon/runtime/sources/providers/github.ts`
- `src/daemon/runtime/telemetry/emit.ts`
- `src/daemon/runtime/telemetry/glass-box.ts`
- `src/daemon-client/vfs/read.ts`
- `src/daemon-client/vfs/write-buffer.ts`
- `src/commands/storage-handlers.ts`
- `src/commands/install.ts`
- `src/cli/auth.ts`
- `src/connectors/cursor.ts`
- `src/connectors/claude-code.ts`
- `src/connectors/codex.ts`
- `src/dashboard/contracts.ts`
