/**
 * Rung 3: uninstall a conflicting Hivemind global (PRD-064c, AC-064c.2 / .4 / .5 / .6).
 *
 * Honeycomb and Hivemind (`@deeplake/hivemind`) are siblings that share one credential
 * folder but CANNOT run side-by-side (duplicate capture/recall hooks, competing
 * daemons) - per the coexistence rules in PRD-050d. When a conflicting `@deeplake/
 * hivemind` global is detected, this rung removes the PACKAGE automatically (OD-4:
 * autonomous, always when detected).
 *
 * The single hard safety boundary (AC-064c.2 + Technical considerations): rung 3
 * removes the npm PACKAGE only. It NEVER touches the shared `~/.deeplake/` state -
 * credentials and onboarding live there and Honeycomb still depends on them. There is
 * literally no code path in this rung that writes to or deletes `~/.deeplake/`; the
 * only filesystem write is the timestamped backup record under HiveDoctor's OWN
 * workspace dir.
 *
 * Backup-before-removal (AC-064c.5): before issuing the uninstall, a timestamped JSON
 * record of exactly what is being removed (package + detected version + when) is
 * appended to `removed-packages.ndjson` in the workspace dir, so the removal is
 * auditable and the coexistence migration is reversible-by-record.
 *
 * Idempotency (AC-064c.4): detection runs first. No conflicting global present -> a
 * safe no-op skip (no backup, no uninstall). A second run after a successful removal
 * therefore detects nothing and skips.
 *
 * Crash-safety: every step is inside the rung's try/catch and the runner never throws;
 * any failure resolves to a failed {@link RungResult}. Built-ins only (injected runner
 * + node:fs for the backup record).
 */

import { appendFileSync, mkdirSync } from "node:fs";

import type { Rung, RungContext, RungResult } from "../remediation.js";
import { resolveInBase } from "../safe-path.js";
import type { CommandRunner } from "./command-runner.js";

/** The conflicting Hivemind npm package rung 3 removes (NEVER the `~/.deeplake/` state). */
export const HIVEMIND_PACKAGE = "@deeplake/hivemind";

/** Detects a conflicting Hivemind global: its installed version, or null when absent. Injected. */
export type DetectHivemindFn = () => Promise<string | null>;

/** One appended backup record of a removed package (AC-064c.5). */
export interface RemovedPackageRecord {
	/** The package removed. */
	readonly package: string;
	/** The version detected at removal time, or null when undeterminable. */
	readonly version: string | null;
	/** ISO-8601 of when the removal record was written (before the uninstall ran). */
	readonly at: string;
}

/** Construction deps for rung 3. */
export interface UninstallHivemindRungDeps {
	/** The injected command runner (the only thing that touches npm). */
	readonly runner: CommandRunner;
	/**
	 * Detect a conflicting `@deeplake/hivemind` global. Injected so tests are hermetic;
	 * the real impl runs `npm ls -g @deeplake/hivemind` through the runner.
	 */
	readonly detectHivemind: DetectHivemindFn;
	/** HiveDoctor's workspace dir; the backup record is written under it (NOT `~/.deeplake/`). */
	readonly workspaceDir: string;
	/** Injected clock for the backup timestamp (defaults to `Date.now`). */
	readonly now?: () => number;
	/** Per-uninstall timeout in ms (default: the runner's own default). */
	readonly uninstallTimeoutMs?: number;
}

/** Stable action verb recorded in the incident step for this rung. */
const ACTION = "uninstall-conflicting-hivemind";

/**
 * Build the default {@link DetectHivemindFn} over a command runner: `npm ls -g
 * @deeplake/hivemind --depth 0`. Returns the version on a clean exit that names the
 * package, else null. Defensive: any runner failure -> null (treated as "not
 * detected", which is the safe no-op direction).
 */
export function createNpmHivemindDetector(runner: CommandRunner): DetectHivemindFn {
	return async (): Promise<string | null> => {
		const result = await runner.run("npm", ["ls", "-g", HIVEMIND_PACKAGE, "--depth", "0"]);
		// `npm ls` exits non-zero when the package is absent; exit 0 + a version line means present.
		if (!result.ok) return null;
		const match = result.stdout.match(/@deeplake\/hivemind@(\S+)/);
		return match?.[1] ?? null;
	};
}

/** Build rung 3 (uninstall conflicting Hivemind). */
export function createUninstallHivemindRung(deps: UninstallHivemindRungDeps): Rung {
	const now = deps.now ?? Date.now;

	/** Append the timestamped removal record BEFORE the uninstall (AC-064c.5). Defensive. */
	function recordRemoval(version: string | null): boolean {
		const record: RemovedPackageRecord = {
			package: HIVEMIND_PACKAGE,
			version,
			at: new Date(now()).toISOString(),
		};
		try {
			// Containment: the fixed name is joined under the variable workspace dir and asserted
			// to stay inside it (defense-in-depth + SAST taint visibility). A containment violation
			// throws here and is caught below, returning false (caller skips the destructive step).
			const backupPath = resolveInBase(deps.workspaceDir, "removed-packages.ndjson");
			mkdirSync(deps.workspaceDir, { recursive: true });
			appendFileSync(backupPath, `${JSON.stringify(record)}\n`, "utf8");
			return true;
		} catch {
			// A failed backup write must NOT crash the rung, but it DOES mean we cannot honor the
			// "record before removal" contract - so the caller treats it as a reason to skip the
			// destructive uninstall rather than removing without a record.
			return false;
		}
	}

	return {
		rung: 3,
		name: ACTION,
		async run(ctx: RungContext): Promise<RungResult> {
			try {
				// Detection first: idempotency lives here. No conflicting global -> safe no-op skip
				// (AC-064c.4). A second run after a removal detects nothing and lands here.
				const version = await deps.detectHivemind();
				if (version === null) {
					ctx.logger.info("rung3.skip_not_detected");
					return { ok: true, skipped: true, action: ACTION, detail: "no-conflicting-hivemind" };
				}

				// Backup the removal record BEFORE deleting anything (AC-064c.5). If we cannot record
				// it, do NOT proceed to the destructive step - skip and let escalation surface it.
				if (!recordRemoval(version)) {
					ctx.logger.error("rung3.backup_failed");
					return { ok: false, skipped: true, action: ACTION, detail: "backup-record-failed" };
				}

				ctx.logger.warn("rung3.uninstall_start", { pkg: HIVEMIND_PACKAGE, version });
				const result = await deps.runner.run(
					"npm",
					["uninstall", "-g", HIVEMIND_PACKAGE],
					deps.uninstallTimeoutMs !== undefined ? { timeoutMs: deps.uninstallTimeoutMs } : undefined,
				);
				if (!result.ok) {
					ctx.logger.error("rung3.uninstall_failed", { code: result.code, detail: result.detail });
					return { ok: false, action: ACTION, detail: result.detail ?? `npm-exit-${result.code}` };
				}

				ctx.logger.info("rung3.uninstall_ok", { version });
				return { ok: true, action: ACTION, detail: `removed-${version}` };
			} catch (error) {
				const detail = error instanceof Error ? error.message : "unknown";
				ctx.logger.error("rung3.threw", { reason: detail });
				return { ok: false, action: ACTION, detail };
			}
		},
	};
}
