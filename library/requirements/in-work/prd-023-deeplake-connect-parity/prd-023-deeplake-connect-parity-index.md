# PRD-023 — DeepLake Connect Parity (the `honeycomb login` flow, shared with Hivemind)

> Status: backlog · Owner: `/the-smoker` · Type: M (feature)
> Goal: a user runs ONE login and **both** Hivemind and Honeycomb connect to the same DeepLake — no hand-set env vars.

## Why

Hivemind (the shipping predecessor) connects to DeepLake via a device-flow `hivemind login` that writes `~/.deeplake/credentials.json`; its daemon/clients auto-read that file. Honeycomb already speaks the **identical** DeepLake REST wire protocol (`POST {apiUrl}/workspaces/{ws}/tables/query`, `Bearer` + `X-Activeloop-Org-Id`), and already has `login`/`logout`/`org`/`workspace` CLI verbs, a device-flow **seam**, a 0600 credentials store, and a `CredentialProvider` injection point. But it (a) leaves the real device-flow HTTP adapter deferred, (b) writes a *different* file (`~/.honeycomb/credentials.json`) with a *different* shape, and (c) makes the daemon read **env vars only**. PRD-023 closes the gap so Honeycomb replicates Hivemind's connect exactly and shares its credentials.

## Decisions

- **D-1 — Shared credentials file (the whole point).** Honeycomb reads + writes **`~/.deeplake/credentials.json`** in Hivemind's exact shape `{ token, orgId, orgName, userName, workspaceId, apiUrl, savedAt }`, mode `0600`, dir `0700`. One `hivemind login` OR `honeycomb login` authenticates **both** tools interchangeably. Back-compat: if `~/.deeplake/credentials.json` is absent, fall back to reading the legacy `~/.honeycomb/credentials.json`.
- **D-2 — Same backend, ported contract.** Default endpoint `https://api.deeplake.ai`. The device-flow + org/workspace + token-mint HTTP calls mirror Hivemind's exact contract (port the request/response shapes verbatim from `C:\Users\mario\GitHub\hivemind\src\commands\auth.ts`): `POST /auth/device/code`, poll `POST /auth/device/token`, mint long-lived `POST /users/me/tokens`, validate/whoami `GET /me`, list workspaces `GET /workspaces`.
- **D-3 — Daemon auto-connects from the file.** Add `deeplakeCredentialsFileProvider()` (a `CredentialProvider`). The daemon's default provider is **env-over-file**: a present `HONEYCOMB_DEEPLAKE_*` env var wins; otherwise the shared creds file supplies `{ endpoint←apiUrl, token, org←orgId, workspace←workspaceId }`. After `honeycomb login` with NO env vars set, the daemon connects.
- **D-4 — Security non-negotiables.** The token is NEVER printed, logged, echoed, or placed in an error message or URL. File is `0600`. The device flow opens ONLY the validated `verification_uri_complete` (safe-scheme check, as Hivemind does). `audit:sql`/`audit:openclaw` stay green; security-stinger close-out is mandatory (auth code).
- **D-5 — Reuse, don't rebuild.** Fill Honeycomb's existing device-flow seam (`src/daemon/runtime/auth/device-flow.ts`) with the real HTTP issuer; extend the existing `src/cli/auth.ts` / `src/cli/org.ts` verbs; do not duplicate the dispatcher. Interactive device flow is unit-tested with a fake issuer + a manual smoke script; the **token-login + file-shape + daemon-auto-connect** paths are automated in a gated live itest (the device flow's browser step can't be fully automated — same posture as Hivemind's own tests).

## Acceptance criteria

- **AC-1 — `honeycomb login` (device flow).** Runs RFC-8628 against `api.deeplake.ai` (`/auth/device/code` → prints + opens the verification URI → polls `/auth/device/token` → mints a long-lived token via `/users/me/tokens` → validates via `/me`) and writes `~/.deeplake/credentials.json` in the Hivemind shape (0600). Proven: unit test with a fake issuer drives the full happy path + pending-poll + expiry; the written file parses to the exact Hivemind shape.
- **AC-2 — Headless/CI login.** `HONEYCOMB_TOKEN=<key> honeycomb login` (and/or `--token`) skips the browser, validates via `/me`, and saves the shared file — parity with `HIVEMIND_TOKEN`.
- **AC-3 — `honeycomb whoami`.** GETs `/me`, prints the authenticated user + active org + workspace (NEVER the token). Reads the shared file; works against a file written by `hivemind login`.
- **AC-4 — `honeycomb org list` + `org switch <name|id>`.** `org list` enumerates the user's orgs from the backend; `org switch` re-mints for the target org and updates the shared file. (Honeycomb's existing `org switch` re-mint is extended; `org list` is new.)
- **AC-5 — `honeycomb workspaces` + `workspace switch <name|id>`.** `workspaces` lists from `GET /workspaces`; `workspace switch` updates `workspaceId` in the shared file.
- **AC-6 — `honeycomb logout`.** Removes the shared creds file (and the legacy path); exits 0 even if absent; never errors on a missing file.
- **AC-7 — Daemon auto-connect from the shared file.** `deeplakeCredentialsFileProvider()` reads `~/.deeplake/credentials.json`; the daemon's default provider is env-over-file. With NO `HONEYCOMB_DEEPLAKE_*` env and a valid shared file, the assembled daemon resolves a valid `StorageConfig` and connects. Unit-proven (fake fs) + the live itest below.
- **AC-8 — Live parity proof (gated).** A gated `.itest.ts`: seed `~/.deeplake/credentials.json` (token from env, Hivemind shape) in a temp HOME → boot the assembled daemon with NO `HONEYCOMB_DEEPLAKE_*` env → it connects from the file → a store→recall through `/api/memories/recall` succeeds live. AND assert the file Honeycomb writes is byte-shape-compatible with what Hivemind reads (cross-tool interchange).
- **AC-9 — Security.** No token in any log/stdout/stderr/error/URL (grep-proven in tests); file is 0600 (POSIX; best-effort + documented on win32); device-flow opens only the validated verification URI. `npm run ci`/`build`/`audit:sql`/`audit:openclaw`/invariant all green.

## Out of scope

- Changing the DeepLake wire protocol (already identical).
- Team-mode RBAC changes (PRD-011 owns that).
- Migrating existing `~/.honeycomb` users automatically beyond read-fallback (D-1).

## Reference (port from these)

- Hivemind connect: `C:\Users\mario\GitHub\hivemind\src\commands\auth.ts` (device flow + token mint + `/me` + `/workspaces`), `src\commands\auth-creds.ts` (creds file shape/path), `src\config.ts` (env + creds resolution), `src\deeplake-api.ts` (transport — already mirrored).
- Honeycomb current: `src/cli/auth.ts`, `src/cli/org.ts`, `src/daemon/runtime/auth/device-flow.ts`, `src/daemon/runtime/auth/credentials-store.ts`, `src/daemon/storage/config.ts` (`CredentialProvider`), `src/commands/contracts.ts` (`VERB_TABLE`/`AUTH_SUBCOMMANDS`).
