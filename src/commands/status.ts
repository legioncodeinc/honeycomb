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
import { loadCredentials } from "../daemon/runtime/auth/credentials-store.js";
import { ENV_PROJECT_ID, resolveScopeFromDisk, UNSORTED_PROJECT_ID } from "../hooks/shared/project-resolver.js";

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
	/**
	 * The session working directory the per-cwd scope line resolves against (PRD-049d 49d-AC-5).
	 * Defaults to `process.cwd()`. Injected so a test drives the resolved project without chdir.
	 */
	readonly cwd?: string;
	/** Override the `~/.deeplake` dir (credentials + projects cache) for the scope line (tests). */
	readonly dir?: string;
	/** The env (defaults to `process.env`) — the `HONEYCOMB_PROJECT_ID` override is read here. */
	readonly env?: NodeJS.ProcessEnv;
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

	// PRD-049d 49d-AC-5: report the resolved Org → Workspace → Project for the CURRENT cwd, so "what
	// am I writing to right now" is answerable per-folder, and an UNBOUND folder is marked explicitly.
	// Fail-soft + session-safe: the project is resolved PER cwd from the local cache (never a machine-
	// global field), and any failure simply omits the line rather than crashing status.
	renderResolvedScope(deps, out);

	if (deps.health !== undefined) {
		const lines = await deps.health.evaluate();
		for (const line of lines) {
			const mark = line.ok ? "ok " : "FAIL";
			out(`  ${line.id} ${mark} ${line.label}${line.detail !== undefined ? ` (${line.detail})` : ""}`);
		}
	}

	return { exitCode: 0 };
}

/**
 * Render the per-cwd resolved Org → Workspace → Project lines (PRD-049d 49d-AC-5). FAIL-SOFT: it
 * reads the credential (for the org/workspace partition) + the local `~/.deeplake/projects.json`
 * cache (for the cwd-bound project) through the THIN-CLIENT resolver — never the daemon, never a
 * machine-global active-project field (session-safe). On no credential, or any error, it prints
 * nothing rather than crashing `status`. The `HONEYCOMB_PROJECT_ID` override is honored (49d-AC-6).
 * The deeper `honeycomb project status` verb is the richer surface; this is the at-a-glance line.
 */
function renderResolvedScope(deps: StatusDeps, out: OutputSink): void {
	try {
		const creds = loadCredentials(deps.dir, deps.env);
		if (creds === null) return;
		const env = deps.env ?? process.env;
		const override = env[ENV_PROJECT_ID];
		const resolved = resolveScopeFromDisk({
			cwd: deps.cwd ?? process.cwd(),
			org: creds.orgId,
			workspace: creds.workspace,
			...(override !== undefined ? { projectIdOverride: override } : {}),
			...(deps.dir !== undefined ? { dir: deps.dir } : {}),
		});
		out(`org:        ${creds.orgName} (${creds.orgId})`);
		out(`workspace:  ${creds.workspace}`);
		if (resolved.bound) {
			out(`project:    ${resolved.projectId} (this folder)`);
		} else {
			out(`project:    ${UNSORTED_PROJECT_ID} (this folder is UNBOUND — captures land in the inbox)`);
		}
	} catch {
		// Fail-soft: a resolution hiccup never crashes `status` — the scope line is simply omitted.
	}
}
