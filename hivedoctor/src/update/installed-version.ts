/**
 * The globally-installed-package version reader (PRD-064e auto-update "installed" source).
 *
 * The auto-update engine's "installed version" is the GLOBALLY-INSTALLED npm PACKAGE version
 * of the primary daemon (`@legioncodeinc/honeycomb`), NOT the running daemon's `/health`
 * version. They diverge in exactly the case auto-update exists for: when the daemon is DOWN,
 * `/health` returns null, so the daemon-version reader ({@link file://../cli/daemon-version.ts})
 * yields null and the engine would refuse to update -- precisely when an update/repair is most
 * wanted. The installed PACKAGE version is still on disk (npm recorded it), so this reader can
 * answer "0.1.8 is installed" even with the daemon down.
 *
 * It reads `npm ls -g <pkg> --depth=0 --json` through the SAME injected command runner the
 * rungs use ({@link file://../rungs/command-runner.js}: execFile, fixed argv, no shell). The
 * runner launches npm cross-platform (node + npm-cli.js, no shell); there is no platform
 * special-casing here.
 *
 * Fail-soft (design principle 1): any non-zero exit, transport/spawn failure, unparseable
 * JSON, or missing `dependencies[<pkg>].version` key resolves to `null` ("installed unknown"),
 * NEVER a throw. A null installed version simply means the engine declines this tick -- it can
 * never trigger a bad install. Built-ins ONLY (via the injected runner).
 *
 * Note on `npm ls` exit codes: `npm ls` exits NON-ZERO when the tree has problems (missing
 * peers, extraneous packages) EVEN when it still prints valid JSON with the version. So we do
 * NOT gate parsing on `result.ok`: we always attempt to parse stdout, and only fall back to
 * null when the version key is genuinely absent or the body is not JSON.
 */

import type { CommandRunner } from "../rungs/command-runner.js";
import type { ReadInstalledVersionFn } from "./update-engine.js";

/** Options for {@link createInstalledPackageVersionReader}. */
export interface InstalledPackageReaderOptions {
	/** The command runner (the ONLY thing that runs npm). Reuses the rungs' boundary. */
	readonly runner: CommandRunner;
	/** The npm package whose globally-installed version is read. */
	readonly pkg: string;
	/** Per-read timeout in ms (default: the runner's own default). */
	readonly timeoutMs?: number;
}

/**
 * Extract `dependencies[pkg].version` from an `npm ls --json` body. Returns null when the
 * body is not JSON, has no `dependencies` object, lacks an entry for `pkg`, or carries no
 * usable `version` string. Defensive: NEVER throws.
 */
export function parseInstalledVersion(body: string, pkg: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const dependencies = (parsed as Record<string, unknown>).dependencies;
	if (dependencies === null || typeof dependencies !== "object") return null;
	const entry = (dependencies as Record<string, unknown>)[pkg];
	if (entry === null || typeof entry !== "object") return null;
	const version = (entry as Record<string, unknown>).version;
	return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
}

/**
 * Build a {@link ReadInstalledVersionFn} that reads the GLOBALLY-INSTALLED package version
 * via `npm ls -g <pkg> --depth=0 --json` through the injected runner. Fail-soft: any error,
 * non-parseable body, or missing key resolves to null. NEVER throws.
 */
export function createInstalledPackageVersionReader(
	options: InstalledPackageReaderOptions,
): ReadInstalledVersionFn {
	return async (): Promise<string | null> => {
		try {
			const result = await options.runner.run(
				"npm",
				["ls", "-g", options.pkg, "--depth=0", "--json"],
				options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined,
			);
			// Do NOT gate on result.ok: `npm ls` can exit non-zero on tree warnings while still
			// printing the version in valid JSON. Parse stdout regardless; the parse fail-softs.
			return parseInstalledVersion(result.stdout, options.pkg);
		} catch {
			// The runner never throws, but this keeps the reader total even if a test stub does.
			return null;
		}
	};
}
