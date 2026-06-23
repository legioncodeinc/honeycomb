/**
 * The `/api/graph/*` mount seam — PRD-014 daemon-assembly wiring (CONVENTIONS §11).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `mountGraphApi(daemon, { storage, ... })` is the single named step the composition
 * root (`assemble.ts`) calls AFTER `createDaemon(...)` to attach the codebase-graph
 * BUILD + READ handlers onto the already-mounted `/api/graph` route group — mirroring
 * `mountMemoriesApi` (`memories/api.ts`) and `mountDashboardApi`. ZERO edits to
 * `server.ts`: the `/api/graph` group is ALREADY scaffolded there behind the permission
 * middleware (`ROUTE_GROUPS`: `protect: true, session: false`), so attaching via
 * `daemon.group("/api/graph")` inherits auth/RBAC with no re-wiring.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── What it wires (replacing the PRD-004 501 scaffold) ───────────────────────
 *   POST /api/graph/build → run the EXISTING, tested worker end-to-end: resolve the
 *                           identity tuple → `buildAggregateSnapshot` (discover →
 *                           tree-sitter extract → aggregate) → `finalizeSnapshot`
 *                           (resolve cross-file → degrees → canonical hash) →
 *                           `writeSnapshotAtomic` (local on-disk authoritative copy) →
 *                           `pushSnapshot` (best-effort cloud push to the `codebase`
 *                           table through the daemon, the ONLY DeepLake client, with
 *                           the 014c SELECT-before-INSERT drift semantics). Returns the
 *                           build result as data — NO MORE 501.
 *   GET  /api/graph        → load the freshest LOCAL snapshot for the worktree and
 *                           return the FULL dashboard {@link GraphView}
 *                           (`{ built, nodes, edges }`) the canvas renders — mapping the
 *                           NetworkX node-link `nodes`/`links` into the view-model shape.
 *                           `built:false` with empty arrays when no build has run yet.
 *                           This is the SINGLE owner of `GET /api/graph` (the dashboard's
 *                           former DeepLake-read handler is retired): reading the LOCAL
 *                           snapshot makes the PRD-041a "Build graph" re-read immediate +
 *                           consistent (no DeepLake eventual-consistency flap — the local
 *                           copy `POST /build` writes via `writeSnapshotAtomic` IS the read).
 *
 * ── Daemon-only storage (codebase CONVENTIONS §10) ───────────────────────────
 * The cloud push runs daemon-side through the injected {@link StorageQuery}; the
 * build/extract/discovery touch ONLY the local filesystem. The local snapshot is ALWAYS
 * authoritative and a push failure NEVER fails the build (014c best-effort).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Context } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import { resolveScopeOrLocalDefault } from "../scope.js";

import type { GraphView } from "../../../dashboard/contracts.js";
import type { Snapshot, SnapshotIdentity } from "./contracts.js";
import { resolveSnapshotIdentity } from "./identity.js";
import { parseSnapshotJsonb, pushSnapshot, type PushOutcome } from "./push-pull.js";
import {
	buildAggregateSnapshot,
	type BuildDeps,
	finalizeSnapshot,
	writeSnapshotAtomic,
} from "./snapshot.js";

/** The route group the graph API attaches to (already mounted in `server.ts`). */
export const GRAPH_GROUP = "/api/graph" as const;

/** Options for {@link mountGraphApi}. Mirrors {@link import("../memories/api.js").MountMemoriesOptions}. */
export interface MountGraphOptions {
	/** The storage client the cloud push runs through (never a raw fetch — 014c). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a request with no `x-honeycomb-org` header falls back to this
	 * single configured tenant. ABSENT → pure header-only resolution (fail-closed 400).
	 */
	readonly defaultScope?: QueryScope;
	/**
	 * The workspace root the build discovers + extracts under. Defaults to the daemon's cwd
	 * (the same default the file watcher + secrets store use). A test points it at a fixture.
	 */
	readonly workspaceDir?: string;
	/**
	 * The local base dir snapshots are written/read under. Defaults to
	 * `~/.honeycomb/graphs/<repo-key>/` (the same convention `defaultCacheDir` uses). A test
	 * points it at a temp dir so the build never touches the real home dir.
	 */
	readonly graphBaseDir?: string;
	/**
	 * Build seams (discovery git lister + file reader + cache dir), injectable so a test drives
	 * a fixture repo with no real git / filesystem. Production leaves it unset → real seams.
	 */
	readonly buildDeps?: BuildDeps;
	/**
	 * The identity-resolution override (the resolved {@link SnapshotIdentity}). Production leaves
	 * it unset → the real git-probe resolution from `workspaceDir`. A test injects a fixed tuple.
	 */
	readonly identity?: SnapshotIdentity;
}

/** The 400 body for a request with no resolvable tenancy. */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/**
 * The local base dir for a repo's snapshots — `~/.honeycomb/graphs/<repo-key>/`. The
 * repo slug is sanitized to a single safe path segment so it can never traverse. Mirrors
 * `snapshot.ts`'s `defaultCacheDir` so the build write + the GET read agree on ONE dir.
 */
export function defaultGraphBaseDir(identity: SnapshotIdentity): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
	const repoKey = identity.repo === "" ? "default" : identity.repo.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(home, ".honeycomb", "graphs", repoKey);
}

/**
 * Load the freshest local snapshot from `<baseDir>/snapshots/` (the dir
 * `writeSnapshotAtomic` writes into). Picks the most-recently-modified `.json` file and
 * shape-validates it via {@link parseSnapshotJsonb}. Returns `null` when no snapshot dir
 * exists, it is empty, or the freshest file is malformed — so `GET /api/graph` cleanly
 * reports `built:false` rather than throwing. Pure-local, zero network.
 */
export function loadFreshestLocalSnapshot(baseDir: string): Snapshot | null {
	const dir = join(baseDir, "snapshots");
	if (!existsSync(dir)) return null;
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
	} catch {
		return null;
	}
	if (entries.length === 0) return null;

	let freshest: { path: string; mtimeMs: number } | null = null;
	for (const entry of entries) {
		const full = join(dir, entry);
		try {
			const mtimeMs = statSync(full).mtimeMs;
			if (freshest === null || mtimeMs > freshest.mtimeMs) freshest = { path: full, mtimeMs };
		} catch {
			// A file that vanished mid-scan is skipped, never fatal.
		}
	}
	if (freshest === null) return null;

	try {
		return parseSnapshotJsonb(readFileSync(freshest.path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Map a local {@link Snapshot} (NetworkX node-link JSON) into the dashboard {@link GraphView}
 * the canvas renders. The snapshot's `nodes` are codebase {@link import("./contracts.js").GraphNode}s
 * (`id` / `name` / `kind`) and its EDGES live under `links` (the NetworkX node-link convention —
 * `source` / `target` / `relation`), NOT an `edges` key. This is the authoritative, typed mapping:
 *   - node → `{ id, label: name (id fallback), kind }`
 *   - link → `{ from: source, to: target, kind: relation }`
 * Reading `links` (not a non-existent `edges`) is why the canvas now draws real edges. Pure +
 * total — every field is a string on both contracts, so there is no coercion or throw.
 */
export function snapshotToGraphView(snapshot: Snapshot): GraphView {
	const nodes = snapshot.nodes.map((n) => ({
		id: n.id,
		label: n.name !== "" ? n.name : n.id,
		kind: n.kind,
	}));
	const edges = snapshot.links.map((l) => ({
		from: l.source,
		to: l.target,
		kind: l.relation,
	}));
	return { built: true, nodes, edges };
}

/** The build result reported back to the caller (data, never a thrown error). */
interface BuildResultBody {
	readonly built: true;
	readonly snapshotSha256: string;
	readonly nodeCount: number;
	readonly edgeCount: number;
	readonly fileCount: number;
	readonly parseErrorCount: number;
	readonly cacheStats: { readonly reused: number; readonly extracted: number };
	readonly localPath: string;
	/** The 014c cloud-push outcome (best-effort): `inserted`/`already-current`/`drift`/`skipped`/… */
	readonly push: PushOutcome["kind"];
}

/**
 * Run the build worker end-to-end for `identity` over `workspaceDir`, writing the local
 * snapshot and best-effort pushing it (014c). This is the function the deferred wiring was
 * missing — it composes the already-built + already-tested pieces; it adds NO new graph
 * logic. Returns the build result as data.
 */
async function runGraphBuild(
	identity: SnapshotIdentity,
	scope: QueryScope,
	options: MountGraphOptions,
): Promise<BuildResultBody> {
	const workspaceDir = options.workspaceDir ?? process.cwd();
	const baseDir = options.graphBaseDir ?? defaultGraphBaseDir(identity);

	// 1. Aggregate: discover → tree-sitter extract → NetworkX node-link snapshot (014a).
	const aggregate = await buildAggregateSnapshot(workspaceDir, identity, options.buildDeps ?? {});
	// 2. Finalize: resolve cross-file edges → degrees → canonical stable-field hash (014b).
	const finalized = finalizeSnapshot(aggregate);
	// 3. Persist the LOCAL authoritative copy atomically (014b). This is what `GET /api/graph`
	//    and the PRD-015 `graph/` VFS bridge read — it never depends on the cloud push.
	const localPath = writeSnapshotAtomic(finalized.snapshot, baseDir, finalized.sha256);

	// 4. Best-effort cloud push (014c). SELECT-before-INSERT drift detection through the daemon
	//    storage client (the ONLY DeepLake path). A push failure/skip/drift NEVER fails the
	//    build — the local snapshot is authoritative; the outcome is reported as data.
	const push = await pushSnapshot(finalized.snapshot, finalized.sha256, identity, {
		storage: options.storage,
		scope,
		// Local single-user loopback is the dogfood target: a resolved scope IS the authenticated
		// tenant. (A non-empty commit is the other push gate; the worker self-skips when absent.)
		authenticated: true,
		pushedBy: identity.user,
	});

	const obs = finalized.snapshot.observation;
	return {
		built: true,
		snapshotSha256: finalized.sha256,
		nodeCount: obs.nodeCount,
		edgeCount: obs.edgeCount,
		fileCount: obs.fileCount,
		parseErrorCount: obs.parseErrorCount,
		cacheStats: aggregate.cacheStats,
		localPath,
		push: push.kind,
	};
}

/**
 * Attach the `/api/graph/*` handlers onto the daemon's already-mounted `/api/graph` route
 * group (the PRD-014 assembly seam). Mirrors `mountMemoriesApi`: every handler resolves the
 * request scope (fail-closed 400 outside local), then delegates to the existing worker. Call
 * ONCE after `createDaemon(...)`. If the group is not mounted (unknown daemon shape) the
 * attach is a no-op. Build failures are caught and reported as a 500 data body — never an
 * unhandled throw that crashes the request pipeline.
 */
export function mountGraphApi(daemon: Daemon, options: MountGraphOptions): void {
	const group = daemon.group(GRAPH_GROUP);
	if (group === undefined) return;

	const workspaceDir = options.workspaceDir ?? process.cwd();
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	// Resolve the repo half of the identity ONCE (the git probes are stable for the worktree).
	// The tenant half (org/workspace) is layered on per-request from the resolved scope.
	const resolveIdentity = (scope: QueryScope): SnapshotIdentity =>
		options.identity ?? resolveSnapshotIdentity(workspaceDir, scope);

	// ── POST /api/graph/build → run the worker end-to-end (replaces the 501). ──
	group.post("/build", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		try {
			const result = await runGraphBuild(resolveIdentity(scope), scope, options);
			return c.json(result);
		} catch (err: unknown) {
			// A build error is surfaced as data (never an unhandled throw). The local snapshot
			// is authoritative; an extract/IO failure here is reported, not swallowed.
			const reason = err instanceof Error ? err.message : String(err);
			return c.json({ error: "build_failed", reason }, 500);
		}
	});

	// ── GET /api/graph → the freshest LOCAL snapshot as the FULL dashboard GraphView. ──
	// SINGLE owner of `GET /api/graph` (the dashboard's former DeepLake `fetchGraphView`
	// handler is retired). Returns `{ built, nodes, edges }` mapped from the local snapshot's
	// node-link `nodes`/`links` — `built:false` empty arrays when no build has run yet. The
	// local copy is the SAME file `POST /build` writes, so the PRD-041a "Build graph" re-read
	// is immediate + consistent (no DeepLake eventual-consistency wait).
	group.get("/", (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const baseDir = options.graphBaseDir ?? defaultGraphBaseDir(resolveIdentity(scope));
		const snapshot = loadFreshestLocalSnapshot(baseDir);
		const view: GraphView =
			snapshot === null ? { built: false, nodes: [], edges: [] } : snapshotToGraphView(snapshot);
		return c.json(view);
	});
}
