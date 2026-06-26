/**
 * The dashboard SCOPE-SWITCH persistence surface — IRD-122 (122-AC-1 / 122-AC-2 / 122-AC-4).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * Two loopback, LOCAL-MODE-ONLY POST routes the dashboard Org→Workspace switcher calls so a selection
 * PERSISTS a real scope change instead of being a viewer-only no-op (the IRD-122 defect). They attach
 * onto the already-mounted, protected `/api/diagnostics` group (NO `server.ts` edit) and self-gate to
 * `local` mode exactly like {@link import("./scope-enumeration-api.js").mountScopeEnumerationApi}:
 *
 *   POST /api/diagnostics/scope/org-switch        { org }        → re-mint an org-bound token + persist
 *                                                                  it (+ org id/name) to the shared
 *                                                                  `~/.deeplake/credentials.json` (122-AC-2).
 *   POST /api/diagnostics/scope/workspace-switch  { workspace }  → persist the workspace id to the shared
 *                                                                  credential (NO re-mint — the workspace
 *                                                                  resolves server-side).
 *
 * ── It reuses the CLI `org switch` / `workspace switch` mechanics (no fork) ──
 * The org switch RE-MINTS a fresh org-bound token via the SAME {@link DeeplakeAuthClient.reMint} the CLI
 * uses (the org is baked into the token claim, so switching mints rather than edits — 122-AC-2) and
 * persists through the SAME {@link saveDiskCredentials} writer (`src/cli/org.ts`). The workspace switch
 * writes ONLY the shared file's `workspaceId` (no re-mint), exactly as `workspace switch` does. The
 * dashboard and CLI never diverge on the credential file.
 *
 * ── Loopback + local-mode only + the token is sacred (D-4 / security F-1) ────
 * The `/api/diagnostics` group is `protect:true`; these ALSO self-gate to `local` mode (a non-local
 * request 404s) — the persisted token rides ONLY in the `Authorization` header inside the auth client
 * and the credential file, NEVER in a response body, log, or echo. The ack bodies are the resolved org/
 * workspace ids + names only.
 *
 * ── Fail-soft, zod-validated at the boundary ─────────────────────────────────
 * Every external input is zod-validated; a malformed body is a clean 400. No credential / an auth-API
 * failure returns a clean ack with a redacted reason, never a 500.
 */

import type { Context } from "hono";

import { z } from "zod";

import type { DeploymentMode } from "../config.js";
import type { Daemon } from "../server.js";
import {
	type Clock,
	type DeeplakeAuthClient,
	type DiskCredentials,
	type OrgRow,
	type WorkspaceRow,
	createDeeplakeAuthClient,
	loadDiskCredentials,
	resolveApiUrl,
	saveDiskCredentials,
	systemClock,
} from "../auth/index.js";

/** The already-mounted, protected route group these attach to (no `server.ts` edit). */
export const SCOPE_SWITCH_GROUP = "/api/diagnostics" as const;

/** `POST /api/diagnostics/scope/org-switch` — re-mint + persist an org switch (122-AC-2). */
export const SCOPE_ORG_SWITCH_PATH = "/scope/org-switch" as const;
/** `POST /api/diagnostics/scope/workspace-switch` — persist a workspace switch (no re-mint). */
export const SCOPE_WORKSPACE_SWITCH_PATH = "/scope/workspace-switch" as const;

/** `POST /scope/org-switch` ack: the now-active org + whether a token re-mint ran (122-AC-2). NO token. */
export interface OrgSwitchAck {
	/** True when the org switch was persisted (token re-minted + saved). */
	readonly switched: boolean;
	/** The now-active org id. */
	readonly org: string;
	/** The now-active org display name. */
	readonly orgName?: string;
	/** True when a fresh org-bound token was minted (the org actually changed). */
	readonly reminted: boolean;
	/** A redacted reason on a failed switch (no credential / unknown org / re-mint error). NO token. */
	readonly error?: string;
}

/** `POST /scope/workspace-switch` ack: the now-active workspace (no re-mint). */
export interface WorkspaceSwitchAck {
	/** True when the workspace was persisted. */
	readonly switched: boolean;
	/** The now-active workspace id. */
	readonly workspace: string;
	/** A redacted reason on a failed switch. */
	readonly error?: string;
}

/** Options for {@link mountScopeSwitchApi}. All seams injectable for deterministic tests. */
export interface MountScopeSwitchOptions {
	/** Override the credentials directory (tests). Defaults to `~/.deeplake`. */
	readonly credentialsDir?: string;
	/** The env the apiUrl/token rules read (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The clock stamping `savedAt` server-side. Defaults to {@link systemClock}. */
	readonly clock?: Clock;
	/**
	 * The auth-client factory. Defaults to the REAL {@link createDeeplakeAuthClient}; a test injects a
	 * fake that records the call order (so the 122-AC-2 reMint-before-save assertion is deterministic).
	 */
	readonly authClientFactory?: (apiUrl: string) => DeeplakeAuthClient;
}

/** zod boundary for the org-switch body (122-AC-2): the target org id (or name). */
const OrgSwitchBodySchema = z.object({
	org: z.string().min(1),
});

/** zod boundary for the workspace-switch body: the target workspace id (or name, or `default`). */
const WorkspaceSwitchBodySchema = z.object({
	workspace: z.string().min(1),
});

/** A redacted reason for a failed auth-API call — the status/message, NEVER the token (D-4). */
function redactedReason(err: unknown): string {
	if (err instanceof Error) return err.message.slice(0, 200);
	return String(err).slice(0, 200);
}

/**
 * Attach the two scope-switch persistence routes onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (IRD-122). Call ONCE after `createDaemon(...)` under the LOCAL-mode gate
 * (mirroring the scope-enumeration mount). If the group is not mounted the attach is a no-op. Every
 * handler self-gates to local mode (a non-local request 404s), zod-validates its input, persists the
 * shared credential via {@link saveDiskCredentials}, and is fail-soft (never a 500). The token is NEVER
 * returned in a body.
 */
export function mountScopeSwitchApi(daemon: Daemon, options: MountScopeSwitchOptions): void {
	const group = daemon.group(SCOPE_SWITCH_GROUP);
	if (group === undefined) return;
	const mode: DeploymentMode = daemon.config.mode;
	const env = options.env ?? process.env;
	const clock = options.clock ?? systemClock;
	const makeClient = options.authClientFactory ?? ((apiUrl: string) => createDeeplakeAuthClient({ apiUrl }));
	const notLocal = (): boolean => mode !== "local";

	// ── 122-AC-2: POST /scope/org-switch { org } → re-mint an org-bound token + persist it. ──
	group.post(SCOPE_ORG_SWITCH_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = await readBody(c, OrgSwitchBodySchema);
		if (!parsed.ok) return c.json({ error: "bad_request", reason: parsed.reason }, 400);
		const disk = loadDiskCredentials(options.credentialsDir, env);
		if (disk === null || disk.token.length === 0) {
			const body: OrgSwitchAck = { switched: false, org: "", reminted: false, error: "not_logged_in" };
			return c.json(body, 200);
		}
		return c.json(await switchOrg(disk, parsed.value.org.trim(), options, env, clock, makeClient), 200);
	});

	// ── IRD-122: POST /scope/workspace-switch { workspace } → persist the workspace (NO re-mint). ──
	group.post(SCOPE_WORKSPACE_SWITCH_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = await readBody(c, WorkspaceSwitchBodySchema);
		if (!parsed.ok) return c.json({ error: "bad_request", reason: parsed.reason }, 400);
		const disk = loadDiskCredentials(options.credentialsDir, env);
		if (disk === null || disk.token.length === 0) {
			const body: WorkspaceSwitchAck = { switched: false, workspace: "", error: "not_logged_in" };
			return c.json(body, 200);
		}
		return c.json(await switchWorkspace(disk, parsed.value.workspace.trim(), options, env, clock, makeClient), 200);
	});
}

/**
 * Persist an org switch (IRD-122 122-AC-2): resolve the target from `listOrgs` (a NAME or an id),
 * RE-MINT a fresh org-bound token, and save the new token + org id/name to the shared credential — the
 * SAME mechanic as the CLI `honeycomb org switch`. When the requested org already matches the active
 * one, no re-mint runs (the existing token is already bound). The token is NEVER returned.
 */
async function switchOrg(
	disk: DiskCredentials,
	target: string,
	options: MountScopeSwitchOptions,
	env: NodeJS.ProcessEnv,
	clock: Clock,
	makeClient: (apiUrl: string) => DeeplakeAuthClient,
): Promise<OrgSwitchAck> {
	const apiUrl = disk.apiUrl !== undefined && disk.apiUrl.length > 0 ? disk.apiUrl : resolveApiUrl(env);
	const client = makeClient(apiUrl);

	let orgs: OrgRow[];
	try {
		orgs = await client.listOrgs(disk.token);
	} catch (err: unknown) {
		return { switched: false, org: disk.orgId, reminted: false, error: redactedReason(err) };
	}
	const lc = target.toLowerCase();
	const chosen = orgs.find((o) => o.id === target || o.name.toLowerCase() === lc);
	if (chosen === undefined) {
		return { switched: false, org: disk.orgId, reminted: false, error: "unknown_org" };
	}
	if (chosen.id === disk.orgId) {
		// Already in this org → nothing to re-mint, but the switch is a no-op success (idempotent).
		return { switched: true, org: chosen.id, orgName: chosen.name, reminted: false };
	}

	let minted: string;
	try {
		// 122-AC-2: re-mint BEFORE save — the org is baked into the token claim.
		minted = await client.reMint(disk.token, chosen.id);
	} catch (err: unknown) {
		return { switched: false, org: disk.orgId, reminted: false, error: redactedReason(err) };
	}

	// Persist the new token + org. The workspace resets to `default` because a concrete workspace
	// belongs to the PREVIOUS org and would be stale under the new one (mirrors the CLI `org switch`).
	const next: DiskCredentials = {
		...disk,
		token: minted,
		orgId: chosen.id,
		orgName: chosen.name,
		workspaceId: "default",
		savedAt: "", // stamped server-side by saveDiskCredentials.
	};
	saveDiskCredentials(next, options.credentialsDir, clock);
	return { switched: true, org: chosen.id, orgName: chosen.name, reminted: true };
}

/**
 * Persist a workspace switch (IRD-122): write ONLY the shared file's `workspaceId` (NO token re-mint —
 * the workspace resolves server-side), resolving a NAME → id via `listWorkspaces` best-effort. The
 * `default` sentinel writes verbatim; an unreachable backend falls back to the verbatim value (the
 * CLI's back-compat posture). The same mechanic as `honeycomb workspace switch`.
 */
async function switchWorkspace(
	disk: DiskCredentials,
	target: string,
	options: MountScopeSwitchOptions,
	env: NodeJS.ProcessEnv,
	clock: Clock,
	makeClient: (apiUrl: string) => DeeplakeAuthClient,
): Promise<WorkspaceSwitchAck> {
	let resolvedWs = target;
	if (target !== "default") {
		const apiUrl = disk.apiUrl !== undefined && disk.apiUrl.length > 0 ? disk.apiUrl : resolveApiUrl(env);
		try {
			const workspaces: WorkspaceRow[] = await makeClient(apiUrl).listWorkspaces(disk.token, disk.orgId);
			const lc = target.toLowerCase();
			const match = workspaces.find((w) => w.id === target || w.name.toLowerCase() === lc);
			if (match !== undefined) {
				resolvedWs = match.id;
			} else if (workspaces.length > 0) {
				// The backend WAS reachable and returned a list, yet the target matched nothing — reject
				// so a typo does not silently set a bad scope (the CLI's additive strictness).
				return { switched: false, workspace: disk.workspaceId ?? "default", error: "unknown_workspace" };
			}
			// (Empty list → backend reachable but no concrete workspaces; honor the value verbatim.)
		} catch {
			// Backend unreachable → fall back to the back-compat verbatim write.
			resolvedWs = target;
		}
	}

	const next: DiskCredentials = { ...disk, workspaceId: resolvedWs, savedAt: "" };
	saveDiskCredentials(next, options.credentialsDir, clock);
	return { switched: true, workspace: resolvedWs };
}

/** A parsed body result: the validated value, or a redacted reason. */
type ParsedBody<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Read + zod-validate a JSON body, returning a typed value or a redacted reason (never a throw). */
async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<ParsedBody<T>> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return { ok: false, reason: "request body must be JSON" };
	}
	const result = schema.safeParse(raw);
	if (!result.success) {
		return { ok: false, reason: "invalid request body" };
	}
	return { ok: true, value: result.data };
}
