/**
 * Device-flow authentication — PRD-011b (Wave 2 impl).
 *
 * Fills the OAuth 2.0 device flow against the {@link TokenIssuer} SEAM (a fake in
 * tests — there is no real auth server in this environment; the real HTTP issuer is
 * a thin documented adapter behind the seam, deferred — see {@link TokenIssuer} in
 * contracts.ts). The three public surfaces:
 *   - {@link deviceFlowLogin} — request a device code, surface the user code +
 *     verification URI, poll on the issuer's interval until a long-lived org-bound
 *     token comes back, then persist it via {@link saveCredentials} (0600 file /
 *     0700 dir, `savedAt` server-stamped) — b-AC-1.
 *   - {@link healOrgDrift} — on session start, if the verified token org claim
 *     disagrees with the active org, re-mint via the issuer, realign org name +
 *     workspace, save; warn and CONTINUE on any failure (never crash the session) —
 *     b-AC-2 / D-4.
 *   - {@link createTokenAuthenticator} — validate a Bearer token via
 *     {@link verifyTokenClaims} → resolve an {@link Identity} (org / workspace /
 *     agentId / role / project from the claims) or `null`. This is the token half of
 *     the composite {@link Authenticator} the daemon composes into the permission
 *     middleware (assembly deferred, D-9).
 *
 * ── The secret is never logged / persisted / printed ────────────────────────
 * The bearer token is a secret. NOTHING here logs, prints, or returns it on any
 * diagnostic path: the device-flow status lines carry the user code + URI only, the
 * drift-heal warning carries org ids only, and any secret comparison uses
 * {@link timingSafeEqual} (a-AC-6 / the redaction thesis). The token reaches disk
 * ONLY through the Wave-1 {@link saveCredentials} (0600), never a hand-rolled write.
 *
 * 011b MUST NOT touch: contracts.ts (the seam shapes), credentials-store.ts (the IO
 * discipline), permission.ts (011c owns the policy). It ADDS its impl here + its test.
 */

import { timingSafeEqual } from "node:crypto";

import {
	type Authenticator,
	type Credentials,
	type Identity,
	type Mode,
	type MintedToken,
	type PresentedCredentials,
	type Role,
	type TokenClaims,
	type TokenIssuer,
	asRole,
	verifyTokenClaims,
} from "./contracts.js";
import {
	type Clock,
	DEFAULT_WORKSPACE,
	loadCredentials,
	saveCredentials,
	systemClock,
} from "./credentials-store.js";

// ────────────────────────────────────────────────────────────────────────────
// deviceFlowLogin — b-AC-1.
// ────────────────────────────────────────────────────────────────────────────

/** A sink for the user-facing device-flow prompts (user code + verification URI). */
export interface DeviceFlowReporter {
	/** Show the verification URI + user code the human types in the browser. */
	prompt(line: string): void;
}

/** A sleeper so the poll cadence is injectable (a test passes a no-wait sleeper). */
export interface Sleeper {
	/** Resolve after `ms` milliseconds (the issuer's `interval`, in seconds, ×1000). */
	(ms: number): Promise<void>;
}

/** The real wall-clock sleeper. */
export const realSleeper: Sleeper = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** The injectable seams {@link deviceFlowLogin} runs against (all default to real impls). */
export interface DeviceFlowDeps {
	/** Mints the device code + polls for the long-lived org-bound token (the SEAM). */
	readonly issuer: TokenIssuer;
	/** Override the credentials directory (tests). */
	readonly dir?: string;
	/** The clock that stamps `savedAt` server-side (b-AC-4). */
	readonly clock?: Clock;
	/** The user-facing prompt sink (defaults to `console.log`). NEVER receives the token. */
	readonly reporter?: DeviceFlowReporter;
	/** The poll sleeper (defaults to the real wall clock); a test injects a no-wait one. */
	readonly sleep?: Sleeper;
	/** A safety cap on poll attempts so a never-approving issuer cannot loop forever. */
	readonly maxPolls?: number;
}

/** The default poll cap — generous, but bounded so a stuck flow surfaces rather than hangs. */
export const DEFAULT_MAX_POLLS = 900;

function reporterOf(deps: DeviceFlowDeps): DeviceFlowReporter {
	return deps.reporter ?? { prompt: (line: string): void => console.log(line) };
}

/** Map verified {@link TokenClaims} onto the persisted {@link Credentials} identity fields. */
function credentialsFromMint(minted: MintedToken, prior: Credentials | null): Credentials {
	const claims = minted.claims;
	return {
		token: minted.token,
		orgId: claims.org,
		// 011b has no human-org-name source in this env; the id is the safe display default.
		orgName: claims.org,
		workspace: claims.workspace ?? prior?.workspace ?? DEFAULT_WORKSPACE,
		agentId: claims.agentId ?? prior?.agentId ?? "default",
		savedAt: "", // stamped server-side by saveCredentials (b-AC-4).
	};
}

/**
 * Run the device-flow login against the {@link TokenIssuer} and return the persisted
 * {@link Credentials} (b-AC-1).
 *
 * Flow: `requestDeviceCode` → surface `userCode` + `verificationUri` to the human →
 * poll `pollToken(deviceCode)`, respecting the issuer's `interval` (seconds) on each
 * `"pending"`, until a {@link MintedToken} arrives → persist via
 * {@link saveCredentials} (0600 file / 0700 dir, `savedAt` server-stamped). The
 * bearer token is NEVER printed — only the user code + URI reach the reporter.
 *
 * Throws if the issuer errors or the poll cap is exhausted without approval; the CLI
 * maps a throw to a non-zero exit with a redacted message.
 */
export async function deviceFlowLogin(deps: DeviceFlowDeps): Promise<Credentials> {
	const issuer = deps.issuer;
	const clock = deps.clock ?? systemClock;
	const reporter = reporterOf(deps);
	const sleep = deps.sleep ?? realSleeper;
	const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;

	const grant = await issuer.requestDeviceCode();
	// Surface the verification URI + the SHORT user code — never the bearer token.
	reporter.prompt(`To finish signing in, open ${grant.verificationUri} and enter code: ${grant.userCode}`);

	const intervalMs = Math.max(0, grant.interval) * 1000;
	const prior = loadCredentials(deps.dir);

	for (let attempt = 0; attempt < maxPolls; attempt += 1) {
		const result = await issuer.pollToken(grant.deviceCode);
		if (result !== "pending") {
			// A long-lived org-bound token arrived — persist it (0600) and return.
			const creds = credentialsFromMint(result, prior);
			return saveCredentials(creds, deps.dir, clock);
		}
		// Respect the issuer's poll interval before asking again (avoids hammering it).
		await sleep(intervalMs);
	}
	throw new Error("device-flow login timed out before the grant was approved");
}

// ────────────────────────────────────────────────────────────────────────────
// healOrgDrift — b-AC-2.
// ────────────────────────────────────────────────────────────────────────────

/** A warning sink for the best-effort drift heal (carries org ids only — never the token). */
export interface DriftWarner {
	/** Emit a structured warning; the heal CONTINUES regardless (b-AC-2). */
	warn(line: string): void;
}

/** The injectable seams {@link healOrgDrift} runs against. */
export interface HealOrgDriftDeps {
	/** Mints a fresh org-bound token for the active org (the re-mint SEAM). */
	readonly issuer: TokenIssuer;
	/** The org the session is configured to run under (the active org). */
	readonly activeOrg: string;
	/** Override the credentials directory (tests). */
	readonly dir?: string;
	/** The clock that stamps `savedAt` on the realigned save (b-AC-4). */
	readonly clock?: Clock;
	/** The warning sink (defaults to `console.warn`); receives org ids, NEVER the token. */
	readonly warner?: DriftWarner;
	/** The env (defaults to `process.env`) — the token-env rule applies on load. */
	readonly env?: NodeJS.ProcessEnv;
}

/** The outcome of a drift-heal attempt — a typed result, never a throw (b-AC-2). */
export type DriftHealResult =
	/** No credentials on disk → nothing to heal (the session prompts login elsewhere). */
	| { readonly kind: "no-credentials" }
	/** The token's verified org already matches the active org → no action. */
	| { readonly kind: "aligned"; readonly org: string }
	/** Drift detected and healed: re-minted + realigned + saved. */
	| { readonly kind: "healed"; readonly from: string; readonly to: string }
	/** Drift detected but the heal failed → warned and continuing with the stale token. */
	| { readonly kind: "heal-failed"; readonly reason: string };

function warnerOf(deps: HealOrgDriftDeps): DriftWarner {
	return deps.warner ?? { warn: (line: string): void => console.warn(line) };
}

/**
 * Heal a drifted org token on session start, BEST-EFFORT (b-AC-2 / D-4).
 *
 * Decodes the active token via {@link verifyTokenClaims}; if its verified org claim
 * disagrees with `activeOrg`, re-mints a fresh org-bound token via the issuer,
 * realigns the stored org name + workspace, and saves (0600). On ANY failure
 * (unverifiable token, issuer reject, save error) it emits a WARNING carrying the
 * conflicting org ids — never the token — and CONTINUES with the stale credential
 * rather than crashing the session.
 *
 * Never throws: every fault becomes a typed {@link DriftHealResult} the caller can
 * log, so the session boundary never dies on a heal.
 */
export async function healOrgDrift(deps: HealOrgDriftDeps): Promise<DriftHealResult> {
	const warner = warnerOf(deps);
	const clock = deps.clock ?? systemClock;
	const creds = loadCredentials(deps.dir, deps.env);
	if (creds === null) return { kind: "no-credentials" };

	const claims = verifyTokenClaims(creds.token);
	if (claims === null) {
		// An unverifiable token cannot be compared; warn (no token) and continue.
		warner.warn(
			`auth: org-drift heal skipped — the stored token could not be verified (active org "${deps.activeOrg}"); continuing with the stale credential`,
		);
		return { kind: "heal-failed", reason: "token could not be verified" };
	}

	if (claims.org === deps.activeOrg) return { kind: "aligned", org: claims.org };

	// Drift: the token is bound to a different org than the session is configured for.
	try {
		const minted = await deps.issuer.reMint(deps.activeOrg);
		const realigned = credentialsFromMint(minted, creds);
		saveCredentials(realigned, deps.dir, clock);
		return { kind: "healed", from: claims.org, to: deps.activeOrg };
	} catch (err) {
		const reason = err instanceof Error ? err.message : "re-mint failed";
		// WARN + CONTINUE: never crash the session on a heal failure (b-AC-2). The
		// warning names the conflicting orgs (token org vs active org) but NOT the token.
		warner.warn(
			`auth: org-drift heal failed (token org "${claims.org}" ≠ active org "${deps.activeOrg}"): ${reason}; continuing with the stale credential`,
		);
		return { kind: "heal-failed", reason };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// createTokenAuthenticator — the token half of the composite Authenticator (D-9).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A verify function: token string → verified {@link TokenClaims}, or `null` on any
 * failure. The default is {@link verifyTokenClaims} (the Wave-1 decoder; 011b's real
 * HTTP issuer adapter swaps in real signature + expiry verification BEHIND this same
 * shape). Injectable so a test can drive the authenticator with a scripted verifier.
 */
export type TokenVerifier = (token: string) => TokenClaims | null;

/** Map a verified claim's optional `role` onto the closed {@link Role} set; default `agent`. */
function roleFromClaims(claims: TokenClaims): Role {
	const role = claims.role !== undefined ? asRole(claims.role) : null;
	// Fail-closed default: an absent/unknown role resolves to the LEAST-privileged
	// connector role rather than widening to anything broader.
	return role ?? "agent";
}

/** A timing-safe equality check for two secret-bearing strings (never short-circuits on length). */
export function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * Build the token-authenticator half of the composite {@link Authenticator} (D-9 /
 * b-AC). Validates a presented Bearer token via `verify` (default
 * {@link verifyTokenClaims}), maps the verified claims onto an {@link Identity}
 * (org / workspace / agentId / role / project), and returns `null` on ANY
 * verification failure (→ the middleware treats `null` as 401). It NEVER returns a
 * partially-trusted Identity and NEVER logs the token.
 *
 * SECURITY: In `team` and `hybrid` modes, unsigned stub tokens (those with the
 * `hcmt.v1.` prefix) are REJECTED. Stub tokens are development-only and lack
 * cryptographic signatures; accepting them in production would allow an attacker
 * to forge admin credentials. Only `local` mode (single-user loopback) accepts
 * stub tokens.
 *
 * The api-key half is 011d's {@link Authenticator}; the daemon assembly composes the
 * two (deferred, D-9).
 *
 * @param verify - Token verification function (default: {@link verifyTokenClaims})
 * @param mode - Deployment mode; if `team` or `hybrid`, stub tokens are rejected
 */
export function createTokenAuthenticator(
	verify: TokenVerifier = verifyTokenClaims,
	mode?: Mode,
): Authenticator {
	return {
		authenticate(presented: PresentedCredentials): Promise<Identity | null> {
			const bearer = presented.bearer;
			if (typeof bearer !== "string" || bearer.length === 0) {
				// No bearer → this half cannot authenticate (the api-key half may; else 401).
				return Promise.resolve(null);
			}
			// SECURITY: Reject UNSIGNED tokens in team/hybrid modes (production) when the
			// default (signature-blind) verifier is in use. Stub tokens (hcmt.v1. prefix)
			// have no signature; and as of FIX #3 the default `verifyTokenClaims` also
			// decodes a real JWT's payload WITHOUT verifying its signature (it is a
			// tenancy-resolution decoder, not a production authenticator). Accepting either
			// in production would let an attacker forge claims. A production deployment
			// injects a real signature-verifying `verify`, which opts out of this guard.
			if ((mode === "team" || mode === "hybrid") && verify === verifyTokenClaims) {
				// Fail-closed: no signature-checking verifier in production → reject (null → 401).
				return Promise.resolve(null);
			}
			const claims = verify(bearer);
			if (claims === null) return Promise.resolve(null);
			const identity: Identity = {
				org: claims.org,
				workspace: claims.workspace ?? DEFAULT_WORKSPACE,
				agentId: claims.agentId ?? "default",
				role: roleFromClaims(claims),
				...(claims.project !== undefined ? { project: claims.project } : {}),
			};
			return Promise.resolve(identity);
		},
	};
}
