/**
 * PRD-015a a-AC-6 / D-6 — the thin-client invariant, asserted at the VFS module level.
 *
 * `tests/daemon/storage/invariant.test.ts` already proves NO file under `src/daemon-client`
 * imports `daemon/storage`. This test pins the same property SPECIFICALLY for the VFS module
 * + names it after a-AC-6, so a future edit that reaches for the storage client fails a test
 * named for the criterion it violates. Belt-and-braces: the VFS reaches storage ONLY through
 * the `DaemonDispatch` seam.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VFS_DIR = fileURLToPath(new URL("../../../src/daemon-client/vfs/", import.meta.url));

function vfsSourceFiles(): string[] {
	return readdirSync(VFS_DIR)
		.filter((f) => f.endsWith(".ts"))
		.map((f) => join(VFS_DIR, f));
}

/**
 * Extract the module specifiers of REAL `import`/`export ... from` statements only (not
 * specifiers that appear in JSDoc prose). Anchored to a statement that starts with
 * `import`/`export` and carries a `from "..."`.
 */
function importSpecifiers(src: string): string[] {
	const specs: string[] = [];
	const re = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s+["']([^"']+)["']/g;
	for (let m = re.exec(src); m !== null; m = re.exec(src)) specs.push(m[1]);
	return specs;
}

/** A specifier that reaches the daemon storage CLIENT — a boundary violation (a-AC-6). */
const STORAGE_CLIENT = /daemon\/storage\/(client|index|writes|heal|vector|result)/;

describe("a-AC-6 the VFS module dispatches through the daemon, never opens DeepLake", () => {
	it("a-AC-6 no VFS source file imports the daemon storage client", () => {
		const offenders = vfsSourceFiles().filter((file) =>
			importSpecifiers(readFileSync(file, "utf-8")).some((s) => STORAGE_CLIENT.test(s)),
		);
		expect(offenders, `VFS files importing the storage client: ${offenders.join(", ")}`).toEqual([]);
	});

	it("a-AC-6 the VFS module only imports the PURE sql helpers + the PURE graph renderer from daemon/", () => {
		// Any `daemon/` import must resolve to the pure escaping helpers (`storage/sql`) or the
		// pure, zero-network graph renderer (`runtime/codebase/query` or its `contracts`).
		const allowed = /daemon\/storage\/sql\.js|daemon\/runtime\/codebase\/(query|contracts)\.js/;
		for (const file of vfsSourceFiles()) {
			const daemonImports = importSpecifiers(readFileSync(file, "utf-8")).filter((s) => s.includes("daemon/"));
			for (const imp of daemonImports) {
				expect(imp, `unexpected daemon import in ${file}: ${imp}`).toMatch(allowed);
			}
		}
	});
});
