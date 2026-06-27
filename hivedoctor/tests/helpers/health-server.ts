/**
 * A real ephemeral node:http server that stands in for the daemon's `/health`
 * endpoint, so the probe is exercised end-to-end over a real socket (not a mocked
 * fetch). The handler is swappable per test so a single server can act healthy, then
 * degraded, then be torn down to simulate "unreachable".
 *
 * Built-ins only (node:http), mirroring the runtime constraint of the package itself.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The per-request behavior a test installs. */
export type HealthHandler = () => { statusCode: number; body: string };

/** A running mock health server bound to an ephemeral loopback port. */
export interface MockHealthServer {
	/** The `/health` URL to point the probe at. */
	readonly url: string;
	/** Swap the response behavior. */
	setHandler(handler: HealthHandler): void;
	/** Stop answering by making the socket hang forever (simulates a wedged daemon -> timeout). */
	setHang(hang: boolean): void;
	/** Close the server (simulates a down daemon -> connection refused). */
	close(): Promise<void>;
}

/** A convenient healthy `ok` body matching the daemon's health.ts shape. */
export function okBody(): { statusCode: number; body: string } {
	return {
		statusCode: 200,
		body: JSON.stringify({ status: "ok", reasons: { storage: "reachable", embeddings: "on", schema: "ok" } }),
	};
}

/** A degraded body naming a specific failing subsystem (for AC-064a.4). */
export function degradedBody(reasons: { storage?: string; embeddings?: string; schema?: string }): {
	statusCode: number;
	body: string;
} {
	return { statusCode: 200, body: JSON.stringify({ status: "degraded", reasons }) };
}

/** Start a mock health server on an ephemeral port. */
export async function startMockHealthServer(initial: HealthHandler = okBody): Promise<MockHealthServer> {
	let handler = initial;
	let hang = false;

	const server: Server = createServer((req, res) => {
		if (hang) {
			// Accept the socket but never respond -> the probe's setTimeout fires -> classified
			// as `unreachable-timeout`. We intentionally leave req/res dangling.
			void req;
			return;
		}
		const { statusCode, body } = handler();
		res.writeHead(statusCode, { "content-type": "application/json" });
		res.end(body);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${port}/health`;

	return {
		url,
		setHandler(next: HealthHandler): void {
			handler = next;
		},
		setHang(next: boolean): void {
			hang = next;
		},
		close(): Promise<void> {
			return new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			});
		},
	};
}
