# PRD-075a: Live the PreToolUse Recall Path — Real VFS + Propagated Decision

> **Parent:** [`prd-075-on-demand-recall-command-surface-index`](./prd-075-on-demand-recall-command-surface-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (~0.5-1d)
> **Schema changes:** None.

---

## Goal

Connect the two runtime breakpoints that keep the `PreToolUse` recall surface inert: (1) the runtime resolves pre-tool mount ops through the **fake** VFS, and (2) it **discards** the `PreToolDecision`. After this sub-PRD, a mount-targeted pre-tool op is resolved by the real daemon-backed `VfsIntercept` (`DeepLakeFs`) and its decision leaves the runtime intact for the shim renderer (075b) to consume.

This sub-PRD deliberately stops at the runtime boundary — it makes the decision *available*; it does not render it to the harness (that is 075b). Split this way, 075a is fully unit-testable against the runtime seam without depending on the Claude Code output contract 075b must pin.

## Non-Goals

- **No shim render** — the `PreToolDecision` → Claude Code `PreToolUse` response mapping is 075b.
- **No new VFS behavior** — `DeepLakeFs` and the intercept's verb routing are reused verbatim; this is wiring, not logic.
- **No `SessionStart` notice / sentinel verb** — those are 075c.
- **No change to off-mount pass-through** — a non-mount op still returns `allow` with no daemon call.

---

## Code-grounded starting point

| # | Fact | Code |
|---|---|---|
| 1 | The dispatch calls `runPreToolUse(input, deps)` (two args) and keeps only `{ result }` | `src/hooks/runtime.ts:252` |
| 2 | `runPreToolUse(input, _deps, vfs = createFakeVfsIntercept())` ignores `deps` via `void _deps` and defaults to the fake | `src/hooks/shared/pre-tool-use.ts:91-96` |
| 3 | The real intercept seam is `DeepLakeFs` under `src/daemon-client/vfs/`, dispatching SQL through the daemon over loopback | `src/daemon-client/vfs/` |
| 4 | `HookCoreDeps` (the `deps` already passed to every core) is where daemon-client seams are threaded | `src/hooks/shared/contracts.ts` (`HookCoreDeps`) |
| 5 | The lifecycle is fail-soft — a core throw is absorbed by `dispatchLifecycle`'s `try/catch` | `src/hooks/runtime.ts` |

---

## Design

Two edits, both narrow:

1. **Thread the real `VfsIntercept` through `deps`.** Add a `vfs: VfsIntercept` seam to `HookCoreDeps` (defaulting, at the runtime's dependency-construction site, to the real `DeepLakeFs`-backed intercept pointed at the loopback daemon). In `runPreToolUse`, stop ignoring `_deps`: read `deps.vfs` and use it, keeping the `createFakeVfsIntercept()` default **only** as the parameter fallback for isolated unit tests that construct no deps. The real runtime path must resolve to the daemon seam.

2. **Propagate the decision.** Change the `case "pre-tool-use"` branch to return the `decision` alongside the `result`:

   ```ts
   case "pre-tool-use": {
     const { result, decision } = await runPreToolUse(input, deps);
     return { result, decision };
   }
   ```

   Extend `HookEventOutcome` with an optional `decision?: PreToolDecision` so the outcome carries it to the binary driver / shim without disturbing the other branches (which simply never set it).

Fail-soft is preserved: if `deps.vfs.resolve` throws or times out, the existing `try/catch` in `dispatchLifecycle` absorbs it to a fail-soft `result`, and the branch yields no `replace` decision — the tool passes through rather than blocking. (075b renders an absent/`allow` decision as untouched pass-through, so a daemon failure degrades to "the real tool runs," never a hang.)

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | `HookCoreDeps` gains a `vfs` seam; the runtime's real dependency construction wires it to the daemon-backed `DeepLakeFs` intercept over loopback. A test asserts the production deps carry the real seam, not `createFakeVfsIntercept()`. |
| a-AC-2 | `runPreToolUse` resolves mount ops through `deps.vfs` (no longer `void _deps`). A test injecting a recording `vfs` double through `deps` observes the `VfsToolOp` (verb + path + query) and confirms its output becomes the `replace` decision's `output`. |
| a-AC-3 | The `pre-tool-use` dispatch branch returns `{ result, decision }`; `HookEventOutcome.decision` carries the `PreToolDecision`. A test asserts a mount `Grep` yields a `replace` decision on the outcome, and an off-mount op yields `allow`. |
| a-AC-4 | Off-mount pass-through is unchanged: a non-mount tool op makes **no** `deps.vfs` call and returns `allow`. A test with a throwing `vfs` double confirms it is never invoked for `cat /etc/hosts`. |
| a-AC-5 | Fail-soft holds: a `vfs.resolve` that throws or times out is absorbed to a fail-soft `result` with no `replace` decision; the turn proceeds. A test drives the double to reject and asserts no throw escapes `dispatchLifecycle`. |
| a-AC-6 | No behavioral change to `session-start`, `session-end`, or the capture branches; their outcomes never carry a `decision`. Existing runtime tests remain green. |

---

## Files touched

**Modified**
- `src/hooks/runtime.ts` — `pre-tool-use` branch returns `{ result, decision }`; real `vfs` seam constructed into `deps`.
- `src/hooks/shared/pre-tool-use.ts` — read `deps.vfs`; drop `void _deps`; keep the fake only as the isolated-test parameter default.
- `src/hooks/shared/contracts.ts` — add `vfs: VfsIntercept` to `HookCoreDeps`; add `decision?: PreToolDecision` to `HookEventOutcome` (or its definition site in `runtime.ts`).

**New**
- `tests/daemon/runtime/hooks/pre-tool-use-recall.test.ts` (or extend the existing pre-tool-use suite) — the wiring, propagation, off-mount, and fail-soft cases above.

---

## Test plan

- **Unit — wiring:** inject a recording `vfs` double via `deps`; assert `runPreToolUse` calls it with the correct `VfsToolOp` for `Read`/`Grep`/`ls`/`find` on the mount, and that its return becomes the `replace` output (a-AC-2).
- **Unit — propagation:** assert the `pre-tool-use` outcome carries the `decision` (a-AC-3).
- **Unit — off-mount:** throwing `vfs` double + `cat /etc/hosts` → `allow`, double never called (a-AC-4).
- **Unit — fail-soft:** rejecting `vfs` double → fail-soft result, no throw, no `replace` (a-AC-5).
- **Regression:** the existing runtime + pre-tool-use suites stay green (a-AC-6).

---

## Open questions

- **Where the real `vfs` seam is constructed.** It should mirror how the runtime already builds its daemon-client seams (host/port/`fetch`), so the intercept shares the same loopback config as the notifications/prime seams. Confirm the single construction site so the fake never leaks into production deps.
- **Timeout budget for the intercept call.** The `PreToolUse` hook has a 60 s hook timeout, but a recall should be bounded far tighter (target ≤ ~2 s) so a slow daemon degrades to pass-through quickly. Confirm whether the bound belongs in the `DeepLakeFs` client or as a wrapper here.
