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
import { createInterface } from "node:readline";

import {
	type AuthFetch,
	type BrowserOpener,
	type Clock,
	type Credentials,
	credentialsPath,
	type DiskCredentials,
	encodeStubToken,
	legacyCredentialsPath,
	loginWithDeviceFlow,
	loginWithToken,
	type Sleeper,
	saveCredentials,
	systemClock,
	type TenancyCandidates,
	type TenancySelector,
} from "../daemon/runtime/auth/index.js";
import { redactEndpointCredentials } from "../shared/redact-endpoint.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export type OutputSink = (line: string) => void;

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
	/**
	 * PRD-073d: whether stdin+stdout are a TTY (interactive). Injectable so tests drive the prompt vs
	 * refusal branch deterministically. Defaults to `process.stdin.isTTY && process.stdout.isTTY`.
	 */
	readonly isTTY?: boolean;
	/**
	 * PRD-073d: the interactive prompt reader (a question → the user's typed line). Injectable so the
	 * suite scripts answers with no real stdin. Defaults to a `node:readline` reader (used only on a TTY).
	 */
	readonly prompt?: (question: string) => Promise<string>;
}

/** Outcome of a login/logout command: exit code + whether the file changed. */
export interface AuthResult {
	/** The process exit code (logout-with-no-file is SUCCESS — AC-6). */
	readonly exitCode: number;
	/** True iff a credentials file was written (login) or removed (logout). */
	readonly wrote: boolean;
}

/**
 * The parsed `login`/`logout` invocation: the verb plus the optional value flags.
 * `--token` is the headless token (AC-2); `--endpoint`/`--org`/`--workspace` drive
 * the self-hosted-login path (point honeycomb at a self-hosted backend WITHOUT
 * dialing api.deeplake.ai). All are absent for a plain `login`/`logout`.
 */
export interface AuthInvocation {
	/** The sub-command word (`login` | `logout`). */
	readonly command: string;
	/** The `--token <key>` value, if supplied (AC-2 headless login). */
	readonly token?: string;
	/** The `--endpoint <url>` value: self-hosted backend URL (HTTP gateway or postgres://). */
	readonly endpoint?: string;
	/** The `--org <id>` value for the self-hosted credential (defaults to `local`). */
	readonly org?: string;
	/** The `--workspace <id>` value for the self-hosted credential (defaults to `default`). */
	readonly workspace?: string;
}

/** The value-taking flags `parseAuthArgs` understands (`--flag value` or `--flag=value`). */
const AUTH_VALUE_FLAGS = ["token", "endpoint", "org", "workspace"] as const;

/**
 * Parse a raw argv tail into a typed {@link AuthInvocation}. The first non-flag word is the verb
 * (`login` | `logout`); each `--<flag> <value>` (or `--<flag>=<value>`) in {@link AUTH_VALUE_FLAGS}
 * is captured. `--token` supplies the headless token (AC-2); `--endpoint`/`--org`/`--workspace`
 * select the self-hosted-login path.
 */
export function parseAuthArgs(argv: readonly string[]): AuthInvocation {
	let command = "";
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		let consumed = false;
		for (const name of AUTH_VALUE_FLAGS) {
			if (a === `--${name}`) {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[name] = next;
					i += 1;
				} else {
					// A bare `--<flag>` (no value, or followed by another flag): record it
					// as empty so a value-less `--endpoint` is rejected by the caller
					// rather than silently ignored (which would fall back to hosted login).
					flags[name] = "";
				}
				consumed = true;
				break;
			}
			if (a.startsWith(`--${name}=`)) {
				flags[name] = a.slice(`--${name}=`.length);
				consumed = true;
				break;
			}
		}
		if (consumed) continue;
		if (!a.startsWith("--") && command === "") command = a;
	}
	return {
		command,
		...(flags.token !== undefined ? { token: flags.token } : {}),
		...(flags.endpoint !== undefined ? { endpoint: flags.endpoint } : {}),
		...(flags.org !== undefined ? { org: flags.org } : {}),
		...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
	};
}

/** The dir argument the credentials helpers take (undefined = real home). */
function dirArg(dir?: string): string | undefined {
	return dir !== undefined && dir.length > 0 ? dir : undefined;
}

/** Resolve the deps with their real defaults. */
function withDefaults(
	deps: AuthCommandDeps,
): Required<Pick<AuthCommandDeps, "clock" | "env" | "out" | "flows">> & AuthCommandDeps {
	return {
		...deps,
		clock: deps.clock ?? systemClock,
		env: deps.env ?? process.env,
		out: deps.out ?? ((line: string): void => console.log(line)),
		flows: deps.flows ?? { deviceFlow: loginWithDeviceFlow, tokenLogin: loginWithToken },
	};
}

/** A default `node:readline` prompt reader — used only on a real TTY; the suite injects a scripted one. */
function defaultPrompt(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise<string>((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

/**
 * Build the PRD-073d tenancy selector the CLI hands to the login flows. Only INVOKED by the issuer for
 * a multi-tenancy account (env pins + single-tenancy auto-select short-circuit before it). Resolves
 * `--org`/`--workspace` flags (by name or id) against the enumerated lists; on a TTY prompts a numbered
 * picker for the unfixed half; on a non-TTY with no flag it REFUSES with an actionable, org-listing
 * error and writes NOTHING (parent AC-6 / 073d-AC-2). An unknown flag value also refuses.
 */
function buildTenancySelector(inv: AuthInvocation, deps: ReturnType<typeof withDefaults>): TenancySelector {
	const orgFlag = inv.org !== undefined && inv.org.trim().length > 0 ? inv.org.trim() : undefined;
	const wsFlag = inv.workspace !== undefined && inv.workspace.trim().length > 0 ? inv.workspace.trim() : undefined;
	const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const promptFn = deps.prompt ?? defaultPrompt;

	return async (candidates: TenancyCandidates): Promise<{ orgId: string; workspaceId: string }> => {
		const orgId = await resolveOrg(candidates.orgs, orgFlag, isTTY, promptFn);
		const workspaces = await candidates.listWorkspaces(orgId);
		const workspaceId = await resolveWorkspace(candidates.orgs, workspaces, wsFlag, isTTY, promptFn);
		return { orgId, workspaceId };
	};
}

/** Resolve the chosen org id from a flag / prompt / refusal (073d). */
async function resolveOrg(
	orgs: TenancyCandidates["orgs"],
	flag: string | undefined,
	isTTY: boolean,
	promptFn: (q: string) => Promise<string>,
): Promise<string> {
	if (flag !== undefined) {
		const lc = flag.toLowerCase();
		const match = orgs.find((o) => o.id === flag || o.name.toLowerCase() === lc);
		if (match === undefined) throw new Error(`no organization named or id'd "${flag}" is accessible to this account`);
		return match.id;
	}
	if (orgs.length === 1) return orgs[0].id;
	if (!isTTY) throw new Error(refusalMessage(orgs));
	return promptPick("Select an organization", orgs, promptFn);
}

/** Resolve the chosen workspace id from a flag / prompt / auto (073d). */
async function resolveWorkspace(
	orgs: TenancyCandidates["orgs"],
	workspaces: readonly { id: string; name: string }[],
	flag: string | undefined,
	isTTY: boolean,
	promptFn: (q: string) => Promise<string>,
): Promise<string> {
	if (flag !== undefined) {
		if (flag.toLowerCase() === "default") return "default";
		const lc = flag.toLowerCase();
		const match = workspaces.find((w) => w.id === flag || w.name.toLowerCase() === lc);
		if (match === undefined) throw new Error(`no workspace named or id'd "${flag}" in the chosen organization`);
		return match.id;
	}
	if (workspaces.length === 0) return "default";
	if (workspaces.length === 1) return workspaces[0].id;
	if (!isTTY) throw new Error(refusalMessage(orgs));
	return promptPick("Select a workspace", workspaces, promptFn);
}

/** The non-TTY refusal message: names the orgs + the required flags (073d-AC-2.1). NO token. */
function refusalMessage(orgs: TenancyCandidates["orgs"]): string {
	const list = orgs.map((o) => `${o.name} (${o.id})`).join(", ");
	return `this account has multiple organizations or workspaces; re-run with --org <name|id> --workspace <name|id>. Available orgs: ${list}`;
}

/** Render a numbered picker, read the answer, and return the chosen entity id (re-prompts on a bad answer). */
async function promptPick(
	title: string,
	items: readonly { id: string; name: string }[],
	promptFn: (q: string) => Promise<string>,
): Promise<string> {
	const lines = items.map((it, i) => `  ${i + 1}. ${it.name} (${it.id})`).join("\n");
	// One re-prompt on an out-of-range/blank answer, then give up (the selector throws → login refuses).
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const answer = (await promptFn(`${title}:\n${lines}\nEnter a number: `)).trim();
		const n = Number.parseInt(answer, 10);
		if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].id;
	}
	throw new Error(`no valid ${title.toLowerCase()} was chosen`);
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
	// Self-hosted-login path (`--endpoint`): point honeycomb at a self-hosted backend
	// WITHOUT dialing api.deeplake.ai. SKIPS the device flow AND the `GET /me` validation,
	// and writes the shared credential directly with the supplied apiUrl. Purely additive:
	// with NO `--endpoint`, every existing login behavior below is unchanged.
	// An explicit but empty `--endpoint` (a bare flag or `--endpoint=`) means the user
	// asked for the self-hosted path but gave no URL. Reject it instead of silently
	// falling back to the hosted flow, which could dial api.deeplake.ai.
	if (inv.endpoint !== undefined && inv.endpoint.length === 0) {
		out("error: login --endpoint requires a URL (e.g. --endpoint https://host or --endpoint postgres://host/db)");
		return { exitCode: 1, wrote: false };
	}
	if (inv.endpoint !== undefined) {
		return loginSelfHosted(inv, inv.endpoint, deps);
	}
	// The headless token: the explicit `--token` arg wins, else `HONEYCOMB_TOKEN` (AC-2 / parity).
	const headlessToken = inv.token ?? deps.env.HONEYCOMB_TOKEN;
	// PRD-073d: the explicit tenancy selector (flags/prompt/refusal). The issuer only invokes it for a
	// multi-tenancy account — env pins and single-tenancy accounts auto-select before it (parent AC-8/10).
	const selectTenancy = buildTenancySelector(inv, deps);

	let disk: DiskCredentials;
	try {
		if (headlessToken !== undefined && headlessToken.length > 0) {
			// AC-2: skip the browser, validate via /me, persist. Tenancy still requires an explicit choice.
			disk = await deps.flows.tokenLogin(headlessToken, {
				dir: dirArg(deps.dir),
				clock: deps.clock,
				env: deps.env,
				selectTenancy,
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
				selectTenancy,
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
 * `honeycomb login --endpoint <url> [--token <tok>] [--org <o>] [--workspace <w>]` (self-hosted).
 *
 * The one supported command to point honeycomb at a self-hosted backend instead of env-var or
 * hand-edit gymnastics, and WITHOUT any call to api.deeplake.ai. It skips the device flow and the
 * `GET /me` validation entirely and writes the shared `~/.deeplake/credentials.json` (0600) directly
 * with `apiUrl = <endpoint>`, the token, the org (default `local`), and the workspace (default
 * `default`), through the same {@link saveCredentials} discipline (dir 0700 / file 0600 / server-
 * stamped `savedAt`) as every other login.
 *
 * When `--token` is omitted (and no `HONEYCOMB_TOKEN` is set) a LOCAL stub token is minted via the
 * existing {@link encodeStubToken} machinery, bound to the supplied org/workspace, so a self-hoster
 * needs no Activeloop token at all. The minted token round-trips `verifyTokenClaims`, so the daemon's
 * tenancy-integrity gate (file orgId must match the token's org claim) passes for the default org.
 *
 * The token is NEVER printed (D-4): the success line names the endpoint, org, and workspace only.
 *
 * KNOWN LIMITATION (open question for the maintainer): only this direct-write login skips
 * api.deeplake.ai. `honeycomb login` (device/headless) and `honeycomb org switch` still dial
 * api.deeplake.ai for their auth/re-mint, so a fully self-hosted deployment must use THIS path to
 * establish the credential and avoid those verbs until a self-hosted auth issuer exists.
 */
function loginSelfHosted(inv: AuthInvocation, endpoint: string, deps: ReturnType<typeof withDefaults>): AuthResult {
	const out = deps.out;
	const org = inv.org !== undefined && inv.org.length > 0 ? inv.org : "local";
	const workspace = inv.workspace !== undefined && inv.workspace.length > 0 ? inv.workspace : "default";
	// The token: an explicit `--token` (or `HONEYCOMB_TOKEN`) wins; otherwise mint a LOCAL stub
	// bound to this org/workspace so no Activeloop token is needed for a self-hosted backend.
	// Empty strings (`--token=` or `HONEYCOMB_TOKEN=""`) are treated as ABSENT, so we mint the
	// stub instead of persisting a broken empty bearer token (`??` alone would keep the "").
	const explicitToken = inv.token !== undefined && inv.token.length > 0 ? inv.token : undefined;
	const envToken =
		deps.env.HONEYCOMB_TOKEN !== undefined && deps.env.HONEYCOMB_TOKEN.length > 0
			? deps.env.HONEYCOMB_TOKEN
			: undefined;
	const token = explicitToken ?? envToken ?? encodeStubToken({ org, workspace, agentId: "default", role: "admin" });

	const creds: Credentials = {
		token,
		orgId: org,
		orgName: org,
		workspace,
		agentId: "default",
		savedAt: "", // stamped server-side by saveCredentials (b-AC-4).
	};
	try {
		// Thread the endpoint through as the on-disk apiUrl (instead of the hardcoded default).
		saveCredentials(creds, dirArg(deps.dir), deps.clock, endpoint);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "could not write credentials";
		out(`error: login failed: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	out(`Logged in to self-hosted backend ${redactEndpointCredentials(endpoint)}. Org ${org}, workspace ${workspace}.`);
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
	resolved.out("usage: honeycomb <login [--token <key>] [--endpoint <url> [--org <o>] [--workspace <w>]] | logout>");
	return { exitCode: inv.command === "" ? 0 : 1, wrote: false };
}

/** Convenience entry: parse + run a login/logout argv tail in one call. */
export function authMain(argv: readonly string[], deps: AuthCommandDeps = {}): Promise<AuthResult> {
	return runAuthCommand(parseAuthArgs(argv), deps);
}
