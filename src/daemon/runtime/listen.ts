/**
 * Production listen path (PRD-004a FR-1 / a-AC-1 / a-AC-7).
 *
 * Binds the daemon's Hono app to a real TCP socket via `@hono/node-server`. This
 * is the ONLY module that opens a socket; it is kept separate from `server.ts`
 * so the server surface (routes, middleware, /health, /api/status) is fully
 * verifiable in-process (`app.request(...)`) with no network. Importing the
 * runtime does not auto-listen — `startDaemon` is called explicitly by the CLI.
 *
 * Bind contract (FR-1 / D-1): listens on `config.host:config.port`, which the
 * config resolver already produced from `HONEYCOMB_PORT`/`HOST`/`BIND`. A port
 * already in use surfaces as a thrown bind error (the impl-note "fail startup
 * loudly rather than silently rebind"); we do not catch it here.
 */

import { serve } from "@hono/node-server";
import type { Daemon } from "./server.js";

/** A running daemon: the bound server handle plus a graceful close. */
export interface RunningDaemon {
	/** The resolved address the daemon is listening on. */
	readonly address: { host: string; port: number };
	/** Stop the HTTP server and all daemon services. */
	close(): Promise<void>;
}

/**
 * Start the daemon: bring up its services, then bind the HTTP socket. Returns a
 * handle to close both. The bind happens AFTER services start so the daemon does
 * not accept requests before the queue/watcher are warm. A bind failure (port in
 * use) rejects loudly; services are stopped before re-throwing so a failed start
 * leaves nothing dangling.
 */
export async function startDaemon(daemon: Daemon): Promise<RunningDaemon> {
	await daemon.startServices();

	let server: ReturnType<typeof serve>;
	try {
		server = serve({
			fetch: daemon.app.fetch,
			hostname: daemon.config.host,
			port: daemon.config.port,
		});
	} catch (err: unknown) {
		// Roll back the started services so a bind failure is clean, then surface
		// the real cause (e.g. EADDRINUSE) rather than swallowing it.
		await daemon.stopServices();
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`daemon failed to bind ${daemon.config.host}:${daemon.config.port}: ${message}`);
	}

	return {
		address: { host: daemon.config.host, port: daemon.config.port },
		async close(): Promise<void> {
			await new Promise<void>((resolve, reject) => {
				server.close((err?: unknown) => {
					if (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
						return;
					}
					resolve();
				});
			});
			await daemon.stopServices();
		},
	};
}
