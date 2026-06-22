/**
 * The `/api/skills/*` PUBLISH + PULL mount seam — PRD-045g (closes the PRD-018 daemon-wiring gap).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `mountSkillPropagationApi(daemon, { storage, ... })` is the single named step the
 * composition root (`assemble.ts`) calls AFTER `createDaemon(...)` to attach the team
 * skill-sharing WRITE/ACTION handlers onto the already-mounted, protected `/api/skills`
 * route group (server.ts:83 — `{ path: "/api/skills", protect: true }`). It mirrors
 * `mountOntologyApi` / `mountGraphApi`: attach via `daemon.group("/api/skills")`, inherit
 * the auth/RBAC + tenancy resolution with ZERO edits to `server.ts`.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Why this mount exists (the gap PRD-018 left) ─────────────────────────────
 * PRD-018 BUILT the daemon-side publish/select endpoint ({@link createSkillPublishEndpoint})
 * and the thin-client pull + symlink fan-out (`daemon-client/skillify`), but NEVER mounted an
 * HTTP route, so:
 *   - `createSkillPublishEndpoint` was reachable only in a live itest, never over HTTP → a
 *     republish could not land via the CLI/daemon (g-AC-1);
 *   - the CLI's `POST /api/skills/pull` (045f wired `honeycomb skillify pull` there) hit an
 *     UNMOUNTED path → it would 404/501 instead of running a real pull (g-AC-5).
 *
 * ── No route collision (the `/api/graph` double-register the audit flagged) ──
 * `GET /api/skills` is owned by `product/api.ts` (`mountSkillsReadApi`); THIS module owns the
 * `POST /api/skills` (publish) + the `POST /api/skills/{pull,scope,unpull,force}` action verbs.
 * No path is registered twice — the read mount and this propagation mount attach DISJOINT
 * method/path pairs onto the same group.
 *
 * ── What it wires ────────────────────────────────────────────────────────────
 *   POST /api/skills          → publish a versioned skill (append-only version bump). Returns
 *                               `{ version }` — the version the row landed at (g-AC-1).
 *   POST /api/skills/pull     → run the real team pull + cross-harness symlink fan-out into the
 *                               detected agent roots (g-AC-5). Idempotent (a re-pull of the same
 *                               version is a no-op on disk) + fail-soft. Returns the
 *                               {@link PullOutcome}. This is the route session-start auto-pull
 *                               AND the `honeycomb skillify pull` CLI dispatch land on.
 *   POST /api/skills/scope    → no-op ack (scope is persisted client-side by the CLI's local
 *                               config store; the daemon needs no state). Kept so the CLI
 *                               dispatch lands on a real route, never a 404/501.
 *   POST /api/skills/unpull   → no-op ack (unpull reverses a LOCAL manifest entry on the
 *                               client; the daemon holds no per-client manifest). Same rationale.
 *   POST /api/skills/force    → alias of pull with `force:true` (re-write even when not newer).
 *
 * ── Fail-soft + injection-free ──────────────────────────────────────────────
 * Every handler resolves the request scope (fail-closed 400 outside local), then reads/writes
 * through the injected storage client. A publish/pull error is surfaced as a data body (never an
 * unhandled throw that crashes the request pipeline or the daemon). The publish endpoint builds
 * its SQL through `sqlIdent` only (no caller-interpolated value — the scope is a daemon-side
 * partition filter), so `audit:sql` stays clean.
 */

import type { Context } from "hono";
import { z } from "zod";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import {
	type AgentRootDetector,
	createDefaultAgentRoots,
	pull,
	type PulledSkill,
	type PullOutcome,
	type SkillPullClient,
} from "../../../daemon-client/skillify/index.js";
import { type Skill, SKILL_INSTALLS, SKILL_SCOPES } from "./contracts.js";
import { createSkillPublishEndpoint } from "./publish-endpoint.js";

/** The route group the propagation API attaches to (already mounted + protected in `server.ts`). */
export const SKILLS_GROUP = "/api/skills" as const;

/** The 400 body for a request with no resolvable tenancy (fail-closed — never a broad scope). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** Options for {@link mountSkillPropagationApi}. Mirrors {@link import("../ontology/api.js").MountOntologyOptions}. */
export interface MountSkillPropagationOptions {
	/** The storage client every publish/pull runs through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a request with no `x-honeycomb-org` header falls back to this
	 * single configured tenant. ABSENT → pure header-only resolution (fail-closed 400).
	 */
	readonly defaultScope?: QueryScope;
	/**
	 * The detected agent skill roots the pull fans symlinks into (g-AC-5). Injectable so a test
	 * points the whole set at temp dirs (no real `~` writes). Defaults to
	 * {@link createDefaultAgentRoots} (discovers `~/.claude/skills` + the other agent roots).
	 */
	readonly roots?: AgentRootDetector;
	/**
	 * Map the canonical `skills` table name to a PHYSICAL table (publish/select). Identity in
	 * production; a live itest injects a per-run prefix so it reads/writes a throwaway table.
	 */
	readonly resolveTable?: (canonical: string) => string;
}

/**
 * The zod boundary schema for a publish body (typescript-node Hard Rule #3: zod at every
 * untrusted boundary). The CLI/SDK/itest POST a {@link Skill}-shaped JSON body; this rejects a
 * malformed payload at the edge with a 400 rather than letting it reach the append-only write.
 * The app uses zod ^4 (the MCP server is the only place that imports `zod/v3`).
 */
const PublishBodySchema = z.object({
	id: z.string().trim().min(1),
	name: z.string().trim().min(1),
	author: z.string().trim().min(1),
	description: z.string().default(""),
	triggerText: z.string().default(""),
	body: z.string().default(""),
	install: z.enum(SKILL_INSTALLS).default("global"),
	provenance: z.object({
		sourceSessions: z.array(z.string()).default([]),
		version: z.number().int().positive(),
		createdBy: z.string().trim().min(1),
		scope: z.enum(SKILL_SCOPES).default("team"),
	}),
	contributors: z.array(z.string()).optional(),
});

/** Read a JSON body defensively; a non-JSON / empty body → `{}` (the schema then rejects it). */
async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		// A non-JSON body is not a crash — the schema treats it as missing fields → 400.
		return {};
	}
}

/**
 * Build a daemon-side {@link SkillPullClient} from the publish endpoint's select-newer read
 * (g-AC-5). The pull reads the highest-version skills THROUGH the same storage client the
 * daemon already holds — there is no second DeepLake connection and no thin-client dispatch on
 * the server side; the daemon IS the storage owner here. A read failure surfaces as `[]` so the
 * pull degrades to "nothing to pull" rather than throwing (the handler is fail-soft overall).
 */
function daemonSidePullClient(
	storage: StorageQuery,
	scope: QueryScope,
	resolveTable: (canonical: string) => string,
): SkillPullClient {
	const endpoint = createSkillPublishEndpoint(storage, scope, resolveTable);
	return {
		async readLatestSkills(): Promise<readonly PulledSkill[]> {
			const published = await endpoint.selectNewerForOrgUsers();
			// `PublishedSkill` and `PulledSkill` share the (name, author, version, body) shape.
			return published.map((s) => ({ name: s.name, author: s.author, version: s.version, body: s.body }));
		},
	};
}

/**
 * Run the real team pull + cross-harness symlink fan-out under `scope` (g-AC-5). Reuses the
 * 016c/018 {@link pull} engine VERBATIM — the conflict policy (`decideAction`), the idempotent
 * skip (a re-pull of the same version writes nothing), and the fan-out into the detected agent
 * roots all come from there. `force` re-writes even when remote is not newer (the `force` verb).
 * Wrapped fail-soft by the caller; a `null` return signals a swallowed error.
 */
async function runDaemonPull(
	storage: StorageQuery,
	scope: QueryScope,
	roots: AgentRootDetector,
	resolveTable: (canonical: string) => string,
	force: boolean,
): Promise<PullOutcome> {
	return pull({
		client: daemonSidePullClient(storage, scope, resolveTable),
		roots,
		install: "global",
		force,
	});
}

/**
 * Attach the `/api/skills/*` PUBLISH + PULL handlers onto the daemon's already-mounted,
 * protected `/api/skills` route group (the PRD-045g assembly seam). Mirrors `mountOntologyApi`:
 * every handler resolves the request scope (fail-closed 400 outside local), then publishes/pulls
 * through the injected storage client. Call ONCE after `createDaemon(...)`. If the group is not
 * mounted (unknown daemon shape) the attach is a no-op. A publish/pull error is reported as a
 * data body — never an unhandled throw that crashes the daemon.
 *
 * NO collision with `GET /api/skills` (owned by `mountSkillsReadApi`): this registers only POST
 * verbs onto the same group.
 */
export function mountSkillPropagationApi(daemon: Daemon, options: MountSkillPropagationOptions): void {
	const group = daemon.group(SKILLS_GROUP);
	if (group === undefined) return;

	const storage = options.storage;
	const roots = options.roots ?? createDefaultAgentRoots();
	const resolveTable = options.resolveTable ?? ((t: string): string => t);
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	// POST /api/skills — publish a versioned skill (append-only version bump). The body is the
	// rendered Skill; the version it lands at is returned (g-AC-1). NOT a 501 — a real write.
	group.post("/", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const parsed = PublishBodySchema.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "bad_request", reason: "invalid skill body" }, 400);
		}
		const skill: Skill = {
			id: parsed.data.id,
			name: parsed.data.name,
			author: parsed.data.author,
			description: parsed.data.description,
			triggerText: parsed.data.triggerText,
			body: parsed.data.body,
			install: parsed.data.install,
			provenance: {
				sourceSessions: parsed.data.provenance.sourceSessions,
				version: parsed.data.provenance.version,
				createdBy: parsed.data.provenance.createdBy,
				scope: parsed.data.provenance.scope,
			},
			...(parsed.data.contributors !== undefined ? { contributors: parsed.data.contributors } : {}),
		};
		try {
			const endpoint = createSkillPublishEndpoint(storage, scope, resolveTable);
			const version = await endpoint.publish(skill);
			return c.json({ published: true, version }, 200);
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			return c.json({ error: "publish_failed", reason }, 500);
		}
	});

	// POST /api/skills/pull — run the real team pull + symlink fan-out (g-AC-5). Idempotent +
	// fail-soft: a pull error is surfaced as a data body with `pulled:false`, never a throw.
	group.post("/pull", async (c) => handlePull(c, false));

	// POST /api/skills/force — pull with `force:true` (re-write even when remote is not newer).
	group.post("/force", async (c) => handlePull(c, true));

	// POST /api/skills/scope — the CLI persists scope LOCALLY (config store); the daemon holds no
	// per-client scope state. Ack so the registered `skill scope` dispatch lands on a real route.
	group.post("/scope", (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		return c.json({ ok: true, note: "scope is persisted client-side" }, 200);
	});

	// POST /api/skills/unpull — unpull reverses a LOCAL pull-manifest entry on the client; the
	// daemon holds no manifest. Ack so the registered `skill unpull` dispatch lands on a real route.
	group.post("/unpull", (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		return c.json({ ok: true, note: "unpull is reversed client-side" }, 200);
	});

	/** Shared pull handler (pull + force differ only in the `force` flag). Fail-soft by construction. */
	async function handlePull(c: Context, force: boolean): Promise<Response> {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		try {
			const outcome = await runDaemonPull(storage, scope, roots, resolveTable, force);
			return c.json({ pulled: true, ...outcome }, 200);
		} catch (err: unknown) {
			// A pull error NEVER crashes the request pipeline — surfaced as a fail-soft data body.
			const reason = err instanceof Error ? err.message : String(err);
			return c.json({ pulled: false, reason }, 200);
		}
	}
}
