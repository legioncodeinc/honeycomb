/**
 * Wiki-summary contracts + seams — PRD-017 Wave 1 (the typed shapes 017a / 017b
 * code against).
 *
 * Wiki summaries collapse verbose session traces into an AI-written markdown
 * SUMMARY written to the `memory` table so recall ranks DOCUMENTS, not thousands
 * of raw `sessions` rows. The pipeline has two sub-PRDs that meet ONLY at these
 * contracts:
 *
 *   - 017a (summary worker, `worker.ts`, THIS WAVE, FULL) — trigger handling +
 *     per-session lock + retry-on-empty event fetch + the gate-CLI shell-out +
 *     embed + the SELECT-before-INSERT `memory` write at
 *     `/summaries/<userName>/<sessionId>.md`. PRODUCES the per-session summary row.
 *   - 017b (synthesis, `synthesis.ts`) — CONSUMES 017a's per-session summaries:
 *     writes a tenant-scoped `MEMORY.md` linking them + per-session-resumable
 *     thread heads. An honest stub this Wave (see {@link notImplemented}).
 *
 * ── The non-negotiable invariants every seam encodes ─────────────────────────
 *   1. THE HOOK SIGNALS THE DAEMON; THE DAEMON OWNS THE ONLY DEEPLAKE CONNECTION.
 *      The worker runs INSIDE the honeycomb daemon (port 3850, the only DeepLake
 *      client). Hooks SIGNAL the daemon on the final + periodic triggers; they
 *      never spawn the worker or open DeepLake (FR-1). The worker's storage seam
 *      IS the daemon-side {@link SummaryStore} (a thin wrapper over `StorageQuery`).
 *   2. SELECT-BEFORE-INSERT KEYED ON `path`, NEVER AN IN-PLACE UPDATE (a-AC-6 /
 *      D-6). A summary is written EXACTLY ONCE per session at the canonical path
 *      `/summaries/<userName>/<sessionId>.md` via the 002d `selectBeforeInsert`
 *      primitive — the SAME live-proven discipline `codebase` snapshots use. There
 *      is NO `update` method on {@link SummaryStore} by construction: the DeepLake
 *      backend coalesces rapid in-place UPDATEs against a freshly-written row and
 *      silently drops one, so an in-place `SET` can never converge. A live read of
 *      a just-written row UNDER-reports, so reads are POLL-CONVERGENT.
 *
 * ── Boundary vs interior (where zod lives) ──────────────────────────────────
 * The shapes 017a passes around ({@link SessionEvent}, {@link SummaryTrigger},
 * {@link WorkerConfig}) are plain TS interfaces — they are constructed in-process
 * from already-trusted daemon state, so a runtime re-validation would be ceremony
 * (mirrors `skillify/contracts.ts` + `sources/contracts.ts`). zod validates at the
 * UNTRUSTED boundary (the CLI / hook payload), which the hook half owns.
 *
 * Every value these contracts carry is eventually interpolated into SQL by
 * `worker.ts` through the `sqlIdent` / `sLiteral` / `val.*` helpers — the contracts
 * hold the data, the writer escapes it.
 */

import type { EmbedClient } from "../services/embed-client.js";

// Re-export the 005b EmbedClient seam so 017a + the Wave-2 Bee reach it from one
// place (the summary worker embeds the markdown through exactly this seam — a THROW
// is non-fatal, a-AC-5).
export type { EmbedClient } from "../services/embed-client.js";

// ────────────────────────────────────────────────────────────────────────────
// SummaryTrigger — what fired a summary run (final vs periodic). 017a consumes.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The two trigger CLASSES (D-1 / FR-2). `final` fires ONCE per session at a
 * terminating hook event; `periodic` fires mid-session when a `turn-counters`
 * threshold (messages-since-last-summary OR elapsed-hours) is crossed. Frozen so
 * the type + the worker's branch read one source.
 */
export const SUMMARY_TRIGGER_KINDS = Object.freeze(["final", "periodic"] as const);
/** A single trigger class. */
export type SummaryTriggerKind = (typeof SUMMARY_TRIGGER_KINDS)[number];

/**
 * The terminating hook events that fire the `final` trigger (D-1 / FR-2). A
 * session is summarized exactly once at any of these; the per-session lock + the
 * SELECT-before-INSERT keep it exactly-once even if two fire.
 */
export const FINAL_TRIGGER_EVENTS = Object.freeze(["Stop", "SessionEnd", "session_shutdown"] as const);
/** A terminating hook event. */
export type FinalTriggerEvent = (typeof FINAL_TRIGGER_EVENTS)[number];

/** The reason a `periodic` trigger fired — a message-count or elapsed-hours crossing. */
export const PERIODIC_TRIGGER_REASONS = Object.freeze(["messages", "hours"] as const);
/** A periodic-trigger reason. */
export type PeriodicTriggerReason = (typeof PERIODIC_TRIGGER_REASONS)[number];

/**
 * What fired a summary run (D-1 / a-AC-1 / a-AC-4). The hook signals the daemon
 * with one of these; the daemon worker acts on it. `final` carries the terminating
 * event; `periodic` carries the threshold reason + the crossing count, so the
 * worker's diagnostics can attribute the run.
 */
export type SummaryTrigger =
	| { readonly kind: "final"; readonly event: FinalTriggerEvent }
	| { readonly kind: "periodic"; readonly reason: PeriodicTriggerReason; readonly count: number };

// ────────────────────────────────────────────────────────────────────────────
// SummarySession + SummaryScope — the session identity + the tenant the run is in.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The session a summary run targets (a-AC-1 / a-AC-3). `sessionId` is the harness
 * session id (the lock key + the write-path segment); `userName` is the operator
 * name the canonical path is scoped to (`/summaries/<userName>/<sessionId>.md`);
 * `path` is the `sessions`-table conversation grouping key the events are fetched
 * by (one logical session). `agentId` carries the host agent that triggered the
 * session so the daemon can select the matching gate-CLI invocation (FR-8).
 */
export interface SummarySession {
	/** The harness session id — the per-session lock key + the write-path segment. */
	readonly sessionId: string;
	/** The operator name the summary path is scoped under (`/summaries/<userName>/…`). */
	readonly userName: string;
	/** The `sessions`-table conversation grouping key the events are fetched by. */
	readonly path: string;
	/** The host agent that triggered the session (selects the gate-CLI invocation). */
	readonly agentId?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// WorkerConfig — the per-run tuning (retry + backoff + gate timeout). 017a reads.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The retry-on-empty + gate-timeout tuning a single run serializes (D-3 / D-4 /
 * FR-5 / FR-8). DeepLake reads lag the write, so a just-ended session's events
 * may not be visible yet; the worker retries the fetch with LINEAR backoff up to
 * `retryLimit` at `backoffMs` before giving up and removing the in-progress
 * placeholder (a-AC-3). The gate-CLI shell-out is bounded by `gateTimeoutMs`.
 *
 * Every field is injectable so a test drives the retry + abort paths FAST with a
 * fake clock; production resolves the defaults from the env at daemon construction.
 */
export interface WorkerConfig {
	/** Max event-fetch retries on an empty result before giving up (a-AC-3). Default 5. */
	readonly retryLimit: number;
	/** The LINEAR backoff between fetch retries, in ms (a-AC-3). Default 1500. */
	readonly backoffMs: number;
	/** The gate-CLI shell-out timeout, in ms (FR-8). Default 120000. */
	readonly gateTimeoutMs: number;
}

/** The D-3 default event-fetch retry limit (FR-5: `HONEYCOMB_WIKI_EVENT_RETRIES`). */
export const DEFAULT_RETRY_LIMIT = 5;
/** The D-3 default linear backoff in ms (FR-5: `HONEYCOMB_WIKI_EVENT_BACKOFF_MS`). */
export const DEFAULT_BACKOFF_MS = 1_500;
/** The D-4 default gate-CLI timeout in ms (FR-8). */
export const DEFAULT_GATE_TIMEOUT_MS = 120_000;

/** The default {@link WorkerConfig} (D-3 / D-4 defaults), overridable per run. */
export const DEFAULT_WORKER_CONFIG: WorkerConfig = Object.freeze({
	retryLimit: DEFAULT_RETRY_LIMIT,
	backoffMs: DEFAULT_BACKOFF_MS,
	gateTimeoutMs: DEFAULT_GATE_TIMEOUT_MS,
});

// ────────────────────────────────────────────────────────────────────────────
// SessionEvent — one fetched `sessions` row the gate renders. 017a fetches.
// ────────────────────────────────────────────────────────────────────────────

/**
 * One fetched session event the gate prompt renders (a-AC-1 / FR-5). A subset of
 * a `sessions` row: the JSONB `message` envelope, the author, and the ISO date the
 * worker orders events by (`creation_date` ascending). The worker SCRUBS each
 * event's text with `redactSecrets` (reused from skillify) before it reaches the
 * gate prompt so a pasted credential never lands in a summary.
 */
export interface SessionEvent {
	/** The raw JSONB `message` envelope `{ event, metadata }` (string or parsed). */
	readonly message: unknown;
	/** The author/agent that produced the event. */
	readonly author: string;
	/** The row's ISO creation date — events render in ascending order. */
	readonly creationDate: string;
}

// ────────────────────────────────────────────────────────────────────────────
// SessionEventFetcher SEAM — the scoped read of `sessions` with retry on empty.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The session-event fetch seam (a-AC-3 / FR-5). ONE attempt: fetch all of a
 * session's events from `sessions`, ordered by `creation_date` ascending. The
 * worker drives the retry-on-empty LINEAR backoff loop ON TOP of this seam, so the
 * seam stays a single round trip and the retry policy is testable with a fake
 * clock. The real impl ({@link createSessionEventFetcher} in `worker.ts`) builds
 * the scoped, `sLiteral`-escaped SELECT and dispatches through the daemon-side
 * `StorageQuery`; a test injects canned events (and an empty-then-present script
 * for the retry AC).
 */
export interface SessionEventFetcher {
	/** Fetch a session's events for ONE attempt (ascending by date; may be empty). */
	fetch(session: SummarySession): Promise<readonly SessionEvent[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// SummaryGenCli SEAM — the host-harness gate CLI → markdown (017a owns; faked).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The summary-generation gate seam (a-AC-1 / a-AC-2 / D-4 / FR-8 / FR-9). The
 * summary is NOT generated with an API key — the worker SHELLS OUT to the host
 * agent's own CLI (claude_code / codex / cursor / hermes / pi), which already
 * holds the operator's auth and matches the operator's model. The real impl
 * ({@link createHostSummaryGenCli} in `worker.ts`) is a `child_process.spawn` with
 * an args ARRAY and `shell:false` (no-shell, so a hostile transcript can never
 * command-inject — reused from skillify's `systemGateSpawner`), bounded by
 * `gateTimeoutMs` with a SIGTERM kill, and the subprocess env sets
 * `HONEYCOMB_WIKI_WORKER=1` + `HONEYCOMB_CAPTURE=false` so the gate call does not
 * trigger its OWN capture loop (a-AC-2 / FR-9).
 *
 * `run` takes the assembled gate prompt (the scrubbed, ordered events) and
 * resolves to the generated markdown; a timeout / crash REJECTS (the worker treats
 * a throw as "no markdown" — it removes the placeholder and writes nothing). A
 * test fakes this deterministically (there is no host CLI in the test env).
 */
export interface SummaryGenCli {
	/** Shell out to the host CLI with the gate prompt; resolve to the markdown body. */
	run(prompt: string): Promise<string>;
}

/**
 * Build a deterministic FAKE {@link SummaryGenCli} that returns a fixed body (the test
 * double — there is no host CLI in this env). 017a's own tests drive the real
 * shell-out's args-array + env (a-AC-2) through the lower-level spawner seam; the
 * worker-level tests use this fake.
 *
 * PRD-046b: the worker now expects the STRUCTURED gate object `{ extraction, summary,
 * key }`. To keep the existing 017a worker-level callers (which pass bare markdown)
 * working, a plain (non-JSON) `body` is WRAPPED into a valid structured envelope whose
 * `summary` is that markdown verbatim — so a caller asserting on the summary body is
 * unaffected, and the parser/grounding path is exercised. A `body` that is ALREADY a
 * JSON object is returned as-is, so a 046b test can drive a hand-crafted gate response
 * (e.g. a confabulation fixture).
 */
export function createFakeSummaryGenCli(body: string): SummaryGenCli {
	const trimmed = body.trim();
	const isJsonObject = trimmed.startsWith("{");
	const out = isJsonObject ? body : JSON.stringify({ extraction: {}, summary: body, key: "" });
	return {
		async run(): Promise<string> {
			return out;
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// WorkerLock SEAM — the PER-SESSION lock (a-AC-4 / D-2 / FR-3).
// ────────────────────────────────────────────────────────────────────────────

/** The handle a successful lock acquire returns — released in the worker's `finally`. */
export interface SummaryLockHandle {
	/** Release the lock. Idempotent — safe in a `finally` even if already released. */
	release(): void;
}

/**
 * The PER-SESSION worker-lock seam (a-AC-4 / D-2 / FR-3). `acquire` returns a
 * handle on success or `null` when a summary is ALREADY in flight for the SAME
 * session — the second trigger is SUPPRESSED, so at most one concurrent summary
 * runs per session. The real impl ({@link createFileSessionLock} in `worker.ts`)
 * is an atomic `O_EXCL` lock file keyed by `sessionId` (adapted verbatim from
 * skillify's `createFileWorkerLock`, but PER-SESSION not per-project); a test
 * injects an in-memory lock. The handle is ALWAYS released in the worker's
 * `finally` — on success, on an empty-give-up, AND on a gate throw.
 */
export interface SummaryLock {
	/** Try to take the lock for a session; `null` when already held (suppress the run). */
	acquire(sessionId: string): SummaryLockHandle | null;
}

// ────────────────────────────────────────────────────────────────────────────
// SummaryStore SEAM — the daemon's `memory` storage (a-AC-1 / a-AC-6 dispatch).
// ────────────────────────────────────────────────────────────────────────────

/**
 * One per-session summary row the worker writes (a-AC-1). Maps onto the existing
 * `memory` table (`sessions-summaries.ts` MEMORY_COLUMNS): the path → `path`; the
 * markdown body → `summary`; the 768-dim embedding (or NULL) → `summary_embedding`;
 * the excerpt → `description`; the author → `author`/`agent`. No schema change.
 */
export interface SummaryRow {
	/** The canonical `/summaries/<userName>/<sessionId>.md` path — the identity key. */
	readonly path: string;
	/** The AI-written markdown summary body (→ `summary`). */
	readonly summary: string;
	/**
	 * The Tier-1 KEY — a ≤1-sentence, keyword-dense headline derived from the GROUNDED
	 * summary (→ `memory.key`, PRD-046b b-AC-2). The prime (046c) skims this with a pure
	 * SQL select, NO generation at read time (b-AC-4). Empty when no key was derivable.
	 */
	readonly key: string;
	/** A short excerpt for listings (→ `description`). */
	readonly description: string;
	/** The 768-dim embedding of the markdown, or NULL when embedding failed (a-AC-5). */
	readonly embedding: readonly number[] | null;
	/** The author/agent that produced the summary (→ `author`/`agent`). */
	readonly author: string;
}

/**
 * The daemon-side `memory` storage seam (a-AC-1 / a-AC-3 / a-AC-6 / FR-1 / FR-6).
 * The worker runs INSIDE the daemon, so "through the daemon, not a direct DeepLake
 * connection" means it writes through the storage path the daemon ALREADY holds —
 * never a re-opened client. {@link createSummaryStore} (in `worker.ts`) builds the
 * real store over the daemon-side `StorageQuery`; a unit test injects a fake
 * recording store so it can assert the write was a SELECT-before-INSERT keyed on
 * `path` and that NO in-place UPDATE was ever emitted (a-AC-6).
 *
 * There is NO `update` method by construction — the store CANNOT mutate a row in
 * place. {@link writeSummary} is SELECT-before-INSERT (insert iff absent; an
 * existing row at the path means the summary already landed — exactly-once);
 * {@link placeUisExists} / {@link writePlaceholder} / {@link removePlaceholder}
 * manage the in-progress placeholder so a give-up never strands it (a-AC-3).
 */
export interface SummaryStore {
	/**
	 * Write an in-progress PLACEHOLDER row at the path (a-AC-3). `description` is
	 * marked `'in progress'` so {@link removePlaceholder} can delete ONLY the
	 * placeholder (never clobbering a concurrent real summary). SELECT-before-INSERT
	 * keyed on `path` — never an in-place UPDATE.
	 */
	writePlaceholder(path: string, author: string): Promise<void>;
	/**
	 * Remove the in-progress placeholder at the path on a final give-up (a-AC-3 /
	 * FR-6), guarded by `description = 'in progress'` so a concurrent REAL summary is
	 * never clobbered. A no-op when the placeholder is already gone (idempotent).
	 */
	removePlaceholder(path: string): Promise<void>;
	/**
	 * Write the per-session summary row via SELECT-before-INSERT keyed on `path`
	 * (a-AC-1 / a-AC-6 / D-6). Insert iff absent; an existing REAL summary at the
	 * path means it already landed (exactly-once). Returns whether this call wrote a
	 * fresh row. NEVER an in-place UPDATE — the prior placeholder is replaced by the
	 * insert path, not mutated.
	 */
	writeSummary(row: SummaryRow): Promise<SummaryWriteOutcome>;
}

/** The outcome of a {@link SummaryStore.writeSummary} call, for the worker's audit. */
export interface SummaryWriteOutcome {
	/** True when this call inserted a fresh summary row; false when one already existed. */
	readonly written: boolean;
	/** True when the post-insert re-verification observed a duplicate (race — observable). */
	readonly raceDetected: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// notImplemented — the honest Wave-2 (017b) thrower.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The standard "PRD-017b fills this" thrower (mirrors the skillify / sources / vfs
 * harness posture). A stubbed 017b body calls this so an accidental early call
 * FAILS LOUD with the owning sub-PRD, never silently returns a fake-passing value.
 */
export function notImplemented(what: string): never {
	throw new Error(`summaries: ${what} is not implemented in Wave 1 (PRD-017b owns it — see CONVENTIONS.md)`);
}
