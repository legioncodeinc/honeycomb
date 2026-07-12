# PRD-081b: Foundation Leaf Extractions

> **Parent:** [PRD-081: Daemon Assembly Modularization](./prd-081-daemon-assembly-modularization-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M-L (1-2 focused days)
> **Schema changes:** None
> **Blocked by:** PRD-081a

---

## Overview

This wave moves the lowest-coupling process concerns out of `assemble.ts`: single-instance locking,
mode-aware authentication composition, state-path resolution, and daemon tenancy resolution. These blocks
already have narrow inputs and substantial direct tests, so they establish the mechanical move pattern
before route or lifecycle extraction begins.

Every moved public symbol remains explicitly re-exported from `assemble.ts`. Existing callers and tests do
not change import paths.

---

## Goals

- Move cohesive leaf implementations without changing any call site behavior.
- Reduce Node filesystem/process imports in `assemble.ts`.
- Preserve instance-lock continuity across the fleet-root and legacy runtime directory.
- Preserve workspace, vault, queue, and agent-config path ownership.
- Preserve local/team/hybrid authentication construction.
- Preserve boot-frozen tenancy for injected storage and getter-backed live tenancy for production storage.
- Validate each destination directly while retaining facade-level regression tests.

## Non-Goals

- No resource-factory extraction from `assembleDaemon`.
- No route, worker, timer, or lifecycle changes.
- No change to lock race handling or partial-start cleanup semantics.
- No path migration beyond the migration behavior that already runs.
- No new environment variable or precedence change.

## User stories

- As a daemon maintainer, I want locking and path selection isolated from feature wiring so that process
  safety changes do not require editing the entire composition root.
- As a security reviewer, I want authentication and tenancy composition in narrow modules so that mode and
  scope boundaries can be audited without unrelated worker/mount code.
- As an existing caller, I want the facade imports to remain unchanged so that internal organization does
  not create downstream migration work.

---

## Exact move map

| Current source | Symbols / behavior | Destination |
|---|---|---|
| `assemble.ts:297-300`, `860-996` | `LOCK_FILE_NAME`, `PID_FILE_NAME`, `DaemonAlreadyRunningError`, `SingleInstanceLockOptions`, `resolveRuntimeDir`, `isPidAlive`, `acquireSingleInstanceLock`, `readPidFile`, `releaseSingleInstanceLock` | `src/daemon/runtime/assembly/instance-lock.ts` |
| `assemble.ts:1015-1046` | `composeAuthenticator`, `authForMode` | `src/daemon/runtime/assembly/auth.ts` |
| `assemble.ts:295`, `2018-2098`, `2112-2114` | `AGENT_CONFIG_FILE_NAME`, `workspaceBaseDirMemo`, `workspaceBaseDirCandidate`, `resolveWorkspaceBaseDir`, `resolveVaultBaseDir`, `resolveLocalQueueBaseDir`, `isWritableDir`, `resolveAgentConfigPath` | `src/daemon/runtime/assembly/state-paths.ts` |
| `assemble.ts:2100-2104` | `parseLocalQueueDiagnosticsSharedFlag` | Deferred to 081d's diagnostics mount or one shared `assembly/env.ts`; it is not path logic. |
| `assemble.ts:2124-2126` | `secretScopeFromQueryScope` | `src/daemon/runtime/assembly/tenancy.ts` |
| `assemble.ts:4354-4445` | `DaemonTenancy`, `resolveDaemonTenancy`, `asNonEmptyString`, `createLiveDaemonScope` | `src/daemon/runtime/assembly/tenancy.ts` |

`resolveRuntimeDir` may remain private to `instance-lock.ts` or move to `state-paths.ts`; the selected home
must not create a reverse import from a leaf module into `assemble.ts`.

---

## Destination contracts

### `assembly/instance-lock.ts`

Owns all PID/lock file behavior. It imports only Node filesystem/path primitives, state-root helpers, and
shared filesystem modes. It must preserve:

- acquisition before service warmup;
- live PID detection through signal `0`, including `EPERM` meaning alive;
- stale lock reclamation;
- legacy directory continuity during the state-root transition;
- upgrade-only legacy PID stamping where it already occurs;
- release that tolerates absent files;
- fixed filenames and file/directory modes;
- `DaemonAlreadyRunningError` fields and message shape used by callers/tests.

### `assembly/auth.ts`

Owns composition, not authentication implementation. It must:

- construct the token/API-key composite authenticator exactly once per daemon;
- continue using real token verification and API-key lookup;
- return local mode's existing open authorization policy;
- return team/hybrid mode's existing RBAC policy;
- preserve fail-closed defaults when authentication returns no identity;
- accept `StorageClient`, `QueryScope`, and `DeploymentMode` explicitly;
- avoid importing request middleware or server implementation details.

### `assembly/state-paths.ts`

Owns path selection and writability probes. It must preserve the distinction between:

- workspace-based state used for logs or workspace-local configuration;
- fleet-root state used for vault settings and local queues;
- explicit `HONEYCOMB_WORKSPACE` precedence and whitespace handling;
- `APIARY_HOME`/fleet-root behavior supplied by shared helpers;
- the one-cell `workspaceBaseDirMemo` cache;
- real create/remove writability probes rather than unreliable permission-only checks;
- `agent.yaml` explicit option, workspace candidate, and default resolution order;
- no write outside the selected/verified directory.

### `assembly/tenancy.ts`

Owns conversion among credential records, storage scope, and vault secret scope. It must preserve:

- environment org/workspace overrides winning over provider values;
- the same provider instance feeding storage and tenancy resolution;
- the `{ org: "local", workspace: "default" }` fallback for injected/no-credential deterministic tests;
- one boot snapshot for `orgName` and test-injected scope;
- production getter-backed scope using `createMtimeGatedResolver` so credentials can change without restart;
- optional workspace behavior;
- no token value copied into a scope or log;
- `secretScopeFromQueryScope` as a pure structural conversion.

---

## Files touched

### New source files

- `src/daemon/runtime/assembly/instance-lock.ts`
- `src/daemon/runtime/assembly/auth.ts`
- `src/daemon/runtime/assembly/state-paths.ts`
- `src/daemon/runtime/assembly/tenancy.ts`

### Modified source files

- `src/daemon/runtime/assemble.ts`: replace moved bodies with imports and explicit re-exports; keep calls in
  their original locations.

### Test files

Existing tests remain and may be supplemented with direct leaf suites:

- `tests/daemon/runtime/lock-continuity.test.ts`
- `tests/daemon/runtime/workspace-base-dir.test.ts`
- `tests/daemon/runtime/boot-without-credentials.test.ts`
- `tests/daemon/runtime/assemble.test.ts`
- `tests/daemon/storage/live-reload.test.ts`
- `tests/daemon/runtime/state-migration/upgrade-sequence.test.ts`
- new `tests/daemon/runtime/assembly/auth.test.ts` if current mode assertions are not isolated;
- new `tests/daemon/runtime/assembly/tenancy.test.ts` for reference identity and live getter behavior.

No existing test import is changed from `runtime/assemble.js` merely because the implementation moved.
Direct new tests may import the leaf module they own.

---

## Detailed implementation plan

1. Confirm PRD-081a is green and its public-surface test includes every public symbol moved in this wave.
2. Create `assembly/instance-lock.ts` with the required license header.
3. Move lock constants, types, public functions, and their private helpers as one contiguous unit. Preserve
   comments that explain legacy continuity and stale-lock behavior.
4. Add explicit facade re-exports for the lock API before deleting the original block.
5. Run lock-continuity and assembly tests immediately. Do not batch a lock failure with later moves.
6. Create `assembly/auth.ts`, move the two private auth composition helpers, and narrow imports to auth,
   storage, scope, and deployment-mode contracts.
7. Keep the call `authForMode(config.mode, storage, scope)` in the same relative construction position.
8. Run local/team/hybrid auth tests and credential-free boot tests.
9. Create `assembly/state-paths.ts` with the module-level workspace memo and all path/writability helpers.
10. Verify there is exactly one workspace memo cell after the move. Do not accidentally create a cache in
    both the facade and destination.
11. Keep `resolveVaultBaseDir()` and `resolveLocalQueueBaseDir()` fleet-root anchored. Do not derive them
    from `process.cwd()` or the resolved workspace.
12. Move `AGENT_CONFIG_FILE_NAME` with the agent-config resolver and re-export it from the facade.
13. Create `assembly/tenancy.ts`, move boot/live tenancy logic, and use type-only imports where possible.
14. Keep the production condition that selects live getter-backed scope only when storage is not injected
    and a provider exists.
15. Add/extend a reference-identity test proving consumers receive the same getter-backed `scope` object
    before and after a credential-file update while property reads reflect the update.
16. Search the repository for old private helper names and confirm no implementation was duplicated.
17. Run Biome formatting, `npm run ci`, and `npm run build`.

---

## Test plan

| Concern | Required proof |
|---|---|
| Live lock | A live PID prevents a second daemon; no service starts before the error. |
| Stale lock | A stale PID is reclaimed and the new PID is written. |
| Legacy continuity | A live legacy lock prevents double start during state-root migration. |
| Release | Release removes owned lock/PID state and tolerates absence/repetition. |
| Workspace resolution | Explicit workspace, writable cwd, and fleet-root fallback retain precedence and normalization. |
| Vault/local queue paths | Both remain cwd-independent and fleet-root anchored. |
| Agent config | Explicit option and resolved workspace path retain precedence; exported filename is unchanged. |
| Auth modes | Local remains open by design; team/hybrid require the composed authenticator and RBAC. |
| Boot tenancy | Environment/provider/fallback precedence is unchanged. |
| Live tenancy | Getter-backed scope re-reads changed credentials without replacing the scope object. |
| Secret safety | No token enters path, scope, error, or log outputs. |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | All lock symbols and behavior move to `assembly/instance-lock.ts`, remain re-exported from `assemble.ts`, and pass existing continuity/stale/release tests. |
| b-AC-2 | The daemon still acquires its lock before any health, graph, service, outbox, timer, or worker work. |
| b-AC-3 | Auth composition moves to `assembly/auth.ts` with unchanged local/team/hybrid outcomes and no new middleware dependency. |
| b-AC-4 | State-path logic moves to `assembly/state-paths.ts` with one workspace memo and unchanged workspace/fleet-root precedence. |
| b-AC-5 | Vault and local queue paths remain fleet-root anchored and independent of cwd. |
| b-AC-6 | Tenancy logic moves to `assembly/tenancy.ts`; injected storage retains a frozen scope while production retains one live getter-backed scope object. |
| b-AC-7 | Existing facade imports, `src/daemon/index.ts`, and all direct tests compile without import-path changes. |
| b-AC-8 | No moved module imports `runtime/assemble.ts`, no import cycle is introduced, and no implementation is duplicated. |
| b-AC-9 | Every new source file carries the license header. |
| b-AC-10 | `npm run ci` and `npm run build` pass. |

---

## Rollback

Each concern should be a separate mechanical commit where practical: lock, auth, paths, tenancy. Revert the
failing concern without reverting already-green leaf moves. No durable data or configuration rollback is
required.

## Open questions

None. `resolveRuntimeDir` may live in `instance-lock.ts` or `state-paths.ts`; the implementation selects the
cycle-free home while preserving the public and behavioral contracts above.
