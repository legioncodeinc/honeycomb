/**
 * Path-containment helper (PRD-064 Aikido SAST hardening).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every on-disk artifact HiveDoctor touches lives under a single workspace dir
 * that is RESOLVED FROM THE ENVIRONMENT (`HONEYCOMB_WORKSPACE` / the CLI cwd, see
 * src/config.ts). That base is therefore a variable, and each store joins a FIXED
 * literal filename onto it (`state.json`, `install.lock`, `incidents.ndjson`,
 * `needs-attention.json`, `removed-packages.ndjson`). A taint tracker (Aikido)
 * cannot prove the filename is constant, so it flags every `readFileSync(filePath)`
 * / `writeFileSync(filePath)` as a potential path-traversal sink ("file inclusion
 * via reading file").
 *
 * {@link resolveInBase} closes that gap with genuine defense-in-depth, not a
 * cosmetic launder: it (1) rejects a filename carrying ANY path separator or a
 * `..` segment, (2) resolves the base to an absolute, normalized path, (3) joins
 * the segments and re-normalizes, and (4) ASSERTS the result is still contained
 * within the resolved base. A poisoned `HONEYCOMB_WORKSPACE` (or a future caller
 * passing a hostile segment) thus cannot escape the workspace, and the tainted
 * path now flows through a validator the SAST taint-tracker can see.
 *
 * ── Binding constraints ──────────────────────────────────────────────────────
 * - ZERO runtime deps: `node:path` built-ins ONLY (HiveDoctor design principle 1).
 * - Strict ESM, TS strict. The base itself is trusted to BE the root; we only
 *   guarantee the joined result does not escape it. Resolving the base further
 *   (e.g. realpath) is out of scope: the workspace IS the authority.
 */

import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Thrown when a path segment would escape its base dir (separator / `..` in a
 * fixed filename, or a joined result outside the resolved base). Callers in the
 * stores catch broadly and fail-soft (log + degrade), so a containment violation
 * degrades EXACTLY like the existing defensive read/write error handling and
 * never crashes the watchdog.
 */
export class PathContainmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathContainmentError";
	}
}

/** True iff `child` is the same as, or nested under, `base` (both already resolved). */
function isContained(base: string, child: string): boolean {
	if (child === base) return true;
	// Compare with a trailing separator so `/a/bc` is NOT treated as under `/a/b`.
	const baseWithSep = base.endsWith(sep) ? base : base + sep;
	return child.startsWith(baseWithSep);
}

/**
 * Resolve one or more FIXED, literal path segments under `baseDir`, guaranteeing
 * the result stays inside `baseDir`. Intended for joining a constant filename
 * (e.g. `"state.json"`) onto a variable-derived workspace dir.
 *
 * @param baseDir   The containing directory (the trusted root; a variable is fine).
 * @param segments  One or more fixed filename / subdir segments. Each MUST be a
 *                   plain name: no path separator, no `..`, non-empty.
 * @returns         The absolute, normalized, contained path.
 * @throws {PathContainmentError} on a hostile segment or an escaping result.
 */
export function resolveInBase(baseDir: string, ...segments: string[]): string {
	if (segments.length === 0) {
		throw new PathContainmentError("resolveInBase requires at least one path segment");
	}
	for (const segment of segments) {
		if (segment.length === 0) {
			throw new PathContainmentError("empty path segment");
		}
		// Reject any separator (both POSIX `/` and Windows `\`) and any `..` traversal.
		// A legitimate fixed filename never contains these.
		if (segment.includes("/") || segment.includes("\\")) {
			throw new PathContainmentError(`path segment must not contain a separator: ${segment}`);
		}
		if (segment === ".." || segment === ".") {
			throw new PathContainmentError(`path segment must not be a traversal token: ${segment}`);
		}
	}

	// Resolve the base to an absolute, normalized path. `resolve` anchors a relative
	// base against the cwd; `normalize` collapses any `.`/`..` already in the base.
	const resolvedBase = normalize(resolve(baseDir));
	const candidate = normalize(resolve(resolvedBase, ...segments));

	if (!isContained(resolvedBase, candidate)) {
		throw new PathContainmentError(
			`resolved path escapes its base (base=${resolvedBase}, resolved=${candidate})`,
		);
	}
	return candidate;
}

/**
 * Assert that an ALREADY-COMPOSED absolute path is contained within `baseDir`.
 * Used where a path is built from a fixed multi-segment structure that the caller
 * composes itself (e.g. the daemon-service unit paths); routes the tainted base
 * through the same containment check before it reaches a file syscall.
 *
 * @throws {PathContainmentError} when `candidatePath` is not absolute or escapes.
 */
export function assertWithinBase(baseDir: string, candidatePath: string): string {
	if (!isAbsolute(candidatePath)) {
		throw new PathContainmentError(`expected an absolute path: ${candidatePath}`);
	}
	const resolvedBase = normalize(resolve(baseDir));
	const candidate = normalize(candidatePath);
	if (!isContained(resolvedBase, candidate)) {
		throw new PathContainmentError(
			`path escapes its base (base=${resolvedBase}, path=${candidate})`,
		);
	}
	return candidate;
}
