/**
 * The `/api/hooks/*` handler attach seam — PRD-019b (daemon side).
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

import { healTargetFor } from "../../storage/catalog/index.js";
import type { HealTarget } from "../../storage/heal.js";
import type { StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import type { JobQueueService } from "../services/job-queue.js";
import type { EmbedAttachment } from "../services/embed-client.js";
import {
	type CaptureHandler,
	type CaptureLogger,
	createCaptureHandler,
} from "./capture-handler.js";

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
}

/**
 * Attach the `/api/hooks/*` handlers onto the daemon's already-mounted `/api/hooks`
 * route group (the a-AC-6 / 019b attach step). Constructs the capture handler with
 * the injected storage + queue (+ the `sessions` heal target, defaulted) and calls
 * its `register(daemon)`. Returns the constructed {@link CaptureHandler} so the
 * caller can read its per-turn counters. Call ONCE after `createDaemon(...)`.
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
	return handler;
}
