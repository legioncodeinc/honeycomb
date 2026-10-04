# Notifications and Environment Health

> Category: Operations | Version: 1.0 | Date: June 2026 | Status: Active

Architecture of the Honeycomb notifications framework and the proactive prerequisite environment health check and auto-wiring engine.

**Related:**
- [`cli-command-architecture.md`](cli-command-architecture.md)
- [`doctor-watchdog.md`](doctor-watchdog.md)
- [`../auth/auth-architecture.md`](../auth/auth-architecture.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../overview.md`](../overview.md)
- [`../architecture/system-overview.md`](../architecture/system-overview.md)
- [`../architecture/request-lifecycle.md`](../architecture/request-lifecycle.md)

---

## Why this exists

Coding assistant integrations are complex and fragile. They are highly dependent on external command-line utilities, correct user sessions, a reachable daemon, and global configuration files like `~/.cursor/hooks.json`.

To prevent silent failures, Honeycomb implements two proactive operational guardrails:
1. **The Notifications Framework:** Evaluates, queues, and delivers contextual alerts on session start, helping developers resolve subscription issues, account limits, and local mining opportunities.
2. **The Environment Health Check:** `honeycomb status` evaluates five probes (D1–D5) for the running CLI version, daemon reachability on `127.0.0.1:3850`, `cursor-agent` on PATH, `cursor-agent` login, and hook wiring. `createHealthCheck` in [`src/notifications/health.ts`](../../../../src/notifications/health.ts) has no timer. `status` calls `evaluate()`. Auto-wiring is a separate `autoWire()` on that same check.

Together, these guardrails ensure that the shared memory layer remains robust, and that potential compilation, summarization, or daemon-connectivity failures are caught and surfaced before causing silent data loss.

---

## The Notifications Framework

The notifications pipeline is trigger-agnostic and fail-soft. It runs on session start without a timer of its own. Backend notifications are fetched through the daemon, which holds the authenticated connection to the DeepLake cloud.

The drain lives in [`src/notifications/pipeline.ts`](../../../../src/notifications/pipeline.ts). `createNotificationsPipeline` returns a pipeline whose `drain(trigger)` is the session-start operation (the module comment names it `drain(session_start)`). [`src/notifications/index.ts`](../../../../src/notifications/index.ts) is a barrel and re-exports `createNotificationsPipeline` and `DEFAULT_PIPELINE_TIMEOUT_MS`. That constant is `1500`. Local rules, the queue, and the backend fetch run in parallel. Each fetch is bounded by that timeout and fail-soft: a hang or a throw contributes no candidates and the drain still resolves.

### Double-Invocation Race Mitigation

In some environments, such as Claude Code, the notifications hook can be registered in both the user's global configuration (`~/.claude/settings.json`) and the marketplace plugin definition (`hooks.json`). This causes two separate Node processes to spawn and run in parallel, both reading state before either writes.

To prevent duplicate banners from cluttering the terminal, Honeycomb implements an atomic claiming lock using POSIX file semantics. The lock is `createClaimLock` in [`src/notifications/state.ts`](../../../../src/notifications/state.ts). The claim directory name is `claims` (`CLAIM_DIR_NAME`) under `honeycombStateDir()`.

`claim` exclusive-creates the claim file with `openSync(path, "wx")`. The first process creates the file and wins. A racer sees `EEXIST` and loses, and that notification is skipped. Any other filesystem error, including a `mkdir` failure, throws `StateFsError`.

### Transient vs. Persistent States

* **Persistent Notifications:** Welcome messages, first-time guides, or organization-wide savings recaps are registered in state. Storing their `id` and `dedupKey` in `~/.apiary/honeycomb/notifications-state.json` ensures they display exactly once (`src/notifications/state.ts` resolves the directory with `honeycombStateDir()`).
* **Transient Notifications:** Used for self-clearing events, such as payment failures or missing background dependencies. When a transient notification is drained, its claim file is unlinked using `releaseClaim`, allowing future sessions to re-emit the warning if the underlying issue continues.

To prevent filesystem corruption during state updates, `writeState` writes output to a temporary process-tagged file first, then executes an atomic POSIX `renameSync` operation over the active state path.

---

## Environment Health Check (D1 - D5)

The health check resolves the silent-failure gap described in `prd-002a-health-check.md`. If a background summary worker fails because a compiler or tool binary is missing, or because the daemon is down, the error was previously swallowed. `honeycomb status` evaluates five independent dimensions. The dimension ids are still `D1` through `D5` ([`src/notifications/contracts.ts`](../../../../src/notifications/contracts.ts)). The probes are [`src/cli/health-probes.ts`](../../../../src/cli/health-probes.ts).

| Dimension | Checked Precondition | Resolving Strategy |
| --- | --- | --- |
| **D1: `honeycomb` CLI** | Is this process the `honeycomb` CLI? | In-process `HONEYCOMB_VERSION`. The probe does not spawn a PATH lookup. |
| **D2: Honeycomb daemon** | Is the daemon reachable? | `daemon.ping()`, detail `127.0.0.1:3850`. The probe does not launch the daemon. |
| **D3: `cursor-agent` CLI** | Is `cursor-agent` present? | `which`, or `where` on Windows. |
| **D4: `cursor-agent` login** | Is the user logged into `cursor-agent`? | `cursor-agent status`, with a 5-second timeout. |
| **D5: Hooks wired and current** | Is capture wired? | Healthy when the Claude Code plugin is installed and enabled. Otherwise healthy when `~/.cursor/hooks.json` exists. |

Surfacing logged-out, daemon-down, and missing states upfront prevents the shared DeepLake store from filling with silent, empty placeholders.

---

## Health Must Report the True Runtime State

The recent fixes in this area establish one governing principle: `/health` must report the true runtime state, not the intended or configured flag. A toggle being *enabled* is not evidence that the subsystem is *running*. When the health surface reports the flag instead of the fact, a total failure becomes invisible, and the operator has no signal that anything is wrong.

### The embeddings spawn-path bug

PR #242 caught the sharpest example. The Hive Embeddings toggle did nothing: with embeddings enabled, semantic recall silently ran on BM25, and `/health` cheerfully reported `embeddings: "on"` the whole time.

The root cause was a resolve-path mismatch between the dev layout and the shipped bundle. In the shipped bundle the embed supervisor is inlined into `daemon/index.js`, but `resolveEmbedEntry` hard-coded a five-parent-directory walk that is correct only for the dev `dist/src/daemon/runtime/services/` layout. In a bundled install that walk resolved to `<npm-root>/../embeddings/embed-daemon.js`, a path outside the package. The spawn was handed a file that does not exist, the child process exited 1, the crash-restart budget drained, and nothing ever came up on port 3851. Meanwhile the health surface read `embeddings: "on"` straight from the enabled flag, so the failure left no trace.

The fix has two halves:

1. **Probe candidate paths instead of hard-coding one.** `resolveEmbedEntry` now checks both the bundled sibling path (`../embeddings/...`) and the dev five-up path and picks whichever actually exists on disk. The selection logic was extracted as a pure `pickEmbedEntry` with a regression test covering both layouts, so a future packaging change that breaks one layout is caught in CI rather than in the field.
2. **Report the honest embeddings state.** The supervisor reads the embed daemon's own `/health` (`warmFailed`) and tracks restart-exhaustion. The daemon `/health` field is `EmbeddingsHealth`: `off`, `warming`, `on`, `suspect`, or `failed` ([`src/daemon/runtime/health.ts`](../../../../src/daemon/runtime/health.ts)). The coarse `embeddings` value mirrors that set when supervisor signals are wired. `HONEYCOMB_EMBEDDINGS=false` still forces `off`.

The general lesson applies beyond embeddings: every subsystem that `/health` describes should be probed for its actual state (process alive, warmup succeeded, restart budget intact), never reported from the flag that was supposed to turn it on.

---

## Auto-Wiring and Idempotency

The auto-wiring engine removes the friction of manual hook setup by managing the `~/.cursor/hooks.json` configuration file on the developer's behalf.

The engine wires six lifecycle events through `CURSOR_HANDLERS` in [`src/connectors/cursor.ts`](../../../../src/connectors/cursor.ts). Auto-wiring delegates to that connector ([`src/notifications/auto-wiring.ts`](../../../../src/notifications/auto-wiring.ts)). The cursor shim still accepts `afterAgentResponse` and maps it to `assistant_message` ([`src/hooks/cursor/shim.ts`](../../../../src/hooks/cursor/shim.ts)); the connector registers `assistant_message` on native `stop` only.

| Native event | Handler | Timeout |
| --- | --- | --- |
| `sessionStart` | `session-start.js` | 10s |
| `beforeSubmitPrompt` | `capture.js` | 10s |
| `beforeShellExecution` | `pre-tool-use.js`, matcher `Shell` | 60s |
| `postToolUse` | `capture.js` | 15s |
| `stop` | `capture.js` (`assistant_message`) | 30s |
| `sessionEnd` | `session-end.js` | 60s |

### Correctness and Safety Requirements

To operate safely inside developer environments, the auto-wiring process adheres to three strict rules:

1. **Preserving Foreign Hooks:** Auto-wiring must never overwrite other third-party hooks. It parses the existing array, filters out entries matching Honeycomb paths via `isHoneycombEntry`, and appends the new configuration.
2. **Idempotency:** Re-wiring when no configuration has changed must not touch the file. This protects the hook-trust fingerprint calculated by the editor, avoiding warning dialogs. This is implemented using `writeJsonIfChanged` under the hood.
3. **Reversibility:** When uninstalling, the engine strips only the Honeycomb hooks. If the resulting `hooks` object contains no further hooks, the configuration file itself is cleanly unlinked.
