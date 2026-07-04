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
 * ── ASSETS auto-pull (PRD-033 R-1) — the SECOND real step on this seam ────────
 * PRD-045g wired the SKILLS step (a fire-and-forget daemon POST). PRD-033 R-1 now adds the
 * `autoPullAssets` step onto the SAME injected seams object WITHOUT re-plumbing the runtime — the
 * runtime already constructs this factory with `{ credentials, host, port, fetch }`, so the new
 * step flows through for free. The asset pull is DIFFERENT in shape from the skills pull: it runs
 * the THIN-CLIENT install IN-PROCESS (`daemon-client/assets`'s `autoPull` → `pullAndInstall`). The
 * daemon only returns rows over loopback (`POST /api/assets/pull`); THIS client writes the native
 * artifacts to disk. The same discipline holds — kill-switch (`HONEYCOMB_ASSET_AUTOPULL_DISABLED`),
 * fully fail-soft (ANY error swallowed → resolves void), and time-budgeted (the thin client's own
 * 5s budget; we add NO second timeout). The tenancy scope is built from the credential
 * (org/workspace/author) + this machine's stable device id (`~/.apiary/device.json`, with a legacy
 * `~/.honeycomb/device.json` read fallback during the ADR-0003 window).
 */

import {
	type AssetAutoPullDeps,
	type AssetScope,
	ASSET_AUTOPULL_DISABLED_ENV,
	autoPull as autoPullAssetsThinClient,
	createDefaultHarnessRoots,
	createLoopbackAssetSyncApi,
} from "../../daemon-client/assets/index.js";
import { AUTOPULL_DISABLED_ENV, AUTOPULL_TIMEOUT_MS } from "../../daemon-client/skillify/index.js";
import { createLoopbackDaemonClient } from "../../commands/contracts.js";
// `loadOrCreateDevice` is imported from the PURE device module (NOT the assets barrel
// `daemon/runtime/assets/index.js`, which re-exports the storage-laden `sync.js`/`api.js`).
// `device.js` itself imports only node builtins (crypto/fs/os/path), so this deep import keeps
// the thin-client invariant: `src/hooks` stays free of any `daemon/storage` path, statically AND
// at bundle time (esbuild never pulls the storage client in through this leaf). See D-6.
import { type DeviceRecord, loadOrCreateDevice } from "../../daemon/runtime/assets/device.js";
import { DAEMON_HOST, DAEMON_PORT } from "../../shared/constants.js";
import { type CredentialReader, type HookCredential, type SessionStartSeams } from "./contracts.js";

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
	/**
	 * Resolve this machine's stable device record for the asset-pull scope (default
	 * {@link loadOrCreateDevice}, which reads/mints the fleet-root `~/.apiary/device.json` with a
	 * legacy `~/.honeycomb/device.json` fallback). Injected so the asset auto-pull test drives the
	 * device id deterministically WITHOUT touching the real home.
	 */
	readonly loadDevice?: () => DeviceRecord;
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
	const loadDevice = options.loadDevice ?? loadOrCreateDevice;
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

		// Step 7b (PRD-033 R-1): pull + install team/org synced ASSETS in-process. Runs the
		// assets THIN-CLIENT `autoPull` (the daemon returns rows over loopback; this client writes
		// the files). Idempotent + fail-soft + time-budgeted by the thin client itself (its own 5s
		// budget — we add NO second timeout). The kill switch + scope are resolved here; ANY error
		// is swallowed so session start is NEVER blocked (FR-10).
		async autoPullAssets(cred: HookCredential | undefined): Promise<void> {
			try {
				// Kill switch (the SAME env the assets thin client honors). Checked here too so a
				// disabled pull never even constructs the loopback client / reads the device file.
				if (env[ASSET_AUTOPULL_DISABLED_ENV] === "1") return;
				const deps = buildAssetAutoPullDeps({ cred, host, port, doFetch, loadDevice });
				await autoPullAssetsThinClient(deps);
			} catch {
				// Device read, client construction, or pull — ANY failure is swallowed. The thin
				// client's `autoPull` is already fail-soft; this outer guard covers the wiring too.
			}
		},
	};
}

/** The wiring a {@link buildAssetAutoPullDeps} resolves the asset auto-pull from. */
interface AssetAutoPullWiring {
	readonly cred: HookCredential | undefined;
	readonly host: string;
	readonly port: number;
	readonly doFetch: typeof fetch;
	readonly loadDevice: () => DeviceRecord;
}

/**
 * Assemble the {@link AssetAutoPullDeps} the assets thin-client `autoPull` runs against: the
 * loopback {@link createLoopbackAssetSyncApi} over a credential-stamped {@link createLoopbackDaemonClient}
 * (the ONLY path to `synced_assets`, D-6), the default per-harness install roots, and the pull
 * scope built from the credential + this machine's stable device id. No timeout is set — the thin
 * client applies its own 5s budget; setting one here would double-bound it.
 */
function buildAssetAutoPullDeps(wiring: AssetAutoPullWiring): AssetAutoPullDeps {
	const daemon = createLoopbackDaemonClient({
		baseUrl: `http://${wiring.host}:${wiring.port}`,
		headers: tenancyHeaders(wiring.cred),
		fetchImpl: wiring.doFetch,
	});
	return {
		api: createLoopbackAssetSyncApi(daemon),
		roots: createDefaultHarnessRoots(),
		scope: buildAssetScope(wiring.cred, wiring.loadDevice),
	};
}

/**
 * Build the {@link AssetScope} the asset pull is scoped by — org/workspace bound the Team radius,
 * author + the stable device id bound the Device radius. Prefer the credential's resolved tenancy;
 * fall back to the same `local`/`default` sentinels the CLI's `resolveScope` uses for a loopback,
 * single-tenant local pull. The device id is read from (or minted into) the fleet-root
 * `~/.apiary/device.json` (legacy `~/.honeycomb/device.json` fallback during the window).
 */
function buildAssetScope(cred: HookCredential | undefined, loadDevice: () => DeviceRecord): AssetScope {
	const device = loadDevice();
	const org = cred?.org !== undefined && cred.org.length > 0 ? cred.org : "local";
	const workspace = cred?.workspace !== undefined && cred.workspace.length > 0 ? cred.workspace : DEFAULT_WORKSPACE;
	const author = cred?.actor !== undefined && cred.actor.length > 0 ? cred.actor : device.label;
	return { org, workspace, author, deviceId: device.device_id };
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
		headers[WORKSPACE_HEADER] =
			cred.workspace !== undefined && cred.workspace.length > 0 ? cred.workspace : DEFAULT_WORKSPACE;
	}
	if (cred?.actor !== undefined && cred.actor.length > 0) headers[ACTOR_HEADER] = cred.actor;
	return headers;
}
