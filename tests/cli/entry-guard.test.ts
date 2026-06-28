/**
 * Regression guard for the npm-bin entry detection (PRD-001b FR-8 / b-AC-6).
 *
 * The bug (PR #172): the bundle's "am I the entry point?" guard tested
 * `process.argv[1].endsWith("cli.js")` — i.e. the symlink NAME. The npm global install
 * reaches the bundle through a SYMLINK named `honeycomb` → `bundle/cli.js`; Node realpaths
 * `import.meta.url` to `…/cli.js` but leaves `argv[1]` the symlink path `…/bin/honeycomb`,
 * so the guard never matched and `main()` never ran → every command exited 0 in silence.
 *
 * The fix mirrors the daemon's `isMainEntry`: test `import.meta.url` (the realpath'd,
 * always-forward-slash module URL) with `endsWith("/cli.js")`, plus a `pathToFileURL`
 * comparison against argv[1] for the `--preserve-symlinks-main` case. `isCliEntry` must
 * fire for the bundle URL however it is reached, and must NOT fire when merely imported
 * (the source module is `index.ts`, not `cli.js`).
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isCliEntry } from "../../src/cli/index.js";

describe("isCliEntry — fires across every published invocation path (PR #172)", () => {
	it("matches direct bundle execution: `node bundle/cli.js`", () => {
		// import.meta.url is the bundle URL; argv[1] is the same file. Matches on the URL clause.
		expect(isCliEntry("file:///opt/app/bundle/cli.js", "/opt/app/bundle/cli.js")).toBe(true);
	});

	it("matches the Unix npm bin SYMLINK — the original bug", () => {
		// THE regression: argv[1] is the symlink (`…/bin/honeycomb`, NOT cli.js), but Node sets
		// import.meta.url to the realpath'd `…/bundle/cli.js`. The pre-fix guard checked argv[1]'s
		// name and missed this; `import.meta.url.endsWith("/cli.js")` catches it.
		expect(isCliEntry("file:///usr/local/lib/node_modules/x/bundle/cli.js", "/usr/local/bin/honeycomb")).toBe(true);
	});

	it("matches the Windows npm SHIM — import.meta.url is a forward-slash URL on every OS", () => {
		// npm on Windows runs `node C:\...\bundle\cli.js`; import.meta.url is `file:///C:/.../cli.js`
		// (URLs are always forward-slash), so `endsWith("/cli.js")` holds regardless of host.
		const winArgv = "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\x\\bundle\\cli.js";
		expect(isCliEntry("file:///C:/Users/dev/AppData/Roaming/npm/node_modules/x/bundle/cli.js", winArgv)).toBe(true);
	});

	it("matches under --preserve-symlinks-main, where import.meta.url stays the symlink path", () => {
		// In this mode import.meta.url does NOT end in /cli.js; the pathToFileURL(argv1) clause
		// carries the match. Both sides go through pathToFileURL so the assertion is host-independent.
		const bin = "/usr/local/bin/honeycomb";
		expect(isCliEntry(pathToFileURL(bin).href, bin)).toBe(true);
	});

	it("does NOT fire when the module is merely imported (source is index.ts, not cli.js)", () => {
		// A test runner or another module imports src/cli/index.ts — main() must stay dormant.
		expect(isCliEntry("file:///repo/src/cli/index.js", "/repo/node_modules/.bin/vitest")).toBe(false);
	});

	it("does NOT fire for an empty / absent argv[1]", () => {
		expect(isCliEntry("file:///repo/src/cli/index.js", undefined)).toBe(false);
		expect(isCliEntry("file:///repo/src/cli/index.js", "")).toBe(false);
	});
});

// End-to-end repro of the exact original failure: an `honeycomb` symlink pointing at a
// cli.js module must execute its entry branch (non-empty output), not silently exit.
// Symlink creation needs privilege on Windows, so this faithful repro is Unix-only; the
// Windows shim path is covered by the forward-slash-URL unit case above (and the Windows
// CI test matrix runs these unit cases with real pathToFileURL semantics).
const symlinkRepro = process.platform === "win32" ? describe.skip : describe;
symlinkRepro("npm bin symlink executes the entry branch end-to-end (Unix)", () => {
	it("runs main()-equivalent work through a `honeycomb` → cli.js symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-entry-"));
		try {
			// A minimal module that reuses the SAME guard shape and prints only when it's the entry.
			const cliPath = join(dir, "cli.js");
			writeFileSync(
				cliPath,
				[
					"import { pathToFileURL } from 'node:url';",
					// Inline copy of isCliEntry so the repro has no build/import dependency.
					"function isCliEntry(importMetaUrl, argv1) {",
					"  if (typeof argv1 !== 'string' || argv1.length === 0) return false;",
					"  try { return importMetaUrl === pathToFileURL(argv1).href || importMetaUrl.endsWith('/cli.js'); }",
					"  catch { return false; }",
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
