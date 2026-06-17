/**
 * OpenClaw harness adapter entry root. Thin client only (no DeepLake).
 * Independently addressable by the bundler (PRD-001b).
 *
 * Unlike the other five harness entries (which are pure `bootHarness` thin
 * shims), OpenClaw additionally owns the runtime-tuning dispatch (FR-7 / FR-6 /
 * b-AC-7): it exposes a `register()` that the OpenClaw host calls with the
 * plugin config from `openclaw.json`, populating `globalThis.__honeycomb_tuning__`
 * so that shared code's `process.env.HONEYCOMB_*` reads — rewritten by esbuild
 * `define` to `globalThis.__honeycomb_tuning__.HONEYCOMB_*` — resolve to the
 * user's tuning values. The bundle therefore carries zero `process.env`
 * substrings while runtime tuning still works.
 */

import { bootHarness, type HarnessContext } from "../../../src/daemon-client/harness.js";
import { HONEYCOMB_VERSION } from "../../../src/shared/constants.js";

/**
 * Version this OpenClaw bundle self-reports (b-AC-5). Reading the shared
 * constant pulls the esbuild `__HONEYCOMB_VERSION__` define into this bundle so
 * it carries the same root version as every other target.
 */
export const honeycombVersion: string = HONEYCOMB_VERSION;

/** Minimal shape of the OpenClaw plugin config relevant to Honeycomb. */
export interface OpenclawPluginConfig {
	tuning?: Record<string, string | undefined>;
}

/** Subset of the OpenClaw plugin API surface this adapter depends on. */
export interface OpenclawPluginApi {
	pluginConfig?: OpenclawPluginConfig;
}

/**
 * Keys that must never be copied from untrusted `openclaw.json` tuning config
 * onto the dispatch object. `tuning`'s schema is `additionalProperties: true`,
 * so a `__proto__` key would re-point the dispatch object's prototype and let a
 * rewritten `globalThis.__honeycomb_tuning__.HONEYCOMB_*` read resolve through
 * that injected prototype (defense-in-depth before later PRDs flow tuning into
 * config/role objects). Skipping them is the OWASP prototype-pollution guard.
 */
const FORBIDDEN_TUNING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Populate the runtime-tuning dispatch from the user's `openclaw.json` config.
 * esbuild's `banner` has already initialized `globalThis.__honeycomb_tuning__`
 * to `{}`; here we overlay the user-supplied knobs (FR-7).
 */
export function applyOpenclawTuning(config?: OpenclawPluginConfig): void {
	const tuning = config?.tuning;
	if (!tuning) return;
	const target = (globalThis.__honeycomb_tuning__ ??= {});
	for (const [key, value] of Object.entries(tuning)) {
		if (FORBIDDEN_TUNING_KEYS.has(key)) continue;
		target[key] = value;
	}
}

/**
 * OpenClaw plugin entry. The host calls this with the plugin API; we apply the
 * tuning config and boot the thin daemon client. Returns the harness context.
 */
export function register(pluginApi: OpenclawPluginApi): HarnessContext {
	applyOpenclawTuning(pluginApi.pluginConfig);
	return bootHarness("openclaw");
}

/**
 * Demonstrable tuning read (b-AC-7). After `register()` runs, this returns the
 * `HONEYCOMB_DEBUG` knob the user set in `openclaw.json`. In the bundle this
 * `process.env.HONEYCOMB_DEBUG` read is rewritten to
 * `globalThis.__honeycomb_tuning__.HONEYCOMB_DEBUG` by esbuild `define`, so the
 * value flows from `openclaw.json` -> `__honeycomb_tuning__` -> here.
 */
export function readDebugKnob(): string | undefined {
	return process.env.HONEYCOMB_DEBUG;
}

/** Legacy thin-client activation kept for parity with the other harnesses. */
export function activate(): HarnessContext {
	return bootHarness("openclaw");
}
