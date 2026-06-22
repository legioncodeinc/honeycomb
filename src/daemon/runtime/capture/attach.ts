/**
 * The `/api/hooks/*` handler attach seam — PRD-019b + PRD-021c (daemon side).
 *
 * ── PRD-021c (c-AC-3): the two missing endpoints attach ALONGSIDE capture ────
 * The 019b hook lifecycle has THREE daemon calls: `/capture` (per-turn rows),
 * `/context` (the session-start rules/goals block the renderer asks for), and
 * `/session-end` (mark-ended + usage + skillify). Originally only `/capture` was
 * attached. This seam now also attaches `/context` and `/session-end` onto the SAME
 * already-mounted `/api/hooks` group (they inherit the runtime-path + permission
 * middleware with zero re-wiring, exactly like capture), so all three lifecycle
 * calls REACH the daemon. Their full handler bodies are 021d/021e's; this seam wires
 * DEFAULTED lifecycle-composing handlers and exposes `contextHandler` /
 * `sessionEndHandler` options for 021d/021e to pass the real bodies. The change is
 * ADDITIVE — `assembleSeams` calls `attachHooks(daemon, { storage, queue })`
 * unchanged and now gets all three endpoints.
 *
 * The capture handler (`capture-handler.ts`) ships a `register(daemon)` method (the
 * PRD-005a a-AC-6 seam) but nothing called it yet: the daemon bootstrap
 * (`server.ts`) only SCAFFOLDS the `/api/hooks` route group (session-scoped,
 * protected, runtime-path ahead of permission). This module is the single named
 * step the daemon assembly path calls AFTER `createDaemon(...)` to wire
 * `capture-handler.ts` onto that already-mounted group — so `/api/hooks/capture`
 * (the endpoint every 019b/019c hook POSTs to) is live and inherits the
 * runtime-path + permission middleware with ZERO re-wiring.
 *
 * It is storage-correct: it constructs the capture handler with the injected
 * storage client + the `sessions` heal target (defaulting to `healTargetFor`) + the
 * durable queue, exactly as `capture-handler.ts` requires. It is IDEMPOTENT at the
 * assembly level — the daemon assembly calls it once; calling it twice would
 * register the routes twice, so the assembly guards the single call (this helper
 * does not hold global state).
 *
 * Deferred assembly (mirrors the 001–018 posture): the production daemon assembly
 * that owns the live storage client + queue is itself a later wiring step. This
 * module is the seam that step calls; it is constructed-and-tested here, not
 * auto-invoked by importing the daemon (no behavior change to `createDaemon`).
 */

import type { Context } from "hono";
import { healTargetFor } from "../../storage/catalog/index.js";
import type { HealTarget } from "../../storage/heal.js";
import type { StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import type { JobQueueService } from "../services/job-queue.js";
import type { EmbedAttachment } from "../services/embed-client.js";
import { SUMMARY_JOB_KIND } from "../summaries/index.js";
import {
	type CaptureHandler,
	type CaptureLogger,
	createCaptureHandler,
	HOOKS_GROUP,
} from "./capture-handler.js";

/** The session-start context route, relative to {@link HOOKS_GROUP} (PRD-021c c-AC-3). */
export const CONTEXT_PATH = "/context" as const;
/** The session-end route, relative to {@link HOOKS_GROUP} (PRD-021c c-AC-3). */
export const SESSION_END_PATH = "/session-end" as const;

/**
 * A daemon hook endpoint handler (the 021d/021e seam). Returns the {@link Response}
 * the route serves. The 021c attach wires a DEFAULTED handler so the endpoint exists
 * and serves NOW (c-AC-3 — all three lifecycle calls reach the daemon); 021d/021e
 * pass the real bodies (the rules/goals render for `/context`, the mark-ended +
 * usage + skillify for `/session-end`).
 */
export type HookEndpointHandler = (c: Context) => Response | Promise<Response>;

/** Options for {@link attachHooksHandlers}. Mirrors the capture handler's deps, with sane defaults. */
export interface AttachHooksOptions {
	/** The storage client the capture INSERT/read-back runs through (FR-6, never a raw fetch). */
	readonly storage: StorageQuery;
	/** The durable queue per-turn cues enqueue into (NOT inline). */
	readonly queue: JobQueueService;
	/** The `sessions` heal target. Defaults to `healTargetFor("sessions")`. */
	readonly sessionsTarget?: HealTarget;
	/** The non-blocking embed seam (005b). Defaults to the handler's no-op. */
	readonly embed?: EmbedAttachment;
	/** Optional structured-log sink. */
	readonly logger?: CaptureLogger;
	/**
	 * The `/api/hooks/context` handler (PRD-021c c-AC-3). Defaults to a renderer that
	 * returns an EMPTY context block (`{ additionalContext: "" }`, status 200) — so the
	 * session-start renderer's read SUCCEEDS and the lifecycle composes; 021d/021e
	 * supply the real rules/goals render under the request scope.
	 */
	readonly contextHandler?: HookEndpointHandler;
	/**
	 * The `/api/hooks/session-end` handler (PRD-021c c-AC-3). Defaults to an
	 * acknowledgement (`{ ok: true }`, status 200) — so the session-end core's
	 * mark+usage+skillify call SUCCEEDS and the lifecycle composes; 021d/021e supply
	 * the real server-side work.
	 */
	readonly sessionEndHandler?: HookEndpointHandler;
}

/**
 * Attach the `/api/hooks/*` handlers onto the daemon's already-mounted `/api/hooks`
 * route group (the a-AC-6 / 019b + 021c c-AC-3 attach step). Constructs the capture
 * handler with the injected storage + queue (+ the `sessions` heal target, defaulted)
 * and calls its `register(daemon)`, THEN attaches `/context` and `/session-end` onto
 * the SAME group so all three lifecycle calls reach the daemon. The two new endpoints
 * inherit the runtime-path + permission middleware with zero re-wiring (exactly like
 * capture). Their handlers default to lifecycle-composing responders that 021d/021e
 * replace. ADDITIVE: `assembleSeams` calls `attachHooks(daemon, { storage, queue })`
 * unchanged and gets all three endpoints. Returns the constructed
 * {@link CaptureHandler} so the caller can read its per-turn counters. Call ONCE.
 */
export function attachHooksHandlers(daemon: Daemon, options: AttachHooksOptions): CaptureHandler {
	const handler = createCaptureHandler({
		storage: options.storage,
		sessionsTarget: options.sessionsTarget ?? healTargetFor("sessions"),
		queue: options.queue,
		...(options.embed !== undefined ? { embed: options.embed } : {}),
		...(options.logger !== undefined ? { logger: options.logger } : {}),
	});
	handler.register(daemon);

	// ── c-AC-3: attach the two missing endpoints ALONGSIDE capture. They join the
	// SAME `/api/hooks` group the capture handler registered on, inheriting the
	// runtime-path + permission middleware with zero re-wiring. Defaulted handlers
	// make all three lifecycle calls reach the daemon NOW; 021d/021e replace them.
	const group = daemon.group(HOOKS_GROUP);
	if (group === undefined) {
		throw new Error(`attachHooksHandlers: route group "${HOOKS_GROUP}" is not scaffolded`);
	}
	const contextHandler = options.contextHandler ?? defaultContextHandler;
	// PRD-046a (FINAL trigger): the default session-end handler enqueues a `summary` FINAL
	// job into the SAME durable `memory_jobs` queue (the daemon-owned signal — the hook
	// SIGNALS, the daemon-resident summary worker runs the gate). 021d/021e may replace the
	// whole handler with the real mark+usage+skillify body; until then this defaulted body
	// keeps the lifecycle composing AND fires the final summary trigger.
	const sessionEndHandler = options.sessionEndHandler ?? makeSessionEndHandler(options.queue, options.logger);
	group.post(CONTEXT_PATH, (c) => contextHandler(c));
	group.post(SESSION_END_PATH, (c) => sessionEndHandler(c));

	return handler;
}

/**
 * The defaulted `/api/hooks/context` handler (c-AC-3). Returns an empty context block
 * with status 200, so the session-start {@link ContextRenderer} read SUCCEEDS (it
 * coerces an empty `additionalContext` to `""`) and the lifecycle composes. 021d/021e
 * replace this with the real rules/goals render under the request scope.
 */
function defaultContextHandler(c: Context): Response {
	return c.json({ additionalContext: "" }, 200);
}

/**
 * The session metadata a final-trigger enqueue needs, pulled from the session-end body's
 * `meta` (the {@link HookSessionMeta} the shim forwarded). All optional — a missing
 * `sessionId`/`path` simply means no final job is enqueued (the ack still succeeds).
 */
interface SessionEndMeta {
	readonly sessionId?: unknown;
	readonly path?: unknown;
	readonly agentId?: unknown;
}

/** Narrow an unknown field to a non-empty string, else `undefined`. */
function nonEmptyStr(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Build the defaulted `/api/hooks/session-end` handler (PRD-021c c-AC-3 + PRD-046a FINAL
 * trigger). It acknowledges the mark-ended + usage + skillify intents with status 200 (so
 * the session-end core's call SUCCEEDS and the lifecycle composes — 021d/021e replace the
 * body with the real server-side work), AND enqueues a `summary` FINAL job into the
 * durable `memory_jobs` queue so the daemon-resident summary worker summarizes the
 * just-ended session (PRD-046a a-AC-2). The hook SIGNALS; the daemon owns the worker.
 *
 * The enqueue is FAIL-SOFT and NON-BLOCKING: a malformed body, a missing `sessionId`/
 * `path`, or a queue error never fails the session-end ack (the ack is the hook's
 * fast-exit contract; the summary is best-effort, never load-bearing for the turn).
 * The session identity (`sessionId`/`path`/`agentId`) is read from the body's `meta`;
 * the operator name (`userName`) from the `x-honeycomb-org` header (the resolved tenant),
 * matching the summary worker's `scope.org` fallback.
 */
function makeSessionEndHandler(queue: JobQueueService, logger?: CaptureLogger): HookEndpointHandler {
	return async (c: Context): Promise<Response> => {
		// Read the session identity off the body's `meta`, fail-soft — a non-JSON or
		// shapeless body still acks (the lifecycle composes) and simply skips the enqueue.
		let meta: SessionEndMeta = {};
		try {
			const body = (await c.req.json()) as { meta?: SessionEndMeta } | undefined;
			if (body !== undefined && body !== null && typeof body === "object" && body.meta !== undefined) {
				meta = body.meta;
			}
		} catch {
			// A bodyless / non-JSON session-end POST is valid (the ack does not require one).
		}

		const sessionId = nonEmptyStr(meta.sessionId);
		const path = nonEmptyStr(meta.path);
		const agentId = nonEmptyStr(meta.agentId);
		const userName = nonEmptyStr(c.req.header("x-honeycomb-org"));

		// Enqueue the FINAL summary job only when we have the lock key + the event-fetch
		// grouping key (a meaningless summary has neither). Never await/block the ack.
		if (sessionId !== undefined && path !== undefined) {
			try {
				await queue.enqueue({
					kind: SUMMARY_JOB_KIND,
					payload: {
						sessionId,
						path,
						...(userName !== undefined ? { userName } : {}),
						...(agentId !== undefined ? { agentId } : {}),
						triggerKind: "final",
						reason: "SessionEnd",
						count: 0,
					},
				});
			} catch (err: unknown) {
				// A queue error must NEVER fail the session-end ack — surface it, do not throw.
				const reason = err instanceof Error ? err.message : String(err);
				logger?.event("summary.final_trigger.enqueue_failed", { sessionId, reason });
			}
		}

		return c.json({ ok: true }, 200);
	};
}
