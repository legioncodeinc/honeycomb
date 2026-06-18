/**
 * Auth & tenancy contracts — PRD-011 Wave 1 (the typed shapes + seams 011a/011b/
 * 011c/011d/011e code against).
 *
 * This is the single most load-bearing Wave-1 artifact for PRD-011: four Wave-2
 * concerns (011b device-flow + auth CLI, 011c modes + RBAC, 011d api-keys +
 * rate-limit) each code against THESE shapes, so they must be right and stable. A
 * genuinely new cross-module field is a Wave-1 change (raise it), not a stub edit.
 *
 * ── The central thesis: FAIL CLOSED. When in doubt, DENY. ───────────────────
 * This is the security-critical auth layer. Every default here is the most
 * restrictive one:
 *   - The default {@link AuthorizationPolicy} ({@link defaultDenyPolicy}) returns
 *     `"forbidden"` for EVERY input.
 *   - An {@link Authenticator} returns `null` (→ unauthenticated → 401) when it
 *     cannot positively validate a credential — it never "passes through".
 *   - {@link verifyTokenClaims} returns `null` on any malformed/unverifiable token
 *     rather than a partially-trusted claim set.
 *
 * ── Identity is RESOLVED, never asserted ────────────────────────────────────
 * The {@link Identity} is the VALIDATED caller — produced by an {@link Authenticator}
 * from a bearer token or an API key, NEVER read from a request header. The role,
 * org, workspace, and project on an Identity are trustworthy precisely because a
 * header can't forge them: a `x-honeycomb-role: admin` header is a
 * privilege-escalation bypass, so the middleware (011c) takes the role ONLY from
 * an Identity an Authenticator returned. Org/workspace headers survive ONLY as a
 * tenancy HINT the authenticator cross-checks against the token claim — never as
 * the source of truth (a-AC-5 / D-4).
 *
 * ── The secret is never persisted/logged/dumped ─────────────────────────────
 * An {@link ApiKeyRecord} holds `keyHash` — a salted-hash STRING, never a
 * plaintext key (D-6 / d-AC-1). {@link Credentials} carries the bearer `token`,
 * but {@link Credentials} is NEVER logged and `honeycomb status` prints every
 * field EXCEPT the token (a-AC-6). There is no plaintext-key field anywhere in
 * these contracts by construction.
 *
 * ── The four roles (D-1) ────────────────────────────────────────────────────
 * The RBAC matrix (011c implements; pinned here for Wave 2):
 *
 *   role       | read | write | admin routes | token/connectors-admin routes
 *   -----------+------+-------+--------------+------------------------------
 *   admin      | yes  | yes   | yes          | yes
 *   member     | yes  | yes¹  | no           | no
 *   readonly   | yes  | NO→403| no           | no
 *   agent      | yes² | yes²  | no           | NO→403  (connector; no admin/token)
 *
 *   ¹ member writes within its own org/workspace/project scope only.
 *   ² agent (a remote connector) reads+writes its own scoped data; it is denied
 *     every admin route, every token/credentials route, and the connectors-admin
 *     surface (c-AC-6 / d-AC-3).
 *
 * Project scope rides ON TOP of the role: a token/key bound `project=alpha`
 * targeting `project=beta` is denied unless the role is `admin` (c-AC-5 / d-AC-6).
 */

import type { DeploymentMode } from "../config.js";

// ────────────────────────────────────────────────────────────────────────────
// Mode — reuse the daemon's DeploymentMode (local | team | hybrid).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The deployment mode the auth layer keys off (D-2). Re-exported from the daemon
 * config so the auth modules share ONE mode type, never a parallel definition:
 *   - `local`  — loopback single-user; full access, no token, no rate limit.
 *   - `team`   — token/API-key required; RBAC enforced.
 *   - `hybrid` — fail-closed: no trustworthy socket-peer signal → require a token;
 *                NEVER trust the `Host` header (c-AC-1).
 */
export type Mode = DeploymentMode;

// ────────────────────────────────────────────────────────────────────────────
// Role — the closed 4-role RBAC vocabulary (D-1).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The four RBAC roles, ORDERED most-privileged → least for readability (the order
 * is NOT a rank — RBAC is a per-route matrix, not a scalar level; see the matrix
 * in the module doc). Frozen so the array is the single source the type + any
 * narrowing reads. A NEW role is an additive Wave-1 change (append only).
 */
export const ROLES = Object.freeze(["admin", "member", "readonly", "agent"] as const);

/** One RBAC role drawn from the closed {@link ROLES} vocabulary (D-1). */
export type Role = (typeof ROLES)[number];

/** Narrow an arbitrary string to a known {@link Role}, else `null` (fail-closed). */
export function asRole(raw: string): Role | null {
	return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Identity — the VALIDATED caller (resolved from a token/key, never a header).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The validated caller identity (D-9). Produced by an {@link Authenticator} from a
 * bearer token or an API key — NEVER read from a request header. The middleware
 * (011c) trusts an Identity precisely because it came from credential validation:
 * the `role` here is the authorization source of truth, and a header-asserted role
 * is a bypass that the middleware explicitly does NOT honor.
 *
 * `org` + `workspace` are the resolved tenancy partition (the outer ring, 011a).
 * `agentId` is the within-workspace actor (the inner-ring scope key, 011e).
 * `project`, when present, bounds the caller to one project: a request targeting a
 * different project is denied unless the role is `admin` (c-AC-5 / d-AC-6).
 */
export interface Identity {
	/** The resolved org (from the token claim, never a header) — the billing/partition boundary. */
	readonly org: string;
	/** The resolved workspace — the within-org project partition (outer ring, 011a). */
	readonly workspace: string;
	/** The within-workspace actor id (inner-ring scope key, 011e). */
	readonly agentId: string;
	/** The validated RBAC role — the authorization source of truth (never a header). */
	readonly role: Role;
	/** Optional project binding; a cross-project request is denied unless `admin` (c-AC-5). */
	readonly project?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Credentials — the on-disk credentials.json shape (011a/011b).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The persisted credentials (D-3). Lives in `~/.honeycomb/credentials.json` at
 * mode `0600`. Carries the bearer `token` (org-bound, minted by the
 * {@link TokenIssuer}) plus the tenancy identity it resolves to.
 *
 * SECURITY: the `token` is a secret. {@link Credentials} is NEVER logged, and
 * `honeycomb status` prints every field EXCEPT `token` (a-AC-6). `savedAt` is
 * ALWAYS stamped server-side from the clock on write, ignoring any caller value
 * (b-AC-4) — it is evidence of when the file was written, not a client assertion.
 */
export interface Credentials {
	/** The org-bound bearer token (SECRET — never logged, never printed by `status`). */
	readonly token: string;
	/** The org id the token is bound to (cross-checked against the token claim — a-AC-5). */
	readonly orgId: string;
	/** The human-readable org name (display only). */
	readonly orgName: string;
	/** The active workspace id (the `default` sentinel resolves server-side — a-AC). */
	readonly workspace: string;
	/** The resolved agent id (display + inner-ring scope hint). */
	readonly agentId: string;
	/** ISO timestamp stamped server-side on save (b-AC-4), never trusted from the caller. */
	readonly savedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// TokenClaims — the decoded token (for the org-claim-vs-file integrity check).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The decoded token claim set (D-4). The auth layer needs ONE claim today — the
 * org the token is bound to — for the integrity check in `resolveTenancy`: a
 * credentials file whose `orgId` disagrees with the token's verified `org` claim is
 * REJECTED, never honored (a-AC-5). Other claims (workspace, role, project, expiry)
 * are carried as optionals so 011b can harden the decoder without a shape change.
 *
 * This is NOT a trust boundary by itself: claims are only trustworthy once
 * {@link verifyTokenClaims} has verified the token's integrity. An unverified
 * decode returns `null`.
 */
export interface TokenClaims {
	/** The org the token is bound to — the claim the file's `orgId` is checked against (a-AC-5). */
	readonly org: string;
	/** Optional workspace claim. */
	readonly workspace?: string;
	/** Optional agent id claim. */
	readonly agentId?: string;
	/** Optional role claim (011b/011c map this onto the {@link Role} set). */
	readonly role?: string;
	/** Optional project binding claim (c-AC-5). */
	readonly project?: string;
	/** Optional expiry (epoch seconds); 011b enforces it. */
	readonly exp?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// ApiKeyRecord — mirrors the api_keys catalog row (011d).
// ────────────────────────────────────────────────────────────────────────────

/**
 * One API-key record (D-6) — the typed mirror of an `api_keys` catalog row
 * relevant to validation. Holds `keyHash` ONLY (a salted hash; 011d reconciles the
 * existing SHA-256 helper to scrypt+salt per d-AC-1) — there is NO plaintext-key
 * field by construction. A presented key is validated by hashing it and matching
 * `keyHash`; a `revoked` record is rejected (d-AC-4); a `project`-bound record
 * denies a cross-project request unless `admin` (d-AC-6).
 */
export interface ApiKeyRecord {
	/** The key id (the `api_keys.id`). */
	readonly id: string;
	/** The salted hash of the plaintext key — the ONLY credential field (d-AC-1). */
	readonly keyHash: string;
	/** A human label for the key. */
	readonly name: string;
	/** The role this key grants (drives RBAC — c-AC / d-AC-3). */
	readonly role: Role;
	/** Optional project binding; a cross-project request is denied unless `admin` (d-AC-6). */
	readonly project?: string;
	/** True when the key has been revoked → every request with it is rejected (d-AC-4). */
	readonly revoked: boolean;
	/** ISO creation timestamp. */
	readonly createdAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// AuthDecision — the three-way outcome the middleware maps to status codes.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The three-way authorization outcome (011c). The middleware maps it to a status:
 *   - `allow`           → `next()` (the handler runs).
 *   - `unauthenticated` → `401` (no valid credential — who are you?).
 *   - `forbidden`       → `403` (valid credential, but not permitted here).
 *
 * The 401-vs-403 distinction is load-bearing: 401 means "authenticate", 403 means
 * "authenticated but denied". The middleware derives `unauthenticated` from a null
 * {@link Authenticator} result and `forbidden`/`allow` from the
 * {@link AuthorizationPolicy}. Frozen so the array is the single source the type reads.
 */
export const AUTH_DECISIONS = Object.freeze(["allow", "unauthenticated", "forbidden"] as const);

/** One authorization outcome drawn from {@link AUTH_DECISIONS}. */
export type AuthDecision = (typeof AUTH_DECISIONS)[number];

// ────────────────────────────────────────────────────────────────────────────
// TOKEN ISSUER SEAM — 011b fills the real one (fake here; no auth server in env).
// ────────────────────────────────────────────────────────────────────────────

/** A pending device-flow grant the user approves in a browser (OAuth 2.0 device flow, D-5). */
export interface DeviceCodeGrant {
	/** The opaque device code the CLI polls with. */
	readonly deviceCode: string;
	/** The short user code the human types at the verification URI. */
	readonly userCode: string;
	/** The URL the user visits to approve. */
	readonly verificationUri: string;
	/** The poll interval (seconds) the CLI must respect (avoids hammering the issuer). */
	readonly interval: number;
}

/** A minted org-bound token + its decoded claims (the device-flow / re-mint result). */
export interface MintedToken {
	/** The org-bound bearer token (SECRET). */
	readonly token: string;
	/** The decoded claims for the minted token (its `org` is the binding). */
	readonly claims: TokenClaims;
}

/**
 * The token-issuance SEAM (D-5). There is NO real auth server in this environment,
 * so Wave 1 ships ONLY the seam + a fake; 011b fills the real OAuth 2.0 device flow.
 *   - `requestDeviceCode` — begin a device-flow grant (returns the codes + URI).
 *   - `pollToken`         — poll the grant; `"pending"` until the user approves,
 *                           then the {@link MintedToken}.
 *   - `reMint`            — mint a FRESH org-bound token for `orgId` (the
 *                           `honeycomb org switch` path — a-AC-3 — and the
 *                           org-drift realignment — b-AC-2).
 *
 * The issued token is org-bound: the org is baked into the claim, which is why
 * switching orgs re-mints rather than editing a field (a-AC-3 / FR-4).
 */
export interface TokenIssuer {
	/** Begin a device-flow grant (D-5). */
	requestDeviceCode(): Promise<DeviceCodeGrant>;
	/** Poll a grant; `"pending"` until approved, then the minted token + claims. */
	pollToken(deviceCode: string): Promise<MintedToken | "pending">;
	/** Re-mint a fresh org-bound token for an org (the `org switch` path — a-AC-3). */
	reMint(orgId: string): Promise<MintedToken>;
}

/**
 * A scripted device-flow run for {@link createFakeTokenIssuer}. `grant` is the
 * device-code grant `requestDeviceCode` returns; `pollResults` is the ORDERED
 * sequence `pollToken` yields (e.g. `["pending", "pending", token]`) so a test
 * drives the poll loop deterministically; `reMint` maps an org id → the token a
 * re-mint produces. No real network, no real auth server.
 */
export interface FakeTokenIssuerScript {
	/** The grant `requestDeviceCode` returns. */
	readonly grant?: DeviceCodeGrant;
	/** The ordered `pollToken` results (consumed one per call); exhausted → last value repeats. */
	readonly pollResults?: readonly (MintedToken | "pending")[];
	/** org id → the {@link MintedToken} a `reMint(orgId)` returns. */
	readonly reMint?: Record<string, MintedToken>;
}

/**
 * Build a FAKE {@link TokenIssuer} for tests from a {@link FakeTokenIssuerScript}.
 * 011b's device-flow tests drive THIS (no real auth server in the env). `reMint`
 * for an unscripted org rejects (the production issuer fails closed on an unknown
 * org). The poll sequence is consumed in order; once exhausted the last entry
 * repeats so a test need not over-specify.
 */
export function createFakeTokenIssuer(script: FakeTokenIssuerScript = {}): TokenIssuer {
	const grant: DeviceCodeGrant = script.grant ?? {
		deviceCode: "fake-device-code",
		userCode: "FAKE-CODE",
		verificationUri: "https://example.invalid/device",
		interval: 1,
	};
	const polls = [...(script.pollResults ?? [])];
	let pollIndex = 0;
	return {
		requestDeviceCode(): Promise<DeviceCodeGrant> {
			return Promise.resolve(grant);
		},
		pollToken(_deviceCode: string): Promise<MintedToken | "pending"> {
			if (polls.length === 0) return Promise.resolve("pending");
			const value = pollIndex < polls.length ? polls[pollIndex] : polls[polls.length - 1];
			if (pollIndex < polls.length) pollIndex += 1;
			return Promise.resolve(value as MintedToken | "pending");
		},
		reMint(orgId: string): Promise<MintedToken> {
			const table = script.reMint ?? {};
			if (Object.hasOwn(table, orgId)) return Promise.resolve(table[orgId] as MintedToken);
			return Promise.reject(new Error(`FakeTokenIssuer: no re-mint scripted for org ${orgId}`));
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATOR SEAM — 011b fills token-auth, 011d fills api-key-auth.
// ────────────────────────────────────────────────────────────────────────────

/** The raw credentials presented on a request: a bearer token and/or an API key. */
export interface PresentedCredentials {
	/** The `Authorization: Bearer <token>` value, stripped of the `Bearer ` prefix. */
	readonly bearer?: string;
	/** The `x-api-key` header value. */
	readonly apiKey?: string;
}

/**
 * The authentication SEAM (D-9). Validates presented credentials and returns the
 * resolved {@link Identity}, or `null` when no credential validates → the middleware
 * treats `null` as `unauthenticated` (401). It NEVER returns a partially-trusted
 * Identity: a malformed/expired token or an unknown/revoked key yields `null`.
 *
 * Wave 2 composes the real authenticator: 011b fills token authentication
 * (verify → claims → Identity), 011d fills API-key authentication (hash → lookup →
 * Identity), and a composite tries each. Wave 1 ships ONLY the seam + the
 * always-unauthenticated default ({@link alwaysUnauthenticated}) + a fake.
 */
export interface Authenticator {
	/** Validate presented credentials → the resolved Identity, or `null` (→ 401). */
	authenticate(presented: PresentedCredentials): Promise<Identity | null>;
}

/**
 * The fail-closed default {@link Authenticator}: it validates NOTHING and always
 * returns `null`. With no real authenticator wired, every `team`/`hybrid` request
 * is `unauthenticated` (401) — the daemon stays closed by default. The daemon
 * assembly swaps in the composed real authenticator (deferred, D-9).
 */
export const alwaysUnauthenticated: Authenticator = {
	authenticate(): Promise<Identity | null> {
		return Promise.resolve(null);
	},
};

/**
 * Build a FAKE {@link Authenticator} for tests from a lookup `table`. A key (the
 * bearer token, else the api key) maps to the {@link Identity} it resolves to;
 * a missing key → `null` (unauthenticated). Lets 011c's middleware tests drive
 * the 401-vs-403 split without a real token validator or key store.
 */
export function createFakeAuthenticator(table: Record<string, Identity>): Authenticator {
	return {
		authenticate(presented: PresentedCredentials): Promise<Identity | null> {
			const key = presented.bearer ?? presented.apiKey;
			if (key !== undefined && Object.hasOwn(table, key)) {
				return Promise.resolve(table[key] as Identity);
			}
			return Promise.resolve(null);
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION POLICY SEAM — 011c fills the real RBAC.
// ────────────────────────────────────────────────────────────────────────────

/** The request context an {@link AuthorizationPolicy} decides against (011c). */
export interface AuthorizationContext {
	/** The route-group label this request targets (e.g. `/api/memories`). */
	readonly group: string;
	/** The HTTP method (drives the read-vs-write RBAC split — c-AC-2). */
	readonly method: string;
	/** The project the request targets, if any (cross-project → 403 unless admin — c-AC-5). */
	readonly project?: string;
}

/**
 * The authorization SEAM (D-9 / 011c). Given a VALIDATED {@link Identity} and the
 * request {@link AuthorizationContext}, decide `allow` | `forbidden` (an
 * AuthorizationPolicy never returns `unauthenticated` — that outcome belongs to the
 * {@link Authenticator}, which runs first; a policy only ever sees an authenticated
 * caller). 011c fills the real 4-role matrix (see the module doc); Wave 1 ships the
 * fail-closed {@link defaultDenyPolicy}.
 */
export interface AuthorizationPolicy {
	/** Decide whether a validated Identity may perform this request. */
	decide(identity: Identity, ctx: AuthorizationContext): AuthDecision;
}

/**
 * The fail-closed default {@link AuthorizationPolicy}: it returns `"forbidden"` for
 * EVERY input. With no real RBAC wired, an authenticated caller is still denied —
 * the daemon never defaults to allow. 011c replaces this with the real matrix; the
 * daemon assembly injects it (deferred, D-9). A test that wants an allow injects
 * its own policy (mirroring the 004a `permissionCheck` posture).
 */
export const defaultDenyPolicy: AuthorizationPolicy = {
	decide(): AuthDecision {
		return "forbidden";
	},
};

// ────────────────────────────────────────────────────────────────────────────
// verifyTokenClaims — the minimal decoder seam (011b hardens it).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The token-encoding prefix the Wave-1 stub issuer/decoder agree on. There is no
 * JWT library and no real signing key in this environment, so Wave 1 uses a
 * DOCUMENTED, self-describing token shape both the {@link TokenIssuer} fakes and
 * this decoder understand: the literal prefix below followed by a base64url-encoded
 * JSON claim object. 011b replaces this with real signature verification.
 */
export const STUB_TOKEN_PREFIX = "hcmt.v1.";

/**
 * Decode + minimally verify a token's claims (D-4 — the org-claim-vs-file check
 * consumes this). Returns the {@link TokenClaims}, or `null` on ANY problem
 * (wrong prefix, malformed body, missing `org`) — fail-closed, never a partial
 * claim set.
 *
 * WAVE-1 STUB (011b hardens): a token is `STUB_TOKEN_PREFIX` + base64url(JSON).
 * This is integrity-by-shape only — there is no cryptographic signature in this
 * environment. 011b swaps in real verification (signature + expiry) BEHIND this
 * same signature, so callers (`resolveTenancy`, the token authenticator) do not
 * change. The contract callers rely on is: a returned non-null value has a verified
 * `org`; a `null` value means "do not trust this token".
 *
 * Pure + total: it never throws (a throw would be a swallow-or-crash fork at every
 * call site); a bad token is `null`.
 */
export function verifyTokenClaims(token: string): TokenClaims | null {
	if (typeof token !== "string" || !token.startsWith(STUB_TOKEN_PREFIX)) return null;
	const body = token.slice(STUB_TOKEN_PREFIX.length);
	let json: unknown;
	try {
		const decoded = Buffer.from(body, "base64url").toString("utf8");
		json = JSON.parse(decoded);
	} catch {
		// A malformed body is an untrustworthy token → null (fail-closed), not a throw.
		return null;
	}
	if (typeof json !== "object" || json === null) return null;
	const record = json as Record<string, unknown>;
	const org = record.org;
	if (typeof org !== "string" || org.trim() === "") return null;
	const claims: TokenClaims = {
		org,
		...(typeof record.workspace === "string" ? { workspace: record.workspace } : {}),
		...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
		...(typeof record.role === "string" ? { role: record.role } : {}),
		...(typeof record.project === "string" ? { project: record.project } : {}),
		...(typeof record.exp === "number" ? { exp: record.exp } : {}),
	};
	return claims;
}

/**
 * Encode a {@link TokenClaims} into the Wave-1 stub token shape (the inverse of
 * {@link verifyTokenClaims}). Used by the fake {@link TokenIssuer} scripts and tests
 * to produce a token that decodes back to known claims, WITHOUT a real auth server.
 * 011b replaces both halves with real mint+verify behind the same seam.
 */
export function encodeStubToken(claims: TokenClaims): string {
	const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
	return `${STUB_TOKEN_PREFIX}${body}`;
}

// ────────────────────────────────────────────────────────────────────────────
// The standard "Wave 2 fills this" thrower.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The standard "Wave 2 fills this" thrower (mirrors the inference/dreaming harness
 * posture). A stubbed seam body calls this so an accidental early call FAILS LOUD
 * with the owning sub-PRD, never silently returns a fake-passing (and here,
 * security-relevant) value.
 */
export function notImplemented(what: string): never {
	throw new Error(`auth: ${what} is not implemented in Wave 1 (see CONVENTIONS.md for the owning sub-PRD)`);
}
