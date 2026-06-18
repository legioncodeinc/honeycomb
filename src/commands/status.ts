/**
 * `honeycomb status` handler — PRD-020a (FR-10 / FR-8 / a-AC-4) consuming PRD-020d health.
 *
 * `status` reports three things: daemon CONNECTIVITY (via `deps.daemon.ping()`), LOGIN
 * state (the shared credential present + non-drifted), and ENVIRONMENT HEALTH — the
 * D1–D5 dimensions OWNED by 020d (`src/notifications/health.ts`). This handler CONSUMES
 * 020d's `HealthCheck` through the {@link StatusHealthSource} seam (bound by
 * {@link healthSourceFromCheck}); it does NOT re-implement the dimension probes (D-1
 * boundary: 020d owns the health engine, 020a surfaces the result).
 *
 * ── healDriftedOrgToken on session start (FR-8 / a-AC-4) ──────────────────────
 * Before rendering, `status` runs the org-drift heal: it REUSES 011b's `healOrgDrift`
 * (decode the JWT, compare the `org_id` claim with the active org, re-mint a corrected
 * token on mismatch) through the {@link OrgDriftHealer} seam. 011b's heal never throws —
 * it warns and continues — so a drift heal can never crash `status`. The re-minted token's
 * `org_id` claim matches the active org (a-AC-4).
 *
 * Thin client: connectivity is the daemon seam; health is the 020d seam; login + drift-heal
 * read the credential file. Never DeepLake.
 */

import {
	type CommandResult,
	type CommandDeps,
	type OutputSink,
} from "./contracts.js";

/**
 * One rendered health dimension line for `status` (mirrors 020d's `HealthDimension` result
 * shape). 020d's `HealthDimension` is structurally compatible; {@link healthSourceFromCheck}
 * adapts a 020d `HealthCheck` into this seam without 020a importing the 020d module type
 * directly at the call site.
 */
export interface StatusHealthLine {
	/** The dimension id (`D1`..`D5`). */
	readonly id: string;
	/** Human label (e.g. `honeycomb CLI`, `daemon reachable`). */
	readonly label: string;
	/** True when the dimension passed. */
	readonly ok: boolean;
	/** A short detail (e.g. version, url, or the failure reason). */
	readonly detail?: string;
}

/**
 * The health seam `status` consumes (D-1 boundary). 020d's `HealthCheck` satisfies this via
 * {@link healthSourceFromCheck}; a test injects a fake returning canned D1–D5 lines.
 */
export interface StatusHealthSource {
	/** Run the D1–D5 check and return one line per dimension. */
	evaluate(): Promise<readonly StatusHealthLine[]>;
}

/** The minimal 020d `HealthCheck` shape `status` consumes (structural — no hard 020d import). */
export interface HealthCheckLike {
	evaluate(): Promise<{ readonly dimensions: readonly StatusHealthLine[] }>;
}

/**
 * Adapt a 020d `HealthCheck` (`createHealthCheck(...)`) into the {@link StatusHealthSource} seam
 * `status` renders (FR-10). The daemon-assembly wiring builds the real `HealthCheck` with its
 * probes and passes it here; the structural `HealthCheckLike` keeps 020a decoupled from 020d's
 * concrete module while binding to its STABLE `HealthReport.dimensions` shape.
 */
export function healthSourceFromCheck(check: HealthCheckLike): StatusHealthSource {
	return {
		async evaluate(): Promise<readonly StatusHealthLine[]> {
			const report = await check.evaluate();
			return report.dimensions;
		},
	};
}

/** The outcome of the org-drift heal — re-exported from 011b's typed result (never a throw). */
export interface DriftHealOutcome {
	/** `no-credentials` | `aligned` | `healed` | `heal-failed`. */
	readonly kind: string;
	/** The org the heal re-minted TO (present on a `healed` outcome) — matches the active org. */
	readonly to?: string;
}

/**
 * The org-drift heal seam (FR-8 / a-AC-4). The daemon-assembly wiring binds 011b's `healOrgDrift`
 * (re-mint a corrected token when the JWT `org_id` claim disagrees with the active org); a test
 * injects a fake. Returns a typed outcome — never throws — so `status` always renders.
 */
export interface OrgDriftHealer {
	/** Heal a drifted org token on session start, best-effort. */
	heal(): Promise<DriftHealOutcome>;
}

/**
 * The deps `status` adds on top of {@link CommandDeps} — the 020d health seam + the 011b
 * drift-heal seam. Both optional so a plain `CommandDeps` still type-checks; the real sources
 * bind at assembly and a fake injects in tests.
 */
export interface StatusDeps extends CommandDeps {
	/** The D1–D5 health source (020d). Bound from `createHealthCheck` via `healthSourceFromCheck`. */
	readonly health?: StatusHealthSource;
	/** The org-drift healer (011b `healOrgDrift`). Runs on session start (FR-8 / a-AC-4). */
	readonly drift?: OrgDriftHealer;
	/** Whether a credential is present (login state). Injected so a test drives it without `~`. */
	readonly loggedIn?: boolean;
}

/**
 * Run `honeycomb status` (FR-10 / FR-8 / a-AC-4). Runs the org-drift heal (FR-8) first — best
 * effort, never fatal — then renders connectivity (`deps.daemon.ping()`), login (`deps.loggedIn`),
 * and the D1–D5 health (`deps.health`). Never DeepLake.
 */
export async function runStatusCommand(deps: StatusDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));

	// FR-8 / a-AC-4: heal a drifted org token on session start. Best-effort — 011b's healer
	// warns + continues internally, so this never crashes status.
	if (deps.drift !== undefined) {
		const outcome = await deps.drift.heal();
		if (outcome.kind === "healed") {
			out(`auth: re-minted an org-aligned token (org ${outcome.to ?? ""}).`);
		}
	}

	const alive = await deps.daemon.ping();
	out(`daemon:     ${alive ? "up (127.0.0.1:3850)" : "down"}`);
	out(`login:      ${deps.loggedIn === true ? "logged in" : "not logged in"}`);

	if (deps.health !== undefined) {
		const lines = await deps.health.evaluate();
		for (const line of lines) {
			const mark = line.ok ? "ok " : "FAIL";
			out(`  ${line.id} ${mark} ${line.label}${line.detail !== undefined ? ` (${line.detail})` : ""}`);
		}
	}

	return { exitCode: 0 };
}
