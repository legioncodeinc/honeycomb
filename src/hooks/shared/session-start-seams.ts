/**
 * The production {@link SessionStartSeams} — PRD-045g (g-AC-2, closes the PRD-018 auto-pull gap).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * `session-start.ts` sequences six side-effecting steps AROUND the daemon calls
 * ({@link SessionStartSeams}): heal / autoUpdate / ensureTables / writePlaceholderSummary /
 * **autoPullSkills** / spawnGraphPull. Before this module, the runtime built `SessionStartDeps`
 * with NO `seams`, so `seams.autoPullSkills()` resolved to the no-op default
 * ({@link createNoopSessionStartSeams}) and freshly-mined team skills NEVER reached a teammate's
 * session — the PRD-018 auto-pull was dead-coded at runtime. THIS factory supplies a real
 * `autoPullSkills` so session-start actually pulls.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT. The auto-pull NEVER opens DeepLake. It POSTs over loopback
 * to the daemon's `POST /api/skills/pull` (the route PRD-045g mounts), which runs the REAL team
 * pull + cross-harness symlink fan-out daemon-side. The hook STATES "pull now"; the daemon does
 * the work. The transport here is a fail-soft `fetch` — the same loopback discipline the
 * runtime's notifications backend source uses.
 *
 * ── IDEMPOTENT · FAIL-SOFT · TIME-BUDGETED (the PRD-018 spec) ────────────────
 *   - IDEMPOTENT: the daemon-side `pull` engine applies `decideAction` — a re-pull of the same
 *     version writes nothing on disk (the conflict policy is the idempotency floor). Running it
 *     on every SessionStart is safe.
 *   - FAIL-SOFT: ANY error (daemon down, non-200, refused socket, timeout) is SWALLOWED — the
 *     call always RESOLVES, never throws, so session start is NEVER blocked or broken (FR-10).
 *   - TIME-BUDGETED: bounded by {@link AUTOPULL_TIMEOUT_MS}; a slow daemon never delays the turn.
 *   - KILL SWITCH: `HONEYCOMB_AUTOPULL_DISABLED=1` skips the pull entirely (the same env the
 *     daemon-client `autoPull` honors).
 *   - UNAUTHENTICATED: a session with NO credential POSTs unscoped; the daemon fail-closes it.
 *     We do not pre-gate on auth here (the daemon is the authority) — the pull simply returns a
 *     no-op outcome and session start proceeds.
 *
 * ── Shared-seam note (PRD-033 assets) ────────────────────────────────────────
 * This wiring fixes the SAME `SessionStartDeps`-missing-`seams` defect PRD-033's asset auto-pull
 * would also need. PRD-045g wires the SKILLS step here and leaves the other five steps at their
 * no-op default; a later PRD-033 pass adds an `assets` step onto the SAME injected seams object
 * WITHOUT re-plumbing the runtime. We do not take on 033's asset work here, only avoid blocking it.
 */

import {
	AUTOPULL_DISABLED_ENV,
	AUTOPULL_TIMEOUT_MS,
} from "../../daemon-client/skillify/index.js";
import { DAEMON_HOST, DAEMON_PORT } from "../../shared/constants.js";
import {
	type CredentialReader,
	type HookCredential,
	type SessionStartSeams,
} from "./contracts.js";

/** The loopback route the auto-pull POSTs (PRD-045g `mountSkillPropagationApi`). */
const SKILLS_PULL_ENDPOINT = "/api/skills/pull" as const;

/** Tenancy + runtime headers the daemon's `/api/skills` group resolves the scope from. */
const ORG_HEADER = "x-honeycomb-org" as const;
const WORKSPACE_HEADER = "x-honeycomb-workspace" as const;
const ACTOR_HEADER = "x-honeycomb-actor" as const;
/** The `default` workspace sentinel when a logged-in credential carries no workspace. */
const DEFAULT_WORKSPACE = "default" as const;

/** Options for {@link createSessionStartSeams}. All optional with production defaults. */
export interface SessionStartSeamsOptions {
	/**
	 * The credential reader the auto-pull resolves tenancy through (the SAME identity the daemon
	 * client + CLI use). When the read returns `undefined` (signed out), the pull is POSTed
	 * unscoped and the daemon fail-closes it. Injected so a test drives the seam deterministically.
	 */
	readonly credentials: CredentialReader;
	/** The daemon host. Defaults to the loopback constant (`127.0.0.1`). */
	readonly host?: string;
	/** The daemon port. Defaults to the loopback constant (`3850`). */
	readonly port?: number;
	/** Injectable `fetch` (tests). Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** The env (defaults to `process.env`) — the kill-switch flag is read here. */
	readonly env?: NodeJS.ProcessEnv;
	/** The auto-pull time budget in ms (default {@link AUTOPULL_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
}

/**
 * Build the production {@link SessionStartSeams} (g-AC-2). ONLY `autoPullSkills` is wired to a
 * real impl — a fail-soft, time-budgeted loopback `POST /api/skills/pull`. The other five steps
 * keep their no-op default (their real impls are owned by other PRDs and are out of 045g scope;
 * a no-op is the correct, safe placeholder — exactly the prior runtime behaviour for those steps).
 *
 * The returned seam is injected into `SessionStartDeps` on the session-start branch so
 * `runSessionStart` calls a REAL pull instead of the no-op default.
 */
export function createSessionStartSeams(options: SessionStartSeamsOptions): SessionStartSeams {
	const host = options.host ?? DAEMON_HOST;
	const port = options.port ?? DAEMON_PORT;
	const doFetch = options.fetch ?? fetch;
	const env = options.env ?? process.env;
	const timeoutMs = options.timeoutMs ?? AUTOPULL_TIMEOUT_MS;
	const url = `http://${host}:${port}${SKILLS_PULL_ENDPOINT}`;

	return {
		// Steps owned by other PRDs — no-op here (unchanged from the prior no-default behaviour).
		async healDriftedOrgToken(): Promise<void> {},
		async autoUpdate(): Promise<void> {},
		async ensureTables(): Promise<void> {},
		async writePlaceholderSummary(): Promise<void> {},
		async spawnGraphPull(): Promise<void> {},

		// Step 7 (FR-3): pull team/org skills. The REAL wiring 045g supplies — a fail-soft,
		// time-budgeted loopback POST to the daemon's pull route, which runs the idempotent team
		// pull + symlink fan-out daemon-side. NEVER throws (the caller's `safeVoid` also absorbs,
		// but we resolve cleanly here so a swallowed error is the explicit contract).
		async autoPullSkills(cred: HookCredential | undefined): Promise<void> {
			// Kill switch: run nothing (the same env the daemon-client auto-pull honors).
			if (env[AUTOPULL_DISABLED_ENV] === "1") return;
			await autoPullViaLoopback({ url, doFetch, cred, timeoutMs });
		},
	};
}

/** The args {@link autoPullViaLoopback} runs against (kept small so the call site reads clean). */
interface LoopbackPullArgs {
	readonly url: string;
	readonly doFetch: typeof fetch;
	readonly cred: HookCredential | undefined;
	readonly timeoutMs: number;
}

/**
 * Fire the loopback `POST /api/skills/pull`, bounded by the time budget and FULLY fail-soft. The
 * fetch is raced against an abort timer so a hung daemon never blocks session start; ANY failure
 * (timeout, refused socket, non-200) is swallowed — this always resolves to `void`, never throws.
 */
async function autoPullViaLoopback(args: LoopbackPullArgs): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), args.timeoutMs);
	if (typeof timer.unref === "function") timer.unref();
	try {
		await args.doFetch(args.url, {
			method: "POST",
			headers: tenancyHeaders(args.cred),
			body: "{}",
			signal: controller.signal,
		});
		// The response status is intentionally ignored: a non-200 (daemon fail-closed an unscoped
		// pull, or the route is unmounted on an older daemon) is NOT a session-start failure.
	} catch {
		// Timeout / refused / transport error — swallow. Session start is never blocked (FR-10).
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build the tenancy headers for the pull POST from the credential (the SAME stamping the daemon
 * client does). A logged-in credential scopes the pull to its org + workspace (the `default`
 * sentinel when absent); a signed-out session sends no scope headers and the daemon fail-closes
 * the pull (a no-op outcome) — session start still proceeds.
 */
function tenancyHeaders(cred: HookCredential | undefined): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cred?.org !== undefined && cred.org.length > 0) {
		headers[ORG_HEADER] = cred.org;
		headers[WORKSPACE_HEADER] = cred.workspace !== undefined && cred.workspace.length > 0 ? cred.workspace : DEFAULT_WORKSPACE;
	}
	if (cred?.actor !== undefined && cred.actor.length > 0) headers[ACTOR_HEADER] = cred.actor;
	return headers;
}
