# Security code lens

Read-only static survey of `/home/marioaldayuz/Desktop/development/active/honeycomb` on 2026-10-04. No install, no runtime bind, no secret values. Labels: VERIFIED (source read this pass), REPORTED (a comment or doc states it; behavior not re-executed), UNVERIFIABLE-HERE (not decided from the files opened).

## Posture

Default listen address is loopback `127.0.0.1:3850` in `local` mode. Permission middleware exists and is mounted on protected route groups, and in `local` mode it does not authenticate. `HONEYCOMB_BIND` and `HONEYCOMB_HOST` can set a non-loopback host, including `0.0.0.0`, with no check that mode is `team` or `hybrid`. `widened` is true only when `HONEYCOMB_BIND` itself is non-loopback. SQL escaping is gated by `scripts/audit-sql-safety.mjs` over `src/daemon` and `src/daemon-client`. Device-flow credentials are a mode `0600` JSON file with a second direct reader in the hook layer. `agent.yaml` stores a `${SECRET_REF}` name, and the inference parser rejects an inline key.

## Findings

### security-code-1 VERIFIED

Default daemon bind host is `127.0.0.1` and the default port is `3850`.

- `src/shared/constants.ts` exports `DAEMON_HOST = "127.0.0.1"` and `DAEMON_PORT = 3850`. The same file sets `HIVE_HOST` / `HIVE_PORT` to `127.0.0.1` / `3853` for the portal, which is a different process.
- `src/daemon/runtime/config.ts` sets `LOOPBACK_HOST` from `DAEMON_HOST`. `RuntimeConfigSchema` defaults `host` to that value, `port` to `DAEMON_PORT`, `mode` to `local`, and `widened` to `false`.
- `resolveRuntimeConfig` with an empty record is covered by `tests/daemon/runtime/config.test.ts` (`defaults to 127.0.0.1:3850 in local mode`).
- `src/daemon/runtime/listen.ts` passes `daemon.config.host` and `daemon.config.port` to `@hono/node-server` `serve` as `hostname` and `port`.

`trust-boundaries.md` describes hook and CLI traffic as loopback RPC to the daemon on port 3850. That matches the default. It does not mention `HONEYCOMB_HOST` or `HONEYCOMB_BIND`.

### security-code-2 VERIFIED

The resolver accepts a non-loopback listen host. Nothing in the bind path refuses that host when mode stays `local`.

- `resolveRuntimeConfig` uses `HONEYCOMB_BIND` when it is a non-empty string, otherwise `HONEYCOMB_HOST`.
- `widened` is `bindSet && !isLoopback(bind)`. Loopback for that flag is `127.0.0.1`, `::1`, or `localhost`.
- `tests/daemon/runtime/config.test.ts` expects `host: "0.0.0.0"` to resolve to host `0.0.0.0`. It expects `bind: "0.0.0.0"` to set host `0.0.0.0` and `widened: true`.
- A host of `0.0.0.0` supplied only as `HONEYCOMB_HOST` therefore leaves `widened` false, because `bindSet` is false. `load-bearing-boundaries.md` says `widened` records whether the bind left loopback. The flag records whether `HONEYCOMB_BIND` left loopback.
- `src/shared/constants.ts` comments that `DAEMON_HOST` must never bind a public interface. The resolver does not enforce that sentence. `Host` only requires a non-empty token matching `^[A-Za-z0-9._:-]+$`.
- `src/cli/runtime.ts` `daemonHost()` returns `HONEYCOMB_HOST` only when the trimmed value is `127.0.0.1` or `localhost`. Any other value falls back to `DAEMON_HOST`. The CLI dialer does not follow a widened listen address. The daemon listen path still uses `config.host`.

No surveyed security doc says the default bind is beyond loopback. `daemon-surface.md` and `load-bearing-boundaries.md` say the default is `127.0.0.1:3850` and that `HONEYCOMB_PORT`, `HONEYCOMB_HOST`, and `HONEYCOMB_BIND` can widen it. That override exists in `config.ts`. This pass found no knowledge doc that claims a beyond-loopback bind the code cannot perform.

### security-code-3 VERIFIED

Permission middleware exists, is mounted, and is a no-op in the default mode.

- File: `src/daemon/runtime/middleware/permission.ts`. Export: `permissionMiddleware`. Context key: `honeycombIdentity`. Reader: `getRequestIdentity`.
- `local`: the handler runs with no authenticator and no policy (`mode === "local"` returns `next()`).
- `team` and `hybrid`: missing bearer and missing `x-api-key` return 401. A present credential is authenticated, then the policy decides. Default authenticator is `alwaysUnauthenticated`. Default policy is `defaultDenyPolicy`. `hybrid` uses `noSocketPeer`, which never treats a peer as local, so hybrid requires a credential.
- `src/daemon/runtime/server.ts` `createDaemon` mounts `permissionMiddleware` on route groups with `protect: true`. Groups with `protect: false` are `/health`, `/api/status`, and `/`.
- `/api/status` returns `config.host`, `config.port`, `config.mode`, and `config.widened` with no permission middleware.
- `src/daemon/runtime/assemble.ts` mounts `/setup/*` only when `daemon.config.mode === "local"`, on the unprotected `/` group.
- Assembly passes a real authenticator from `composeAuthenticator` when storage is present (`assemble.ts` around the `authenticator` / `createRbacPolicy` helper). Default `createDaemon()` without that injection stays fail-closed in `team`/`hybrid` and open in `local`.

`request-identity-validation.md` says `getRequestIdentity` is undefined in `local` mode and that guards then trust caller input. That matches `permission.ts` and the guards below.

### security-code-4 VERIFIED

Org, workspace, and project guards match `request-identity-validation.md` when an `Identity` is present.

- `resolveScopeFromHeaders` in `src/daemon/runtime/scope.ts`: empty `x-honeycomb-org` returns null. If `getRequestIdentity` is defined and the header org differs from `identity.org`, the function returns null. If an identity is present, workspace comes from `identity.workspace`. If no identity is present, the workspace header is used.
- `isAuthorizedForResolvedProject` is implemented in four modules, each reading `getRequestIdentity`: `src/daemon/runtime/memories/api.ts`, `src/daemon/runtime/dashboard/api.ts`, `src/daemon/runtime/product/api.ts`, `src/daemon/runtime/vfs/api.ts`. No identity, `admin`, or a missing `identity.project` returns true. A bound project that differs returns false, and callers use reason text `project scope violation`.
- Because `local` mode never stamps an identity, these guards do not run on the default deployment.

The doc's named test files were not re-run this pass. Their existence was not required to confirm the guard source.

### security-code-5 VERIFIED

`scripts/audit-sql-safety.mjs` is a static grep gate, not a SQL parser.

- `package.json` script `audit:sql` is `node scripts/audit-sql-safety.mjs` with no directory argument. `ci` includes `audit:sql`.
- Default `SCAN_DIRS` is `src/daemon` and `src/daemon-client`. One positional directory argument replaces that pair with that directory only.
- Walk includes `.ts`, `.mts`, and `.cts`. It skips directories named `node_modules`, `dist`, and `bundle`, and files ending in `.d.ts` or `.test.ts`. Basename `sql.ts` is exempt.
- A line must match a SQL statement fingerprint and contain a quote. Comment lines and `throw new` / `new Error` / `console.` lines are skipped.
- It flags a `${...}` body that is not `sqlStr`, `sqlLike`, `sqlIdent`, `sqlColumnList`, `eLiteral`, or `sLiteral`, and is not classified as numeric, prebuilt, a safe binding, or a same-file method whose return is one of those helpers.
- It also flags `+` concatenation of a raw operand into a SQL string literal.
- It does not scan `harnesses/`, `mcp/`, `src/cli/`, `sdk/`, `embeddings/`, or `tests/`.

`trust-boundaries.md` names `sqlStr`, `sqlLike`, and `sqlIdent` as the VFS escaping helpers. The script also treats `sqlColumnList`, `eLiteral`, and `sLiteral` as safe. That is a wider allowlist than the three names in the doc, and it matches `load-bearing-boundaries.md` on `eLiteral`.

### security-code-6 VERIFIED

SQL strings are assembled in `src/daemon-client` and sent to the daemon. `trust-boundaries.md` says the daemon is the only place SQL is assembled.

- `src/daemon-client/vfs/read.ts` `buildSessionsConcatSql` builds a `SELECT` with `sqlIdent` and `sLiteral`, then `concatSessions` calls `deps.dispatch.query(...)`.
- The audit script header says the default scan includes `src/daemon-client` because that tree builds SQL and dispatches it through the daemon.
- The daemon remains the process that opens DeepLake. The thin client still composes the SQL text. The doc sentence "the only place SQL is ever assembled" does not match `src/daemon-client`.

### security-code-7 VERIFIED

Credential file readers and writers, names and paths only.

Direct file IO:

| Function | File | Paths |
|---|---|---|
| `loadCredentials`, `loadDiskCredentials` (internal reads via `readFileSync`) | `src/daemon/runtime/auth/credentials-store.ts` | `~/.deeplake/credentials.json`, then `~/.honeycomb/credentials.json` |
| `saveCredentials`, `saveDiskCredentials` | same file | writes `~/.deeplake/credentials.json` only |
| `createCredentialReader` / `readFileCredential` | `src/hooks/shared/credential-reader.ts` | same two paths, read only |

Constants in both modules: `CREDENTIALS_DIR_NAME` `.deeplake`, `LEGACY_CREDENTIALS_DIR_NAME` `.honeycomb`, `CREDENTIALS_FILE_NAME` `credentials.json`. Store write modes: `FILE_MODE` `0o600`, `DIR_MODE` `0o700`.

Both readers honor env name `HONEYCOMB_TOKEN` as the token when a file credential exists. The hook reader returns undefined when both files are missing, including when that env var is set (`credential-reader.ts` comments say the daemon resolves an env-only token).

Callers that use the store helpers and do not call `readFileSync` on the credentials file themselves include `src/cli/runtime.ts`, `src/cli/auth.ts` (`saveCredentials`), `src/cli/org.ts`, `src/cli/project.ts`, `src/cli/whoami.ts`, `src/commands/status.ts`, `src/daemon/storage/config.ts`, `src/daemon/runtime/vault/migrate.ts`, `src/daemon/runtime/auth/device-flow.ts`, `src/daemon/runtime/auth/tenancy-resolution.ts`, and `src/daemon/runtime/dashboard/setup-state.ts`.

`credential-storage.md` says the functions in `credentials-store.ts` own all disk access and that no other module reads or writes the credentials file directly. `src/hooks/shared/credential-reader.ts` is a second direct reader. The hook file header says that split is intentional so hooks do not import the daemon store.

`harnesses/cursor/extension/contracts.ts` comments say login writes `~/.honeycomb/credentials.json` via `saveCredentials`. `saveCredentials` writes `~/.deeplake/credentials.json`. This pass did not find a call to `saveCredentials` under `harnesses/cursor/extension/`; the path in those comments is REPORTED, not a second writer confirmed here.

### security-code-8 VERIFIED

`agent.yaml` uses secret-ref style. No inline key material is in the file.

- The only credential field read this pass is `inference.accounts[].apiKey` with value `${ANTHROPIC_API_KEY}`.
- `src/daemon/runtime/inference/config.ts` `SECRET_REF_PATTERN` is `^\$\{[A-Za-z_][A-Za-z0-9_]*\}$`. The zod refinement rejects any other `apiKey` string. The error text does not include the rejected value.
- Parsed accounts store `apiKeyRef`. Resolution is deferred to `SecretResolver` (`src/daemon/runtime/inference/router.ts` calls `this.secrets.resolve(account.apiKeyRef)`).

`secrets.md` says router accounts reference secrets and a config dump must not contain a credential. The parser matches that rule. The on-disk secret name in this file is `ANTHROPIC_API_KEY`.

### security-code-9 VERIFIED

`secrets.md` describes a bundled plugin at `plugins/core/secrets`. That path is not in the tree (search returned no files).

The implementation is `src/daemon/runtime/secrets/` (`SecretsStore`, `SECRETS_DIR_NAME` `.secrets`). Assembly sets the store `baseDir` with `resolveVaultBaseDir()`, which returns `honeycombStateDir()` (`src/daemon/runtime/assemble.ts`). `src/shared/fleet-root.ts` documents that directory as `~/.apiary/honeycomb` unless `APIARY_HOME` or Linux `XDG_STATE_HOME` overrides the fleet root. That matches the fleet-root paragraph in `secrets.md`.

`src/daemon/runtime/secrets/store.ts` and `secrets/CONVENTIONS.md` still describe the base as `$HONEYCOMB_WORKSPACE/.secrets/`. The assembly call site passes the fleet state root. The module comment and the assembly function disagree; the running wiring follows assembly.

### security-code-10 VERIFIED

`credential-storage.md` plaintext file contract matches the store for the fields this pass checked: on-disk names include `token`, `orgId`, `workspaceId`, `apiUrl`, `agentId`, `savedAt`. Writes use mode `0600` and directory mode `0700`. Legacy `~/.honeycomb/credentials.json` is a read fallback. New writes go to `~/.deeplake`. The module imports `node:fs` and does not import `fetch` (the isolation claim in that doc). Token values were not printed.

`trust-boundaries.md` says the token is read from a mode `0600` file and sent to the daemon as a bearer on loopback. The hook reader does read that file. Whether every hook avoids placing the token on argv or in a child env was not exhaustively traced (UNVERIFIABLE-HERE for the full hook set). The file-read path itself is verified.

### security-code-11 REPORTED

`secrets.md` says OS keychain and passphrase backends are planned and should be treated as not implemented until confirmed in code. `credential-storage.md` says the device-flow token does not use an OS keychain. This pass did not find a keychain integration on the credentials path. A full negative search of every native binding was not done, so the absence of a keychain backend stays REPORTED from those docs plus the credentials-store header, not a whole-repo proof.

### security-code-12 UNVERIFIABLE-HERE

No socket was opened. This pass did not observe a live `listen()` address, a live `HONEYCOMB_BIND`, or file modes on a real `~/.deeplake/credentials.json`. Tests cited above are source expectations, not a run from this survey. `npm run audit:sql` was not executed.

## Doc contradictions

1. `trust-boundaries.md` says SQL is assembled only inside the daemon. `src/daemon-client` builds SQL strings and dispatches them (`security-code-6`). The daemon is still the DeepLake client.
2. `trust-boundaries.md` describes the daemon link as loopback and does not mention `HONEYCOMB_BIND` or `HONEYCOMB_HOST`. The default matches. The resolver can leave loopback (`security-code-2`). No security doc claims a beyond-loopback default that the code lacks.
3. `load-bearing-boundaries.md` says `widened` records whether the bind left loopback. The flag is set from `HONEYCOMB_BIND` only. `HONEYCOMB_HOST=0.0.0.0` changes the listen host and leaves `widened` false (`security-code-2`).
4. `src/shared/constants.ts` says never bind a public interface. `config.ts` accepts `0.0.0.0` (`security-code-2`). `daemon-surface.md` correctly describes that override.
5. `credential-storage.md` says no other module reads or writes `credentials.json` directly. `src/hooks/shared/credential-reader.ts` reads it directly (`security-code-7`).
6. `secrets.md` places the secrets plugin at `plugins/core/secrets`. That directory is absent. Code lives in `src/daemon/runtime/secrets/` (`security-code-9`). The fleet-root base dir in that same doc matches `resolveVaultBaseDir()`.
7. `request-identity-validation.md` matches `scope.ts` and the four `isAuthorizedForResolvedProject` copies for authenticated requests. Those checks do not apply in default `local` mode, which the doc states.

## Files read

`src/shared/constants.ts`, `src/shared/fleet-root.ts`, `src/daemon/runtime/config.ts`, `src/daemon/runtime/listen.ts`, `src/daemon/runtime/server.ts`, `src/daemon/runtime/middleware/permission.ts`, `src/daemon/runtime/scope.ts`, `src/daemon/runtime/memories/api.ts` (project guard), `src/daemon/runtime/assemble.ts` (vault base, setup mount, authenticator helper), `src/daemon/runtime/auth/credentials-store.ts`, `src/hooks/shared/credential-reader.ts`, `src/daemon-client/vfs/read.ts`, `src/daemon/runtime/inference/config.ts`, `src/daemon/runtime/secrets/store.ts`, `src/cli/runtime.ts` (`daemonHost`), `scripts/audit-sql-safety.mjs`, `agent.yaml`, `package.json` (`audit:sql`), `tests/daemon/runtime/config.test.ts`, and the four security knowledge files plus `library/knowledge/private/architecture/daemon-surface.md` and `load-bearing-boundaries.md`.
