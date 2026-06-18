/**
 * The DEFERRED-ASSEMBLY transport adapter — the ONE thing the composition slice
 * authors. Everything else in the slice is a REAL product surface.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * `src/hooks/shared/contracts.ts` defines {@link DaemonHookClient} as "the ONLY
 * path out to the daemon" and documents that the REAL impl (Wave 2 / deferred
 * assembly) POSTs over loopback to `127.0.0.1:3850` stamping the runtime-path +
 * session + actor headers. That production impl was never built — runtime
 * ASSEMBLY was deferred behind the seam across the 001–020 build, and every
 * surface was proven against a *fake of its neighbor* (`createFakeDaemonHookClient`
 * on the hook side, a hand-rolled `body()` on the daemon side). NOTHING yet proved
 * the real surfaces COMPOSE.
 *
 * This adapter is that missing transport glue, written HERE in the test (per the
 * composition rule: supply the tiny missing adapter in the test, never patch
 * product code to make it pass). Instead of opening a real socket it dispatches
 * IN-PROCESS via `daemon.app.request(...)` — the exact same in-process exercise
 * posture the daemon's own suites and the live itests use (`server.ts` header:
 * "the app is exercised in-process via `app.request(...)` — no socket is bound in
 * tests"). So the wire is real (a Hono request through the real middleware stack +
 * real handler), only the socket is elided.
 *
 * ── WHAT IT STAMPS (the 019b→daemon contract) ────────────────────────────────
 *   - `x-honeycomb-runtime-path`: `req.runtimePath` (`legacy` for Claude Code hook
 *      scripts) → the real runtime-path middleware claims the session on it and
 *      enforces one-path-per-session (the 409 the slice asserts end-to-end).
 *   - `x-honeycomb-session`: `req.meta.sessionId` → the runtime-path claim key.
 *   - `x-honeycomb-org` / `x-honeycomb-workspace`: the resolved tenancy.
 *
 * ── THE TENANCY INJECTION (an honest deferred-assembly responsibility) ───────
 * The hook-side {@link HookSessionMeta} carries NO org/workspace — the shim is
 * tenancy-agnostic by construction. The daemon's capture boundary
 * (`CaptureMetadataSchema`) REQUIRES `org` + `workspace` (no unscoped capture).
 * In production the device-flow credential resolves the tenancy; the real
 * transport client is exactly where that resolved tenancy is stamped onto BOTH
 * the headers AND the request metadata before the POST. This adapter does the
 * same: it merges `{ org, workspace }` into `body.metadata`. This is glue the
 * deferred transport step always owned — NOT a contract mismatch in the shim or
 * the handler (see the report's "contract" note).
 */

import type {
	DaemonHookClient,
	DaemonHookRequest,
	DaemonHookResponse,
} from "../../src/hooks/shared/index.js";
import type { Daemon } from "../../src/daemon/runtime/server.js";

/** The tenancy the deferred transport resolves (from the credential in prod). */
export interface DaemonHookClientTenancy {
	/** The resolved org → `x-honeycomb-org` + `metadata.org`. */
	readonly org: string;
	/** The resolved workspace → `x-honeycomb-workspace` + `metadata.workspace`. */
	readonly workspace: string;
}

/**
 * Build the real {@link DaemonHookClient} for the composition slice. Dispatches
 * each hook event to `/api/hooks/<endpoint>` through the in-process daemon app,
 * stamping the runtime-path + session + tenancy headers and merging the resolved
 * tenancy into the request metadata (the deferred-assembly responsibility above).
 *
 * Returns the parsed JSON body + the HTTP status as a {@link DaemonHookResponse},
 * so the shared `runCapture` core sees the real `201` (capture) / `409`
 * (runtime-path conflict) the daemon returns — driving the SAME branches the
 * production transport would.
 */
export function createDaemonHookClient(daemon: Daemon, tenancy: DaemonHookClientTenancy): DaemonHookClient {
	return {
		async send(req: DaemonHookRequest): Promise<DaemonHookResponse> {
			const headers: Record<string, string> = {
				"content-type": "application/json",
				"x-honeycomb-runtime-path": req.runtimePath,
				"x-honeycomb-session": req.meta.sessionId,
				"x-honeycomb-org": tenancy.org,
				"x-honeycomb-workspace": tenancy.workspace,
			};
			const body = withTenancy(req.body, tenancy);
			const res = await daemon.app.request(`/api/hooks/${req.endpoint}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			return { status: res.status, body: await parseJson(res) };
		},
	};
}

/**
 * Merge the resolved tenancy into the capture body's `metadata` (the deferred
 * transport's job). `buildCaptureBody` produced `{ event, metadata }`; we add
 * `org`/`workspace` onto `metadata` so the daemon's `CaptureMetadataSchema`
 * boundary validates. Returns a shallow copy — the input is never mutated.
 */
function withTenancy(body: unknown, tenancy: DaemonHookClientTenancy): unknown {
	if (body === null || typeof body !== "object") return body;
	const record = body as Record<string, unknown>;
	const metadata =
		record.metadata !== null && typeof record.metadata === "object"
			? (record.metadata as Record<string, unknown>)
			: {};
	return {
		...record,
		metadata: { ...metadata, org: tenancy.org, workspace: tenancy.workspace },
	};
}

/** Parse a Hono `Response` body as JSON, tolerating an empty body. */
async function parseJson(res: Response): Promise<unknown> {
	const text = await res.text();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
