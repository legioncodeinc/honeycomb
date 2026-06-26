/**
 * PRD-058c — the stale-reference diagnostic TRIGGER seam (the maintenance `observe` / `execute` runner).
 *
 * The manual-trigger path for the `σ(m,t)` diagnostic, mirroring {@link mountCompactApi} (PRD-030): a
 * daemon route that runs the {@link runStaleRefDiagnostic} over the memories under the daemon's scope.
 * It attaches `POST /api/diagnostics/stale-refs` onto the ALREADY-MOUNTED, protected `/api/diagnostics`
 * group (ZERO edits to `server.ts`), so it inherits the same auth/RBAC the JSON dashboard views enforce
 * (open in `local` mode, gated in team/hybrid). It is the HTTP TRIGGER, never new staleness logic — the
 * handler resolves the scope + posture, fetches the candidate memories, and calls the diagnostic.
 *
 * ── Posture (US-55c.2) ───────────────────────────────────────────────────────────────────────
 *   The request body carries `{ posture: "observe" | "execute" }` (default `observe`). The posture is
 *   threaded to the diagnostic + recorded in `memory_history`; it governs whether the EVENTUAL recall
 *   demotion (the `s` exponent on the recall {@link import("../memories/recall.js").StalenessSource}) is
 *   live. The diagnostic WRITES identically in both postures — `observe` ships detection visible-but-inert.
 *
 * ── The snapshot ORACLE (US-55c.3.3, poll-to-convergence) ────────────────────────────────────
 *   The diagnostic resolves against a converged codebase-graph snapshot via a {@link SnapshotProvider}.
 *   The production provider ({@link localSnapshotProvider}) reads the freshest LOCAL snapshot the graph
 *   worker wrote, POLLING until two consecutive reads agree on the snapshot hash (so a build mid-write
 *   never yields a half-written / stale-segment view that wrongly flags a live symbol). A `null` (no
 *   build yet) makes the diagnostic FAIL-SOFT — everything `unknown`, nothing stale.
 *
 * ── Fail-soft (the maintenance posture) ──────────────────────────────────────────────────────
 *   A request with no resolvable tenancy fails closed at the edge (400). Everything else is best-effort:
 *   a missing graph → `graphUnavailable: true` + nothing flagged; a per-memory write hiccup → that memory
 *   reports `written: false`. The worst case is "nothing re-verified this pass", never a crash.
 */

import type { Context } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { listMemories } from "../memories/reads.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import type { Snapshot, SnapshotIdentity } from "../codebase/contracts.js";
import { computeSnapshotSha256 } from "../codebase/snapshot.js";
import { defaultGraphBaseDir, loadFreshestLocalSnapshot } from "../codebase/api.js";
import { resolveSnapshotIdentity } from "../codebase/identity.js";
import type { Daemon } from "../server.js";
import {
	runStaleRefDiagnostic,
	type DiagnosticMemory,
	type SnapshotProvider,
	type StalePosture,
	type StaleRefDiagnosticReport,
} from "./stale-ref-diagnostic.js";

/** The route the stale-ref trigger is served at (full path `/api/diagnostics/stale-refs`). */
export const STALE_REF_TRIGGER_PATH = "/stale-refs" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const STALE_REF_TRIGGER_GROUP = "/api/diagnostics" as const;

/** How many memories one trigger pass scans (bounded so a manual trigger is a normal request). */
export const DEFAULT_STALE_REF_BATCH = 500;

/** The 400 body for a request with no resolvable tenancy (fail-closed at the edge). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** Poll budget + backoff for the local-snapshot convergence read (mirrors the heal/job-queue posture). */
const SNAPSHOT_CONVERGENCE_POLLS = 3;
const SNAPSHOT_CONVERGENCE_DELAY_MS = 25;

/**
 * The production {@link SnapshotProvider}: read the freshest LOCAL codebase-graph snapshot for the scope,
 * POLLING to convergence (US-55c.3.3 — DeepLake/build eventual consistency). It re-reads the local
 * snapshot up to {@link SNAPSHOT_CONVERGENCE_POLLS} times and returns only once two consecutive reads
 * agree on the snapshot hash, so a build mid-write (a half-written or just-renamed file) never produces a
 * stale-segment view that wrongly flags a live symbol. Returns `null` when no build has run yet (→ the
 * diagnostic fails soft, everything `unknown`). The repo identity is resolved from the workspace dir; the
 * tenant half is layered from the per-request scope, exactly as `mountGraphApi` does.
 */
export function localSnapshotProvider(
	workspaceDir: string,
	resolveIdentity: (scope: QueryScope) => SnapshotIdentity,
	deps?: { readonly delay?: (ms: number) => Promise<void>; readonly baseDir?: (identity: SnapshotIdentity) => string },
): SnapshotProvider {
	const sleep = deps?.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const baseDirOf = deps?.baseDir ?? defaultGraphBaseDir;
	return {
		async load(scope: QueryScope): Promise<Snapshot | null> {
			const baseDir = baseDirOf(resolveIdentity(scope));
			let last: Snapshot | null = loadFreshestLocalSnapshot(baseDir);
			if (last === null) return null;
			let lastSha = computeSnapshotSha256(last);
			// Poll until two consecutive reads agree on the hash (converged) or the budget is spent.
			for (let attempt = 1; attempt < SNAPSHOT_CONVERGENCE_POLLS; attempt++) {
				await sleep(SNAPSHOT_CONVERGENCE_DELAY_MS);
				const next = loadFreshestLocalSnapshot(baseDir);
				if (next === null) return last; // a vanish mid-poll → the last good read stands.
				const nextSha = computeSnapshotSha256(next);
				if (nextSha === lastSha) return next; // converged: two reads agree.
				last = next;
				lastSha = nextSha;
			}
			return last; // budget spent: return the freshest read (best-effort, never blocks the pass).
		},
	};
}

/** Options for {@link mountStaleRefApi}. */
export interface MountStaleRefOptions {
	/** The live storage client the diagnostic reads/writes through (guarded `writes.ts` primitives). */
	readonly storage: StorageQuery;
	/** The daemon's own tenancy partition (the same `defaultScope` the other diagnostics mounts thread). */
	readonly defaultScope: QueryScope;
	/** The workspace dir the repo identity resolves from. Defaults to `process.cwd()`. */
	readonly workspaceDir?: string;
	/** The snapshot-provider override (a test injects a fake). Production → {@link localSnapshotProvider}. */
	readonly snapshots?: SnapshotProvider;
	/** The candidate-batch size. Defaults to {@link DEFAULT_STALE_REF_BATCH}. */
	readonly batch?: number;
}

/** The summary body the trigger returns (the exact contract the maintenance verb / dashboard reads). */
export interface StaleRefSummaryBody extends StaleRefDiagnosticReport {
	/** The number of memories scanned this pass. */
	readonly scanned: number;
}

/** Read the posture from the request body defensively (default `observe` — the conservative posture). */
function resolvePosture(body: unknown): StalePosture {
	if (typeof body !== "object" || body === null) return "observe";
	const p = (body as { posture?: unknown }).posture;
	return p === "execute" ? "execute" : "observe";
}

/**
 * Attach the stale-reference diagnostic trigger onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (PRD-058c). Registers `POST /api/diagnostics/stale-refs`, which resolves the
 * request scope (header org or the daemon default — fail-closed), the posture (default `observe`), fetches
 * up to `batch` memories, runs the diagnostic against the converged snapshot oracle, and returns the
 * summary. Call ONCE after `createDaemon(...)`. If the group is not mounted the attach is a no-op.
 */
export function mountStaleRefApi(daemon: Daemon, options: MountStaleRefOptions): void {
	const group = daemon.group(STALE_REF_TRIGGER_GROUP);
	if (group === undefined) return;

	const workspaceDir = options.workspaceDir ?? process.cwd();
	const resolveIdentity = (scope: QueryScope): SnapshotIdentity => resolveSnapshotIdentity(workspaceDir, scope);
	const snapshots = options.snapshots ?? localSnapshotProvider(workspaceDir, resolveIdentity);
	const batch = options.batch ?? DEFAULT_STALE_REF_BATCH;

	group.post(STALE_REF_TRIGGER_PATH, async (c) => {
		const scope = resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		const posture = resolvePosture(await readBody(c));
		const records = await listMemories(batch, scope, { storage: options.storage });
		const memories: DiagnosticMemory[] = records.map((r) => ({ id: r.id, content: r.content }));

		const report = await runStaleRefDiagnostic(memories, scope, posture, { storage: options.storage, snapshots });
		const out: StaleRefSummaryBody = { ...report, scanned: memories.length };
		return c.json(out, 200);
	});
}

/** Read the JSON body defensively (an absent / unparseable body → `undefined`, the `observe` default). */
async function readBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
