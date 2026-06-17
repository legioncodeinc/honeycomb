/**
 * PRD-002a a-AC-5: the daemon is the only DeepLake client.
 *
 * The storage adapter (the DeepLake path) must live ONLY under `src/daemon/`.
 * No non-daemon source root — `src/cli`, `src/daemon-client`, `mcp/`,
 * `harnesses/*`, `embeddings/` — may import the storage module, directly or via
 * a relative path. Non-daemon code reaches storage by dialing the daemon on
 * port 3850 (the daemon-client surface), never by opening DeepLake itself.
 *
 * This is enforced as a static import-graph assertion: we scan every
 * non-daemon `.ts` source file for an import that resolves into
 * `src/daemon/storage`. A match fails the test and the build, the same way the
 * OpenClaw audit gates `process.env` out of that bundle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Source roots that must stay DeepLake-free (everything but src/daemon). */
const NON_DAEMON_ROOTS = ["src/cli", "src/daemon-client", "src/shared", "mcp", "harnesses", "embeddings"];

/** Recursively collect `.ts` files (skipping bundles/dist/node_modules). */
function collectTs(dir: string, out: string[]): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry === "bundle") continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) collectTs(full, out);
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
	}
}

/** An import that reaches the daemon storage module is a boundary violation. */
const STORAGE_IMPORT = /from\s+["'][^"']*daemon\/storage[^"']*["']/;

describe("a-AC-5: only the daemon links DeepLake; non-daemon roots never import storage", () => {
	it("a-AC-5 no non-daemon source file imports src/daemon/storage", () => {
		const offenders: string[] = [];
		for (const root of NON_DAEMON_ROOTS) {
			const files: string[] = [];
			collectTs(join(REPO_ROOT, root.split("/").join(sep)), files);
			for (const file of files) {
				const src = readFileSync(file, "utf-8");
				if (STORAGE_IMPORT.test(src)) offenders.push(file);
			}
		}
		expect(offenders, `non-daemon files importing DeepLake storage: ${offenders.join(", ")}`).toEqual([]);
	});

	it("a-AC-5 the storage module itself lives under src/daemon/", () => {
		expect(existsSync(join(REPO_ROOT, "src", "daemon", "storage", "client.ts"))).toBe(true);
	});

	it("a-AC-5 the daemon-client surface (the 3850 seam) carries no DeepLake import", () => {
		const dcDir = join(REPO_ROOT, "src", "daemon-client");
		const files: string[] = [];
		collectTs(dcDir, files);
		for (const file of files) {
			expect(STORAGE_IMPORT.test(readFileSync(file, "utf-8"))).toBe(false);
		}
	});
});
