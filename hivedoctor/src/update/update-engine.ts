/**
 * The auto-update transaction engine (PRD-064e AC-064e.1 / .3 / .5 / .6).
 *
 * `runUpdateTransaction` performs ONE update attempt, atomically-as-npm-allows:
 *
 *   1. record the current installed version (the rollback target);
 *   2. consult the gate ({@link file://./update-policy.ts}) -- it decides go/no-go from
 *      installed + latest + blessed + opt-out (the engine just supplies the I/O);
 *   3. ACQUIRE the shared install lock ({@link file://../install-lock.ts}) so the update
 *      can never race rung 2's reinstall-as-repair (AC-064e.6) -- if the lock is held,
 *      SKIP (the other installer is already doing the work);
 *   4. `npm i -g @legioncodeinc/honeycomb@<blessed>` through the injected runner;
 *   5. restart the daemon (injected) so it picks up the new binary;
 *   6. poll `/health` (injected) -- on healthy, DONE (outcome "updated", AC-064e.1);
 *   7. on a FAILED post-update health, ROLL BACK: reinstall the recorded prior version,
 *      restart, and re-verify, so the daemon returns to healthy on the OLD version
 *      (AC-064e.3); emit a rollback telemetry event either way (AC-064e.5).
 *
 * npm global installs are not transactional; the recorded-prior-version + verify +
 * rollback loop is how we APPROXIMATE atomicity (PRD-064e Technical considerations).
 *
 * Crash-safety (design principle 1): every external call is behind an injected seam that
 * resolves a value rather than throwing, and the whole body is wrapped so any unexpected
 * throw becomes a failed {@link UpdateTransactionResult}. An update error NEVER crashes
 * HiveDoctor (binding constraint: fail-soft). The install lock is ALWAYS released in a
 * `finally`. Built-ins only (via the injected runner, lock, restart, and health seams).
 */

import type { InstallLock } from "../install-lock.js";
import type { Logger } from "../logger.js";
import type { CommandRunner } from "../rungs/command-runner.js";
import { fetchBlessedVersion, type BlessedChannelOptions } from "./blessed-channel.js";
import type { ReadLatestVersionFn } from "./registry.js";
import { decideUpdate, type NoUpdateReason, type UpdateDecision, type UpdateOptOut } from "./update-policy.js";
import { parseVersion } from "./version.js";
import {
	createDefaultUpdateEmit,
	type UpdateEmit,
	type UpdateOutcome,
} from "./update-telemetry.js";

/** The npm package name of the primary Honeycomb daemon (the thing auto-update installs). */
export const PRIMARY_PACKAGE = "@legioncodeinc/honeycomb";

/** Reads the currently-installed primary version, or null when undeterminable. Injected. */
export type ReadInstalledVersionFn = () => Promise<string | null>;

/**
 * Restarts the primary daemon so it picks up a freshly-installed binary. Injected (064a path).
 *
 * May resolve a boolean: `true` = the restart was actually performed (a supervised daemon /
 * registered OS service exists), `false` = there was no way to restart (no OS service, no
 * running daemon to signal). `void` is treated as "unknown -> assume supervised" so existing
 * callers that resolve nothing keep today's behavior. The boolean feeds the FIX-2 verify rule:
 * when there is no daemon to restart, a still-unhealthy `/health` afterward must NOT trigger a
 * destructive rollback (the update cannot have made an already-down daemon worse).
 */
export type RestartDaemonFn = () => Promise<void | boolean>;

/** Polls `/health` after a restart; resolves true when the daemon is healthy. Injected. */
export type VerifyHealthyFn = () => Promise<boolean>;

/** Construction deps for {@link createUpdateEngine}. All I/O behind injectable seams. */
export interface UpdateEngineDeps {
	/** The command runner (the ONLY thing that runs npm). Reuses the 064c rungs' boundary. */
	readonly runner: CommandRunner;
	/** The shared install mutex, so auto-update + reinstall never run concurrently (AC-064e.6). */
	readonly installLock: InstallLock;
	/** Reads npm `@latest` for the primary package (fail-soft; null = unknown). */
	readonly readLatestVersion: ReadLatestVersionFn;
	/** Reads the currently-installed primary version (fail-soft; null = unknown). */
	readonly readInstalledVersion: ReadInstalledVersionFn;
	/** Restart the daemon after an install (064a restart path). */
	readonly restartDaemon: RestartDaemonFn;
	/** Poll `/health` and report whether the daemon is healthy. */
	readonly verifyHealthy: VerifyHealthyFn;
	/** The blessed-channel fetch options (URL + injected fetch + timeout). */
	readonly blessedOptions?: BlessedChannelOptions;
	/** The opt-out + pin inputs (resolved by the caller from flags / env / state). */
	readonly optOut: UpdateOptOut;
	/** The stable per-install device id (PRD-033 UUID) stamped on telemetry events. */
	readonly deviceId: string;
	/** The update/rollback telemetry seam (default: the 064d chokepoint adapter). */
	readonly emit?: UpdateEmit;
	/** Logger. */
	readonly logger: Logger;
	/** Injected clock for telemetry timestamps (default `Date.now`). */
	readonly now?: () => number;
	/** Per-install timeout in ms (default: the runner's own default). */
	readonly installTimeoutMs?: number;
}

/** The terminal status of one transaction attempt. */
export type UpdateTransactionStatus =
	| "updated" // installed + verified healthy on the new version (AC-064e.1)
	| "updated_unverified" // installed, but there was no healthy baseline / no supervised daemon to verify against, so health verification was skipped and the new version is KEPT (not rolled back)
	| "rolled_back" // post-update health failed; recovered on the prior version (AC-064e.3)
	| "rollback_failed" // post-update health failed AND rollback did not recover
	| "install_failed" // the npm install itself failed
	| "no_update" // the gate declined (opt-out / pin / not blessed / already current / fail-closed)
	| "skipped_lock_held" // the shared install lock was held (AC-064e.6: serialized, no concurrent install)
	;

/** The structured result of one transaction. Never thrown; failure is a value. */
export interface UpdateTransactionResult {
	readonly status: UpdateTransactionStatus;
	/** The version installed before the attempt (the rollback target), when known. */
	readonly fromVersion?: string;
	/** The version the attempt targeted, when a go was reached. */
	readonly toVersion?: string;
	/** The gate's no-go reason, present only when `status` is `no_update`. */
	readonly noUpdateReason?: NoUpdateReason;
	/** A short, secret-free detail for logs/tests. */
	readonly detail?: string;
}

/**
 * A pure DRY-RUN of the update decision (`hivedoctor update --check`). It reads the same
 * three inputs the real transaction reads (installed + latest + blessed) and runs the SAME
 * gate ({@link decideUpdate}), but performs NO mutation: it never acquires the install lock,
 * never runs `npm install`, never restarts, and never verifies/rolls back. A "check" must
 * PREVIEW, never mutate.
 */
export interface UpdatePreview {
	/** True when the gate would update (installed < blessed and latest == blessed, no opt-out). */
	readonly eligible: boolean;
	/** The currently-installed version, or null when the installed read failed this tick. */
	readonly fromVersion: string | null;
	/** The version an update would target (the blessed version), present only when eligible. */
	readonly toVersion?: string;
	/** The gate's no-go reason, present only when NOT eligible. */
	readonly reason?: NoUpdateReason;
}

/** The update engine surface: one transaction per call. */
export interface UpdateEngine {
	/** Run ONE update attempt. Crash-safe: resolves a result, never throws. */
	runUpdateTransaction(): Promise<UpdateTransactionResult>;
	/**
	 * Preview the update decision WITHOUT mutating anything: read installed + latest + blessed,
	 * run the SAME gate as {@link runUpdateTransaction}, and return the decision. NEVER acquires
	 * the install lock, runs npm, restarts, or rolls back. Crash-safe: resolves a value, never
	 * throws. This is what `update --check` calls so a "check" can never install/restart/roll back.
	 */
	previewUpdate(): Promise<UpdatePreview>;
}

/** Map a transaction status to the telemetry outcome (AC-064e.5). */
function outcomeOf(status: UpdateTransactionStatus): UpdateOutcome | null {
	switch (status) {
		case "updated":
			return "updated";
		case "updated_unverified":
			return "updated_unverified";
		case "rolled_back":
			return "rolled_back";
		case "rollback_failed":
			return "rollback_failed";
		case "install_failed":
			return "install_failed";
		default:
			// no_update / skipped_lock_held: nothing was installed, so no from/to event fires.
			return null;
	}
}

/** Build the auto-update engine. */
export function createUpdateEngine(deps: UpdateEngineDeps): UpdateEngine {
	const now = deps.now ?? Date.now;
	const emit = deps.emit ?? createDefaultUpdateEmit();

	/** Install one exact version of the primary package through the injected runner. */
	async function installVersion(version: string): Promise<boolean> {
		if (parseVersion(version) === null) {
			// SECURITY (defense-in-depth, no-arbitrary-spec): validate `version` as strict SemVer
			// BEFORE composing the `name@version` npm spec. The gate path only yields a parseable
			// blessed version, but the ROLLBACK path passes the installed version read from the
			// daemon's `/health` JSON (network-sourced, unvalidated). A spoofed/poisoned version
			// (`latest`, a range like `>=0.0.0`, any non-semver) must NEVER reach `npm install`,
			// else npm resolves an attacker-chosen spec. Refuse it here (= failed install).
			// execFile already blocks shell-metacharacter injection; this closes the npm
			// argument/spec-injection gap too.
			deps.logger.error("autoupdate.install_rejected_bad_version", { version });
			return false;
		}
		const spec = `${PRIMARY_PACKAGE}@${version}`;
		const result = await deps.runner.run(
			"npm",
			["install", "-g", spec],
			deps.installTimeoutMs !== undefined ? { timeoutMs: deps.installTimeoutMs } : undefined,
		);
		return result.ok;
	}

	/** Emit one update/rollback event (fail-soft; the seam never throws). */
	async function emitEvent(
		kind: "update" | "rollback",
		fromVersion: string,
		toVersion: string,
		outcome: UpdateOutcome,
	): Promise<void> {
		await emit({ kind, fromVersion, toVersion, outcome, deviceId: deps.deviceId, timestampMs: now() });
	}

	/**
	 * Roll back to `priorVersion` after a failed post-update health (AC-064e.3). Reinstall
	 * the prior bits, restart, and re-verify. Returns the terminal status + emits the
	 * rollback telemetry event with the observed outcome.
	 */
	async function rollback(priorVersion: string, failedVersion: string): Promise<UpdateTransactionResult> {
		deps.logger.warn("autoupdate.rollback_start", { from: failedVersion, to: priorVersion });
		const reinstalled = await installVersion(priorVersion);
		if (reinstalled) {
			await deps.restartDaemon();
		}
		const healthyAgain = reinstalled && (await deps.verifyHealthy());
		const status: UpdateTransactionStatus = healthyAgain ? "rolled_back" : "rollback_failed";

		// The rollback event records from=the failed new version, to=the prior version.
		await emitEvent("rollback", failedVersion, priorVersion, healthyAgain ? "rolled_back" : "rollback_failed");

		if (healthyAgain) {
			deps.logger.info("autoupdate.rollback_ok", { to: priorVersion });
		} else {
			deps.logger.error("autoupdate.rollback_failed", { to: priorVersion });
		}
		return {
			status,
			fromVersion: priorVersion,
			toVersion: failedVersion,
			detail: healthyAgain ? `rolled-back-to-${priorVersion}` : `rollback-failed-to-${priorVersion}`,
		};
	}

	/**
	 * Read the installed version then gather the gate inputs (latest + blessed) and run the
	 * pure {@link decideUpdate} gate. Shared by `previewUpdate` (read + decide ONLY) and
	 * `runUpdateTransaction` (which then acts on the decision). Performs reads but NO mutation:
	 * no install lock, no npm, no restart. `installedVersion === null` short-circuits to the
	 * honest `installed_unknown` no-go before any registry/CDN read.
	 */
	async function gatherDecision(): Promise<{
		installedVersion: string | null;
		decision: UpdateDecision;
	}> {
		const installedVersion = await deps.readInstalledVersion();
		if (installedVersion === null) {
			// Cannot establish a rollback target -> no-go. Honest label: the INSTALLED read failed
			// (distinct from the gate's "latest_unknown" registry read).
			return { installedVersion: null, decision: { update: false, reason: "installed_unknown" } };
		}
		const latestVersion = await deps.readLatestVersion();
		const blessed = await fetchBlessedVersion(deps.blessedOptions);
		const decision = decideUpdate({ installedVersion, latestVersion, blessed, optOut: deps.optOut });
		return { installedVersion, decision };
	}

	return {
		async previewUpdate(): Promise<UpdatePreview> {
			try {
				// Pure DRY-RUN: read installed + latest + blessed and run the SAME gate, but touch
				// NOTHING -- no install lock, no npm, no restart, no rollback. A "check" only previews.
				const { installedVersion, decision } = await gatherDecision();
				if (decision.update) {
					return { eligible: true, fromVersion: installedVersion, toVersion: decision.toVersion };
				}
				return { eligible: false, fromVersion: installedVersion, reason: decision.reason };
			} catch (error) {
				// Crash-safe: an unexpected throw in a read seam becomes a not-eligible preview, never
				// a thrown error. The honest reason is the registry-read failure label.
				deps.logger.warn("autoupdate.preview_threw", {
					reason: error instanceof Error ? error.message : "unknown",
				});
				return { eligible: false, fromVersion: null, reason: "latest_unknown" };
			}
		},

		async runUpdateTransaction(): Promise<UpdateTransactionResult> {
			try {
				// 1. Read installed + gather the gate inputs and decide (the SAME gate preview runs).
				const { installedVersion, decision } = await gatherDecision();
				if (installedVersion === null) {
					deps.logger.warn("autoupdate.skip_unknown_installed");
					return { status: "no_update", noUpdateReason: "installed_unknown", detail: "installed-version-unknown" };
				}

				if (!decision.update) {
					deps.logger.info("autoupdate.no_update", { reason: decision.reason });
					return { status: "no_update", noUpdateReason: decision.reason, fromVersion: installedVersion };
				}
				const toVersion = decision.toVersion;

				// 2. Capture the PRE-update health baseline BEFORE touching npm (FIX 2). The verify
				//    rule below depends on whether the daemon was healthy to begin with: a regression
				//    from healthy->unhealthy is a real failure (roll back); a daemon that was already
				//    down cannot be made worse by the update (do NOT roll back, keep the new version).
				const wasHealthyBefore = await deps.verifyHealthy();

				// 3. Serialize against rung 2: only one global npm install at a time (AC-064e.6).
				const handle = deps.installLock.acquire("auto-update");
				if (handle === null) {
					deps.logger.warn("autoupdate.skip_lock_held");
					return {
						status: "skipped_lock_held",
						fromVersion: installedVersion,
						toVersion,
						detail: "install-lock-held",
					};
				}

				try {
					// 4. Install the EXACT blessed version (pinned to the audited bits).
					deps.logger.info("autoupdate.install_start", { from: installedVersion, to: toVersion });
					const installed = await installVersion(toVersion);
					if (!installed) {
						deps.logger.error("autoupdate.install_failed", { to: toVersion });
						await emitEvent("update", installedVersion, toVersion, "install_failed");
						return {
							status: "install_failed",
							fromVersion: installedVersion,
							toVersion,
							detail: "npm-install-failed",
						};
					}

					// 5. Restart so the daemon picks up the new binary (064a restart path). The seam
					//    MAY report whether a restart actually happened: `false` = no OS service / no
					//    daemon to restart through. `void`/`true` = assume a supervised restart fired.
					const restartReport = await deps.restartDaemon();
					const restartSupervised = restartReport !== false;

					// 6. Verify post-update health. Healthy -> done (AC-064e.1).
					const healthy = await deps.verifyHealthy();
					if (healthy) {
						deps.logger.info("autoupdate.updated", { from: installedVersion, to: toVersion });
						await emitEvent("update", installedVersion, toVersion, "updated");
						return { status: "updated", fromVersion: installedVersion, toVersion, detail: `updated-${toVersion}` };
					}

					// 7. Post-update health FAILED. The verify rule (FIX 2) decides rollback vs keep:
					//    - If the daemon was HEALTHY before AND there was a supervised daemon to restart,
					//      a healthy->unhealthy regression is a real failure -> ROLL BACK (AC-064e.3).
					//    - If the daemon was NOT healthy before (already down/unreachable), OR there was
					//      no OS service to restart through, a destructive rollback would only discard the
					//      new version (which may be the fix) for no gain -- the update cannot make an
					//      already-down daemon worse. KEEP the install and return `updated_unverified`.
					if (wasHealthyBefore && restartSupervised) {
						deps.logger.warn("autoupdate.verify_failed", { to: toVersion });
						return await rollback(installedVersion, toVersion);
					}

					const skipReason = !wasHealthyBefore ? "no-healthy-baseline" : "no-supervised-daemon";
					deps.logger.warn("autoupdate.verify_skipped", {
						to: toVersion,
						reason: skipReason,
						wasHealthyBefore,
						restartSupervised,
					});
					await emitEvent("update", installedVersion, toVersion, "updated_unverified");
					return {
						status: "updated_unverified",
						fromVersion: installedVersion,
						toVersion,
						detail: `updated-unverified-${toVersion}-${skipReason}`,
					};
				} finally {
					// Always free the mutex, even if a step above threw.
					handle.release();
				}
			} catch (error) {
				// Defensive: any unexpected throw becomes a failed result so the watch loop continues.
				const detail = error instanceof Error ? error.message : "unknown";
				deps.logger.error("autoupdate.threw", { reason: detail });
				return { status: "install_failed", detail };
			}
		},
	};
}

/** Re-export so callers can map a status to a telemetry outcome without reaching into the module. */
export { outcomeOf };
