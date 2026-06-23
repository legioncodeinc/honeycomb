# QA Report: Claude Code plugin-registration fix

**Plan document:** standalone audit (bug fix, no source PRD/IRD) — see `library/qa/harness/2026-06-23-claude-code-plugin-registration-security.md` for the paired security pass
**Audit date:** 2026-06-23
**Base branch:** `main`
**Head:** `fix/claude-code-plugin-registration` (working tree; changes uncommitted)
**Auditor:** quality-worker-bee

## Summary

**PASS.** The fix makes Honeycomb a real, registerable, hook-bearing Claude Code plugin and the connector drives `honeycomb setup` registration through the injected `claude plugin` CLI. All six verification axes hold and the load-bearing behavior is genuinely test-locked: a fake `PluginCommandRunner` pins the exact argv, idempotency, the hivemind→honeycomb migration, foreign-preserving strip of the old broken hooks, fail-soft (no `${CLAUDE_PLUGIN_ROOT}` written when `claude` is absent), and uninstall. The full DoD gate is green (`npm run ci` 2922 passed / 6 skipped, `build`, `audit:sql`, `audit:openclaw`), `npm pack --dry-run` ships the complete plugin (marketplace.json + plugin.json + hooks/hooks.json + 5-file bundle), and the **real** `claude plugin validate .` returns `✔ Validation passed`. The two findings below are non-blocking: one missing test assertion (the exact add→update→install→enable ordering is implemented but not index-pinned) and one dev-layout `packageRoot()` resolution nuance — neither affects the shipped artifact.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All 6 verification items present in code + test-locked; live `claude plugin validate` confirms ✔. |
| Correctness   | ✅ | Argv/ordering/migration/fail-soft/uninstall behave per spec; verified against fake runner + live CLI validate. |
| Alignment     | ✅ | Subclass seams preserved; hooks relocated to loader-read `hooks/hooks.json`; no OLD root path remains in code. |
| Gaps          | ⚠️ | Exact add→update→install→enable sequence not index-asserted in a test (W-1); idempotency/migration ordering are. |
| Detrimental   | ✅ | No regression — full suite green; bundle gitignored as expected; no broken `${CLAUDE_PLUGIN_ROOT}` fallback. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Exact registration argv ordering (add→update→install→enable) is implemented but not pinned by a test**, `tests/connectors/claude-code.test.ts:80-114`

  The requirement calls for the precise sequence `marketplace add <pkgRoot>` → `marketplace update honeycomb` → `install honeycomb@honeycomb` → `enable honeycomb`. The connector issues exactly that order (`src/connectors/claude-code.ts:151-155`), and tests assert each command is present (`toContain`) and that the migration-remove precedes `marketplace add` (`removeStaleIdx < addHoneycombIdx`). But no test asserts the relative ordering *among the four registration commands themselves*, nor that `marketplace update honeycomb` is issued at all. A future refactor that reordered `enable` before `install`, or dropped `update`, would pass the current suite. Add index assertions for the add→update→install→enable run, mirroring the existing `removeStaleIdx`/`addHoneycombIdx` pattern.

  ```ts
  // present: each command asserted individually + migration-before-add ordering
  expect(cmds).toContain(`plugin marketplace add ${PKG_ROOT}`);
  expect(cmds).toContain(`plugin install ${CLAUDE_PLUGIN_SPEC}`);
  expect(cmds).toContain(`plugin enable ${CLAUDE_PLUGIN_NAME}`);
  // missing: `plugin marketplace update honeycomb` assertion + add<update<install<enable index order
  ```

## Suggestions (consider improving)

- [ ] **`packageRoot()` dev-layout resolution is correct only in the shipped bundle; document or harden the dev path**, `src/cli/connector-runner.ts:35-46`, `src/cli/health-probes.ts:137`

  `resolve(here, "..")` resolves to the package root holding `harnesses/` in the **published** layout (`bundle/cli.js` → `..` = root), which is the path that matters and is verified correct (`npm pack` + `claude plugin validate` both green). In a raw dev `tsc` layout the same module sits at `dist/src/cli/`, where `..` is `dist/src/` (no `harnesses/`). The `HONEYCOMB_PACKAGE_ROOT` env override covers this, and production is unaffected, so this is a robustness/readability note, not a defect. Consider an upward walk to the first dir containing `.claude-plugin/marketplace.json`, or a comment cross-linking the esbuild `bundle/cli.js` outfile (`esbuild.config.mjs:312,325`) that makes the `..` math hold.

- [ ] **`hooks/hooks.json` declares 7 events (includes `SubagentStop`) where the brief enumerates 6**, `harnesses/claude-code/hooks/hooks.json:62-73`

  The manifest ships `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`. The brief's "6 lifecycle events" list omits `SubagentStop`; the distribution test asserts the 6 named events via `toContain` (`tests/connectors/claude-plugin-distribution.test.ts:93`), so the extra event neither breaks the test nor the requirement. `SubagentStop` is a valid Claude Code event and capturing it is reasonable — flagging only so the count discrepancy is a conscious choice, not drift.

## Plan Item Traceability

| #  | Plan Requirement | Status | Implementation Location | Notes |
|----|------------------|--------|-------------------------|-------|
| 1  | Marketplace validates: string source `"./harnesses/claude-code"`, not object form; test asserts shape + names = `honeycomb` | ✅ | `.claude-plugin/marketplace.json:15`; `tests/connectors/claude-plugin-distribution.test.ts:42-66` | Live `claude plugin validate .` → ✔ Validation passed. |
| 2  | Plugin provides all 6 hooks at moved path `hooks/hooks.json` referencing `${CLAUDE_PLUGIN_ROOT}/bundle/index.js`; nothing points at OLD root | ✅ | `harnesses/claude-code/hooks/hooks.json`; `tests/connectors/claude-plugin-distribution.test.ts:91-96` | grep of `src/` confirms no OLD `harnesses/claude-code/hooks.json` reference; 7 events shipped (S-2). |
| 3  | npm ships the plugin: `files` includes `harnesses/claude-code/hooks`; test asserts allowlist; `npm pack --dry-run` lists it; complete plugin ships | ✅ | `package.json:34`; `tests/connectors/claude-plugin-distribution.test.ts:81-89` | `npm pack --dry-run` lists marketplace.json + plugin.json + hooks/hooks.json + 5-file bundle. |
| 4a | Connector drives exact argv: `marketplace add` → `marketplace update honeycomb` → `install honeycomb@honeycomb` → `enable honeycomb` | ✅ | `src/connectors/claude-code.ts:151-155`; `tests/connectors/claude-code.test.ts:80-96` | Exact 4-command ordering not index-pinned by a test (W-1); commands individually asserted. |
| 4b | Idempotency: re-run is a no-op | ✅ | `src/connectors/claude-code.ts:148-155`; `tests/connectors/claude-code.test.ts:159-167` | Test asserts identical argv across two runs. |
| 4c | hivemind→honeycomb migration: stale hivemind removed BEFORE honeycomb added | ✅ | `src/connectors/claude-code.ts:145,188-196`; `tests/connectors/claude-code.test.ts:98-114` | `removeStaleIdx < addHoneycombIdx` asserted. |
| 4d | Prior broken top-level honeycomb hooks stripped, foreign-preserving | ✅ | `src/connectors/claude-code.ts:192-195`; `tests/connectors/claude-code.test.ts:116-157` | Two tests: ours stripped, `/other/tool.js` survives. |
| 4e | Fail-soft when `claude` absent: NO broken `${CLAUDE_PLUGIN_ROOT}`; absolute-path fallback + clear notice | ✅ | `src/connectors/claude-code.ts:141,203-211,244-256`; `tests/connectors/claude-code.test.ts:169-192` | Test asserts no `${CLAUDE_PLUGIN_ROOT}`, resolved absolute path written, notice surfaced. |
| 4f | Uninstall reverses: plugin uninstall + marketplace remove | ✅ | `src/connectors/claude-code.ts:172-185`; `tests/connectors/claude-code.test.ts:194-231` | Plugin uninstall + marketplace remove + fallback strip (foreign preserved) asserted. |
| 5  | D5 status probe reports claude-code capture off plugin install/enable state (not old hooks.json check); test-locked, hermetic | ✅ | `src/cli/health-probes.ts:77-85`; `src/connectors/plugin-runner.ts:61-72`; `tests/cli/health-probes.test.ts:34-46`; `tests/connectors/plugin-runner.test.ts` | Injected runner; `parsePluginEnabled` pinned against live CLI output shape (enabled/disabled/absent/neighbour). |
| 6  | No regression: connector/conformance/auto-wiring tests pass; base settings.json = no-runner fallback; `bundle` gitignored build output | ✅ | `tests/connectors/claude-code.test.ts:240-271`; `git check-ignore harnesses/claude-code/bundle` | Full `npm run ci` green (2922 passed); bundle confirmed gitignored — expected, not a missing-file gap. |
| 7  | DoD: `npm run ci` / `build` / `audit:sql` / `audit:openclaw` green; tests real; real `~/.claude` untouched | ✅ | gate run outputs | CI 2922/6-skip green; build green; audit:sql clean (213 files); audit:openclaw clean. `sources/api.test.ts` passed in full run. |
| NG | Do not mutate real `~/.claude`; report-only, no code/asset changes | ✅ | tests use injected fake fs / temp homes | All connector tests point at `/home/dev` fake fs; no real `~/.claude` write. This audit changed no code or assets. |

## Files Changed

- `.claude-plugin/marketplace.json` (M), plugin source changed from rejected `{source:"git-subdir",path:…}` object to accepted string `"./harnesses/claude-code"`.
- `harnesses/claude-code/hooks/hooks.json` (R, from `harnesses/claude-code/hooks.json`), hooks manifest relocated to the dir Claude Code's plugin loader reads; declares 7 lifecycle events on `${CLAUDE_PLUGIN_ROOT}/bundle/index.js`.
- `harnesses/claude-code/src/index.ts` (M), doc comment updated to reference the plugin's `hooks/hooks.json` + `${CLAUDE_PLUGIN_ROOT}` instead of the old root-level hooks.json.
- `package.json` (M), `files` allowlist adds `harnesses/claude-code/hooks` so npm ships the hooks manifest.
- `src/cli/connector-runner.ts` (M), wires `createClaudePluginRunner()` + `packageRoot()` + a `notify` sink into the claude-code connector builder.
- `src/cli/health-probes.ts` (M), D5 probe + status health source now read plugin install/enable state via the injected runner; injectable for hermetic tests.
- `src/connectors/claude-code.ts` (M), connector overrides `install()`/`uninstall()` to drive `claude plugin` registration (migrate → add → update → install → enable), with fail-soft absolute-path fallback and packageRoot guard.
- `src/connectors/index.ts` (M), re-exports `CLAUDE_PLUGIN_NAME`/`CLAUDE_PLUGIN_SPEC`/`STALE_MARKETPLACE_NAME` and the plugin-runner API.
- `src/connectors/plugin-runner.ts` (A), the injectable `PluginCommandRunner` seam + production `spawnSync`-backed runner + `parsePluginEnabled` parser for `claude plugin list`.
- `tests/cli/health-probes.test.ts` (M), D5 tests use a fake plugin runner; assert plugin-enabled → healthy, not-enabled → soft fail.
- `tests/connectors/claude-code.test.ts` (M), full registration suite via fake runner: argv, idempotency, migration ordering, strip/preserve, fail-soft, uninstall, packageRoot guard.
- `tests/connectors/claude-plugin-distribution.test.ts` (A), asserts marketplace shape/names/source, plugin.json existence, npm `files` hooks coverage, and the 6 lifecycle events at the shipped path.
- `tests/connectors/plugin-runner.test.ts` (A), pins `parsePluginEnabled` against the real `claude plugin list` output shape (enabled/disabled/absent/empty/neighbour).
