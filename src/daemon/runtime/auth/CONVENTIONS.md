# Auth & Tenancy module — CONVENTIONS (PRD-011)

The fail-closed auth/tenancy layer lives under `src/daemon/runtime/auth/`
(daemon-only — the CredentialsStore touches `node:fs`/the home dir but opens NO
DeepLake; the per-concern CLIs import this module's contracts, never
`src/daemon/storage`, which `tests/daemon/storage/invariant.test.ts` enforces).
Wave 1 built the shared contracts + the four seams, the CredentialsStore (0600),
011a org/workspace resolution + the `honeycomb org/workspace/status` CLI, the
evolved permission middleware (the 011c harness), the 011e e-AC verification
against the existing `buildScopeClause`, and the 011b/011c/011d stubs. Wave 2's
three concerns each fill ONE area + its test, contention-free.

**Read this file before filling a stub.** It is the contract Wave 2 follows.

## The central thesis: FAIL CLOSED. When in doubt, DENY.

This is the security-critical auth layer; every default is the most restrictive:

- The default `AuthorizationPolicy` (`defaultDenyPolicy`) returns `"forbidden"` for
  every input. The default `Authenticator` (`alwaysUnauthenticated`) returns `null`
  → 401. The default `SocketPeerProbe` (`noSocketPeer`) trusts NO peer, so `hybrid`
  requires a token (c-AC-1).
- `verifyTokenClaims` returns `null` on ANY malformed/unverifiable token — never a
  partial claim set. `loadCredentials` returns `null` on a missing OR malformed file
  — never a partial credential (b-AC-3).
- `resolveTenancy` REJECTS a credentials file whose `orgId` disagrees with the
  token's verified org claim (a-AC-5 / D-4); it never honors the file.

If you find yourself adding an "allow by default" branch or a "best-effort widen on
error" path, STOP — that is the wrong direction for this module.

## Identity is RESOLVED, never asserted (the no-header-role rule)

The `Identity` (`{ org, workspace, agentId, role, project? }`) is the VALIDATED
caller — produced by an `Authenticator` from a token/key, **never read from a
header**. The middleware takes the role/org/project ONLY from an `Identity`. The
004a `x-honeycomb-role` trust path is REMOVED: a header-asserted role is a
privilege-escalation bypass (c-AC-2). Org/workspace headers survive ONLY as a
tenancy HINT the authenticator cross-checks against the token; the project header /
`?project=` is a HINT the policy compares to the Identity's OWN project binding —
never a grant.

> The legacy header path still exists in ONE isolated, opt-in place:
> `legacyPermissionCheckAdapter` (permission.ts), wired only when a caller injects
> the deprecated `permissionCheck` (the 004a server tests). New code MUST NOT use it.

## The secret is never persisted/logged/dumped

- `Credentials.token` is a secret. `Credentials` is NEVER logged, and
  `honeycomb status` prints every field EXCEPT the token (a-AC-6). The org-switch
  output also never prints the token.
- `ApiKeyRecord` holds `keyHash` ONLY — no plaintext-key field by construction
  (d-AC-1). `createApiKey` returns the plaintext ONCE to print; it is never written
  to disk or a log.
- `savedAt` is ALWAYS stamped server-side from the injected clock on write, ignoring
  any caller value (b-AC-4).
- The file is `0600`, its dir `0700`, enforced on POSIX; on win32 the bits are a
  documented best-effort no-op (NTFS ACLs apply) and the perm-assert test guards on
  `process.platform !== "win32"`.

## The 4-role RBAC matrix (D-1) — 011c implements

```
role       | read | write | admin routes | token / connectors-admin routes
-----------+------+-------+--------------+--------------------------------
admin      | yes  | yes   | yes          | yes
member     | yes  | yes¹  | no           | no
readonly   | yes  | NO→403| no           | no
agent      | yes² | yes²  | no           | NO→403   (connector; no admin/token)
```

¹ member writes within its own org/workspace/project scope only.
² agent reads+writes its own scoped data; denied every admin/token/connectors-admin
  route (c-AC-6 / d-AC-3).

Project scope rides ON TOP of the role: a token/key bound `project=alpha` targeting
`project=beta` is denied unless `admin` (c-AC-5 / d-AC-6).

## The modes (D-2) — already routed by the middleware

- `local`  → open. No auth, no check, no rate limit (c-AC-4 / d-AC-5).
- `team`   → token/API-key required; RBAC enforced. No credential → 401; valid
  credential + insufficient perm → 403.
- `hybrid` → fail-closed: with no trustworthy socket-peer signal, require a token;
  NEVER trust the `Host` header (c-AC-1). The `SocketPeerProbe` seam carries the
  peer signal; the default trusts nothing.

## Shared files — DO NOT TOUCH (Wave-1 surface)

| File | What it owns |
|---|---|
| `contracts.ts` | `Role`/`ROLES`, `Identity`, `Credentials`, `TokenClaims`, `ApiKeyRecord`, `AuthDecision`, `Mode`; the `TokenIssuer`/`Authenticator`/`AuthorizationPolicy` seams (+ fakes + `defaultDenyPolicy`/`alwaysUnauthenticated`); `verifyTokenClaims`/`encodeStubToken`; `notImplemented`. A genuinely new cross-module field is a Wave-1 change (raise it), not a stub edit. |
| `credentials-store.ts` | `loadCredentials`/`saveCredentials` (0600/0700, env rules, savedAt stamp), `resolveTenancy` (env overrides + the org-claim integrity gate), `TenancyIntegrityError`. |
| `tenancy-resolution.ts` | `resolveRequestTenancy` — credentials+env → the `QueryScope` partition, fail-closed. |
| `permission.ts` (middleware) | The evolved `permissionMiddleware(group, getMode, { authenticator, policy, socketPeer })` (401 vs 403, no header role) + the `noSocketPeer`/`SocketPeerProbe` seam + the legacy adapter. 011c fills the POLICY (rbac.ts), not this wiring. |

## Where each Wave-2 area fills + what it MUST NOT touch

| Area | Fill | Test | MUST NOT touch |
|---|---|---|---|
| 011b device-flow + auth CLI | `device-flow.ts` (`deviceFlowLogin`, `createTokenAuthenticator`) + `src/cli/auth.ts` (CREATE) | `tests/daemon/runtime/auth/device-flow.test.ts`, `tests/cli/auth.test.ts` | contracts.ts, credentials-store.ts (the IO discipline), permission.ts |
| 011c modes + RBAC | `rbac.ts` (`createRbacPolicy` — the matrix + project gate) | `tests/daemon/runtime/auth/rbac.test.ts` (or via the middleware) | contracts.ts, permission.ts (the wiring already calls `policy.decide`) |
| 011d api-keys + rate-limit + keys CLI | `api-keys.ts` (create/validate/revoke, scrypt reconcile of `hashApiKey`) + `rate-limit.ts` + `src/cli/keys.ts` (CREATE) | `tests/daemon/runtime/auth/api-keys.test.ts`, `tests/daemon/runtime/auth/rate-limit.test.ts`, `tests/cli/keys.test.ts` | contracts.ts, permission.ts, credentials-store.ts |

Keep the `notImplemented` throwers honest until the real body lands — never
fake-pass. A premature call surfaces the owning sub-PRD.

## The fake test posture (no real auth server, no real secrets, no real home dir)

- `createFakeTokenIssuer(script)` — script the device-code grant, the ordered
  `pollToken` sequence (`["pending", "pending", token]`), and the `reMint` org→token
  table. No real auth server. Build a stub token with `encodeStubToken(claims)` so it
  decodes back via `verifyTokenClaims`.
- `createFakeAuthenticator(table)` — key (bearer/api-key) → `Identity`; a miss →
  `null` (401). Drives the middleware 401-vs-403 split.
- A test injects a `dir` (a temp dir) + a fake `Clock` into the CredentialsStore /
  org CLI so the real `~/.honeycomb` and wall clock are never touched.
- Drive the middleware via `daemon.app.request(...)` (in-process; no socket).

## 011e: the scope clause is canonical — DO NOT rebuild (D-8)

`buildScopeClause` (`recall/scope-clause.ts`) is THE inner-ring authorization
chokepoint and already integrated in `recall/authorization.ts`. 011e is
VERIFICATION: `tests/daemon/runtime/auth/scope-clause-policy.test.ts` asserts the
six e-ACs against the EXISTING builder (isolated/shared/group WHERE fragments,
escaped values, archived-excluded, fallback-to-isolated, IDs-before-content). These
PASS against existing code; a genuine failure is a real finding to report, not to
paper over. The live proof already exists (`recall-authz-live.itest.ts`).

## Live itest (opt-in)

`tests/integration/api-keys-live.itest.ts` — gated on `HONEYCOMB_DEEPLAKE_TOKEN`,
throwaway `ci_api_keys_<runid>` in `honeycomb_ci`, DROP cleanup. Models the
gating/cleanup on `recall-authz-live.itest.ts`: `queryTimeoutMs: 120_000` for
first-touch heal; if a read-back reads >1 freshly-written row, POLL-AND-UNION (the
`scanDistinct`/`SCAN_POLLS` pattern). Asserts NO plaintext key on disk. 011d fills
the real create/hash/revoke; Wave 1 scaffolds the shape (it may use the existing
`hashApiKey`/`api_keys` builders directly for the smoke). Do NOT run it locally (no
creds) — the orchestrator runs it.

## Daemon assembly is DEFERRED (D-9)

Wave 1 is constructed-and-tested, not wired into the running daemon:

- The daemon swaps the default `{ authenticator: alwaysUnauthenticated, policy:
  defaultDenyPolicy }` for the COMPOSED real authenticator (011b token ∘ 011d
  api-key) + the real RBAC policy (011c) + a real `SocketPeerProbe` — a documented
  TODO at `createDaemon`. Until then the daemon stays fail-closed by default.
- The per-concern CLIs (`org.ts` 011a, `auth.ts` 011b, `keys.ts` 011d) register on
  the `honeycomb` bin at the assembly step. Each is constructed-and-tested with
  injected fakes today.

Keep every export's signature stable so the assembly is a pure wiring step.
