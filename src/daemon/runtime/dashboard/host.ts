/**
 * The viewable dashboard HOST route — PRD-021d (FR-3 / FR-5 / d-AC-3).
 *
 * d-AC-3 asks the daemon to SERVE the canonical 020b view layer as a real, viewable page
 * (not just a JSON data contract). This module is the single named step the daemon
 * assembly calls AFTER `createDaemon(...)` to attach `GET /dashboard` onto the
 * already-mounted root group — mirroring `mountDashboardApi`. It builds a DAEMON-SIDE
 * {@link DashboardDataSource} (reading the live storage directly via the shared view
 * fetchers in `api.ts`, allowed because this lives under `src/daemon/`), runs the 020b
 * {@link renderDashboard} orchestrator, and serializes the resulting `ViewBlock` tree to a
 * standalone HTML page via {@link renderDashboardPage}. The page is pointed at the live
 * daemon data, so opening it shows real KPIs/sessions/etc.
 *
 * ── Connectivity + empty states are FREE (d-AC-5 / d-AC-6) ────────────────────
 *   The host calls the SAME `renderDashboard` the thin client uses, so a daemon-down probe
 *   yields the 020b connectivity banner alone and a not-built graph / empty session list
 *   yields the 020b empty-state block — no reinvention. Here the probe is in-process: the
 *   daemon serving the page IS up, so `probe()` reports reachable and the views render; the
 *   daemon-down banner is exercised by the thin-client path (`launchDashboard`) and tested
 *   directly against `renderDashboard`.
 *
 * ── Why daemon-side (not the loopback thin client) ───────────────────────────
 *   The host serves the page FROM the daemon, so it reads storage in-process rather than
 *   dialing itself over loopback (which would be a needless round trip and a chicken-and-egg
 *   during boot). The thin-client `createDaemonDashboardDataSource` (020b `launch.ts`) is for
 *   an EXTERNAL caller (the CLI/webview); this in-process source is the host's own reader.
 *
 * ── Deferred assembly (D-1 / D-7) ────────────────────────────────────────────
 *   The production daemon assembly (021a) calls `mountDashboardHost(daemon, { storage })`
 *   once. Constructed-and-tested here against a fake `StorageQuery`; importing the daemon
 *   does not auto-invoke it.
 */

import {
	type Connectivity,
	type DashboardData,
	type DashboardDataSource,
	reachable,
} from "../../../dashboard/contracts.js";
import { renderDashboard } from "../../../dashboard/dashboard.js";
import { renderDashboardPage } from "../../../dashboard/html.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import {
	buildSettingsView,
	type DashboardSettingsConfig,
	fetchGraphView,
	fetchKpisView,
	fetchRulesView,
	fetchSessionsView,
	fetchSkillSyncView,
} from "./api.js";

/** The route the viewable dashboard host is served at (FR-3). */
export const DASHBOARD_HOST_PATH = "/dashboard" as const;

/** The root route group the host attaches to (already mounted, UNPROTECTED, in `server.ts`). */
export const DASHBOARD_HOST_GROUP = "/" as const;

/** Resolve the daemon's own tenancy scope for the in-process host read. */
export interface HostScopeResolver {
	/** The org/workspace the host reads under. */
	resolve(): QueryScope;
}

/** Options for {@link mountDashboardHost}. */
export interface MountDashboardHostOptions {
	/** The live storage client the daemon-side data source reads through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The scope the in-process host reads under. Defaults to {@link envHostScope} (the same
	 * `HONEYCOMB_DEEPLAKE_ORG`/`WORKSPACE` the composition root resolves the daemon scope from).
	 * A test injects a fixed scope.
	 */
	readonly scope?: HostScopeResolver;
}

/**
 * The default host scope: read `HONEYCOMB_DEEPLAKE_ORG` / `HONEYCOMB_DEEPLAKE_WORKSPACE`
 * from env (the daemon's own partition, the same source `assemble.ts` uses). Falls back to
 * the benign loopback `{ org: "local", workspace: "default" }` when env is unset (a test /
 * bare assembly), so the host never throws building its scope.
 */
export const envHostScope: HostScopeResolver = {
	resolve(): QueryScope {
		const org = process.env.HONEYCOMB_DEEPLAKE_ORG;
		const workspace = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE;
		if (org !== undefined && org.length > 0) {
			return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
		}
		return { org: "local", workspace: "default" };
	},
};

/**
 * Build the DAEMON-SIDE {@link DashboardDataSource} (d-AC-3). `probe()` always reports
 * reachable — the daemon serving the page IS up (an in-process read needs no loopback
 * round trip). `fetchAll()` reads the six views directly through the shared fetchers, so
 * the served page draws the SAME rows the JSON endpoints serve. Exported so a test drives
 * the source against a fake `StorageQuery` without the route.
 */
export function createDaemonSideDataSource(
	storage: StorageQuery,
	scope: QueryScope,
	settings: DashboardSettingsConfig,
	hostUrl: string,
): DashboardDataSource {
	return {
		async probe(): Promise<Connectivity> {
			// The host serves the page from inside the running daemon, so it is reachable by
			// construction. The daemon-DOWN banner is the thin-client path's concern (d-AC-5),
			// exercised against `renderDashboard` directly.
			return reachable(hostUrl);
		},
		async fetchAll(): Promise<DashboardData> {
			const [kpis, sessions, graph, rules, skillSync] = await Promise.all([
				fetchKpisView(storage, scope),
				fetchSessionsView(storage, scope),
				fetchGraphView(storage, scope),
				fetchRulesView(storage, scope),
				fetchSkillSyncView(storage, scope),
			]);
			return { kpis, sessions, settings: buildSettingsView(scope, settings), graph, rules, skillSync };
		},
	};
}

/**
 * Attach the viewable dashboard host onto the daemon's already-mounted root group
 * (d-AC-3 / FR-3 / FR-5). Registers `GET /dashboard`, which builds the daemon-side data
 * source, runs the 020b `renderDashboard`, and returns the serialized HTML page. Call ONCE
 * after `createDaemon(...)`. If the root group is not mounted (unknown daemon shape) the
 * attach is a no-op. The route is unprotected (the root group carries no permission
 * middleware) — `local` single-user loopback is the dogfood target (D-3).
 */
export function mountDashboardHost(daemon: Daemon, options: MountDashboardHostOptions): void {
	const root = daemon.group(DASHBOARD_HOST_GROUP);
	if (root === undefined) return;

	const storage = options.storage;
	const scopeResolver = options.scope ?? envHostScope;
	const settings: DashboardSettingsConfig = { mode: daemon.config.mode, port: daemon.config.port };
	const hostUrl = `http://${daemon.config.host}:${daemon.config.port}${DASHBOARD_HOST_PATH}`;

	root.get(DASHBOARD_HOST_PATH, async (c) => {
		const scope = scopeResolver.resolve();
		const source = createDaemonSideDataSource(storage, scope, settings, hostUrl);
		const rendered = await renderDashboard(source);
		return c.html(renderDashboardPage(rendered));
	});
}
