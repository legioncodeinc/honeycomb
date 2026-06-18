/**
 * `honeycomb login` / `logout` CLI — PRD-011b (b-AC-1 / b-AC-3 / b-AC-6).
 *
 * The identity-establishment command surface:
 *   - `honeycomb login`  — run the OAuth 2.0 device flow against the
 *     {@link TokenIssuer} SEAM (request a device code, surface the user code +
 *     verification URI, poll until a long-lived org-bound token comes back) and
 *     persist it at `~/.honeycomb/credentials.json` mode `0600` via the Wave-1
 *     {@link saveCredentials} (b-AC-1). The bearer token is NEVER printed.
 *   - `honeycomb logout` — remove the credentials file; with NO file it prints
 *     "Not logged in." and exits SUCCESS, not an error (b-AC-6).
 *
 * ── Boundary: the CLI imports NO DeepLake path (invariant.test.ts) ──────────
 * This is a thin client: it imports neither `src/daemon/storage` nor the daemon
 * core. It reaches the credentials FILE through the CredentialsStore helpers
 * (`loadCredentials` / `credentialsPath`) + the device-flow helpers
 * (`deviceFlowLogin`), and mints tokens through an INJECTED {@link TokenIssuer} seam
 * (the daemon-assembly wiring supplies the real one; the AC-named test supplies a
 * fake). These touch `node:fs` + the user's home dir only — no DeepLake connection —
 * so the storage-import invariant holds. Mirrors `src/cli/org.ts`.
 *
 * ── The token is a secret — never printed ───────────────────────────────────
 * `login` prints a "logged in" confirmation with org id / name / workspace / agent
 * but NEVER the bearer token (a-AC-6 / the redaction thesis). `logout` prints only
 * the status line. There is no code path here that writes the token to stdout.
 *
 * Note: the bundled `honeycomb` bin is not yet extended to dispatch here; that is
 * the deferred pure-wiring assembly step (D-9). This module is constructed-and-tested
 * (the AC-named CLI test drives {@link runAuthCommand} with fakes).
 */

import { unlinkSync } from "node:fs";

import {
	type Clock,
	type Credentials,
	type DeviceFlowReporter,
	type Sleeper,
	type TokenIssuer,
	credentialsPath,
	deviceFlowLogin,
	loadCredentials,
	systemClock,
} from "../daemon/runtime/auth/index.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/**
 * The injectable seams the auth CLI runs against (b-AC-1 / b-AC-6). All default to
 * the real impls; the AC-named test injects fakes (a fake {@link TokenIssuer}, a temp
 * `dir`, a fake {@link Clock}, a no-wait {@link Sleeper}) so no real auth server,
 * real `~/.honeycomb`, or real wall clock is touched.
 */
export interface AuthCommandDeps {
	/** Mints device codes + the long-lived org-bound token for `login` (the SEAM). */
	readonly issuer: TokenIssuer;
	/** Override the credentials directory (tests). */
	readonly dir?: string;
	/** The clock used to stamp `savedAt` server-side (b-AC-4). */
	readonly clock?: Clock;
	/** The env (defaults to `process.env`) — the token-env rule applies on load. */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). NEVER receives the bearer token. */
	readonly out?: OutputSink;
	/** The poll sleeper (defaults to the real wall clock); a test injects a no-wait one. */
	readonly sleep?: Sleeper;
}

/** Outcome of a login/logout command: exit code + whether the file changed. */
export interface AuthResult {
	/** The process exit code (logout-with-no-file is SUCCESS — b-AC-6). */
	readonly exitCode: number;
	/** True iff the credentials file was written (login) or removed (logout). */
	readonly wrote: boolean;
}

/** The parsed `login`/`logout` invocation: just the verb (no positional args today). */
export interface AuthInvocation {
	/** The sub-command word (`login` | `logout`). */
	readonly command: string;
}

/**
 * Parse a raw argv tail into a typed {@link AuthInvocation}. The first non-flag word
 * is the verb (`login` | `logout`); flags are ignored (the device flow needs none).
 */
export function parseAuthArgs(argv: readonly string[]): AuthInvocation {
	const word = argv.find((a) => !a.startsWith("--"));
	return { command: word ?? "" };
}

/** Resolve the deps with their real defaults. */
function withDefaults(deps: AuthCommandDeps): Required<Omit<AuthCommandDeps, "issuer" | "sleep">> & {
	issuer: TokenIssuer;
	sleep?: Sleeper;
} {
	return {
		issuer: deps.issuer,
		dir: deps.dir ?? "",
		clock: deps.clock ?? systemClock,
		env: deps.env ?? process.env,
		out: deps.out ?? ((line: string): void => console.log(line)),
		sleep: deps.sleep,
	};
}

/** The dir argument the CredentialsStore helpers take (undefined = real home). */
function dirArg(dir: string): string | undefined {
	return dir.length > 0 ? dir : undefined;
}

/**
 * `honeycomb login` — run the device flow and persist the minted org-bound token at
 * `0600` (b-AC-1). The reporter shows the verification URI + user code; the success
 * line prints the resolved identity but NEVER the bearer token (a-AC-6).
 */
async function login(deps: ReturnType<typeof withDefaults>): Promise<AuthResult> {
	const out = deps.out;
	// The device-flow reporter surfaces the URI + user code — never the token.
	const reporter: DeviceFlowReporter = { prompt: (line: string): void => out(line) };
	let creds: Credentials;
	try {
		creds = await deviceFlowLogin({
			issuer: deps.issuer,
			dir: dirArg(deps.dir),
			clock: deps.clock,
			reporter,
			...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : "login failed";
		out(`error: login failed: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	// Confirm the logged-in identity WITHOUT the token (a-AC-6 discipline).
	out(`Logged in to org ${creds.orgId} (${creds.orgName}), workspace ${creds.workspace}, agent ${creds.agentId}.`);
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb logout` — remove the credentials file (b-AC-6). With NO file present it
 * prints "Not logged in." and exits SUCCESS (so a script can run it
 * unconditionally); with a file it `unlinkSync`s it and confirms removal.
 */
function logout(deps: ReturnType<typeof withDefaults>): AuthResult {
	const out = deps.out;
	const existing = loadCredentials(dirArg(deps.dir), deps.env);
	if (existing === null) {
		// No credential to remove → SUCCESS, not an error (b-AC-6).
		out("Not logged in.");
		return { exitCode: 0, wrote: false };
	}
	try {
		unlinkSync(credentialsPath(dirArg(deps.dir)));
	} catch (err) {
		const reason = err instanceof Error ? err.message : "could not remove credentials";
		out(`error: logout failed: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	out("Logged out. Credentials removed.");
	return { exitCode: 0, wrote: true };
}

/**
 * Run a parsed `login`/`logout` command (b-AC-1 / b-AC-6). The seams are injected so
 * the AC-named test drives the whole surface against fakes (a fake issuer, a temp
 * dir, a fake clock, a no-wait sleeper) without an auth server or the real home dir.
 */
export async function runAuthCommand(inv: AuthInvocation, deps: AuthCommandDeps): Promise<AuthResult> {
	const resolved = withDefaults(deps);
	if (inv.command === "login") return login(resolved);
	if (inv.command === "logout") return logout(resolved);
	resolved.out("usage: honeycomb <login | logout>");
	return { exitCode: inv.command === "" ? 0 : 1, wrote: false };
}

/** Convenience entry: parse + run a login/logout argv tail in one call. */
export function authMain(argv: readonly string[], deps: AuthCommandDeps): Promise<AuthResult> {
	return runAuthCommand(parseAuthArgs(argv), deps);
}
