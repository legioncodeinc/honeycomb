/**
 * The D1–D5 environment health check — PRD-020d (FR-7 / FR-8 / d-AC-2).
 *
 * `evaluate()` runs the five INDEPENDENT dimension probes (D1 CLI PATH+version, D2 daemon TCP,
 * D3 cursor-agent present, D4 cursor-agent login, D5 hooks wired) through the injected
 * {@link HealthProbes} seam and assembles the {@link HealthReport} in D1..D5 order, tagging each
 * dimension's `wirable` from {@link HEALTH_DIMENSION_WIRABLE} (only D5 is auto-wirable). A probe
 * that throws is surfaced as a FAILING dimension (never propagated) — the check itself never
 * crashes the session (fail-soft).
 *
 * `autoWire()` evaluates, then — when a WIRABLE dimension is failing — resolves it via the 020d
 * {@link AutoWiring} engine (which DELEGATES to the 019a connector, D-4 / d-AC-6), and returns a
 * FRESH evaluation. A failing NON-wirable dimension (e.g. logged-out D4) is SURFACED, never
 * "fixed" (FR-8 / d-AC-2). Idempotent: when nothing is wirable-and-failing, no wire runs.
 *
 * Thin client: the D2 probe dials the daemon (TCP), never DeepLake. The other probes touch
 * PATH / the editor dir / `hooks.json` through seams. `src/notifications` is a NON_DAEMON_ROOT.
 */

import {
	type AutoWiring,
	type HealthCheck,
	type HealthDimension,
	type HealthDimensionId,
	type HealthReport,
	HEALTH_DIMENSION_IDS,
	HEALTH_DIMENSION_LABELS,
	HEALTH_DIMENSION_WIRABLE,
} from "./contracts.js";

/** A single probe's outcome (pass/fail + a short, token-free detail). */
export interface ProbeOutcome {
	readonly ok: boolean;
	readonly detail?: string;
}

/**
 * The probe seams the health check runs against (FR-7), each defaulting to the real impl at
 * assembly and a fake in tests so every D-x branch is drivable without a real CLI / daemon /
 * editor. The probes are intentionally coarse + fast (the check runs synchronously during
 * SessionStart).
 */
export interface HealthProbes {
	/** D1 — is the `honeycomb` CLI on PATH + does `--version` answer? */
	probeCli(): Promise<ProbeOutcome>;
	/** D2 — is the daemon reachable on 3850 (TCP probe + fast-start fallback)? */
	probeDaemon(): Promise<ProbeOutcome>;
	/** D3 — is `cursor-agent` present (PATH + IDE-directory fallbacks)? */
	probeCursorAgent(): Promise<ProbeOutcome>;
	/** D4 — is `cursor-agent` logged in (lightweight status query)? */
	probeCursorLogin(): Promise<ProbeOutcome>;
	/** D5 — are hooks wired and current (`hooks.json` matches the bundle)? */
	probeHooksWired(): Promise<ProbeOutcome>;
}

/** The deps the health check is built with (FR-7 / FR-8). */
export interface HealthCheckDeps {
	/** The five dimension probes. */
	readonly probes: HealthProbes;
	/** The auto-wiring engine for `autoWire()` (FR-8 / D-4). */
	readonly autoWiring: AutoWiring;
}

/** Map a dimension id to its bound probe (the D1..D5 → probe wiring). */
function probeFor(probes: HealthProbes, id: HealthDimensionId): () => Promise<ProbeOutcome> {
	switch (id) {
		case "D1":
			return () => probes.probeCli();
		case "D2":
			return () => probes.probeDaemon();
		case "D3":
			return () => probes.probeCursorAgent();
		case "D4":
			return () => probes.probeCursorLogin();
		case "D5":
			return () => probes.probeHooksWired();
	}
}

/** Run one probe, surfacing a thrown error as a FAILING dimension (never propagated). */
async function runDimension(probes: HealthProbes, id: HealthDimensionId): Promise<HealthDimension> {
	const wirable = HEALTH_DIMENSION_WIRABLE[id];
	const label = HEALTH_DIMENSION_LABELS[id];
	let outcome: ProbeOutcome;
	try {
		outcome = await probeFor(probes, id)();
	} catch (err) {
		// A probe that throws is a failing dimension, not a crashed check (fail-soft).
		outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
	return {
		id,
		label,
		ok: outcome.ok,
		wirable,
		...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
	};
}

/** Run all five probes (independently) and assemble the report in D1..D5 order (FR-7). */
async function evaluateProbes(probes: HealthProbes): Promise<HealthReport> {
	const dimensions = await Promise.all(HEALTH_DIMENSION_IDS.map((id) => runDimension(probes, id)));
	return { dimensions, healthy: dimensions.every((d) => d.ok) };
}

/**
 * Build the {@link HealthCheck} (FR-7 / FR-8). `evaluate()` runs the five probes → report;
 * `autoWire()` resolves the wirable failing dimensions via `deps.autoWiring`, then re-evaluates.
 */
export function createHealthCheck(deps: HealthCheckDeps): HealthCheck {
	return {
		async evaluate(): Promise<HealthReport> {
			return evaluateProbes(deps.probes);
		},
		async autoWire(): Promise<HealthReport> {
			const before = await evaluateProbes(deps.probes);
			// Only act when a WIRABLE dimension is actually failing — a failing NON-wirable
			// dimension (e.g. logged-out D4) is surfaced, never "fixed" (FR-8 / d-AC-2). When
			// nothing is wirable-and-failing, no wire runs (idempotent, d-AC-6).
			const needsWire = before.dimensions.some((d) => d.wirable && !d.ok);
			if (needsWire) {
				// Delegate to the 019a connector (D-4): foreign-preserve + writeJsonIfChanged
				// idempotency + reversible. We re-evaluate AFTER wiring to reflect the resolved state.
				await deps.autoWiring.wire();
			}
			return evaluateProbes(deps.probes);
		},
	};
}
