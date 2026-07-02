/**
 * The `honeycomb dashboard` launch surface — PRD-020b (FR-1 / FR-7 / FR-8 / D-2 / D-7).
 *
 * FR-1: `honeycomb dashboard` launches the daemon-served dashboard pointed at the daemon on
 * port 3850. This module is the SEAM the 020a CLI `dashboard` verb calls: it builds the real
 * {@link DashboardDataSource} (a loopback HTTP reader against the daemon's dashboard endpoints)
 * and runs {@link renderDashboard}, returning the renderer-agnostic {@link RenderedDashboard}
 * `ViewBlock` tree a host (CLI/TUI print, or the 020c webview) paints. The dashboard NEVER opens
 * DeepLake — it reaches the daemon ONLY through these endpoints (D-2; `src/dashboard` is a
 * NON_DAEMON_ROOT).
 *
 * ── Deferred assembly (D-7) ──────────────────────────────────────────────────
 *   The real `createDaemonDashboardDataSource` is constructed-and-tested here behind an injected
 *   `fetch` seam (so a test drives it with a stub fetch), but it is NOT auto-wired into a running
 *   daemon/host this wave: the 020a `dashboard` verb invokes `launchDashboard(...)`, and the
 *   webview/TUI host that paints the tree is the host's concern. Nothing here binds a socket or
 *   spawns a UI — importing this module has no side effects.
 */

import { DAEMON_HOST, DAEMON_PORT, HIVE_HOST, HIVE_PORT } from "../shared/constants.js";
import {
	type Connectivity,
	type DashboardData,
	type DashboardDataSource,
	EMPTY_DASHBOARD_DATA,
	reachable,
	unreachable,
} from "./contracts.js";
import { type RenderedDashboard, renderDashboard } from "./dashboard.js";

/** The minimal `fetch` shape the loopback reader needs (the global `fetch` satisfies it). */
export type FetchLike = (
	input: string,
	init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

/** Options pointing the dashboard at the daemon (FR-1). Defaults to the loopback 3850 daemon. */
export interface LaunchDashboardOptions {
	/** The daemon host. Defaults to the shared loopback constant. */
	readonly host?: string;
	/** The daemon port. Defaults to 3850 (FR-1). */
	readonly port?: number;
	/** The HTTP transport. Defaults to the global `fetch`. Injected for tests. */
	readonly fetch?: FetchLike;
	/** Per-request timeout (ms) so an unreachable daemon never hangs the probe (FR-8). */
	readonly timeoutMs?: number;
	/** Tenancy headers (org/workspace) forwarded to the daemon, when known. */
	readonly headers?: Readonly<Record<string, string>>;
}

/** The daemon base URL the dashboard points at (FR-1: 3850 by default). */
export function daemonBaseUrl(options: LaunchDashboardOptions = {}): string {
	const host = options.host ?? DAEMON_HOST;
	const port = options.port ?? DAEMON_PORT;
	return `http://${host}:${port}`;
}

/** Run a single GET against a daemon endpoint, parsing JSON; throws on non-ok or transport error. */
async function getJson<T>(
	fetchImpl: FetchLike,
	url: string,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
		if (!res.ok) throw new Error(`daemon responded ${res.status} for ${url}`);
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build the REAL daemon-served {@link DashboardDataSource} (FR-7) — a thin loopback reader over
 * the daemon's dashboard endpoints. `probe()` GETs `/health` to derive the {@link Connectivity}
 * state (FR-8, reusing the same reachability signal the D1/D2 health dims use); `fetchAll()` GETs
 * the six view endpoints and assembles the {@link DashboardData}. NEVER opens DeepLake (D-2) —
 * the daemon does, behind these endpoints. Constructed-and-tested behind the injected `fetch`
 * seam (D-7); the running CLI/host injects the global `fetch`.
 */
export function createDaemonDashboardDataSource(options: LaunchDashboardOptions = {}): DashboardDataSource {
	const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const base = daemonBaseUrl(options);
	const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
	const timeoutMs = options.timeoutMs ?? 1500;
	return {
		async probe(): Promise<Connectivity> {
			try {
				await getJson<unknown>(fetchImpl, `${base}/health`, headers, timeoutMs);
				return reachable(base);
			} catch (err) {
				const detail = err instanceof Error ? err.message : "daemon not reachable";
				return unreachable(base, detail);
			}
		},
		async fetchAll(): Promise<DashboardData> {
			// The daemon serves each view as its 020b view-model shape; assemble them into the
			// full DashboardData. A missing/empty endpoint falls back to the empty-but-valid shape
			// so one absent view never blanks the whole dashboard.
			const [kpis, sessions, settings, graph, rules, skillSync] = await Promise.all([
				getJson<DashboardData["kpis"]>(fetchImpl, `${base}/api/diagnostics/kpis`, headers, timeoutMs).catch(
					() => EMPTY_DASHBOARD_DATA.kpis,
				),
				getJson<DashboardData["sessions"]>(fetchImpl, `${base}/api/diagnostics/sessions`, headers, timeoutMs).catch(
					() => EMPTY_DASHBOARD_DATA.sessions,
				),
				getJson<DashboardData["settings"]>(fetchImpl, `${base}/api/diagnostics/settings`, headers, timeoutMs).catch(
					() => EMPTY_DASHBOARD_DATA.settings,
				),
				getJson<DashboardData["graph"]>(fetchImpl, `${base}/api/graph`, headers, timeoutMs).catch(
					() => EMPTY_DASHBOARD_DATA.graph,
				),
				getJson<DashboardData["rules"]>(fetchImpl, `${base}/api/diagnostics/rules`, headers, timeoutMs).catch(
					() => EMPTY_DASHBOARD_DATA.rules,
				),
				getJson<DashboardData["skillSync"]>(fetchImpl, `${base}/api/diagnostics/skills`, headers, timeoutMs).catch(
					() => EMPTY_DASHBOARD_DATA.skillSync,
				),
			]);
			return { kpis, sessions, settings, graph, rules, skillSync };
		},
	};
}

/**
 * Launch the dashboard (FR-1). The 020a CLI `dashboard` verb calls THIS: build the daemon-served
 * data source (loopback 3850 by default) and render via {@link renderDashboard}, returning the
 * renderer-agnostic {@link RenderedDashboard} so the host (CLI print / TUI / 020c webview) paints
 * the SAME `ViewBlock` tree (D-6). A test injects a fake `DashboardDataSource` via `options.source`
 * to drive the flow without a live daemon.
 */
export async function launchDashboard(
	options: LaunchDashboardOptions & { readonly source?: DashboardDataSource } = {},
): Promise<RenderedDashboard> {
	const source = options.source ?? createDaemonDashboardDataSource(options);
	return renderDashboard(source);
}

/** The URL path the hive portal serves the dashboard SPA at (ADR-0001 / PRD-001). */
export const DASHBOARD_HOST_PATH = "/" as const;

/** The hive portal base URL the operator opens in a browser. */
export function portalBaseUrl(options: LaunchDashboardOptions = {}): string {
	const host = options.host ?? HIVE_HOST;
	const port = options.port ?? HIVE_PORT;
	return `http://${host}:${port}`;
}

/** The result of opening the dashboard host: the viewable URL + a probed connectivity state. */
export interface OpenDashboardResult {
	/** The viewable dashboard host URL the operator opens (e.g. `http://127.0.0.1:3850/dashboard`). */
	readonly url: string;
	/** The probed connectivity (so the verb can warn when the daemon is down before opening). */
	readonly connectivity: Connectivity;
}

/**
 * Resolve the viewable portal URL (PRD-001 / ADR-0001) the `honeycomb dashboard` verb opens.
 * hive serves the React dashboard at loopback port 3853; honeycomb keeps `/api/*` only.
 * Returns that URL plus a connectivity probe against the honeycomb data daemon so the verb
 * can surface the daemon-down state (d-AC-5) before handing the URL to a browser opener.
 */
export async function openDashboard(
	options: LaunchDashboardOptions & { readonly source?: DashboardDataSource } = {},
): Promise<OpenDashboardResult> {
	const source = options.source ?? createDaemonDashboardDataSource(options);
	const connectivity = await source.probe();
	return { url: `${portalBaseUrl(options)}${DASHBOARD_HOST_PATH}`, connectivity };
}
