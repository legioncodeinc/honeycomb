/**
 * The "First time setup" on-page login route — PRD-050c (c-AC-3 .. c-AC-6).
 *
 * `POST /setup/login` is the button handler the pre-auth setup shell (050b) calls. It BEGINS the
 * DeepLake device flow — carrying the dual referral-attribution headers on the device-code request
 * (`X-Honeycomb-Referrer` + `X-Hivemind-Referrer`, PRD-050c) — and returns the `user_code` +
 * verification URIs for the dashboard to RENDER ON THE PAGE, while the validated
 * `verification_uri_complete` opens in a browser tab so a new user lands on DeepLake's
 * login-or-create-account page. The flow then keeps polling in the background; on approval it mints +
 * persists the SHARED `~/.deeplake/credentials.json` (0600) through the EXISTING `persistFromToken`
 * path (via {@link loginWithDeviceFlow}) — unchanged except for the added attribution headers.
 *
 * ── LOCAL-MODE ONLY (mirrors `mountDashboardHost`) ───────────────────────────
 * This route sits beside the dashboard host on the UNPROTECTED root group, so the composition root
 * (`assemble.ts`) fires it LOCAL-MODE ONLY — exactly the same gate the viewable `/dashboard` host
 * gets (security F-1: a single loopback tenant, the permission middleware open by design). In
 * team/hybrid the route is never mounted and falls through to the root scaffold.
 *
 * ── The token is a SECRET (c-AC-4) ───────────────────────────────────────────
 * The response body carries ONLY `user_code` + the verification URIs — NEVER the device/bearer token,
 * and never the `device_code` poll handle. The device flow's reporter sink is swallowed here so no
 * token-adjacent line is logged; the structured `onGrant` hook hands the route the user-code-bearing
 * grant fields only. The browser open + the https-only scheme gate live inside
 * {@link loginWithDeviceFlow} (`validateVerificationUrl` / `defaultBrowserOpener`), unchanged.
 */

import type { Context } from "hono";

import {
	type DeviceCodeResponse,
	type DeviceFlowLoginDeps,
	loginWithDeviceFlow,
} from "../auth/index.js";
import type { Daemon } from "../server.js";

/** The loopback route the "First time setup" button POSTs to (PRD-050c / 050b host group). */
export const SETUP_LOGIN_PATH = "/setup/login" as const;

/** The root route group the setup-login route attaches to (already mounted, UNPROTECTED, in `server.ts`). */
export const SETUP_LOGIN_GROUP = "/" as const;

/**
 * The on-page render payload (PRD-050c c-AC-3). Carries the `user_code` to display + the verification
 * URIs — and NOTHING token-shaped: no bearer/device token, no `device_code`. `verification_uri_complete`
 * is present only when the server-derived URL passed the https-only scheme gate.
 */
export interface SetupLoginResponse {
	/** The short code the user reads off the page and enters at the verification URI. */
	readonly user_code: string;
	/** The base verification URI the user opens to enter the code. */
	readonly verification_uri: string;
	/** The pre-filled completion URI (https-only validated) — present only when it is safe to open. */
	readonly verification_uri_complete?: string;
}

/** Options for {@link mountSetupLogin}. */
export interface MountSetupLoginOptions {
	/**
	 * The device-flow runner — defaults to the real {@link loginWithDeviceFlow}. A test injects a fake
	 * that fires `onGrant` with a canned grant and resolves the persist, so the route is exercised with
	 * no real network/browser. Kept as a seam (not a hard call) for exactly that deterministic test.
	 */
	readonly runDeviceFlow?: (deps: DeviceFlowLoginDeps) => Promise<unknown>;
	/**
	 * Override the credentials/onboarding dir (tests point this at a temp HOME). Threaded straight into
	 * the device-flow deps so the persist + the onboarding-`ref` lookup never touch the real `~/.deeplake`.
	 */
	readonly dir?: string;
}

/** A non-empty trimmed string body value, or `undefined` (used for the optional `ref` override). */
function pickRef(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Re-validate `verification_uri_complete` to an https-only URL before echoing it to the browser (c-AC-4).
 * `loginWithDeviceFlow` fires `onGrant` BEFORE its own `validateVerificationUrl` runs, so the raw
 * device-code value reaches this handler unchecked — a `javascript:`/`http:`/malformed value would
 * otherwise render as a clickable link on the setup page. Returns the canonical https href, or
 * `undefined` (omit the field) for anything that is not a parseable https URL.
 */
function safeVerificationUriComplete(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}

/** Read + JSON-parse the POST body, tolerating an absent/empty/non-JSON body (the button may send none). */
async function readBody(c: Context): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await c.req.json();
		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	} catch {
		// No body / not JSON → an empty bag (the default ref then applies — c-AC-1).
		return {};
	}
}

/**
 * Attach the `POST /setup/login` route onto the daemon's already-mounted root group. Call ONCE after
 * `createDaemon(...)`; the composition root fires it LOCAL-MODE ONLY (mirroring `mountDashboardHost`).
 * If the root group is not mounted the attach is a no-op.
 *
 * The handler begins the device flow (returning the `user_code` + URIs the moment the grant arrives,
 * via the `onGrant` hook) and lets the flow keep polling → mint → persist in the background. The
 * response NEVER carries a token (c-AC-4). A device-code request failure surfaces as a clean 502 with
 * NO token/secret in the message.
 */
export function mountSetupLogin(daemon: Daemon, options: MountSetupLoginOptions = {}): void {
	const root = daemon.group(SETUP_LOGIN_GROUP);
	if (root === undefined) return;

	const runDeviceFlow = options.runDeviceFlow ?? loginWithDeviceFlow;

	root.post(SETUP_LOGIN_PATH, async (c) => {
		const body = await readBody(c);
		// An explicit `--ref` override rides in the body; absent it, the effective ref resolves inside
		// the device flow (onboarding.ref → DEFAULT_REF). `undefined` means "use the default" (c-AC-1);
		// an explicit empty string means "omit attribution" (c-AC-2) — both honored by resolveEffectiveRef.
		const ref = pickRef(body.ref);

		// The grant is captured via the structured `onGrant` hook so the response returns the moment the
		// device-code request resolves — without waiting for the (long) poll loop. The poll → mint →
		// persist continues in the background (auto-poll on render — PRD-050c open-question lean).
		let resolveGrant: (grant: DeviceCodeResponse) => void = () => {};
		let rejectGrant: (err: unknown) => void = () => {};
		const grantReady = new Promise<DeviceCodeResponse>((resolve, reject) => {
			resolveGrant = resolve;
			rejectGrant = reject;
		});

		const deps: DeviceFlowLoginDeps = {
			...(ref !== undefined ? { ref } : {}),
			...(options.dir !== undefined ? { dir: options.dir } : {}),
			// The reporter sink is SWALLOWED — no token-adjacent CLI line is logged for the on-page flow
			// (c-AC-4). The structured grant reaches the route via `onGrant`, not this string sink.
			reporter: { prompt: () => {} },
			onGrant: (grant) => resolveGrant(grant),
		};

		// Kick the flow off. We do NOT await the whole thing — only the grant. A failure BEFORE the grant
		// (e.g. the device-code request 4xx/5xx) rejects `grantReady`; a failure AFTER (poll timeout, mint)
		// is a background concern the page polls `/setup/state` (050b) for — it never blocks this response.
		void runDeviceFlow(deps).catch((err: unknown) => rejectGrant(err));

		let grant: DeviceCodeResponse;
		try {
			grant = await grantReady;
		} catch {
			// A redacted failure — the device-code request did not yield a grant. NO token/secret here.
			return c.json({ error: "device_flow_unavailable", reason: "could not begin the device flow" }, 502);
		}

		// Render-safe payload ONLY: user_code + the verification URIs. NEVER the device/bearer token. The
		// completion URI is re-validated to https-only here (onGrant fires before the flow's own gate), so
		// a non-https/javascript value never reaches the page as a clickable link.
		const verificationUriComplete = safeVerificationUriComplete(grant.verification_uri_complete);
		const payload: SetupLoginResponse = {
			user_code: grant.user_code,
			verification_uri: grant.verification_uri,
			...(verificationUriComplete !== undefined ? { verification_uri_complete: verificationUriComplete } : {}),
		};
		return c.json(payload);
	});
}
