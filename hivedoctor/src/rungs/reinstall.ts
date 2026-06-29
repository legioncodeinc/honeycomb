/**
 * Rung 2: reinstall the primary (PRD-064c, AC-064c.1 / AC-064c.4 / AC-064c.6).
 *
 * Fires AFTER 3 consecutive failed restarts (the ladder advances to rung 2 via OD-4).
 * It does a clean GLOBAL reinstall of `@legioncodeinc/honeycomb` to fix a corrupted /
 * stale install - the "stale global daemon serves old routes" failure mode - then
 * VERIFIES the install took by re-reading the running version and comparing it to the
 * blessed version. The actual daemon restart that picks up the new binary is the
 * supervisor's next-tick job; this rung's contract is "install the blessed bits and
 * confirm they are present".
 *
 * Authority (OD-4): autonomous, no confirm gate. Concurrency: the install runs ONLY
 * while holding the shared {@link file://../install-lock.ts} mutex, so it can never
 * race the 064e auto-update engine's npm install. If the lock is held it SKIPS (the
 * other installer is already doing the work).
 *
 * Idempotency (AC-064c.4): `npm i -g <pkg>` is itself idempotent (a second run with the
 * version already present is a no-op reinstall). Re-running the rung when the running
 * version ALREADY matches the blessed version short-circuits to a skip before touching
 * npm, so a healthy box is never needlessly reinstalled.
 *
 * Absent blessed version (fail-soft, PRD-064e/B-3): the blessed version is single-sourced
 * from the blessed channel, which is unreachable until the CDN object exists. When the
 * caller has no blessed version (an empty string), the rung still reinstalls (the repair
 * is valuable on its own) but DEGRADES the verify step to "performed, cannot verify"
 * rather than failing: with nothing to compare against, an exact-version assertion would
 * be meaningless. The reinstall therefore reports `ok: true` with an `unverified-no-blessed`
 * detail, so a missing channel never blocks or fails the repair.
 *
 * Crash-safety (design principle 1): every step is inside the rung's own try/catch AND
 * the command-runner never throws; any failure resolves to a failed {@link RungResult}
 * so the ladder/escalation proceeds. Built-ins only (via the injected runner + lock).
 */

import type { InstallLock } from "../install-lock.js";
import type { Rung, RungContext, RungResult } from "../remediation.js";
import type { CommandRunner } from "./command-runner.js";

/** The npm package name of the primary Honeycomb daemon (the thing rung 2 reinstalls). */
export const PRIMARY_PACKAGE = "@legioncodeinc/honeycomb";

/** Reads the currently-installed/running primary version, or null when undeterminable. Injected. */
export type ReadInstalledVersionFn = () => Promise<string | null>;

/** Construction deps for rung 2. */
export interface ReinstallRungDeps {
	/** The injected command runner (the only thing that touches npm). */
	readonly runner: CommandRunner;
	/** The shared install mutex, so reinstall + auto-update never run concurrently. */
	readonly installLock: InstallLock;
	/**
	 * The version HiveDoctor expects after a good install (single-sourced from the blessed
	 * channel). An empty string means "no blessed version known" (the channel is unreachable
	 * until B-3 ships the CDN object); in that case the rung still reinstalls but degrades the
	 * verify step to a fail-soft "cannot verify" instead of a hard failure.
	 */
	readonly blessedVersion: string;
	/**
	 * Re-read the running primary version AFTER the install (e.g. via `/health`), so the
	 * rung can confirm the reinstall took. Injected so tests are hermetic.
	 */
	readonly readInstalledVersion: ReadInstalledVersionFn;
	/**
	 * Optional fail-soft seam that resolves the live blessed version at run-time (e.g. by
	 * fetching the blessed channel). When present and it yields a non-empty version, the rung
	 * verifies against THAT instead of the static {@link blessedVersion}; when it yields an
	 * empty string or throws, the rung falls back to {@link blessedVersion}. This lets the
	 * composition root thread the real blessed version through without the rung ever blocking
	 * or failing on an unreachable channel (B-3). Default: not provided (use the static value).
	 */
	readonly resolveBlessedVersion?: () => Promise<string>;
	/** Per-install timeout in ms (default: the runner's own default). */
	readonly installTimeoutMs?: number;
}

/** Stable action verb recorded in the incident step for this rung. */
const ACTION = "reinstall-primary";

/**
 * Resolve the blessed version fail-soft. When a {@link ReinstallRungDeps.resolveBlessedVersion}
 * seam is wired, consult it (e.g. the blessed channel) and use its result when non-empty;
 * if it throws or yields an empty string, fall back to the static {@link ReinstallRungDeps.blessedVersion}.
 * Never throws: an unreachable channel degrades to the static value (which may itself be "").
 */
async function resolveBlessedVersion(deps: ReinstallRungDeps, ctx: RungContext): Promise<string> {
	if (deps.resolveBlessedVersion === undefined) return deps.blessedVersion;
	try {
		const resolved = (await deps.resolveBlessedVersion()).trim();
		return resolved.length > 0 ? resolved : deps.blessedVersion;
	} catch (error) {
		ctx.logger.warn("rung2.blessed_resolve_failed", { reason: error instanceof Error ? error.message : "unknown" });
		return deps.blessedVersion;
	}
}

/** Build rung 2 (reinstall primary). */
export function createReinstallRung(deps: ReinstallRungDeps): Rung {
	return {
		rung: 2,
		name: ACTION,
		async run(ctx: RungContext): Promise<RungResult> {
			try {
				// Resolve the blessed version fail-soft: prefer the live channel seam when it yields
				// a real version, else fall back to the static value. A throwing or empty channel
				// degrades to "" (no blessed version known) and never blocks the repair.
				const blessedVersion = await resolveBlessedVersion(deps, ctx);

				// Idempotency short-circuit: if the running version already matches the blessed one,
				// the install is fine - do NOT reinstall a healthy box (AC-064c.4). With no blessed
				// version known we cannot prove the box is healthy, so we never short-circuit here.
				const before = await deps.readInstalledVersion();
				if (before !== null && blessedVersion.length > 0 && before === blessedVersion) {
					ctx.logger.info("rung2.skip_already_blessed", { version: before });
					return { ok: true, skipped: true, action: ACTION, detail: "already-blessed" };
				}

				// Serialize against the auto-update engine: only one global npm install at a time.
				const handle = deps.installLock.acquire("reinstall");
				if (handle === null) {
					ctx.logger.warn("rung2.skip_lock_held");
					return { ok: false, skipped: true, action: ACTION, detail: "install-lock-held" };
				}

				try {
					ctx.logger.info("rung2.reinstall_start", { pkg: PRIMARY_PACKAGE });
					const result = await deps.runner.run(
						"npm",
						["install", "-g", PRIMARY_PACKAGE],
						deps.installTimeoutMs !== undefined ? { timeoutMs: deps.installTimeoutMs } : undefined,
					);
					if (!result.ok) {
						ctx.logger.error("rung2.reinstall_failed", { code: result.code, detail: result.detail });
						return { ok: false, action: ACTION, detail: result.detail ?? `npm-exit-${result.code}` };
					}

					// Verify the install took: the running version must now be the blessed one
					// (AC-064c.1, "version reported by /health matches the blessed version").
					const after = await deps.readInstalledVersion();
					// Fail-soft when no blessed version is known (empty channel): the reinstall still
					// ran, but there is nothing to compare against, so report "performed, cannot verify"
					// rather than a hard failure. A missing channel must never block the repair (B-3).
					if (blessedVersion.length === 0) {
						ctx.logger.info("rung2.reinstall_unverified_no_blessed", { version: after ?? "null" });
						return { ok: true, action: ACTION, detail: "unverified-no-blessed" };
					}
					if (after === blessedVersion) {
						ctx.logger.info("rung2.reinstall_verified", { version: after });
						return { ok: true, action: ACTION, detail: `verified-${after}` };
					}
					ctx.logger.warn("rung2.reinstall_unverified", { expected: blessedVersion, got: after ?? "null" });
					return { ok: false, action: ACTION, detail: `unverified-got-${after ?? "null"}` };
				} finally {
					// Always free the mutex, even if verification threw.
					handle.release();
				}
			} catch (error) {
				// Defensive: any unexpected throw becomes a failed result so the ladder continues.
				const detail = error instanceof Error ? error.message : "unknown";
				ctx.logger.error("rung2.threw", { reason: detail });
				return { ok: false, action: ACTION, detail };
			}
		},
	};
}
