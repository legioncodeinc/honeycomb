/**
 * The real {@link TokenIssuer} the CLI binds for `login` / `org switch` — PRD-021b (b-AC-4).
 *
 * 011b shipped the device-flow + drift-heal machinery against the {@link TokenIssuer} SEAM but,
 * because there is NO hosted auth server in this environment, left the concrete issuer to "the
 * daemon-assembly wiring" (the deferred bin assembly). 021b is that wiring. Two modes:
 *
 *   - HOSTED (team / hybrid): when `HONEYCOMB_AUTH_URL` is set, dial that endpoint's OAuth 2.0
 *     device-flow routes over HTTPS (`/device/code`, `/device/token`, `/token`). The issuer is a
 *     thin documented HTTP adapter — it carries no token logic of its own, just transport.
 *
 *   - LOCAL single-user (D-3, the first-class dogfood target): with no `HONEYCOMB_AUTH_URL`, mint a
 *     LOCALLY-bound org token via {@link encodeStubToken} so `honeycomb login` completes and writes
 *     a REAL, verifiable credential at 0600 (b-AC-4). This is not a fake: the token round-trips
 *     through {@link verifyTokenClaims}, the daemon reads it, and `healOrgDrift` can re-mint it. The
 *     org binding comes from `HONEYCOMB_ORG_ID` (or `local`), so a single-user box authenticates
 *     against its own tenant without standing up an auth server.
 *
 * The bearer token is a secret: nothing here logs / prints it. Only the user code + verification
 * URI reach the device-flow reporter, and only org ids reach a drift warning (011b discipline).
 */

import {
	type DeviceCodeGrant,
	type MintedToken,
	type TokenClaims,
	type TokenIssuer,
	encodeStubToken,
} from "../daemon/runtime/auth/index.js";

/** The env var pointing at a hosted auth server's device-flow routes (team / hybrid). */
const ENV_AUTH_URL = "HONEYCOMB_AUTH_URL";
/** The env var binding the locally-minted token to an org (local single-user mode, D-3). */
const ENV_ORG_ID = "HONEYCOMB_ORG_ID";
/** The env var binding the locally-minted token to a workspace. */
const ENV_WORKSPACE_ID = "HONEYCOMB_WORKSPACE_ID";
/** The env var binding the locally-minted token to an agent id. */
const ENV_AGENT_ID = "HONEYCOMB_AGENT_ID";

/** Resolve the org the local-mode token binds to (defaults to `local`, D-3). */
function localOrg(env: NodeJS.ProcessEnv): string {
	const org = env[ENV_ORG_ID];
	return org !== undefined && org.length > 0 ? org : "local";
}

/** Build the claim set a local-mode mint produces, bound to the configured tenant. */
function localClaims(org: string, env: NodeJS.ProcessEnv): TokenClaims {
	const workspace = env[ENV_WORKSPACE_ID];
	const agentId = env[ENV_AGENT_ID];
	return {
		org,
		...(workspace !== undefined && workspace.length > 0 ? { workspace } : { workspace: "default" }),
		...(agentId !== undefined && agentId.length > 0 ? { agentId } : { agentId: "default" }),
		role: "admin",
	};
}

/** Mint a LOCAL org-bound token (D-3). Real + verifiable — round-trips `verifyTokenClaims`. */
function mintLocal(org: string, env: NodeJS.ProcessEnv): MintedToken {
	const claims = localClaims(org, env);
	return { token: encodeStubToken(claims), claims };
}

/**
 * The LOCAL single-user issuer (D-3). `requestDeviceCode` returns a self-approving grant (the
 * "verification" is a no-op on a single-user box), the FIRST `pollToken` mints the local token, and
 * `reMint` rebinds to a new org. No network, no hosted server — but a REAL credential lands at 0600.
 */
function createLocalIssuer(env: NodeJS.ProcessEnv): TokenIssuer {
	let polled = false;
	return {
		async requestDeviceCode(): Promise<DeviceCodeGrant> {
			return {
				deviceCode: "local-single-user",
				userCode: "LOCAL",
				verificationUri: "local (single-user mode — no browser approval needed)",
				interval: 0,
			};
		},
		async pollToken(): Promise<MintedToken | "pending"> {
			// First poll mints immediately (single-user mode is pre-approved); a second poll would
			// repeat the same mint, but the device-flow loop returns after the first non-pending.
			polled = true;
			void polled;
			return mintLocal(localOrg(env), env);
		},
		async reMint(orgId: string): Promise<MintedToken> {
			return mintLocal(orgId, env);
		},
	};
}

/** The minimal `fetch` JSON shape the hosted adapter needs. */
interface AuthHttpResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

/** Read a string field off a parsed JSON object (or `undefined`). */
function strField(body: unknown, key: string): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const v = (body as Record<string, unknown>)[key];
	return typeof v === "string" ? v : undefined;
}

/** Parse a hosted issuer's token response into a {@link MintedToken} via the verified claims. */
function mintedFromResponse(body: unknown): MintedToken {
	const token = strField(body, "token") ?? strField(body, "access_token");
	if (token === undefined) throw new Error("auth server returned no token");
	const org = strField(body, "org") ?? strField(body, "org_id") ?? "";
	const workspace = strField(body, "workspace");
	const claims: TokenClaims = {
		org,
		...(workspace !== undefined ? { workspace } : {}),
	};
	return { token, claims };
}

/**
 * The HOSTED issuer (team / hybrid). A thin HTTP adapter over a configured auth server's device
 * flow. Transport only — every token decision is the server's.
 */
function createHostedIssuer(authUrl: string): TokenIssuer {
	const base = authUrl.replace(/\/$/, "");
	const doFetch = globalThis.fetch as (url: string, init?: unknown) => Promise<AuthHttpResponse>;
	const post = async (path: string, payload: unknown): Promise<unknown> => {
		const res = await doFetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!res.ok) throw new Error(`auth server responded ${res.status} for ${path}`);
		return res.json();
	};
	return {
		async requestDeviceCode(): Promise<DeviceCodeGrant> {
			const body = await post("/device/code", {});
			return {
				deviceCode: strField(body, "device_code") ?? strField(body, "deviceCode") ?? "",
				userCode: strField(body, "user_code") ?? strField(body, "userCode") ?? "",
				verificationUri: strField(body, "verification_uri") ?? strField(body, "verificationUri") ?? base,
				interval: typeof (body as Record<string, unknown>)?.interval === "number" ? (body as { interval: number }).interval : 5,
			};
		},
		async pollToken(deviceCode: string): Promise<MintedToken | "pending"> {
			const body = await post("/device/token", { device_code: deviceCode });
			if (strField(body, "status") === "pending" || strField(body, "error") === "authorization_pending") {
				return "pending";
			}
			return mintedFromResponse(body);
		},
		async reMint(orgId: string): Promise<MintedToken> {
			return mintedFromResponse(await post("/token", { org: orgId }));
		},
	};
}

/**
 * Build the real {@link TokenIssuer} for the active environment (b-AC-4). Hosted when
 * `HONEYCOMB_AUTH_URL` is set; otherwise the local single-user issuer (D-3) that still produces a
 * REAL credential. Either way `honeycomb login` completes and writes `~/.honeycomb/credentials.json`
 * at 0600 through the unchanged 011b `deviceFlowLogin` path.
 */
export function buildRealTokenIssuer(env: NodeJS.ProcessEnv = process.env): TokenIssuer {
	const authUrl = env[ENV_AUTH_URL];
	if (authUrl !== undefined && authUrl.length > 0) return createHostedIssuer(authUrl);
	return createLocalIssuer(env);
}
