# EXECUTION LEDGER — PRD-023 DeepLake Connect Parity (M)

> Orchestrator: `/the-smoker` · Branch: `prd-023-deeplake-connect-parity` · Started 2026-06-20
> Status: **IN-WORK**

Make Honeycomb replicate Hivemind's exact DeepLake connect: a `honeycomb login` device flow +
`whoami` + `org`/`workspace` list & switch that read/write the **shared `~/.deeplake/credentials.json`**
(Hivemind shape, 0600), plus a daemon `deeplakeCredentialsFileProvider()` so the assembled daemon
auto-connects from that file. One login → both Hivemind and Honeycomb connect. Wire protocol is
ALREADY identical; this PRD adds the credential acquisition + sharing + auto-connect.

Behavioral bar: after `honeycomb login` (or a seeded `~/.deeplake/credentials.json`, token from env)
with NO `HONEYCOMB_DEEPLAKE_*` env, the assembled daemon connects from the file and store→recall
through `/api/memories/recall` works LIVE; and the file Honeycomb writes is byte-shape-compatible
with what `hivemind whoami` reads.

## Reference to port (verbatim contract)
Hivemind `C:\Users\mario\GitHub\hivemind`: `src/commands/auth.ts` (device flow `/auth/device/code` →
poll `/auth/device/token` → mint `/users/me/tokens` → validate `/me`; `/workspaces` list), `src/commands/auth-creds.ts`
(creds file path/shape/mode), `src/config.ts` (env+creds resolution), `src/deeplake-api.ts` (transport — already mirrored).

## Decisions (from the PRD)
- D-1 Shared `~/.deeplake/credentials.json`, Hivemind shape `{token,orgId,orgName,userName,workspaceId,apiUrl,savedAt}` 0600; legacy `~/.honeycomb` read-fallback.
- D-2 Same backend `api.deeplake.ai`; port the HTTP contract verbatim.
- D-3 Daemon env-over-file: `HONEYCOMB_DEEPLAKE_*` overrides; else the shared file supplies `{endpoint←apiUrl,token,org←orgId,workspace←workspaceId}`.
- D-4 Security: token NEVER logged/echoed/in-URL/in-error; 0600; verification-URL scheme validated.
- D-5 Reuse the existing seams/verbs; fill the deferred device-flow issuer; don't duplicate the dispatcher.

## Wave plan
- **Wave 1 — foundational creds spine (typescript-node-bee).** Move `credentials-store.ts` to the shared `~/.deeplake/credentials.json` + Hivemind shape (legacy `~/.honeycomb` read-fallback); add `deeplakeCredentialsFileProvider()` in `storage/config.ts` + wire **env-over-file** as the daemon default (`createStorageClient`/assembly). Owns AC-7 spine + the shared `Credentials` shape everything else consumes. → unblocks all.
- **Wave 2 — auth HTTP client + device-flow issuer + login/logout (typescript-node-bee).** Port the `api.deeplake.ai` auth client (`/auth/device/code`,`/auth/device/token`,`/users/me/tokens`,`/me`,`/workspaces`) into the device-flow seam; `honeycomb login` (device + `HONEYCOMB_TOKEN`/`--token`) writes the shared file; `logout` removes it. Exports the auth client for Wave 3. AC-1, AC-2, AC-6.
- **Wave 3 — whoami + org/workspace list&switch + VERB_TABLE + smoke (typescript-node-bee).** `whoami` (GET `/me`), `org list`/`org switch` (re-mint), `workspaces`/`workspace switch`; wire `VERB_TABLE`/`AUTH_SUBCOMMANDS`; manual device-flow smoke script. AC-3, AC-4, AC-5.
- **Wave 4 — gated live itest (retrieval/ts-node-bee + orchestrator runs it).** Seed `~/.deeplake/credentials.json` in temp HOME (token from env) → assembled daemon connects with NO env → store→recall live; + cross-tool file-shape compat assertion. AC-8 (+ re-proves AC-7 live).
- **Wave 5 — close-out: security (opus, MANDATORY for auth/token) → quality (sonnet).** AC-9 + full AC verify.

## AC matrix (9) — OPEN → DONE → VERIFIED
| AC | Criterion (abbrev) | Wave | Owner | Status |
|----|--------------------|------|-------|--------|
| AC-1 | `honeycomb login` device flow → shared file (Hivemind shape, 0600); fake-issuer unit happy/pending/expiry | 2 | ts-node | **DONE** |
| AC-2 | Headless `HONEYCOMB_TOKEN`/`--token` login → validate `/me` → save shared file | 2 | ts-node | **DONE** |
| AC-3 | `whoami` GET `/me` prints user/org/workspace (never token); reads a file `hivemind login` wrote | 3 | ts-node | **DONE** |
| AC-4 | `org list` (backend) + `org switch <name|id>` (re-mint, update shared file) | 3 | ts-node | **DONE** |
| AC-5 | `workspaces` (GET `/workspaces`) + `workspace switch <name|id>` (update shared file) | 3 | ts-node | **DONE** |
| AC-6 | `logout` removes shared (+ legacy) file; exit 0 if absent | 2 | ts-node | **DONE** |
| AC-7 | `deeplakeCredentialsFileProvider()` + env-over-file daemon default; NO env + valid file → daemon connects (unit) | 1 | ts-node | **DONE** |
| AC-8 | Gated live itest: seeded shared file (temp HOME, no env) → assembled daemon connects → store→recall live; + cross-tool shape compat | 4 | retrieval/ts-node | **DONE (pending live run)** — `tests/integration/connect-parity-live.itest.ts`; orchestrator runs it with creds |
| AC-9 | Security: no token in logs/stdout/err/URL (grep-proven); 0600; verification-URL scheme validated; gates green | 5 | security | **DONE** — audit 2026-06-20: 0 Critical, 0 High. Token-leak sweep clean (Bearer-header-only); `validateVerificationUrl`/`defaultBrowserOpener` https-only + fixed-argv `execFileSync`; 0600/0700 via `saveDiskCredentials`; tenancy integrity gate intact; gates green (audit:sql=0, audit:openclaw=0, invariant=0, 155 auth tests pass). 2 Low + 1 informational documented, no remediation required. |

## Wave 1 — DONE (the shared creds spine; the contract Waves 2/3 consume)

**AC-7 proven by** (all unit, deterministic temp dir, never the real `~/.deeplake`):
- `tests/daemon/runtime/auth/credentials-store.test.ts`
  - *AC-7 save→load round-trips the Hivemind on-disk shape at ~/.deeplake* (2 tests: on-disk shape = `{token,orgId,orgName,workspaceId,apiUrl,savedAt}` + additive `agentId`; adapter round-trip).
  - *AC-7 cross-tool read: a file written in Hivemind's EXACT shape loads correctly* (2: Hivemind file with `userName`/no `agentId` loads; missing-token → null).
  - *AC-7 / D-1 legacy ~/.honeycomb read-fallback* (3: fallback when shared absent; shared wins when both exist; writes always land in `~/.deeplake`).
  - *AC-7 loadDiskCredentials exposes the raw disk shape* (3: apiUrl/workspaceId surfaced; legacy up-convert; `HONEYCOMB_TOKEN` override).
- `tests/daemon/storage/config.test.ts`
  - *AC-7 deeplakeCredentialsFileProvider maps the shared file → {endpoint,token,org,workspace}* (4: field mapping; endpoint default; all-undefined-no-throw + fail-closed; **valid `StorageConfig` from a file alone**).
  - *AC-7 defaultCredentialProvider: env-over-file, merged per field* (5: **NO env → file supplies all four → valid `StorageConfig`** = the spine; env wins per-field; env fully overrides; env tuning knobs flow through; fails closed when neither supplies).
- Existing suites kept green (path/shape change, not weakening): `org.test.ts` workspace-use now asserts on-disk `workspaceId` (Hivemind shape); all credentials-store/device-flow/auth-CLI/tenancy/assemble tests pass.

### Exported contract (the shape + signatures Waves 2/3 build on)

**On-disk `DiskCredentials` (Hivemind EXACT shape — `~/.deeplake/credentials.json`, byte-cross-compatible):**
```ts
interface DiskCredentials {
  token: string; orgId: string;
  orgName?: string; userName?: string; workspaceId?: string; apiUrl?: string;
  agentId?: string;     // additive Honeycomb-only field (Hivemind ignores unknown keys)
  savedAt: string;
}
```
**In-memory `Credentials` (UNCHANGED — `contracts.ts`; the rest of Honeycomb uses these names):**
`{ token, orgId, orgName, workspace, agentId, savedAt }`. The store adapts `workspaceId ↔ workspace` at the IO boundary.

**Store API — `src/daemon/runtime/auth/credentials-store.ts` (re-exported via `auth/index.ts`):**
- `CREDENTIALS_DIR_NAME = ".deeplake"` (was `.honeycomb`); `LEGACY_CREDENTIALS_DIR_NAME = ".honeycomb"`; `DEFAULT_DEEPLAKE_API_URL = "https://api.deeplake.ai"`.
- `credentialsDir(dir?) -> string` (default `~/.deeplake`); `credentialsPath(dir?) -> string`; `legacyCredentialsPath(legacyDir?) -> string`.
- `saveCredentials(creds: Credentials, dir?, clock?) -> Credentials` — writes the Hivemind disk shape at 0600, dir 0700, `savedAt` server-stamped. New writes ALWAYS go to `~/.deeplake`.
- `loadCredentials(dir?, env = process.env, legacyDir?) -> Credentials | null` — reads `~/.deeplake` (accepts Honeycomb- AND Hivemind-written files), else legacy `~/.honeycomb` fallback; applies `HONEYCOMB_TOKEN` env rule; null on missing/malformed.
- `loadDiskCredentials(dir?, env = process.env, legacyDir?) -> DiskCredentials | null` — raw disk shape (incl. `apiUrl`/`workspaceId`) for the storage provider; legacy up-convert.
- `resolveTenancy()` + `verifyTokenClaims()` integrity behavior UNCHANGED (token-claim org must match file org).

**Storage provider API — `src/daemon/storage/config.ts` (re-exported via `storage/index.ts`):**
- `interface CredentialsFileProviderOptions { dir?; legacyDir?; env? }`.
- `deeplakeCredentialsFileProvider(opts?) -> CredentialProvider` — `read()` maps `{ endpoint←apiUrl (default DEFAULT_DEEPLAKE_API_URL), token, org←orgId, workspace←workspaceId }`; missing file/keys → undefined fields, never throws.
- `defaultCredentialProvider(opts?) -> CredentialProvider` — ENV-OVER-FILE per-field merge (env present wins, else file); tuning knobs (`queryTimeoutMs`/`traceSql`) env-only. **This is the daemon default.**

**Env-over-file daemon wiring location:** `src/daemon/storage/index.ts` → `createStorageClient()` default provider changed `envCredentialProvider()` → `defaultCredentialProvider()`. `assembleDaemon()` (`src/daemon/runtime/assemble.ts:466`) calls `createStorageClient()` with no provider, so the assembled daemon now resolves config env-over-file from the shared file. Tests still inject `options.provider` (override path unchanged).

**Note for Waves 2/3:** the daemon RUNTIME dir (PID/lock) stays at `~/.honeycomb` (Honeycomb-private process state, not a shared credential); only the credentials file moved to `~/.deeplake`. `assemble.ts` now uses `LEGACY_CREDENTIALS_DIR_NAME` for the lock dir.

## Wave 2 — DONE (the real `api.deeplake.ai` auth client + device-flow / headless login; AC-1/AC-2/AC-6)

**New module:** `src/daemon/runtime/auth/deeplake-issuer.ts` (re-exported via `auth/index.ts`). Ports
`hivemind/src/commands/auth.ts` VERBATIM. **New store helper:** `saveDiskCredentials(disk, dir?, clock?)`
in `credentials-store.ts` (writes the full Hivemind disk shape incl. `userName` + authenticated `apiUrl`
at 0600 — the in-memory `Credentials` can't carry those). **CLI:** `src/cli/auth.ts` rewritten to the real flows.

**AC-1 proven by** `tests/daemon/runtime/auth/deeplake-issuer.test.ts` + `tests/cli/auth.test.ts`:
- *AC-1 device flow → minted long-lived token → shared file in Hivemind shape (0600)* — happy path
  (code→pending→pending→minted→mint→`/me`→file), `"pending"`-then-success, **expiry → clean error (no
  token, no crash, no file)**, never-approving poll-cap → timeout (no file), 0600 perm (POSIX). The
  written file is asserted to have EXACTLY the Hivemind keys `{apiUrl,orgId,orgName,savedAt,token,userName,workspaceId}`.
- CLI *AC-1 login → device flow → shared file; token never printed* (identity printed, token/Auth0-token absent; 0600).

**AC-2 proven by** the same two files:
- *AC-2 headless login: a pre-issued token validates via /me → shared file saved* (no device endpoint hit;
  token only in the `Authorization` header, never a URL), *invalid token (401 /me) → throw, NO file, NO token
  in message*, *empty token rejected before any network call*.
- CLI *AC-2: HONEYCOMB_TOKEN / --token → validate /me → save (no browser)* (both env + `--token` paths;
  invalid token → exit 1, no file, no token in output).

**AC-6 proven by** CLI *AC-6 logout: removes the shared + legacy file; exit 0 when absent; never throws*
(removes BOTH `~/.deeplake` and legacy `~/.honeycomb`; absent → exit 0 "Not logged in.").

**D-4 (security) proven by** *D-4 the device flow REJECTS a non-https `verification_uri_complete` (never
opens it)* (a `javascript:` completion URL → opener handed nothing, login still completes via the user
code) + `validateVerificationUrl` scheme table (https only; http/javascript/file/garbage → null) + the
token-never-printed / token-never-in-URL greps in every login test + the redacted-`AuthHttpError` test.

### Exported auth client — the contract Wave 3 (whoami / org / workspace) consumes

All from `src/daemon/runtime/auth/index.js` (re-exported from `deeplake-issuer.ts`):

```ts
createDeeplakeAuthClient(opts?: {
  apiUrl?: string;                 // default DEFAULT_DEEPLAKE_API_URL
  fetch?: AuthFetch;               // injectable (tests pass a fake); default global fetch
  sleep?: Sleeper;                 // injectable poll/backoff sleeper
  maxRetries?: number;             // default DEFAULT_MAX_RETRIES = 3 (retries 429/5xx w/ backoff)
}): DeeplakeAuthClient

interface DeeplakeAuthClient {
  readonly apiUrl: string;
  getMe(token: string, orgId?: string): Promise<MeResponse>;                 // GET /me   → {id,name,email?}  (AC-3 whoami)
  listOrgs(token: string): Promise<OrgRow[]>;                                // GET /organizations            (AC-4 org list)
  listWorkspaces(token: string, orgId?: string): Promise<WorkspaceRow[]>;    // GET /workspaces (tolerates {data:[]}) (AC-5)
  reMint(token: string, orgId: string): Promise<string>;                     // POST /users/me/tokens → long-lived token (AC-4 org switch)
  requestDeviceCode(): Promise<DeviceCodeResponse>;                          // POST /auth/device/code
  pollDeviceToken(deviceCode: string): Promise<DeviceTokenResponse | "pending">; // POST /auth/device/token
}

// High-level flows the CLI uses (also reusable):
loginWithDeviceFlow(deps?: DeviceFlowLoginDeps): Promise<DiskCredentials>    // AC-1 (validated browser open + poll + mint + /me + write)
loginWithToken(token: string, deps?: LoginDeps): Promise<DiskCredentials>    // AC-2 (validate /me + write)

// Helpers: resolveApiUrl(env) (HONEYCOMB_DEEPLAKE_ENDPOINT → DEFAULT_DEEPLAKE_API_URL),
//          validateVerificationUrl(url) (https-only gate), defaultBrowserOpener(url) (the safe opener),
//          AuthHttpError {status} (redacted — never carries the token).
// Store: saveDiskCredentials(disk: DiskCredentials, dir?, clock?) — writes the Hivemind shape at 0600.
```

**Wave 3 guidance:** `org switch <name|id>` = `client.reMint(token, orgId)` then `saveDiskCredentials(...)`
(re-resolve `orgName`/`workspaceId` via `listOrgs`/`listWorkspaces`); `whoami` = `client.getMe`;
`workspaces` = `client.listWorkspaces`; `workspace switch` = update `workspaceId` only (no re-mint), like
the existing 011a `workspace use`. Resolve `apiUrl`+`token`+`orgId` from `loadDiskCredentials()`.

### Seams (how the network + browser are kept out of the unit tests)

- **fetch** (`AuthFetch`) — every HTTP call routes through the injected `fetch`; tests pass a fake that
  replays canned `/auth/device/code`, `/auth/device/token`, `/me`, `/organizations`, `/users/me/tokens`,
  `/workspaces` responses. No real `api.deeplake.ai`.
- **openBrowser** (`BrowserOpener`) — the device flow calls the injected opener; tests pass a RECORDER that
  captures the URL it was handed (asserting a non-https URI is never passed). Production default
  `defaultBrowserOpener` validates `https:` then `execFileSync` (fixed argv, no shell). No real browser.
- **sleep** (`Sleeper`) — the poll/backoff cadence; tests inject a no-wait sleeper. Plus a `dir` + fake
  `Clock` so the real `~/.deeplake` + wall clock are never touched.

### Security enforcement (D-4 — where each guard lives)

- **Token never logged/printed/URL'd:** the token rides ONLY in the `Authorization: Bearer` header
  (`authHeaders` in `deeplake-issuer.ts`); request paths are constant strings; `AuthHttpError` carries the
  status + a `body.slice(0,200)` (never the token); the CLI success line prints org/workspace/user only
  (`reportLoggedIn`). Grep-asserted in every login test (stdout, error message, request URLs).
- **verification-URL scheme validation:** `validateVerificationUrl` (https-only) is called BEFORE the opener
  in `loginWithDeviceFlow`; `defaultBrowserOpener` re-checks `protocol === "https:"` and uses fixed-argv
  `execFileSync` (rundll32 `FileProtocolHandler` on win32 to avoid `cmd /c start` re-parsing). Ported verbatim
  from Hivemind's `openBrowser`.
- **0600 / 0700:** all writes go through `saveDiskCredentials` (same `FILE_MODE`/`DIR_MODE` discipline as
  the Wave-1 `saveCredentials`).

### Gates (Wave 2)

`npm run ci` = 0 (typecheck + jscpd dup + 1718 passed / 5 skipped), `npm run build` = 0,
`npm run audit:sql` = 0, `npm run audit:openclaw` = 0, `invariant.test.ts` = 0 (3 passed). New files are
git-tracked (not ignored): `src/daemon/runtime/auth/deeplake-issuer.ts`,
`tests/daemon/runtime/auth/deeplake-issuer.test.ts`.

### Not blocking Wave 3/4

The daemon already auto-connects env-over-file (Wave 1 AC-7). The login flows write the shape AC-8's live
itest seeds. The PRD-021b stub `deviceFlowLogin` / `buildRealTokenIssuer` are untouched and still drive
`org`/`workspace` (those migrate to the real client in Wave 3 — non-blocking; the client is exported and ready).

## Wave 3 — DONE (whoami + org/workspace list & switch + dispatcher wiring + smoke; AC-3/AC-4/AC-5)

**New module:** `src/cli/whoami.ts` (`runWhoamiCommand`/`whoamiMain`) — loads the shared credential via
`loadDiskCredentials`, validates it live via the Wave-2 client's `getMe`, prints user / org (name+id) /
workspace. **Migrated module:** `src/cli/org.ts` — `org switch` moved OFF the PRD-011 stub `TokenIssuer`
ONTO the real Wave-2 `DeeplakeAuthClient` (`listOrgs`/`listWorkspaces`/`reMint`); added `org list`,
`workspaces` (alias `workspace list`), `workspace switch`; kept `workspace use` (alias) + `status`. The
real client is an injectable `client` seam (the AC test injects a fake; the runtime constructs one bound
to the credential's `apiUrl`). All switch writes go through `saveDiskCredentials` (Hivemind shape, 0600).

**AC-3 proven by** `tests/cli/whoami.test.ts` (4 tests):
- *AC-3 prints user / org (name+id) / workspace from GET /me; NEVER the token* (grep-asserts the seeded
  bearer token never appears in any output line).
- *AC-3 reads a file written in Hivemind's EXACT shape (cross-tool read)* (a `saveDiskCredentials`-written
  file — the same shape `hivemind login` writes — loads + resolves; `/me`-derived display name when the
  file omits `userName`).
- *AC-3 not-logged-in → clean "run `honeycomb login`" message + non-zero exit*.
- *AC-3 invalid token (401 /me) → redacted error + non-zero exit, no token leaked*.

**AC-4 proven by** `tests/cli/org.test.ts` (org list + switch, fake `DeeplakeAuthClient`):
- *AC-4 org list prints the accessible orgs, marking the active one*.
- *AC-4 org switch by NAME → re-mints (scoped to the resolved org id) + persists new orgId/orgName/token
  to the shared file (assert on-disk `orgId`/`orgName`/`token`/`savedAt`); token never printed*.
- *AC-4 org switch by ID → re-mints + persists*.
- *AC-4 fails closed (non-zero, no write) when the target org is not accessible / when re-mint throws*
  (seeded org + token untouched).

**AC-5 proven by** `tests/cli/org.test.ts` (workspaces + switch, fake `DeeplakeAuthClient`):
- *AC-5 workspaces lists the org's workspaces, marking the active one; `workspace list` is an alias*.
- *AC-5 workspace switch by NAME → resolves name→id, persists `workspaceId`, token UNCHANGED (no re-mint)*.
- *AC-5 workspace switch by ID directly; rejects a name with no match when the backend is reachable*.
- Back-compat: *`workspace use default` writes verbatim (no lookup)* + *`workspace use` falls back to a
  verbatim write when the backend is unreachable* (the PRD-011a alias preserved).
- a-AC-6 `status` kept green (prints org id/name/workspace/agent, never the token; not-logged-in path).

### Dispatcher wiring (VERB_TABLE / AUTH_SUBCOMMANDS / runtime passthrough — D-5, extended not duplicated)
- `src/commands/contracts.ts`: added `whoami` (cls `auth`), `workspaces` (cls `auth`) to `VERB_TABLE`;
  updated `org`/`workspace` summaries (list/switch). `AUTH_SUBCOMMANDS` now = `{org, workspace, workspaces,
  whoami, login, logout}` so all four new verbs are recognized and forwarded VERBATIM to the auth
  dispatcher (the unified dispatcher does NOT re-parse their subcommands).
- `src/cli/runtime.ts` `buildAuthPassthrough`: routes `login`/`logout` → `authMain`; `whoami` → `whoamiMain`
  (AC-3); `org`/`workspace`/`workspaces` → `orgMain` (AC-4/AC-5, real client constructed on demand — no
  stub issuer passed). The PRD-011 stub issuer is no longer wired into the tenancy verbs (it remains only
  in `buildOrgDriftHealer`).

### Consume-side gap CLOSED (the hook credential reader — flagged by Wave 1)
`src/hooks/shared/credential-reader.ts` REPOINTED to read the SHARED `~/.deeplake/credentials.json` FIRST
(Hivemind shape — the workspace is the `workspaceId` field), falling back to the legacy
`~/.honeycomb/credentials.json` (old shape — the workspace is `workspace`). Stays self-contained (imports
NOTHING from `daemon/storage`/`daemon/runtime` — mirrors the minimal path/shape logic; `invariant.test.ts`
green). This is what lets the capture/hook path use a `honeycomb login` OR `hivemind login` credential
(also exercised by Wave 4's live golden path). **Proven by** `tests/hooks/shared/credential-reader.test.ts`
(7 tests): reads `~/.deeplake` (workspaceId→workspace, orgId→org, agentId→actor); env-token override;
legacy `~/.honeycomb` (workspace) fallback; shared wins when both exist; malformed-shared falls through to
legacy; token-less file → undefined; both-absent → undefined. **Wave 4: this is CLOSED.**

### Manual device-flow smoke (AC-3 operator proof)
`scripts/login-smoke.mjs` + `npm run smoke:login`. Drives the REAL `api.deeplake.ai` device flow end-to-end
through the built `bundle/cli.js`: `honeycomb login` (prints the user code + URI, opens the browser — the
one un-automatable bit is the human browser-authorize), confirms the shared file landed, then `honeycomb
whoami`. Opt-in/interactive gated (`HONEYCOMB_LOGIN_SMOKE=1`; needs a TTY) — mirrors `golden-path-smoke.mjs`'s
gating posture; no opt-in → clear message, exit 0. Headless variant: `HONEYCOMB_TOKEN=<key>` takes the AC-2
no-browser path. Never reads/prints/forwards the token (checks env PRESENCE only).

### Gates (Wave 3)
`npm run ci` = 0 (typecheck + jscpd dup 0.5% + **1738 passed / 5 skipped**), `npm run build` = 0
(1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon @ 0.1.0),
`npm run audit:sql` = 0, `npm run audit:openclaw` = 0, `invariant.test.ts` = 0 (3 passed). New files are
git-tracked (not ignored): `src/cli/whoami.ts`, `tests/cli/whoami.test.ts`,
`tests/hooks/shared/credential-reader.test.ts`, `scripts/login-smoke.mjs`.

### Not blocking Wave 4
The hook credential reader is repointed + tested (the consume-side gap is CLOSED). The shared file the
login flows write is the same file `whoami` + the hook reader + the daemon (Wave 1 env-over-file) read —
one login authenticates Honeycomb + Hivemind end to end. AC-3/4/5 verbs are wired into the dispatcher and
callable through `bundle/cli.js`. Wave 4's live golden path can seed `~/.deeplake/credentials.json` and
exercise the full store→recall path with the hook reader honoring it.

## Wave 4 — DONE (pending live run) — the gated AC-8 connect-parity itest

**New file (git-tracked, NOT ignored):** `tests/integration/connect-parity-live.itest.ts` — the gated live
parity proof. `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)`, `.itest.ts` suffix, 120s cap, per-run-unique
recall term (`connectparity${RUN_ID}`), creds seeded into a `mkdtempSync` TEMP dir (never the real
`~/.deeplake`). **The orchestrator runs it with creds** (`npm run test:integration`); it is NOT run here.

**AC-8 (re-proves AC-7 LIVE) — what the itest asserts:**
- **The env-stripped, file-only connect (the AC-8 core).** `beforeAll` seeds the shared file via the Wave-2
  `saveDiskCredentials(seeded, credDir)` (the `honeycomb login` write path, 0600, Hivemind shape
  `{token,orgId,orgName,userName,workspaceId,apiUrl,savedAt}`) from `HONEYCOMB_DEEPLAKE_TOKEN/_ORG/_WORKSPACE/_ENDPOINT`.
  It then builds the storage client from the REAL `defaultCredentialProvider({ env: <stripped>, dir: credDir })`
  — env-over-file — where `<stripped>` is a `{...process.env}` CLONE with every `HONEYCOMB_DEEPLAKE_*` key
  DELETED (`envWithoutDeeplakeKeys()`; the real `process.env` is NEVER mutated). With the env arm contributing
  nothing for the four credential fields, the FILE supplies all of `{ endpoint←apiUrl, token, org←orgId,
  workspace←workspaceId }`. That client is injected into `bootTestDaemon({ mode:"local", storage:
  createStorageClient({ provider }) })` (mirroring `data-api-assembled-live.itest.ts`), so the assembled daemon
  auto-connects FROM THE FILE, not env. (A thin wrapper adds only the `queryTimeoutMs: 120_000` live tuning knob;
  the four credential fields pass through unchanged from the file-only provider.)
- **Store→recall LIVE through HTTP.** Test 1 drives `POST /api/memories` (store the unique term) via the CLI
  loopback client (`createLoopbackDaemonClient` — it stamps the session/runtime-path headers), asserts 201
  inserted/deduped, then polls `POST /api/memories/recall {query:<term>}` poll-convergently (40 polls × 350ms —
  the established eventual-consistency discipline) until the row recalls. A green recall PROVES the file-only
  connect path end to end (re-proving AC-7 live).
- **Cross-tool shape compat (the AC-8 second half).** Test 2 reads the seeded file back off disk
  (`credentialsPath(credDir)`) and asserts the EXACT Hivemind key set
  `{token,orgId,orgName,userName,workspaceId,apiUrl,savedAt}` is present (superset OK), the four load-bearing
  keys `token/orgId/workspaceId/apiUrl` are present + correctly typed, and Honeycomb's own
  `loadDiskCredentials(credDir, {})` round-trips it to the same values. (Does NOT import the Hivemind repo —
  asserts the shape contract Hivemind's loader reads.)

**SECURITY (D-4):** the token is read from env, written to the temp file, and NEVER `console.log`'d. Both
receipts print the recall term / status / KEY SET only — never a credential value. No `git add`/commit/push;
no other waves' files touched.

### Gates (Wave 4 — verified WITHOUT the live itest running)
`npm run ci` = **0** (typecheck + jscpd dup + **1738 passed / 5 skipped** — UNCHANGED count, confirming the new
`.itest.ts` did NOT enter the unit run + `audit:sql` OK). `npm run build` = **0** (1 daemon + 5 hook-harness +
1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon @ 0.1.0). `npm run audit:openclaw` = **0**.
`tests/daemon/storage/invariant.test.ts` = **0** (3 passed). `git check-ignore
tests/integration/connect-parity-live.itest.ts` → exit **1** (NOT ignored — git-trackable). Integration config
discovers the file and SKIPS it cleanly with no token (2 skipped, exit 0) — gated + excluded from CI both ways
(`.itest.ts` suffix + `tests/integration/**` exclusion).
