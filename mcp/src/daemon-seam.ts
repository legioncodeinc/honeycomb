/**
 * The production {@link DaemonApiSeam} — PRD-019d FR-2 / d-AC-1 / D-6.
 *
 * ── WHAT THIS STAMPS ────────────────────────────────────────────────────────
 * Every MCP tool call routes through this seam. It calls the daemon's OWN API over
 * loopback (`127.0.0.1:3850`, the shared daemon-client constants) and STAMPS, on
 * EVERY request:
 *   - `x-honeycomb-runtime-path: plugin`  (MCP traffic is plugin-path traffic, FR-2)
 *   - `x-honeycomb-actor: <actor>`        (the actor identity, d-AC-1)
 *   - `x-honeycomb-actor-type: <type>`    (user / agent / plugin, d-AC-1)
 *
 * The daemon (already built, PRD-004/011) ENFORCES scoping/permission/runtime-path
 * on these headers; this surface only STAMPS them (D-6). The seam opens NO DeepLake.
 *
 * ── DEFERRED LIVE BIND ──────────────────────────────────────────────────────
 * `createHttpDaemonApiSeam` is constructed-and-tested behind the `fetch` seam: a
 * test injects a fake `fetch` and asserts the stamped headers + the URL, with NO
 * socket. The real `globalThis.fetch` over loopback is the assembly-time wiring; we
 * do NOT claim a live MCP endpoint is serving — only that the seam stamps correctly.
 */

import { DAEMON_HOST, DAEMON_PORT } from "../../src/shared/constants.js";
import type { Actor, DaemonApiRequest, DaemonApiResponse, DaemonApiSeam } from "./contracts.js";

/** The header keys this seam stamps on every daemon call (FR-2 / d-AC-1). */
export const RUNTIME_PATH_HEADER = "x-honeycomb-runtime-path";
export const ACTOR_HEADER = "x-honeycomb-actor";
export const ACTOR_TYPE_HEADER = "x-honeycomb-actor-type";

/** The runtime path MCP traffic always stamps (FR-2). */
export const MCP_RUNTIME_PATH = "plugin";

/** The minimal `fetch` shape this seam depends on (injected so tests need no socket). */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Options for {@link createHttpDaemonApiSeam}. */
export interface HttpDaemonApiSeamOptions {
	/** The daemon host (default: the shared loopback constant). */
	readonly host?: string;
	/** The daemon port (default: the shared loopback constant). */
	readonly port?: number;
	/** The `fetch` impl (default: `globalThis.fetch`). Injected for tests. */
	readonly fetch?: FetchLike;
}

/** Build the headers for a daemon call — always stamps plugin + actor (FR-2 / d-AC-1). */
export function stampHeaders(actor: Actor): Record<string, string> {
	return {
		"content-type": "application/json",
		[RUNTIME_PATH_HEADER]: MCP_RUNTIME_PATH,
		[ACTOR_HEADER]: actor.actor,
		[ACTOR_TYPE_HEADER]: actor.actorType,
	};
}

/**
 * The production {@link DaemonApiSeam}: calls the daemon's own API over loopback,
 * stamping `x-honeycomb-runtime-path: plugin` + actor headers on every request
 * (FR-2 / d-AC-1). Behind the injected `fetch` seam so a test asserts the stamps
 * without binding a socket. Opens NO DeepLake (D-2).
 */
export function createHttpDaemonApiSeam(opts: HttpDaemonApiSeamOptions = {}): DaemonApiSeam {
	const host = opts.host ?? DAEMON_HOST;
	const port = opts.port ?? DAEMON_PORT;
	const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const base = `http://${host}:${port}`;

	return {
		async call(req: DaemonApiRequest): Promise<DaemonApiResponse> {
			const headers = stampHeaders(req.actor);
			const init: { method: string; headers: Record<string, string>; body?: string } = {
				method: req.method,
				headers,
			};
			if (req.body !== undefined) init.body = JSON.stringify(req.body);
			const res = await doFetch(`${base}${req.path}`, init);
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				body = undefined;
			}
			return { status: res.status, body };
		},
	};
}
