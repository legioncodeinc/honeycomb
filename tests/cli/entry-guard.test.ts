/**
 * Regression guard for the npm-bin entry detection (PRD-001b FR-8 / b-AC-6).
 *
 * The bug (PR #172): the bundle's "am I the entry point?" guard only matched
 * `import.meta.url === file://${argv[1]}` or `argv[1].endsWith("cli.js")`. The npm
 * global install reaches the bundle two ways the guard missed:
 *   - Unix: a SYMLINK named `honeycomb` → `bundle/cli.js`. Node realpaths
 *     `import.meta.url` to `…/cli.js` but leaves `argv[1]` the symlink path
 *     `…/bin/honeycomb`, so neither clause matched → `main()` never ran → silent exit 0.
 *   - Windows: a `.cmd`/`.ps1` shim runs `node C:\…\bundle\cli.js` with BACKSLASHES.
 *     The first proposed fix used `split("/")` to take the basename, which never
 *     splits a backslash path, so it would have re-broken the Windows path.
 *
 * `isCliEntry` must therefore fire for the bundle path, the Unix symlink, AND the
 * Windows backslash shim path — and must NOT fire when the module is merely imported.
 * The basename split on BOTH separators is what makes that hold on any test host.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isCliEntry } from "../../src/cli/index.js";

describe("isCliEntry — fires across every published invocation path (PR #172)", () => {
	it("matches direct bundle execution: `node bundle/cli.js`", () => {
		// Unix-style absolute path, as Node reports it for a direct run.
		expect(isCliEntry("file:///opt/app/bundle/cli.js", "/opt/app/bundle/cli.js")).toBe(true);
	});

	it("matches a relative bundle path (`node bundle/cli.js` from the repo root)", () => {
		// import.meta.url is always absolute; argv[1] is verbatim what was typed.
		expect(isCliEntry("file:///repo/bundle/cli.js", "bundle/cli.js")).toBe(true);
	});

	it("matches the npm bin basename when realpath can't be resolved (symlink not on disk)", () => {
		// realpathSync throws on a non-existent path → falls back to raw; basename is `honeycomb`.
		expect(isCliEntry("file:///nope.js", "/usr/local/bin/honeycomb")).toBe(true);
	});

	it("matches the Windows npm shim path (backslashes) — the split('/') regression", () => {
		const winPath = "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@legioncodeinc\\honeycomb\\bundle\\cli.js";
		// import.meta.url (forward slashes) won't equal the backslash argv on Windows, so the
		// match must come from the basename / endsWith clauses — exactly what split('/') broke.
		expect(isCliEntry("file:///C:/Users/dev/.../bundle/cli.js", winPath)).toBe(true);
	});

	it("matches a Windows backslash path to a `honeycomb`-named bin", () => {
		expect(isCliEntry("file:///nope.js", "C:\\tools\\bin\\honeycomb")).toBe(true);
	});

	it("does NOT fire when the module is merely imported (some unrelated entry)", () => {
		// e.g. a test runner or another bundle imports src/cli/index.ts — main() must stay dormant.
		expect(isCliEntry("file:///repo/src/cli/index.js", "/repo/node_modules/.bin/vitest")).toBe(false);
	});

	it("does NOT fire for an empty / absent argv[1]", () => {
		expect(isCliEntry("file:///repo/src/cli/index.js", undefined)).toBe(false);
		expect(isCliEntry("file:///repo/src/cli/index.js", "")).toBe(false);
	});
});

// End-to-end repro of the exact original failure: an `honeycomb` symlink pointing at a
// cli-shaped module must execute its entry branch (non-empty output), not silently exit.
// Symlink creation needs privilege on Windows, so this faithful repro is Unix-only; the
// Windows path is already covered by the backslash unit cases above.
const symlinkRepro = process.platform === "win32" ? describe.skip : describe;
symlinkRepro("npm bin symlink executes the entry branch end-to-end (Unix)", () => {
	it("runs main()-equivalent work through a `honeycomb` → cli.js symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-entry-"));
		try {
			// A minimal module that reuses the SAME guard and prints only when it's the entry.
			const cliPath = join(dir, "cli.js");
			writeFileSync(
				cliPath,
				[
					"import { realpathSync } from 'node:fs';",
					// Inline copy of isCliEntry's logic so the repro has no build/import dependency.
					"function isCliEntry(importMetaUrl, argv1) {",
					"  const raw = argv1 ?? '';",
					"  let real = raw;",
					"  try { real = realpathSync(raw); } catch {}",
					"  const base = (p) => p.split(/[/\\\\]/).pop() ?? '';",
					"  return importMetaUrl === `file://${raw}` || importMetaUrl === `file://${real}` ||",
					"    raw.endsWith('cli.js') || base(real) === 'cli.js' || base(real) === 'honeycomb';",
					"}",
					"if (isCliEntry(import.meta.url, process.argv[1])) process.stdout.write('RAN');",
				].join("\n"),
				"utf8",
			);
			const binPath = join(dir, "honeycomb"); // the npm-style symlink (no .js extension)
			symlinkSync(cliPath, binPath);

			const out = spawnSync(process.execPath, [binPath], { encoding: "utf8" });
			expect(out.status).toBe(0);
			expect(out.stdout).toBe("RAN"); // pre-fix this was empty — the silent-exit bug
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
