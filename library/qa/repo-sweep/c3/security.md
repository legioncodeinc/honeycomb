# Security Audit Report: PR-05 Repo Sweep, Chunk C3 (src/hooks)

**Audit date:** 2026-06-16
**Auditor:** security-worker-bee subagent
**Branch:** `pr/05-security-quality-repo-sweep`
**Scope:** All 47 `.ts` files under `src/hooks/` (root + `shared/`, `claude-code` root, `codex/`, `cursor/`, `hermes/`, `pi/`)
**Node version audited:** >=22 (ESM)
**`npm audit` result:** Not run (dependency tree is out of C3 scope; `node_modules` symlinked, `npm install` prohibited per task). Dependency surface owned by `dependency-audit-worker-bee`.
**OpenClaw bundle scan:** Not run (out of C3 scope).
**CVE watchlist last refreshed:** see `.cursor/skills/security-stinger/research/cve-watchlist.md`; not gating for this hooks-only chunk.

---

## Executive Summary

Chunk C3 (`src/hooks/`) is the pre-tool-use VFS gate, the capture pipeline, and the wiki/skill workers across six harnesses. The single most important finding is **credential exposure**: each harness's wiki-worker spawn helper wrote the Activeloop token into a `config.json` under the world-readable, predictable `/tmp/deeplake-wiki-*` directory with no restrictive file/dir mode, leaving the JWT readable by any local user for the worker's lifetime. That is now fixed (dir `0o700`, file `0o600`). The second class is a **defense-in-depth SQL-injection gap**: ~20 hook query sites interpolated config-driven table identifiers (`HIVEMIND_TABLE` / `HIVEMIND_SESSIONS_TABLE`) raw into the parameterless Deeplake SQL API without the `sqlIdent` guard that the rest of the codebase (`DeeplakeApi`, `session-queue.ts`, `context-renderer.ts`) already enforces; all in-scope sites are now wrapped. A Medium path-traversal hardening in the query cache was fixed under the <5-line rule. One High item is documented as a follow-up (not safely fixable in-session without behavior risk): the wiki summarizer runs the spawned agent CLI with permission bypass over attacker-influenceable captured session content.

Counts: **2 High classes fixed** (credential file modes across 4 files; missing `sqlIdent` across 17 files), **1 Medium fixed** (cache path traversal), **1 High documented as follow-up** (summarizer prompt-injection blast radius), **1 Low documented**. No tokens are logged anywhere in the hooks; capture opt-out (`HIVEMIND_CAPTURE=false`) is honored at every INSERT site; the pre-tool-use gate keeps paths literal and routes through the VFS.

Ordering: no C3 QA report predates this audit (`library/qa/repo-sweep/c3/` was empty). The parallel C2 quality run covers `src/cli/` + `scripts/`, disjoint from C3, so no ordering inversion applies to these files.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | FAIL (fixed) | 1 High (4 files) |
| Captured-Trace PII (sessions/memory) | OK | 0 |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deep Lake SQL API) | FAIL (fixed) | 1 High class (17 files) + 1 Medium |
| Dependency & OpenClaw Bundle | OK (out of scope) | 0 |
| Configuration (cred modes, capture opt-out, client hardening) | OK | capture opt-out verified |
| Pre-Tool-Use Gate & Prompt Injection | ATTN | 1 High documented (follow-up), 1 Low |

Legend: **OK** = zero findings · **ATTN** = Medium/Low or documented follow-up · **FAIL** = Critical/High (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

- [x] **Credential exposure: Activeloop token written to world-readable temp file** `src/hooks/spawn-wiki-worker.ts:95-101`, `src/hooks/codex/spawn-wiki-worker.ts:92-98`, `src/hooks/cursor/spawn-wiki-worker.ts:92-98`, `src/hooks/hermes/spawn-wiki-worker.ts:93-99` - each spawn helper created `tmpDir` via `mkdirSync(..., { recursive: true })` (default perms) and wrote `config.json` containing `token: config.token` via `writeFileSync(...)` (no `mode`), in the shared, predictable `/tmp/deeplake-wiki-<sessionId>-<ts>` path. With a typical umask the token JWT is group-/world-readable for the worker's lifetime (up to the 120s `claude -p` timeout). **Fix:** `mkdirSync(tmpDir, { recursive: true, mode: 0o700 })` and `writeFileSync(configFile, ..., { mode: 0o600 })` on all four helpers, mirroring the `~/.deeplake/credentials.json` 0600/0700 convention.

- [x] **SQL injection surface: config-driven table identifiers interpolated without `sqlIdent`** (A3) - the Deeplake HTTP query endpoint has no parameterized queries, so every identifier must pass `sqlIdent` (the codebase already does this in `DeeplakeApi.ensure*`, `session-queue.ts:129`, `context-renderer.ts:180`). The following hook SQL sites interpolated `HIVEMIND_TABLE` / `HIVEMIND_SESSIONS_TABLE`-derived names raw (`FROM "${memoryTable}"`, `INSERT INTO "${sessionsTable}"`, etc.). All are now wrapped with `sqlIdent(...)`, which throws on anything outside `[A-Za-z_][A-Za-z0-9_]*`:
  - `src/hooks/virtual-table-query.ts:162,163,204,209,238,239,291,292` (memory + sessions, all three query builders)
  - `src/hooks/capture.ts:164`
  - `src/hooks/upload-summary.ts:81,94,109`
  - `src/hooks/session-start.ts:102,123`
  - `src/hooks/wiki-worker.ts:137,156,174,188`
  - `src/hooks/codex/pre-tool-use.ts:252`
  - `src/hooks/codex/session-start-setup.ts:34,55`
  - `src/hooks/codex/stop.ts:131`
  - `src/hooks/codex/capture.ts:139`
  - `src/hooks/codex/wiki-worker.ts:139,154,168`
  - `src/hooks/cursor/session-start.ts:111,129`
  - `src/hooks/cursor/capture.ts:165`
  - `src/hooks/cursor/wiki-worker.ts:119,134,148`
  - `src/hooks/hermes/session-start.ts:85,103`
  - `src/hooks/hermes/capture.ts:148`
  - `src/hooks/hermes/wiki-worker.ts:119,134,148`
  - `src/hooks/pi/wiki-worker.ts:124,139,153`

  Severity note: the catalog (A3) rates missing-`sqlIdent`-on-config-identifier as Critical; the taint source here is a local environment variable rather than remote input, and table existence is separately validated in the `ensure*` path, so realistic exploitability is High. Fixed regardless to close the gap and restore codebase-wide consistency. `bash-command-compiler.ts` reaches the data layer only through `virtual-table-query.ts`, so it is covered transitively.

---

## Medium Findings

- [x] **Path traversal via unsanitized `sessionId` in the query cache** `src/hooks/query-cache.ts:15-18` - `getSessionQueryCacheDir` did `join(cacheRoot, sessionId)` with the harness-supplied `session_id` unsanitized, while the sibling `writeReadCacheFile` (pre-tool-use.ts:81) already strips `[^a-zA-Z0-9._-]`. A `session_id` containing `..`/`/` would let a cache write/read escape `~/.deeplake/query-cache`. `session_id` is normally a harness UUID (low likelihood), but the inconsistency is a real gap. **Fixed in-session (<5 lines):** sanitize `sessionId` to `[a-zA-Z0-9._-]` (falling back to `"unknown"`) before joining, matching `writeReadCacheFile`.

---

## High Findings (documented - architectural follow-up, NEEDS HUMAN REVIEW)

- [ ] **Prompt-injection blast radius: wiki summarizer runs the agent CLI with permission bypass over untrusted captured content** `src/hooks/wiki-worker-spawn.ts:5-11` (`CLAUDE_FLAGS` = `--permission-mode bypassPermissions`), consumed by `src/hooks/wiki-worker.ts:212-217` and the codex/cursor/hermes/pi worker forks. The summarizer reads reconstructed session JSONL (raw prompts/tool-calls from the team-shared `sessions` table - attacker-influenceable: a poisoned trace authored in a prior session or by another org member) and is told to "Read the session JSONL ... Write the summary file." Because the spawned agent runs with permission bypass and no tool allowlist or cwd sandbox, a prompt-injection payload embedded in captured content could steer it into executing arbitrary tools (A6 / C8). **Not fixed in-session:** the documented working path needs the headless agent to write the summary file, and removing the bypass or restricting tools (`--allowedTools "Read Write"`, sandbox, or pivoting the summarizer to emit to stdout while the worker writes the file) is an unverifiable behavior change here (cannot run the workers under this audit). **Recommended remediation:** constrain the summarizer to a Read/Write tool allowlist and a sandboxed cwd, or restructure so the agent emits summary text to stdout and the worker performs the file write, removing the need for permission bypass. Treat as High; route to a follow-up with the harness-integration owner.

---

## Low Findings (documentation only)

- [ ] **Harness model/provider env values flow into a shell-mode invocation on Windows `.cmd` shims** `src/hooks/cursor/spawn-wiki-worker.ts:111` (`cursorModel` from `HIVEMIND_CURSOR_MODEL`), `src/hooks/hermes/spawn-wiki-worker.ts:112-113` (`hermesProvider`/`hermesModel`). On the Windows `.cmd`/`.bat` `shell: true` path (`wiki-worker-spawn.ts:34-40,61-68`) these become flag values under a shell. Source is an operator-set env var (not remote), and the prompt itself rides stdin, so impact is Low; documented for awareness.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **SQL guards** (`src/utils/sql.ts`) | `sqlIdent` regex `[A-Za-z_][A-Za-z0-9_]*`; values via `sqlStr`/`sqlLike` | grep/search SQL pattern via `sqlLike(params.pattern)` (grep-core.ts:549); values escaped throughout | OK |
| **Config table names via `sqlIdent`** | `HIVEMIND_TABLE`/`HIVEMIND_SESSIONS_TABLE` wrapped at hook query sites | Were raw; now wrapped in all in-scope hook files | OK (fixed) |
| **Pre-tool-use gate** (`src/hooks/pre-tool-use.ts`, `memory-path-utils.ts`) | literal paths only; VFS-confined; substitutions/interpreters rejected | `isSafe` rejects `$()`/backticks/`<()`/`$'...'`, `find -exec`, control keywords; computed `cat` on host explicitly avoided; fallback routes to sandboxed `deeplake-shell.js` with single-quoted argv | OK |
| **Agent-supplied grep/rg pattern -> SQL** | escaped before LIKE/ILIKE | `grep-core.ts` `sqlLike(params.pattern)`; `findVirtualPaths`/find path use `sqlLike` | OK |
| **Spawn / CLI arg injection** | argv arrays, no shell string from input | `spawnDetachedNodeWorker([configFile])`, `execFileSync(file, argv)`, `spawnSync("node",[...])`; Windows `.cmd` path routes prompt via stdin | OK |
| **Capture opt-out** (`HIVEMIND_CAPTURE=false`) | zero INSERTs / DDL | guarded at `capture.ts:76,79`, `codex/capture.ts:72,75`, `hermes/capture.ts`, `cursor/capture.ts`, `session-end.ts:55`, `codex/stop.ts:143`, `session-start.ts:214` (ensure* gated) | OK |
| **No token in logs / traces** | no token in `console.*`/logger or captured rows | token only in `Authorization: Bearer` fetch headers; capture writes prompt/response/tool fields, never headers/env/credentials | OK |
| **Credential file modes (tmp config.json)** | 0600 file / 0700 dir | were default; now explicit | OK (fixed) |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/hooks/spawn-wiki-worker.ts` | tmp dir `0o700`, config.json `0o600` (token confidentiality) |
| `src/hooks/codex/spawn-wiki-worker.ts` | tmp dir `0o700`, config.json `0o600` |
| `src/hooks/cursor/spawn-wiki-worker.ts` | tmp dir `0o700`, config.json `0o600` |
| `src/hooks/hermes/spawn-wiki-worker.ts` | tmp dir `0o700`, config.json `0o600` |
| `src/hooks/virtual-table-query.ts` | `sqlIdent` on memory+sessions table names (3 query builders) |
| `src/hooks/capture.ts` | `sqlIdent` on sessions table in INSERT |
| `src/hooks/upload-summary.ts` | `sqlIdent` on table name (SELECT/UPDATE/INSERT) |
| `src/hooks/session-start.ts` | `sqlIdent` on table in placeholder SELECT/INSERT |
| `src/hooks/wiki-worker.ts` | `sqlIdent` on sessions+memory tables (4 queries) |
| `src/hooks/codex/pre-tool-use.ts` | `sqlIdent` on table in index SELECT |
| `src/hooks/codex/session-start-setup.ts` | `sqlIdent` on table in placeholder SELECT/INSERT |
| `src/hooks/codex/stop.ts` | `sqlIdent` on sessions table in INSERT |
| `src/hooks/codex/capture.ts` | `sqlIdent` on sessions table in INSERT |
| `src/hooks/codex/wiki-worker.ts` | `sqlIdent` on sessions+memory tables |
| `src/hooks/cursor/session-start.ts` | `sqlIdent` on table in placeholder SELECT/INSERT |
| `src/hooks/cursor/capture.ts` | `sqlIdent` on sessions table in INSERT |
| `src/hooks/cursor/wiki-worker.ts` | `sqlIdent` on sessions+memory tables |
| `src/hooks/hermes/session-start.ts` | `sqlIdent` on table in placeholder SELECT/INSERT |
| `src/hooks/hermes/capture.ts` | `sqlIdent` on sessions table in INSERT |
| `src/hooks/hermes/wiki-worker.ts` | `sqlIdent` on sessions+memory tables |
| `src/hooks/pi/wiki-worker.ts` | `sqlIdent` on sessions+memory tables |
| `src/hooks/query-cache.ts` | sanitize `sessionId` path segment (traversal guard) |

`npx tsc --noEmit` passes clean after all edits. `git diff` reviewed and confirmed security-scoped (22 files, all under `src/hooks/`) on 2026-06-16. No files outside `src/hooks/` were touched.

---

## Recommended Follow-Up (architectural)

1. **Constrain the wiki summarizer** (High, above): drop `--permission-mode bypassPermissions` in favor of a Read/Write tool allowlist + sandboxed cwd, or have the agent emit summary text to stdout for the worker to write. Owner: harness-integration.
2. **Out-of-scope mirror sites:** `src/shell/grep-core.ts` (out of C3 scope) builds its dual-table queries with raw `"${memoryTable}"`/`"${sessionsTable}"` interpolation as well; recommend the same `sqlIdent` wrap in a shell-layer sweep for full consistency.
3. **Centralize identifier validation:** consider validating `tableName`/`sessionsTableName` once in `loadConfig()` (config.ts) so every downstream interpolation is safe-by-construction and individual call sites no longer carry the risk.
