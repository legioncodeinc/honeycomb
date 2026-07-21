/**
 * `DeepLakeFs` — the intercept that ties PRD-015a together (a-AC-1 / a-AC-4 / a-AC-6 / FR-1).
 *
 * The agent's view is a directory at `~/.honeycomb/memory/`; underneath, every op is a
 * daemon-dispatched SQL query scoped by org/workspace/agent_id. `DeepLakeFs` is the
 * long-lived consumer (the standalone deeplake-shell); the one-shot PreToolUse hook (deferred
 * — see CONVENTIONS) lowers the same verbs into the same {@link FsOp} and shares this logic.
 *
 * The Wave-1 surface:
 *   - `readFile`            → the read-precedence chain (`resolveRead`) — a-AC-1 / a-AC-2.
 *   - `writeFile`/`appendFile`/`rm`/`cp`/`mv` on a SESSION path → EPERM — a-AC-4 (D-4).
 *   - `writeFile`/`appendFile`/`rm`/`cp`/`mv` otherwise → routed to the 015b WRITE BUFFER
 *     (stub this wave — `// WAVE 2 (015b)`). The buffer is wired NOW so 015b fills the flush
 *     without touching this file.
 *
 * EVERY storage-reaching op dispatches via {@link DaemonDispatch} (a-AC-6) carrying the
 * {@link VfsScope} on every call. This module imports the PURE escaping helpers + the PURE
 * graph renderer + the dispatch SEAM — NEVER the storage CLIENT. It lives under
 * `src/daemon-client/`, which `tests/daemon/storage/invariant.test.ts` scans, so a direct
 * DeepLake import would fail the build (the invariant is the enforcement, not a convention).
 */

import { classifyPath, toMountRelative } from "./classify.js";
import {
	type ContentCache,
	type DaemonDispatch,
	type FsVerb,
	type PendingBuffer,
	type SessionCache,
	SessionPermissionError,
	type SnapshotLoader,
	type VfsScope,
} from "./contracts.js";
import { type ReadDeps, resolveRead } from "./read.js";
import { createWriteBuffer, type WriteBuffer } from "./write-buffer.js";

/** The construction inputs for a {@link DeepLakeFs} (all seams injected). */
export interface DeepLakeFsOptions {
	/** The ONLY path out to storage (a-AC-6). In prod a POST to 127.0.0.1:3850; in tests a fake. */
	readonly dispatch: DaemonDispatch;
	/** The tenancy scope carried on EVERY dispatch (FR-2 / a-AC-6). */
	readonly scope: VfsScope;
	/** The local snapshot loader for the graph bridge (a-AC-2) — zero network. */
	readonly snapshots: SnapshotLoader;
	/** Optional seed cache (defaults to empty). */
	readonly cache?: ContentCache;
	/** Optional seed session-recall cache (defaults to empty). */
	readonly sessionCache?: SessionCache;
	/** Optional seed pending buffer (defaults to empty). */
	readonly pending?: PendingBuffer;
}

/**
 * The long-lived filesystem intercept over the memory mount. Reads resolve through the
 * precedence chain; session mutations reject with EPERM; other mutations route to the 015b
 * write buffer (stub this wave). One instance per shell session; the maps are its in-memory
 * tree (FR-3).
 */
export class DeepLakeFs {
	private readonly dispatch: DaemonDispatch;
	private readonly scope: VfsScope;
	private readonly cache: ContentCache;
	private readonly sessionCache: SessionCache;
	private readonly pending: PendingBuffer;
	private readonly snapshots: SnapshotLoader;
	private readonly buffer: WriteBuffer;

	constructor(options: DeepLakeFsOptions) {
		this.dispatch = options.dispatch;
		this.scope = options.scope;
		this.cache = options.cache ?? new Map();
		this.sessionCache = options.sessionCache ?? new Map();
		this.pending = options.pending ?? new Map();
		this.snapshots = options.snapshots;
		// The write path is wired NOW (015b fills the flush). It shares the SAME dispatch
		// seam + scope + pending map — so a buffered write is visible to the read tier-4
		// buffer before the flush, and the flush dispatches through the daemon too (a-AC-6).
		this.buffer = createWriteBuffer({ dispatch: this.dispatch, scope: this.scope, pending: this.pending });
	}

	/** The read-resolution deps, assembled from this instance's seams. */
	private readDeps(): ReadDeps {
		return {
			dispatch: this.dispatch,
			scope: this.scope,
			cache: this.cache,
			sessionCache: this.sessionCache,
			pending: this.pending,
			snapshots: this.snapshots,
		};
	}

	/**
	 * Resolve a path's content through the read-precedence chain (a-AC-1 / a-AC-2). Every
	 * storage-reaching tier dispatches through the daemon; the graph tier reads the local
	 * snapshot with zero network.
	 */
	readFile(path: string): Promise<string> {
		return resolveRead(path, this.readDeps());
	}

	/**
	 * Buffer a write for the 015b flush (a session target → EPERM). WAVE 2 (015b) owns the
	 * batched flush; Wave 1 wires the routing + the session guard. A non-session write reaches
	 * the buffer stub, which throws `notImplemented` until 015b lands — the routing + EPERM
	 * decision is the Wave-1 contract.
	 */
	async writeFile(path: string, body: string): Promise<void> {
		this.guardSession(path, "write");
		// WAVE 2 (015b): enqueue → batched-debounced flush (SELECT-before-INSERT for goal/kpi,
		// update-or-insert for memory, NULL vectors when embeddings disabled).
		this.buffer.enqueue({ path: toRel(path), body, verb: "write", pathClass: classifyPath(path) });
	}

	/**
	 * Buffer an append for the 015b flush (a session target → EPERM). WAVE 2 (015b) turns this
	 * into a SQL-level concat + cache-invalidate with no read-back (b-AC-5).
	 */
	async appendFile(path: string, body: string): Promise<void> {
		this.guardSession(path, "append");
		// WAVE 2 (015b): accumulate the tail; flush as a SQL concat, invalidate the cache.
		this.buffer.enqueue({ path: toRel(path), body, verb: "append", pathClass: classifyPath(path) });
	}

	/**
	 * Remove a path (a session target → EPERM). WAVE 2 (015b): an `rm` of a GOAL is a
	 * SOFT-CLOSE (status→closed, row preserved) via the buffer; a memory rm is a delete.
	 */
	async rm(path: string): Promise<void> {
		this.guardSession(path, "rm");
		// WAVE 2 (015b): soft-close for a goal, delete for a memory.
		await this.buffer.softCloseGoal(toRel(path));
	}

	/**
	 * Copy a path (a session source/target → EPERM — sessions cannot be cp'd out of the log).
	 * WAVE 2 (015b) owns the memory/goal copy semantics.
	 */
	async cp(from: string, to: string): Promise<void> {
		this.guardSession(from, "cp");
		this.guardSession(to, "cp");
		// WAVE 2 (015b): copy the resolved body into a new write.
		this.buffer.enqueue({ path: toRel(to), body: "", verb: "write", pathClass: classifyPath(to) });
	}

	/**
	 * Move a path (a session source/target → EPERM — an append-only log row cannot be mv'd).
	 * WAVE 2 (015b): an `mv` of a GOAL is a STATUS transition (status-only differs) or EPERM
	 * (goal_id/owner differs).
	 */
	async mv(from: string, to: string): Promise<void> {
		this.guardSession(from, "mv");
		this.guardSession(to, "mv");
		// WAVE 2 (015b): goal status transition vs EPERM; memory rename.
		await this.buffer.transitionGoal(toRel(from), toRel(to));
	}

	/**
	 * Reject a mutation that targets a SESSION path (a-AC-4 / D-4 / FR-7). Sessions are an
	 * append-only event log: write/append/rm/cp/mv all throw {@link SessionPermissionError}
	 * (EPERM). Called at the TOP of every mutating verb, BEFORE any dispatch, so a session
	 * mutation never reaches storage.
	 */
	private guardSession(path: string, verb: FsVerb): void {
		if (classifyPath(path) === "session") {
			throw new SessionPermissionError(path, verb);
		}
	}
}

/**
 * Normalize an incoming path to its mount-relative form for the pending/cache map keys.
 * Re-uses the single `toMountRelative` reduction (classify.ts) so the buffer keys match the
 * read tier-4 buffer lookup exactly — no second prefix-stripping implementation to drift.
 */
function toRel(path: string): string {
	return toMountRelative(path);
}
