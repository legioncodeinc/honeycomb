/**
 * Regression guard for the npm-bin entry detection (PRD-001b FR-8 / b-AC-6).
 *
 * The bug (PR #172): the bundle's "am I the entry point?" guard tested
 * `process.argv[1].endsWith("cli.js")` — i.e. the symlink NAME. The npm global install
 * reaches the bundle through a SYMLINK named `honeycomb` → `bundle/cli.js`; Node realpaths
 * `import.meta.url` to `…/cli.js` but leaves `argv[1]` the symlink path `…/bin/honeycomb`,
 * so the guard never matched and `main()` never ran → every command exited 0 in silence.
 *
 * The fix compares `import.meta.url` (the realpath'd module URL) against `argv[1]` resolved
 * through `realpathSync` (which lands on the same `…/cli.js`), plus a raw `pathToFileURL`
 * comparison for `--preserve-symlinks-main`. The realpath comparison is also what keeps the
 * guard from firing on a plain import: when imported, `argv[1]` is some OTHER entry, so it
 * resolves to a different file than this module's URL.
 *
 * The realpath path needs files on disk, so the symlink/import-distinction cases live in the
 * Unix real-FS block; the pure-string cases below cover the raw `pathToFileURL` clause.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isCliEntry } from "../../src/cli/index.js";

/** Build a file URL the same way Node derives import.meta.url, so assertions are host-independent. */
const url = (p: string): string => pathToFileURL(p).href;

describe("isCliEntry — raw pathToFileURL clause (pure, host-independent)", () => {
	it("matches direct bundle execution: `node bundle/cli.js`", () => {
		// import.meta.url and argv[1] point at the same file → matches without touching the FS.
		expect(isCliEntry(url("/opt/app/bundle/cli.js"), "/opt/app/bundle/cli.js")).toBe(true);
	});

	it("matches the Windows npm shim, whose argv[1] IS the real cli.js path (backslashes)", () => {
		// npm on Windows runs `node C:\...\bundle\cli.js` (no symlink); argv[1] equals the module.
		// pathToFileURL handles the backslash path correctly — unlike a `file://${path}` concat.
		const winArgv = "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\x\\bundle\\cli.js";
		expect(isCliEntry(url(winArgv), winArgv)).toBe(true);
	});

	it("matches under --preserve-symlinks-main, where import.meta.url stays the symlink path", () => {
		// import.meta.url is the symlink itself; the raw argv[1] comparison carries the match.
		const bin = "/usr/local/bin/honeycomb";
		expect(isCliEntry(url(bin), bin)).toBe(true);
	});

	it("does NOT fire when merely imported (argv[1] is an unrelated, unresolvable entry)", () => {
		// A test runner imports the module — argv[1] is the runner, not this file → no match.
		expect(isCliEntry(url("/repo/bundle/cli.js"), "/repo/node_modules/.bin/vitest")).toBe(false);
	});

	it("does NOT fire for an empty / absent argv[1]", () => {
		expect(isCliEntry(url("/repo/bundle/cli.js"), undefined)).toBe(false);
		expect(isCliEntry(url("/repo/bundle/cli.js"), "")).toBe(false);
	});
});

// The realpath clause + the import-vs-execute distinction need real files on disk. Symlink
// creation needs privilege on Windows, so this block is Unix-only; the Windows shim (argv[1]
// IS the cli.js path, no symlink) is already covered by the pure case above and runs on the
// Windows CI matrix with real pathToFileURL semantics.
const realFs = process.platform === "win32" ? describe.skip : describe;
realFs("isCliEntry — realpath clause + import distinction (Unix real FS)", () => {
	it("matches the npm bin SYMLINK in-process (the original bug)", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-entry-"));
		try {
			const cliPath = join(dir, "cli.js");
			writeFileSync(cliPath, "export {};\n", "utf8");
			const binPath = join(dir, "honeycomb"); // npm-style symlink, no .js extension
			symlinkSync(cliPath, binPath);
			// import.meta.url is the realpath (cli.js); argv[1] is the symlink. realpathSync(argv[1])
			// resolves back to cli.js → match. Pre-fix this returned false (the silent-exit bug).
			expect(isCliEntry(url(cliPath), binPath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does NOT match when argv[1] is a real but DIFFERENT file (genuine import)", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-entry-"));
		try {
			const cliPath = join(dir, "cli.js");
			const otherPath = join(dir, "runner.js");
			writeFileSync(cliPath, "export {};\n", "utf8");
			writeFileSync(otherPath, "export {};\n", "utf8");
			// Module is cli.js but the process entry is runner.js → realpath differs → no run on import.
			expect(isCliEntry(url(cliPath), otherPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executes the entry branch end-to-end through a `honeycomb` → cli.js symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-entry-"));
		try {
			// A minimal module reusing the SAME guard shape; prints only when it's the entry.
			const cliPath = join(dir, "cli.js");
			writeFileSync(
				cliPath,
				[
					"import { realpathSync } from 'node:fs';",
					"import { pathToFileURL } from 'node:url';",
					"function isCliEntry(importMetaUrl, argv1) {",
					"  if (typeof argv1 !== 'string' || argv1.length === 0) return false;",
					"  try {",
					"    if (importMetaUrl === pathToFileURL(argv1).href) return true;",
					"    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;",
					"  } catch { return false; }",
					"}",
					"if (isCliEntry(import.meta.url, process.argv[1])) process.stdout.write('RAN');",
				].join("\n"),
				"utf8",
			);
			const binPath = join(dir, "honeycomb");
			symlinkSync(cliPath, binPath);

			const out = spawnSync(process.execPath, [binPath], { encoding: "utf8" });
			expect(out.status).toBe(0);
			expect(out.stdout).toBe("RAN"); // pre-fix this was empty — the silent-exit bug
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
