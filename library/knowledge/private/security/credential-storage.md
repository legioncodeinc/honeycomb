# Credential Storage

> Category: Security | Version: 1.0 | Date: June 2026 | Status: Active

Documents where Honeycomb stores device-flow credentials on disk, the shared `~/.deeplake/credentials.json` it byte-shares with Hivemind, the three detected credential locations, the file-system permissions enforced on every write, the shape of the credentials object, and the IO helpers that own all access to the file.

**Related:**
- [`secrets.md`](secrets.md)
- [`trust-boundaries.md`](trust-boundaries.md)
- [`scoping-and-visibility.md`](scoping-and-visibility.md)
- [`../auth/auth-architecture.md`](../auth/auth-architecture.md)
- [`../operations/install-and-onboarding.md`](../operations/install-and-onboarding.md)
- [`../multi-tenant/org-workspace-model.md`](../multi-tenant/org-workspace-model.md)

---

## Why this exists

The device-flow credential (access token, org identity, workspace selection) must persist across processes and restarts without relying on a running daemon. A single JSON file under the user's home directory satisfies this requirement and is the conventional pattern for developer tools on all three supported platforms (macOS, Linux, Windows). A hook that needs to reach the Honeycomb daemon reads this file to learn who it is and which org it belongs to before it ever opens a socket.

This file is distinct from the encrypted secrets subsystem documented in [`secrets.md`](secrets.md). Credential storage holds the single bearer token that proves identity to the daemon and backend; the secrets subsystem holds encrypted, scoped key/value material that the daemon decrypts on demand. They share neither a file nor a code path.

No keychain, secret manager, or OS credential store is used for the device-flow token. The security model relies entirely on file-system permissions: only the owning user can read or write the credentials file.

---

## The shared credential file (byte-compatible with Hivemind)

Honeycomb and Hivemind **share one credentials file**: `~/.deeplake/credentials.json`. One `hivemind login` **or** `honeycomb login` authenticates both tools. To make the file byte-cross-compatible, the on-disk shape is Hivemind's exact shape, `{ token, orgId, orgName, userName, workspaceId, apiUrl, savedAt }` plus an additive `agentId` that Hivemind's loader ignores (it reads named fields and never enumerates keys). The IO layer maps `workspaceId ↔ workspace` on the disk boundary so the rest of Honeycomb keeps its in-memory `Credentials` shape unchanged.

This shared file is the foundation of the install/onboarding migration path: because the credential is byte-compatible, a Hivemind→Honeycomb upgrader is usually adopted with **no re-auth at all**, a valid file is verified via `GET /me` and reused. See [Install and Onboarding](../operations/install-and-onboarding.md#hivemind-coexistence-and-migration).

All disk access lives in `src/daemon/runtime/auth/credentials-store.ts`. The directory and file name constants are exported there:

| Constant | Value |
|---|---|
| `CREDENTIALS_DIR_NAME` | `.deeplake` (the shared dir) |
| `LEGACY_CREDENTIALS_DIR_NAME` | `.honeycomb` (legacy read-fallback only) |
| `CREDENTIALS_FILE_NAME` | `credentials.json` |

Path resolution is lazy (re-evaluated on each call via `homedir()`, not bound at module load) so tests can override the home/dir between cases; the dir is also injectable, so a test points it at a temp HOME and never touches the real `~/.deeplake`.

### Three detected locations

The onboarding/setup surface probes **three** home-relative directories to decide which setup state to render, a plain `existsSync` on each, never a read of the credential value:

| Directory | Meaning |
|---|---|
| `~/.deeplake` | The shared, current Honeycomb+Hivemind credential dir |
| `~/.honeycomb` | A legacy Honeycomb credential/runtime dir (read-only fallback) |
| `~/.hivemind` | A legacy Hivemind install, a prior-tool signal that drives the coexistence-warning wizard |

A present `~/.hivemind` directory is the "folder present + not ours → likely Hivemind" signal: it flips `priorTool.hivemind` to `present` so the dashboard offers migration rather than plain first-time setup.

### Coexistence is unsupported; migration is the path

Running Hivemind and Honeycomb together on one machine is **unsupported** (duplicate capture/recall hooks, competing daemons, ambiguous ownership). The supported path is migration: back up `~/.hivemind`, uninstall Hivemind, then adopt or re-link the shared credential. The credential file itself is never deleted by a failed/partial uninstall.

---

## Read precedence and the legacy fallback

`loadCredentials()` reads in precedence order:

1. `~/.deeplake/credentials.json` (the Hivemind shape, accepts both a Honeycomb-written and a Hivemind-written file; `workspaceId → workspace` on adapt).
2. Else `~/.honeycomb/credentials.json` (the legacy Honeycomb shape, adapted as-is), a **read-only** back-compat path.

New writes **always** land in `~/.deeplake` in the new shared shape; the legacy path is never written. The function returns `null` when both are missing or malformed (never a throw, never a partial credential), callers treat `null` as "not logged in." This `null`-on-missing contract is exactly what the pre-auth dashboard relies on to boot without credentials (see [Install and Onboarding](../operations/install-and-onboarding.md#the-one-daemon--two-phase-model)).

---

## File-System Permissions

`saveCredentials()` / `saveDiskCredentials()` enforce permissions on every write:

| Resource | Mode | Who can access |
|---|---|---|
| `~/.deeplake/` (directory) | `0700` (`rwx------`) | Owning user only |
| `~/.deeplake/credentials.json` | `0600` (`rw-------`) | Owning user only |

The directory is created with `mkdirSync({ recursive: true, mode: 0o700 })`. The `recursive: true` flag is idempotent: if the directory already exists, the call is a no-op and does NOT change the existing mode. Mode `0o700` is applied only on initial creation.

The file is written with `writeFileSync(path, json, { mode: 0o600 })`. On POSIX systems this sets the permission bits directly. On Windows, the mode parameter is silently ignored; the token-at-rest protection there is the per-user profile directory ACL, documented as a known platform gap. `savedAt` is always stamped server-side from an injected clock, ignoring any value the caller passed, the timestamp is evidence, not input.

---

## Credentials Schema

The on-disk `DiskCredentials` shape (TypeScript source of truth in `src/daemon/runtime/auth/credentials-store.ts`) is Hivemind's exact shape, `token` + `orgId` are load-bearing, the rest are optional on read (a Hivemind-written file may omit some):

| Field | Type | Required | Description |
|---|---|---|---|
| `token` | `string` | yes | Long-lived org-bound JWT (365-day expiry). Bearer token for all daemon and API calls. A SECRET at rest, never logged or printed by this module. |
| `orgId` | `string` | yes | Active organization ID. Must match `org_id` claim in `token`. |
| `orgName` | `string` | no | Human-readable org name. Used for display only (e.g. session banner). |
| `userName` | `string` | no | Display name fetched from `GET /me` at login time (Hivemind field). |
| `workspaceId` | `string` | no | Active workspace (maps to in-memory `workspace`). Defaults to `"default"` (the backend resolves the sentinel). |
| `apiUrl` | `string` | no | Base URL for the DeepLake API. Defaults to `https://api.deeplake.ai` when absent. |
| `agentId` | `string` | no | Additive Honeycomb-only field: the within-workspace actor id. Hivemind's loader ignores it. |
| `savedAt` | `string` | yes | ISO 8601 timestamp stamped server-side on save. Evidence, not input; not validated at load time. |

Example file contents:

```json
{
  "token": "eyJ...<truncated>",
  "orgId": "acme-inc",
  "orgName": "Acme Inc",
  "userName": "alice",
  "workspaceId": "default",
  "apiUrl": "https://api.deeplake.ai",
  "agentId": "default",
  "savedAt": "2026-06-12T23:00:00.000Z"
}
```

The `orgId` and `workspaceId` fields are the client-side anchor for tenancy. The daemon re-validates both against the JWT and the storage layer on every request, so a tampered credentials file cannot widen a token's reach. See [`scoping-and-visibility.md`](scoping-and-visibility.md) and [`../multi-tenant/org-workspace-model.md`](../multi-tenant/org-workspace-model.md) for how org and workspace boundaries are enforced.

---

## File IO Helpers

The functions in `src/daemon/runtime/auth/credentials-store.ts` own all disk access. No other module reads or writes the credentials file directly. Everything IO-touching (the dir, the clock) is injectable so tests run against a temp dir with a fake clock.

### `loadCredentials(dir?, env?, legacyDir?): Credentials | null`

Reads the shared `~/.deeplake/credentials.json`, falling back to the legacy `~/.honeycomb/credentials.json` when the shared file is absent, and adapts the on-disk shape into the in-memory `Credentials`. Returns `null` for any failure on both paths: missing file, permission denied, or malformed JSON. Callers treat `null` as "not logged in." When `HONEYCOMB_TOKEN` is set, the returned token is the env token and neither file is trusted for its token field (the file's identity fields still describe the active tenancy). A sibling `loadDiskCredentials()` returns the raw disk shape (including `apiUrl`/`workspaceId`) for the storage-config provider.

### `saveCredentials(creds, dir?, clock?): Credentials` / `saveDiskCredentials(disk, dir?, clock?)`

Writes credentials to the shared `~/.deeplake/credentials.json` in Hivemind's exact on-disk shape. Always:
1. Creates the dir (recursively) at `0700` if absent.
2. Writes the file at `0600`, with `savedAt` stamped server-side from the injected clock, any value on the input is ignored.

New writes always land in `~/.deeplake` in the new shape, never the legacy path. The in-memory `workspace`/`agentId` are mapped to `workspaceId` + the additive `agentId`, and `apiUrl` defaults to the canonical DeepLake endpoint so a Hivemind read sees a complete record. The token is carried verbatim and never logged.

### Tenancy integrity gate

`resolveTenancy()` applies the env overrides (`HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID`) and the integrity check: the token (env `HONEYCOMB_TOKEN` if set, else the file's) is decoded and verified, and if its verified org claim disagrees with the org the file claims, the file is **rejected** with a `TenancyIntegrityError`, a tampered credentials file can never widen a token's reach. An env org override is checked against the same token claim, so it cannot escape the token's org either. An unverifiable token is likewise rejected (fail-closed).

---

## No Keychain Integration

Honeycomb does not use any OS keychain or secret manager (Keychain Access on macOS, libsecret/gnome-keyring on Linux, Windows Credential Manager) for the device-flow token. The decision prioritizes cross-platform consistency and zero-dependency credential access inside bundled Node scripts: keychains require native bindings that would complicate the esbuild bundle and break in some CI environments.

The tradeoff is that `~/.deeplake/credentials.json` is readable by any process running as the same OS user. The mitigations are:

- File mode `0600` prevents other OS users from reading the file.
- The token is org-bound and carries a 365-day expiry. Rotating it is a single `honeycomb login` command.
- `HONEYCOMB_TOKEN` environment variable overrides the file entirely for short-lived CI contexts where no persistent credential is appropriate.

---

## Why a file, not SQLite

The credential is a **plaintext-shape JSON file**, deliberately, even though SQLite exists elsewhere in the tree. The choice is settled across both the auth and secrets layers:

- **SQLite in this codebase is only for the durable log store**, where it is allowed to degrade to in-memory when the runtime's `node:sqlite` is unavailable. A degrade-to-memory posture is fine for logs but unacceptable for a token, a login that silently evaporated on restart would be a footgun.
- **The pre-auth "boot-without-creds" dashboard phase depends on `loadCredentials()` returning `null` on a missing file**, a simple, robust contract a relational store complicates.
- **The secrets vault independently forbids SQLite**, and even its DeepLake-token migration is copy-not-move, leaving the credentials file byte-authoritative for the shared Hivemind login.
- **Byte-compatibility with Hivemind** requires the exact file shape Hivemind reads; a relational store would break the one-login-serves-both property.

Any future per-session/per-project scope is layered *beside* this file, not by migrating it into a database.

---

## Module Isolation Contract

`src/daemon/runtime/auth/credentials-store.ts` is intentionally kept free of any `fetch` calls. It exists so bundlers (particularly the harness plugin's esbuild config) can enforce per-file static-analysis rules that flag co-occurrence of `fs` reads/writes with network calls. Keeping IO and network in separate source files is an explicit architectural constraint, not an accident. The daemon, not this module, is the component that carries the token onto the network.
