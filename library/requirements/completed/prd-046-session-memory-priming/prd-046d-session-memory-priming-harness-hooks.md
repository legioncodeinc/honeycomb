# PRD-046d — Claude Code + Cursor SessionStart hooks

> Status: completed (merged #77, 2026-06-22) · Parent: PRD-046 · Wave: W2 · Type: M
> Goal: deliver the prime to the agent — a SessionStart hook in Claude Code and Cursor that fetches the
> digest (046c) once per session and injects it as session context. Start with these two harnesses; the
> others follow the same shape later.

## Why
The prime digest (046c) is only useful if it reaches the agent's context at session start. Both target
harnesses already have the lifecycle event and Honeycomb already wires hooks into both, so this is an
addition to an existing integration, not new machinery. There is a direct precedent: Honeycomb already
fires a **session-start step** today — the skill `pull`/`auto-pull` propagation — so a memory prime is
structurally the same move (a bounded, session-scoped fetch that seeds the agent before turn one). See
`session-priming-architecture.md` §6–7.

## What (scope)
- **Claude Code:** add a `SessionStart` hook entry that calls the daemon for the prime digest (scoped to
  the repo/agent) and contributes it as session/additional context. Reuse the existing capture/recall
  hook installation path; reuse the skill-propagation pattern for shape.
- **Cursor:** add the session-start equivalent in the `~/.cursor/hooks.json` surface wired by
  `src/cli/install-cursor.ts`; the pull tools are the already-registered Honeycomb MCP server.
- **Once-per-session.** The hook fires at session start only (not per turn). After the prime, the agent
  pulls (resolve/search, 046e) on its own.
- **Graceful degradation.** If the daemon is unreachable or the repo is cold, the hook injects nothing
  (or an honest "no memory yet"), never blocks session start, never errors the agent.
- **Bounded.** The injected block respects the 046c token budget; the hook does no assembly itself — it
  fetches the already-bounded digest.

## Acceptance criteria
- **d-AC-1 — Claude Code injects the prime.** On session start, the CC hook fetches the digest and the
  agent's context contains the Tier-1 index. Verified on the CC harness path (installer wires the hook).
- **d-AC-2 — Cursor injects the prime.** Same, via the Cursor hooks.json session-start event +
  `install-cursor.ts`. Verified on the Cursor path.
- **d-AC-3 — Once per session, not per turn.** The hook fires at session start only; subsequent turns do
  not re-inject. Verified.
- **d-AC-4 — Degrades gracefully.** Daemon down / cold repo → no injection, no error, session starts
  normally. Unit/integration-tested with an unreachable daemon stub.
- **d-AC-5 — Gates green; no secrets.** Installer + hook changes keep `npm run ci` / `build` /
  `audit:openclaw` green; the digest carries no secret/PII (inherited from 046b/c). Per-harness smoke.

## Risks / Out of scope
- **Risk — harness API drift.** Claude Code / Cursor hook contracts evolve. Keep the hook thin (fetch +
  inject); all logic lives in the daemon (046c), so a harness change is a small adapter edit.
- **Risk — startup latency.** A slow daemon must not stall session start. Bound the fetch with a short
  timeout and degrade to no-injection (d-AC-4).
- **Out of scope — the other four harnesses** (Codex, Hermes, pi, OpenClaw) — same shape, sequenced
  later; **the digest assembly** (046c); **proving value** (046f).

## Dependencies
- **046c** (the digest endpoint the hook calls).
- The harness installers — the Claude Code hook installation path and `src/cli/install-cursor.ts`; the
  registered Honeycomb MCP server (for the pull tools the prime references).
- The skill `pull`/`auto-pull` session-start precedent (pattern + possibly the hook point).
