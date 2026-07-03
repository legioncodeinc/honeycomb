/**
 * The capture handler (PRD-005a FR-1..10, a-AC-1..6) — daemon-side.
 *
 * Attaches the capture route to the PRD-004 `/api/hooks` group and the read-back
 * route, then for each accepted event INSERTs exactly ONE `sessions` row. It is
 * the input half of the request lifecycle: it commits the event durably and
 * returns fast, before any model runs. Distillation is decoupled — capture only
 * records + cues.
 *
 * ── Where it mounts (FR-1 / a-AC-6) ──────────────────────────────────────────
 * `/api/hooks` is a SESSION-SCOPED, PROTECTED group (server.ts ROUTE_GROUPS:
 * `protect: true, session: true`). The bootstrap already mounted runtime-path
 * (004d) AHEAD of permission (004a) on it, so attaching handlers via
 * `daemon.group("/api/hooks")` (the a-AC-6 seam) inherits BOTH middlewares with
 * ZERO re-wiring — capture sits behind runtime-path + permission as required. The
 * routes register RELATIVE to the group base: `/capture` and `/conversation`.
 *
 * ── The daemon is the only DeepLake client (FR-6 of 002) ─────────────────────
 * The handler reaches storage SOLELY through the injected {@link StorageQuery} +
 * the catalog `HealTarget` — never a raw fetch. It runs the append-only INSERT
 * through `appendOnlyInsert` (which wraps `withHeal`: a missing `sessions` table
 * is CREATEd from its ColumnDef array and the INSERT retried ONCE — FR-7 /
 * a-AC-4). Every interpolated value goes through the 002b helpers via the typed
 * `val.*` / `appendOnlyInsert` path — the attacker-controllable JSONB `message`
 * is `val.text` → `eLiteral` (FR-9). `audit:sql` scans `src/daemon` and the
 * handler builds no SQL by hand, so the gate stays green.
 *
 * ── One row per event, never concatenated (FR-3 / a-AC-1 / a-AC-2) ───────────
 * `sessions.pattern` is `append-only`; each event is its OWN INSERT. The handler
 * NEVER reads-modify-writes an existing row. N events in a turn → N INSERTs.
 *
 * ── Embedding is inline-async fire-and-forget (D-3) ──────────────────────────
 * After the INSERT returns, the handler kicks off the embed seam WITHOUT awaiting
 * it before responding (b-AC-4). 005a's default seam is a no-op (the column stays
 * NULL); 005b fills the real compute + single attach-UPDATE. A throw in that
 * continuation is caught + logged, never surfaced to the captured turn.
 *
 * ── Per-turn counters cue workers, never run them (FR-8 / a-AC-5 / D-1) ───────
 * Every accepted event bumps the message counter; a turn-terminating event bumps
 * the turn counter (the `tryStopCounterTrigger` path). A crossed threshold
 * ENQUEUEs a `summary` / `skillify` cue-job to the injected queue — NOT inline.
 */

import type { Context } from "hono";
import {
	hasBoundProjectOnDisk,
	resolveScopeFromDisk,
	UNSORTED_PROJECT_ID,
} from "../../../hooks/shared/project-resolver.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { MAX_SESSION_TURNS } from "../../storage/sql.js";
import {
	appendOnlyInsertMany,
	type ColumnValue,
	type RowValues,
	readAppendOrdered,
	val,
} from "../../storage/writes.js";
import { getRequestIdentity } from "../middleware/permission.js";
import type { Daemon } from "../server.js";
import { type EmbedAttachment, noopEmbedAttachment } from "../services/embed-client.js";
import type { JobQueueService } from "../services/job-queue.js";
import { budgetedStringify } from "./budgeted-stringify.js";
import { type BufferClock, CaptureBuffer } from "./capture-buffer.js";
import { type CaptureConfig, resolveCaptureConfig } from "./capture-config.js";
import { type CaptureEvent, type CaptureMetadata, parseCaptureRequest } from "./event-contract.js";
import type { CaptureDroppedEventsCounter } from "./dropped-events.js";
import { type MemoryCue, type TurnCounterConfig, TurnCounters, tryStopCounterTrigger } from "./turn-counters.js";

/** The route group the capture handler attaches to (FR-1). */
export const HOOKS_GROUP = "/api/hooks" as const;

/**
 * The PRD-062a query-meter label for a captured-event append to `sessions`. Threaded
 * onto every capture write (single or batched) so the 062a meter attributes the write
 * cost to `capture-write` and AC-62c.1.3 can show the per-session count drop with batching.
 */
const CAPTURE_WRITE_SOURCE = "capture-write" as const;
/** The capture route, relative to {@link HOOKS_GROUP}. */
export const CAPTURE_PATH = "/capture" as const;
/** The conversation read-back route, relative to {@link HOOKS_GROUP}. */
export const CONVERSATION_PATH = "/conversation" as const;

/** A minimal structured-log sink (matches the queue's logger shape). */
export interface CaptureLogger {
	/** Record a structured event (e.g. `capture.embed.failed`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** Construction deps for the capture handler. Everything is injected for testability. */
export interface CaptureHandlerDeps {
	/** Run the `sessions` INSERT / read-back through this — never a raw fetch (FR-6). */
	readonly storage: StorageQuery;
	/** The `{ table: "sessions", columns }` heal target (catalog `healTargetFor`). */
	readonly sessionsTarget: HealTarget;
	/** The durable queue the per-turn cues are enqueued into (FR-8 — NOT inline). */
	readonly queue: JobQueueService;
	/**
	 * PRD-045a (a-AC-2): the memory-pipeline ENTRY enqueue. Called once per accepted
	 * capture (NOT inline — it enqueues a `memory_extraction` job onto the SAME durable
	 * queue and returns), so a captured turn enters the extraction → decision →
	 * controlled-write → graph-persist pipeline. Given the captured event's text + the
	 * tenancy scope it enqueues the entry job (the daemon wires this to the pipeline
	 * fan-out). Optional + FAIL-SOFT: when absent (the Wave-1 posture / a unit test that
	 * does not exercise the pipeline) capture behaves exactly as before; when present, a
	 * throw is caught + logged and NEVER breaks the captured turn (the capture path must
	 * never fail because the pipeline enqueue did).
	 */
	readonly enqueuePipelineEntry?: (
		text: string,
		scope: QueryScope,
		agentId: string,
		projectId?: string,
	) => Promise<void>;
	/**
	 * The embed seam called non-blocking after the INSERT (D-3 / 005b). Defaults to
	 * the no-op attachment: the column stays NULL and the continuation is inert.
	 */
	readonly embed?: EmbedAttachment;
	/** Per-turn counter thresholds (D-1 defaults otherwise). */
	readonly counterConfig?: TurnCounterConfig;
	/** Shared counter store; one is created per handler when absent. */
	readonly counters?: TurnCounters;
	/** Optional structured-log sink. */
	readonly logger?: CaptureLogger;
	/**
	 * Monotonic counter for events acked to the hook but lost on flush/batch-insert (fail-soft
	 * observability). When present, flush failures increment by the number of rows lost.
	 */
	readonly droppedEvents?: CaptureDroppedEventsCounter;
	/** Injected clock (ISO timestamps) so tests are deterministic. Default `Date.now`. */
	readonly now?: () => number;
	/**
	 * PRD-062c (L-C1 / L-C2 / L-X1): the capture write-batching + envelope-trim config.
	 * Defaults to {@link resolveCaptureConfig} (reads the `HONEYCOMB_CAPTURE_*` env flags,
	 * DEFAULT-ON). A test injects an explicit config to force batch on/off and pick a budget
	 * deterministically. When `batch` is false AND the envelope budget is 0 the handler
	 * reproduces EXACTLY the pre-062c behavior (one INSERT per event, full untrimmed
	 * envelope) — AC-9.
	 */
	readonly captureConfig?: CaptureConfig;
	/**
	 * PRD-062c: injected clock/timer seam for the flush window so tests advance the
	 * window deterministically with NO real sleep. Defaults to the real timer
	 * (`setTimeout`/`Date.now`, unref'd so a pending flush never keeps the process alive).
	 */
	readonly bufferClock?: BufferClock;
	/**
	 * PRD-049b: override the local `~/.deeplake/projects.json` cache dir the capture path
	 * resolves `project_id` from (049a `resolveScopeFromDisk`). Defaults to `~/.deeplake` in
	 * production; a test points it at a temp dir with a seeded cache to prove a bound cwd
	 * attributes the captured row to the real project (49b-AC-1) — and a missing cache resolves
	 * to the `__unsorted__` inbox (49b-AC-3, capture never dropped).
	 */
	readonly projectsDir?: string;
	/**
	 * PRD-059a / IRD-123: the first-run capture gate. When `true` (the default), a capture whose
	 * active workspace has ZERO locally-bound projects NO-OPs — it writes no `sessions`/`memory`/
	 * `memory_jobs` row and enqueues no pipeline job (a-AC-1), returning a `{ ok: true, gated: true }`
	 * ack so the shim does not treat the suppression as a failure. The gate reads the SAME local
	 * `~/.deeplake/projects.json` cache the project resolver reads ({@link hasBoundProjectOnDisk}) with
	 * NO DeepLake call (a-AC-3). The moment the first project is bound the gate opens and capture —
	 * including the 049a `__unsorted__` inbox fallback for unbound folders — resumes (a-AC-4 / a-AC-5).
	 *
	 * OPT-IN: the gate suppresses ONLY when explicitly `true` (the production posture the daemon
	 * assembly wires). Unset/`false` → always capture, so a direct-construction unit test that does not
	 * exercise onboarding keeps the pre-059a behaviour. FAIL-OPEN on an unexpected throw: a set-up user
	 * is never hard-blocked because a cache read hiccuped (059a impl-note); only a genuinely empty/absent
	 * store (the unambiguous zero-state) suppresses when the gate is on.
	 */
	readonly firstRunGate?: boolean;
	/**
	 * Wait for the fire-and-forget embed continuation. ONLY for tests — production
	 * NEVER awaits it (b-AC-4). The handler returns the HTTP response before this
	 * resolves; a test can await it to assert the attach happened.
	 */
	readonly onEmbedSettled?: (p: Promise<void>) => void;
}

/** The capture handler surface: the route registrar + the testable internals. */
export interface CaptureHandler {
	/** Attach `/capture` (POST) + `/conversation` (GET) to the `/api/hooks` group. */
	register(daemon: Daemon): void;
	/** The shared per-turn counter store (for assertions). */
	readonly counters: TurnCounters;
	/**
	 * PRD-062c (AC-5 / AC-62c.1.2): force-flush + close the capture write buffer so no
	 * buffered event is lost on a clean stop. The daemon assembly calls this in its
	 * graceful-shutdown path; a test calls it to assert the buffer drains. Idempotent and
	 * never throws (a flush failure on shutdown is logged via the injected logger, not
	 * surfaced). A no-op when batching is off (there is no buffer to drain).
	 */
	flush(): Promise<void>;
}

/**
 * Build the capture handler. The daemon (once wired) or a test constructs this
 * with the storage client + the sessions heal target + the queue, then calls
 * `register(daemon)` AFTER `createDaemon(...)` so the handlers inherit the
 * already-mounted middleware (a-AC-6). No edit to `server.ts`.
 */
export function createCaptureHandler(deps: CaptureHandlerDeps): CaptureHandler {
	const counters = deps.counters ?? new TurnCounters(deps.counterConfig);
	const embed = deps.embed ?? noopEmbedAttachment;
	const now = deps.now ?? ((): number => Date.now());
	const config = deps.captureConfig ?? resolveCaptureConfig();
	const handler = new CaptureRouteHandler(deps, counters, embed, now, config);
	return {
		register(daemon: Daemon): void {
			const group = daemon.group(HOOKS_GROUP);
			if (group === undefined) {
				throw new Error(`createCaptureHandler: route group "${HOOKS_GROUP}" is not scaffolded`);
			}
			group.post(CAPTURE_PATH, (c) => handler.handleCapture(c));
			group.get(CONVERSATION_PATH, (c) => handler.handleConversation(c));
		},
		counters,
		flush: () => handler.flush(),
	};
}

/**
 * One buffered capture write: the pre-built `sessions` row + the tenancy scope it
 * must be written under. The buffer groups these and the flush appends each scope's
 * rows as one multi-row INSERT.
 */
interface BufferedRow {
	readonly row: RowValues;
	readonly scope: QueryScope;
}

/** The route bodies, factored so `register` stays a thin wiring shell. */
class CaptureRouteHandler {
	/**
	 * PRD-062c (L-C1): the capture write buffer. NULL when batching is off — the handler
	 * then does one append-only INSERT per event (the pre-062c path). Lazily created on the
	 * first buffered write so a flag-off handler allocates nothing.
	 */
	private buffer: CaptureBuffer<BufferedRow> | null = null;

	constructor(
		private readonly deps: CaptureHandlerDeps,
		private readonly counters: TurnCounters,
		private readonly embed: EmbedAttachment,
		private readonly now: () => number,
		private readonly config: CaptureConfig,
	) {}

	/**
	 * POST /api/hooks/capture (FR-1..5, FR-7..9 / a-AC-1..5).
	 *
	 * Validate the body at the zod boundary → build ONE append-only `sessions`
	 * INSERT (JSONB message via `val.text`/`eLiteral`, scope + metadata columns) →
	 * heal-once on a missing table → enqueue per-turn cues (never inline) → kick
	 * the non-blocking embed seam → return the row id. The embed is NEVER awaited
	 * before this responds (b-AC-4 / D-3).
	 */
	async handleCapture(c: Context): Promise<Response> {
		const body = await readJson(c);
		if (body === undefined) {
			return c.json({ error: "bad_request", reason: "request body must be JSON" }, 400);
		}
		const parsed = parseCaptureRequest(body);
		if (!parsed.ok) {
			return c.json({ error: "bad_request", reason: "invalid capture event", detail: parsed.error }, 400);
		}
		const { event, metadata } = parsed.value;
		const scope: QueryScope = { org: metadata.org, workspace: metadata.workspace };

		// PRD-059a / IRD-123 — first-run capture gate. Before ANY write, check the local store: while
		// the active workspace has zero locally-bound projects, capture NO-OPs (no `sessions`/`memory`/
		// `memory_jobs` row, no pipeline job, no embed) and returns a clean gated ack — the shim treats
		// this as success, not a failure, and the once-per-session "bind a project to start" notice is
		// emitted by the session-start seam (a-AC-2), never per turn here. The check is a local cache
		// read with NO DeepLake call (a-AC-3). Once the first project is bound, the gate opens and the
		// 049a inbox fallback for unbound folders resumes (a-AC-4 / a-AC-5).
		if (this.firstRunGateClosed(metadata)) {
			return c.json({ ok: true, gated: true, path: metadata.path, enqueued: [] }, 200);
		}

		const id = this.makeRowId(metadata);
		const nowIso = new Date(this.now()).toISOString();
		// PRD-049b (49b-AC-1): resolve the session's project ONCE, then carry it onto BOTH the
		// `sessions` row AND the pipeline-entry job so the distilled fact the pipeline writes is
		// segmented by the SAME project. Capture never drops: a no-cwd session falls to the inbox.
		const projectId = this.resolveCaptureProjectId(metadata);
		const row = this.buildRow(id, event, metadata, nowIso, projectId);

		// PRD-062c (L-C1 / AC-5): the write path. With batching ON the row is BUFFERED and
		// flushed as part of a multi-row append over a bounded window (a burst of turns → one
		// DeepLake write); the handler returns fast once the row is committed to the in-memory
		// window (the buffer GUARANTEES a flush on window-close / size-cap / shutdown). With
		// batching OFF the row is written immediately as ONE append-only INSERT (the pre-062c
		// path, FR-3 / a-AC-1) and a write failure surfaces as 502. Either path threads the
		// `capture-write` 062a meter source and heals a missing `sessions` table once (FR-7).
		if (this.config.batch) {
			this.bufferRow(id, row, scope);
		} else {
			const result = await appendOnlyInsertMany(this.deps.storage, this.deps.sessionsTarget, scope, [row], {
				source: CAPTURE_WRITE_SOURCE,
			});
			if (!isOk(result)) {
				this.deps.logger?.event("capture.insert.failed", { id, kind: result.kind });
				return c.json({ error: "capture_failed", reason: "could not write the session row" }, 502);
			}
		}

		// Per-turn counters → cue background workers, NEVER inline (FR-8 / a-AC-5 / D-1).
		const cues = this.bumpCounters(metadata);
		await this.enqueueCues(cues);

		// PRD-045a (a-AC-2): enqueue the memory-pipeline ENTRY job so the captured turn
		// flows through extraction → decision → controlled-write → graph-persist. It is a
		// queue enqueue (NOT inline work), and FAIL-SOFT — a pipeline enqueue failure must
		// never break the capture path (the row is already committed above).
		await this.enqueuePipelineEntry(event, scope, metadata.agentId, projectId);

		// Fire-and-forget embed (D-3 / b-AC-4): kicked WITHOUT awaiting before responding.
		this.kickEmbed(id, event, scope);

		return c.json({ ok: true, id, path: metadata.path, enqueued: cues.map((cue) => cue.kind) }, 201);
	}

	/**
	 * GET /api/hooks/conversation?path=… (FR-6 / a-AC-6). Read back the `sessions`
	 * rows sharing a `path`, ordered by `creation_date`, scoped to the requesting
	 * org/workspace (via `readAppendOrdered`). Org/workspace come from the same
	 * `x-honeycomb-*` headers the rest of the daemon reads, so the read-back stays
	 * inside the requester's tenancy.
	 *
	 * ── Cross-tenant guard (PRD-022 security) ────────────────────────────────────
	 * When a validated Identity is present, the resolved org MUST equal `identity.org`;
	 * a mismatch returns 400.
	 *
	 * ── Cross-workspace guard (PRD-022 security hardening) ───────────────────────
	 * When a validated Identity is present, the workspace is taken from `identity.workspace`
	 * (the token's own workspace), NOT from the header. The header is trusted ONLY in local
	 * mode (no Identity).
	 */
	async handleConversation(c: Context): Promise<Response> {
		const path = c.req.query("path");
		if (path === undefined || path.trim().length === 0) {
			return c.json({ error: "bad_request", reason: "path query parameter is required" }, 400);
		}
		const org = c.req.header("x-honeycomb-org");
		if (org === undefined || org.length === 0) {
			return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
		}
		// Cross-tenant guard: a forged org header can never cross the token's own org boundary.
		const identity = getRequestIdentity(c);
		if (identity !== undefined && org !== identity.org) {
			return c.json({ error: "bad_request", reason: "org mismatch" }, 400);
		}
		// When an authenticated Identity is present, use its workspace rather than trusting
		// the header — a forged workspace header must not allow cross-workspace access.
		const scope: QueryScope =
			identity !== undefined
				? { org: identity.org, workspace: identity.workspace }
				: (() => {
						// Local mode (no Identity): trust the header, with optional workspace.
						const workspace = c.req.header("x-honeycomb-workspace");
						return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
					})();

		// Bounded to the most-recent turns (default cap): a fan-out session that
		// funnels many sub-agents into one `path` can hold tens of thousands of
		// rows; an unbounded read-back materialized hundreds of MB and stalled.
		const result = await readAppendOrdered(
			this.deps.storage,
			this.deps.sessionsTarget,
			scope,
			path.trim(),
			"*",
			MAX_SESSION_TURNS,
		);
		if (!isOk(result)) {
			this.deps.logger?.event("capture.readback.failed", { path, kind: result.kind });
			return c.json({ error: "read_failed", reason: "could not read the conversation" }, 502);
		}
		return c.json({ path: path.trim(), rows: result.rows as StorageRow[] });
	}

	/**
	 * Buffer one built row for batched flushing (PRD-062c L-C1). Lazily creates the
	 * buffer on first use (a flag-off handler never allocates one). The per-item flush
	 * promise the buffer returns is observed fire-and-forget: a flush failure is logged
	 * here (never swallowed) but does NOT fail the captured turn — the row is committed
	 * to the in-memory window, which the buffer GUARANTEES to flush (window / size /
	 * shutdown). This is the documented trade: worst-case loss is one window on a hard
	 * crash (see {@link CaptureBuffer}); a graceful stop drains the buffer.
	 */
	private recordDropped(count: number): void {
		this.deps.droppedEvents?.increment(count);
	}

	private bufferRow(id: string, row: RowValues, scope: QueryScope): void {
		const buffer = this.ensureBuffer();
		void buffer.add({ row, scope }).catch((err: unknown) => {
			this.recordDropped(1);
			this.deps.logger?.event("capture.flush.failed", {
				id,
				reason: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/** Lazily build the capture write buffer from the resolved config + the flush callback. */
	private ensureBuffer(): CaptureBuffer<BufferedRow> {
		if (this.buffer === null) {
			const cfg = { maxEvents: this.config.maxEvents, windowMs: this.config.windowMs };
			this.buffer =
				this.deps.bufferClock !== undefined
					? new CaptureBuffer<BufferedRow>((batch) => this.flushBatch(batch), cfg, this.deps.bufferClock)
					: new CaptureBuffer<BufferedRow>((batch) => this.flushBatch(batch), cfg);
		}
		return this.buffer;
	}

	/**
	 * Flush a buffered batch as multi-row append(s) (PRD-062c L-C1 / AC-5). Rows that
	 * share a tenancy scope are grouped and written with ONE `appendOnlyInsertMany`, so N
	 * within-window same-scope events become ONE DeepLake write (AC-62c.1.1). Different
	 * scopes (the rare cross-tenant interleave within a window) each get their own append —
	 * a multi-row INSERT cannot span partitions. Every append threads the `capture-write`
	 * 062a meter source. A failed append rejects so the awaiter ({@link bufferRow}) logs it.
	 */
	private async flushBatch(batch: readonly BufferedRow[]): Promise<void> {
		for (const [scope, rows] of groupRowsByScope(batch)) {
			try {
				const result = await appendOnlyInsertMany(this.deps.storage, this.deps.sessionsTarget, scope, rows, {
					source: CAPTURE_WRITE_SOURCE,
				});
				if (!isOk(result)) {
					this.recordDropped(rows.length);
					this.deps.logger?.event("capture.batch_insert.failed", { count: rows.length, kind: result.kind });
					throw new Error(`capture batch append failed: ${result.kind}`);
				}
			} catch (err: unknown) {
				const alreadyCounted = err instanceof Error && err.message.startsWith("capture batch append failed:");
				if (!alreadyCounted) {
					this.recordDropped(rows.length);
					this.deps.logger?.event("capture.batch_insert.failed", {
						count: rows.length,
						kind: err instanceof Error ? err.message : String(err),
					});
				}
				throw err;
			}
		}
	}

	/**
	 * Force-flush + close the buffer on shutdown (PRD-062c AC-5 / AC-62c.1.2). Drains the
	 * remaining window so nothing buffered is lost on a clean stop. A no-op when batching is
	 * off (no buffer). Never throws — a flush failure on shutdown is logged, not surfaced.
	 */
	async flush(): Promise<void> {
		if (this.buffer === null) return;
		try {
			await this.buffer.close();
		} catch (err: unknown) {
			this.deps.logger?.event("capture.flush.failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
			// Per-row losses are counted in flushBatch; avoid double-counting on shutdown drain.
		}
	}

	/**
	 * Build the single `sessions` row's ordered column values (FR-4 / FR-5).
	 *
	 * The JSONB `message` stores the FULL normalized envelope `{ event, metadata }`
	 * so the original structured shape survives intact for later extraction (FR-4) —
	 * including the fields the dedicated columns have no home for (session id,
	 * permission mode). The whole envelope goes through `val.text` → `eLiteral`
	 * (escape-safe; the attacker-controllable prompt text inside it can never break
	 * out of the literal — FR-9). The dedicated columns additionally carry the
	 * metadata onto the row (FR-5): `path` groups the conversation (FR-6),
	 * `filename` the hook event name, `author`/`agent_id` the agent scope, `project`
	 * the cwd, `agent`/`plugin_version` the provenance. `message_embedding` is left
	 * NULL (its DEFAULT) here; 005b attaches it later (D-3). `visibility` defaults;
	 * org/workspace scope the partition.
	 */
	private buildRow(
		id: string,
		event: CaptureEvent,
		meta: CaptureMetadata,
		nowIso: string,
		projectId: string,
	): RowValues {
		// PRD-062c (L-C2 / AC-6): the normalized envelope `{ event, metadata }`, with a
		// `tool_call`'s oversized `input`/`response` capped to the byte budget and replaced by
		// an explicit `…[truncated N bytes]` marker. A budget of 0 disables trimming → the FULL
		// untrimmed envelope (the exact pre-062c content, AC-9). The CONSUMER AUDIT (PRD-062c
		// gating) governs what is trimmed: ONLY the unbounded tool I/O is capped; `event.text`
		// and the WHOLE `metadata` object are preserved verbatim because the skillify miner reads
		// `metadata.sessionId` from this envelope (no dedicated column carries it) and recall +
		// the summary gate read `event.text` — trimming either would be a silent capability cut.
		const message =
			this.config.envelopeBudgetBytes > 0
				? budgetedStringify(event, meta, this.config.envelopeBudgetBytes)
				: JSON.stringify({ event, metadata: meta });
		// PRD-049b (49b-AC-1 / 49b-AC-3): `projectId` is the RESOLVED registry key (049a), resolved
		// ONCE in handleCapture from the session cwd and carried onto the row + the pipeline entry.
		// `project` keeps the raw cwd path (D5). Capture never drops (no-cwd → inbox upstream).
		const row: Array<readonly [string, ColumnValue]> = [
			["id", val.str(id)],
			["path", val.str(meta.path)],
			["filename", val.str(meta.hookEventName)],
			// JSONB message: the verbatim normalized envelope, escaped via eLiteral (FR-4/FR-9).
			["message", val.text(message)],
			// message_embedding omitted → its DEFAULT (NULL); 005b attaches it (D-3).
			["author", val.str(meta.agentId)],
			["agent", val.str(meta.agent)],
			["project", val.str(meta.cwd)],
			// PRD-049b: the resolved registry key the scope clause segments on (additive, D5 keeps `project`).
			["project_id", val.str(projectId)],
			["plugin_version", val.str(meta.pluginVersion)],
			["agent_id", val.str(meta.agentId)],
			// PRD-060a (a-AC-7): the capture-source discriminant. `metadata.agent` is the
			// canonical harness token the shim stamps (`claude-code` for the reference
			// shim), so every Claude-Code-captured row carries `source_tool='claude-code'`.
			["source_tool", val.str(meta.agent)],
			// PRD-060 ROI fix: the per-turn model id (e.g. `claude-opus-4-8`) read from the
			// transcript, so the dashboard prices the turn at its real model's rate. An absent
			// model writes `''` ("model unknown" — the column default); a present model writes the
			// id via the typed `val.str` SQL guard. Carried on the SAME append-only INSERT.
			["model", val.str(modelFor(event))],
			["creation_date", val.str(nowIso)],
			["last_update_date", val.str(nowIso)],
		];
		// PRD-060a (a-AC-5): the per-turn token + cache counts ride the SAME append-only
		// INSERT as the turn — no second write, no row mutation. Only an assistant turn
		// that actually carried a validated `usage` block contributes columns; each count
		// is written ONLY when present (a measured value, including a real 0). Absent
		// counts are OMITTED, so the nullable column defaults to SQL NULL = "token data
		// absent" (a-AC-6) — never a silent 0. (No-usage / non-assistant turns add nothing.)
		for (const [col, value] of usageColumns(event)) {
			row.push([col, val.num(value)]);
		}
		return row;
	}

	/**
	 * Resolve the capture row's `project_id` from the session cwd (PRD-049b 49b-AC-1 / 49b-AC-3).
	 * Uses the thin-client {@link resolveScopeFromDisk} (049a) scoped to the capture's resolved
	 * org/workspace so a stale cross-workspace cache can never bind the wrong project. Capture is
	 * NEVER dropped: a blank cwd, a missing/malformed cache, or any throw falls to the workspace
	 * {@link UNSORTED_PROJECT_ID} inbox (the write-side asymmetry — never fail-closed on capture).
	 */
	/**
	 * Is the first-run capture gate CLOSED for this event's workspace? (PRD-059a a-AC-1 / a-AC-3 /
	 * IRD-123.) The gate is closed when it is ENABLED (`firstRunGate` defaults ON) AND the active
	 * workspace has no locally-bound project ({@link hasBoundProjectOnDisk}, a pure local-cache read —
	 * NO DeepLake call). When closed, the caller no-ops the capture (writes nothing, enqueues nothing).
	 *
	 * FAIL-OPEN on an unexpected throw: a transient cache-read error must NOT hard-block a set-up user,
	 * so a throw is treated as "gate open" (capture proceeds, the 049a inbox fallback applies). Only a
	 * genuinely empty/absent store — the unambiguous zero-state the loader returns WITHOUT throwing —
	 * keeps the gate closed.
	 */
	private firstRunGateClosed(meta: CaptureMetadata): boolean {
		// The gate is OPT-IN: it only suppresses when EXPLICITLY enabled (`firstRunGate === true`, the
		// production posture wired by the daemon assembly). An unset/false flag → always capture, so a
		// direct-construction unit test that does not exercise onboarding keeps the pre-059a behaviour.
		if (this.deps.firstRunGate !== true) return false;
		try {
			const bound = hasBoundProjectOnDisk({
				workspace: meta.workspace,
				...(this.deps.projectsDir !== undefined ? { dir: this.deps.projectsDir } : {}),
			});
			return !bound; // no bound project → gate CLOSED (suppress); ≥1 bound → gate OPEN.
		} catch {
			// Fail-open: never hard-block a set-up user because the local store read hiccuped.
			return false;
		}
	}

	private resolveCaptureProjectId(meta: CaptureMetadata): string {
		if (meta.cwd.trim() === "") return UNSORTED_PROJECT_ID; // no cwd → inbox (never dropped).
		try {
			return resolveScopeFromDisk({
				cwd: meta.cwd,
				org: meta.org,
				workspace: meta.workspace,
				...(this.deps.projectsDir !== undefined ? { dir: this.deps.projectsDir } : {}),
			}).projectId;
		} catch {
			// The resolver is fail-soft; guard belt-and-suspenders so capture never fails on resolution.
			return UNSORTED_PROJECT_ID;
		}
	}

	/** A stable, unique row id for an event (append-only → every event is its own row). */
	private makeRowId(meta: CaptureMetadata): string {
		const rand = Math.floor(Math.random() * 1_000_000);
		return `sess-${meta.sessionId}-${this.now()}-${rand}`;
	}

	/**
	 * Bump the per-turn counters (FR-8). Every accepted event bumps the message
	 * counter; a turn-terminating event additionally fires the Stop-counter trigger
	 * (skillify) — independent of the summary cue (FR-8 impl-note). Returns the cues
	 * to enqueue (possibly both, possibly none).
	 */
	private bumpCounters(meta: CaptureMetadata): MemoryCue[] {
		const cues: MemoryCue[] = [];
		const summaryCue = this.counters.recordMessage(meta.sessionId, meta.path);
		if (summaryCue !== null) cues.push(summaryCue);
		if (meta.isTurnTerminating) {
			const skillifyCue = tryStopCounterTrigger(this.counters, meta.sessionId, meta.path);
			if (skillifyCue !== null) cues.push(skillifyCue);
		}
		return cues;
	}

	/** Enqueue each cue to `memory_jobs` — the daemon's durable queue, NOT inline (a-AC-5). */
	private async enqueueCues(cues: readonly MemoryCue[]): Promise<void> {
		for (const cue of cues) {
			await this.deps.queue.enqueue({
				kind: cue.kind,
				payload: { sessionId: cue.sessionId, path: cue.path, count: cue.count },
			});
		}
	}

	/**
	 * Enqueue the memory-pipeline ENTRY job (PRD-045a a-AC-2). Derives the captured
	 * event's text (the same source string the embed seam uses), and — when the daemon
	 * wired the pipeline seam AND there is text to extract from — calls it to enqueue a
	 * `memory_extraction` job. FAIL-SOFT: any throw is caught + logged so a pipeline
	 * enqueue failure NEVER breaks the captured turn (the `sessions` row is already
	 * committed). A no-op when the seam is unwired (the Wave-1 posture).
	 */
	private async enqueuePipelineEntry(
		event: CaptureEvent,
		scope: QueryScope,
		agentId: string,
		projectId: string,
	): Promise<void> {
		const enqueue = this.deps.enqueuePipelineEntry;
		if (enqueue === undefined) return;
		const text = embedTextFor(event);
		if (text === "") return; // nothing to extract from (e.g. an empty tool response).
		try {
			// PRD-049b: carry the resolved project so the distilled fact is segmented identically.
			await enqueue(text, scope, agentId, projectId);
		} catch (err: unknown) {
			this.deps.logger?.event("capture.pipeline_enqueue.failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Kick the embed seam fire-and-forget (D-3 / b-AC-4). Compute the vector and
	 * issue the single attach-UPDATE in a continuation that is NOT awaited before
	 * the HTTP response. Any throw is caught + logged — a failing embed never breaks
	 * a captured turn (b-AC-3). With the no-op default this is inert. `onEmbedSettled`
	 * lets a TEST await the continuation; production passes nothing.
	 */
	private kickEmbed(id: string, event: CaptureEvent, scope: QueryScope): void {
		const text = embedTextFor(event);
		const settled = (async (): Promise<void> => {
			if (text === "") return; // nothing to embed (e.g. an empty tool response).
			const vector = await this.embed.client.embed(text);
			if (vector === null) return; // disabled / unreachable / non-768 → leave NULL.
			await this.embed.attacher.attach({ id, scope }, vector);
		})().catch((err: unknown) => {
			this.deps.logger?.event("capture.embed.failed", {
				id,
				reason: err instanceof Error ? err.message : String(err),
			});
		});
		this.deps.onEmbedSettled?.(settled);
	}
}

/** Parse the request JSON, returning `undefined` on a malformed/missing body. */
async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		// A non-JSON body is a 400 at the call site; surface `undefined`, never throw.
		return undefined;
	}
}

/**
 * The text an event contributes to its embedding (D-3 / 005b). A `user_message`
 * or `assistant_message` embeds its text; a `tool_call` embeds its tool name +
 * serialized input/response so a tool turn is still semantically recallable. The
 * real model/normalization is 005b's; this is the deterministic source string.
 */
function embedTextFor(event: CaptureEvent): string {
	switch (event.kind) {
		case "user_message":
		case "assistant_message":
			return event.text;
		case "tool_call":
			return [event.tool, serialize(event.input), serialize(event.response)].filter((s) => s.length > 0).join("\n");
	}
}

/**
 * The per-turn token/cache columns an event contributes to its `sessions` row
 * (PRD-060a a-AC-5 / a-AC-6). ONLY an `assistant_message` that carried a validated
 * `usage` block contributes, and ONLY the counts actually present are emitted —
 * each as a measured integer (a real 0 included). An absent count is OMITTED so the
 * nullable column defaults to SQL NULL = "token data absent" (a-AC-6), never a
 * silent 0. The zod boundary already guaranteed every present count is a
 * non-negative integer, so no re-validation is needed here.
 */
function usageColumns(event: CaptureEvent): ReadonlyArray<readonly [string, number]> {
	if (event.kind !== "assistant_message" || event.usage === undefined) return [];
	const u = event.usage;
	const cols: Array<readonly [string, number]> = [];
	if (u.input !== undefined) cols.push(["input_tokens", u.input]);
	if (u.output !== undefined) cols.push(["output_tokens", u.output]);
	if (u.cacheRead !== undefined) cols.push(["cache_read_input_tokens", u.cacheRead]);
	if (u.cacheCreation !== undefined) cols.push(["cache_creation_input_tokens", u.cacheCreation]);
	return cols;
}

/**
 * The per-turn `model` id an event contributes to its `sessions` row (PRD-060 ROI fix). ONLY an
 * `assistant_message` that carried a (zod-validated, non-empty) `model` contributes the id; every
 * other event — and an assistant turn whose model is unknown — contributes `''` (the column default
 * = "model unknown"). The zod boundary already trimmed/omitted a blank model, so a present value
 * here is a real model id. The dashboard's `resolveRate` reads this to price the turn at its real
 * model's rate (an Opus turn at the Opus row, not the Sonnet default).
 */
function modelFor(event: CaptureEvent): string {
	return event.kind === "assistant_message" && event.model !== undefined ? event.model : "";
}

/**
 * Group buffered rows by their tenancy scope (PRD-062c L-C1). A multi-row INSERT
 * cannot span partitions, so rows are bucketed by `org`+`workspace` and each bucket
 * is appended as one statement. Insertion order is preserved within a bucket (the
 * `Map` keeps first-seen key order) so `creation_date` ordering is unaffected. In the
 * common single-tenant daemon every row shares one scope → one bucket → one append.
 */
function groupRowsByScope(batch: readonly BufferedRow[]): Map<QueryScope, RowValues[]> {
	const byKey = new Map<string, { scope: QueryScope; rows: RowValues[] }>();
	for (const item of batch) {
		// Collision-free composite key: JSON-encode the pair so a separator char in an
		// org/workspace value can never alias a different scope into the same bucket.
		const key = JSON.stringify([item.scope.org, item.scope.workspace ?? ""]);
		const bucket = byKey.get(key);
		if (bucket === undefined) byKey.set(key, { scope: item.scope, rows: [item.row] });
		else bucket.rows.push(item.row);
	}
	const out = new Map<QueryScope, RowValues[]>();
	for (const { scope, rows } of byKey.values()) out.set(scope, rows);
	return out;
}

/** Serialize an unknown JSON value to a string for embedding (empty when absent). */
function serialize(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		// A value that cannot serialize (a cycle) contributes nothing — never throw.
		return "";
	}
}
