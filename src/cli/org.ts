/**
 * `honeycomb org` / `workspace` / `status` CLI — PRD-011a (a-AC-3 / a-AC-6).
 *
 * The tenancy-switching command surface, scoped by org / workspace:
 *   - `honeycomb org switch <org>`      — re-mint a FRESH org-bound token via the
 *     {@link TokenIssuer} and persist it (a-AC-3 / FR-4). The org is baked into the
 *     token claim, so switching orgs re-mints rather than editing a field.
 *   - `honeycomb workspace use <ws>`    — update ONLY the credentials file's
 *     workspace (a-AC-3 / FR-5). No token re-mint — the workspace resolves
 *     server-side, so the same org-bound token serves a different workspace.
 *   - `honeycomb status`                — print org id/name, workspace, and agent;
 *     NEVER the bearer token (a-AC-6 / FR-6).
 *
 * ── Boundary: the CLI imports NO DeepLake path (invariant.test.ts) ──────────
 * This is a thin client: it imports neither `src/daemon/storage` nor the daemon
 * core. It reaches the credentials FILE through the CredentialsStore helpers
 * (`loadCredentials`/`saveCredentials`) and mints tokens through an INJECTED
 * {@link TokenIssuer} seam (the daemon-assembly wiring supplies the real one; the
 * AC-named test supplies a fake). The credentials helpers touch `node:fs` + the
 * user's home dir only — they open NO DeepLake connection — so the storage-import
 * invariant holds.
 *
 * Note: the bundled `honeycomb` bin is not yet extended to dispatch here; that is
 * the deferred pure-wiring assembly step. This module is constructed-and-tested
 * (the AC-named CLI test drives {@link runOrgCommand} with fakes).
 */

import type { Credentials, MintedToken, TokenIssuer } from "../daemon/runtime/auth/contracts.js";
import {
	type Clock,
	loadCredentials,
	saveCredentials,
	systemClock,
} from "../daemon/runtime/auth/credentials-store.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/**
 * The injectable seams the org CLI runs against (a-AC-3). All default to the real
 * impls; the AC-named test injects fakes (a fake {@link TokenIssuer}, a temp `dir`,
 * a fake {@link Clock}) so no real auth server or real `~/.honeycomb` is touched.
 */
export interface OrgCommandDeps {
	/** Mints fresh org-bound tokens for `org switch` (a-AC-3). */
	readonly issuer: TokenIssuer;
	/** Override the credentials directory (tests). */
	readonly dir?: string;
	/** The clock used to stamp `savedAt` server-side (b-AC-4). */
	readonly clock?: Clock;
	/** The env (defaults to `process.env`) — the token-env rule applies on load. */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). */
	readonly out?: OutputSink;
}

/** Outcome of an org/workspace/status command: exit code + whether the file changed. */
export interface OrgResult {
	readonly exitCode: number;
	/** True iff the credentials file was written (org switch / workspace use). */
	readonly wrote: boolean;
}

/** The parsed `org`/`workspace`/`status` invocation: the sub-command path + its arg. */
export interface OrgInvocation {
	/** The sub-command words (e.g. `["org", "switch"]` or `["status"]`). */
	readonly path: readonly string[];
	/** The positional argument (the org id or workspace id), if any. */
	readonly arg?: string;
}

/**
 * Parse a raw argv tail into a typed {@link OrgInvocation}. The first non-flag word
 * is the command group (`org` | `workspace` | `status`), the second its verb
 * (`switch` | `use`), and the third the positional arg (the org/workspace id).
 */
export function parseOrgArgs(argv: readonly string[]): OrgInvocation {
	const words = argv.filter((a) => !a.startsWith("--"));
	const path: string[] = [];
	let arg: string | undefined;
	// `org switch <org>` / `workspace use <ws>` → two command words + one arg.
	// `status` → one command word, no arg.
	if (words[0] === "status") {
		path.push("status");
	} else if (words[0] === "org" || words[0] === "workspace") {
		path.push(words[0]);
		if (words[1] !== undefined) path.push(words[1]);
		if (words[2] !== undefined) arg = words[2];
	} else {
		for (const w of words) path.push(w);
	}
	return arg === undefined ? { path } : { path, arg };
}

/** Resolve the deps with their real defaults. */
function withDefaults(deps: OrgCommandDeps): Required<Omit<OrgCommandDeps, "issuer">> & { issuer: TokenIssuer } {
	return {
		issuer: deps.issuer,
		dir: deps.dir ?? "",
		clock: deps.clock ?? systemClock,
		env: deps.env ?? process.env,
		out: deps.out ?? ((line: string): void => console.log(line)),
	};
}

/** The dir argument the CredentialsStore helpers take (undefined = real home). */
function dirArg(dir: string): string | undefined {
	return dir.length > 0 ? dir : undefined;
}

/**
 * `honeycomb org switch <org>` — re-mint a fresh org-bound token and persist it
 * (a-AC-3 / FR-4). The new token's claims drive the saved org id/name; the
 * workspace + agent carry over from the existing credentials (or default). The
 * token is never printed.
 */
async function orgSwitch(org: string, deps: ReturnType<typeof withDefaults>): Promise<OrgResult> {
	const out = deps.out;
	if (org === "") {
		out("usage: honeycomb org switch <org>");
		return { exitCode: 1, wrote: false };
	}
	let minted: MintedToken;
	try {
		// Re-mint: the org is baked into the token claim, so a switch mints anew.
		minted = await deps.issuer.reMint(org);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "re-mint failed";
		out(`error: could not switch org to ${org}: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	const existing = loadCredentials(dirArg(deps.dir), deps.env);
	const next: Credentials = {
		token: minted.token,
		orgId: minted.claims.org,
		orgName: minted.claims.org, // 011b resolves a human org name; the id is the safe default here.
		workspace: minted.claims.workspace ?? existing?.workspace ?? "default",
		agentId: minted.claims.agentId ?? existing?.agentId ?? "default",
		savedAt: "", // stamped server-side by saveCredentials (b-AC-4).
	};
	saveCredentials(next, dirArg(deps.dir), deps.clock);
	out(`Switched to org ${next.orgId}. A fresh org-bound token was minted and saved.`);
	// The token is NEVER printed (a-AC-6 discipline extends to switch output).
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb workspace use <ws>` — update ONLY the credentials file's workspace
 * (a-AC-3 / FR-5). No token re-mint: the workspace resolves server-side, so the
 * same org-bound token serves the new workspace.
 */
function workspaceUse(workspace: string, deps: ReturnType<typeof withDefaults>): OrgResult {
	const out = deps.out;
	if (workspace === "") {
		out("usage: honeycomb workspace use <workspace>");
		return { exitCode: 1, wrote: false };
	}
	const existing = loadCredentials(dirArg(deps.dir), deps.env);
	if (existing === null) {
		out("Not logged in. Run `honeycomb login` first.");
		return { exitCode: 1, wrote: false };
	}
	// Update ONLY the workspace; the token is untouched (no re-mint — FR-5).
	const next: Credentials = { ...existing, workspace };
	saveCredentials(next, dirArg(deps.dir), deps.clock);
	out(`Workspace set to ${workspace}. (No token re-mint — the workspace resolves server-side.)`);
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb status` — print org id/name, workspace, and agent; NEVER the bearer
 * token (a-AC-6 / FR-6). When not logged in, print a clear message + a non-error
 * exit so a script can branch on it.
 */
function status(deps: ReturnType<typeof withDefaults>): OrgResult {
	const out = deps.out;
	const creds = loadCredentials(dirArg(deps.dir), deps.env);
	if (creds === null) {
		out("Not logged in. Run `honeycomb login`.");
		return { exitCode: 0, wrote: false };
	}
	// Print every identity field EXCEPT the token (a-AC-6). The token is a secret;
	// it never appears in status output.
	out(`org id:     ${creds.orgId}`);
	out(`org name:   ${creds.orgName}`);
	out(`workspace:  ${creds.workspace}`);
	out(`agent:      ${creds.agentId}`);
	return { exitCode: 0, wrote: false };
}

/**
 * Run a parsed `org`/`workspace`/`status` command (a-AC-3 / a-AC-6). The seams are
 * injected so the AC-named test drives the whole surface against fakes (a fake
 * issuer, a temp dir, a fake clock) without an auth server or the real home dir.
 */
export async function runOrgCommand(inv: OrgInvocation, deps: OrgCommandDeps): Promise<OrgResult> {
	const resolved = withDefaults(deps);
	const sub = inv.path.join(" ");

	if (sub === "org switch") return orgSwitch(inv.arg ?? "", resolved);
	if (sub === "workspace use") return workspaceUse(inv.arg ?? "", resolved);
	if (sub === "status") return status(resolved);

	resolved.out("usage: honeycomb <org switch <org> | workspace use <ws> | status>");
	return { exitCode: sub === "" ? 0 : 1, wrote: false };
}

/** Convenience entry: parse + run an org/workspace/status argv tail in one call. */
export function orgMain(argv: readonly string[], deps: OrgCommandDeps): Promise<OrgResult> {
	return runOrgCommand(parseOrgArgs(argv), deps);
}
