# PRD-075c: SessionStart Recall-Awareness Notice + `honeycomb recall` Sentinel

> **Parent:** [`prd-075-on-demand-recall-command-surface-index`](./prd-075-on-demand-recall-command-surface-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S (~2-4h)
> **Schema changes:** None.
> **Depends on:** [`prd-075a`](./prd-075a-live-the-pretooluse-recall-path.md) + [`prd-075b`](./prd-075b-render-pretool-decision-and-conformance.md) (the notice is inert until the surface it points at is live).

---

## Goal

Make the now-live recall surface **discoverable**. A capability the model does not know about is unused: the whole point of the LLM-commanded design (vs. always-on sync recall) is that the model *chooses* to recall — which requires it to know the command exists. This sub-PRD (1) appends a short, durable awareness notice to `SessionStart`'s `additionalContext`, and (2) adds a first-class `honeycomb recall "<query>"` Bash sentinel so the command reads as intent rather than a filesystem trick.

## Non-Goals

- **No runtime/VFS or render changes** — 075a/075b.
- **No change to the existing session-start digest/prime content** — the notice is *appended*; the blind-dump recall is untouched.
- **No reminder-injection on other events** — a one-shot session-start notice ships here; a per-turn reminder cadence is recorded as a follow-up, not built.

---

## Code-grounded starting point

| # | Fact | Code |
|---|---|---|
| 1 | `SessionStart` renders `additionalContext` by joining a notice block + a rules/goals context block + the prime digest; all-empty omits `additionalContext` | `src/hooks/shared/session-start.ts:218-237` |
| 2 | The join helper composes blocks separated cleanly; either-empty returns the other | `src/hooks/shared/session-start.ts:242-` (`joinBlocks`) |
| 3 | A first-run notice string is already threaded into that render (precedent for adding another block) | `src/hooks/shared/session-start.ts:218-222` (`noticeBlock`) |
| 4 | `lowerBashVerb` maps a leading Bash word to a VFS verb; unrecognized → `undefined` (rewrite to echo) | `src/hooks/shared/pre-tool-use.ts:222-240` |
| 5 | `sniffBashPath` pulls the first mount-referencing arg; the mount gate is `mentionsMount` | `src/hooks/shared/pre-tool-use.ts:175-194`, `:243-246` |

---

## Design

### Part 1 — The awareness notice

Add a constant notice string and append it to the session-start `additionalContext` via the existing `joinBlocks` composition (alongside `noticeBlock`/`contextBlock`/`primeBlock`). Keep it terse and imperative — it competes for attention and decays as context grows. Proposed copy (final wording is an open question):

> **Memory recall (on demand).** You have a searchable memory of past sessions. To recall it mid-task, run `honeycomb recall "<what you're looking for>"` — the result comes back as the command's output. Reach for it before asking the user to re-explain prior context, decisions, or where something lives. It costs nothing on turns you don't use it.

Fail-soft is inherited: the notice is a static string, so it cannot throw; if every block is empty the render still omits `additionalContext` cleanly (existing behavior).

### Part 2 — The `honeycomb recall` sentinel

Map `honeycomb recall` as a `search` verb so the model has an intent-shaped command instead of needing to know the mount path. Two matching options:

- **Preferred:** extend `lowerBashVerb` (and the path/query sniff) to recognize a `honeycomb recall "<query>"` (and `honeycomb search`) Bash line: verb → `search`, `query` → the quoted argument, `path` → the mount root (so `onMemoryMount` passes without the model naming a path).
- **Always-available fallback:** the raw `Grep`/`cat` against `~/.apiary/honeycomb/memory/` that the intercept already supports (`lowerVerb`/`lowerBashVerb` today). The notice names the sentinel; the fallback stays for any agent that greps the mount directly.

The sentinel is a *recognition* rule in the pre-tool intercept — it does not require a real `honeycomb recall` CLI subcommand to exist (the intercept blocks the command and returns daemon output before it would run). Whether to *also* add a real CLI verb for out-of-hook use is an open question below.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | `SessionStart`'s `additionalContext` includes the recall-awareness notice. A test asserts the notice text is present in the rendered context when session-start runs. |
| c-AC-2 | The existing session-start digest/prime/first-run-notice content is unchanged and still composes via `joinBlocks`; the notice is an additional block, not a replacement. A test asserts prior blocks survive alongside it. |
| c-AC-3 | With all other blocks empty, `additionalContext` carries just the notice; with everything empty *and* the notice disabled/absent, `additionalContext` is omitted (no empty injection). The render never throws. |
| c-AC-4 | `honeycomb recall "<query>"` as a `Bash` pre-tool op is mapped to the `search` verb, with `<query>` extracted as the VFS query and the mount root as the path, so `onMemoryMount` passes. A test covers verb + query + path extraction. |
| c-AC-5 | `honeycomb recall` resolves through the same VFS intercept as a mount `Grep` (075a) and blocks the real command (075b) — the literal `honeycomb recall` shell command never executes. A test (faked `vfs`) asserts the `replace` decision and no real execution. |
| c-AC-6 | The raw mount `Grep`/`cat` fallback still works unchanged (regression). |

---

## Files touched

**Modified**
- `src/hooks/shared/session-start.ts` — add the notice constant; append it via `joinBlocks`.
- `src/hooks/shared/pre-tool-use.ts` — recognize `honeycomb recall`/`honeycomb search` in `lowerBashVerb` + query/path sniff.

**New**
- extend the session-start test suite — c-AC-1..c-AC-3.
- extend the pre-tool-use test suite — c-AC-4..c-AC-6.

---

## Test plan

- **Unit — notice present:** run session-start render; assert notice in `additionalContext` (c-AC-1), prior blocks preserved (c-AC-2), empty-omit + never-throw (c-AC-3).
- **Unit — sentinel:** `honeycomb recall "<q>"` → `search` verb, query + mount path extracted (c-AC-4); faked `vfs` → `replace`, no real exec (c-AC-5).
- **Regression:** raw mount `Grep`/`cat` still resolves (c-AC-6); existing session-start tests green.

---

## Open questions

- **Notice wording + length.** The copy above is a first draft. Shorter is likelier to survive context growth but risks under-explaining. Ship one version; a follow-up can A/B against recall-usage telemetry (does the model actually issue recall commands after seeing it?).
- **Reminder cadence.** A one-shot session-start notice decays. Should a terse reminder occasionally ride the `PreToolUse` `allow` path (e.g. once every N tool calls, or after a long stretch with no recall)? Deferred to a follow-up PRD — ship the one-shot notice first, measure whether it is enough.
- **Real `honeycomb recall` CLI verb.** The sentinel works purely as a hook-intercept recognition rule. Adding a genuine `honeycomb recall <query>` CLI subcommand (for use outside a hooked session, e.g. a human at a terminal) is separable and out of scope here — flag if wanted.
- **Sentinel collision.** Confirm no existing `honeycomb` CLI subcommand is spelled `recall`/`search` such that the recognition rule would shadow a real command a user might legitimately want to run through the mount. (The intercept only fires when the op resolves onto the mount, but confirm the spelling is free.)
