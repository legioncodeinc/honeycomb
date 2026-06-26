/**
 * SDK contracts + seams — PRD-019e Wave 1 (`@legioncodeinc/honeycomb` typed client).
 *
 * ── THE THESIS (FR-1 / FR-3 / e-AC-3 / D-2) ─────────────────────────────────
 *   THE SDK IS A FETCH-ONLY THIN CLIENT. {@link HoneycombClient} wraps the daemon
 *   API using ONLY standard `fetch` — NO native dependency — so it runs in Node,
 *   Bun, AND the browser (e-AC-3). It opens NO DeepLake and shares the daemon's
 *   token + API-key model (FR-6). `src/sdk` is in `NON_DAEMON_ROOTS`
 *   (`tests/daemon/storage/invariant.test.ts`).
 *
 * ── THE METHOD SURFACE (FR-2 / FR-3) ────────────────────────────────────────
 * The ergonomic `remember`/`recall` helpers plus the full daemon surface the SDK
 * reaches: memory, hook entry points, connectors/documents, sources, skills/goals,
 * health/diagnostics, and the VALUE-SAFE secrets surface (names + redacted output
 * only, FR-9 / e-AC-6). Every authenticated call carries the configured token +
 * actor + actorType (FR-2 / FR-6).
 *
 * ── TYPED ERRORS + RETRY SPLIT (FR-4 / FR-5 / e-AC-2) ────────────────────────
 *   - {@link ApiError}    — a non-2xx response (status + body).
 *   - {@link NetworkError}— a transport failure.
 *   - {@link TimeoutError}— a request past the configured budget.
 * GET requests retry on transient failure; MUTATING requests do NOT (not idempotent).
 * The {@link RetryPolicy} seam expresses the split so a test drives it deterministically.
 *
 * Wave 1 ships the interface + error classes + the {@link Fetch}/{@link RetryPolicy}
 * seams + an honest-stub client. Wave 2 (019e) fills the method bodies + the three
 * framework entry points (`react.ts`, `vercel.ts`, `openai.ts`) — WITHOUT changing
 * these contracts.
 */

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-019e: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed errors (FR-4 / e-AC-2)
// ─────────────────────────────────────────────────────────────────────────────

/** Base class for every typed SDK error so a caller can `catch (e) { if (e instanceof HoneycombError) … }`. */
export abstract class HoneycombError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** A non-2xx daemon response (FR-4). Carries the HTTP status + the parsed/raw body. */
export class ApiError extends HoneycombError {
	constructor(
		message: string,
		/** The HTTP status code (e.g. 404, 409, 500). */
		readonly status: number,
		/** The response body (parsed JSON or raw text), for diagnostics. */
		readonly body?: unknown,
	) {
		super(message);
	}
}

/** A transport failure — DNS, connection refused, socket reset (FR-4). */
export class NetworkError extends HoneycombError {
	constructor(
		message: string,
		/** The underlying cause, when available. */
		readonly cause?: unknown,
	) {
		super(message);
	}
}

/** A request that exceeded the configured timeout budget (FR-4). */
export class TimeoutError extends HoneycombError {
	constructor(
		message: string,
		/** The budget (ms) that was exceeded. */
		readonly timeoutMs: number,
	) {
		super(message);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch seam (e-AC-3 / D-2) — standard fetch, injectable for tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `fetch` signature the SDK uses (FR-1 / e-AC-3). Standard `fetch` ONLY — no
 * native dependency — so the client runs in Node, Bun, and the browser. Injected so
 * a Wave-2 test drives the client against a stub fetch (no daemon, no network), and
 * so the client never reaches for a Node-only HTTP module.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// ─────────────────────────────────────────────────────────────────────────────
// RetryPolicy seam (FR-5 / e-AC-2) — GET retries, mutations don't
// ─────────────────────────────────────────────────────────────────────────────

/** The HTTP method classification driving the retry split (FR-5). */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The retry-policy seam (FR-5 / e-AC-2). Expresses the rule that idempotent reads
 * (GET) retry on transient failure while non-idempotent mutations do NOT, so the SDK
 * never double-applies a write. Injected so a Wave-2 test asserts the split
 * deterministically without real backoff delays.
 */
export interface RetryPolicy {
	/** Max attempts for `method` (GET → >1, mutations → 1). */
	maxAttempts(method: HttpMethod): number;
	/** Backoff (ms) before attempt `n` (1-based). */
	backoffMs(attempt: number): number;
}

/** The default retry policy: GET retries up to 3x with linear backoff; mutations once. */
export function defaultRetryPolicy(): RetryPolicy {
	return {
		maxAttempts(method: HttpMethod): number {
			return method === "GET" ? 3 : 1;
		},
		backoffMs(attempt: number): number {
			return attempt * 100;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Client config + the actor model (FR-1 / FR-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * {@link HoneycombClient} construction options (FR-1 / FR-6). `daemonUrl` is the
 * daemon base URL; `token` is optional (team + hybrid daemon modes); `actor` +
 * `actorType` are stamped on every call so SDK traffic is scoped + audited. The
 * `fetch` + `retry` + `timeoutMs` seams are injectable (defaults: global fetch,
 * {@link defaultRetryPolicy}, a sane budget).
 */
export interface HoneycombClientOptions {
	/** The daemon base URL (e.g. `http://127.0.0.1:3850`). */
	readonly daemonUrl: string;
	/** The auth token (team + hybrid modes). Never logged. */
	readonly token?: string;
	/** The actor label stamped on every call (FR-6). */
	readonly actor: string;
	/** The actor type stamped on every call (FR-6). */
	readonly actorType: string;
	/** Injectable fetch (default: global `fetch`) — keeps the SDK native-dep-free (e-AC-3). */
	readonly fetch?: Fetch;
	/** Injectable retry policy (default: {@link defaultRetryPolicy}). */
	readonly retry?: RetryPolicy;
	/** The per-request timeout budget in ms (default: a sane value, Wave 2 pins it). */
	readonly timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Method-surface option shapes (FR-2 / FR-3) — the typed args
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link HoneycombClient.remember} (FR-2). */
export interface RememberOptions {
	/** The memory path to store under, if explicit. */
	readonly path?: string;
}

/** Options for {@link HoneycombClient.recall} (FR-2). */
export interface RecallOptions {
	/** Max results to return. */
	readonly limit?: number;
}

/** A recall hit (the shape `recall` resolves to; Wave 2 pins fields against the daemon). */
export interface RecallResult {
	/** The memory path. */
	readonly path: string;
	/** The recalled summary/body. */
	readonly text: string;
	/** The recall score, when present. */
	readonly score?: number;
}

/** A value-safe secret descriptor (FR-9 / e-AC-6): a NAME, never a value. */
export interface SecretName {
	/** The secret name. The SDK never returns the value. */
	readonly name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HoneycombClient — the public client surface (FR-1..FR-6 / FR-9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The typed daemon client (FR-1..FR-6 / FR-9). Fetch-only, native-dep-free. The
 * method surface covers the full intended daemon reach; Wave 1 declares the
 * signatures, Wave 2 fills the bodies. The framework helpers (`react`/`vercel`/
 * `openai`) reuse THIS client's token + actor model (FR-7 / FR-8 / e-AC-5).
 *
 * The grouped sub-surfaces (`memory`, `hooks`, `connectors`, `documents`, `sources`,
 * `skills`, `goals`, `health`, `secrets`) keep the method surface organized; the
 * ergonomic `remember`/`recall` sit at the top level (FR-2).
 */
export interface HoneycombClient {
	/** Store a memory (FR-2). Carries token + actor + actorType (e-AC-1). */
	remember(text: string, opts?: RememberOptions): Promise<void>;
	/** Hybrid recall (FR-2). Carries token + actor + actorType (e-AC-1). */
	recall(query: string, opts?: RecallOptions): Promise<readonly RecallResult[]>;

	/** The full daemon surface (FR-3) — Wave 2 fills each grouped method. */
	readonly memory: MemoryApi;
	readonly hooks: HooksApi;
	readonly connectors: ConnectorsApi;
	readonly documents: DocumentsApi;
	readonly sources: SourcesApi;
	readonly skills: SkillsApi;
	readonly goals: GoalsApi;
	readonly health: HealthApi;
	/** Value-safe secrets (FR-9 / e-AC-6) — names + redacted output only. */
	readonly secrets: SecretsApi;
}

/** Memory sub-surface (FR-3). Wave 2 fills the methods. */
export interface MemoryApi {
	search(query: string, opts?: RecallOptions): Promise<readonly RecallResult[]>;
	store(text: string, opts?: RememberOptions): Promise<void>;
	get(path: string): Promise<RecallResult | undefined>;
	list(prefix?: string): Promise<readonly RecallResult[]>;
}

/** Hook-entry-point sub-surface (FR-3) — the SDK can call hooks, not replace them. */
export interface HooksApi {
	call(endpoint: string, body: unknown): Promise<unknown>;
}

/** Connectors sub-surface (FR-3). */
export interface ConnectorsApi {
	list(): Promise<readonly unknown[]>;
}

/** Documents sub-surface (FR-3). */
export interface DocumentsApi {
	list(): Promise<readonly unknown[]>;
}

/** Sources sub-surface (FR-3). */
export interface SourcesApi {
	list(): Promise<readonly unknown[]>;
}

/** Skills sub-surface (FR-3). */
export interface SkillsApi {
	list(): Promise<readonly unknown[]>;
}

/** Goals sub-surface (FR-3). */
export interface GoalsApi {
	list(): Promise<readonly unknown[]>;
	add(goal: string): Promise<void>;
}

/** Health/diagnostics sub-surface (FR-3). */
export interface HealthApi {
	check(): Promise<{ readonly ok: boolean }>;
}

/** Value-safe secrets sub-surface (FR-9 / e-AC-6): names + redacted output only. */
export interface SecretsApi {
	/** List secret NAMES — never values (e-AC-6). */
	list(prefix?: string): Promise<readonly SecretName[]>;
	/** Exec a command with secrets injected; returns REDACTED output only (e-AC-6). */
	exec(command: string): Promise<{ readonly redactedOutput: string }>;
}
