/**
 * Production `DaemonHookClient` — PRD-021c Wave 2 (c-AC-1 / FR-1 / FR-9).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * `contracts.ts` defines {@link DaemonHookClient} as "the ONLY path out to the
 * daemon" and documents that the REAL impl POSTs over loopback to
 * `127.0.0.1:3850` stamping the runtime-path + session + actor headers. Across the
 * 001–020 build that production impl was deferred behind the seam; the composition
 * slice authored its in-process sibling (`tests/composition/daemon-hook-client.ts`,
 * dispatching via `app.request(...)`). THIS is the real-HTTP twin of that proven
 * adapter — same headers, same tenancy-into-body merge, only the transport differs
 * (a real `fetch` over the loopback socket instead of an in-process Hono request).
 *
 * ── THE TENANCY STAMP (the transport's job, c-AC-1) ─────────────────────────
 * The hook-side {@link HookSessionMeta} carries NO org/workspace — the shim is
 * tenancy-agnostic by construction (019c). The daemon's capture boundary REQUIRES
 * `org` + `workspace` (no unscoped capture). The composition-test finding pinned
 * this as the TRANSPORT's responsibility: the resolved tenancy is stamped onto BOTH
 * the `x-honeycomb-org`/`x-honeycomb-workspace` headers AND the request
 * `body.metadata` before the POST. In production the device-flow credential resolves
 * the tenancy, so this client reads it through the injected {@link CredentialReader}
 * (the SAME identity the CLI login wrote and the daemon reads — c-AC-2). A call with
 * no credential is sent UNSCOPED (the daemon fail-closes it); the hook never throws.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT. This module imports NOTHING from
 * `daemon/storage`; the only outbound path is `fetch`. It reaches the daemon
 * exclusively over loopback through the typed {@link DaemonHookRequest} seam.
 */

import { DAEMON_HOST, DAEMON_PORT } from "../../shared/constants.js";
import type {
	CredentialReader,
	DaemonHookClient,
	DaemonHookRequest,
	DaemonHookResponse,
	HookCredential,
} from "./contracts.js";

/** The `x-honeycomb-runtime-path` header (FR-1 / FR-8) — one active path per session. */
export const RUNTIME_PATH_HEADER = "x-honeycomb-runtime-path" as const;
/** The session-scope header the runtime-path middleware claims on (FR-1). */
export const SESSION_HEADER = "x-honeycomb-session" as const;
/** The tenancy org header the daemon's capture boundary requires. */
export const ORG_HEADER = "x-honeycomb-org" as const;
/** The tenancy workspace header the daemon's capture boundary requires. */
export const WORKSPACE_HEADER = "x-honeycomb-workspace" as const;
/** The actor header (the credential's actor label, when present). */
export const ACTOR_HEADER = "x-honeycomb-actor" as const;

/** The default `default` workspace sentinel when the credential carries no workspace. */
const DEFAULT_WORKSPACE = "default" as const;

/** Options for {@link createDaemonHookClient}. */
export interface DaemonHookClientOptions {
	/**
	 * The credential reader the transport resolves tenancy through (c-AC-2). The
	 * SAME `~/.honeycomb/credentials.json` identity the CLI + daemon use. When the
	 * read returns `undefined` (signed out), the call is sent UNSCOPED — the daemon
	 * fail-closes it; the hook stays fail-soft (FR-10).
	 */
	readonly credentials: CredentialReader;
	/** The daemon host. Defaults to the loopback constant (`127.0.0.1`). */
	readonly host?: string;
	/** The daemon port. Defaults to the loopback constant (`3850`). */
	readonly port?: number;
	/**
	 * The `fetch` implementation. Defaults to the global `fetch`. Injected so a unit
	 * test drives the request shape against a recording stub without a real socket.
	 */
	readonly fetch?: typeof fetch;
}

/** The tenancy a credential resolves to (org + workspace + optional actor). */
interface ResolvedTenancy {
	readonly org?: string;
	readonly workspace?: string;
	readonly actor?: string;
}

/**
 * Build the production {@link DaemonHookClient} (c-AC-1). POSTs each hook event to
 * `http://<host>:<port>/api/hooks/<endpoint>` over real loopback HTTP, stamping the
 * runtime-path + session + tenancy (+ actor) headers and merging the resolved
 * tenancy into the request `body.metadata` — IDENTICAL to the proven composition
 * adapter, only over `fetch` instead of an in-process dispatch.
 *
 * Returns the parsed JSON body + the HTTP status as a {@link DaemonHookResponse},
 * so the shared core sees the real `201` (capture) / `409` (runtime-path conflict)
 * the daemon returns and drives the SAME branches the composition tests exercise.
 * A transport-level failure (daemon down, refused socket) surfaces as a `0` status
 * with no body so the fail-soft core absorbs it rather than throwing out of a hook.
 */
export function createDaemonHookClient(options: DaemonHookClientOptions): DaemonHookClient {
	const host = options.host ?? DAEMON_HOST;
	const port = options.port ?? DAEMON_PORT;
	const doFetch = options.fetch ?? fetch;
	const base = `http://${host}:${port}/api/hooks`;

	return {
		async send(req: DaemonHookRequest): Promise<DaemonHookResponse> {
			const tenancy = await resolveTenancy(options.credentials);
			const headers: Record<string, string> = {
				"content-type": "application/json",
				[RUNTIME_PATH_HEADER]: req.runtimePath,
				[SESSION_HEADER]: req.meta.sessionId,
			};
			if (tenancy.org !== undefined) headers[ORG_HEADER] = tenancy.org;
			if (tenancy.workspace !== undefined) headers[WORKSPACE_HEADER] = tenancy.workspace;
			if (tenancy.actor !== undefined) headers[ACTOR_HEADER] = tenancy.actor;

			const body = withTenancy(req.body, tenancy);
			try {
				const res = await doFetch(`${base}/${req.endpoint}`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				});
				return { status: res.status, body: await parseJson(res) };
			} catch (err: unknown) {
				// A transport failure (daemon down / refused) is NOT a hook crash — surface a
				// `0` status with no body so the fail-soft core absorbs it (FR-10). The cause
				// rides on the stderr line so an operator can tell ECONNREFUSED from a timeout.
				const reason = err instanceof Error ? err.message : String(err);
				process.stderr.write(`honeycomb: hook capture transport failed (daemon unreachable): ${reason}\n`);
				return { status: 0 };
			}
		},
	};
}

/**
 * Resolve the tenancy from the credential (c-AC-2). The credential's `org` is the
 * tenancy org; the workspace is the credential's (the `default` sentinel resolves
 * server-side). Read failures (absent / malformed) resolve to the unscoped tenancy —
 * the read is itself fail-soft (it never throws), so the hook proceeds.
 */
async function resolveTenancy(reader: CredentialReader): Promise<ResolvedTenancy> {
	let cred: HookCredential | undefined;
	try {
		cred = await reader.read();
	} catch {
		cred = undefined;
	}
	if (cred === undefined) return {};
	return {
		...(cred.org !== undefined ? { org: cred.org } : {}),
		// A logged-in credential always scopes to a workspace: prefer the credential's
		// own workspace, falling back to the `default` sentinel so the body still validates.
		workspace: cred.org !== undefined ? (cred.workspace ?? DEFAULT_WORKSPACE) : undefined,
		...(cred.actor !== undefined ? { actor: cred.actor } : {}),
	};
}

/**
 * Merge the resolved tenancy into the capture body's `metadata` (the deferred
 * transport's job, mirroring the composition adapter). `buildCaptureBody` produced
 * `{ event, metadata }`; we add `org`/`workspace` onto `metadata` so the daemon's
 * `CaptureMetadataSchema` boundary validates. Returns a shallow copy — the input is
 * never mutated. An unscoped tenancy adds nothing (the daemon fail-closes it).
 */
function withTenancy(body: unknown, tenancy: ResolvedTenancy): unknown {
	if (body === null || typeof body !== "object") return body;
	if (tenancy.org === undefined && tenancy.workspace === undefined) return body;
	const record = body as Record<string, unknown>;
	const metadata =
		record.metadata !== null && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {};
	return {
		...record,
		metadata: {
			...metadata,
			...(tenancy.org !== undefined ? { org: tenancy.org } : {}),
			...(tenancy.workspace !== undefined ? { workspace: tenancy.workspace } : {}),
		},
	};
}

/** Parse a `fetch` `Response` body as JSON, tolerating an empty/non-JSON body. */
async function parseJson(res: Response): Promise<unknown> {
	const text = await res.text();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
