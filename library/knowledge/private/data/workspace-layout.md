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

---

## Why the workspace matters

The workspace is the thing the user actually owns. Models, providers, and harnesses change; the workspace persists. It holds two kinds of state that serve different masters: readable identity files that live on the local filesystem and directly shape the next agent turn, and durable application state that lives in the team-shared, GPU-backed DeepLake store the daemon manages. The local directory is the user's identity surface and the seam they read, back up, and move. The DeepLake store is the canonical persistence layer for everything the engine produces.

This split is the whole custody pitch. A workspace maps to a tenancy boundary: an org owns workspaces, and a workspace is the unit that scopes every durable row (see [`../multi-tenant/org-workspace-model.md`](../multi-tenant/org-workspace-model.md)). The local files are the readable face of that workspace; DeepLake is its durable body.

## The directory tree

`$HONEYCOMB_WORKSPACE` defaults to `~/.honeycomb/`.

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
2. The daemon repeats the same fallback as defense in depth. `resolveWorkspaceBaseDir()` is memoized, probes the candidate, and on failure falls back to `~/.honeycomb` after writing a one-line stderr warning so the operator sees the substitution.

Writability is tested by a real create-write-unlink round trip, not by `accessSync(W_OK)`. On Windows `accessSync` inspects the read-only attribute rather than the ACL, so `system32` falsely reports writable. The honest probe (`canWriteDir`) does `mkdirSync` then creates and removes an exclusive `mkdtemp` directory inside the candidate. The randomly suffixed temp name means the probe only ever creates and deletes a path it owns, so it can never truncate or remove a pre-existing workspace file the way a deterministic marker name could. The `~/.honeycomb` runtime directory that holds the PID and single-instance lock is always resolved from the home directory and is never affected by this fallback.

## What lives where, and why DeepLake

Application state, memories, embeddings, the graph, jobs, sessions, telemetry, lives in DeepLake tables the daemon owns. Embeddings are 768-dim `nomic-embed-text-v1.5` vectors stored as DeepLake tensors. Tables are created lazily with lazy schema-healing, the query endpoint has no parameterized queries (values are escaped and interpolated), structured payloads are `jsonb`, and concurrent-edit tables use append-only version-bumped writes to work around an UPDATE-coalescing quirk. The full schema is documented in [`schema.md`](schema.md) and the storage mechanics in [`deeplake-storage.md`](deeplake-storage.md).

Local JSON and JSONL sidecars are not allowed as the default for app state, caches, queues, indexes, or cursors; those belong in DeepLake. Sidecars are fine only for genuine user-facing artifacts: import and export bundles, attachments, logs, and backups. Secrets are the one thing that never lives in DeepLake or the identity files; they sit encrypted under `.secrets/`, as described in [`../security/secrets.md`](../security/secrets.md).
