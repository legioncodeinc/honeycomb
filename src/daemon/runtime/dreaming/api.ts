/**
 * The "Dream now" HTTP trigger seam — PRD-024 Wave 1 (AC-6 backend half).
 *
 * The brand dashboard's "Dream now" button (Wave 2) needs a REAL daemon endpoint that
 * kicks the PRD-009 Dreaming consolidation loop. This module is the single named step the
 * daemon assembly calls AFTER `createDaemon(...)` to attach `POST /api/diagnostics/dream`
 * onto the ALREADY-MOUNTED, protected `/api/diagnostics` group — mirroring
 * `mountDashboardApi` (020b) and `mountLogsApi` (021d). ZERO edits to `server.ts`: the
 * `/api/diagnostics` group is scaffolded + `protect:true`, so attaching via
 * `daemon.group("/api/diagnostics")` inherits the same auth/RBAC the JSON dashboard views
 * enforce (in `local` mode that middleware is open by design — D-4).
 *
 * ── It is the HTTP TRIGGER, never new dreaming logic (D-3) ────────────────────
 *   The handler reuses the PRD-009a {@link DreamingTrigger} seam: it calls
 *   `checkAndEnqueueDreaming`, which (per the dreaming config + the single-pending guard)
 *   ENQUEUES exactly one `dreaming` job into the durable `memory_jobs` queue and returns
 *   promptly. The job's actual consolidation pass (the model call) is run later by the
 *   queue worker via the PRD-009b/009c runner — NOT here. So the endpoint is NON-BLOCKING
 *   by construction: it never awaits the loop finishing, only the cheap enqueue round trip.
 *   The trigger is injected the daemon's OWN already-constructed job queue
 *   (`daemon.services.queue`) as its enqueuer — there is no second dreaming subsystem.
 *
 * ── The ack shape (the contract Wave 2's button calls) ───────────────────────
 *   On success the handler returns HTTP 202 with a small JSON ack:
 *     `{ triggered: true,  status: "enqueued" }`            — a pass was queued.
 *     `{ triggered: true,  status: "running",  reason }`    — a pass is already in flight
 *                                                              (the single-pending guard) or
 *                                                              below the token threshold; the
 *                                                              loop is healthy, nothing new
 *                                                              was queued.
 *     `{ triggered: false, status: "skipped",  reason }`    — dreaming is DISABLED in config,
 *                                                              or the dreaming subsystem is not
 *                                                              available (no queue wired). A
 *                                                              clean ack, NEVER a 500.
 *   The ack carries NO token, secret, or header value (D-4) — only the decision + a short
 *   machine reason string from the trigger.
 *
 * ── Authz + local posture (D-4) ──────────────────────────────────────────────
 *   The endpoint rides the protected `/api/diagnostics` group, so it inherits the same
 *   auth/RBAC as the dashboard's JSON views — open in `local` mode (the single-user
 *   loopback dogfood target the dashboard host serves), gated in team/hybrid. It is not a
 *   team-mode escalation: it triggers the daemon's OWN dreaming loop for the daemon's OWN
 *   tenancy partition, exactly the surface the local dashboard already reads. The handler
 *   takes NO attacker-controlled SQL/identifier — the trigger keys the counter by the
 *   default agent scope and builds every statement through the guarded `sql.ts` helpers.
 *
 * ── Fail-soft, never 500 (D-4) ───────────────────────────────────────────────
 *   If the dreaming subsystem is unavailable (the queue is the no-op stub, so an enqueue
 *   would be a black hole) the handler returns a clean `{ triggered: false, status:
 *   "skipped", reason: "unavailable" }` rather than a 500. A request with no resolvable
 *   tenancy fails closed at the edge (400), consistent with the other diagnostics handlers.
 *
 * ── Deferred assembly (mirrors the sibling seams) ────────────────────────────
 *   The production daemon assembly (`assemble.ts`) calls `mountDreamApi(daemon, { storage,
 *   defaultScope })` ONCE. It is constructed-and-tested here against a fake dreaming
 *   trigger seam (`tests/daemon/runtime/dreaming/api.test.ts` drives `app.request(...)`);
 *   importing the daemon does not auto-invoke it.
 */

import type { Context } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import { resolveDreamingConfig } from "./config.js";
import {
	createDreamingTrigger,
	type DreamingJobEnqueuer,
	type DreamingScope,
	type DreamingTickResult,
} from "./trigger.js";

/** The route the "Dream now" trigger is served at (full path `/api/diagnostics/dream`). */
export const DREAM_TRIGGER_PATH = "/dream" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const DREAM_TRIGGER_GROUP = "/api/diagnostics" as const;

/** The default agent the dashboard-button trigger keys the dreaming counter by (009a D-1). */
export const DREAM_DEFAULT_AGENT_ID = "default" as const;

/**
 * The minimal trigger seam the handler calls — exactly the 009a
 * {@link DreamingTrigger.checkAndEnqueueDreaming} signature. Keeping it as a one-method
 * interface lets the production path inject the REAL trigger and a unit test inject a fake
 * that records the call, without the handler holding any dreaming lifecycle knowledge.
 */
export interface DreamTriggerSeam {
	/** Evaluate the scope's counter + guard and enqueue at most one dreaming pass. */
	checkAndEnqueueDreaming(scope: DreamingScope): Promise<DreamingTickResult>;
}

/** Options for {@link mountDreamApi}. */
export interface MountDreamOptions {
	/**
	 * The live storage client the dreaming trigger reads/writes the `dreaming_state` counter
	 * through (never a raw fetch). The trigger builds every statement with the guarded
	 * `sql.ts` helpers.
	 */
	readonly storage: StorageQuery;
	/**
	 * The daemon's own tenancy partition the dreaming counter rows live under (the same
	 * `defaultScope` the composition root threads into the data-API mounts). In `local` mode
	 * this is the single loopback tenant; the dreaming loop runs for it.
	 */
	readonly defaultScope: QueryScope;
	/**
	 * The job enqueuer the trigger uses to queue a dreaming pass. Defaults to the daemon's
	 * OWN durable job queue (`daemon.services.queue`) so there is no second dreaming
	 * subsystem. When the queue is the no-op stub (dreaming subsystem unavailable) the
	 * handler returns a clean `{ triggered: false }` ack rather than enqueuing into a black
	 * hole — see {@link isQueueAvailable}.
	 */
	readonly enqueuer?: DreamingJobEnqueuer;
	/**
	 * An explicit trigger seam override (tests inject a recording fake). Production leaves it
	 * unset; the handler then constructs the REAL {@link DreamingTrigger} from `storage` +
	 * `defaultScope` + the resolved dreaming config + the `enqueuer`.
	 */
	readonly trigger?: DreamTriggerSeam;
	/**
	 * Whether the dreaming subsystem is available (a real durable queue is wired). When false,
	 * the handler short-circuits to `{ triggered: false, status: "skipped", reason:
	 * "unavailable" }` — a clean ack, never a 500. Defaults to true when an `enqueuer` is
	 * supplied (the composition root only supplies the real queue), false otherwise.
	 */
	readonly available?: boolean;
}

/** The ack body the trigger returns (the exact contract Wave 2's button reads). */
export interface DreamAck {
	/** True when the trigger ran (enqueued OR found the loop already busy/below-threshold). */
	readonly triggered: boolean;
	/** The coarse status: a pass was queued, one is already running, or the trigger was skipped. */
	readonly status: "enqueued" | "running" | "skipped";
	/** A short machine reason (present for `running`/`skipped`); carries no token/secret. */
	readonly reason?: string;
}

/** The 400 body for a request with no resolvable tenancy (fail-closed at the edge). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/**
 * Resolve the per-request tenancy scope, falling back to the daemon's `defaultScope` when
 * the request carries no `x-honeycomb-org` header (the PRD-022 local-mode posture: a
 * loopback dashboard button need not stamp the org). Returns `null` ONLY when neither a
 * header org NOR a default org is present (a malformed default) — fail-closed.
 */
function resolveTriggerScope(c: Context, defaultScope: QueryScope): QueryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org !== undefined && org.length > 0) {
		const workspace = c.req.header("x-honeycomb-workspace");
		return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
	}
	// No header org → the local-mode default tenant (the single loopback tenant the dashboard
	// host serves). Fail closed if even the default has no org (a malformed assembly).
	return defaultScope.org.length > 0 ? defaultScope : null;
}

/**
 * Map a 009a {@link DreamingTickResult} onto the dashboard ack (D-3). `enqueued` → a pass
 * was queued. `skipped` (already pending) and `below_threshold` → the loop is healthy but
 * nothing new was queued, surfaced as `running`. `disabled` → the dreaming master switch is
 * off; surfaced as `skipped` so the UI can say so. The `reason` is the trigger's own short
 * machine string — never a token or secret.
 */
function ackFor(result: DreamingTickResult): DreamAck {
	switch (result.decision) {
		case "enqueued":
			return { triggered: true, status: "enqueued" };
		case "disabled":
			return { triggered: false, status: "skipped", reason: result.reason };
		// `skipped` (a pass already in flight) and `below_threshold` both mean the loop is
		// alive but no NEW pass was queued — the button surfaces this as "running".
		case "skipped":
		case "below_threshold":
		default:
			return { triggered: true, status: "running", reason: result.reason };
	}
}

/**
 * Whether the supplied enqueuer is a REAL durable queue (dreaming available) vs the no-op
 * stub. The composition root only ever supplies the real `daemon.services.queue` when the
 * daemon was assembled with the live storage client; a bare `createDaemon()` leaves the
 * no-op stub, whose `enqueue` returns the synthetic `"noop-job"` id (a black hole). We treat
 * an absent enqueuer as unavailable so the handler fails soft rather than pretending.
 */
function isQueueAvailable(options: MountDreamOptions): boolean {
	if (options.available !== undefined) return options.available;
	return options.enqueuer !== undefined;
}

/**
 * Attach the "Dream now" trigger onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (AC-6 backend half). Registers `POST /api/diagnostics/dream`,
 * which resolves the request scope (header org or the daemon default — fail-closed),
 * evaluates the PRD-009a dreaming trigger, and returns the 202 ack. Call ONCE after
 * `createDaemon(...)`. If the group is not mounted (unknown daemon shape) the attach is a
 * no-op. NON-BLOCKING: the handler awaits only the cheap enqueue, never the consolidation
 * pass (which the queue worker runs later via the 009b/009c runner).
 */
export function mountDreamApi(daemon: Daemon, options: MountDreamOptions): void {
	const group = daemon.group(DREAM_TRIGGER_GROUP);
	if (group === undefined) return;

	const available = isQueueAvailable(options);
	const dreamScope: DreamingScope = { agentId: DREAM_DEFAULT_AGENT_ID };

	// Build the trigger seam ONCE at mount (not per request): the REAL 009a trigger wired to
	// the daemon's own job queue + the resolved dreaming config, OR the injected test fake.
	// When the dreaming subsystem is unavailable we build NO trigger — the handler short-
	// circuits to the clean `unavailable` ack below.
	const trigger: DreamTriggerSeam | null = options.trigger ?? (available ? buildRealTrigger(options) : null);

	group.post(DREAM_TRIGGER_PATH, async (c) => {
		const scope = resolveTriggerScope(c, options.defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		// Dreaming subsystem not available (no real queue wired) — a clean ack, never a 500.
		if (trigger === null) {
			const ack: DreamAck = { triggered: false, status: "skipped", reason: "unavailable" };
			return c.json(ack, 202);
		}

		// Kick the REAL dreaming loop: evaluate the counter + single-pending guard and enqueue
		// at most one pass. NON-BLOCKING — `checkAndEnqueueDreaming` only enqueues a job; the
		// consolidation pass (the model call) is run later by the queue worker.
		const result = await trigger.checkAndEnqueueDreaming(dreamScope);
		return c.json(ackFor(result), 202);
	});
}

/**
 * Construct the REAL PRD-009a {@link DreamingTrigger} from the mount options: the live
 * storage client, the daemon's tenancy partition, the env-resolved `memory.dreaming` config,
 * and the daemon's own job queue as the enqueuer. The trigger owns the append-only
 * `dreaming_state` counter + the single-pending guard; this only wires it.
 */
function buildRealTrigger(options: MountDreamOptions): DreamTriggerSeam {
	const config = resolveDreamingConfig();
	// `available` is true only when an enqueuer was supplied, so this non-null assertion holds
	// by construction (see isQueueAvailable). Guard anyway so a future caller can't crash here.
	const enqueuer = options.enqueuer;
	if (enqueuer === undefined) {
		// Should never happen (available ⇒ enqueuer present), but never throw past the seam.
		return {
			async checkAndEnqueueDreaming(): Promise<DreamingTickResult> {
				return { decision: "disabled", reason: "disabled", tokens: 0 };
			},
		};
	}
	return createDreamingTrigger({
		storage: options.storage,
		scope: options.defaultScope,
		config,
		enqueuer,
	});
}
