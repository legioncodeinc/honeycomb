/**
 * `honeycomb org` / `workspace` / `status` CLI — PRD-011a + PRD-023 Wave 3 (AC-4 / AC-5).
 *
 * The tenancy-listing + switching command surface, scoped by org / workspace. PRD-023 Wave 3
 * MIGRATES the switch verbs off the PRD-011 stub {@link TokenIssuer} onto the REAL `api.deeplake.ai`
 * Wave-2 client ({@link DeeplakeAuthClient}) so one shared `~/.deeplake/credentials.json` (D-1) drives
 * both Honeycomb and Hivemind:
 *
 *   - `honeycomb org list`              — `GET /organizations` ({@link DeeplakeAuthClient.listOrgs});
 *     print the orgs the user can access, marking the active one (AC-4). New.
 *   - `honeycomb org switch <name|id>`  — resolve the target from `listOrgs` (accept a NAME or an id),
 *     re-mint a fresh org-bound token ({@link DeeplakeAuthClient.reMint}), and persist the new token +
 *     orgId + orgName to the SHARED file via {@link saveDiskCredentials} (AC-4). The org is baked into
 *     the token claim, so switching re-mints rather than editing a field.
 *   - `honeycomb workspaces` (alias `workspace list`) — `GET /workspaces`
 *     ({@link DeeplakeAuthClient.listWorkspaces}); print the org's workspaces, marking the active one
 *     (AC-5). New.
 *   - `honeycomb workspace switch <name|id>` — update ONLY the shared file's `workspaceId` (resolve a
 *     NAME → id via `listWorkspaces`); no token re-mint (the workspace resolves server-side, AC-5). New.
 *   - `honeycomb workspace use <ws>`    — the PRD-011a back-compat alias for `workspace switch` (kept
 *     so existing scripts/tests keep working); updates the workspace id only.
 *   - `honeycomb status`                — print org id/name, workspace, and agent; NEVER the bearer
 *     token (a-AC-6 / FR-6).
 *
 * ── Boundary: the CLI imports NO DeepLake path (invariant.test.ts) ──────────
 * Thin client: it imports neither `src/daemon/storage` nor the daemon core. It reaches the
 * credentials FILE through the credentials-store helpers (`loadCredentials`/`loadDiskCredentials`/
 * `saveCredentials`/`saveDiskCredentials`) and the auth backend through the INJECTED
 * {@link DeeplakeAuthClient} seam (the runtime assembly supplies the real one; the AC-named test
 * supplies a fake). The credentials helpers touch `node:fs` + the user's home dir only — they open NO
 * DeepLake connection — so the storage-import invariant holds.
 *
 * ── The token is a SECRET (D-4) ─────────────────────────────────────────────
 * No verb here logs, prints, echoes, or URL-embeds the bearer token. `org switch` re-mints a new
 * token and persists it silently (the success line names the org only); `org list` / `workspaces`
 * print names + ids only; `status` prints every identity field EXCEPT the token. The token rides in
 * the `Authorization` header inside the auth client, never a log line.
 */

import type { Credentials, MintedToken, TokenIssuer } from "../daemon/runtime/auth/contracts.js";
import {
	type Clock,
	type DeeplakeAuthClient,
	type DiskCredentials,
	type OrgRow,
	type WorkspaceRow,
	createDeeplakeAuthClient,
	loadCredentials,
	loadDiskCredentials,
	resolveApiUrl,
	saveDiskCredentials,
	systemClock,
} from "../daemon/runtime/auth/index.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/**
 * The injectable seams the org CLI runs against (AC-4 / AC-5). The PRD-011a {@link TokenIssuer} is
 * kept OPTIONAL for back-compat (only the legacy `org switch`-via-stub path uses it; the real path
 * uses {@link client}); the AC-named test injects fakes (a fake {@link DeeplakeAuthClient}, a temp
 * `dir`, a fake {@link Clock}) so no real auth server or real `~/.deeplake` is touched.
 */
export interface OrgCommandDeps {
	/**
	 * The REAL `api.deeplake.ai` client driving `org list` / `org switch` / `workspaces` /
	 * `workspace switch` (PRD-023 Wave 3, AC-4 / AC-5). Defaults to a client bound to the credential's
	 * `apiUrl` (or the env / default). The AC-named test injects a fake.
	 */
	readonly client?: DeeplakeAuthClient;
	/**
	 * The PRD-011 stub issuer — RETAINED for back-compat only (unused by the real switch path). A
	 * caller that still wires the stub issuer keeps type-checking; new wiring should pass `client`.
	 */
	readonly issuer?: TokenIssuer;
	/** Override the credentials directory (tests). */
	readonly dir?: string;
	/** Override the legacy `~/.honeycomb` dir for the read-fallback (tests). */
	readonly legacyDir?: string;
	/** The clock used to stamp `savedAt` server-side (b-AC-4). */
	readonly clock?: Clock;
	/** The env (defaults to `process.env`) — the token-env rule + apiUrl resolution apply. */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). NEVER receives the bearer token. */
	readonly out?: OutputSink;
}

/** Outcome of an org/workspace/status command: exit code + whether the file changed. */
export interface OrgResult {
	readonly exitCode: number;
	/** True iff the credentials file was written (org switch / workspace switch / use). */
	readonly wrote: boolean;
}

/** The parsed `org`/`workspace`/`workspaces`/`status` invocation: the sub-command path + its arg. */
export interface OrgInvocation {
	/** The sub-command words (e.g. `["org", "switch"]`, `["workspaces"]`, or `["status"]`). */
	readonly path: readonly string[];
	/** The positional argument (the org/workspace name or id), if any. */
	readonly arg?: string;
}

/**
 * Parse a raw argv tail into a typed {@link OrgInvocation}. The first non-flag word is the command
 * group (`org` | `workspace` | `workspaces` | `status`), the second its verb (`list` | `switch` |
 * `use`), and the third the positional arg (the org/workspace name or id). `workspaces` and `status`
 * are single-word commands (no verb); `workspaces` carries no arg.
 */
export function parseOrgArgs(argv: readonly string[]): OrgInvocation {
	const words = argv.filter((a) => !a.startsWith("--"));
	const path: string[] = [];
	let arg: string | undefined;
	if (words[0] === "status" || words[0] === "workspaces") {
		// Single-word commands: `status`, `workspaces` (the `workspace list` alias is handled below).
		path.push(words[0]);
	} else if (words[0] === "org" || words[0] === "workspace") {
		path.push(words[0]);
		if (words[1] !== undefined) path.push(words[1]);
		if (words[2] !== undefined) arg = words[2];
	} else {
		for (const w of words) path.push(w);
	}
	return arg === undefined ? { path } : { path, arg };
}

/** The resolved deps with their real defaults (issuer/client stay optional). */
interface ResolvedOrgDeps {
	readonly client?: DeeplakeAuthClient;
	readonly issuer?: TokenIssuer;
	readonly dir: string;
	readonly legacyDir?: string;
	readonly clock: Clock;
	readonly env: NodeJS.ProcessEnv;
	readonly out: OutputSink;
}

/** Resolve the deps with their real defaults. */
function withDefaults(deps: OrgCommandDeps): ResolvedOrgDeps {
	return {
		...(deps.client !== undefined ? { client: deps.client } : {}),
		...(deps.issuer !== undefined ? { issuer: deps.issuer } : {}),
		dir: deps.dir ?? "",
		...(deps.legacyDir !== undefined ? { legacyDir: deps.legacyDir } : {}),
		clock: deps.clock ?? systemClock,
		env: deps.env ?? process.env,
		out: deps.out ?? ((line: string): void => console.log(line)),
	};
}

/** The dir argument the credentials-store helpers take (undefined = real home). */
function dirArg(dir: string): string | undefined {
	return dir.length > 0 ? dir : undefined;
}

/**
 * Resolve the REAL auth client: the injected one, or a client bound to the credential's `apiUrl`
 * (else the env / default). The token NEVER reaches the URL — only `apiUrl` does.
 */
function resolveClient(deps: ResolvedOrgDeps, disk: DiskCredentials): DeeplakeAuthClient {
	if (deps.client !== undefined) return deps.client;
	const apiUrl = disk.apiUrl !== undefined && disk.apiUrl.length > 0 ? disk.apiUrl : resolveApiUrl(deps.env);
	return createDeeplakeAuthClient({ apiUrl });
}

/** Load the raw disk credential or print the not-logged-in message; returns null when absent. */
function requireDisk(deps: ResolvedOrgDeps): DiskCredentials | null {
	const disk = loadDiskCredentials(dirArg(deps.dir), deps.env, deps.legacyDir);
	if (disk === null) {
		deps.out("Not logged in. Run `honeycomb login` first.");
		return null;
	}
	return disk;
}

/**
 * `honeycomb org list` (AC-4) — `GET /organizations`; print the orgs the user can access, marking
 * the active one (the credential's `orgId`). Read-only: no token re-mint, no file write.
 */
async function orgList(deps: ResolvedOrgDeps): Promise<OrgResult> {
	const out = deps.out;
	const disk = requireDisk(deps);
	if (disk === null) return { exitCode: 1, wrote: false };
	let orgs: OrgRow[];
	try {
		orgs = await resolveClient(deps, disk).listOrgs(disk.token);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "could not list organizations";
		out(`error: org list failed: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	if (orgs.length === 0) {
		out("No organizations found for this account.");
		return { exitCode: 0, wrote: false };
	}
	out("Organizations:");
	for (const org of orgs) {
		const active = org.id === disk.orgId ? " (active)" : "";
		out(`  ${org.name} (${org.id})${active}`);
	}
	return { exitCode: 0, wrote: false };
}

/**
 * `honeycomb org switch <name|id>` (AC-4) — resolve the target from `listOrgs` (a NAME or an id),
 * re-mint a fresh org-bound token, and persist the new token + orgId + orgName to the SHARED file.
 * The token is never printed. A target that matches no accessible org fails with a clear message and
 * no file write.
 */
async function orgSwitch(target: string, deps: ResolvedOrgDeps): Promise<OrgResult> {
	const out = deps.out;
	if (target === "") {
		out("usage: honeycomb org switch <name|id>");
		return { exitCode: 1, wrote: false };
	}
	const disk = requireDisk(deps);
	if (disk === null) return { exitCode: 1, wrote: false };
	const client = resolveClient(deps, disk);

	let orgs: OrgRow[];
	try {
		orgs = await client.listOrgs(disk.token);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "could not list organizations";
		out(`error: could not switch org to ${target}: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	// Accept a NAME (case-insensitive) OR an id.
	const lc = target.toLowerCase();
	const chosen = orgs.find((o) => o.id === target || o.name.toLowerCase() === lc);
	if (chosen === undefined) {
		out(`error: no organization named or id'd "${target}" is accessible to this account.`);
		return { exitCode: 1, wrote: false };
	}
	if (chosen.id === disk.orgId) {
		out(`Already in org ${chosen.name} (${chosen.id}).`);
		return { exitCode: 0, wrote: false };
	}

	let minted: string;
	try {
		// Re-mint: the org is baked into the token claim, so a switch mints a fresh org-bound token.
		minted = await client.reMint(disk.token, chosen.id);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "re-mint failed";
		out(`error: could not switch org to ${target}: ${reason}`);
		return { exitCode: 1, wrote: false };
	}

	// Persist the new token + org to the shared file. The workspace resets to `default` because a
	// concrete workspace belongs to the PREVIOUS org and would be stale under the new one.
	const next: DiskCredentials = {
		...disk,
		token: minted,
		orgId: chosen.id,
		orgName: chosen.name,
		workspaceId: "default",
		savedAt: "", // stamped server-side by saveDiskCredentials (b-AC-4).
	};
	saveDiskCredentials(next, dirArg(deps.dir), deps.clock);
	out(`Switched to org ${chosen.name} (${chosen.id}). A fresh org-bound token was minted and saved.`);
	// The token is NEVER printed.
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb workspaces` / `workspace list` (AC-5) — `GET /workspaces`; print the active org's
 * workspaces, marking the active one (the credential's `workspaceId`). Read-only.
 */
async function workspacesList(deps: ResolvedOrgDeps): Promise<OrgResult> {
	const out = deps.out;
	const disk = requireDisk(deps);
	if (disk === null) return { exitCode: 1, wrote: false };
	let workspaces: WorkspaceRow[];
	try {
		workspaces = await resolveClient(deps, disk).listWorkspaces(disk.token, disk.orgId);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "could not list workspaces";
		out(`error: workspaces failed: ${reason}`);
		return { exitCode: 1, wrote: false };
	}
	const activeWs = disk.workspaceId !== undefined && disk.workspaceId.length > 0 ? disk.workspaceId : "default";
	if (workspaces.length === 0) {
		out(`No workspaces found in org ${disk.orgName ?? disk.orgId}. (active: ${activeWs})`);
		return { exitCode: 0, wrote: false };
	}
	out("Workspaces:");
	for (const ws of workspaces) {
		const active = ws.id === activeWs || ws.name.toLowerCase() === activeWs.toLowerCase() ? " (active)" : "";
		out(`  ${ws.name} (${ws.id})${active}`);
	}
	return { exitCode: 0, wrote: false };
}

/**
 * `honeycomb workspace switch <name|id>` (AC-5) — update ONLY the shared file's `workspaceId`. A
 * NAME is resolved to its id via `listWorkspaces`; an id (or the `default` sentinel) is written
 * directly. No token re-mint (the workspace resolves server-side). `workspace use <ws>` is the
 * back-compat alias that lands here.
 */
async function workspaceSwitch(target: string, deps: ResolvedOrgDeps): Promise<OrgResult> {
	const out = deps.out;
	if (target === "") {
		out("usage: honeycomb workspace switch <name|id>");
		return { exitCode: 1, wrote: false };
	}
	const disk = requireDisk(deps);
	if (disk === null) return { exitCode: 1, wrote: false };

	// `default` is the per-org sentinel the backend resolves itself — write it directly, no lookup.
	// For a concrete name/id we resolve a NAME → id via `listWorkspaces` (AC-5). The lookup is
	// BEST-EFFORT: if it can't be reached (no client, transient error), we fall back to writing the
	// value verbatim — the server is the ultimate authority on the workspace, and the back-compat
	// `workspace use <ws>` path (Hivemind's `switchWorkspace`) historically wrote verbatim. Resolving
	// a NAME → id when we CAN reach the backend is the additive AC-5 win.
	let resolvedWs = target;
	if (target !== "default") {
		try {
			const workspaces: WorkspaceRow[] = await resolveClient(deps, disk).listWorkspaces(disk.token, disk.orgId);
			const lc = target.toLowerCase();
			const match = workspaces.find((w) => w.id === target || w.name.toLowerCase() === lc);
			if (match !== undefined) {
				// A NAME resolves to its id; an exact-id match keeps that id.
				resolvedWs = match.id;
			} else if (workspaces.length > 0) {
				// The backend WAS reachable and returned a list, yet the target matched nothing —
				// reject so a typo doesn't silently set a bad scope (the additive AC-5 strictness).
				out(`error: no workspace named or id'd "${target}" in org ${disk.orgName ?? disk.orgId}.`);
				return { exitCode: 1, wrote: false };
			}
			// (Empty list → backend reachable but no concrete workspaces; honor the value verbatim.)
		} catch {
			// Backend unreachable / no client → fall back to the back-compat verbatim write.
			resolvedWs = target;
		}
	}

	const next: DiskCredentials = { ...disk, workspaceId: resolvedWs, savedAt: "" };
	saveDiskCredentials(next, dirArg(deps.dir), deps.clock);
	out(`Workspace set to ${resolvedWs}. (No token re-mint — the workspace resolves server-side.)`);
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb status` — print org id/name, workspace, and agent; NEVER the bearer token (a-AC-6 /
 * FR-6). When not logged in, print a clear message + a non-error exit so a script can branch on it.
 */
function status(deps: ResolvedOrgDeps): OrgResult {
	const out = deps.out;
	const creds = loadCredentials(dirArg(deps.dir), deps.env, deps.legacyDir);
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
 * Run a parsed `org`/`workspace`/`workspaces`/`status` command (AC-4 / AC-5 / a-AC-6). The seams are
 * injected so the AC-named test drives the whole surface against fakes (a fake auth client, a temp
 * dir, a fake clock) without an auth server or the real home dir.
 */
export async function runOrgCommand(inv: OrgInvocation, deps: OrgCommandDeps = {}): Promise<OrgResult> {
	const resolved = withDefaults(deps);
	const sub = inv.path.join(" ");

	if (sub === "org list") return orgList(resolved);
	if (sub === "org switch") return orgSwitch(inv.arg ?? "", resolved);
	if (sub === "workspaces" || sub === "workspace list") return workspacesList(resolved);
	if (sub === "workspace switch") return workspaceSwitch(inv.arg ?? "", resolved);
	// Back-compat: `workspace use <ws>` is the PRD-011a alias for `workspace switch`.
	if (sub === "workspace use") return workspaceSwitch(inv.arg ?? "", resolved);
	if (sub === "status") return status(resolved);

	resolved.out(
		"usage: honeycomb <org list | org switch <name|id> | workspaces | workspace switch <name|id> | status>",
	);
	return { exitCode: sub === "" ? 0 : 1, wrote: false };
}

/** Convenience entry: parse + run an org/workspace/status argv tail in one call. */
export function orgMain(argv: readonly string[], deps: OrgCommandDeps = {}): Promise<OrgResult> {
	return runOrgCommand(parseOrgArgs(argv), deps);
}

/**
 * Re-exported so callers that still construct the legacy stub-issuer path keep a single import site.
 * The types are unused by the real switch verbs but remain part of the module's public surface for
 * back-compat (a wiring that injects `issuer` still type-checks).
 */
export type { Credentials, MintedToken, TokenIssuer };
