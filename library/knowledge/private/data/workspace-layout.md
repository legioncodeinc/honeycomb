# Workspace Layout

> Category: Data | Version: 1.0 | Date: June 2026 | Status: Active

The on-disk shape of a Honeycomb workspace: the identity files that shape the next agent turn, the pointer to the DeepLake-backed store, and how the workspace path is resolved.

**Related:**
- [`schema.md`](schema.md)
- [`deeplake-storage.md`](deeplake-storage.md)
- [`../ai/pollinating-loop.md`](../ai/pollinating-loop.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../multi-tenant/org-workspace-model.md`](../multi-tenant/org-workspace-model.md)
- [`../security/secrets.md`](../security/secrets.md)
- [`../architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md`](../architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md)

---

## Why the workspace matters

The workspace is the thing the user actually owns. Models, providers, and harnesses change; the workspace persists. It holds two kinds of state that serve different masters: readable identity files that live on the local filesystem and directly shape the next agent turn, and durable application state that lives in the team-shared, GPU-backed DeepLake store the daemon manages. The local directory is the user's identity surface and the seam they read, back up, and move. The DeepLake store is the canonical persistence layer for everything the engine produces.

This split is the whole custody pitch. A workspace maps to a tenancy boundary: an org owns workspaces, and a workspace is the unit that scopes every durable row (see [`../multi-tenant/org-workspace-model.md`](../multi-tenant/org-workspace-model.md)). The local files are the readable face of that workspace; DeepLake is its durable body.

## Two roots, not one

Honeycomb resolves two independent on-disk roots, and conflating them is the source of a whole class of bugs (see the trailing-space section below). Keep them distinct:

1. The **fleet state root** is the neutral, home-anchored directory the fleet coordinates under. As of PR #229 (PRD-072) it moved from the original `~/.honeycomb/` to `~/.apiary/honeycomb/`, per ADR-0008 (the honeycomb-local mirror of the superproject fleet-directory ADR, see [`../architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md`](../architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md)). This root holds honeycomb's own runtime state: the PID and single-instance lock, telemetry SQLite, the machine key, the skillify lock/state, the graph cache, and the secrets store and vault. It is resolved from `os.homedir()` through the Tier-1 canonical chain in `src/shared/fleet-root.ts`, never from `process.cwd()`.

2. The **workspace base dir** is the user-owned identity surface: the directory `$HONEYCOMB_WORKSPACE` points at (default `~/.honeycomb/`). It anchors `agent.yaml`, the identity markdown files, `.secrets/`, and `.daemon/logs.db`. It is resolved separately by `resolveWorkspaceBaseDir`, described below.

The two often coincide on a default single-machine install, but they are resolved by different code paths and can diverge. The directory tree below shows the workspace base dir (the identity surface); the fleet state root under `~/.apiary/honeycomb/` is described in [the fleet state root](#the-fleet-state-root-and-the-apiary-migration) section.

## The directory tree

`$HONEYCOMB_WORKSPACE` (the workspace base dir) defaults to `~/.honeycomb/`.

```text
$HONEYCOMB_WORKSPACE/                 (default ~/.honeycomb/)
├── agent.yaml                        # main config
├── AGENTS.md                         # operating instructions (synced to harnesses)
├── SOUL.md                           # optional personality and values
├── IDENTITY.md                       # optional identity metadata
├── USER.md                           # optional user profile and relationship context
├── MEMORY.md                         # generated working-memory summary
├── POLLINATING.md                       # optional pollinating-session prompt (not loaded normally)
├── HEARTBEAT.md                      # optional background-check prompt
├── BOOTSTRAP.md                      # optional first-run prompt
├── memory/
│   ├── store.json                    # connection pointer to the DeepLake-backed store
│   └── scripts/                      # python bridge for harness hooks
├── skills/                           # user-authored skills
├── .secrets/                         # encrypted secrets (git-ignored)
├── .daemon/
│   ├── logs/                         # daemon logs
│   └── auth-secret                   # local-mode token signing key (0600)
├── agents/
│   └── <agent-name>/                 # per-agent identity overrides
├── .sigignore                        # watcher ignore patterns
└── .git/                             # optional auto-committed history
```

The one structural change from older single-machine layouts: there is no local database file under `memory/`. What used to be a `memories.db` SQLite file is now a connection pointer (`store.json`) to the DeepLake-backed store the daemon owns. Durable rows do not sit on the user's disk; they live in DeepLake. The local tree holds identity, config, secrets, scripts, and logs only.

## The identity files

These files are the seams the project cares most about, because they go directly into the next agent turn rather than sitting in a database row.

`agent.yaml` is the main config: agent metadata, harnesses, embedding provider, search tuning, the pipeline (`memory.pipelineV2`) config, the identity preset, hooks, auth, the org/workspace binding, and the inference routing block. The loader checks `agent.yaml`, then `AGENT.yaml`, then `config.yaml`. Every section is optional with sensible defaults.

`AGENTS.md` is the operating-instruction file. The watcher syncs it on change into harness-specific copies (for example `~/.claude/CLAUDE.md` and `~/.config/opencode/AGENTS.md`), each stamped with a generated header and a do-not-edit warning so nobody hand-edits a downstream copy.

`SOUL.md`, `IDENTITY.md`, and `USER.md` are optional. They carry personality and values, identity metadata, and user context for harnesses that split personality from instructions.

`MEMORY.md` is generated. The synthesis worker rebuilds it from durable memories, thread heads, and the session ledger, all read from DeepLake. It is a working summary loaded at session start, not canonical history, and it should not be hand-edited. On regeneration the daemon backs up the previous copy before writing the new one.

`POLLINATING.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md` are special-session prompts that are not part of normal startup. `POLLINATING.md` in particular is loaded only for the pollinating pass described in [`../ai/pollinating-loop.md`](../ai/pollinating-loop.md).

## Identity loading presets

The identity preset decides which files load at startup and in what order.

| Preset | Startup load order | Special files |
|---|---|---|
| `minimal` (default) | `AGENTS.md` | `POLLINATING.md` for pollinating sessions |
| `hermes` | `SOUL.md`, then `AGENTS.md` | matches Hermes SOUL-primary convention |
| `openclaw` | `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` | `HEARTBEAT.md`, `POLLINATING.md`, `BOOTSTRAP.md` |
| `custom` | user-specified ordered list | user-specified |

Each entry in a preset carries a path, a role (such as `operating_instructions` or `user_profile`), and a token budget.

## Per-agent overrides

Multiple named agents share one daemon and one DeepLake store but get their own identity directory under `agents/<name>/`. Each can carry its own `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, and the rest, with the workspace root used as the fallback when an agent-specific file is absent. Identity files are local; durable separation between agents within a workspace is enforced in the store by `agent_id` scoping and visibility, covered in [`../security/scoping-and-visibility.md`](../security/scoping-and-visibility.md).

## Workspace resolution

The active workspace path is resolved in order:

1. the `--path` CLI flag,
2. the `HONEYCOMB_PATH` environment variable,
3. the stored CLI setting in `~/.config/honeycomb/workspace.json`,
4. the default `~/.honeycomb/`.

The stored setting is written by `honeycomb workspace set <path>`. The store connection itself is configurable via `memory.store`, which resolves to the DeepLake table namespace for this org and workspace rather than to a local file path.

## Daemon workspace resolution and the writability probe

The resolution order above is the CLI-side rule. The daemon resolves its own filesystem root separately, and the two must agree or the daemon writes its `.secrets/`, `.daemon/`, and `agent.yaml` somewhere the CLI never looks. Inside the daemon, `assemble.ts` derives the secrets-store and log-store base directory from `HONEYCOMB_WORKSPACE ?? process.cwd()`. A detached daemon inherits the cwd of whatever spawned it, so if the CLI launches it without pinning that environment the daemon can land on an arbitrary directory.

On Windows that arbitrary directory is the trap. A CLI invoked from a service or a stray shell sits in `C:\WINDOWS\system32`, which is not writable by a normal user. With `HONEYCOMB_WORKSPACE` unset the daemon then resolves its root to `system32`, every secret write throws `EACCES`, and the secrets handler returns a `502 store_failed` with no audit trail because the swallowed log writes fail silently too. `GET /api/secrets` also reads empty. This is an application 502, not a proxy failure, and it was the observed cause of secrets saves failing from the Settings page.

Two layers now keep the daemon on writable ground:

1. The CLI pins both `cwd` and `HONEYCOMB_WORKSPACE` when it spawns the daemon. `resolveDaemonWorkspace()` returns the first writable of an explicit `HONEYCOMB_WORKSPACE`, the CLI cwd, then `~/.honeycomb`.
2. The daemon repeats the same fallback as defense in depth. `resolveWorkspaceBaseDir()` is memoized, probes the candidate, and on failure falls back to `~/.honeycomb` after writing a one-line stderr warning so the operator sees the substitution. It derives its candidate through the pure `workspaceBaseDirCandidate(env)` helper, which trims `HONEYCOMB_WORKSPACE` before use (see [the two-source trailing-space bug class](#the-two-source-trailing-space-bug-class)).

Writability is tested by a real create-write-unlink round trip, not by `accessSync(W_OK)`. On Windows `accessSync` inspects the read-only attribute rather than the ACL, so `system32` falsely reports writable. The honest probe (`canWriteDir`) does `mkdirSync` then creates and removes an exclusive `mkdtemp` directory inside the candidate. The randomly suffixed temp name means the probe only ever creates and deletes a path it owns, so it can never truncate or remove a pre-existing workspace file the way a deterministic marker name could. The runtime directory that holds the PID and single-instance lock is always resolved from the home directory (the fleet state root) and is never affected by this fallback.

## The fleet state root and the .apiary migration

PR #229 (PRD-072) moved honeycomb's runtime state out of the workload-branded `~/.honeycomb/` and into the neutral, home-anchored fleet root `~/.apiary/honeycomb/`. The motivation and the four-repo contract are in ADR-0008; this section covers what it means for honeycomb's on-disk shape.

The canonical resolver lives in `src/shared/fleet-root.ts` and is Tier-1 (imported, not duplicated, inside honeycomb). It resolves the root from `os.homedir()` down a fixed chain: an absolute `APIARY_HOME`, then on Linux an absolute `$XDG_STATE_HOME` joined with `apiary`, otherwise `<home>/.apiary`. Per-product state is that root plus `/honeycomb`; the shared coordination surface (`registry.json`, `device.json`, `install-id`) sits at the root itself.

**Env roots are honored only when absolute.** A relative `APIARY_HOME` or `$XDG_STATE_HOME` is ignored and the chain falls through to `<home>/.apiary`. This is a security fix, not a convenience: honoring a relative value would anchor the fleet root, and everything derived from it including the machine key that encrypts secrets, on `process.cwd()`, which is the exact cwd footgun the neutral root exists to prevent. Absoluteness is checked with `path.win32.isAbsolute` so a relative value is never mistaken for absolute on any host.

The move runs once, on first boot after upgrade, and covers seven families of state (`src/daemon/runtime/state-migration/{families,index,migrate,move}.ts`). It is non-destructive: the migration primitives distinguish a migrated move (legacy files carried into the new layout) from a freshly minted directory, and until the migration completes readers fall back to the legacy `~/.honeycomb` location so a partially-migrated install never loses pid, lock, or registry continuity. Several families get bespoke handling:

- **Telemetry SQLite:** if the mover fails, it opens the legacy database in place rather than minting a fresh empty one and stranding the history (`src/daemon/runtime/state-migration/telemetry/{fleet-registry,fleet-store}.ts`).
- **Skillify lock and state:** cut over with a legacy in-flight probe so an in-progress skillify run is not orphaned.
- **Graph cache:** not moved, rebuilt lazily under the new root on next use.
- **Machine key:** byte-verified after the move so a corrupted or partial copy is caught before it is trusted to decrypt secrets.

**Registry writes never double-write.** A registry-window write goes to `~/.apiary/registry.json` when the fleet root exists, else to the legacy path, never to both, and always advertises the daemon's resolved absolute paths rather than a path relative to some cwd.

**VFS memory-mount dual recognition.** The virtual filesystem that fronts memory recognizes both the new `.apiary/honeycomb/memory` mount and the legacy `.honeycomb/memory` mount during the migration window. The matcher is hardened against Windows backslash and case bypass so neither `\.apiary\honeycomb\memory` nor a case-shifted variant can slip a path past the recognizer.

The installer pins `APIARY_HOME` into the service units so a daemon launched by the service manager resolves the same absolute root the CLI does. The secrets store and the unified vault both move under the new root; their contract is in [`../security/secrets.md`](../security/secrets.md).

## The two-source trailing-space bug class

The two roots are resolved by two resolvers, and each reads a different environment variable, so a stray trailing space can strand state in a divergent directory in two independent ways. Understanding both is the point of keeping the roots distinct.

The v0.5.7 fix trimmed `APIARY_HOME` and quoted the scheduled-task `set` assignments, which corrected the fleet-root side: telemetry SQLite and the state directory started landing at the clean path. But that was only the first source. PR #238 caught the second: the workspace base dir is resolved by `resolveWorkspaceBaseDir`, which reads `HONEYCOMB_WORKSPACE` and, before the fix, did not trim it. Observed live on 0.5.7, telemetry landed at the clean fleet-root path while `.daemon/logs.db`, `.secrets/`, and `agent.yaml` landed in a divergent `"<dir> "` trailing-space directory that the CLI and the uninstaller never look in. Because the secrets store is anchored to the workspace base dir, this splits the vault: a `DEEPLAKE_TOKEN` written on one side is invisible on the other, which can break inference-key delivery and therefore session-to-memory consolidation.

PR #238 fixed the workspace side by extracting a pure, exported `workspaceBaseDirCandidate(env)` that trims `HONEYCOMB_WORKSPACE` (a whitespace-only value collapses to `process.cwd()`); `resolveWorkspaceBaseDir` now delegates to it. The lesson the two PRs together encode: any environment variable that feeds a root resolver must be trimmed at the resolver, because a trailing space is invisible in a shell yet forms a real, distinct directory name on disk. There are two such variables (`APIARY_HOME` for the fleet root, `HONEYCOMB_WORKSPACE` for the workspace base dir) and both are now hardened.

## What lives where, and why DeepLake

Application state, memories, embeddings, the graph, jobs, sessions, telemetry, lives in DeepLake tables the daemon owns. Embeddings are 768-dim `nomic-embed-text-v1.5` vectors stored as DeepLake tensors. Tables are created lazily with lazy schema-healing, the query endpoint has no parameterized queries (values are escaped and interpolated), structured payloads are `jsonb`, and concurrent-edit tables use append-only version-bumped writes to work around an UPDATE-coalescing quirk. The full schema is documented in [`schema.md`](schema.md) and the storage mechanics in [`deeplake-storage.md`](deeplake-storage.md).

Local JSON and JSONL sidecars are not allowed as the default for app state, caches, queues, indexes, or cursors; those belong in DeepLake. Sidecars are fine only for genuine user-facing artifacts: import and export bundles, attachments, logs, and backups. Secrets are the one thing that never lives in DeepLake or the identity files; they sit encrypted under `.secrets/` (with the vault and secrets store now under the migrated `~/.apiary/honeycomb/` fleet root), as described in [`../security/secrets.md`](../security/secrets.md).
