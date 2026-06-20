/**
 * `honeycomb whoami` CLI — PRD-023 Wave 3 (AC-3).
 *
 * The identity-inspection command, ported to the REAL `api.deeplake.ai` backend so it reports the
 * SAME authenticated identity Hivemind would (one shared `~/.deeplake/credentials.json`, D-1). It
 * reads the persisted credential, validates the bearer token live via `GET /me`
 * ({@link DeeplakeAuthClient.getMe}), and prints the authenticated user + the active org (name + id)
 * + the active workspace. A file `hivemind login` wrote loads here unchanged (the disk shape is
 * byte-cross-compatible) — that cross-tool read is the heart of AC-3.
 *
 * ── Boundary: the CLI imports NO DeepLake storage path (invariant.test.ts) ──────
 * Thin client: it imports neither `src/daemon/storage` nor the daemon core. It reaches the
 * credentials FILE + the auth backend through `src/daemon/runtime/auth` (the credentials-store
 * loaders + the auth client), which touch `node:fs` + the auth HTTP API only — no DeepLake
 * connection — so the storage-import invariant holds. The HTTP `fetch` is a SEAM (injectable) so
 * the AC-named test drives the whole surface against a fake client with no network.
 *
 * ── The token is a secret — never printed (D-4) ─────────────────────────────────
 * `whoami` prints the user / org / workspace but NEVER the bearer token. There is no code path here
 * that writes the token to stdout/stderr; an HTTP failure surfaces the status + a redacted message
 * (never the token). The grep-asserted token-absence test in `tests/cli/whoami.test.ts` proves it.
 */

import {
	type DiskCredentials,
	type MeResponse,
	createDeeplakeAuthClient,
	loadDiskCredentials,
	resolveApiUrl,
} from "../daemon/runtime/auth/index.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/**
 * The auth-client seam `whoami` validates the token through (AC-3). Only `getMe` is needed; the
 * full {@link DeeplakeAuthClient} satisfies it, and a test injects a minimal fake. Factoring it as a
 * one-method interface keeps the test's fake trivial and the dependency honest.
 */
export interface WhoamiAuthClient {
	/** `GET /me` — validate the token + return the authenticated user (AC-3). */
	getMe(token: string, orgId?: string): Promise<MeResponse>;
}

/**
 * The injectable deps the `whoami` command runs against (AC-3). All default to the real impls; the
 * AC-named test injects a temp `dir`, an injected `env`, a fake `client`, and a capturing `out` so
 * no real auth server, real `~/.deeplake`, or real stdout is touched.
 */
export interface WhoamiCommandDeps {
	/** Override the SHARED credentials directory (tests). Defaults to the real `~/.deeplake`. */
	readonly dir?: string;
	/** Override the legacy `~/.honeycomb` dir for the read-fallback (tests). */
	readonly legacyDir?: string;
	/** The env (defaults to `process.env`) — resolves apiUrl + the `HONEYCOMB_TOKEN` rule. */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). NEVER receives the bearer token. */
	readonly out?: OutputSink;
	/** The auth-client seam (defaults to the real `api.deeplake.ai` client). */
	readonly client?: WhoamiAuthClient;
}

/** Outcome of a `whoami` command: the process exit code. */
export interface WhoamiResult {
	/** 0 when logged in + the token validated; non-zero when not logged in or validation failed. */
	readonly exitCode: number;
}

/** The dir argument the credentials helpers take (undefined = real home). */
function dirArg(dir?: string): string | undefined {
	return dir !== undefined && dir.length > 0 ? dir : undefined;
}

/**
 * Resolve the auth client from the deps (the injected fake, or a real client bound to the resolved
 * apiUrl — the credential's `apiUrl` wins, else the env / default). The token NEVER reaches the URL.
 */
function resolveClient(deps: WhoamiCommandDeps, disk: DiskCredentials): WhoamiAuthClient {
	if (deps.client !== undefined) return deps.client;
	const env = deps.env ?? process.env;
	const apiUrl = disk.apiUrl !== undefined && disk.apiUrl.length > 0 ? disk.apiUrl : resolveApiUrl(env);
	return createDeeplakeAuthClient({ apiUrl });
}

/**
 * `honeycomb whoami` (AC-3) — print the authenticated user + active org (name + id) + workspace.
 * Reads the shared `~/.deeplake/credentials.json` (a `hivemind login` file loads unchanged), then
 * validates the token live via `GET /me`. The token is NEVER printed. When not logged in, prints a
 * clean "run `honeycomb login`" message and returns a non-zero exit. A token that fails validation
 * (revoked / expired) surfaces a redacted error and a non-zero exit (the message carries the status,
 * never the token).
 */
export async function runWhoamiCommand(deps: WhoamiCommandDeps = {}): Promise<WhoamiResult> {
	const out = deps.out ?? ((line: string): void => console.log(line));
	const env = deps.env ?? process.env;

	const disk = loadDiskCredentials(dirArg(deps.dir), env, deps.legacyDir);
	if (disk === null) {
		out("Not logged in — run `honeycomb login`.");
		return { exitCode: 1 };
	}

	const client = resolveClient(deps, disk);
	let me: MeResponse;
	try {
		// `GET /me` validates the token AND supplies the authoritative user identity (AC-3).
		me = await client.getMe(disk.token, disk.orgId);
	} catch (err) {
		// The error message carries the status + a truncated body — never the token (D-4).
		const reason = err instanceof Error ? err.message : "could not validate the session";
		out(`error: whoami failed: ${reason}`);
		return { exitCode: 1 };
	}

	// The display user prefers `/me`'s live name, then the persisted `userName`, then a sentinel.
	const liveName = me.name.length > 0 ? me.name : me.email !== undefined && me.email.length > 0 ? me.email : "";
	const user =
		liveName.length > 0
			? liveName
			: disk.userName !== undefined && disk.userName.length > 0
				? disk.userName
				: "(unknown user)";
	const orgName = disk.orgName !== undefined && disk.orgName.length > 0 ? disk.orgName : disk.orgId;
	const workspace = disk.workspaceId !== undefined && disk.workspaceId.length > 0 ? disk.workspaceId : "default";

	out(`User:       ${user}`);
	out(`Org:        ${orgName} (${disk.orgId})`);
	out(`Workspace:  ${workspace}`);
	// The token is NEVER printed (D-4) — only the identity fields above reach stdout.
	return { exitCode: 0 };
}

/** Convenience entry: run `whoami` from an argv tail (the verb has no positional args). */
export function whoamiMain(_argv: readonly string[], deps: WhoamiCommandDeps = {}): Promise<WhoamiResult> {
	return runWhoamiCommand(deps);
}
