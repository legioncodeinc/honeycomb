# PRD-011b: Device-Flow Auth

> **Parent:** [PRD-011](./prd-011-tenancy-and-auth-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

OAuth 2.0 device-flow login that mints a long-lived org-bound token, persistence of that token in `~/.honeycomb/credentials.json` at mode `0600` through three IO helpers, and best-effort org-drift healing on session start. This PRD owns identity establishment and on-disk credential storage; what an authenticated caller may touch is PRD-011c, and how tenancy is carried per request is PRD-011a.

## Goals

- Establish identity through the OAuth 2.0 Device Authorization Flow so no password is ever sent and the short-lived access token is discarded rather than persisted.
- Mint a long-lived org-bound token (365-day expiry) and persist it with org id, org name, user name, workspace id, and daemon URL.
- Confine all credential disk access to three helpers in `auth-creds.ts` (`loadCredentials`, `saveCredentials`, `deleteCredentials`) and keep that module free of `fetch`.
- Heal a drifted org token on session start, best-effort, logging a warning and continuing on failure rather than blocking.

## Non-Goals

- RBAC roles, daemon modes, API keys, and rate limiting (PRD-011c, PRD-011d).
- The org/workspace partition isolation and switch commands (PRD-011a).
- Any OS keychain or secret manager integration; the security model relies on file-system permissions only.
- The encrypted secrets subsystem (PRD-012), which shares neither file nor code path with this credential.

## User stories

- As a developer, I want to log in through a browser device flow so that no password is ever sent and my org-bound token persists across restarts.
- As a developer who switched orgs on another machine, I want the daemon to heal my drifted token on session start so I do not have to log in again.
- As a security reviewer, I want all credential disk access funneled through three audited helpers so I can reason about file permissions in one place.

## Functional requirements

- FR-1: Login MUST use the OAuth 2.0 Device Authorization Flow: the CLI requests a device code, presents a verification URL, the user approves in a browser, and the CLI polls until the daemon returns a token.
- FR-2: The daemon MUST mint a long-lived, org-bound JWT (365-day expiry); the short-lived access token from the flow MUST be discarded, not persisted.
- FR-3: Org selection MUST follow the priority order: environment override, then the token's `org_id` claim, then the first org; workspace MUST resolve from the `default` sentinel server-side.
- FR-4: `saveCredentials` MUST create `~/.honeycomb/` with mode `0700` (idempotent, mode applied only on creation) and write `credentials.json` with mode `0600`, overwriting `savedAt` with the current ISO 8601 timestamp on every write.
- FR-5: `loadCredentials` MUST return `null` for any failure (missing file, permission denied, malformed JSON) without an `existsSync`-then-`readFileSync` TOCTOU pattern; callers treat `null` as "not logged in" and prompt `honeycomb login`.
- FR-6: `deleteCredentials` MUST `unlinkSync` the file and return `true` on removal, `false` for any failure; `logout` reports "Not logged in." on `false` rather than an error.
- FR-7: On session start the daemon MUST decode the token's org claim, compare it to the configured org, and re-mint when they disagree, then realign the stored org name and workspace; on healing failure it MUST log a warning and continue with the stale token.
- FR-8: The `auth-creds.ts` module MUST contain no `fetch` calls so the bundler can statically flag co-occurrence of `fs` IO with network calls; the daemon, not this module, carries the token onto the network.
- FR-9: `HONEYCOMB_TOKEN` MUST override the credentials file entirely for short-lived CI contexts where no persistent credential is appropriate.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the device flow, when the user approves in the browser, then the CLI polls, receives a long-lived org-bound token, and writes `credentials.json` at mode `0600` (directory `0700`). |
| AC-2 | Given a token whose org claim disagrees with the active org, when a session starts, then the daemon re-mints and realigns org name and workspace, logging a warning and continuing on failure. |
| AC-3 | Given a missing or malformed `credentials.json`, when `loadCredentials` runs, then it returns `null` and the CLI prompts the user to log in. |
| AC-4 | Given a successful login, when the credential is written, then `savedAt` is the current timestamp regardless of any value passed in. |
| AC-5 | Given `HONEYCOMB_TOKEN` is set, when a command runs, then the env token is used and the file is not read for the token. |
| AC-6 | Given `honeycomb logout` with no existing file, when it runs, then it prints "Not logged in." and returns success, not an error. |

## Implementation notes

- All disk access flows through `loadCredentials` / `saveCredentials` / `deleteCredentials` in `src/commands/auth-creds.ts`; no other module touches the file. The module is kept free of `fetch` by design.
- Path accessors `configDir()` (`~/.honeycomb`) and `credsPath()` (`~/.honeycomb/credentials.json`) are lazy (re-evaluated per call) so tests can override `HOME` between cases.
- On Windows the mode bits are silently ignored; protection relies on the user profile directory being OS-protected. Confirm Windows posture before GA.
- The daemon listens on port 3850 and is the only DeepLake client; the credential proves identity to that daemon and the backend.

## Dependencies

- PRD-011a (org/workspace) consumes the org-bound token claim and the persisted `workspaceId`.
- PRD-011c (modes and RBAC) consumes the token for Bearer authentication in `team` and `hybrid` modes.

## Open questions

- [ ] Confirm the Windows credential-protection posture given mode bits are ignored.
- [ ] Should drift healing re-mint silently or surface a one-line notice to the user on session start?

## Related

- [parent index](./prd-011-tenancy-and-auth-index.md)
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md)
- [Credential Storage](../../../knowledge/private/security/credential-storage.md)
