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
 * ── THE PRE-TOOL-USE VFS SEAM (PRD-075a a-AC-1) ─────────────────────────────
 * The runtime constructs the REAL daemon-backed {@link VfsIntercept}
 * ({@link createDaemonVfsIntercept}) resolving through the already-mounted
 * `/memory/{cat,grep,ls,find}` browse routes over loopback, fed tenancy by the SAME
 * credential reader the daemon client uses. Every pre-tool-use dispatch rebinds a
 * fresh instance to that event's own session + runtime path before calling
 * {@link runPreToolUse} — a `createFakeVfsIntercept()` NEVER reaches production deps.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT. This module imports NOTHING from
 * `daemon/storage`; every outbound path is the injected seam (the daemon client, the
 * credential reader, the notifications pipeline, the VFS intercept) over loopback.
 * No SQL, no DeepLake.
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
import {
	ACTOR_HEADER,
	createDaemonHookClient,
	ORG_HEADER,
	RUNTIME_PATH_HEADER,
	SESSION_HEADER,
	WORKSPACE_HEADER,
} from "./shared/daemon-client.js";
import { createCredentialReader } from "./shared/credential-reader.js";
import { createSessionStartSeams } from "./shared/session-start-seams.js";
import {
	createContextRenderer,
	createFileRecallSessionStore,
	createSessionBindNoticeGate,
	createPrimeRenderer,
	createRecallRenderer,
	type CredentialReader,
	type DaemonHookClient,
	type HookCoreDeps,
	type HookCredential,
	type HookInput,
	type HookResult,
	type HookSessionMeta,
	type OnboardingNoticeGate,
	type PreToolDecision,
	type PrimeRenderer,
	type RecallRenderer,
	type RecallSessionStore,
	runCapture,
	runPreToolUse,
	runSessionEnd,
	runSessionStart,
	runUserPromptRecall,
	type RuntimePath,
	type SessionStartDeps,
	type SessionStartSeams,
	type SummarySpawn,
	type VfsIntercept,
	type VfsToolOp,
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
	 * Inject the per-turn recall renderer (tests / PRD-076a). Defaults to the REAL loopback
	 * `POST /api/memories/recall` renderer (a-AC-1..3), tightly time-bounded + fail-soft. The
	 * runtime CALLS it on the `user_prompt_recall` injector branch ONLY; a down/cold daemon
	 * contributes nothing (a-AC-3). ABSENT → the real renderer.
	 */
	readonly recall?: RecallRenderer;
	/**
	 * Inject the per-turn recall throttle/dedupe state store (tests / PRD-076a a-AC-6/7).
	 * Defaults to the REAL file-backed store under `~/.honeycomb/recall-sessions`. A test
	 * injects an in-memory store shared across the two turns it drives (a-AC-6).
	 */
	readonly recallStore?: RecallSessionStore;
	/**
	 * Inject the notifications pipeline (tests / c-AC-4). Defaults to the REAL 020d
	 * pipeline (real state + claim lock + a fail-soft daemon-backed source). The runtime
	 * CALLS this on session-start; it never reimplements it.
	 */
	readonly notifications?: NotificationsPipeline;
	/**
	 * Inject the session-start step seams (tests / PRD-045g g-AC-2). Defaults to the REAL seams
	 * whose `autoPullSkills` POSTs the daemon's `POST /api/skills/pull` over loopback (idempotent,
	 * fail-soft, time-budgeted), fed tenancy by the same credential reader. The runtime injects
	 * this on the session-start branch so freshly-mined team skills are pulled at session start;
	 * the other steps (heal/update/ensure/placeholder/graph-pull) stay no-op (out of 045g scope).
	 */
	readonly seams?: SessionStartSeams;
	/**
	 * Inject the first-run onboarding-notice gate (tests / PRD-059a / IRD-123). Defaults to the REAL
	 * gate reading `~/.deeplake/projects.json` ({@link createOnboardingNoticeGate}). When the active
	 * workspace has bound no project, session-start prepends the one-per-session "bind a project to
	 * start" notice. Fail-soft, NO DeepLake call. A test injects a fixed gate to drive the notice.
	 */
	readonly onboardingNotice?: OnboardingNoticeGate;
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
	/**
	 * Inject the pre-tool-use VFS intercept (tests / PRD-075a a-AC-1). Defaults to the
	 * REAL daemon-backed intercept ({@link createDaemonVfsIntercept}), resolving through
	 * the already-mounted `/memory/{cat,grep,ls,find}` browse routes over loopback, fed
	 * tenancy by the SAME credential reader the daemon client uses. `runEvent` rebinds a
	 * FRESH default instance to each pre-tool-use event's own session + runtime path
	 * before dispatch; an injected override here is used AS-IS and is NEVER rebound, so a
	 * test double stays a stable, inspectable seam across every event (a-AC-2..a-AC-5).
	 */
	readonly vfs?: VfsIntercept;
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
	/**
	 * The pre-tool-use {@link PreToolDecision} (PRD-075a a-AC-3), present ONLY when this
	 * outcome came from a `pre-tool-use` dispatch. Absent on every other branch
	 * (session-start / session-end / capture) — they never set it (a-AC-6). The shim
	 * renderer (075b) consumes this to map the decision onto the harness's native
	 * pre-tool response format; an absent/`allow` decision is untouched pass-through.
	 */
	readonly decision?: PreToolDecision;
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
	const daemon = options.daemon ?? createDaemonHookClient({ credentials, host, port, fetch: doFetch });
	// c-AC-1/4: the real read-only context renderer (asks the daemon for the rules/goals block).
	const context = createContextRenderer(daemon);
	// PRD-046d (d-AC-1..5): the real session-start prime renderer — a fail-soft loopback
	// `GET /api/memories/prime`, fed tenancy by the SAME credential reader. Injected on the
	// session-start branch below; a down/cold daemon contributes nothing (d-AC-4).
	const prime = options.prime ?? createPrimeRenderer({ credentials, host, port, fetch: doFetch });
	// PRD-076a (a-AC-1..3): the real per-turn recall renderer - a fail-soft, tightly-bounded
	// loopback `POST /api/memories/recall`. Injected on the `user_prompt_recall` branch below;
	// a down/cold daemon contributes nothing (a-AC-3). The recall STATE store persists the
	// throttle/dedupe snapshot across the per-turn processes (a-AC-6).
	const recall = options.recall ?? createRecallRenderer({ host, port, fetch: doFetch });
	const recallStore = options.recallStore ?? createFileRecallSessionStore();

	// PRD-075a (a-AC-1): the pre-tool-use VFS intercept. `vfsOverride` (a test double) is
	// used AS-IS and NEVER rebound; the real default is rebound to each pre-tool-use
	// event's own session + runtime path in `runEvent` below (the `/memory` route group
	// is session-scoped — see `createDaemonVfsIntercept`'s docstring). This base instance
	// (bound to the `UNBOUND_VFS_SESSION` sentinel) exists so `HookRuntime.deps.vfs` is
	// provably the REAL seam, not `createFakeVfsIntercept()`, even before the first event.
	const vfsOverride = options.vfs;
	const vfs =
		vfsOverride ??
		createDaemonVfsIntercept({
			credentials,
			host,
			port,
			fetch: doFetch,
			sessionId: UNBOUND_VFS_SESSION,
			runtimePath: DEFAULT_VFS_RUNTIME_PATH,
		});

	const deps: HookCoreDeps = { daemon, credentials, context, vfs };

	// c-AC-4: the REAL 020d notifications pipeline (real state + lock + daemon-backed source).
	const notifications = options.notifications ?? createDefaultNotificationsPipeline(host, port, doFetch);

	const summarySpawn = options.summarySpawn ?? noopSummarySpawn;
	const captureEnv = { captureFlag: options.captureFlag ?? process.env.HONEYCOMB_CAPTURE };

	// PRD-045g (g-AC-2): the REAL session-start step seams. `autoPullSkills` POSTs the daemon's
	// `POST /api/skills/pull` over loopback (idempotent + fail-soft + time-budgeted), fed tenancy
	// by the SAME credential reader the daemon client uses. Before this fix the runtime built
	// `SessionStartDeps` with NO `seams`, so auto-pull resolved to the no-op default and team
	// skills never reached a teammate's session. Injected ONLY on the session-start branch below.
	const seams = options.seams ?? createSessionStartSeams({ credentials, host, port, fetch: doFetch });

	// PRD-059a / IRD-123 (a-AC-2): the REAL first-run onboarding-notice gate — a pure local read of
	// `~/.deeplake/projects.json`. When the active workspace has bound no project yet, session-start
	// prepends the one-per-session "bind a project to start" notice. Fail-soft (no DeepLake call).
	const onboardingNotice = options.onboardingNotice ?? createSessionBindNoticeGate();

	return {
		deps,
		notifications,
		async runEvent(shim: HarnessShim, event: NativeHookEvent, meta: HookSessionMeta): Promise<HookEventOutcome> {
			// 019c shim: native event → normalized HookInput. A dropped (non-lifecycle)
			// event makes NO daemon call (fail-soft).
			const input = shim.normalize({ name: event.name, payload: event.payload }, meta);
			if (input === undefined) {
				return { result: { ok: true }, dropped: true };
			}
			// PRD-075a (a-AC-1 / a-AC-2): rebind the REAL vfs to THIS event's own session +
			// runtime path before dispatch — the daemon's `/memory` route group is
			// session-scoped (runtime-path negotiation), so a single construction-time
			// instance cannot carry the right headers for every future event. A test
			// override (`vfsOverride`) is a stable double and is NEVER rebound.
			const eventDeps: HookCoreDeps =
				input.event === "pre-tool-use" && vfsOverride === undefined
					? {
							...deps,
							vfs: createDaemonVfsIntercept({
								credentials,
								host,
								port,
								fetch: doFetch,
								sessionId: input.meta.sessionId,
								runtimePath: input.runtimePath,
							}),
						}
					: deps;
			return dispatchLifecycle(
				input,
				eventDeps,
				captureEnv,
				notifications,
				summarySpawn,
				prime,
				seams,
				onboardingNotice,
				// Thread the shim's optional off-process hygiene spawn through to session-start.
				shim.spawnHygieneChild !== undefined ? shim.spawnHygieneChild.bind(shim) : undefined,
				recall,
				recallStore,
			);
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
	seams: SessionStartSeams,
	onboardingNotice: OnboardingNoticeGate,
	spawnHygieneChild: ((meta: HookSessionMeta) => void) | undefined,
	recall: RecallRenderer,
	recallStore: RecallSessionStore,
): Promise<HookEventOutcome> {
	try {
		switch (input.event) {
			case "session-start": {
				// PRD-046d (d-AC-1..5): the prime is injected ONLY on the session-start branch
				// (d-AC-3 — per-turn capture never primes). session-start appends the digest to
				// the rules/goals `additionalContext`, fully fail-soft (d-AC-4).
				// PRD-045g (g-AC-2): the REAL step seams are injected here so `autoPullSkills`
				// runs a real (idempotent, fail-soft, time-budgeted) loopback pull instead of the
				// no-op default — freshly-mined team skills reach this session at its start.
				const sessionDeps: SessionStartDeps = {
					...deps,
					captureEnv,
					prime,
					seams,
					onboardingNotice,
					// Thread the shim's optional off-process hygiene spawn: when the harness
					// implements `spawnHygieneChild`, session-start calls it instead of the three
					// in-process hygiene seams (the parent stays free of hygiene I/O).
					...(spawnHygieneChild !== undefined ? { spawnHygieneChild } : {}),
				};
				const result = await runSessionStart(input, sessionDeps);
				// c-AC-4: drain the 020d notifications pipeline (call it; do not reimplement).
				const drain = await drainNotificationsSoft(notifications);
				return { result, drain };
			}
			case "pre-tool-use": {
				// PRD-075a (a-AC-3): the decision now rides the outcome alongside the result,
				// so the shim renderer (075b) can map it onto the harness's native response.
				const { result, decision } = await runPreToolUse(input, deps);
				return { result, decision };
			}
			case "session-end": {
				const result = await runSessionEnd(input, deps, summarySpawn);
				return { result };
			}
			case "user_prompt_recall": {
				// PRD-076a (a-AC-4): the synchronous per-turn recall injector. Calls the recall
				// renderer + returns `{ ok, additionalContext }`; `emitResponse` renders it to stdout
				// (unchanged). The async capture entry keeps its own `user_message → runCapture` path.
				const result = await runUserPromptRecall(input, deps, recall, recallStore);
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
function createDefaultNotificationsPipeline(host: string, port: number, doFetch: typeof fetch): NotificationsPipeline {
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
function createDaemonBackendSource(host: string, port: number, doFetch: typeof fetch): BackendNotificationSource {
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

// ─────────────────────────────────────────────────────────────────────────────
// The pre-tool-use VFS intercept — PRD-075a (a-AC-1 / a-AC-2). The runtime's real
// dependency-construction site for the `vfs` seam threaded through `HookCoreDeps`.
// ─────────────────────────────────────────────────────────────────────────────

/** The daemon's already-mounted VFS browse route group (`src/daemon/runtime/vfs/api.ts`, PRD-022b). */
const VFS_GROUP_PATH = "/memory" as const;

/**
 * Bounds a single VFS resolve so a hung/slow daemon degrades to pass-through quickly
 * rather than riding the harness's own (much longer) pre-tool hook timeout — the PRD's
 * "target ~2s" open question. TIMEOUT-PLACEMENT DECISION: bounded HERE, at the
 * transport call inside {@link createDaemonVfsIntercept}, via `AbortController` — NOT
 * inside the stable {@link VfsIntercept} contract (`resolve(op): Promise<string>` has
 * no budget parameter and is shared by isolated unit tests that must stay
 * synchronous-fast). Keeping the bound at this one construction site means every
 * hook-runtime caller shares the same policy without threading a timeout through the
 * seam's public shape.
 */
const VFS_RESOLVE_TIMEOUT_MS = 2_000;

/**
 * The `x-honeycomb-session` value the runtime's BASE `deps.vfs` (built once, before any
 * event is known — see {@link createHookRuntime}) is stamped with. A real `/memory` call
 * against the base instance alone would 400 (the daemon requires a claimed session); that
 * is expected — every pre-tool-use dispatch rebinds a fresh instance to the ACTUAL event
 * session before resolving (`runEvent`), so the base instance exists ONLY so
 * `HookRuntime.deps.vfs` is provably the real seam (a-AC-1), never a live call target.
 */
const UNBOUND_VFS_SESSION = "unbound" as const;

/** The `x-honeycomb-runtime-path` the base `deps.vfs` is stamped with (see {@link UNBOUND_VFS_SESSION}). */
const DEFAULT_VFS_RUNTIME_PATH: RuntimePath = "plugin";

/** Options for {@link createDaemonVfsIntercept}. */
interface DaemonVfsInterceptOptions {
	/** The credential reader the tenancy headers resolve through (mirrors `createDaemonHookClient`). */
	readonly credentials: CredentialReader;
	/** The daemon host. */
	readonly host: string;
	/** The daemon port. */
	readonly port: number;
	/** The `fetch` implementation (real global `fetch` in production; injectable for tests). */
	readonly fetch: typeof fetch;
	/** The `x-honeycomb-session` this instance stamps on every resolve. */
	readonly sessionId: string;
	/** The `x-honeycomb-runtime-path` this instance stamps on every resolve. */
	readonly runtimePath: RuntimePath;
}

/**
 * Build the production {@link VfsIntercept} (a-AC-1 / a-AC-2). Resolves a lowered
 * {@link VfsToolOp} against the REAL daemon-mounted VFS browse routes — `GET
 * /memory/{cat,grep,ls,find}` (`src/daemon/runtime/vfs/api.ts`, PRD-022b) — over real
 * loopback HTTP, fed tenancy by the SAME credential reader {@link createDaemonHookClient}
 * uses (mirrors that seam's own construction: host/port/fetch — the PRD's open question
 * on where the seam is built).
 *
 * CROSS-BOUNDARY NOTE (architecture decision, see the sub-PRD's final report): the PRD's
 * fact table names `DeepLakeFs` (`src/daemon-client/vfs/fs.ts`) as "the real intercept
 * seam". Wiring that class for real needs a `DaemonDispatch` that POSTs raw escaped SQL
 * to the daemon — no such endpoint is mounted anywhere in this codebase today (its own
 * CONVENTIONS.md lists "the real `DaemonDispatch`" as a still-deferred assembly step), and
 * mounting one would be an `src/daemon` change outside this sub-PRD's file ownership. The
 * `/memory/*` browse routes below ARE already mounted, already daemon-backed, and (per
 * `src/daemon/runtime/vfs/CONVENTIONS.md`) are explicitly documented as "the surface the
 * PRD-015 `DeepLakeFs` client... dispatch to" — hitting them directly resolves the SAME
 * `memory`-table content `DeepLakeFs`'s read tiers would, without a second storage-access
 * path. `write` is never reached here — `pre-tool-use.ts` denies it before calling the
 * seam.
 *
 * Bounded by {@link VFS_RESOLVE_TIMEOUT_MS} via `AbortController`; a timeout or transport
 * failure REJECTS `resolve()` (this function does not itself catch), which the caller
 * (`dispatchLifecycle`'s existing `try`/`catch`) absorbs fail-soft (a-AC-5).
 */
function createDaemonVfsIntercept(options: DaemonVfsInterceptOptions): VfsIntercept {
	const base = `http://${options.host}:${options.port}${VFS_GROUP_PATH}`;
	return {
		async resolve(op: VfsToolOp): Promise<string> {
			const headers = await vfsRequestHeaders(options.credentials, options.sessionId, options.runtimePath);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), VFS_RESOLVE_TIMEOUT_MS);
			try {
				const res = await options.fetch(vfsRequestUrl(base, op), { method: "GET", headers, signal: controller.signal });
				if (res.status !== 200) return "";
				return renderVfsBody(op.verb, (await res.json()) as unknown);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/**
 * Resolve the `/memory` request headers (session/runtime-path + tenancy). Mirrors
 * `createDaemonHookClient`'s tenancy resolution: a credential-read failure resolves to
 * an unscoped call (the daemon fail-closes an org-less request), never a throw.
 */
async function vfsRequestHeaders(
	credentials: CredentialReader,
	sessionId: string,
	runtimePath: RuntimePath,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		[RUNTIME_PATH_HEADER]: runtimePath,
		[SESSION_HEADER]: sessionId,
	};
	let cred: HookCredential | undefined;
	try {
		cred = await credentials.read();
	} catch {
		cred = undefined;
	}
	if (cred?.org !== undefined) headers[ORG_HEADER] = cred.org;
	if (cred?.workspace !== undefined) headers[WORKSPACE_HEADER] = cred.workspace;
	if (cred?.actor !== undefined) headers[ACTOR_HEADER] = cred.actor;
	return headers;
}

/** Build the `/memory/<route>` URL + query for a lowered {@link VfsToolOp} (verb → route). */
function vfsRequestUrl(base: string, op: VfsToolOp): string {
	switch (op.verb) {
		case "read":
			return `${base}/cat?path=${encodeURIComponent(op.path)}`;
		case "search":
			return `${base}/grep?q=${encodeURIComponent(op.query ?? op.path)}`;
		case "list":
			return `${base}/ls?prefix=${encodeURIComponent(op.path)}`;
		case "find":
			return `${base}/find?pattern=${encodeURIComponent(op.query ?? op.path)}`;
		case "write":
			// Never reached: `pre-tool-use.ts` denies `write` before calling the intercept.
			return `${base}/cat?path=${encodeURIComponent(op.path)}`;
		default: {
			const exhaustive: never = op.verb;
			throw new Error(`vfs: unmodeled op verb reached the intercept: ${String(exhaustive)}`);
		}
	}
}

/**
 * Render a `/memory/*` JSON response body to the plain-text `resolve()` output
 * `runPreToolUse` folds into a `replace` decision. Every field is shape-guarded so a
 * malformed/unexpected daemon body degrades to `""` rather than throwing (fail-soft).
 */
function renderVfsBody(verb: VfsToolOp["verb"], body: unknown): string {
	const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
	switch (verb) {
		case "read":
			return typeof rec.content === "string" ? rec.content : "";
		case "search":
			return renderGrepHits(rec.hits);
		case "list":
			return renderLsEntries(rec.entries);
		case "find":
			return renderFindMatches(rec.matches);
		case "write":
			return "";
		default: {
			const exhaustive: never = verb;
			throw new Error(`vfs: unmodeled op verb reached the intercept: ${String(exhaustive)}`);
		}
	}
}

/** Render a `grep` response's `hits` array (`{ content }[]`) to newline-joined content. */
function renderGrepHits(hits: unknown): string {
	if (!Array.isArray(hits)) return "";
	return hits
		.map((hit) =>
			hit !== null && typeof hit === "object" && typeof (hit as { content?: unknown }).content === "string"
				? (hit as { content: string }).content
				: "",
		)
		.filter((content) => content.length > 0)
		.join("\n\n");
}

/** Render an `ls` response's `entries` array (`{ path }[]`) to newline-joined paths. */
function renderLsEntries(entries: unknown): string {
	if (!Array.isArray(entries)) return "";
	return entries
		.map((entry) =>
			entry !== null && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
				? (entry as { path: string }).path
				: "",
		)
		.filter((path) => path.length > 0)
		.join("\n");
}

/** Render a `find` response's `matches` array (`{ path, summary }[]`) to `path: summary` lines. */
function renderFindMatches(matches: unknown): string {
	if (!Array.isArray(matches)) return "";
	return matches
		.map((match) => {
			if (match === null || typeof match !== "object") return "";
			const rec = match as { path?: unknown; summary?: unknown };
			const path = typeof rec.path === "string" ? rec.path : "";
			const summary = typeof rec.summary === "string" ? rec.summary : "";
			return path.length > 0 ? `${path}: ${summary}` : "";
		})
		.filter((line) => line.length > 0)
		.join("\n");
}
