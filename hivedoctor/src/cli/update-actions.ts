/**
 * The CLI `update` / `update --check` action mapping (PRD-064e/064f; FIX 1).
 *
 * Maps the update engine onto the three {@link UpdateActions} the CLI dispatcher calls. The
 * load-bearing rule lives here so it is unit-testable without spinning the whole CLI context:
 *
 *   - `checkPrimaryUpdate` (`update --check`) is READ-ONLY. It calls {@link UpdateEngine.previewUpdate}
 *     -- a pure read + gate decision -- and NEVER {@link UpdateEngine.runUpdateTransaction}. A
 *     "check" must preview, never mutate (the live bug: a `--check` that ran the full transaction
 *     installed a version, failed verify, and rolled back).
 *   - `applyPrimaryUpdate` (`update`) runs the real {@link UpdateEngine.runUpdateTransaction}
 *     (acquire lock -> npm install -> restart -> verify -> commit/rollback).
 *   - `selfUpdate` is passed straight through (the SOLE HiveDoctor-own-package path, AC-064f.5).
 *
 * Built-ins only; pure string formatting over the injected engine.
 */

import type { UpdateActions } from "./context.js";
import { outcomeOf, type UpdateEngine } from "../update/update-engine.js";

/** The self-update action (the one path that updates HiveDoctor's own package). */
export type SelfUpdateFn = () => Promise<string>;

/**
 * Build the CLI update actions over an engine. `checkPrimaryUpdate` previews (no mutation);
 * `applyPrimaryUpdate` runs the real transaction; `selfUpdate` is passed through.
 */
export function createUpdateActions(engine: UpdateEngine, selfUpdate: SelfUpdateFn): UpdateActions {
	return {
		checkPrimaryUpdate: async (): Promise<string> => {
			// READ-ONLY preview: previewUpdate() reads installed + latest + blessed and runs the
			// SAME gate, but acquires no lock, runs no npm, restarts nothing, rolls nothing back.
			const preview = await engine.previewUpdate();
			if (preview.eligible) {
				return `Update available: ${preview.fromVersion ?? "?"} -> ${preview.toVersion ?? "?"}.`;
			}
			return `No update: ${preview.reason ?? "not eligible"}.`;
		},
		applyPrimaryUpdate: async (): Promise<string> => {
			const result = await engine.runUpdateTransaction();
			const outcome = outcomeOf(result.status);
			return outcome === null
				? `No update applied (${result.status}${result.noUpdateReason ? `: ${result.noUpdateReason}` : ""}).`
				: `Update ${result.status}: ${result.fromVersion ?? "?"} -> ${result.toVersion ?? "?"}.`;
		},
		selfUpdate,
	};
}
