/**
 * `honeycomb login` / `logout` CLI — PRD-023 Wave 2 (AC-1 / AC-2 / AC-6).
 *
 * The identity-establishment command surface, ported to the REAL `api.deeplake.ai` backend so one
 * login authenticates BOTH Honeycomb and Hivemind against the SHARED `~/.deeplake/credentials.json`
 * (D-1). Three behaviors:
 *
 *   - `honeycomb login` (default, AC-1) — run the RFC-8628 device flow against `api.deeplake.ai`
 *     ({@link loginWithDeviceFlow}): request a device code, PRINT the user code + verification URI,
 *     OPEN the validated `verification_uri_complete` (https-only — D-4), poll to a token, mint a
 *     long-lived org-bound token, `GET /me`, and persist the Hivemind disk shape (0600). The bearer
 *     token is NEVER printed; the success line names org / workspace / user only.
 *   - `honeycomb login --token <key>` / `HONEYCOMB_TOKEN=<key> honeycomb login` (AC-2) — headless:
 *     skip the browser, validate the pre-issued token via `GET /me` ({@link loginWithToken}), and
 *     persist. Parity with Hivemind's `HIVEMIND_TOKEN`. An invalid token → non-zero exit, NO file,
 *     NO token in any output.
 *   - `honeycomb logout` (AC-6) — remove the SHARED `~/.deeplake/credentials.json` AND the legacy
 *     `~/.honeycomb/credentials.json` if present; exit 0 even when neither exists; never throw.
 *
 * ── Boundary: the CLI imports NO DeepLake storage path (invariant.test.ts) ──────
 * This is a thin client: it imports neither `src/daemon/storage` nor the daemon core. It reaches the
 * credentials FILE + the auth backend through `src/daemon/runtime/auth` (the login flows + the
 * credentials-store helpers), which touch `node:fs` + the auth HTTP API only — no DeepLake
 * connection — so the storage-import invariant holds. The HTTP `fetch` + the browser opener are
 * SEAMS (injectable) so the AC-named tests drive the whole surface against a fake fetch + a recorder
 * opener with no network and no real browser.
 *
 * ── The token is a secret — never printed (D-4) ─────────────────────────────────
 * `login` prints a confirmation with org / workspace / user but NEVER the bearer token. `logout`
 * prints only the status line. There is no code path here that writes the token to stdout/stderr.
 */

import { existsSync, unlinkSync } from "node:fs";

import {
	type AuthFetch,
	type BrowserOpener,
	type Clock,
	type DiskCredentials,
	type Sleeper,
	credentialsPath,
	legacyCredentialsPath,
	loginWithDeviceFlow,
	loginWithToken,
	systemClock,
} from "../daemon/runtime/auth/index.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/**
 * The login-flow seams the CLI runs against (AC-1 / AC-2). Both default to the REAL
 * `api.deeplake.ai` flows; the AC-named test injects fakes by passing `fetch` + `openBrowser` so no
 * network call and no real browser launch happens. A test can also inject the flow functions wholesale.
 */
export interface AuthLoginFlows {
	/** AC-1: the device-flow login (defaults to {@link loginWithDeviceFlow}). */
	readonly deviceFlow: typeof loginWithDeviceFlow;
	/** AC-2: the headless token login (defaults to {@link loginWithToken}). */
	readonly tokenLogin: typeof loginWithToken;
}

/**
 * The injectable deps the auth CLI runs against (AC-1 / AC-2 / AC-6). All default to the real impls;
 * the AC-named test injects a temp `dir`, a fake `clock`, an injected `env`, a fake `fetch`, a
 * recorder `openBrowser`, and a no-wait `sleep` so no real auth server, real `~/.deeplake`, real
 * wall clock, or real browser is touched.
 */
export interface AuthCommandDeps {
	/** Override the SHARED credentials directory (tests). */
	readonly dir?: string;
	/** Override the legacy `~/.honeycomb` dir for AC-6 cleanup (tests). */
	readonly legacyDir?: string;
	/** The clock used to stamp `savedAt` server-side (b-AC-4). */
	readonly clock?: Clock;
	/** The env (defaults to `process.env`) — resolves `HONEYCOMB_TOKEN` (AC-2) + apiUrl + org pin. */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). NEVER receives the bearer token. */
	readonly out?: OutputSink;
	/** The injectable auth `fetch` (defaults to the global `fetch`). */
	readonly fetch?: AuthFetch;
	/** The injectable browser opener (defaults to the validated OS opener). */
	readonly openBrowser?: BrowserOpener;
	/** The poll sleeper (defaults to the real wall clock); a test injects a no-wait one. */
	readonly sleep?: Sleeper;
	/** Override the login flows wholesale (tests / Wave 4); defaults to the real deeplake flows. */
	readonly flows?: AuthLoginFlows;
}

/** Outcome of a login/logout command: exit code + whether the file changed. */
export interface AuthResult {
	/** The process exit code (logout-with-no-file is SUCCESS — AC-6). */
	readonly exitCode: number;
	/** True iff a credentials file was written (login) or removed (logout). */
	readonly wrote: boolean;
}

/** The parsed `login`/`logout` invocation: the verb + the optional `--token` value (AC-2). */
export interface AuthInvocation {
	/** The sub-command word (`login` | `logout`). */
	readonly command: string;
	/** The `--token <key>` value, if supplied (AC-2 headless login). */
	readonly token?: string;
}

/**
 * Parse a raw argv tail into a typed {@link AuthInvocation}. The first non-flag word is the verb
 * (`login` | `logout`); `--token <key>` (or `--token=<key>`) supplies the headless token (AC-2).
 */
export function parseAuthArgs(argv: readonly string[]): AuthInvocation {
	let command = "";
	let token: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--token") {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				token = next;
				i += 1;
			}
		} else if (a.startsWith("--token=")) {
			token = a.slice("--token=".length);
		} else if (!a.startsWith("--") && command === "") {
			command = a;
		}
	}
	return token === undefined ? { command } : { command, token };
}

/** The dir argument the credentials helpers take (undefined = real home). */
function dirArg(dir?: string): string | undefined {
	return dir !== undefined && dir.length > 0 ? dir : undefined;
}

/** Resolve the deps with their real defaults. */
function withDefaults(deps: AuthCommandDeps): Required<Pick<AuthCommandDeps, "clock" | "env" | "out" | "flows">> & AuthCommandDeps {
	return {
		...deps,
		clock: deps.clock ?? systemClock,
		env: deps.env ?? process.env,
		out: deps.out ?? ((line: string): void => console.log(line)),
		flows: deps.flows ?? { deviceFlow: loginWithDeviceFlow, tokenLogin: loginWithToken },
	};
}

/** Print the logged-in identity WITHOUT the token (D-4). */
function reportLoggedIn(out: OutputSink, disk: DiskCredentials): void {
	const user = disk.userName !== undefined && disk.userName.length > 0 ? disk.userName : "(unknown user)";
	const ws = disk.workspaceId !== undefined && disk.workspaceId.length > 0 ? disk.workspaceId : "default";
	out(`Logged in as ${user} — org ${disk.orgName ?? disk.orgId} (${disk.orgId}), workspace ${ws}.`);
}

/**
 * `honeycomb login` — device flow (AC-1) or headless `--token`/`HONEYCOMB_TOKEN` (AC-2). On success
 * the shared `~/.deeplake/credentials.json` is written 0600 and the resolved identity is printed
 * WITHOUT the token. On any failure a redacted message is printed and a non-zero exit returned with
 * NO file written and NO token in the message (D-4).
 */
async function login(inv: AuthInvocation, deps: ReturnType<typeof withDefaults>): Promise<AuthResult> {
	const out = deps.out;
	// The headless token: the explicit `--token` arg wins, else `HONEYCOMB_TOKEN` (AC-2 / parity).
	const headlessToken = inv.token ?? deps.env.HONEYCOMB_TOKEN;

	let disk: DiskCredentials;
	try {
		if (headlessToken !== undefined && headlessToken.length > 0) {
			// AC-2: skip the browser, validate via /me, persist.
			disk = await deps.flows.tokenLogin(headlessToken, {
				dir: dirArg(deps.dir),
				clock: deps.clock,
				env: deps.env,
				...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
				...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
			});
		} else {
			// AC-1: the device flow. The reporter surfaces the URI + user code — never the token.
			disk = await deps.flows.deviceFlow({
				dir: dirArg(deps.dir),
				clock: deps.clock,
				env: deps.env,
				reporter: { prompt: (line: string): void => out(line) },
				...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
				...(deps.openBrowser !== undefined ? { openBrowser: deps.openBrowser } : {}),
				...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
			});
		}
	} catch (err) {
		// The error message carries the status + a truncated body — never the token (D-4).
		const reason = err instanceof Error ? err.message : "login failed";
		out(`error: login failed: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	reportLoggedIn(out, disk);
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb logout` — remove the SHARED `~/.deeplake/credentials.json` AND the legacy
 * `~/.honeycomb/credentials.json` if present (AC-6). Exits 0 even when neither exists; never throws
 * on a missing file. A removal failure (permission, EBUSY) is surfaced as a non-zero exit.
 */
function logout(deps: ReturnType<typeof withDefaults>): AuthResult {
	const out = deps.out;
	const targets = [credentialsPath(dirArg(deps.dir)), legacyCredentialsPath(deps.legacyDir)];
	let removed = false;
	for (const path of targets) {
		if (!existsSync(path)) continue;
		try {
			unlinkSync(path);
			removed = true;
		} catch (err) {
			const reason = err instanceof Error ? err.message : "could not remove credentials";
			out(`error: logout failed: ${reason}`);
			return { exitCode: 1, wrote: false };
		}
	}
	out(removed ? "Logged out. Credentials removed." : "Not logged in.");
	// AC-6: exit 0 whether or not a file existed — a script can run logout unconditionally.
	return { exitCode: 0, wrote: removed };
}

/**
 * Run a parsed `login`/`logout` command (AC-1 / AC-2 / AC-6). The seams are injected so the AC-named
 * test drives the whole surface against a fake fetch + a recorder opener (no auth server, no real
 * home dir, no real browser).
 */
export async function runAuthCommand(inv: AuthInvocation, deps: AuthCommandDeps = {}): Promise<AuthResult> {
	const resolved = withDefaults(deps);
	if (inv.command === "login") return login(inv, resolved);
	if (inv.command === "logout") return logout(resolved);
	resolved.out("usage: honeycomb <login [--token <key>] | logout>");
	return { exitCode: inv.command === "" ? 0 : 1, wrote: false };
}

/** Convenience entry: parse + run a login/logout argv tail in one call. */
export function authMain(argv: readonly string[], deps: AuthCommandDeps = {}): Promise<AuthResult> {
	return runAuthCommand(parseAuthArgs(argv), deps);
}
