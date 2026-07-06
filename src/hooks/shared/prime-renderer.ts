/**
 * Production session-start prime renderer — PRD-046d (d-AC-1..5).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * The 046c digest (`GET /api/memories/prime`) is only useful if it reaches the agent
 * at session start. This renderer is the THIN delivery seam: ONCE per session
 * (session-start calls it; per-turn capture never does — d-AC-3) it fetches the
 * already-bounded digest over loopback and hands back the `digest` text verbatim. The
 * shim threads that text into the SAME `additionalContext` channel the context renderer
 * uses, so BOTH Claude Code and Cursor inject it through their native session-start
 * surface (d-AC-1 / d-AC-2) — the shared `runtime.ts` wires it for every hooks host, so
 * there is no per-harness fork.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT — it imports NOTHING from `daemon/storage` and builds
 * NO SQL. The ONLY outbound path is a `fetch` over loopback to `127.0.0.1:3850`. The hook
 * does NO assembly (d-AC-5): the digest the daemon returns is already token-bounded and
 * PII-redacted (046b/c); this seam injects it as-is.
 *
 * ── THE SESSION-GROUP HEADERS (why a bare GET 400s) ─────────────────────────
 * `/api/memories/prime` lives under the `/api/memories` SESSION group, which sits behind
 * the runtime-path middleware: a request MUST carry `x-honeycomb-runtime-path`
 * (`plugin`/`legacy`) AND a non-empty `x-honeycomb-session`, or it is rejected 400/409
 * BEFORE the handler runs. Tenancy (`x-honeycomb-org` (+ `x-honeycomb-workspace`)) scopes
 * the digest to the repo/agent partition (fail-closed 400 with no org outside local mode).
 * So this client stamps ALL of them from the resolved credential, mirroring the
 * `daemon-client.ts` POST stamp. The runtime path comes from the active harness so a
 * legacy Codex/Claude session-start prime does not claim the session as `plugin` before
 * later capture posts.
 *
 * ── FAIL-SOFT, NEVER A THROW (d-AC-4) ───────────────────────────────────────
 * ANY failure resolves to `""` (no injection), never a throw: an unreachable/timed-out
 * daemon, a non-200 status, a malformed body, OR an honest cold-repo `{ empty: true }`.
 * The fetch is bounded by a short timeout (a slow daemon must not stall session start)
 * and aborted on expiry. A `""` return makes session-start omit the prime block entirely
 * — the session starts normally with no error and no banner.
 */

import { DAEMON_HOST, DAEMON_PORT } from "../../shared/constants.js";
import type { CredentialReader, HookCredential, PrimeRenderer, PrimeRenderRequest } from "./contracts.js";

/** The daemon route the renderer GETs (046c). */
export const PRIME_PATH = "/api/memories/prime" as const;

/**
 * The default fetch timeout (ms) — a slow daemon must not stall session start (d-AC-4), but the
 * prime skim itself runs TWO SQL SELECTs over DeepLake (episodic `memory` + durable `memories`)
 * which measure ~1-2s warm and can exceed 2s cold. The original 2s budget raced the computation
 * and lost intermittently, so the prime silently degraded to "" (no injection). 5s gives warm +
 * cold prime computations comfortable headroom while still bounding a genuinely-hung daemon.
 */
export const DEFAULT_PRIME_TIMEOUT_MS = 5_000;

/** The `default` workspace sentinel when the credential carries no workspace (mirrors the daemon-client). */
const DEFAULT_WORKSPACE = "default" as const;

/** Options for {@link createPrimeRenderer}. All optional with production defaults. */
export interface PrimeRendererOptions {
	/**
	 * The credential reader the renderer resolves tenancy through (the SAME identity the
	 * CLI + daemon use). When the read returns `undefined` (signed out), the prime is sent
	 * UNSCOPED — the daemon fail-closes it (no org → 400) and the renderer degrades to "".
	 */
	readonly credentials: CredentialReader;
	/** The daemon host. Defaults to the loopback constant (`127.0.0.1`). */
	readonly host?: string;
	/** The daemon port. Defaults to the loopback constant (`3850`). */
	readonly port?: number;
	/**
	 * The `fetch` implementation. Defaults to the global `fetch`. Injected so a unit test
	 * drives the request + the degrade paths against a recording stub without a real socket.
	 */
	readonly fetch?: typeof fetch;
	/** The fetch timeout in ms. Defaults to {@link DEFAULT_PRIME_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

/**
 * Build the production {@link PrimeRenderer} (d-AC-1..5). GETs `/api/memories/prime` over
 * loopback, stamping the runtime-path + session + tenancy headers, and returns the
 * response's `digest` text. READ-ONLY + FAIL-SOFT: any error / non-200 / malformed body /
 * cold-repo `{ empty: true }` resolves to `""` (no injection), never a throw (d-AC-4). The
 * fetch is bounded by `timeoutMs` and aborted on expiry so a slow daemon never stalls
 * session start.
 */
export function createPrimeRenderer(options: PrimeRendererOptions): PrimeRenderer {
	const host = options.host ?? DAEMON_HOST;
	const port = options.port ?? DAEMON_PORT;
	const doFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PRIME_TIMEOUT_MS;
	const url = `http://${host}:${port}${PRIME_PATH}`;

	return {
		async render(req: PrimeRenderRequest): Promise<string> {
			const tenancy = resolveTenancy(req.credential);
			const headers: Record<string, string> = {
				// The session group requires BOTH of these (runtime-path middleware), or 400.
				"x-honeycomb-runtime-path": req.runtimePath ?? "plugin",
				"x-honeycomb-session": req.meta.sessionId,
			};
			// Tenancy scopes the digest to the repo/agent partition (fail-closed without org).
			if (tenancy.org !== undefined) headers["x-honeycomb-org"] = tenancy.org;
			if (tenancy.workspace !== undefined) headers["x-honeycomb-workspace"] = tenancy.workspace;
			if (tenancy.actor !== undefined) headers["x-honeycomb-actor"] = tenancy.actor;

			// Bound the fetch: a slow daemon must not stall session start (d-AC-4). The signal
			// is aborted on timeout so the await rejects and the catch degrades to "".
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await doFetch(url, { method: "GET", headers, signal: controller.signal });
				if (res.status !== 200) return "";
				return coerceDigest(await parseJson(res));
			} catch {
				// Unreachable / refused / timed-out / aborted → no injection, no throw (d-AC-4).
				return "";
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** The tenancy a credential resolves to (org + workspace + optional actor). Mirrors the daemon-client. */
interface ResolvedTenancy {
	readonly org?: string;
	readonly workspace?: string;
	readonly actor?: string;
}

/**
 * Resolve the tenancy from the credential. A logged-in credential always scopes to a
 * workspace (its own, or the `default` sentinel); a signed-out (`undefined`) credential
 * resolves to the unscoped tenancy, which the daemon fail-closes — the renderer then
 * degrades to "" (d-AC-4). Mirrors `daemon-client.ts#resolveTenancy`.
 */
function resolveTenancy(cred: HookCredential | undefined): ResolvedTenancy {
	if (cred === undefined) return {};
	return {
		...(cred.org !== undefined ? { org: cred.org } : {}),
		workspace: cred.org !== undefined ? (cred.workspace ?? DEFAULT_WORKSPACE) : undefined,
		...(cred.actor !== undefined ? { actor: cred.actor } : {}),
	};
}

/**
 * Coerce a prime response body to its injectable `digest` text. The 046c contract is
 * `{ digest: string, empty: boolean, … }`; a cold repo answers `{ empty: true }` with the
 * honest "no memory yet" digest — we treat `empty: true` as NO injection (d-AC-4) so a
 * cold scope contributes nothing rather than a placeholder banner. A non-string `digest`
 * or an unknown body shape yields "".
 */
function coerceDigest(body: unknown): string {
	if (body === null || typeof body !== "object") return "";
	const rec = body as Record<string, unknown>;
	// A cold scope (empty:true) injects nothing — the session starts clean (d-AC-4).
	if (rec.empty === true) return "";
	return typeof rec.digest === "string" ? rec.digest : "";
}

/** Parse a `fetch` `Response` body as JSON, tolerating an empty/non-JSON body (→ undefined). */
async function parseJson(res: Response): Promise<unknown> {
	const text = await res.text();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
