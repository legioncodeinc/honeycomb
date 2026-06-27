/**
 * HiveDoctor local status page (PRD-064g AC-064g.4).
 *
 * A minimal read-only HTTP server bound to 127.0.0.1 on a config-driven port
 * (distinct from 3850/3851 used by the primary daemon and its dashboard). The
 * purpose is comfort UX: the user has SOMETHING to look at while the primary
 * daemon (and its dashboard) is down.
 *
 * Two routes:
 *   GET /             -- minimal HTML page showing health, latest escalation,
 *                        and suggested `hivedoctor` commands.
 *   GET /status.json  -- the same data as JSON; machine-readable.
 *   Any other path    -- 404 with a short JSON body.
 *
 * Design constraints (PRD-064g hard constraints):
 *   - Node built-ins ONLY: `node:http`. Zero new runtime deps.
 *   - Bind errors are SWALLOWED + LOGGED; a port-conflict or EACCES must never
 *     crash HiveDoctor (design principle 1, "incapable of crashing").
 *   - The server is READ-ONLY: it serves the state HiveDoctor already knows.
 *     It never accepts mutations, never proxies to the daemon, never calls out.
 *   - Bound to 127.0.0.1 only (loopback); never 0.0.0.0.
 *   - start()/stop() lifecycle; safe to call stop() before start().
 *
 * Port: config-driven (`statusPagePort` in HiveDoctorConfig extension, default 3852).
 * The constant DEFAULT_STATUS_PAGE_PORT is exported so config.ts and tests use the
 * same value without a second definition.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "../logger.js";
import type { NeedsAttentionFile } from "../escalation/needs-attention-store.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Coarse health snapshot the status page reads from the supervisor. */
export type StatusPageHealth = "ok" | "degraded" | "unreachable" | "unknown";

/** The JSON shape served at GET /status.json (AC-064g.4). */
export interface StatusJson {
	readonly health: StatusPageHealth;
	/** Null when no escalation has occurred. */
	readonly escalation: NeedsAttentionFile | null;
	/** Suggested commands the user can run to diagnose or fix. */
	readonly suggestedCommands: readonly string[];
	/** ISO-8601 of when the status was generated. */
	readonly asOf: string;
}

/** State provider injected into the server so it always serves fresh data. */
export interface StatusPageStateProvider {
	/** Current coarse health. */
	health(): StatusPageHealth;
	/** Current needs-attention record, or null. */
	escalation(): NeedsAttentionFile | null;
}

/** Options for {@link createStatusPageServer}. */
export interface StatusPageServerOptions {
	/** TCP port to bind to on 127.0.0.1. */
	readonly port: number;
	/** Injected state provider. */
	readonly state: StatusPageStateProvider;
	/** Logger for lifecycle events and bind errors. */
	readonly logger: Logger;
	/** Injected clock for `asOf` (defaults to `Date.now`). */
	readonly now?: () => number;
}

/** The status page server handle returned by {@link createStatusPageServer}. */
export interface StatusPageServer {
	/**
	 * Bind the server to 127.0.0.1:<port>.
	 * A bind error (EADDRINUSE, EACCES) is swallowed + logged; never throws.
	 * Safe to call multiple times; a second call while already listening is a no-op.
	 */
	start(): void;
	/**
	 * Close the server; drains existing connections.
	 * Safe to call before start() or after stop(). Never throws.
	 */
	stop(): void;
	/**
	 * The port the server is actually listening on (undefined before start() or
	 * after a failed bind). For tests that use port 0 to get an OS-assigned port.
	 */
	readonly listeningPort: number | undefined;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default local status page port (distinct from 3850/3851). */
export const DEFAULT_STATUS_PAGE_PORT = 3852 as const;

/** The loopback address the server always binds to. */
const LOOPBACK = "127.0.0.1";

// ── Suggested commands ────────────────────────────────────────────────────────

/** Build the suggested commands for the status page based on current health + escalation. */
function buildSuggestedCommands(
	health: StatusPageHealth,
	escalation: NeedsAttentionFile | null,
): readonly string[] {
	const cmds: string[] = [];

	if (health !== "ok") {
		cmds.push("hivedoctor status");
		cmds.push("hivedoctor logs");
	}

	if (escalation !== null && !escalation.resolved) {
		const action = escalation.escalation.recommendedAction;
		switch (action) {
			case "reinstall-primary":
				cmds.push("npm install -g @legioncodeinc/honeycomb@latest");
				break;
			case "uninstall-conflicting-hivemind":
				cmds.push("npm uninstall -g @deeplake/hivemind");
				break;
			case "clear-credentials":
				// Deferred action -- we recommend but do not perform it (AC-064c.3 / OD-4).
				cmds.push("# Review ~/.deeplake/credentials.json (HiveDoctor cannot clear it automatically)");
				break;
			case "investigate":
			case "manual-intervention":
				cmds.push("hivedoctor doctor");
				break;
			default:
				cmds.push("hivedoctor doctor");
		}
	}

	if (cmds.length === 0) {
		cmds.push("hivedoctor status");
	}

	return cmds;
}

// ── HTML template ─────────────────────────────────────────────────────────────

/** Minimal inline CSS (no external resources; zero network calls from the page). */
const PAGE_CSS = `
  body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.5}
  h1{font-size:1.4rem;margin-bottom:.5rem}
  .badge{display:inline-block;padding:.2em .7em;border-radius:.3em;font-size:.9rem;font-weight:600}
  .ok{background:#d4edda;color:#155724}
  .degraded{background:#fff3cd;color:#856404}
  .unreachable,.unknown{background:#f8d7da;color:#721c24}
  pre{background:#f6f8fa;padding:.8rem;border-radius:.3em;overflow:auto;font-size:.85rem}
  ul{padding-left:1.2rem}
  .muted{color:#6c757d;font-size:.85rem}
`.replace(/\n\s*/g, " ");

/** Build the minimal HTML status page. */
function buildHtml(status: StatusJson): string {
	const healthClass = status.health;
	const escalationSection =
		status.escalation === null
			? "<p>No escalation recorded.</p>"
			: `<pre>${escapeHtml(JSON.stringify(status.escalation, null, 2))}</pre>`;

	const commandList = status.suggestedCommands.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join("");

	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>HiveDoctor Status</title><style>${PAGE_CSS}</style></head>
<body>
<h1>HiveDoctor Local Status</h1>
<p>Health: <span class="badge ${healthClass}">${escapeHtml(status.health)}</span></p>
<p class="muted">As of ${escapeHtml(status.asOf)}</p>
<h2>Latest Escalation</h2>
${escalationSection}
<h2>Suggested Commands</h2>
<ul>${commandList}</ul>
<hr>
<p class="muted">
  This page is served by HiveDoctor on 127.0.0.1 only.
  For machine-readable data: <a href="/status.json">/status.json</a>
</p>
</body>
</html>`;
}

/** Minimal HTML entity escaping (prevents injection in the local page). */
function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ── Request handler ───────────────────────────────────────────────────────────

function buildStatus(state: StatusPageStateProvider, now: () => number): StatusJson {
	const health = state.health();
	const escalation = state.escalation();
	return {
		health,
		escalation,
		suggestedCommands: buildSuggestedCommands(health, escalation),
		asOf: new Date(now()).toISOString(),
	};
}

function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	state: StatusPageStateProvider,
	now: () => number,
): void {
	const path = req.url ?? "/";

	if (path === "/status.json") {
		const status = buildStatus(state, now);
		const body = JSON.stringify(status, null, 2);
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		});
		res.end(body);
		return;
	}

	if (path === "/" || path === "") {
		const status = buildStatus(state, now);
		const body = buildHtml(status);
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(body);
		return;
	}

	// 404 for anything else.
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "not found", paths: ["/", "/status.json"] }));
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Build the status page server. Does not bind until start() is called. */
export function createStatusPageServer(options: StatusPageServerOptions): StatusPageServer {
	const { state, logger } = options;
	const now = options.now ?? Date.now;

	let server: Server | null = null;
	let listeningPort: number | undefined = undefined;

	const handle: StatusPageServer = {
		start(): void {
			if (server !== null) {
				// Already listening (or in the process of binding); no-op.
				return;
			}

			const s = createServer((req, res) => {
				try {
					handleRequest(req, res, state, now);
				} catch (error) {
					// A handler error must not crash the server; return 500 defensively.
					try {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "internal error" }));
					} catch {
						// Socket already gone; nothing to do.
					}
					logger.error("status-page.handler_error", {
						reason: error instanceof Error ? error.message : "unknown",
					});
				}
			});

			s.on("error", (error) => {
				// Bind errors (EADDRINUSE, EACCES) arrive here. Swallow + log; never crash.
				logger.warn("status-page.bind_failed", {
					port: options.port,
					reason: error instanceof Error ? error.message : "unknown",
				});
				server = null;
				listeningPort = undefined;
			});

			s.listen(options.port, LOOPBACK, () => {
				const addr = s.address();
				listeningPort = typeof addr === "object" && addr !== null ? addr.port : options.port;
				logger.info("status-page.listening", { port: listeningPort });
			});

			server = s;
		},

		stop(): void {
			if (server === null) return;
			const s = server;
			server = null;
			listeningPort = undefined;
			s.close((error) => {
				if (error !== undefined) {
					logger.warn("status-page.close_error", {
						reason: error instanceof Error ? error.message : "unknown",
					});
				}
			});
		},

		get listeningPort(): number | undefined {
			return listeningPort;
		},
	};

	return handle;
}
