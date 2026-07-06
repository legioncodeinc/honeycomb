/**
 * PRD-058d — the `memory.lifecycle.*` config suite.
 *
 * Acceptance criteria → tests:
 *   58d.1.1 a fresh install defaults non-destructive: a = 1, c = 0, s = 0 (posture observe), auto-resolve off.
 *   58d.1.2 a `HONEYCOMB_LIFECYCLE_*` env var overrides the matching yaml value per-key (env > yaml > default).
 *   58d.1.3 every flag in the parameter table appears in the single-sourced reference with symbol/default/effect,
 *           and the reference defaults agree with the resolved schema defaults (no drift).
 *   58d.1.4 the stale-ref posture flip observe → execute moves `s` 0 → its configured value; no other term changes.
 *   Plus: coerce-and-clamp (a fat-fingered env is tuning noise, never a throw); the recency projection feeds the
 *         recall consumer without a second clamp model.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_ACTIVATION_EXPONENT,
	DEFAULT_CONFIDENCE_EXPONENT,
	DEFAULT_STALENESS_EXPONENT,
	EXECUTE_STALENESS_EXPONENT,
	LIFECYCLE_FLAG_REFERENCE,
	effectiveStalenessExponent,
	envLifecycleConfigProvider,
	lifecycleRecency,
	resolveLifecycleConfig,
	resolveLifecycleConfigLayered,
	staticLifecycleConfigProvider,
	type RawLifecycleConfig,
} from "../../../../src/daemon/runtime/memories/lifecycle-config.js";

describe("PRD-058d lifecycle config — non-destructive defaults (AC-55d.1.1)", () => {
	it("a fresh install (no config) defaults to a = 1, c = 0, s = 0 (posture observe), auto-resolve off", () => {
		const config = resolveLifecycleConfig(staticLifecycleConfigProvider({}));
		expect(config.activationExponent).toBe(1);
		expect(config.confidenceExponent).toBe(0);
		expect(config.stalenessExponent).toBe(0);
		expect(config.staleRefPosture).toBe("observe");
		expect(config.conflictAutoResolve).toBe(false);
		// The effective `s` under the default observe posture is 0 (visible but inert).
		expect(effectiveStalenessExponent(config)).toBe(0);
		// The default constants the surface re-exports agree with the resolved values.
		expect(DEFAULT_ACTIVATION_EXPONENT).toBe(1);
		expect(DEFAULT_CONFIDENCE_EXPONENT).toBe(0);
		expect(DEFAULT_STALENESS_EXPONENT).toBe(0);
	});

	it("the per-class half-lives default to 180 / 45 / 10 (distilled > summary > raw)", () => {
		const config = resolveLifecycleConfig(staticLifecycleConfigProvider({}));
		expect(config.halfLifeDaysByClass.memories).toBe(180);
		expect(config.halfLifeDaysByClass.memory).toBe(45);
		expect(config.halfLifeDaysByClass.sessions).toBe(10);
	});
});

describe("PRD-058d lifecycle config — precedence env > yaml > default (AC-55d.1.2)", () => {
	it("an env var overrides the matching yaml value per-key; an un-set key keeps yaml; an un-set-in-both falls to default", () => {
		const yaml: RawLifecycleConfig = {
			activationExponent: 0.5, // yaml sets a
			contradictionThreshold: 0.7, // yaml sets θ_detect (no env override) → yaml wins
		};
		const env: RawLifecycleConfig = {
			activationExponent: 0.25, // env overrides yaml's a
			// no contradictionThreshold in env → yaml's 0.7 stands
			// no reviewMargin anywhere → the documented default 0.15
		};
		const config = resolveLifecycleConfigLayered(staticLifecycleConfigProvider(yaml), staticLifecycleConfigProvider(env));
		expect(config.activationExponent).toBe(0.25); // env won
		expect(config.contradictionThreshold).toBe(0.7); // yaml won (no env)
		expect(config.reviewMargin).toBe(0.15); // default (neither)
	});

	it("the env provider reads HONEYCOMB_LIFECYCLE_* keys", () => {
		const env = {
			HONEYCOMB_LIFECYCLE_ACTIVATION_EXPONENT: "2",
			HONEYCOMB_LIFECYCLE_STALEREF_POSTURE: "execute",
			HONEYCOMB_LIFECYCLE_CONFLICT_AUTORESOLVE: "true",
		} as unknown as NodeJS.ProcessEnv;
		const config = resolveLifecycleConfig(envLifecycleConfigProvider(env));
		expect(config.activationExponent).toBe(2);
		expect(config.staleRefPosture).toBe("execute");
		expect(config.conflictAutoResolve).toBe(true);
	});
});

describe("PRD-058d lifecycle config — coerce-and-clamp (a typo never crashes the daemon)", () => {
	it("a non-numeric exponent falls back to its default; an out-of-range bounded knob clamps", () => {
		const config = resolveLifecycleConfig(
			staticLifecycleConfigProvider({
				activationExponent: "not-a-number", // → default 1
				contradictionThreshold: 5, // out of [0,1] → clamp to 1
				activationFloor: -1, // out of [0,1] → clamp to 0
			}),
		);
		expect(config.activationExponent).toBe(1);
		expect(config.contradictionThreshold).toBe(1);
		expect(config.activationFloor).toBe(0);
	});

	it("an unrecognized posture falls back to observe (the safe default)", () => {
		const config = resolveLifecycleConfig(staticLifecycleConfigProvider({ staleRefPosture: "bananas" }));
		expect(config.staleRefPosture).toBe("observe");
	});

	it("trims surrounding whitespace on the conflictAutoResolve flag (the trailing-space env class)", () => {
		// A Windows scheduled-task `set "VAR=true" && …` chain leaks a trailing space; the trim keeps
		// `"true "` / `" true "` reading as ON and `"false "` / junk as OFF.
		expect(resolveLifecycleConfig(staticLifecycleConfigProvider({ conflictAutoResolve: "true " })).conflictAutoResolve).toBe(true);
		expect(resolveLifecycleConfig(staticLifecycleConfigProvider({ conflictAutoResolve: " true " })).conflictAutoResolve).toBe(true);
		expect(resolveLifecycleConfig(staticLifecycleConfigProvider({ conflictAutoResolve: "false " })).conflictAutoResolve).toBe(false);
		expect(resolveLifecycleConfig(staticLifecycleConfigProvider({ conflictAutoResolve: " nope " })).conflictAutoResolve).toBe(false);
	});
});

describe("PRD-058d lifecycle config — posture flip (AC-55d.1.4)", () => {
	it("observe → execute moves the effective s from 0 to its configured value; no other term changes", () => {
		const observe = resolveLifecycleConfig(staticLifecycleConfigProvider({ staleRefPosture: "observe", activationExponent: 1, confidenceExponent: 0 }));
		const execute = resolveLifecycleConfig(staticLifecycleConfigProvider({ staleRefPosture: "execute", activationExponent: 1, confidenceExponent: 0 }));
		// s flips.
		expect(effectiveStalenessExponent(observe)).toBe(0);
		expect(effectiveStalenessExponent(execute)).toBe(EXECUTE_STALENESS_EXPONENT);
		// No other term's exponent changed implicitly.
		expect(execute.activationExponent).toBe(observe.activationExponent);
		expect(execute.confidenceExponent).toBe(observe.confidenceExponent);
	});

	it("execute with an explicit non-zero s honors the configured value", () => {
		const execute = resolveLifecycleConfig(staticLifecycleConfigProvider({ staleRefPosture: "execute", stalenessExponent: 0.4 }));
		expect(effectiveStalenessExponent(execute)).toBe(0.4);
	});
});

describe("PRD-058d lifecycle config — single-sourced flag reference (AC-55d.1.3)", () => {
	it("every parameter-table flag + the two posture flags appear with symbol, default, config path, and effect", () => {
		const symbols = LIFECYCLE_FLAG_REFERENCE.map((f) => f.symbol);
		for (const sym of ["a", "c", "s", "h(memories)", "h(memory)", "h(sessions)", "d", "A_min", "h_verify", "θ_detect", "γ", "τ_supersede", "τ_review", "ρ", "auto-resolve", "posture"]) {
			expect(symbols).toContain(sym);
		}
		for (const flag of LIFECYCLE_FLAG_REFERENCE) {
			expect(flag.symbol.length).toBeGreaterThan(0);
			expect(flag.configPath.startsWith("memory.lifecycle.")).toBe(true);
			expect(flag.envOverride.startsWith("HONEYCOMB_LIFECYCLE_")).toBe(true);
			expect(flag.defaultValue.length).toBeGreaterThan(0);
			expect(flag.effect.length).toBeGreaterThan(0);
		}
	});

	it("the reference defaults agree with the resolved schema defaults (no drift)", () => {
		const config = resolveLifecycleConfig(staticLifecycleConfigProvider({}));
		const byPath = new Map(LIFECYCLE_FLAG_REFERENCE.map((f) => [f.configPath, f.defaultValue]));
		expect(byPath.get("memory.lifecycle.activationExponent")).toBe(String(config.activationExponent));
		expect(byPath.get("memory.lifecycle.confidenceExponent")).toBe(String(config.confidenceExponent));
		expect(byPath.get("memory.lifecycle.stalenessExponent")).toBe(String(config.stalenessExponent));
		expect(byPath.get("memory.lifecycle.contradictionThreshold")).toBe(String(config.contradictionThreshold));
		expect(byPath.get("memory.lifecycle.staleRefPosture")).toBe(config.staleRefPosture);
		expect(byPath.get("memory.lifecycle.conflictAutoResolve")).toBe(String(config.conflictAutoResolve));
	});
});

describe("PRD-058d lifecycle config — feeds the recall consumer without a second clamp model", () => {
	it("lifecycleRecency projects the activation exponent + per-class half-lives into the recall RecencyConfig", () => {
		const config = resolveLifecycleConfig(
			staticLifecycleConfigProvider({ activationExponent: 0.8, halfLifeDaysByClass: { memories: 200, memory: 50, sessions: 12 } }),
		);
		const recency = lifecycleRecency(config);
		expect(recency.activationExponent).toBe(0.8);
		expect(recency.halfLifeDaysByClass.memories).toBe(200);
		expect(recency.halfLifeDaysByClass.memory).toBe(50);
		expect(recency.halfLifeDaysByClass.sessions).toBe(12);
	});
});
