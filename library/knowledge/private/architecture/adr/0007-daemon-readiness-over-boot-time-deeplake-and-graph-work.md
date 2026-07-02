# ADR-0007, Daemon readiness over boot-time DeepLake and graph work

> **Status:** Accepted | **Date:** 2026-06-30
> **Supersedes:** none | **Superseded by:** none
> **Owners:** daemon, operations, storage | **Related:** ADR-0006, PRD-066, PR-190, v0.1.12

## Context

Honeycomb v0.1.11 exposed a boot-readiness failure on macOS arm64 with Node 22.22.3.
During `honeycomb daemon start`, the daemon could crash-loop with repeated WASM `Aborted()`
failures from the bundled tree-sitter graph path. In the reported failure mode, the daemon never
bound port 3850. Disabling the graph path with `HONEYCOMB_PIPELINE_GRAPH_ENABLED=false` stopped the
abort spam, but the daemon still did not bind, which showed that startup readiness was also coupled
to other boot-time work.

This matters for both user experience and cost:

- Doctor and the CLI need the daemon to bind and answer `/health` quickly enough to distinguish
  "booting" from "dead".
- Optional codebase graph work should not be allowed to crash or block the core daemon listener.
- DeepLake health probes and queue warmup can involve remote I/O. They should not own local process
  readiness, especially while Honeycomb is trying to stop idle workers from keeping Activeloop or
  DeepLake compute warm.
- On macOS, the `ai.honeycomb.daemon` launchd agent had `KeepAlive=true`. A stop command that only
  signaled the child process allowed launchd to immediately respawn it, which could silently keep
  backend compute warm even after a user believed the daemon was stopped.

ADR-0006 already moved Honeycomb toward a local queue as interim idle-cost control. This decision
extends the same principle to process readiness: local daemon availability should not wait on
optional graph parsing or remote storage work.

## Decision drivers

- **The daemon must bind quickly enough for Doctor and the CLI to observe it.**
- **Core daemon readiness must not depend on optional codebase graph generation.**
- **Core daemon readiness must not depend on first DeepLake health or queue warmup round trips.**
- **A user-issued macOS stop must stop the launchd service, not trigger an immediate respawn.**
- **The fix must be safe to ship immediately as a v0.1.12 hotfix.**

## Considered options

### Option A, Keep boot-time graph auto-build and catch failures

This is not sufficient. The observed failure was a WASM abort from the parser path, which can
terminate the process instead of surfacing as a catchable JavaScript exception. Keeping auto-build as
default boot work would preserve the failure mode.

### Option B, Gate graph auto-build only on macOS arm64

This would address the first reported platform, but it would keep a risky optional parser path in
the boot-critical path everywhere else. The graph feature is useful, but it is not required for
daemon readiness. Platform-specific gating would also make support harder because startup semantics
would differ by machine.

### Option C, Increase boot and health timeouts

Longer timeouts may hide slow startup, but they do not remove the core problem. The daemon would
still be treating optional parser work and remote storage calls as prerequisites for binding. This
also does not address launchd respawn after stop.

### Option D, Make daemon readiness local and background optional boot work (CHOSEN)

Bind the daemon and serve health before optional graph generation, first remote health probing, and
shared queue warmup complete. Keep those tasks observable through health state, but do not let them
own listener availability. On macOS, unload the launchd agent on stop so `KeepAlive=true` cannot
respawn the daemon after a user explicitly stops it.

## Decision

Adopt **Option D** for the v0.1.12 hotfix.

The daemon readiness contract is:

```text
Daemon ready = listener bound + /health reachable.
```

The following work is not part of the core readiness gate:

- codebase graph auto-build;
- first DeepLake or storage health probe;
- shared local queue table creation and first reaper sweep.

The codebase graph auto-build is opt-in at boot with:

```text
HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD=true
```

Manual graph APIs and explicitly requested graph operations remain available. This decision only
removes automatic graph building from the default boot path.

For production local boot, the first storage health probe runs in the background. Tests and
injected-storage harnesses may still await probe completion when deterministic assertions need that
behavior.

The local shared job queue starts its scheduler promptly and performs table creation plus initial
reaper work in the background. Enqueue, lease, and reaper operations must continue to heal or fail
softly if warmup has not completed yet.

On macOS, `honeycomb daemon stop` must unload the launchd agent with `launchctl bootout` rather than
only signaling the child process. This preserves `KeepAlive=true` for crash recovery and login
startup while making explicit stop semantics match user intent.

## Scope Boundary

This ADR covers the immediate hotfix boundary:

- daemon boot readiness;
- default codebase graph auto-build behavior;
- first storage health probe scheduling;
- shared local queue startup warmup;
- macOS launchd stop behavior.

This ADR does not redesign:

- the long-term hosted control plane;
- multi-device memory synchronization;
- graph feature semantics after explicit user or API invocation;
- the full Doctor portal/dashboard roadmap.

## Consequences

**Positive**

- The daemon can bind and answer `/health` without waiting for optional graph or remote storage work.
- Doctor can observe a live daemon instead of treating a slow or blocked boot as a dead service.
- A parser/WASM failure in automatic graph construction no longer prevents core daemon startup by
  default.
- macOS `daemon stop` actually stops the launchd-managed service instead of letting `KeepAlive`
  immediately respawn it.
- Idle-cost controls are stronger because explicit stop and local readiness are less likely to keep
  DeepLake or Activeloop compute warm accidentally.

**Negative / accepted**

- Codebase graph snapshots no longer auto-refresh at daemon boot unless
  `HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD=true` is set.
- Health can briefly report a booting or not-yet-probed storage state after the listener is already
  reachable.
- The first queue operation after process start may race background warmup and must rely on the
  existing fail-soft or self-healing paths.
- Operators who depended on automatic boot graph generation need to opt in explicitly.

**Neutral**

- Manual graph APIs remain wired.
- Storage schemas and DeepLake memory/vector behavior are unchanged.
- Doctor should treat the first 60 seconds as booting/settling time per the companion health
  PRD work, but that timeout is a diagnostic grace period, not a reason for the daemon to delay
  binding.

## Required invariants

- The daemon must not require codebase graph auto-build to bind its local HTTP listener.
- The daemon must not require a successful first DeepLake or storage probe to bind its local HTTP
  listener.
- The shared local queue must remain safe if startup warmup completes after the scheduler starts.
- `honeycomb daemon stop` on macOS must unload the launchd agent so KeepAlive cannot respawn it.
- Default boot behavior must favor a reachable local daemon over optional boot-time enrichment.

## Revisit triggers

Re-open this decision if any of these become true:

1. The graph path is proven safe across supported platforms and can run out-of-process or behind a
   crash boundary that cannot kill the daemon.
2. Users report that opt-in graph auto-build creates unacceptable discoverability or freshness gaps.
3. Doctor gains a separate always-on portal process that can supervise daemon boot without
   depending on the main daemon listener.
4. DeepLake or the hosted control plane provides a cheap, non-blocking health/readiness primitive
   that does not keep remote compute warm.

## Links

- PR-190: `https://github.com/legioncodeinc/honeycomb/pull/190`
- ADR-0006: `library/knowledge/private/architecture/adr/0006-local-queue-as-interim-idle-cost-control.md`
- PRD-066: `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`
