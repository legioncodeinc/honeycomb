/**
 * Dependency-free semantic-version compare for the auto-update engine (PRD-064e).
 *
 * The blessed gate must answer one question: "is the candidate version strictly
 * NEWER than what is installed?" (AC-064e.1 / AC-064e.2). The `semver` npm package
 * would answer it, but the watchdog runtime is Node built-ins ONLY (PRD-064 design
 * principle 1, "incapable of crashing -- zero runtime deps"). So this module parses
 * and compares the small slice of SemVer 2.0.0 that npm `@latest` tags actually use:
 * `MAJOR.MINOR.PATCH` with an optional `-prerelease` and an ignored `+build`.
 *
 * The comparison rules mirror SemVer precedence (semver.org #11):
 *   - numeric MAJOR/MINOR/PATCH compared numerically;
 *   - a version WITH a prerelease is LOWER than the same version without one
 *     (`1.2.0-rc.1` < `1.2.0`);
 *   - prerelease identifiers compared left-to-right: numeric < numeric numerically,
 *     any-numeric < any-alphanumeric, alphanumeric compared lexically, and a longer
 *     identifier list wins when all shared identifiers are equal.
 *
 * Defensive by construction (design principle 1): an unparseable version yields
 * `null` from {@link parseVersion}, and {@link isStrictlyNewer} treats any unparseable
 * input as "not newer" so a garbage CDN/registry string can never trigger an update.
 */

/** A parsed SemVer core + optional prerelease (build metadata is parsed but ignored). */
export interface ParsedVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	/** The prerelease identifiers (e.g. `["rc", 1]`), or an empty array for a release. */
	readonly prerelease: readonly (string | number)[];
}

/** Matches `MAJOR.MINOR.PATCH` with an optional `-prerelease` and an optional `+build`. */
const SEMVER_RE =
	/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** True iff a prerelease identifier is a pure run of digits (numeric identifier). */
function isNumericIdentifier(id: string): boolean {
	return id.length > 0 && /^\d+$/.test(id);
}

/**
 * Parse a version string into its core + prerelease parts, or `null` when it is not a
 * valid `MAJOR.MINOR.PATCH[-prerelease][+build]`. A leading `v` is tolerated (some tags
 * carry it). Never throws.
 */
export function parseVersion(raw: string): ParsedVersion | null {
	const trimmed = raw.trim().replace(/^v/, "");
	const m = SEMVER_RE.exec(trimmed);
	if (m === null) return null;

	// The first three capture groups are guaranteed digit runs by the regex, but
	// noUncheckedIndexedAccess means we must narrow them before Number.parseInt.
	const majorRaw = m[1];
	const minorRaw = m[2];
	const patchRaw = m[3];
	if (majorRaw === undefined || minorRaw === undefined || patchRaw === undefined) return null;

	const prereleaseRaw = m[4];
	const prerelease: (string | number)[] =
		prereleaseRaw === undefined
			? []
			: prereleaseRaw.split(".").map((id) => (isNumericIdentifier(id) ? Number.parseInt(id, 10) : id));

	return {
		major: Number.parseInt(majorRaw, 10),
		minor: Number.parseInt(minorRaw, 10),
		patch: Number.parseInt(patchRaw, 10),
		prerelease,
	};
}

/** Compare two prerelease identifier lists per SemVer #11. Returns -1 / 0 / 1. */
function comparePrerelease(a: readonly (string | number)[], b: readonly (string | number)[]): number {
	// A version WITHOUT a prerelease outranks one WITH a prerelease.
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1; // a is a release, b is a prerelease -> a is higher
	if (b.length === 0) return -1;

	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const ai = a[i];
		const bi = b[i];
		if (ai === undefined || bi === undefined) break;
		const aNum = typeof ai === "number";
		const bNum = typeof bi === "number";
		if (aNum && bNum) {
			if (ai !== bi) return ai < bi ? -1 : 1;
		} else if (aNum !== bNum) {
			// Numeric identifiers always have lower precedence than alphanumeric ones.
			return aNum ? -1 : 1;
		} else {
			// Both alphanumeric: compare lexically (ASCII order).
			const as = String(ai);
			const bs = String(bi);
			if (as !== bs) return as < bs ? -1 : 1;
		}
	}
	// All shared identifiers equal: the longer list has higher precedence.
	if (a.length !== b.length) return a.length < b.length ? -1 : 1;
	return 0;
}

/**
 * Compare two parsed versions by SemVer precedence. Returns -1 (a < b), 0 (equal), or
 * 1 (a > b). Core fields first, then prerelease.
 */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * True iff `candidate` is a valid version STRICTLY newer than `installed`. Fail-closed:
 * if either string is unparseable, returns `false` (never "newer"), so a garbage version
 * from the registry or the blessed channel can never trigger an update. Equal versions
 * are NOT newer (an already-installed blessed version is a no-op, not an update).
 */
export function isStrictlyNewer(candidate: string, installed: string): boolean {
	const c = parseVersion(candidate);
	const i = parseVersion(installed);
	if (c === null || i === null) return false;
	return compareParsed(c, i) > 0;
}

/** True iff the two strings parse to the SAME SemVer precedence (build metadata ignored). */
export function isSameVersion(a: string, b: string): boolean {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null || pb === null) return false;
	return compareParsed(pa, pb) === 0;
}
