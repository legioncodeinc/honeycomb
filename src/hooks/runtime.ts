/**
 * The shared per-harness hook RUNTIME — PRD-021c Wave 2 (c-AC-4 / c-AC-5 / c-AC-6 / FR-4 / FR-8).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * Every `harnesses/<h>/src/index.ts` binary is the SAME pipeline:
 *
 *   native hook payload (stdin/JSON)
 *     → 019c shim `normalize`           (native event → normalized {@link HookInput})
 *     → 019b core                       (`runSessionStart`/`runCapture`/`runPreToolUse`/`runSessionEnd`)
 *     → production {@link DaemonHookClient}  (loopback POST to `/api/hooks/*`)
 *
 * c-AC-6 demands the SECOND harness REUSE this runtime rather than re-derive it. So
 * the runtime lives HERE, once, parameterized only by the harness's {@link HarnessShim}
 * (019c). `harnesses/claude-code/src/index.ts` (the c-AC-5 reference) and
 * `harnesses/codex/src/index.ts` (the c-AC-6 fast-follow) are each a four-line call
 * into {@link createHookRuntime} + {@link runHookEvent} with their own shim — proving
 * the runtime is shared, not re-derived.
 *
 * ── THE THREE PRODUCTION SEAMS (c-AC-1 / c-AC-2 / c-AC-3) ────────────────────
 * The runtime constructs the three 019b seams whose prod impls 021c supplies:
 *   - {@link createDaemonHookClient}  — real loopback POST, runtime-path + tenancy stamp (c-AC-1).
 *   - {@link createCredentialReader}  — reads `~/.honeycomb/credentials.json` (c-AC-2).
 *   - {@link createContextRenderer}   — the real read-only rules/goals renderer (c-AC-1/4).
 * The credential reader feeds the daemon client its tenancy, so the hook speaks as
 * the SAME identity the CLI login wrote and the daemon reads.
 *
 * ── SESSION-START DRAINS NOTIFICATIONS (c-AC-4) ─────────────────────────────
 * On `session-start` the runtime renders prior context via the real renderer AND
 * drains the 020d notifications pipeline (it CALLS the existing
 * {@link createNotificationsPipeline} — it does NOT reimplement it). The drain is
 * fully fail-soft and bounded by the pipeline's own ~1.5s budget, so a hung backend
 * never blocks the session.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT. This module imports NOTHING from
 * `daemon/storage`; every outbound path is the injected seam (the daemon client, the
 * credential reader, the notifications pipeline) over loopback. No SQL, no DeepLake.
 */

import { DAEMON_HOST, DAEMON_PORT } from "../shared/constants.js";
import {
	type BackendNotificationSource,
	type ClaimLock,
	createClaimLock,
	createNotificationsPipeline,
	createNotificationsState,
	type DrainResult,
	type Notification,
	type NotificationsPipeline,
	type NotificationsState,
} from "../notifications/index.js";
import type { HarnessShim } from "./contracts.js";
import { createDaemonHookClient } from "./shared/daemon-client.js";
import { createCredentialReader } from "./shared/credential-reader.js";
import {
	createContextRenderer,
	createPrimeRenderer,
	type CredentialReader,
	type DaemonHookClient,
	type HookCoreDeps,
	type HookInput,
	type HookResult,
	type HookSessionMeta,
	type PrimeRenderer,
	runCapture,
	runPreToolUse,
	runSessionEnd,
	runSessionStart,
	type SessionStartDeps,
	type SummarySpawn,
} from "./shared/index.js";

/** The daemon `GET /api/diagnostics/notifications` route the backend source reads (020d). */
const NOTIFICATIONS_ENDPOINT = "/api/diagnostics/notifications" as const;

/** Options for {@link createHookRuntime}. All optional with production defaults. */
export interface HookRuntimeOptions {
	/** The daemon host. Defaults to the loopback constant (`127.0.0.1`). */
	readonly host?: string;
	/** The daemon port. Defaults to the loopback constant (`3850`). */
	readonly port?: number;
	/** Inject the credential reader (tests). Defaults to the real `~/.honeycomb` reader. */
	readonly credentials?: CredentialReader;
	/** Inject the daemon client (tests). Defaults to the real loopback POST client. */
	readonly daemon?: DaemonHookClient;
	/**
	 * Inject the session-start memory prime (tests / PRD-046d). Defaults to the REAL
	 * loopback `GET /api/memories/prime` renderer (d-AC-1..5), fed tenancy by the same
	 * credential reader. The runtime CALLS it on session-start; it never reimplements the
	 * 046c digest. Fail-soft by construction — a down/cold daemon contributes nothing.
	 */
	readonly prime?: PrimeRenderer;
	/**
	 * Inject the notifications pipeline (tests / c-AC-4). Defaults to the REAL 020d
	 * pipeline (real state + claim lock + a fail-soft daemon-backed source). The runtime
	 * CALLS this on session-start; it never reimplements it.
	 */
	readonly notifications?: NotificationsPipeline;
	/**
	 * Inject the summary spawn for session-end (019b FR-6). Defaults to a no-op spawn —
	 * the real detached `claude -p` / `codex exec` spawn is the shim's host-CLI concern,
	 * wired by the binary when it runs for real; an unwired runtime stays inert.
	 */
	readonly summarySpawn?: SummarySpawn;
	/** Injectable `fetch` (tests). Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** The capture-gate flag channel (`HONEYCOMB_CAPTURE`). Defaults to the process env. */
	readonly captureFlag?: string;
}

/** A constructed hook runtime: the production seams + the lifecycle dispatcher. */
export interface HookRuntime {
	/** The production daemon client (the ONLY path out to the daemon). */
	readonly deps: HookCoreDeps;
	/** The notifications pipeline drained on session-start (c-AC-4). */
	readonly notifications: NotificationsPipeline;
	/**
	 * Drive ONE native hook event end-to-end for a harness (c-AC-5 / c-AC-6): normalize
	 * through the shim, route to the matching 019b core, POST through the daemon client,
	 * and (on session-start) drain notifications. Returns the {@link HookEventOutcome}.
	 * Fail-soft: a malformed/non-lifecycle event returns `{ ok: true }` and never throws.
	 */
	runEvent(shim: HarnessShim, event: NativeHookEvent, meta: HookSessionMeta): Promise<HookEventOutcome>;
}

/** A native hook event the binary parsed off stdin (name + raw payload). */
export interface NativeHookEvent {
	/** The harness's native event name (e.g. `SessionStart`, `UserPromptSubmit`). */
	readonly name: string;
	/** The raw native payload (the shim is the only thing that knows its shape). */
	readonly payload: unknown;
}

/** The outcome of driving one hook event through the runtime. */
export interface HookEventOutcome {
	/** The core {@link HookResult} (carries `additionalContext` on session-start). */
	readonly result: HookResult;
	/** The notifications drain outcome (session-start only; the primary banner + suppressed). */
	readonly drain?: DrainResult;
	/** True when the event was a non-lifecycle event the shim dropped (no daemon call made). */
	readonly dropped?: boolean;
}

/**
 * Build the shared hook runtime (c-AC-5 / c-AC-6). Constructs the three production
 * 019b seams (daemon client, credential reader, context renderer) once, plus the
 * notifications pipeline drained on session-start (c-AC-4). Every harness binary
 * calls THIS — the second harness reuses it verbatim rather than re-deriving it.
 */
export function createHookRuntime(options: HookRuntimeOptions = {}): HookRuntime {
	const host = options.host ?? DAEMON_HOST;
	const port = options.port ?? DAEMON_PORT;
	const doFetch = options.fetch ?? fetch;

	// c-AC-2: the credential reader (the SAME identity the CLI + daemon use).
	const credentials = options.credentials ?? createCredentialReader();
	// c-AC-1: the production loopback daemon client, fed tenancy by the credential reader.
	const daemon =
		options.daemon ?? createDaemonHookClient({ credentials, host, port, fetch: doFetch });
	// c-AC-1/4: the real read-only context renderer (asks the daemon for the rules/goals block).
	const context = createContextRenderer(daemon);
	// PRD-046d (d-AC-1..5): the real session-start prime renderer — a fail-soft loopback
	// `GET /api/memories/prime`, fed tenancy by the SAME credential reader. Injected on the
	// session-start branch below; a down/cold daemon contributes nothing (d-AC-4).
	const prime = options.prime ?? createPrimeRenderer({ credentials, host, port, fetch: doFetch });

	const deps: HookCoreDeps = { daemon, credentials, context };

	// c-AC-4: the REAL 020d notifications pipeline (real state + lock + daemon-backed source).
	const notifications =
		options.notifications ?? createDefaultNotificationsPipeline(host, port, doFetch);

	const summarySpawn = options.summarySpawn ?? noopSummarySpawn;
	const captureEnv = { captureFlag: options.captureFlag ?? process.env.HONEYCOMB_CAPTURE };

	return {
		deps,
		notifications,
		async runEvent(
			shim: HarnessShim,
			event: NativeHookEvent,
			meta: HookSessionMeta,
		): Promise<HookEventOutcome> {
			// 019c shim: native event → normalized HookInput. A dropped (non-lifecycle)
			// event makes NO daemon call (fail-soft).
			const input = shim.normalize({ name: event.name, payload: event.payload }, meta);
			if (input === undefined) {
				return { result: { ok: true }, dropped: true };
			}
			return dispatchLifecycle(input, deps, captureEnv, notifications, summarySpawn, prime);
		},
	};
}

/**
 * Route a normalized {@link HookInput} to its 019b core (c-AC-5). session-start also
 * drains notifications (c-AC-4); session-end spawns the detached summary; capture +
 * pre-tool-use run their cores. Every branch is fail-soft — a core that throws is
 * absorbed so a hook never breaks the turn (FR-10).
 */
async function dispatchLifecycle(
	input: HookInput,
	deps: HookCoreDeps,
	captureEnv: { captureFlag?: string },
	notifications: NotificationsPipeline,
	summarySpawn: SummarySpawn,
	prime: PrimeRenderer,
): Promise<HookEventOutcome> {
	try {
		switch (input.event) {
			case "session-start": {
				// PRD-046d (d-AC-1..5): the prime is injected ONLY on the session-start branch
				// (d-AC-3 — per-turn capture never primes). session-start appends the digest to
				// the rules/goals `additionalContext`, fully fail-soft (d-AC-4).
				const sessionDeps: SessionStartDeps = { ...deps, captureEnv, prime };
				const result = await runSessionStart(input, sessionDeps);
				// c-AC-4: drain the 020d notifications pipeline (call it; do not reimplement).
				const drain = await drainNotificationsSoft(notifications);
				return { result, drain };
			}
			case "pre-tool-use": {
				const { result } = await runPreToolUse(input, deps);
				return { result };
			}
			case "session-end": {
				const result = await runSessionEnd(input, deps, summarySpawn);
				return { result };
			}
			// user_message / tool_call / assistant_message → per-turn capture.
			default: {
				const result = await runCapture(input, deps, captureEnv);
				return { result };
			}
		}
	} catch (err) {
		// A core throw never breaks the turn — surface it fail-soft (FR-10).
		return { result: { ok: false, reason: err instanceof Error ? err.message : "hook-error" } };
	}
}

/** Drain notifications fail-soft — a drain failure never breaks session-start (c-AC-4 / FR-10). */
async function drainNotificationsSoft(pipeline: NotificationsPipeline): Promise<DrainResult> {
	try {
		return await pipeline.drain("session_start");
	} catch {
		return { banner: null, suppressed: [] };
	}
}

/**
 * Build the default 020d notifications pipeline (c-AC-4). Uses the REAL state + claim
 * lock (filesystem under `~/.honeycomb`) and a fail-soft backend source that reads the
 * org's pending notifications from the daemon's `GET /api/diagnostics/notifications`
 * over loopback. This CALLS the existing pipeline factory — it does not reimplement
 * the drain logic.
 */
function createDefaultNotificationsPipeline(
	host: string,
	port: number,
	doFetch: typeof fetch,
): NotificationsPipeline {
	const state: NotificationsState = createNotificationsState();
	const lock: ClaimLock = createClaimLock();
	const backend = createDaemonBackendSource(host, port, doFetch);
	return createNotificationsPipeline({ state, lock, backend });
}

/**
 * A {@link BackendNotificationSource} that reads the org's pending notifications from
 * the daemon over loopback (FR-3 — through the daemon, never DeepLake). Fail-soft: any
 * error / non-200 / malformed body yields `[]`, so the pipeline's bounded drain treats
 * an unreachable daemon as "no backend notifications" and never blocks the session.
 */
function createDaemonBackendSource(
	host: string,
	port: number,
	doFetch: typeof fetch,
): BackendNotificationSource {
	const url = `http://${host}:${port}${NOTIFICATIONS_ENDPOINT}`;
	return {
		async fetch(): Promise<readonly Notification[]> {
			try {
				const res = await doFetch(url, { method: "GET" });
				if (res.status !== 200) return [];
				const body = (await res.json()) as unknown;
				return coerceNotifications(body);
			} catch {
				return [];
			}
		},
	};
}

/** Coerce a daemon notifications response body to a {@link Notification} array (unknown → []). */
function coerceNotifications(body: unknown): readonly Notification[] {
	const list = Array.isArray(body)
		? body
		: body !== null && typeof body === "object" && Array.isArray((body as Record<string, unknown>).notifications)
			? ((body as Record<string, unknown>).notifications as unknown[])
			: [];
	return list.filter(isNotification);
}

/** True when a value is a well-formed {@link Notification} (the daemon's wire shape). */
function isNotification(value: unknown): value is Notification {
	if (value === null || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.id === "string" &&
		(r.kind === "persistent" || r.kind === "transient") &&
		typeof r.text === "string" &&
		typeof r.priority === "number"
	);
}

/** The inert default summary spawn (the real detached spawn is the binary's host-CLI concern). */
const noopSummarySpawn: SummarySpawn = {
	async spawn(): Promise<void> {},
};
