/**
 * The `honeycomb_updated` version-change checkpoint (lifecycle telemetry, the-apiary
 * fleet-operator extension of PRD-050e).
 *
 * `recordVersionAndEmitUpdated(ref, deps?)` compares the CURRENT build version against the
 * `lastVersion` baseline persisted in the onboarding state:
 *
 *   - NO baseline (fresh install, or a state file written before `lastVersion` existed):
 *     the baseline is recorded WITHOUT emitting - a first sighting is not an update.
 *   - SAME version: nothing happens (the cheap common case - one string compare).
 *   - DIFFERENT version: `honeycomb_updated` emits through the single chokepoint
 *     ({@link emitTelemetry}), then the baseline advances to the current version.
 *
 * ── Dedupe semantics (per event+version, not per machine) ────────────────────
 * The chokepoint's default ledger key (the event name) would allow `honeycomb_updated` to fire
 * only ONCE ever per machine - useless for an update event. So the emit passes
 * `dedupeKey: "honeycomb_updated@<version>"`: each NEW version fires once, the SAME version can
 * never double-send (e.g. when the baseline persist below fails and the next run re-detects the
 * same change), and the wire event NAME stays the plain `honeycomb_updated` with the version in
 * the allow-listed `honeycomb_version` property every payload already carries.
 *
 * ── Ordering: emit FIRST, then advance the baseline ──────────────────────────
 * The emit persists its own ledger/sent bookkeeping inside the chokepoint, so this module
 * RE-LOADS the state after the emit before writing `lastVersion` (writing a pre-emit copy would
 * clobber the just-recorded ledger). Advancing the baseline after the emit means a failed
 * baseline persist re-detects on the next run, where the version-qualified dedupe key blocks a
 * duplicate send - the safe failure mode in both directions.
 *
 * ── Fail-soft, fire-and-forget (e-AC-4 posture) ──────────────────────────────
 * Never throws, never changes a host flow's exit code. Every gate the chokepoint applies
 * (empty key / opt-out / consent / dedupe) applies unchanged; a gate-skipped emit still
 * advances the baseline (an opted-out user must not be re-prompted with the same event later).
 *
 * ── Uninstall coverage note (`honeycomb_uninstalled`) ────────────────────────
 * Honeycomb's `uninstall` CLI verb reverses only the harness wiring (the 019a connector engine);
 * no verb removes the npm package or the `~/.deeplake` state dir. The `honeycomb_uninstalled`
 * event therefore fires from that verb (see `src/commands/local-handlers.ts`); PACKAGE-removal
 * coverage comes from the installer's `product_removed` phone-home event
 * ([the-apiary installer scripts](https://github.com/legioncodeinc/the-apiary/tree/main/scripts/install)),
 * which observe a `--products=` narrowing
 * between installer runs.
 */

import { loadOnboarding, type OnboardingState, saveOnboarding } from "../onboarding/index.js";
import { type EmitDeps, type EmitOutcome, emitTelemetry, HONEYCOMB_VERSION } from "./emit.js";

/** The outcome of a {@link recordVersionAndEmitUpdated} pass (resolved, never rejected). */
export interface VersionCheckOutcome {
	/** True when a version CHANGE was detected this pass (an emit was attempted). */
	readonly changed: boolean;
	/** The chokepoint outcome when an emit was attempted; absent when nothing changed. */
	readonly emit?: EmitOutcome;
}

/**
 * Compare the current build version against the persisted `lastVersion` baseline; on a change,
 * emit `honeycomb_updated` (deduped per event+version) and advance the baseline. Cheap (one
 * string compare) on the no-change path, fail-soft always - see the module docstring.
 */
export async function recordVersionAndEmitUpdated(ref: string, deps: EmitDeps = {}): Promise<VersionCheckOutcome> {
	try {
		const load = deps.loadOnboarding ?? loadOnboarding;
		const save = deps.saveOnboarding ?? saveOnboarding;
		const version = deps.version ?? HONEYCOMB_VERSION;
		const state = load(deps.dir);

		// The cheap common case: the baseline already matches - one string compare, no IO beyond the load.
		if (state.lastVersion === version) return { changed: false };

		if (state.lastVersion === undefined) {
			// First sighting: record the baseline WITHOUT emitting (a fresh install / pre-field file
			// is not an update). `honeycomb_installed` covers the install moment.
			save({ ...state, lastVersion: version }, deps.dir);
			return { changed: false };
		}

		// A REAL version change: emit through the chokepoint (which applies every gate and persists
		// its own ledger bookkeeping), deduped per event+version via the qualified ledger key.
		const emit = await emitTelemetry(
			"honeycomb_updated",
			{ ref, tier: "tier1", dedupeKey: `honeycomb_updated@${version}` },
			deps,
		);

		// Advance the baseline on a FRESH load (the emit may have just persisted ledger state; saving
		// the pre-emit copy would clobber it). Best-effort: a persist hiccup re-detects next run,
		// where the version-qualified dedupe key blocks a duplicate send.
		try {
			const fresh: OnboardingState = load(deps.dir);
			save({ ...fresh, lastVersion: version }, deps.dir);
		} catch {
			// Fail-soft: the baseline advance is bookkeeping; the dedupe key is the duplicate guard.
		}
		return { changed: true, emit };
	} catch {
		// Fail-soft: ANY unexpected error (load/save IO) resolves quietly - never a host-flow change.
		return { changed: false };
	}
}
