# Security Audit — Claude Code Plugin Registration

- **Date:** 2026-06-23
- **Branch:** `fix/claude-code-plugin-registration`
- **Auditor:** security-worker-bee
- **Scope:** the Claude Code plugin-registration fix (marketplace.json shape, plugin `hooks/hooks.json` relocation, `plugin-runner.ts`, `claude-code.ts` install/uninstall orchestration, `connector-runner.ts` wiring, `health-probes.ts` D5)
- **Verdict:** **PASS** (no Critical/High findings; zero remediations required)

---

## Executive Summary

This branch replaces a broken top-level-hooks wiring with first-party Claude Code marketplace-plugin registration driven through the `claude plugin` CLI. The audit focused on the five risk areas named in the brief: command/argument injection through `spawnSync`, package-root path handling, foreign-preservation of the migration + strip, fail-soft leakage, and the npm publish surface.

**No Critical or High findings. No code changes were made** — the diff under review is exactly the implementation, unmutated by this audit. Every deterministic guard (audit:sql, audit:openclaw, pack-check) passes, the full CI gate is green (2922 tests passed, 0 failures), and the build succeeds.

Ordering is correct: no `*-qa-report.md` exists for this branch (`library/qa/` checked), so `security-worker-bee` ran before `quality-worker-bee` as required. `quality-worker-bee` may now run.

Scope note: this is fully in-catalog (TypeScript connector + install-time CLI shell-out). No new datastore or non-TS subsystem introduced; full-fidelity coverage applies.

---

## Audit-Focus Findings

### 1. Command / argument injection via `spawnSync("claude", args)` — PASS

`src/connectors/plugin-runner.ts:88` — the production runner calls
`spawnSync(binary, args as string[], { encoding, windowsHide, timeout })`.

- **Argv array, never a shell string.** `args` is a `readonly string[]` passed as the second positional argument. There is **no `shell: true`**, no string concatenation into a command line, and no `exec`/`execSync` anywhere in the plugin flow (grep over `plugin-runner.ts` confirms only `spawnSync` from `node:child_process`).
- **Discrete argv elements.** Call sites in `claude-code.ts:151-155, 181-182, 190-191` pass `pkgRoot`, `CLAUDE_PLUGIN_NAME`, `CLAUDE_PLUGIN_SPEC`, and `STALE_MARKETPLACE_NAME` as separate array elements. A `packageRoot` containing spaces or shell metacharacters (`;`, `&&`, `$()`, backticks) is delivered verbatim to `claude` as one argument — the OS `execvp` boundary never invokes a shell, so injection is structurally impossible.
- **No untrusted interpolation.** The only values reaching argv are the constant plugin/marketplace names and the install-dir path. None derive from captured traces, MCP tool args, or network input.

Conclusion: argument injection is not reachable. **None detected.**

### 2. Path handling (`packageRoot()` + settings.json fallback) — PASS

`src/cli/connector-runner.ts:35-44` — `packageRoot()` resolves
`resolve(dirname(fileURLToPath(import.meta.url)), "..")` (the installed package dir, derived from the module's own location), with an opt-in `HONEYCOMB_PACKAGE_ROOT` env override.

- **Not attacker-controlled.** The default is the module path — it cannot be redirected by a captured trace, a tool argument, or network input. The `HONEYCOMB_PACKAGE_ROOT` override is a local operator/relocated-install escape hatch (same trust level as the user running `honeycomb setup`); it is not a remote or cross-tenant input, so it is not a privilege boundary. Marketplace registration therefore always points at the genuine installed package dir holding `.claude-plugin/marketplace.json`.
- **Fallback write is safe.** The settings.json fallback (`claude-code.ts:244-256`, `hookHandlers()`) builds `command: node "${this.opts.pluginRoot}/bundle/${file}"` with a **resolved absolute** `pluginRoot` (default `<home>/.claude/plugins/honeycomb`) — never the unresolved `${CLAUDE_PLUGIN_ROOT}` literal. The write goes through the inherited `writeJsonIfChanged` → `JSON.stringify` (`contracts.ts:314-320, 533`), so the path lands as a properly JSON-escaped string value; there is no string-concatenation into the settings.json document and foreign keys are preserved by the base merge engine.

Conclusion: path cannot be tricked into an arbitrary marketplace target; fallback JSON write is injection-safe. **None detected.**

### 3. Migration + strip are foreign-preserving — PASS

`src/connectors/claude-code.ts:188-196` (`migrate`) + the inherited strip in `src/connectors/contracts.ts:295-305, 542-555`.

- **Strip is keyed on the Honeycomb marker, not a broad match.** `isHoneycombEntry` (`contracts.ts:295-305`) returns true **iff** the entry carries the `_honeycomb: true` sentinel (`HONEYCOMB_ENTRY_KEY`), with a back-compat fallback that matches only a `command` containing the exact substring `/honeycomb/bundle/`. A foreign third-party hook carries neither, so it is never classified as Honeycomb's.
- **Foreign data preserved verbatim.** `stripHoneycomb` (`contracts.ts:542-555`) filters only Honeycomb entries out of each event block, drops emptied blocks, and **preserves foreign matcher blocks, foreign hook entries, and all foreign top-level keys** (`{ ...config }` spread). The stale-`hivemind`-marketplace removal (`claude-code.ts:190-191`) targets the literal name `hivemind` via `marketplace remove` — it cannot touch the user's other marketplaces or plugins.
- **Best-effort, non-destructive.** Removing an absent marketplace or stripping absent hooks is a documented no-op; migration never gates on these results.

Conclusion: removal is precisely scoped to Honeycomb-marked entries; user hooks, marketplaces, and settings are untouched. **None detected.**

### 4. Fail-soft leaks nothing + leaves a clean state — PASS

`src/connectors/claude-code.ts:203-211` (`failSoftInstall`) + `225-228` (`note`).

- **No secret / sensitive detail in the notice.** The fail-soft notice emits only the non-sensitive config path (`~/.claude/settings.json`), the literal plugin spec (`honeycomb@honeycomb`), and manual-register guidance. Grep over `claude-code.ts` for `token|Bearer|credentials|secret|apiKey|Authorization|process.env` returned **no matches** — no credential material is in scope of this connector at all (it is a `NON_DAEMON_ROOT`: no DeepLake, no token handling).
- **No broken `${CLAUDE_PLUGIN_ROOT}` written.** When `claude` is absent the connector writes the resolved-absolute-path fallback via `hookHandlers()` (point 2 above) — the unresolved `${CLAUDE_PLUGIN_ROOT}` literal is confined to the plugin's own shipped `hooks/hooks.json` (where the host injects it), never to the settings.json fallback. The notice and the `console.log` sink (`connector-runner.ts:69`) carry only the safe notice text.

Conclusion: fail-soft is leak-free and leaves a runnable, correct fallback. **None detected.**

### 5. npm publish surface — PASS

`package.json:34` adds `harnesses/claude-code/hooks` to the `files` allowlist.

- **Shipped file is static, secret-free config.** `harnesses/claude-code/hooks/hooks.json` is 7 lifecycle-hook blocks, each a constant `node "${CLAUDE_PLUGIN_ROOT}/bundle/index.js"` command. No token, credential, path-to-secret, or PII.
- **`pack-check` clean.** `node scripts/pack-check.mjs` → `pack-check OK — 61 files, no forbidden patterns, all required runtime files present`.
- **`audit:openclaw` clean.** `Scanned 1 file(s) under harnesses/openclaw/dist/ — OK, no findings`.
- **Pack dry-run confirms the surface.** `npm pack --dry-run` ships `harnesses/claude-code/hooks/hooks.json` and **no** `credentials.json` / `.env` / secret file. (The only `token`-substring matches in the tarball are `assets/tokens/*.css` design tokens — false positives, not secrets.)

Conclusion: the publish surface is static config only; guards stay green. **None detected.**

---

## Catalog Sweep (every category checked)

| Catalog | Category | Result |
|---|---|---|
| A (AI-code) | A1 missing `sqlIdent` on config table name | N/A — no SQL in this change. `audit:sql` PASS (213 files). |
| A | A2 string-gate path bypass | N/A — no pre-tool-use gate change. |
| A | A3 unscoped `me\|team` query | N/A — connector is install-time, no recall. |
| A | A4 hidden-Unicode rules backdoor | None detected — no `.cursor/rules` change. |
| A | A5 hallucinated deps | None detected — no new dependency added (only `node:child_process`, `node:path`, `node:os`, `node:url`, `node:fs`). |
| A | A6 prompt-injection via poisoned trace | N/A — no recall/skill-injection path touched. |
| A | A7 token leakage to logs | None detected — connector handles no tokens; notify sink emits only safe notice text. |
| A | A8 gate-runner bypass tampering | None detected — `gate-runner.ts` untouched. |
| B (OWASP) | A03 injection (SQL / command) | None detected — `spawnSync` argv array, no shell (focus #1). |
| B | A01 broken access control / scope | N/A — no query layer touched. |
| B | A08 software/data integrity (supply chain) | None detected — pack-check + audit:openclaw PASS (focus #5). |
| B | A05 security misconfiguration | None detected — no broken `${CLAUDE_PLUGIN_ROOT}` written (focus #4). |
| B | A09 logging failures | None detected — no sensitive data logged. |
| C (PII/cred) | C1 credential file modes | N/A — no credential file write in this change. |
| C | C2 tokens/PII in logging | None detected (focus #4). |
| C | C3 org-id/scope from untrusted input | N/A — no org/scope handling. |
| C | C4–C9 over-capture / persisted secret / opt-out / retention | N/A — connector performs no capture/INSERT. |

---

## Files Changed (under audit — not modified by this audit)

| File | Change | Security note |
|---|---|---|
| `.claude-plugin/marketplace.json` | source object → `"./harnesses/claude-code"` string | Valid plugin-source shape; no secret. |
| `harnesses/claude-code/hooks.json → hooks/hooks.json` | git rename | Static config; relocation only. |
| `package.json` | `files` += `harnesses/claude-code/hooks` | Ships static hook config; pack-check clean. |
| `src/connectors/plugin-runner.ts` (new) | `spawnSync` runner + `parsePluginEnabled` | Argv array, no shell; regex name properly escaped. |
| `src/connectors/claude-code.ts` | install/uninstall/migrate orchestration | Foreign-preserving strip; resolved-path fallback. |
| `src/cli/connector-runner.ts` | wires runner + `packageRoot()` | Module-path-derived root; not attacker-controlled. |
| `src/cli/health-probes.ts` | D5 plugin install/enable probe | Read-only `claude plugin list`; injectable runner. |
| `src/connectors/index.ts`, `harnesses/claude-code/src/index.ts` | exports / doc | No behavior change. |
| tests (3 files) | coverage for the above | — |

---

## Verification Run

| Check | Result |
|---|---|
| `npm run audit:sql` | PASS — every SQL interpolation routes through an escaping helper (213 files). |
| `npm run audit:openclaw` | PASS — bundle clean against ClawHub rules. |
| `npm run build` | PASS — all bundles built @ 0.1.0. |
| `npm run ci` (typecheck + dup + test + audit:sql) | PASS — 258 files, 2922 passed, 6 skipped, 0 failures. |
| `scripts/pack-check.mjs` | PASS — 61 files, no forbidden patterns. |
| `git diff --diff-filter=D --name-only` | zero deletions (the one `R` is a tracked rename). |
| `git status --short -- assets/` | empty — no `assets/` mutation. |
| `.scan-output/` | absent — nothing to stage. |

---

## Residual Risk

- **Low.** The only operator-trust input is the `HONEYCOMB_PACKAGE_ROOT` env override; it is not a remote/cross-tenant boundary and is documented as a relocated-install escape hatch. No action required.
- The fix correctly confines `${CLAUDE_PLUGIN_ROOT}` to the plugin-shipped `hooks/hooks.json`; if a future change ever writes that literal into top-level settings.json, it would silently break capture — covered by the existing fallback tests, worth keeping under test.

## Remediations Applied

None. No Critical or High findings; no Medium fixable under 5 lines that warranted a touch. The diff under review was not modified by this audit.
