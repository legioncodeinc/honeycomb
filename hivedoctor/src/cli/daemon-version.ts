/**
 * Read the primary daemon's reported version from `/health` (PRD-064f, `status` command).
 *
 * The daemon's `/health` body carries `{ status, version, ... }` (src/daemon/runtime/
 * server.ts). HiveDoctor reads that `version` field so `status` can show the daemon's
 * running version alongside HiveDoctor's own. It is ALSO the `readInstalledVersion` seam
 * rung 2 / the auto-update engine consult to verify an install took.
 *
 * Built-ins ONLY: node:http, no fetch wrapper (mirrors src/health-probe.ts). NEVER throws:
 * any transport error, non-2xx, or missing/garbage version field resolves to `null`
 * ("version unknown"), so a down daemon never breaks `status` (AC-064f.6).
 */

import { request } from "node:http";

/** Options for {@link readDaemonVersion}. */
export interface ReadDaemonVersionOptions {
	/** The `/health` URL to read (same target the probe uses). */
	readonly healthUrl: string;
	/** Per-read timeout in ms; a wedged socket resolves null after this. */
	readonly timeoutMs: number;
}

/** Parse a daemon `/health` body and extract its `version` string, or null. Defensive. */
export function parseDaemonVersion(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const version = (parsed as Record<string, unknown>).version;
		return typeof version === "string" && version.trim().length > 0 ? version.trim() : null;
	} catch {
		// Non-JSON / unparseable body: version unknown.
		return null;
	}
}

/**
 * Read the daemon's reported version from `/health`. Resolves the version string on a 2xx
 * body that carries one, else null. NEVER throws (a down/wedged daemon -> null).
 */
export function readDaemonVersion(options: ReadDaemonVersionOptions): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		try {
			const req = request(options.healthUrl, { method: "GET" }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => {
					// Cap the buffered body: /health is tiny; a misbehaving endpoint cannot balloon memory.
					if (chunks.length < 256) chunks.push(chunk);
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						finish(null);
						return;
					}
					finish(parseDaemonVersion(Buffer.concat(chunks).toString("utf8")));
				});
				res.on("error", () => finish(null));
			});

			req.setTimeout(options.timeoutMs, () => {
				req.destroy(new Error("daemon_version_timeout"));
			});
			req.on("error", () => finish(null));
			req.end();
		} catch {
			// Defensive: even a synchronous throw from request() must not crash the caller.
			finish(null);
		}
	});
}
