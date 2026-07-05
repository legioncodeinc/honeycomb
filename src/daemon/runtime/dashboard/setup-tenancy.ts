/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * The link-time TENANCY-SELECTION surface — PRD-073c (the two-phase link the hive onboarding consumes).
 *
 * ── The problem this fixes (parent Decision 2) ───────────────────────────────
 * The device-flow link used to silently pick `orgs[0]` + workspace `"default"` and persist it before
 * the user ever saw a choice — which wrote real capture data into the WRONG org on the product owner's
 * machine. This surface splits the link into two phases:
 *
 *   1. Authenticate + enumerate (NO persist). The `/setup/login` route (wired with the pending-link
 *      runner below) runs the device flow to a SHORT-LIVED token held IN MEMORY only, enumerates the
 *      account's orgs, and PARKS a pending-link slice. A single-org + single/zero-workspace account (or
 *      an env-pinned one) auto-selects and persists immediately, clearing the pending window.
 *   2. Persist the choice. `POST /setup/tenancy/select { orgId, workspaceId }` validates the pair
 *      against the enumerated lists, mints the long-lived token bound to the CHOSEN org, and persists
 *      `~/.deeplake/credentials.json` with the chosen pair + the confirmed-tenancy marker.
 *
 * ── The CANONICAL contract (reconciled with hive PRD-011; do not drift a field) ──
 *   GET  /setup/tenancy                       -> { pending, selected, confirmedBy?, authenticated, org|null, workspace|null }
 *        (`selected` is the EFFECTIVE confirmation the capture gate consumes: explicit marker,
 *         grandfathered pre-073 credential, env pins, or auto-select — never marker-only, so a
 *         grandfathered upgraded install is never re-onboarded by the hive portal gate. An
 *         auto-selection persists IMMEDIATELY and is reflected as `selected: true` +
 *         `confirmedBy: "selection"` + the org/workspace pair; the originally-proposed
 *         `autoSelected` field was struck by QA as dead — no pending window can ever carry it)
 *   GET  /setup/tenancy/orgs                  -> { orgs: [{id,name}] }
 *   GET  /setup/tenancy/workspaces?org=<id>   -> { org, workspaces: [{id,name}], canCreate }
 *   POST /setup/tenancy/select { orgId, workspaceId } -> { selected:true, org, workspace, reminted } | { selected:false, error }
 *   POST /setup/tenancy/workspaces { org, name }      -> { created:true, workspace } | { created:false, error }
 *
 * ── Local-mode only + the token is sacred (D-4 / security F-1) ───────────────
 * All routes sit beside `/setup/state` + `/setup/login` on the UNPROTECTED root group and SELF-GATE to
 * `local` mode (a non-local request 404s). The short-lived token lives in daemon memory for the pending
 * window (bounded TTL) and is discarded on selection or expiry — NO file ever holds it, and NO token
 * rides any response body (only ids + names). Mechanics mirror the IRD-122 scope-switch routes
 * (reMint-then-saveDiskCredentials, zod-validated bodies, fail-soft redacted errors).
 */

import type { Context } from "hono";

import { z } from "zod";

import type { DeploymentMode } from "../config.js";
import type { Daemon } from "../server.js";
import {
	authenticateDeviceFlow,
	createDeeplakeAuthClient,
	type DeeplakeAuthClient,
	type DeviceFlowLoginDeps,
	type OrgRow,
	persistSelectedTenancy,
	persistUnconfirmedTenancy,
	resolveApiUrl,
	resolveTenancyChoice,
	TenancySelectionRequiredError,
	type WorkspaceRow,
} from "../auth/deeplake-issuer.js";
import { type Clock, type DiskCredentials, loadDiskCredentials, systemClock } from "../auth/credentials-store.js";
import { resolveTenancyConfirmation } from "../auth/tenancy-confirmation.js";

/** The root route group the setup-tenancy routes attach to (already mounted, UNPROTECTED, in `server.ts`). */
export const SETUP_TENANCY_GROUP = "/" as const;

/** `GET /setup/tenancy` — the pending/selected read the hive onboarding polls. */
export const SETUP_TENANCY_PATH = "/setup/tenancy" as const;
/** `GET /setup/tenancy/orgs` — the org enumeration for the picker. */
export const SETUP_TENANCY_ORGS_PATH = "/setup/tenancy/orgs" as const;
/** `GET /setup/tenancy/workspaces` — the per-org workspace enumeration for the picker. */
export const SETUP_TENANCY_WORKSPACES_PATH = "/setup/tenancy/workspaces" as const;
/** `POST /setup/tenancy/select` — phase 2 (persist the chosen pair + marker). */
export const SETUP_TENANCY_SELECT_PATH = "/setup/tenancy/select" as const;

/** The Deeplake workspace-id slug pattern (`WorkspaceCreateRequest.id`). */
const WORKSPACE_ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** The `default` workspace sentinel is always a legitimate choice (resolves server-side). */
const DEFAULT_WORKSPACE = "default";
/** Deeplake supports workspace creation (`POST /workspaces`), verified against the live API. */
const WORKSPACE_CREATION_SUPPORTED = true;
/** Default pending-link TTL: a bounded window so an abandoned link expires (parent AC-073c.1.4). */
export const DEFAULT_PENDING_LINK_TTL_MS = 10 * 60 * 1000;

/** An `{ id, name }` pair (org or workspace). NO token by construction. */
export interface TenancyEntity {
	readonly id: string;
	readonly name: string;
}

/**
 * How an effectively-confirmed tenancy was confirmed (additive surfacing; hive's zod strips unknown
 * fields, so this is safe to carry). `selection` covers every marker-stamped path (an explicit pick,
 * env pins, and the single-tenancy auto-select — all stamp `tenancyConfirmedAt` through the same
 * phase-2 persist); `grandfathered` is a pre-073 credential confirmed by its non-empty orgId.
 */
export type TenancyConfirmedBy = "selection" | "grandfathered";

/** `GET /setup/tenancy` body — the pending/selected marker + current tenancy. */
export interface SetupTenancyBody {
	/** True ONLY during an unconsumed pending-link window. */
	readonly pending: boolean;
	/**
	 * True when tenancy is EFFECTIVELY confirmed — the SAME rule the capture gate consumes
	 * ({@link resolveTenancyConfirmation}): the explicit `tenancyConfirmedAt` marker is present, OR a
	 * pre-073 credential is grandfathered by its non-empty orgId (parent AC-5: existing installs behave
	 * unchanged; the hive portal gate must not trap an upgraded install into re-onboarding). The
	 * marker-vs-grandfather distinction rides additively on {@link confirmedBy}.
	 */
	readonly selected: boolean;
	/** Present when `selected` is true: how the tenancy was confirmed (additive; see {@link TenancyConfirmedBy}). */
	readonly confirmedBy?: TenancyConfirmedBy;
	/** True when a pending link OR a persisted credential exists. */
	readonly authenticated: boolean;
	/** The current org (from the pending window this is null; from a credential it is the bound org). */
	readonly org: TenancyEntity | null;
	/** The current workspace (null during pending; the credential's workspace otherwise). */
	readonly workspace: TenancyEntity | null;
}

/** `GET /setup/tenancy/orgs` body. */
export interface SetupTenancyOrgsBody {
	readonly orgs: readonly TenancyEntity[];
	readonly error?: string;
}

/** `GET /setup/tenancy/workspaces` body. */
export interface SetupTenancyWorkspacesBody {
	readonly org: string;
	readonly workspaces: readonly TenancyEntity[];
	readonly canCreate: boolean;
	readonly error?: string;
}

/** In-memory pending-link state (the short-lived token + enumerated orgs). Never persisted. */
export interface PendingLink {
	/** The short-lived Auth0 token (memory-only — never on disk). */
	readonly authToken: string;
	/** The API base URL the flow authenticated against. */
	readonly apiUrl: string;
	/** The enumerated orgs the account can see (privilege-scoped). */
	readonly orgs: readonly OrgRow[];
	/** When the pending window opened (epoch ms) — for the TTL sweep. */
	readonly createdAt: number;
}

/** The single-slot pending-link store shared between `/setup/login` and the `/setup/tenancy` routes. */
export interface PendingLinkStore {
	/** Park a pending link (replaces any prior one). */
	set(link: PendingLink): void;
	/** The current pending link, or `null` when absent OR expired (past the TTL). */
	get(): PendingLink | null;
	/** Discard the pending link (on selection or a fresh start). */
	clear(): void;
}

/** Options for {@link createPendingLinkStore}. */
export interface PendingLinkStoreOptions {
	/** The pending-window TTL in ms (default {@link DEFAULT_PENDING_LINK_TTL_MS}). */
	readonly ttlMs?: number;
	/** The clock (epoch ms) — injectable so a test drives TTL expiry deterministically. */
	readonly now?: () => number;
}

/** Build a fresh single-slot pending-link store (in-memory, TTL-bounded). */
export function createPendingLinkStore(options: PendingLinkStoreOptions = {}): PendingLinkStore {
	const ttlMs = options.ttlMs ?? DEFAULT_PENDING_LINK_TTL_MS;
	const now = options.now ?? ((): number => Date.now());
	let link: PendingLink | null = null;
	return {
		set(next: PendingLink): void {
			link = next;
		},
		get(): PendingLink | null {
			if (link === null) return null;
			if (now() - link.createdAt > ttlMs) {
				link = null; // expired — the short-lived token is discarded (AC-073c.1.4).
				return null;
			}
			return link;
		},
		clear(): void {
			link = null;
		},
	};
}

/** Options for {@link makePendingLinkRunner} + {@link mountSetupTenancyApi}. Seams injectable for tests. */
export interface SetupTenancyOptions {
	/** The shared pending-link store (create ONE and pass it to BOTH the login runner and the mount). */
	readonly store: PendingLinkStore;
	/** Override the credentials dir (tests point this at a temp HOME). */
	readonly credentialsDir?: string;
	/** The env the apiUrl/token/pins rules read (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The clock stamping `savedAt`/the marker server-side. Defaults to {@link systemClock}. */
	readonly clock?: Clock;
	/** The auth-client factory (defaults to the REAL {@link createDeeplakeAuthClient}); tests inject a fake. */
	readonly authClientFactory?: (apiUrl: string) => DeeplakeAuthClient;
	/** The clock (epoch ms) for the pending `createdAt` stamp (defaults to `Date.now`). */
	readonly now?: () => number;
}

/**
 * Build the `/setup/login` device-flow runner that PARKS a pending link instead of persisting a guess
 * (PRD-073c phase 1). Wired into `mountSetupLogin(daemon, { runDeviceFlow })` in place of the default
 * `loginWithDeviceFlow`. It authenticates (firing `onGrant` so the route returns the user code), then:
 * auto-selects + persists a single-tenancy/env-pinned account (clearing pending), else parks the
 * pending window for the `/setup/tenancy/select` step. A background failure is surfaced to the caller
 * (the route backgrounds it and the page polls `/setup/tenancy`).
 */
export function makePendingLinkRunner(options: SetupTenancyOptions): (deps: DeviceFlowLoginDeps) => Promise<unknown> {
	const env = options.env ?? process.env;
	const clock = options.clock ?? systemClock;
	const now = options.now ?? ((): number => Date.now());
	return async (deps: DeviceFlowLoginDeps): Promise<unknown> => {
		const { authToken, apiUrl, client } = await authenticateDeviceFlow(deps);
		// Try to resolve tenancy WITHOUT a selector: env pins or a single-tenancy account auto-select.
		try {
			const choice = await resolveTenancyChoice(authToken, client, env, undefined);
			await persistSelectedTenancy(client, authToken, choice, {
				...(options.credentialsDir !== undefined ? { dir: options.credentialsDir } : {}),
				clock,
			});
			options.store.clear();
			// Informational only (the /setup/login route discards the runner's resolution — the page
			// polls GET /setup/tenancy, which now reads selected:true + confirmedBy:"selection"). The
			// contract's `autoSelected` field was struck as dead: an auto-selection never leaves a
			// pending window behind, so no GET could ever carry it.
			return { persisted: { orgId: choice.orgId, workspaceId: choice.workspaceId } };
		} catch (err: unknown) {
			// A multi-tenancy account needs an explicit choice → PARK the pending window for the
			// `/setup/tenancy/select` step. BUG 2: BEFORE parking, persist BASE credentials (auth-only,
			// tenancy unselected) so `/setup/state.authenticated` flips the instant the device is approved
			// (the field hive polls). The base credential is provisionally bound to the FIRST enumerated
			// org and carries `tenancyPending: true` with NO `tenancyConfirmedAt`, so the capture gate
			// stays closed (`tenancy_unconfirmed`) and NO data is written to the provisional org before the
			// explicit pick. The `/setup/tenancy/select` step then re-mints for the CHOSEN org and
			// OVERWRITES the file with the confirmed marker. Persist is fail-soft: a base-credential write
			// hiccup still parks the pending window so the tenancy picker works.
			if (err instanceof TenancySelectionRequiredError) {
				const provisional = err.orgs[0];
				if (provisional !== undefined) {
					try {
						await persistUnconfirmedTenancy(
							client,
							authToken,
							{ orgId: provisional.id, orgName: provisional.name },
							{
								...(options.credentialsDir !== undefined ? { dir: options.credentialsDir } : {}),
								clock,
							},
						);
					} catch {
						// A base-credential persist failure must not block the tenancy picker — park anyway.
					}
				}
				options.store.set({ authToken, apiUrl, orgs: err.orgs, createdAt: now() });
				return { pending: true };
			}
			throw err;
		}
	};
}

/** A redacted reason for a failed auth-API call — the status/message, NEVER the token (D-4). */
function redactedReason(err: unknown): string {
	if (err instanceof Error) return err.message.slice(0, 200);
	return String(err).slice(0, 200);
}

/** The auth client for a given apiUrl, honoring the injected factory (tests). */
function clientFor(options: SetupTenancyOptions, apiUrl: string): DeeplakeAuthClient {
	const make =
		options.authClientFactory ?? ((url: string): DeeplakeAuthClient => createDeeplakeAuthClient({ apiUrl: url }));
	return make(apiUrl);
}

/** Resolve the persisted credential (or `null`) — the already-linked read source when not pending. */
function loadCredential(options: SetupTenancyOptions): DiskCredentials | null {
	return loadDiskCredentials(options.credentialsDir, options.env ?? process.env);
}

/**
 * Where a `POST /setup/tenancy/select` resolves its enumerated orgs + minting token from. Two
 * sources back it: the in-memory pending-link window (the initial sign-in fast path), and (once
 * that single-use window is consumed) the PERSISTED credential (FIX 1, the re-selection keystone).
 */
interface SelectionSource {
	/** The auth client bound to the source's apiUrl. */
	readonly client: DeeplakeAuthClient;
	/** The orgs the selection is validated against (enumerated, privilege-scoped). */
	readonly orgs: readonly OrgRow[];
	/** The token {@link persistSelectedTenancy} re-mints from for the chosen org (memory-only or persisted). */
	readonly mintToken: string;
	/** List a target org's workspaces (to validate a non-`default` workspace choice). */
	listWorkspaces(orgId: string): Promise<WorkspaceRow[]>;
}

/**
 * Resolve the {@link SelectionSource} for a select/re-select:
 *   - a live pending window → enumerate + mint from its short-lived in-memory token (initial link);
 *   - else the PERSISTED credential (FIX 1) → enumerate orgs/workspaces with the long-lived org-bound
 *     token already on disk and re-mint from it, so re-selection works AFTER the pending window is
 *     gone WITHOUT a fresh device-flow sign-in;
 *   - else `null` (genuinely not linked: no window and no credential).
 * The token rides ONLY in the auth client's `Authorization` header (D-4); it never touches a body.
 */
async function resolveSelectionSource(
	options: SetupTenancyOptions,
	pending: PendingLink | null,
): Promise<SelectionSource | null> {
	if (pending !== null) {
		const client = clientFor(options, pending.apiUrl);
		return {
			client,
			orgs: pending.orgs,
			mintToken: pending.authToken,
			listWorkspaces: (orgId: string): Promise<WorkspaceRow[]> => client.listWorkspaces(pending.authToken, orgId),
		};
	}
	const disk = loadCredential(options);
	if (disk === null || disk.token.length === 0) return null;
	const apiUrl = disk.apiUrl ?? resolveApiUrl(options.env ?? process.env);
	const client = clientFor(options, apiUrl);
	const orgs = await client.listOrgs(disk.token);
	return {
		client,
		orgs,
		mintToken: disk.token,
		listWorkspaces: async (orgId: string): Promise<WorkspaceRow[]> => {
			// A credential token is bound to its own org; enumerating a DIFFERENT org needs a reMint
			// first (mirrors the GET /setup/tenancy/workspaces path).
			const token = orgId !== disk.orgId ? await client.reMint(disk.token, orgId) : disk.token;
			return client.listWorkspaces(token, orgId);
		},
	};
}

/** zod boundary for `POST /setup/tenancy/select`. */
const SelectBodySchema = z.object({ orgId: z.string().min(1), workspaceId: z.string().min(1) });
/** zod boundary for `POST /setup/tenancy/workspaces`. */
const CreateWorkspaceBodySchema = z.object({ org: z.string().min(1), name: z.string().min(1) });

/** Slugify a workspace name into a Deeplake-valid id (`^[a-z0-9]+(?:[-_][a-z0-9]+)*$`, <=34), or null. */
export function slugifyWorkspaceId(name: string): string | null {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "")
		.slice(0, 34)
		.replace(/-+$/, "");
	return WORKSPACE_ID_PATTERN.test(slug) ? slug : null;
}

/**
 * Attach the `/setup/tenancy*` routes onto the daemon's already-mounted root group (PRD-073c). Call
 * ONCE after `createDaemon(...)`; the composition root fires it LOCAL-MODE ONLY (mirroring
 * `mountSetupLogin` / `mountSetupStateApi`). Every handler self-gates to local mode (a non-local
 * request 404s) and is fail-soft. Pass the SAME {@link PendingLinkStore} the `/setup/login` runner uses.
 */
export function mountSetupTenancyApi(daemon: Daemon, options: SetupTenancyOptions): void {
	const root = daemon.group(SETUP_TENANCY_GROUP);
	if (root === undefined) return;
	const mode: DeploymentMode = daemon.config.mode;
	const notLocal = (): boolean => mode !== "local";

	// ── GET /setup/tenancy — the pending/selected read (the hive onboarding polls this). ──
	root.get(SETUP_TENANCY_PATH, (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const pending = options.store.get();
		if (pending !== null) {
			const body: SetupTenancyBody = {
				pending: true,
				selected: false,
				authenticated: true,
				org: null,
				workspace: null,
			};
			return c.json(body);
		}
		// No pending window → report the persisted credential tenancy so an already-linked machine
		// renders honestly. `selected` mirrors the SAME effective-confirmation rule the capture gate
		// consumes ({@link resolveTenancyConfirmation}: explicit marker OR grandfathered non-empty
		// orgId) — the ONE predicate, never a duplicated variant — so hive's portal gate and the
		// capture gate can never disagree, and a grandfathered upgraded install is never trapped into
		// re-onboarding (parent AC-5). `confirmedBy` surfaces the marker-vs-grandfather distinction.
		const disk = loadCredential(options);
		if (disk === null) {
			const body: SetupTenancyBody = {
				pending: false,
				selected: false,
				authenticated: false,
				org: null,
				workspace: null,
			};
			return c.json(body);
		}
		const confirmation = resolveTenancyConfirmation({
			...(options.credentialsDir !== undefined ? { credentialsDir: options.credentialsDir } : {}),
			env: options.env ?? process.env,
		});
		const workspaceId =
			disk.workspaceId !== undefined && disk.workspaceId.length > 0 ? disk.workspaceId : DEFAULT_WORKSPACE;
		const body: SetupTenancyBody = {
			pending: false,
			selected: confirmation.confirmed,
			...(confirmation.confirmed
				? { confirmedBy: confirmation.grandfathered ? ("grandfathered" as const) : ("selection" as const) }
				: {}),
			authenticated: true,
			org: { id: disk.orgId, name: disk.orgName ?? disk.orgId },
			workspace: { id: workspaceId, name: workspaceId },
		};
		return c.json(body);
	});

	// ── GET /setup/tenancy/orgs — the org list (pending-token or credential scoped). ──
	root.get(SETUP_TENANCY_ORGS_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const pending = options.store.get();
		if (pending !== null) {
			const body: SetupTenancyOrgsBody = { orgs: pending.orgs.map((o) => ({ id: o.id, name: o.name })) };
			return c.json(body);
		}
		const disk = loadCredential(options);
		if (disk === null || disk.token.length === 0) return c.json({ orgs: [] } satisfies SetupTenancyOrgsBody);
		try {
			const client = clientFor(options, disk.apiUrl ?? resolveApiUrl(options.env ?? process.env));
			const rows = await client.listOrgs(disk.token);
			return c.json({ orgs: rows.map((o) => ({ id: o.id, name: o.name })) } satisfies SetupTenancyOrgsBody);
		} catch (err: unknown) {
			return c.json({ orgs: [], error: redactedReason(err) } satisfies SetupTenancyOrgsBody);
		}
	});

	// ── GET /setup/tenancy/workspaces?org=<id> — that org's workspaces + the create affordance flag. ──
	root.get(SETUP_TENANCY_WORKSPACES_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const org = (c.req.query("org") ?? "").trim();
		const pending = options.store.get();
		if (pending !== null) {
			const targetOrg = org.length > 0 ? org : (pending.orgs[0]?.id ?? "");
			try {
				const client = clientFor(options, pending.apiUrl);
				const rows = await client.listWorkspaces(pending.authToken, targetOrg);
				return c.json({
					org: targetOrg,
					workspaces: rows.map((w) => ({ id: w.id, name: w.name })),
					canCreate: WORKSPACE_CREATION_SUPPORTED,
				} satisfies SetupTenancyWorkspacesBody);
			} catch (err: unknown) {
				return c.json({
					org: targetOrg,
					workspaces: [],
					canCreate: WORKSPACE_CREATION_SUPPORTED,
					error: redactedReason(err),
				} satisfies SetupTenancyWorkspacesBody);
			}
		}
		const disk = loadCredential(options);
		if (disk === null || disk.token.length === 0) {
			return c.json({
				org,
				workspaces: [],
				canCreate: WORKSPACE_CREATION_SUPPORTED,
			} satisfies SetupTenancyWorkspacesBody);
		}
		const targetOrg = org.length > 0 ? org : disk.orgId;
		try {
			const client = clientFor(options, disk.apiUrl ?? resolveApiUrl(options.env ?? process.env));
			// A credential token is bound to its own org; enumerating a DIFFERENT org needs a reMint first.
			const token = targetOrg !== disk.orgId ? await client.reMint(disk.token, targetOrg) : disk.token;
			const rows = await client.listWorkspaces(token, targetOrg);
			return c.json({
				org: targetOrg,
				workspaces: rows.map((w) => ({ id: w.id, name: w.name })),
				canCreate: WORKSPACE_CREATION_SUPPORTED,
			} satisfies SetupTenancyWorkspacesBody);
		} catch (err: unknown) {
			return c.json({
				org: targetOrg,
				workspaces: [],
				canCreate: WORKSPACE_CREATION_SUPPORTED,
				error: redactedReason(err),
			} satisfies SetupTenancyWorkspacesBody);
		}
	});

	// ── POST /setup/tenancy/select — phase 2: validate, mint for the chosen org, persist + marker. ──
	root.post(SETUP_TENANCY_SELECT_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = await readBody(c, SelectBodySchema);
		if (!parsed.ok) return c.json({ selected: false, error: "invalid request body" }, 400);
		const { orgId, workspaceId } = parsed.value;
		const pending = options.store.get();
		// FIX 1 (the re-selection keystone): resolve the enumerated orgs + minting token from the pending
		// window when present, else from the PERSISTED credential, so a user can re-select an org/workspace
		// AFTER the single-use pending window is consumed, without a fresh device-flow sign-in.
		let source: SelectionSource | null;
		try {
			source = await resolveSelectionSource(options, pending);
		} catch (err: unknown) {
			// The persisted-credential enumeration failed (e.g. the org-list call errored); fail soft
			// with a redacted reason (NEVER the token, per D-4). Nothing is persisted; the caller can retry.
			return c.json({ selected: false, error: redactedReason(err) }, 200);
		}
		if (source === null) {
			// No pending window AND no persisted credential → genuinely not linked. Run the sign-in flow.
			return c.json({ selected: false, error: "no pending link — start the sign-in flow again" }, 400);
		}
		// Validate the org against the ENUMERATED list (AC-073c.1.3) — a selection not on the list 400s.
		const org = source.orgs.find((o) => o.id === orgId);
		if (org === undefined) {
			return c.json({ selected: false, error: "org is not in the enumerated list" }, 400);
		}
		// Validate the workspace against the org's enumerated workspaces (the `default` sentinel is
		// always allowed; it resolves server-side), then re-mint + persist for the chosen pair.
		try {
			if (workspaceId !== DEFAULT_WORKSPACE) {
				const workspaces = await source.listWorkspaces(orgId);
				if (!workspaces.some((w) => w.id === workspaceId)) {
					return c.json({ selected: false, error: "workspace is not in the enumerated list" }, 400);
				}
			}
			const persisted = await persistSelectedTenancy(
				source.client,
				source.mintToken,
				{ orgId, orgName: org.name, workspaceId },
				{
					...(options.credentialsDir !== undefined ? { dir: options.credentialsDir } : {}),
					clock: options.clock ?? systemClock,
				},
			);
			// A pending window (if any) is consumed; discard the short-lived token. A persisted-credential
			// re-selection has no window to clear; clear() is idempotent, so this is safe either way.
			options.store.clear();
			return c.json({
				selected: true,
				org: { id: persisted.orgId, name: persisted.orgName ?? persisted.orgId },
				workspace: {
					id: persisted.workspaceId ?? workspaceId,
					name: persisted.workspaceId ?? workspaceId,
				},
				reminted: true,
			});
		} catch (err: unknown) {
			return c.json({ selected: false, error: redactedReason(err) }, 200);
		}
	});

	// ── POST /setup/tenancy/workspaces — create a workspace (Deeplake supports it; canCreate=true). ──
	root.post(SETUP_TENANCY_WORKSPACES_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = await readBody(c, CreateWorkspaceBodySchema);
		if (!parsed.ok) return c.json({ created: false, error: "invalid request body" }, 400);
		const { org, name } = parsed.value;
		const id = slugifyWorkspaceId(name);
		if (id === null) {
			return c.json({ created: false, error: "workspace name has no valid slug (use letters/digits)" }, 400);
		}
		const pending = options.store.get();
		// Defense-in-depth (security audit Low-1): during a pending window, `org` must be one of the
		// ENUMERATED orgs, the same rule `POST /setup/tenancy/select` enforces (AC-073c.1.3).
		if (pending !== null && !pending.orgs.some((o) => o.id === org)) {
			return c.json({ created: false, error: "org is not in the enumerated list" }, 400);
		}
		try {
			if (pending !== null) {
				const client = clientFor(options, pending.apiUrl);
				const created = await client.createWorkspace(pending.authToken, org, id, name);
				return c.json({ created: true, workspace: { id: created.id, name: created.name } });
			}
			const disk = loadCredential(options);
			if (disk === null || disk.token.length === 0) {
				return c.json({ created: false, error: "not_linked" }, 200);
			}
			const client = clientFor(options, disk.apiUrl ?? resolveApiUrl(options.env ?? process.env));
			const token = org !== disk.orgId ? await client.reMint(disk.token, org) : disk.token;
			const created = await client.createWorkspace(token, org, id, name);
			return c.json({ created: true, workspace: { id: created.id, name: created.name } });
		} catch (err: unknown) {
			return c.json({ created: false, error: redactedReason(err) }, 200);
		}
	});
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
	if (!result.success) return { ok: false, reason: "invalid request body" };
	return { ok: true, value: result.data };
}
