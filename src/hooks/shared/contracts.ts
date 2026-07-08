/**
 * Lifecycle hook contracts + seams — PRD-019b Wave 1 (the agent-agnostic core).
 *
 * ── THE THESIS (FR-2 / FR-9 / b-AC-2 / D-2) ─────────────────────────────────
 *   HOOKS ARE THIN CLIENTS. They normalize a harness's native lifecycle event
 *   into the {@link HookInput} shape, read the device-flow credential, and make a
 *   LOCAL request to the daemon (`127.0.0.1:3850`) `/api/hooks/*`. They NEVER open
 *   DeepLake, NEVER build SQL, and hold NO daemon handle. The daemon (already built
 *   across 001–018) owns capture writes, recall, the memory pipeline, skillify, and
 *   summary generation. The hook STATES what happened; the daemon decides what to
 *   persist and return.
 *
 * ── MODULE HOME = `src/hooks/shared/` ON PURPOSE ────────────────────────────
 * `src/hooks` is added to `NON_DAEMON_ROOTS` in
 * `tests/daemon/storage/invariant.test.ts` (D-2). A stray `from ".../daemon/storage"`
 * import here FAILS the build — so the thin-client invariant is ENFORCED, not merely
 * a convention. The only path out to the daemon is the {@link DaemonHookClient} seam
 * below; in production it POSTs over loopback, in tests it is a recording fake.
 *
 * ── THE SIX LOGICAL EVENTS (FR-1) ───────────────────────────────────────────
 * Every harness shim (019c) maps its native event vocabulary onto these six logical
 * events. The contract stays functionally complete even on a harness with a partial
 * event vocabulary (FR-7 / b-AC-1) — e.g. OpenClaw batches capture at `agent_end`,
 * producing the SAME daemon-written rows, just grouped into one flush.
 *
 *   1. session-start       → recall inject + table-ensure + placeholder + context
 *   2. user_message        → prompt capture
 *   3. pre-tool-use        → VFS recall intercept (Bash/Read/Grep/Glob on the mount)
 *   4. tool_call           → post-tool capture
 *   5. assistant_message   → assistant-response capture
 *   6. session-end         → mark ended + usage + skillify + detached summary spawn
 *
 * ── WAVE 1 vs WAVE 2 ────────────────────────────────────────────────────────
 * Wave 1 (this scaffold) defines the typed contracts + seams + fakes, and stubs the
 * five core modules (`session-start.ts`, `capture.ts`, `pre-tool-use.ts`,
 * `session-end.ts`, `context-renderer.ts`) so an early call FAILS LOUD via
 * {@link notImplemented}. Wave 2 (019b) FILLS the bodies WITHOUT changing these
 * signatures. The capture-gate (`src/shared/capture-gate.ts`) is REUSED — never
 * re-implemented here.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// notImplemented — the honest-stub thrower (mirrors vfs/contracts.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single honest-stub helper every Wave-1 stub body calls so an early call
 * FAILS LOUD with a stable, greppable message. Wave 2 deletes each call as it
 * fills the body. Mirrors the `notImplemented` discipline in `vfs/contracts.ts`.
 */
export function notImplemented(what: string): never {
	throw new Error(`PRD-019b: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LogicalEvent — the normalized lifecycle events (FR-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The logical lifecycle events every shim maps its native names onto (FR-1). The
 * first six are the 019b core lifecycle; `user_prompt_recall` (PRD-076a) is the
 * per-turn query-aware recall INJECTOR — a synchronous sibling of the `user_message`
 * capture that runs `runUserPromptRecall` (recall + inject) instead of `runCapture`,
 * so the injected recall and the fire-and-forget capture coexist on `UserPromptSubmit`.
 */
export const LOGICAL_EVENTS = [
	"session-start",
	"user_message",
	"pre-tool-use",
	"tool_call",
	"assistant_message",
	"session-end",
	"user_prompt_recall",
] as const;

/** One normalized logical lifecycle event. */
export type LogicalEvent = (typeof LOGICAL_EVENTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// RuntimePath — the surface that stamps `x-honeycomb-runtime-path` (FR-8 / D-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The runtime path a hook call stamps on `x-honeycomb-runtime-path` (FR-8). A
 * runtime extension stamps `plugin`; a hook script stamps `legacy`. The daemon
 * (already built, PRD-004d) enforces one active path per session and returns 409
 * on conflict (b-AC-6). This module STAMPS the header; it never re-tests
 * enforcement (D-6).
 */
export type RuntimePath = "plugin" | "legacy";

/**
 * The env var carrying the session-metadata JSON from the hook parent to the detached
 * hygiene child (the off-process latency fix). SINGLE SOURCE OF TRUTH — both the
 * claude-code shim (`spawnHygieneChild`, which sets it before spawn) and the hygiene
 * child entrypoint (`harnesses/claude-code/src/hygiene.ts`, which reads it on boot)
 * import THIS constant, so the wire contract cannot drift between the two literals.
 */
export const HYGIENE_META_ENV = "HONEYCOMB_HYGIENE_META" as const;

// ─────────────────────────────────────────────────────────────────────────────
// HookInput — the normalized payload every shim produces (FR-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session metadata threaded onto every hook call (FR-2 / FR-4). Mirrors the
 * daemon-side `CaptureMetadata` (`src/daemon/runtime/capture/event-contract.ts`)
 * so a shim's normalized output maps onto the daemon's capture boundary 1:1. The
 * shim populates these from its native payload; the core forwards them verbatim.
 */
export interface HookSessionMeta {
	/** The harness session id (provenance + transcript-path convention). */
	readonly sessionId: string;
	/** Conversation grouping key — rows sharing a `path` are one conversation. */
	readonly path?: string;
	/** The working directory the turn ran in. */
	readonly cwd?: string;
	/** The harness permission mode for the turn. */
	readonly permissionMode?: string;
	/** The native hook event name that produced this call (provenance). */
	readonly hookEventName?: string;
	/** The agent scope for the row (engine-table `agent_id`). */
	readonly agentId?: string;
	/** The capturing agent label (e.g. `claude-code`). */
	readonly agent?: string;
}

/**
 * The normalized hook payload (FR-2). A shim lowers its harness's native event
 * into THIS shape and hands it to a core module, which reads credentials, applies
 * the capture gate, and dispatches through the {@link DaemonHookClient} seam.
 *
 * `event` is the logical event; `meta` is the session metadata; `data` is the
 * event-specific body the shim normalized (the prompt text, the tool call, the
 * assistant message, etc.) — preserved as `unknown` so the core forwards it to
 * the daemon verbatim without re-typing per harness. An optional
 * `messageEmbedding` rides along when the shim computed one (FR-4).
 */
export interface HookInput {
	/** The logical lifecycle event (FR-1). */
	readonly event: LogicalEvent;
	/** Session metadata threaded onto the daemon call (FR-2 / FR-4). */
	readonly meta: HookSessionMeta;
	/**
	 * The event-specific body the shim normalized. Forwarded to the daemon
	 * verbatim — the daemon's capture boundary (zod) validates it, not the hook.
	 */
	readonly data?: unknown;
	/** Optional per-message embedding vector the shim computed (FR-4). */
	readonly messageEmbedding?: readonly number[];
	/** The runtime path this surface stamps (FR-8 / D-6). */
	readonly runtimePath: RuntimePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// HookResult — what a core module returns to the shim (FR-3 / FR-10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result a core module hands back to the shim, which routes it through the
 * harness's native response format (019c). `additionalContext` is the rules/goals
 * context block session-start renders (FR-3 / b-AC-3); the shim decides the
 * CHANNEL (model-only vs user-visible) per its harness (019c FR-10 / c-AC-5).
 * `ok: false` carries a fail-soft reason — a hook failure NEVER breaks the turn.
 */
export interface HookResult {
	/** True when the core handled the event. */
	readonly ok: boolean;
	/** The context block to inject (session-start), if any (FR-3). */
	readonly additionalContext?: string;
	/** A machine-readable reason when `ok` is false (fail-soft diagnostics). */
	readonly reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DaemonHookClient — the ONLY path out to the daemon (FR-2 / FR-8 / D-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single call to a daemon `/api/hooks/*` endpoint (FR-2). `endpoint` is the
 * sub-path (e.g. `capture`, `session-start`); `body` is the JSON payload; the
 * client STAMPS `x-honeycomb-runtime-path` (FR-8) and the session header from the
 * supplied {@link HookSessionMeta} so the daemon scopes + enforces the runtime
 * path (b-AC-6).
 */
export interface DaemonHookRequest {
	/** The `/api/hooks/<endpoint>` sub-path. */
	readonly endpoint: string;
	/** The JSON request body (the normalized event + metadata). */
	readonly body: unknown;
	/** Session metadata → the `x-honeycomb-session` header + scope. */
	readonly meta: HookSessionMeta;
	/** The runtime path → the `x-honeycomb-runtime-path` header (FR-8). */
	readonly runtimePath: RuntimePath;
}

/** A daemon hook response: the parsed JSON body + the HTTP status (for the 409 path). */
export interface DaemonHookResponse {
	/** The HTTP status — `409` is the runtime-path conflict (b-AC-6). */
	readonly status: number;
	/** The parsed JSON body, or `undefined` for an empty body. */
	readonly body?: unknown;
}

/**
 * The daemon-call seam (FR-2 / D-2). The ONLY way a hook reaches the daemon. The
 * real impl (Wave 2 / deferred assembly) POSTs over loopback to `127.0.0.1:3850`
 * stamping the runtime-path + session + actor headers; the {@link createFakeDaemonHookClient}
 * fake records every call so a test asserts the daemon was reached ONLY through
 * this seam (and that the gate short-circuited by asserting `.calls` is empty).
 */
export interface DaemonHookClient {
	/** POST one hook event to `/api/hooks/<endpoint>`. */
	send(req: DaemonHookRequest): Promise<DaemonHookResponse>;
}

/** A recorded {@link DaemonHookClient} call (the fake's audit trail). */
export interface RecordedHookCall {
	readonly endpoint: string;
	readonly body: unknown;
	readonly meta: HookSessionMeta;
	readonly runtimePath: RuntimePath;
}

/** Options for {@link createFakeDaemonHookClient}. */
export interface FakeDaemonHookClientOptions {
	/** The status to return (default `200`). Set `409` to drive the conflict path. */
	readonly status?: number;
	/** The body to return for each call (default `undefined`). */
	readonly body?: unknown;
}

/** A {@link DaemonHookClient} fake that records every call for assertions. */
export interface FakeDaemonHookClient extends DaemonHookClient {
	/** Every call made through this fake, in order. */
	readonly calls: readonly RecordedHookCall[];
}

/**
 * Build a recording {@link DaemonHookClient} fake (the `FakeStore` discipline on
 * the thin-client side of the wire). Records each call and returns the configured
 * status/body so a Wave-2 test drives the whole core against it — no daemon, no
 * DeepLake. Drive the 409 path with `{ status: 409 }` (b-AC-6).
 */
export function createFakeDaemonHookClient(opts: FakeDaemonHookClientOptions = {}): FakeDaemonHookClient {
	const calls: RecordedHookCall[] = [];
	const status = opts.status ?? 200;
	return {
		get calls(): readonly RecordedHookCall[] {
			return calls;
		},
		async send(req: DaemonHookRequest): Promise<DaemonHookResponse> {
			calls.push({
				endpoint: req.endpoint,
				body: req.body,
				meta: req.meta,
				runtimePath: req.runtimePath,
			});
			return { status, body: opts.body };
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// CredentialReader — read `~/.honeycomb/credentials.json` (FR-2 / FR-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The device-flow credential the hooks read from `~/.honeycomb/credentials.json`
 * (FR-2). The hook reads PRESENCE + the token/org so it can stamp actor headers
 * and decide login-vs-read-only (FR-3); it NEVER logs the value (security, Wave 3).
 * Shape is intentionally minimal — the daemon owns the full auth model.
 */
export interface HookCredential {
	/** The device-flow token, if present. Never logged. */
	readonly token?: string;
	/** The resolved org, if present. */
	readonly org?: string;
	/**
	 * The resolved workspace, if present (PRD-021c additive). The transport stamps it on
	 * `x-honeycomb-workspace` + `metadata.workspace`; absent it, the `default` sentinel
	 * resolves server-side. Mirrors the daemon-side `Credentials.workspace`.
	 */
	readonly workspace?: string;
	/** The actor label (e.g. a user/agent id) for actor-header stamping. */
	readonly actor?: string;
}

/**
 * The credential-read seam (FR-2 / FR-3 / D-2). Injected so the core never reads
 * `~/.honeycomb/credentials.json` from disk directly — a test supplies a fake
 * (present / absent / malformed) and asserts the login-vs-read-only branch (FR-3)
 * without touching the real home directory.
 */
export interface CredentialReader {
	/** Read the credential. Returns `undefined` when the file is absent (read-only mode). */
	read(): Promise<HookCredential | undefined>;
}

/**
 * Build a {@link CredentialReader} fake that returns the supplied credential (or
 * `undefined` for the absent / read-only case). The default returns `undefined`
 * so a test exercises the no-credential branch without setup.
 */
export function createFakeCredentialReader(cred?: HookCredential): CredentialReader {
	return {
		async read(): Promise<HookCredential | undefined> {
			return cred;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextRenderer — the read-only rules/goals block (FR-3 / FR-10 / b-AC-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The context-render request: the scope/session the block is rendered for. The
 * renderer is READ-ONLY and ABSORBS its own errors (FR-10) — a render failure
 * returns an empty block, never a throw, so session-start never breaks the turn.
 */
export interface ContextRenderRequest {
	/** Session metadata (scope + cwd) the block is rendered for. */
	readonly meta: HookSessionMeta;
	/** Runtime path stamped on the session-group request. Defaults to `plugin`. */
	readonly runtimePath?: RuntimePath;
	/** The credential, when present (gates which blocks render). */
	readonly credential?: HookCredential;
}

/**
 * The context-render seam (FR-3 / FR-10 / b-AC-3). Renders the rules/goals
 * `additionalContext` block session-start returns. Injected so a test drives
 * session-start with a deterministic block. The real impl (Wave 2) asks the daemon
 * (through {@link DaemonHookClient}) for the block — it never opens DeepLake.
 */
export interface ContextRenderer {
	/** Render the context block. Returns `""` on any error (read-only, fail-soft). */
	render(req: ContextRenderRequest): Promise<string>;
}

/**
 * Build a {@link ContextRenderer} fake that returns the supplied block (default
 * `""`). A test asserts session-start threads the block into
 * {@link HookResult.additionalContext} (b-AC-3).
 */
export function createFakeContextRenderer(block = ""): ContextRenderer {
	return {
		async render(): Promise<string> {
			return block;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// PrimeRenderer — the session-start memory prime (PRD-046d / d-AC-1..5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The prime-render request: the scope/session the digest is fetched for. The
 * renderer is READ-ONLY and ABSORBS its own errors (d-AC-4) — an unreachable daemon
 * or a cold (`empty:true`) repo returns an empty digest, never a throw, so
 * session-start never blocks and never errors the agent.
 */
export interface PrimeRenderRequest {
	/** Session metadata (scope + session id) the digest is fetched for. */
	readonly meta: HookSessionMeta;
	/** Runtime path stamped on the session-group request. Defaults to `plugin`. */
	readonly runtimePath?: RuntimePath;
	/** The credential, when present (resolves the tenancy the prime is scoped to). */
	readonly credential?: HookCredential;
}

/**
 * The prime-render seam (PRD-046d / d-AC-1..5). Fetches the already-bounded session
 * digest (046c's `GET /api/memories/prime`) ONCE at session start and returns the
 * `digest` text verbatim — it does NO assembly itself (the daemon bounded it). The
 * shim threads the returned block into the SAME `additionalContext` channel the
 * context renderer uses, so the agent sees the Tier-1 index at turn one.
 *
 * Injected so a test drives session-start with a deterministic digest. The real impl
 * does a fail-soft loopback `GET` — ANY failure (daemon down, timeout, non-200,
 * `empty:true`) resolves to `""` (d-AC-4), never a throw.
 */
export interface PrimeRenderer {
	/** Fetch + render the prime digest. Returns `""` on any error / cold repo (d-AC-4). */
	render(req: PrimeRenderRequest): Promise<string>;
}

/**
 * Build a {@link PrimeRenderer} fake that returns the supplied digest (default `""`,
 * the cold-repo / unreachable case). A test asserts session-start threads the digest
 * into {@link HookResult.additionalContext} (d-AC-1 / d-AC-2) and that an empty digest
 * is omitted (d-AC-4).
 */
export function createFakePrimeRenderer(digest = ""): PrimeRenderer {
	return {
		async render(): Promise<string> {
			return digest;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// RecallRenderer — the per-turn query-aware recall (PRD-076a / a-AC-1..3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The recall-render request (PRD-076a). Mirrors {@link PrimeRenderRequest} but adds the
 * turn's `query` (the user's prompt text). The `cwd` the recall is scoped to rides on
 * `meta.cwd` (49b-AC-2 — the daemon resolves the project from it). READ-ONLY + fail-soft:
 * a signed-out credential is sent unscoped and the daemon fail-closes it (a-AC-2).
 */
export interface RecallRenderRequest {
	/** Session metadata (session id + `cwd`) the recall is scoped to. */
	readonly meta: HookSessionMeta;
	/** Runtime path stamped on the session-group request. Defaults to `plugin`. */
	readonly runtimePath?: RuntimePath;
	/** The credential, when present (resolves the tenancy the recall is scoped to). */
	readonly credential?: HookCredential;
	/** The user's prompt text — the recall query (a-AC-1). */
	readonly query: string;
}

/**
 * One coerced recall hit (PRD-076a). `ref` is the dedupe key (the fused `source:id`, or
 * a content fallback when the daemon carried no id) so a re-scored duplicate of the same
 * memory still dedupes (the PRD's preferred dedupe key); `text` is the matched content the
 * injector renders into the context block. The hook does NO ranking — the daemon bounded
 * and ordered the hits already.
 */
export interface RecallHit {
	/** The dedupe key: `source:id`, or `text:<prefix>` when no id was carried. Never empty. */
	readonly ref: string;
	/** The matched memory content to inject. */
	readonly text: string;
}

/**
 * The recall-render seam (PRD-076a / a-AC-1..3). POSTs the turn's prompt to the daemon's
 * hybrid recall (`/api/memories/recall`) ONCE per qualifying turn and returns the coerced,
 * daemon-bounded {@link RecallHit}s. READ-ONLY + fail-soft: ANY failure (unreachable daemon,
 * timeout, non-200, malformed body, signed-out) resolves to `[]` (no injection), never a
 * throw (a-AC-3), exactly like {@link PrimeRenderer} resolves to `""`.
 *
 * Injected so a test drives the whole per-turn arm with a deterministic hit set. The real
 * impl ({@link import("./recall-renderer.js").createRecallRenderer}) is a loopback POST.
 */
export interface RecallRenderer {
	/** Fetch + coerce the recall hits. Returns `[]` on any error / cold repo (a-AC-3). */
	render(req: RecallRenderRequest): Promise<readonly RecallHit[]>;
}

/**
 * Build a {@link RecallRenderer} fake that returns the supplied hits (default `[]`, the
 * cold-repo / unreachable case). A test asserts the per-turn arm injects them (a-AC-4) and
 * that an empty set yields the nudge-or-nothing path (a-AC-7).
 */
export function createFakeRecallRenderer(hits: readonly RecallHit[] = []): RecallRenderer {
	return {
		async render(): Promise<readonly RecallHit[]> {
			return hits;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// RecallSessionStore — the per-turn throttle/dedupe state (PRD-076a / a-AC-6/7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-session recall state the injector reads + writes to throttle the reminder nudge
 * and dedupe injected hits ACROSS turns (PRD-076a / a-AC-6). Each hook invocation is its own
 * process, so this state MUST persist out of process (the default impl is file-backed —
 * {@link import("./user-prompt-recall.js").createFileRecallSessionStore}); a test injects an
 * in-memory {@link createFakeRecallSessionStore} shared across the two turns it drives.
 */
export interface RecallSessionSnapshot {
	/** The hit refs already injected this session (the dedupe set — a-AC-6). */
	readonly injectedRefs: readonly string[];
	/** The count of recall turns seen this session (throttle clock). */
	readonly turns: number;
	/** The turn index the reminder nudge last fired on (`-1` = never — a-AC-6/7). */
	readonly lastNudgeTurn: number;
}

/** The zero-state snapshot: nothing injected, no turns seen, the nudge never fired. */
export const EMPTY_RECALL_SNAPSHOT: RecallSessionSnapshot = {
	injectedRefs: [],
	turns: 0,
	lastNudgeTurn: -1,
};

/**
 * The recall-state seam (PRD-076a). `load` returns the session's prior snapshot (or
 * {@link EMPTY_RECALL_SNAPSHOT} for a fresh/unreadable session); `save` persists the updated
 * snapshot. Both are SYNC + fail-soft: an I/O error degrades to the zero-state (load) or is
 * swallowed (save) so the turn never breaks over the throttle bookkeeping.
 */
export interface RecallSessionStore {
	/** Read the session's recall snapshot. Fail-soft → {@link EMPTY_RECALL_SNAPSHOT}. */
	load(sessionId: string): RecallSessionSnapshot;
	/** Persist the session's recall snapshot. Fail-soft — a write error is swallowed. */
	save(sessionId: string, snapshot: RecallSessionSnapshot): void;
}

/**
 * Build an in-memory {@link RecallSessionStore} fake. A test drives TWO turns through the
 * SAME fake so the second turn sees the first turn's injected refs (a-AC-6) — the in-process
 * substitute for the production cross-process file store.
 */
export function createFakeRecallSessionStore(): RecallSessionStore {
	const map = new Map<string, RecallSessionSnapshot>();
	return {
		load(sessionId: string): RecallSessionSnapshot {
			return map.get(sessionId) ?? EMPTY_RECALL_SNAPSHOT;
		},
		save(sessionId: string, snapshot: RecallSessionSnapshot): void {
			map.set(sessionId, snapshot);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// HookCoreDeps — what every core module is constructed with (D-2 seam bundle)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seam bundle every core module (`session-start`, `capture`, `pre-tool-use`,
 * `session-end`) is constructed with. Bundling the seams keeps each module a pure
 * function of its injected dependencies, so a Wave-2 test drives the whole core
 * against fakes — no daemon, no DeepLake, no real home directory (D-2).
 */
export interface HookCoreDeps {
	/** The ONLY path out to the daemon (FR-2 / FR-8). */
	readonly daemon: DaemonHookClient;
	/** Reads `~/.honeycomb/credentials.json` (FR-2 / FR-3). */
	readonly credentials: CredentialReader;
	/** Renders the read-only context block (FR-3 / FR-10). */
	readonly context: ContextRenderer;
	/**
	 * The pre-tool-use VFS intercept (PRD-075a a-AC-1). OPTIONAL so every existing
	 * `HookCoreDeps` literal across the other four cores (session-start / capture /
	 * session-end / context-renderer tests) stays unchanged — only `pre-tool-use.ts`
	 * reads this field, falling back to its own `vfs` PARAMETER default when this is
	 * absent (the isolated-unit-test path). The real runtime construction
	 * (`runtime.ts`'s `createHookRuntime`) ALWAYS populates this with the real
	 * daemon-backed intercept, rebound to each pre-tool-use event's own session before
	 * dispatch; `createFakeVfsIntercept()` backs ONLY the function-parameter default,
	 * never this field, in production.
	 */
	readonly vfs?: VfsIntercept;
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionStartSeams — the heal/update/ensure/pull steps session-start runs (FR-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The side-effecting steps session-start sequences AROUND the daemon calls (FR-3 /
 * b-AC-3). The real impls already exist from prior PRDs (`healDriftedOrgToken`,
 * `autoUpdate`, `autoPullSkills`, the graph-pull worker spawn); session-start
 * CALLS them through this seam rather than importing them, so the core stays a pure
 * function of its dependencies and a Wave-2 test asserts the ORDER they run in with
 * a recording fake — no network, no real update, no real spawn. Every step is
 * fail-soft: a step that rejects is absorbed (a heal/update failure never breaks the
 * turn, FR-10) — the recorder still captures that it was attempted.
 *
 * This is INJECTED ADDITIVELY via {@link SessionStartDeps}; it does NOT change
 * {@link HookCoreDeps}, so 019c's existing construction stays stable. A shim that
 * does not supply it gets the no-op default ({@link createNoopSessionStartSeams}).
 */
export interface SessionStartSeams {
	/** Reconcile a drifted org token before any scoped call (FR-3 step 2). */
	healDriftedOrgToken(cred: HookCredential | undefined): Promise<void>;
	/** Self-update the plugin if a newer version is available (FR-3 step 3). */
	autoUpdate(): Promise<void>;
	/**
	 * Ensure the `memory` + `sessions` tables exist (FR-3 step 4). A daemon call in
	 * production; GATED behind the capture gate by session-start (only runs when
	 * capture is enabled). Returns nothing — the daemon creates-if-missing.
	 */
	ensureTables(meta: HookSessionMeta): Promise<void>;
	/**
	 * Write the placeholder summary row (FR-3 step 5). A daemon call in production;
	 * GATED behind the capture gate alongside {@link ensureTables}.
	 */
	writePlaceholderSummary(meta: HookSessionMeta): Promise<void>;
	/** Pull team/org skills into the local skill tree (FR-3 step 7). */
	autoPullSkills(cred: HookCredential | undefined): Promise<void>;
	/**
	 * Pull team/org synced ASSETS (skills/agents) and install them in-process (PRD-033
	 * R-1, the session-start asset auto-pull). Unlike {@link autoPullSkills} (a
	 * fire-and-forget daemon POST), the asset pull runs the THIN-CLIENT install LOCALLY:
	 * the daemon returns rows over loopback, this client writes the native artifacts to
	 * disk. Idempotent + fail-soft + time-budgeted by the assets thin client's `autoPull`.
	 * Runs as a new FR-3 step right after {@link autoPullSkills}.
	 */
	autoPullAssets(cred: HookCredential | undefined): Promise<void>;
	/** Spawn the detached graph-pull worker (FR-3 step 8). Fire-and-forget. */
	spawnGraphPull(meta: HookSessionMeta): Promise<void>;
}

/** A recorded session-start step (the fake's audit trail, in call order). */
export interface RecordedSessionStartStep {
	/** The step name, e.g. `"healDriftedOrgToken"`. */
	readonly step: string;
}

/** A {@link SessionStartSeams} fake that records each step in call order for ordering assertions. */
export interface FakeSessionStartSeams extends SessionStartSeams {
	/** Every step invoked, in order (b-AC-3 ordering assertion). */
	readonly steps: readonly RecordedSessionStartStep[];
}

/** Options for {@link createFakeSessionStartSeams}. */
export interface FakeSessionStartSeamsOptions {
	/** When set, the named step REJECTS — to drive the fail-soft absorb path (FR-10). */
	readonly throwOn?: ReadonlySet<string>;
}

/**
 * Build a recording {@link SessionStartSeams} fake. Records each step so a Wave-2
 * test asserts the FR-3 order; `throwOn` makes a named step reject so the test
 * proves session-start absorbs it and continues (FR-10 fail-soft).
 */
export function createFakeSessionStartSeams(opts: FakeSessionStartSeamsOptions = {}): FakeSessionStartSeams {
	const steps: RecordedSessionStartStep[] = [];
	const throwOn = opts.throwOn ?? new Set<string>();
	const record = async (step: string): Promise<void> => {
		steps.push({ step });
		if (throwOn.has(step)) throw new Error(`session-start step failed (test): ${step}`);
	};
	return {
		get steps(): readonly RecordedSessionStartStep[] {
			return steps;
		},
		async healDriftedOrgToken(): Promise<void> {
			await record("healDriftedOrgToken");
		},
		async autoUpdate(): Promise<void> {
			await record("autoUpdate");
		},
		async ensureTables(): Promise<void> {
			await record("ensureTables");
		},
		async writePlaceholderSummary(): Promise<void> {
			await record("writePlaceholderSummary");
		},
		async autoPullSkills(): Promise<void> {
			await record("autoPullSkills");
		},
		async autoPullAssets(): Promise<void> {
			await record("autoPullAssets");
		},
		async spawnGraphPull(): Promise<void> {
			await record("spawnGraphPull");
		},
	};
}

/** A no-op {@link SessionStartSeams} (every step resolves to nothing). The default. */
export function createNoopSessionStartSeams(): SessionStartSeams {
	return {
		async healDriftedOrgToken(): Promise<void> {},
		async autoUpdate(): Promise<void> {},
		async ensureTables(): Promise<void> {},
		async writePlaceholderSummary(): Promise<void> {},
		async autoPullSkills(): Promise<void> {},
		async autoPullAssets(): Promise<void> {},
		async spawnGraphPull(): Promise<void> {},
	};
}

/**
 * The session-start dependency bundle: the core seams PLUS the FR-3 step seams +
 * the capture-gate environment. ADDITIVE over {@link HookCoreDeps} — session-start
 * needs more than capture does, so it takes its own bundle; the shared three seams
 * are spread in so a shim constructs one object. `seams` defaults to the no-op set;
 * `captureEnv` lets the shim source the gate flag from its own env/config channel
 * (the table-ensure + placeholder steps are gated on it, FR-3).
 */
export interface SessionStartDeps extends HookCoreDeps {
	/** The FR-3 side-effecting steps (heal/update/ensure/pull). Default: no-op. */
	readonly seams?: SessionStartSeams;
	/**
	 * The capture-gate environment for the table-ensure + placeholder gate (FR-3).
	 * Carries `captureFlag` (`HONEYCOMB_CAPTURE`), resolved by the shim. When absent,
	 * the gate is permissive (capture enabled), matching the gate's own default.
	 */
	readonly captureEnv?: { readonly captureFlag?: string };
	/**
	 * The PRD-046d session-start memory prime. When supplied, session-start fetches the
	 * 046c digest ONCE (d-AC-3) and appends it to the rendered `additionalContext`
	 * (d-AC-1 / d-AC-2). ABSENT → no prime is fetched (the prior session-start behaviour
	 * is unchanged), so a unit-constructed session-start stays inert. Fail-soft: a prime
	 * failure or a cold (`empty:true`) repo contributes nothing and never breaks
	 * session-start (d-AC-4).
	 */
	readonly prime?: PrimeRenderer;
	/**
	 * PRD-059a / IRD-123 — the first-run "bind a project to start" notice gate. When supplied,
	 * session-start asks it ONCE per session (a-AC-2 — the session-start seam, NOT per turn) whether
	 * the active workspace has bound any project yet; when it has NOT, session-start prepends a single
	 * quiet "bind a project to start" notice to the rendered `additionalContext`, telling the user
	 * capture is paused until they bind a folder. ABSENT → no notice (the prior session-start behaviour
	 * is unchanged), so a unit-constructed session-start stays inert. The check reads the LOCAL
	 * `~/.deeplake/projects.json` cache with NO DeepLake call (a-AC-3) and is FAIL-SOFT: a throw is
	 * absorbed and no notice is shown (never break session-start over the notice — 059a impl-note).
	 */
	readonly onboardingNotice?: OnboardingNoticeGate;
	/**
	 * OPTIONAL off-process hygiene spawn. When supplied (the harness shim implements
	 * `HarnessShim.spawnHygieneChild`), session-start calls this INSTEAD of the three
	 * in-process hygiene seams (`autoPullSkills` / `autoPullAssets` / `spawnGraphPull`).
	 * The implementation spawns a detached child that runs the three pulls in its OWN
	 * process; the parent returns immediately with no in-process hygiene I/O pending, so
	 * its event loop empties and Node exits promptly after writing the response. See
	 * `HarnessShim.spawnHygieneChild` for the latency-budget + Windows-libuv rationale.
	 * ABSENT → session-start runs the three hygiene seams in-process via `backgroundPull`
	 * (the prior behavior — every harness that has not opted into the off-process path).
	 */
	readonly spawnHygieneChild?: (meta: HookSessionMeta) => void;
}

/**
 * The first-run onboarding-notice gate seam (PRD-059a a-AC-2 / IRD-123). Returns whether the active
 * workspace has at least one locally-bound project; when `false`, session-start shows the one-per-session
 * "bind a project to start" notice. The default production impl reads the thin-client
 * `~/.deeplake/projects.json` cache ({@link import("./project-resolver.js").hasBoundProjectOnDisk}); a
 * test injects a fixed boolean. SYNC + pure given its input — no network, no DeepLake.
 */
export interface OnboardingNoticeGate {
	/** True when the workspace has ≥1 bound project (notice suppressed); false in the zero-state. */
	hasBoundProject(meta: HookSessionMeta, credential: HookCredential | undefined): boolean;
	/**
	 * PRD-073b (AC-073b.2.2): the PER-SESSION notice text, or `null` to show nothing. When present it
	 * SUPERSEDES the boolean {@link hasBoundProject} path in session-start, so the notice can carry a
	 * cwd-specific variant ("this folder is not bound to a project") when the session's own cwd is
	 * unbound while the workspace has other bound projects, and the workspace-level variant on a
	 * genuinely fresh install. Optional + additive: a gate that implements only {@link hasBoundProject}
	 * (the 059a gate, or a test fake) keeps the workspace-level behavior unchanged.
	 */
	noticeText?(meta: HookSessionMeta, credential: HookCredential | undefined): string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VfsIntercept — the pre-tool-use VFS seam (FR-5 / b-AC-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A lowered pre-tool filesystem op the VFS intercept resolves (FR-5 / b-AC-4). The
 * shim normalizes a Bash/Read/Grep/Glob/Write/Edit pre-tool payload into this shape;
 * the core routes it through {@link VfsIntercept}. `verb` is the lowered intent:
 *   - `read`   → `cat`/`Read`           → a row read
 *   - `search` → `grep`/`Glob`          → hybrid lexical-plus-semantic search
 *   - `list`   → `ls`                   → prefix listing
 *   - `find`   → `find`                 → pattern query
 *   - `write`  → `Write`/`Edit`         → DENIED with guidance
 * `path` is the (mount-relative or host-absolute) path the tool targeted; `query`
 * carries the search/pattern text for `search`/`find`.
 */
export interface VfsToolOp {
	/** The lowered verb. */
	readonly verb: "read" | "search" | "list" | "find" | "write";
	/** The path the op targeted. */
	readonly path: string;
	/** The search/pattern text for `search`/`find`. */
	readonly query?: string;
}

/**
 * The VFS-intercept seam (FR-5 / b-AC-4 / D-2). The ONLY path pre-tool-use reaches
 * the memory mount. The real impl (deferred assembly) wraps the PRD-015
 * `daemon-client/vfs` `DeepLakeFs` — itself a thin client that dispatches SQL
 * THROUGH the daemon, opening NO DeepLake here. `resolve` returns the resolved
 * memory content for a read/search/list/find, or rejects for a denied write. The
 * pre-tool core lives under `src/hooks` (a NON_DAEMON_ROOT), so it can never open
 * DeepLake — this seam is its sole route, and a test asserts NOTHING reached the
 * real filesystem by driving the whole intercept against the recording fake.
 */
export interface VfsIntercept {
	/** Resolve a read/search/list/find op to its memory content (rejects on a denied write). */
	resolve(op: VfsToolOp): Promise<string>;
}

/** A recorded {@link VfsIntercept} call (the fake's audit trail). */
export interface RecordedVfsOp {
	readonly verb: VfsToolOp["verb"];
	readonly path: string;
	readonly query?: string;
}

/** Options for {@link createFakeVfsIntercept}. */
export interface FakeVfsInterceptOptions {
	/** The content to return for a resolved op (default `""`). */
	readonly content?: string;
}

/** A recording {@link VfsIntercept} fake — answers from `content`, records every op. */
export interface FakeVfsIntercept extends VfsIntercept {
	/** Every op resolved through this fake, in order. Proves nothing hit the real FS. */
	readonly ops: readonly RecordedVfsOp[];
}

/**
 * Build a recording {@link VfsIntercept} fake. Records each op and returns the
 * configured `content`, so a Wave-2 test drives the whole pre-tool intercept
 * against it and asserts the daemon-resolved content was returned and the real
 * filesystem was never touched (b-AC-4) — there is no FS path in the fake at all.
 */
export function createFakeVfsIntercept(opts: FakeVfsInterceptOptions = {}): FakeVfsIntercept {
	const ops: RecordedVfsOp[] = [];
	const content = opts.content ?? "";
	return {
		get ops(): readonly RecordedVfsOp[] {
			return ops;
		},
		async resolve(op: VfsToolOp): Promise<string> {
			ops.push({ verb: op.verb, path: op.path, query: op.query });
			return content;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionEndOps — the per-session summary lock the session-end core acquires (FR-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-session summary lock session-end acquires before spawning the detached
 * summary worker (FR-6 / b-AC-5). `acquire` returns `true` when this caller won the
 * lock (and must spawn) or `false` when another path already holds it (skip).
 * `release` is called when the spawn THROWS before the worker takes ownership, so a
 * `--resume` can retrigger (b-AC-5). Injected so a Wave-2 test asserts acquire→spawn
 * ordering and the release-on-throw path without a real lock file.
 */
export interface SummaryLock {
	/** Acquire the per-session lock. `true` → this caller spawns; `false` → already held. */
	acquire(sessionId: string): Promise<boolean>;
	/** Release the lock (called only on a spawn throw, so `--resume` retriggers). */
	release(sessionId: string): Promise<void>;
}

/** A {@link SummaryLock} fake that records acquire/release calls for ordering assertions. */
export interface FakeSummaryLock extends SummaryLock {
	/** Every acquire call's session id, in order. */
	readonly acquired: readonly string[];
	/** Every release call's session id, in order (b-AC-5 release-on-throw). */
	readonly released: readonly string[];
}

/** Options for {@link createFakeSummaryLock}. */
export interface FakeSummaryLockOptions {
	/** When `false`, `acquire` returns false (the already-held path). Default `true`. */
	readonly acquirable?: boolean;
}

/**
 * Build a recording {@link SummaryLock} fake. Records every acquire/release so a
 * Wave-2 test asserts session-end acquired the lock BEFORE spawning and RELEASED it
 * when the spawn threw (b-AC-5). `acquirable: false` drives the already-held skip.
 */
export function createFakeSummaryLock(opts: FakeSummaryLockOptions = {}): FakeSummaryLock {
	const acquired: string[] = [];
	const released: string[] = [];
	const acquirable = opts.acquirable ?? true;
	return {
		get acquired(): readonly string[] {
			return acquired;
		},
		get released(): readonly string[] {
			return released;
		},
		async acquire(sessionId: string): Promise<boolean> {
			acquired.push(sessionId);
			return acquirable;
		},
		async release(sessionId: string): Promise<void> {
			released.push(sessionId);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// HookInput zod boundary — validate an untrusted normalized payload (FR-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The zod schema for {@link HookInput} (typescript-node stinger Hard Rule #3: zod
 * at every external boundary). A shim's normalized output is validated here BEFORE
 * the core forwards it, so a malformed payload is rejected at the boundary rather
 * than reaching the daemon. The app uses zod ^4 (the MCP server is the only place
 * that imports `zod/v3`), so this module imports from `"zod"`.
 */
export const HookSessionMetaSchema = z.object({
	sessionId: z.string().trim().min(1),
	path: z.string().optional(),
	cwd: z.string().optional(),
	permissionMode: z.string().optional(),
	hookEventName: z.string().optional(),
	agentId: z.string().optional(),
	agent: z.string().optional(),
});

/** The zod schema for a normalized {@link HookInput}. */
export const HookInputSchema = z.object({
	event: z.enum(LOGICAL_EVENTS),
	meta: HookSessionMetaSchema,
	data: z.unknown().optional(),
	messageEmbedding: z.array(z.number()).optional(),
	runtimePath: z.enum(["plugin", "legacy"]),
});
