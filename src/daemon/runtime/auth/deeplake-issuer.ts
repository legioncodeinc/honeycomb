/**
 * The REAL `api.deeplake.ai` auth client + device-flow login — PRD-023 Wave 2 (AC-1 / AC-2).
 *
 * This is the concrete adapter PRD-023 fills behind the auth seam: it speaks the SAME backend
 * Hivemind speaks (`api.deeplake.ai`), porting Hivemind's request/response shapes VERBATIM from
 * `hivemind/src/commands/auth.ts` so one login authenticates BOTH tools against one credential
 * (the shared `~/.deeplake/credentials.json`, D-1). The HTTP contract:
 *
 *   - `POST {apiUrl}/auth/device/code`   → `{ device_code, user_code, verification_uri,
 *                                            verification_uri_complete, expires_in, interval }`
 *   - `POST {apiUrl}/auth/device/token`  → `{ access_token, ... }`, or `400 {error:"authorization_pending"
 *                                            |"slow_down"|"expired_token"|"access_denied"}`
 *   - `POST {apiUrl}/users/me/tokens`    → mint a long-lived org-bound token `{ token: { token } }`
 *   - `GET  {apiUrl}/me`                 → `{ id, name, email? }` (whoami)
 *   - `GET  {apiUrl}/organizations`      → `[{ id, name }]`
 *   - `GET  {apiUrl}/workspaces`         → `{ data: [{ id, name }] }` or `[{ id, name }]`
 *
 * ── Two login paths (AC-1 / AC-2) ────────────────────────────────────────────
 *   - DEVICE FLOW (AC-1, default): request a device code, PRINT the user code + verification URI,
 *     OPEN the validated `verification_uri_complete` in a browser, poll `/auth/device/token` until a
 *     short-lived Auth0 token arrives, mint a long-lived org-bound token via `/users/me/tokens`,
 *     `GET /me` for identity, and persist the full Hivemind disk shape (0600).
 *   - HEADLESS (AC-2): a pre-issued long-lived token (`HONEYCOMB_TOKEN` / `--token`) skips the
 *     browser — validate it via `GET /me` and persist. Parity with Hivemind's `HIVEMIND_TOKEN`.
 *
 * ── The token is a SECRET (D-4) ──────────────────────────────────────────────
 * Nothing here logs, prints, echoes, or URL-embeds the bearer token. It rides ONLY in the
 * `Authorization: Bearer` header, never a query string or path; an HTTP error message carries the
 * status + a truncated body, never the token. The device-flow reporter receives the user code +
 * verification URI only. The browser opener REFUSES any non-`https:` `verification_uri_complete`
 * (the scheme is validated before any OS opener is invoked — ported from Hivemind's `openBrowser`).
 *
 * ── The seams are injectable so unit tests never hit the network or a browser ─
 *   - `fetch` is injected (`AuthFetch`) — tests pass a fake that replays canned device-flow /
 *     mint / `/me` responses; no real `api.deeplake.ai`.
 *   - `openBrowser` is injected (`BrowserOpener`) — tests pass a recorder that captures the URL it
 *     was handed (asserting a non-https URI is REJECTED, never opened), so no real browser launches.
 *   - `sleep` is injected so the poll cadence runs instantly under test.
 *
 * Daemon-side auth may import this; it touches `node:fs` (via the credentials store) + the network
 * only — it opens NO DeepLake connection, so the storage-import invariant holds.
 */

import { execFileSync } from "node:child_process";

import {
	type Clock,
	type DiskCredentials,
	DEFAULT_DEEPLAKE_API_URL,
	saveDiskCredentials,
	systemClock,
} from "./credentials-store.js";
import { DEFAULT_REF, loadOnboarding } from "../onboarding/index.js";
import { type EmitDeps, emitTelemetry } from "../telemetry/index.js";

// ────────────────────────────────────────────────────────────────────────────
// The injectable seams (fetch / browser-open / sleep / reporter).
// ────────────────────────────────────────────────────────────────────────────

/** The minimal `fetch` response shape the adapter reads (a subset of the DOM `Response`). */
export interface AuthFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

/** The injectable `fetch` the auth client issues every request through (the network seam). */
export type AuthFetch = (url: string, init?: AuthFetchRequestInit) => Promise<AuthFetchResponse>;

/** The request init the adapter passes (method + headers + JSON body). */
export interface AuthFetchRequestInit {
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly body?: string;
}

/**
 * The injectable browser opener (the browser seam). Returns `true` iff it opened the URL. The
 * production impl ({@link defaultBrowserOpener}) validates the scheme is `https:` BEFORE invoking any
 * OS opener and REFUSES anything else (D-4). A test injects a recorder so no real browser launches.
 */
export type BrowserOpener = (url: string) => boolean;

/** A sleeper so the poll cadence is injectable (a test passes a no-wait sleeper). */
export type Sleeper = (ms: number) => Promise<void>;

/** A sink for the user-facing device-flow prompts (user code + verification URI — never the token). */
export interface DeviceFlowReporter {
	prompt(line: string): void;
}

/** The real wall-clock sleeper. */
export const realSleeper: Sleeper = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────────────
// VERBATIM Hivemind wire shapes (ported from hivemind/src/commands/auth.ts).
// ────────────────────────────────────────────────────────────────────────────

/** `POST /auth/device/code` response (Hivemind shape, verbatim). */
export interface DeviceCodeResponse {
	readonly device_code: string;
	readonly user_code: string;
	readonly verification_uri: string;
	readonly verification_uri_complete: string;
	readonly expires_in: number;
	readonly interval: number;
}

/** `POST /auth/device/token` success response (Hivemind shape, verbatim). */
export interface DeviceTokenResponse {
	readonly access_token: string;
	readonly token_type?: string;
	readonly expires_in?: number;
}

/** `GET /me` response (Hivemind shape, verbatim). */
export interface MeResponse {
	readonly id: string;
	readonly name: string;
	readonly email?: string;
}

/** One org row from `GET /organizations`. */
export interface OrgRow {
	readonly id: string;
	readonly name: string;
}

/** One workspace row from `GET /workspaces`. */
export interface WorkspaceRow {
	readonly id: string;
	readonly name: string;
}

/** The `X-Deeplake-Client` header value — attributes traffic to honeycomb (parity with Hivemind). */
export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
/** The org-scoping header DeepLake reads. */
export const DEEPLAKE_ORG_HEADER = "X-Activeloop-Org-Id";
/** The honeycomb client-family value. */
export const DEEPLAKE_CLIENT_VALUE = "honeycomb";

/**
 * The referral-attribution header names carried on `POST /auth/device/code` ONLY (PRD-050c).
 *
 * Operator decision (do NOT re-litigate): we DUAL-SEND both headers, each carrying the SAME
 * effective ref — `X-Hivemind-Referrer` is recognized by the Activeloop backend TODAY (verbatim
 * port of Hivemind's `hivemindReferrerHeader`), and `X-Honeycomb-Referrer` is the new
 * Honeycomb-namespaced header that goes fully live once the backend ships recognition. Sending both
 * preserves attribution now AND future-proofs the migration with a single code path.
 */
export const HIVEMIND_REFERRER_HEADER = "X-Hivemind-Referrer";
/** The new Honeycomb-namespaced referral header (recognized once the backend ships it — PRD-050c). */
export const HONEYCOMB_REFERRER_HEADER = "X-Honeycomb-Referrer";

/**
 * Build the referral-attribution headers for the device-code request from an effective ref.
 *
 * Returns BOTH `X-Honeycomb-Referrer` and `X-Hivemind-Referrer` set to the TRIMMED ref when it is
 * non-empty after trimming; returns an EMPTY object (omitting both headers entirely) when the ref is
 * `undefined`, empty, or whitespace-only — the trim-and-omit parity Hivemind's `hivemindReferrerHeader`
 * enforces (an empty referrer is never sent, never attributed). This is the ONLY producer of these
 * headers; they ride on the device-code request and NOWHERE else (PRD-050c c-AC-6).
 */
export function referrerHeaders(ref?: string): Record<string, string> {
	const trimmed = (ref ?? "").trim();
	if (trimmed.length === 0) return {};
	return { [HONEYCOMB_REFERRER_HEADER]: trimmed, [HIVEMIND_REFERRER_HEADER]: trimmed };
}

/**
 * Resolve the EFFECTIVE referral code for a Honeycomb install (PRD-050c c-AC-1).
 *
 * Precedence: an explicit `ref` argument (the `--ref <code>` override) wins; else the machine-local
 * `onboarding.ref` ({@link loadOnboarding}); else the build-injected {@link DEFAULT_REF}
 * (`__HONEYCOMB_REF_DEFAULT__`, shipped `"mario"`). The result is TRIMMED. An explicitly-blank `--ref`
 * (empty/whitespace) resolves to `""` so {@link referrerHeaders} omits both headers — an operator can
 * deliberately opt OUT of attribution. The empty-string `explicit` is honored as an explicit override
 * (it short-circuits the onboarding/default fallback), matching the "explicit blank omits" contract.
 *
 * `dir` overrides the onboarding directory (tests point it at a temp HOME); it defaults to the real
 * `~/.deeplake`.
 */
export function resolveEffectiveRef(explicit?: string, dir?: string): string {
	if (explicit !== undefined) return explicit.trim();
	const fromOnboarding = loadOnboarding(dir).ref;
	if (fromOnboarding.trim().length > 0) return fromOnboarding.trim();
	return DEFAULT_REF.trim();
}

/** The env var carrying a pre-issued long-lived token for headless login (AC-2; HIVEMIND_TOKEN parity). */
export const ENV_HEADLESS_TOKEN = "HONEYCOMB_TOKEN";
/** The env var overriding the DeepLake API base URL (else {@link DEFAULT_DEEPLAKE_API_URL}). */
export const ENV_DEEPLAKE_ENDPOINT = "HONEYCOMB_DEEPLAKE_ENDPOINT";
/** The env var pinning the org the minted/headless token binds to (parity with HIVEMIND_ORG_ID). */
export const ENV_ORG_ID = "HONEYCOMB_ORG_ID";

/** Long-lived mint duration: one year in seconds (Hivemind's `/users/me/tokens` duration, verbatim). */
const MINT_DURATION_SECONDS = 365 * 24 * 3600;

// ────────────────────────────────────────────────────────────────────────────
// apiUrl resolution.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the DeepLake API base URL: `HONEYCOMB_DEEPLAKE_ENDPOINT` if set, else the canonical
 * {@link DEFAULT_DEEPLAKE_API_URL}. The trailing slash is stripped so path concatenation is clean.
 */
export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env[ENV_DEEPLAKE_ENDPOINT];
	const base = raw !== undefined && raw.length > 0 ? raw : DEFAULT_DEEPLAKE_API_URL;
	return base.replace(/\/+$/, "");
}

// ────────────────────────────────────────────────────────────────────────────
// The reusable auth client (Wave 3 consumes this: whoami / org / workspace).
// ────────────────────────────────────────────────────────────────────────────

/** A redacted HTTP failure: carries the status + a truncated body, NEVER the token (D-4). */
export class AuthHttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "AuthHttpError";
		this.status = status;
	}
}

/** Options for {@link createDeeplakeAuthClient} (all seams injectable for tests). */
export interface DeeplakeAuthClientOptions {
	/** The DeepLake API base URL (resolved via {@link resolveApiUrl} by the login flows). */
	readonly apiUrl?: string;
	/** The injectable `fetch` (defaults to the global `fetch`). */
	readonly fetch?: AuthFetch;
	/** The injectable poll sleeper (defaults to the real wall clock). */
	readonly sleep?: Sleeper;
	/** Max retries on a 429 / 5xx before giving up (the hardened-fetch posture). */
	readonly maxRetries?: number;
}

/** Default retry budget on 429 / 5xx — bounded so a flaky backend surfaces rather than hangs. */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * The reusable `api.deeplake.ai` auth client. Wave 3 (whoami / org list / workspace list & switch)
 * consumes THIS — it is the single typed surface over the auth backend. Every method:
 *   - sends the `Authorization: Bearer` header (the token NEVER reaches a URL or a log — D-4);
 *   - retries 429 / 5xx with backoff (the daemon's hardened-fetch posture);
 *   - throws a redacted {@link AuthHttpError} on a non-retryable failure.
 */
export interface DeeplakeAuthClient {
	/** The resolved API base URL (Wave 3 persists this as `apiUrl`). */
	readonly apiUrl: string;
	/** `GET /me` — the authenticated user (AC-3 whoami consumes this). */
	getMe(token: string, orgId?: string): Promise<MeResponse>;
	/** `GET /organizations` — the user's orgs (AC-4 `org list` consumes this). */
	listOrgs(token: string): Promise<OrgRow[]>;
	/** `GET /workspaces` — the org's workspaces (AC-5 `workspaces` consumes this). */
	listWorkspaces(token: string, orgId?: string): Promise<WorkspaceRow[]>;
	/** `POST /users/me/tokens` — mint a fresh long-lived token bound to `orgId` (AC-4 `org switch`). */
	reMint(token: string, orgId: string): Promise<string>;
	/**
	 * Begin the device-flow grant (`POST /auth/device/code`). The optional `extraHeaders` carry the
	 * referral-attribution headers ({@link referrerHeaders}) — spread onto THIS request only (PRD-050c
	 * c-AC-6); they NEVER reach `/me`, `/organizations`, the mint call, or any data-plane request.
	 */
	requestDeviceCode(extraHeaders?: Record<string, string>): Promise<DeviceCodeResponse>;
	/** Poll the device-flow grant; `"pending"` until approved, then the short-lived Auth0 token. */
	pollDeviceToken(deviceCode: string): Promise<DeviceTokenResponse | "pending">;
}

/** Build the JSON headers every authenticated request carries (token in the header ONLY — D-4). */
function authHeaders(token: string, orgId?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		[DEEPLAKE_CLIENT_HEADER]: DEEPLAKE_CLIENT_VALUE,
	};
	if (orgId !== undefined && orgId.length > 0) headers[DEEPLAKE_ORG_HEADER] = orgId;
	return headers;
}

/** True for a status the hardened-fetch posture retries (rate-limit / transient server error). */
function isRetryable(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Build the reusable {@link DeeplakeAuthClient}. The `fetch`, `sleep`, and retry budget are
 * injectable; the production defaults are the global `fetch`, the real wall clock, and
 * {@link DEFAULT_MAX_RETRIES}. The token NEVER reaches a URL or a log line here (D-4).
 */
export function createDeeplakeAuthClient(options: DeeplakeAuthClientOptions = {}): DeeplakeAuthClient {
	const apiUrl = (options.apiUrl ?? DEFAULT_DEEPLAKE_API_URL).replace(/\/+$/, "");
	const doFetch = options.fetch ?? (globalThis.fetch as unknown as AuthFetch);
	const sleep = options.sleep ?? realSleeper;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	/** Issue one request with 429/5xx retry + backoff; classify the outcome (token never in the URL). */
	async function request(path: string, init: AuthFetchRequestInit, expectJson: boolean): Promise<unknown> {
		let lastStatus = 0;
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			const resp = await doFetch(`${apiUrl}${path}`, init);
			if (resp.ok) {
				return expectJson ? await resp.json().catch(() => null) : null;
			}
			lastStatus = resp.status;
			if (isRetryable(resp.status) && attempt < maxRetries) {
				// Exponential-ish backoff: 250ms, 500ms, 1000ms. Bounded by maxRetries.
				await sleep(250 * 2 ** attempt);
				continue;
			}
			// A non-retryable failure: surface the status + a TRUNCATED body (never the token — D-4).
			const body = await resp.text().catch(() => "");
			throw new AuthHttpError(resp.status, `auth API ${resp.status} for ${path}: ${body.slice(0, 200)}`);
		}
		throw new AuthHttpError(lastStatus, `auth API ${lastStatus} for ${path} after ${maxRetries} retries`);
	}

	return {
		apiUrl,
		async getMe(token: string, orgId?: string): Promise<MeResponse> {
			const body = await request("/me", { method: "GET", headers: authHeaders(token, orgId) }, true);
			const me = body as Record<string, unknown> | null;
			const id = typeof me?.id === "string" ? me.id : "";
			const name = typeof me?.name === "string" ? me.name : "";
			const email = typeof me?.email === "string" ? me.email : undefined;
			return email !== undefined ? { id, name, email } : { id, name };
		},
		async listOrgs(token: string): Promise<OrgRow[]> {
			const body = await request("/organizations", { method: "GET", headers: authHeaders(token) }, true);
			return Array.isArray(body) ? (body as OrgRow[]) : [];
		},
		async listWorkspaces(token: string, orgId?: string): Promise<WorkspaceRow[]> {
			const body = await request("/workspaces", { method: "GET", headers: authHeaders(token, orgId) }, true);
			// Hivemind tolerates BOTH `{ data: [...] }` and a bare array — port that tolerance verbatim.
			const data = (body as { data?: WorkspaceRow[] } | null)?.data ?? body;
			return Array.isArray(data) ? (data as WorkspaceRow[]) : [];
		},
		async reMint(token: string, orgId: string): Promise<string> {
			// Per-mint unique name. DeepLake rejects a duplicate (user_id, name) with a misleading 500,
			// so the suffix is `Date.now()` (ms resolution) — verbatim Hivemind hazard mitigation.
			const name = `honeycomb-plugin-${Date.now()}`;
			const body = await request(
				"/users/me/tokens",
				{
					method: "POST",
					headers: authHeaders(token),
					body: JSON.stringify({ name, duration: MINT_DURATION_SECONDS, organization_id: orgId }),
				},
				true,
			);
			const minted = (body as { token?: { token?: unknown } } | null)?.token?.token;
			if (typeof minted !== "string" || minted.length === 0) {
				throw new AuthHttpError(0, "auth API minted no token");
			}
			return minted;
		},
		async requestDeviceCode(extraHeaders?: Record<string, string>): Promise<DeviceCodeResponse> {
			// The referral-attribution headers ({@link referrerHeaders}) ride ONLY here (PRD-050c c-AC-6).
			const body = await request(
				"/auth/device/code",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						[DEEPLAKE_CLIENT_HEADER]: DEEPLAKE_CLIENT_VALUE,
						...(extraHeaders ?? {}),
					},
				},
				true,
			);
			return body as DeviceCodeResponse;
		},
		async pollDeviceToken(deviceCode: string): Promise<DeviceTokenResponse | "pending"> {
			// Hivemind's poll: 200 → token; 400 + authorization_pending/slow_down → pending; other 400s
			// (expired_token / access_denied) → a clean throw. Ported verbatim. The device code rides in
			// the JSON body, NEVER the URL (D-4).
			const resp = await doFetch(`${apiUrl}/auth/device/token`, {
				method: "POST",
				headers: { "Content-Type": "application/json", [DEEPLAKE_CLIENT_HEADER]: DEEPLAKE_CLIENT_VALUE },
				body: JSON.stringify({ device_code: deviceCode }),
			});
			if (resp.ok) return (await resp.json()) as DeviceTokenResponse;
			if (resp.status === 400) {
				const err = (await resp.json().catch(() => null)) as { error?: string } | null;
				if (err?.error === "authorization_pending" || err?.error === "slow_down") return "pending";
				if (err?.error === "expired_token") throw new AuthHttpError(400, "device code expired — run login again");
				if (err?.error === "access_denied") throw new AuthHttpError(400, "authorization denied");
			}
			throw new AuthHttpError(resp.status, `device-token poll failed: HTTP ${resp.status}`);
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// The safe browser opener (ported verbatim from Hivemind's openBrowser — D-4).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Open `url` in the OS browser — but ONLY if it parses as an `https:` URL (D-4). The
 * `verification_uri_complete` is server-derived, hence untrusted: a non-`https:` scheme, or a
 * malformed URL, is REFUSED (returns `false`, never invokes an opener). On open it uses a fixed-argv
 * `execFileSync` (never a shell): `open` (darwin) / `rundll32 url.dll,FileProtocolHandler` (win32,
 * which avoids `cmd /c start` re-parsing `&`/`^`/`|`) / `xdg-open` (linux). Ported verbatim from
 * `hivemind/src/commands/auth.ts:openBrowser`.
 *
 * This is the PRODUCTION opener; unit tests inject a recorder instead so no real browser launches.
 */
export function defaultBrowserOpener(url: string): boolean {
	let safeUrl: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:") return false;
		safeUrl = parsed.href;
	} catch {
		return false;
	}
	try {
		if (process.platform === "darwin") {
			execFileSync("open", [safeUrl], { stdio: "ignore", timeout: 5000, windowsHide: true });
		} else if (process.platform === "win32") {
			// `windowsHide` suppresses the transient rundll32 console flash; the browser still opens.
			execFileSync("rundll32", ["url.dll,FileProtocolHandler", safeUrl], { stdio: "ignore", timeout: 5000, windowsHide: true });
		} else {
			execFileSync("xdg-open", [safeUrl], { stdio: "ignore", timeout: 5000, windowsHide: true });
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate that a server-derived verification URL is safe to open (the scheme gate, D-4). Returns the
 * normalized href when the URL parses AND its scheme is `https:`; `null` otherwise. {@link loginWithDeviceFlow}
 * calls this BEFORE handing the URL to the opener, so a non-https `verification_uri_complete` is never
 * opened even if a (misconfigured) opener would have tried.
 */
export function validateVerificationUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" ? parsed.href : null;
	} catch {
		return null;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// The login flows (AC-1 device flow, AC-2 headless) → write the shared file.
// ────────────────────────────────────────────────────────────────────────────

/** The shared deps every login flow runs against (all seams injectable for deterministic tests). */
export interface LoginDeps {
	/** Override the credentials dir (tests point this at a temp HOME). */
	readonly dir?: string;
	/** The clock that stamps `savedAt` server-side (b-AC-4). */
	readonly clock?: Clock;
	/** The injectable env (defaults to `process.env`) — resolves apiUrl + org pin. */
	readonly env?: NodeJS.ProcessEnv;
	/** The injectable `fetch` (defaults to the global `fetch`). */
	readonly fetch?: AuthFetch;
	/** The injectable poll sleeper (defaults to the real wall clock). */
	readonly sleep?: Sleeper;
}

/** Extra deps for the device flow: the reporter + the browser opener (both injectable). */
export interface DeviceFlowLoginDeps extends LoginDeps {
	/** The user-facing prompt sink (defaults to `console.log`). NEVER receives the token. */
	readonly reporter?: DeviceFlowReporter;
	/** The browser opener (defaults to {@link defaultBrowserOpener}). Tests inject a recorder. */
	readonly openBrowser?: BrowserOpener;
	/** A safety cap on poll attempts so a never-approving grant cannot loop forever. */
	readonly maxPolls?: number;
	/**
	 * The referral code attributed on the device-code request (PRD-050c). An explicit value (the
	 * `--ref <code>` override) wins; absent it, the effective ref resolves from `onboarding.ref` then
	 * the build-injected {@link DEFAULT_REF} (`"mario"`) — see {@link resolveEffectiveRef}. An
	 * explicitly-blank ref (empty/whitespace) OMITS both attribution headers (trim-and-omit parity).
	 */
	readonly ref?: string;
	/**
	 * A structured hook fired ONCE, right after the device-code grant is obtained and BEFORE the poll
	 * loop begins (PRD-050c c-AC-3). It carries the {@link DeviceCodeResponse} — `user_code` +
	 * verification URIs — so the `/setup/login` route can render the code on the page while the flow
	 * keeps polling. The grant carries NO bearer/device token in any field a UI displays (the
	 * `device_code` is the poll handle, never rendered/logged by the route — c-AC-4). This is the
	 * structured analogue of {@link DeviceFlowReporter}; the reporter still fires for CLI prompts.
	 */
	readonly onGrant?: (grant: DeviceCodeResponse) => void;
	/**
	 * Telemetry chokepoint seam (PRD-050e). The `honeycomb_first_link` event emits through here AFTER
	 * the credential is persisted (the first successful link), fire-and-forget — NEVER gating the login
	 * (e-AC-4). The onboarding `dir` is threaded automatically so the dedupe ledger + the persisted
	 * credential share one HOME under test. Omit in production — `emitTelemetry`'s defaults + the empty
	 * build key make it a no-op; a test injects `telemetry.fetch` to record/throw.
	 */
	readonly telemetry?: EmitDeps;
}

/** The default device-flow poll cap — bounded so a stuck flow surfaces rather than hangs. */
export const DEFAULT_MAX_POLLS = 900;

/**
 * Assemble the full Hivemind disk record from a long-lived token + the `/me` identity, then persist
 * it to the shared `~/.deeplake/credentials.json` (0600) via {@link saveDiskCredentials}. The org is
 * pinned by `HONEYCOMB_ORG_ID` when set, else the first org the account belongs to (Hivemind's
 * priority order, ported). The token NEVER reaches a log here (D-4).
 */
async function persistFromToken(
	client: DeeplakeAuthClient,
	token: string,
	deps: LoginDeps,
): Promise<DiskCredentials> {
	const env = deps.env ?? process.env;
	const clock = deps.clock ?? systemClock;

	// `GET /me` validates the token AND supplies the user display name (AC-2 / AC-3).
	const me = await client.getMe(token);
	const userName = me.name.length > 0 ? me.name : me.email ? me.email.split("@")[0] : "unknown";

	// Resolve the org the token is bound to: the env pin wins, else the account's first org.
	const orgs = await client.listOrgs(token);
	if (orgs.length === 0) throw new AuthHttpError(0, "no organizations found for this account");
	const pinned = env[ENV_ORG_ID];
	const chosen = (pinned !== undefined && pinned.length > 0 ? orgs.find((o) => o.id === pinned) : undefined) ?? orgs[0];

	const disk: DiskCredentials = {
		token,
		orgId: chosen.id,
		orgName: chosen.name,
		userName,
		workspaceId: "default",
		apiUrl: client.apiUrl,
		savedAt: "", // stamped server-side by saveDiskCredentials (b-AC-4).
	};
	return saveDiskCredentials(disk, deps.dir, clock);
}

/**
 * AC-1 — run the `api.deeplake.ai` device flow and persist the shared credential (0600).
 *
 * Flow (ported verbatim from Hivemind): `requestDeviceCode` → PRINT the user code + verification URI
 * → OPEN the VALIDATED `verification_uri_complete` (https-only; a non-https URI is refused, never
 * opened — D-4) → poll `/auth/device/token` on the grant's interval until a short-lived Auth0 token
 * arrives → mint a long-lived org-bound token (`/users/me/tokens`) → `GET /me` → write the full
 * Hivemind disk shape (`userName` + the authenticated `apiUrl`) to `~/.deeplake/credentials.json`.
 *
 * The bearer token is NEVER printed (only the user code + URI reach the reporter). Throws on a grant
 * that expires or a poll cap exhausted without approval; the CLI maps a throw to a redacted non-zero exit.
 */
export async function loginWithDeviceFlow(deps: DeviceFlowLoginDeps = {}): Promise<DiskCredentials> {
	const env = deps.env ?? process.env;
	const apiUrl = resolveApiUrl(env);
	const sleep = deps.sleep ?? realSleeper;
	const reporter = deps.reporter ?? { prompt: (line: string): void => console.log(line) };
	const opener = deps.openBrowser ?? defaultBrowserOpener;
	const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
	const client = createDeeplakeAuthClient({
		apiUrl,
		...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
		...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
	});

	// Resolve the effective referral code (explicit `--ref` > onboarding.ref > DEFAULT_REF) and build
	// the dual attribution headers. They ride ONLY on this device-code request (PRD-050c c-AC-6); a
	// blank effective ref omits both headers (trim-and-omit parity — c-AC-2).
	const effectiveRef = resolveEffectiveRef(deps.ref, deps.dir);
	const grant = await client.requestDeviceCode(referrerHeaders(effectiveRef));

	// Hand the structured grant (user_code + URIs, NO bearer token) to the on-page render hook before
	// polling begins (PRD-050c c-AC-3) — the `/setup/login` route displays the code while we poll.
	deps.onGrant?.(grant);

	// Surface the SHORT user code + the verification URI — never the bearer token (D-4).
	reporter.prompt(`To finish signing in, open ${grant.verification_uri} and enter code: ${grant.user_code}`);

	// Validate the server-derived completion URL BEFORE any browser open (https-only — D-4).
	const safe = validateVerificationUrl(grant.verification_uri_complete);
	if (safe !== null) {
		const opened = opener(safe);
		reporter.prompt(opened ? "Browser opened. Waiting for sign in..." : "Waiting for sign in...");
	} else {
		reporter.prompt("Waiting for sign in...");
	}

	const intervalMs = Math.max(grant.interval || 5, 5) * 1000;
	let authToken: string | undefined;
	for (let attempt = 0; attempt < maxPolls; attempt += 1) {
		await sleep(intervalMs);
		const result = await client.pollDeviceToken(grant.device_code);
		if (result !== "pending") {
			authToken = result.access_token;
			break;
		}
	}
	if (authToken === undefined) throw new AuthHttpError(0, "device-flow login timed out before the grant was approved");

	// Mint a long-lived org-bound token from the short-lived Auth0 token (Hivemind's mint step).
	const orgs = await client.listOrgs(authToken);
	if (orgs.length === 0) throw new AuthHttpError(0, "no organizations found for this account");
	const pinned = env[ENV_ORG_ID];
	const chosen = (pinned !== undefined && pinned.length > 0 ? orgs.find((o) => o.id === pinned) : undefined) ?? orgs[0];
	const longLived = await client.reMint(authToken, chosen.id);

	// Persist the long-lived token (validated + identity-hydrated via /me) — the auth token is discarded.
	const persisted = await persistFromToken(client, longLived, deps);

	// Emit `honeycomb_first_link` (PRD-050e e-AC-1) AFTER the credential is persisted — the first
	// successful link. FIRE-AND-FORGET through the single chokepoint: the promise is intentionally NOT
	// awaited (`void`), so a slow/timing-out PostHog hop never delays CLI completion or the `/setup/login`
	// state transition. All errors are swallowed inside `emitTelemetry`; the onboarding `dir` is threaded
	// so the dedupe ledger and the persisted credential share one HOME. The carried `ref` is the SAME
	// effective ref the attribution header used (e-AC-1). Deduped once per machine (e-AC-5); an opt-out
	// env / empty key silences it. NEVER gates the login (the persist already returned).
	void emitTelemetry(
		"honeycomb_first_link",
		{ ref: effectiveRef, tier: "tier1" },
		{ ...(deps.telemetry ?? {}), ...(deps.dir !== undefined ? { dir: deps.dir } : {}) },
	);

	return persisted;
}

/**
 * AC-2 — headless login: validate a PRE-ISSUED long-lived token via `GET /me` and persist the shared
 * credential (0600), skipping the browser entirely. The token comes from `--token <key>` (the
 * explicit arg) or `HONEYCOMB_TOKEN` (parity with Hivemind's `HIVEMIND_TOKEN`). An invalid token →
 * `getMe` throws a redacted {@link AuthHttpError} → the CLI maps it to a non-zero exit with NO file
 * written and NO token in the message (D-4).
 */
export async function loginWithToken(token: string, deps: LoginDeps = {}): Promise<DiskCredentials> {
	if (token.length === 0) throw new AuthHttpError(0, "no token provided for headless login");
	const env = deps.env ?? process.env;
	const apiUrl = resolveApiUrl(env);
	const client = createDeeplakeAuthClient({
		apiUrl,
		...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
		...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
	});
	return persistFromToken(client, token, deps);
}
