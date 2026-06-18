/**
 * Virtual-filesystem contracts + seams — PRD-015a (Wave 1, the intercept + dispatch layer).
 *
 * The central thesis (a-AC-6 / D-6 / the thin-client invariant
 * `tests/daemon/storage/invariant.test.ts`):
 *
 *   THE `DeepLakeFs` PRESENTS MEMORY AS FILES BUT NEVER OPENS DEEPLAKE ITSELF.
 *
 * Every read and every write that reaches storage is built into SQL HERE and
 * DISPATCHED THROUGH THE DAEMON on `127.0.0.1:3850` (the only DeepLake client).
 * This module lives under `src/daemon-client/` ON PURPOSE: that root is a
 * NON-daemon root the invariant test scans, so a stray `from ".../daemon/storage"`
 * import fails the build. The intercept is structurally a thin client.
 *
 * What is OK to import (pure, storage-free):
 *   - `sqlIdent` / `sLiteral` / `sqlStr` (`src/daemon/storage/sql.ts`) — PURE string
 *     functions, the SQL-injection floor. They build NO connection; importing them
 *     does not import the storage CLIENT. The audit (`npm run audit:sql`) proves the
 *     SQL we build is escaped.
 *   - `handleGraphVfs` (`src/daemon/runtime/codebase/query.ts`) — a PURE renderer that
 *     takes an already-loaded `Snapshot` and renders text, ZERO network (PRD-014d
 *     d-AC-5). The graph bridge delegates to it.
 *
 * What is NEVER imported here (would fail the invariant):
 *   - `createStorageClient` / `StorageClient` / anything under `daemon/storage` that
 *     opens a DeepLake connection. The `DaemonDispatch` SEAM below is the ONLY way out
 *     to storage; in production it POSTs to the daemon, in tests it is a fake.
 *
 * The seam shape mirrors the daemon-side `StorageQuery` (`{ query(sql, scope) }`) so the
 * real dispatch is a thin POST wrapper and the fake is a recording double — exactly the
 * `push-pull.ts` / `FakeStore` discipline, but on the thin-client side of the wire.
 */

// ─────────────────────────────────────────────────────────────────────────────
// VfsScope — the org/workspace/agent partition carried on EVERY dispatch (FR-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tenancy partition a VFS op runs under (FR-2 / a-AC-6 / PRD-011 scope). Mirrors
 * the daemon-side `QueryScope` shape (org + optional workspace) and extends it with the
 * OPTIONAL `agentId` so two agents in one workspace are isolated. EVERY `DaemonDispatch`
 * call carries this — a read or write can never escape its scope, because the scope is
 * dispatched alongside the SQL and the daemon applies it as a partition filter.
 */
export interface VfsScope {
	/** The org partition. Required. */
	readonly org: string;
	/** The workspace partition. Defaults daemon-side to the configured workspace. */
	readonly workspace?: string;
	/** The agent partition. Optional — when present, isolates per-agent. */
	readonly agentId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PathClass — what a mount-relative path classifies to (a-AC-3 / FR-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kind a path classifies to (a-AC-3 / index AC-2). A valid goal/kpi SHAPE → its
 * kind; a `sessions/...` path → `session`; a `graph/...` path → `graph`; `index.md` →
 * `index`; ANYTHING malformed or otherwise → `memory` (the generic fallback). This is
 * the routing tag `classifyPath` returns and the intercept branches on.
 */
export type PathClass = "goal" | "kpi" | "memory" | "session" | "graph" | "index";

// ─────────────────────────────────────────────────────────────────────────────
// FsOp — the intercepted filesystem operation (FR-1)
// ─────────────────────────────────────────────────────────────────────────────

/** The filesystem verbs the mount intercepts (FR-1 / FR-7). */
export const FS_VERBS = ["read", "write", "append", "rm", "cp", "mv"] as const;
/** A single intercepted verb. */
export type FsVerb = (typeof FS_VERBS)[number];

/**
 * One intercepted filesystem operation against the mount (FR-1). The hook and the
 * long-lived `DeepLakeFs` both lower a Bash/Read/Grep/Glob action into this shape and
 * hand it to the same dispatcher.
 *
 *   - `read`           → resolve content through the read-precedence chain.
 *   - `write`/`append` → buffer for the 015b flush (a session target → EPERM).
 *   - `rm`/`cp`/`mv`    → 015b lifecycle verbs (a session target → EPERM).
 *
 * `path` is the mount-relative / host-absolute path the agent named; `body` is the
 * content for a write/append; `dest` is the destination for a cp/mv.
 */
export interface FsOp {
	/** The verb. */
	readonly verb: FsVerb;
	/** The path the op targets (any of the accepted shapes — `classifyPath` normalizes). */
	readonly path: string;
	/** The content body for a `write`/`append`. Absent for read/rm. */
	readonly body?: string;
	/** The destination path for a `cp`/`mv`. */
	readonly dest?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DaemonDispatch SEAM — the ONLY path out to storage (a-AC-6 / D-6)
// ─────────────────────────────────────────────────────────────────────────────

/** One row of a dispatched result, keyed by column name (mirrors `StorageRow`). */
export type Row = Record<string, unknown>;
/** The rows a dispatched SELECT returns. */
export type Rows = readonly Row[];

/**
 * The DISPATCH SEAM (a-AC-6 / D-6 / FR-2) — the ONLY way this module reaches storage.
 *
 * The real implementation POSTs the SQL + scope to the honeycomb daemon on
 * `127.0.0.1:3850`; the daemon is the sole DeepLake client and applies the scope as a
 * partition filter. In tests the seam is a FAKE ({@link createFakeDaemonDispatch}) that
 * RECORDS every statement and answers from an in-memory table — so a test can assert the
 * EXACT SQL dispatched AND that storage was reached ONLY through this seam (never a direct
 * DeepLake open). The shape mirrors the daemon-side `StorageQuery.query(sql, scope)`.
 *
 * `query` resolves to the result rows; a dispatch FAILURE rejects (the caller decides
 * whether to surface or swallow). The seam is intentionally minimal: SQL in, rows out,
 * scope alongside — no DeepLake types leak across it.
 */
export interface DaemonDispatch {
	/** Dispatch one SQL statement through the daemon under `scope`, resolving to result rows. */
	query(sql: string, scope: VfsScope): Promise<Rows>;
}

/**
 * A recorded dispatch — the `(sql, scope)` pair the fake captured, in call order. A test
 * asserts on these to prove a tier ran (or did NOT run, for short-circuit precedence) and
 * that the SQL is the expected, escaped statement.
 */
export interface RecordedDispatch {
	readonly sql: string;
	readonly scope: VfsScope;
}

/** Options for {@link createFakeDaemonDispatch}. */
export interface FakeDaemonDispatchOptions {
	/**
	 * A responder that answers a dispatched SQL with rows. Receives the SQL + scope so a
	 * test can branch on which statement is running (a memory read vs a sessions concat vs
	 * an index probe). Defaults to returning NO rows (an empty table).
	 */
	readonly respond?: (sql: string, scope: VfsScope) => Rows;
	/**
	 * When set, the fake REJECTS every dispatch with this error — to drive the failure
	 * branches (a dispatch error is surfaced, not swallowed silently).
	 */
	readonly failWith?: Error;
}

/**
 * A FAKE {@link DaemonDispatch} (the test seam). Records every `(sql, scope)` it is
 * handed and answers from the injected `respond` callback (default: no rows). The
 * recorded calls are exposed on `.calls` so a test asserts:
 *   - WHICH tier reached storage (and that earlier tiers short-circuited — `.calls` is
 *     empty when the cache/pending/graph tier served the read);
 *   - the EXACT escaped SQL each tier built;
 *   - that storage was reached ONLY through this seam — there is no other path, so a
 *     `DeepLakeFs` that opened DeepLake directly could not even compile under the
 *     thin-client invariant.
 */
export interface FakeDaemonDispatch extends DaemonDispatch {
	/** Every dispatch recorded in call order. */
	readonly calls: RecordedDispatch[];
}

/** Build a FAKE {@link DaemonDispatch} for tests (records calls; answers from `respond`). */
export function createFakeDaemonDispatch(options: FakeDaemonDispatchOptions = {}): FakeDaemonDispatch {
	const calls: RecordedDispatch[] = [];
	const respond = options.respond ?? (() => []);
	return {
		calls,
		query(sql: string, scope: VfsScope): Promise<Rows> {
			calls.push({ sql, scope });
			if (options.failWith !== undefined) return Promise.reject(options.failWith);
			return Promise.resolve(respond(sql, scope));
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// SnapshotLoader SEAM — the zero-network graph-bridge source (a-AC-2 / FR-9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal snapshot shape the graph bridge hands to `handleGraphVfs`. Kept as
 * `unknown`-bodied here so this contracts module does not depend on the codebase-graph
 * `Snapshot` type (which lives daemon-side under `runtime/codebase`); the bridge in
 * `read.ts` imports the concrete `Snapshot` type and the pure `handleGraphVfs` renderer.
 * Re-exported as the bridge's loader return so the seam reads cleanly.
 */
export type LoadedSnapshot = unknown;

/**
 * The graph-bridge SEAM (a-AC-2 / FR-9). Loads the LOCAL codebase-graph snapshot off
 * disk for the shell's cwd — ZERO network. Returns `null` when no snapshot exists, so the
 * bridge renders a `no-graph` BODY (never throws). In production this reads the atomic
 * snapshot file the PRD-014 build wrote; in tests it returns a fixture snapshot (or
 * `null`). Synchronous + LOCAL by construction — a network call here would violate the
 * graph bridge's zero-network invariant.
 */
export interface SnapshotLoader {
	/** Load the local snapshot for the current worktree, or `null` if none exists. */
	load(): LoadedSnapshot | null;
}

/** Build a FAKE {@link SnapshotLoader} from a fixed snapshot (or `null` for no-graph). */
export function createFakeSnapshotLoader(snapshot: LoadedSnapshot | null): SnapshotLoader {
	return { load: () => snapshot };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache + pending-buffer types (FR-3 / FR-6) — the in-memory tree
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The in-memory content cache (FR-6, tier 3). Maps a normalized mount-relative path to
 * its resolved body. A cache HIT short-circuits the read before any SQL is dispatched.
 * A write/append INVALIDATES the entry (015b) so a later read never serves stale content.
 */
export type ContentCache = Map<string, string>;

/**
 * The pending-write buffer (FR-6, tier 4 / D-7). Holds writes that have been accepted but
 * not yet FLUSHED to storage (015b batches + debounces the flush). A read sees its OWN
 * pending write here BEFORE storage, so `cat` right after `Write` shows the change
 * (the user story). Wave 1 defines the shape + the read tier; 015b owns the flush.
 */
export type PendingBuffer = Map<string, PendingWrite>;

/** One buffered write awaiting the 015b flush. */
export interface PendingWrite {
	/** The path the write targets. */
	readonly path: string;
	/** The buffered body. For an `append`, this is the accumulated tail to concat. */
	readonly body: string;
	/** The verb that produced it (`write` replaces; `append` concatenates SQL-side at flush). */
	readonly verb: "write" | "append";
	/** The classified kind, so the flush routes goal/kpi vs memory writes correctly (015b). */
	readonly pathClass: PathClass;
}

// ─────────────────────────────────────────────────────────────────────────────
// EPERM — the session append-only rejection (a-AC-4 / FR-7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The error a session-path mutation rejects with (a-AC-4 / D-4 / FR-7). Sessions are an
 * append-only EVENT LOG: `write`, `append`, `rm`, `cp`, and `mv` targeting a session path
 * all reject with this. `code === "EPERM"` so a `just-bash` / shell caller surfaces the
 * same errno a real read-only file would, and a test asserts on the stable `code`.
 */
export class SessionPermissionError extends Error {
	/** The POSIX errno the shell surfaces. */
	readonly code = "EPERM" as const;
	constructor(path: string, verb: FsVerb) {
		super(`EPERM: sessions are an append-only event log — cannot ${verb} ${path}`);
		this.name = "SessionPermissionError";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// notImplemented — the honest Wave-2 (015b) thrower
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The standard "PRD-015b fills this" thrower (mirrors the secrets/inference/ontology
 * harness posture). A stubbed 015b body calls this so an accidental early call FAILS LOUD
 * with the owning sub-PRD, never silently returns a fake-passing value.
 */
export function notImplemented(what: string): never {
	throw new Error(`vfs: ${what} is not implemented in Wave 1 (PRD-015b owns it — see CONVENTIONS.md)`);
}
