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

/**
 * An import that reaches the daemon storage module is a boundary violation — EXCEPT the
 * pure escaping helpers in `daemon/storage/sql.ts`.
 *
 * The invariant's purpose (this file's header) is that no non-daemon code OPENS DeepLake
 * itself: it must reach storage by dialing the daemon, never by holding a connection. The
 * `sql.ts` module opens NOTHING — it is pure, synchronous, dependency-free string escaping
 * (`sqlStr`/`sqlLike`/`sqlIdent`/`sLiteral`/`eLiteral`), the SQL-injection floor. Importing
 * it pulls in no DeepLake client, no transport, no `node:` IO — so it does not violate the
 * "only the daemon links DeepLake" property. The `audit-sql-safety.mjs` gate already treats
 * `sql.ts` as the special module that DEFINES the escaping; this exemption mirrors that.
 *
 * A thin client that BUILDS SQL to dispatch THROUGH the daemon (PRD-015's `DeepLakeFs`)
 * legitimately escapes its values with these helpers. Every OTHER `daemon/storage/*`
 * specifier — `client`, `index`, `writes`, `heal`, `vector`, `result`, `config`, the
 * `catalog/*` — remains banned: those carry (or barrel-re-export) the connection.
 */
const STORAGE_IMPORT = /from\s+["'][^"']*daemon\/storage\/(?!sql(?:\.js)?["'])[^"']*["']/;

/**
 * The bare `daemon/storage` package specifier (the barrel `index.ts`) — banned. The negative
 * lookahead above only exempts the explicit `…/sql` file path; a bare `…/daemon/storage` or
 * `…/daemon/storage/index` still re-exports the client and must be flagged.
 */
const STORAGE_BARREL_IMPORT = /from\s+["'][^"']*daemon\/storage(?:\/index(?:\.js)?)?["']/;

/**
 * Strip line + block comments before matching, so a `daemon/storage` MENTION in JSDoc prose
 * (e.g. "a stray `from ".../daemon/storage"` import fails the build") is never mistaken for a
 * real import statement. The scan must detect IMPORTS, not documentation about imports.
 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** True when a source file imports the storage client/barrel (NOT the pure `sql.ts`). */
function importsStorage(src: string): boolean {
	const code = stripComments(src);
	return STORAGE_IMPORT.test(code) || STORAGE_BARREL_IMPORT.test(code);
}

describe("a-AC-5: only the daemon links DeepLake; non-daemon roots never import storage", () => {
	it("a-AC-5 no non-daemon source file imports src/daemon/storage", () => {
		const offenders: string[] = [];
		for (const root of NON_DAEMON_ROOTS) {
			const files: string[] = [];
			collectTs(join(REPO_ROOT, root.split("/").join(sep)), files);
			for (const file of files) {
				const src = readFileSync(file, "utf-8");
				if (importsStorage(src)) offenders.push(file);
			}
		}
		expect(offenders, `non-daemon files importing DeepLake storage: ${offenders.join(", ")}`).toEqual([]);
	});

	it("a-AC-5 the storage module itself lives under src/daemon/", () => {
		expect(existsSync(join(REPO_ROOT, "src", "daemon", "storage", "client.ts"))).toBe(true);
	});

	it("a-AC-5 the daemon-client surface (the 3850 seam) carries no DeepLake CLIENT import", () => {
		// The thin-client surface may escape SQL with the PURE `daemon/storage/sql.ts` helpers
		// (PRD-015 `DeepLakeFs` builds SQL to dispatch THROUGH the daemon), but must never hold
		// the storage CLIENT/barrel. `importsStorage` allows the pure `sql.ts`, bans the rest.
		const dcDir = join(REPO_ROOT, "src", "daemon-client");
		const files: string[] = [];
		collectTs(dcDir, files);
		for (const file of files) {
			expect(importsStorage(readFileSync(file, "utf-8")), `${file} imports the storage client`).toBe(false);
		}
	});
});
