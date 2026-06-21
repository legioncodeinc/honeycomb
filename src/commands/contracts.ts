/**
 * Unified CLI command contracts + seams — PRD-020a Wave 1 (the dispatcher surface).
 *
 * ── THE THESIS (FR-1..FR-3 / a-AC-1 / a-AC-3 / D-2) ─────────────────────────
 *   THE CLI IS A THIN CLIENT. `src/cli/index.ts` parses global flags, then routes
 *   to a handler under `src/commands/`. A handler that touches STORAGE reaches the
 *   daemon (`127.0.0.1:3850`) through the injected {@link DaemonClient} SEAM — the
 *   ONLY path to a storage verb. No handler opens DeepLake, holds a storage handle,
 *   or builds storage SQL. `src/commands` is a NON_DAEMON_ROOT (D-2;
 *   `tests/daemon/storage/invariant.test.ts`), so a stray `daemon/storage` import
 *   FAILS the build — the thin-client property is ENFORCED, not merely a convention.
 *
 * ── Module home = `src/commands/` ───────────────────────────────────────────
 *   The split (FR-1 / 020a goal): the ENTRY POINT (`src/cli/index.ts`) parses;
 *   the HANDLERS (`src/commands/*`) express their work as daemon calls or local FS
 *   ops behind seams. Presentation never entangles storage. `src/cli/index.ts` stays
 *   the version-print stub this wave; 020a Wave 2 rewires it onto {@link dispatch}.
 *
 * ── What Wave 1 ships ────────────────────────────────────────────────────────
 *   The {@link CommandDispatcher} contract, the merged {@link VERB_TABLE}, the
 *   {@link AUTH_SUBCOMMANDS} passthrough set, the {@link DaemonClient} seam + its
 *   {@link createFakeDaemonClient} fake, and one honest-stub handler module per verb
 *   group. Wave 2 fills the handler bodies + rewires `src/cli/index.ts`.
 *
 * Every export here is STABLE — Wave 2 fills bodies and adds ADDITIVELY (optional
 * fields / extra seams / new exports); it never renames or re-types what 020b/c/d
 * may read.
 */

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-020a: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The merged verb table (FR-2) — every top-level command + its handler group
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The unified command surface (FR-2 / a-AC-1). Each verb maps to a handler group
 * under `src/commands/`. `storage` marks a verb that touches storage and so MUST
 * route through the {@link DaemonClient} seam (FR-3 / a-AC-3). `auth` marks the
 * tenancy verbs whose subcommands pass through to the auth dispatcher (FR-4 /
 * {@link AUTH_SUBCOMMANDS}). `local` marks install/diagnostic verbs that touch the
 * local FS / process only (still never DeepLake).
 *
 * Wave 2 maps each verb to a concrete handler function; the SPEC (name + class) is
 * the stable contract 020b/020d read (e.g. `status` surfaces 020d's health, and
 * `dashboard` launches 020b's surface).
 */
export type VerbClass = "storage" | "auth" | "local";

/** One row of the merged verb table — the verb word + its routing class. */
export interface VerbSpec {
	/** The top-level command word (e.g. `recall`, `sessions`, `dashboard`). */
	readonly verb: string;
	/** How the verb reaches its effect (storage → daemon; auth → passthrough; local → FS). */
	readonly cls: VerbClass;
	/** One-line usage summary printed by `--help`. */
	readonly summary: string;
}

/**
 * The full merged verb set (FR-2). The order is the help-listing order. The merged
 * surface consolidates the Hivemind product verbs and the otherhive engine verbs
 * into ONE dispatcher; every storage-touching verb is `cls: "storage"` so a single
 * predicate ({@link isStorageVerb}) proves AC-3 (storage → daemon, never DeepLake).
 *
 * Note `org` + `workspace` are `auth` (their subcommands pass through to the auth
 * dispatcher, FR-4); `sessions` is `storage` (its `prune` subcommand deletes through
 * the daemon, a-AC-2); `setup`/`connect`/`uninstall`/`update`/`dashboard` are `local`.
 */
export const VERB_TABLE: readonly VerbSpec[] = Object.freeze([
	{ verb: "setup", cls: "local", summary: "detect assistants, wire hooks, bring up the daemon" },
	{ verb: "status", cls: "local", summary: "daemon connectivity + login + D1–D5 environment health" },
	{ verb: "daemon", cls: "local", summary: "start | stop | status the loopback daemon (3850)" },
	{ verb: "dashboard", cls: "local", summary: "launch the daemon-served dashboard (020b)" },
	{ verb: "dream", cls: "storage", summary: "trigger a dreaming consolidation pass on the daemon (009/026)" },
	{ verb: "maintenance", cls: "storage", summary: "run version-history compaction over version-bumped tables (030)" },
	{ verb: "remember", cls: "storage", summary: "write a memory through the daemon" },
	{ verb: "recall", cls: "storage", summary: "recall memories through the daemon" },
	{ verb: "agent", cls: "storage", summary: "run an agent turn through the daemon" },
	{ verb: "ontology", cls: "storage", summary: "inspect/propose ontology changes through the daemon" },
	{ verb: "secret", cls: "storage", summary: "manage named secrets through the daemon" },
	{ verb: "settings", cls: "storage", summary: "get/set/list vault settings + provider→model selector through the daemon" },
	{ verb: "asset", cls: "storage", summary: "register/promote/demote/style skills+agents through the tier×style lattice (033)" },
	{ verb: "skill", cls: "storage", summary: "skillify scope/pull/unpull/force through the daemon" },
	{ verb: "hook", cls: "local", summary: "inspect/wire harness hooks" },
	{ verb: "route", cls: "storage", summary: "manage inference routes through the daemon" },
	{ verb: "sources", cls: "storage", summary: "connect/index/purge sources through the daemon" },
	{ verb: "graph", cls: "storage", summary: "build/query the codebase graph through the daemon" },
	{ verb: "goal", cls: "storage", summary: "manage goals/KPIs through the daemon" },
	{ verb: "whoami", cls: "auth", summary: "show the authenticated user, org, and workspace (GET /me)" },
	{ verb: "org", cls: "auth", summary: "list/switch org (passthrough to the auth dispatcher)" },
	{ verb: "workspace", cls: "auth", summary: "list/switch/use workspace (passthrough to the auth dispatcher)" },
	{ verb: "workspaces", cls: "auth", summary: "list workspaces in the active org (alias of `workspace list`)" },
	{ verb: "sessions", cls: "storage", summary: "list/prune captured sessions through the daemon" },
	{ verb: "uninstall", cls: "local", summary: "reverse only Honeycomb's changes" },
	{ verb: "update", cls: "local", summary: "self-update the CLI, daemon, and bundles" },
]);

/** Fast lookup of a verb spec by word; `undefined` for an unknown verb. */
export function lookupVerb(verb: string): VerbSpec | undefined {
	return VERB_TABLE.find((v) => v.verb === verb);
}

/** True when a verb touches storage and so MUST route through the daemon (FR-3 / a-AC-3). */
export function isStorageVerb(verb: string): boolean {
	return lookupVerb(verb)?.cls === "storage";
}

/**
 * The tenancy verbs whose FULL argument array passes through to the auth-login
 * dispatcher (FR-4 / a-AC-1). `honeycomb org switch <org>` and
 * `honeycomb workspace use <ws>` are recognized by membership in this set and
 * forwarded verbatim to `src/cli/org.ts` / `src/cli/auth.ts` — the dispatcher does
 * NOT re-parse their subcommands. Login/logout are auth entry points too.
 *
 * PRD-023 Wave 3 (AC-3 / AC-5) adds `whoami` (GET /me identity) and `workspaces` (the single-word
 * `workspace list` alias) — both are recognized here and forwarded verbatim to the auth dispatcher.
 */
export const AUTH_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"org",
	"workspace",
	"workspaces",
	"whoami",
	"login",
	"logout",
]);

/** True when a verb is an auth passthrough (FR-4). */
export function isAuthPassthrough(verb: string): boolean {
	return AUTH_SUBCOMMANDS.has(verb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Global flags + the parsed invocation (FR-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The global flags the entry point parses BEFORE routing (FR-1). `--help` and
 * `--version` short-circuit (print + exit 0); the rest are shared options threaded
 * to every handler. A per-command flag is left in {@link CommandInvocation.argv} for
 * the handler to parse.
 */
export interface GlobalFlags {
	/** `--help` / `-h` → print usage and exit 0. */
	readonly help: boolean;
	/** `--version` / `-V` → print version and exit 0. */
	readonly version: boolean;
	/** `--json` → machine-readable output where a handler supports it. */
	readonly json: boolean;
	/** `--dry-run` → no side effects (e.g. `update --dry-run`, FR-10). */
	readonly dryRun: boolean;
}

/** The default (all-false) global flags. */
export const DEFAULT_GLOBAL_FLAGS: GlobalFlags = Object.freeze({
	help: false,
	version: false,
	json: false,
	dryRun: false,
});

/**
 * A parsed top-level invocation (FR-1). `verb` is the first non-flag word (empty
 * when none → usage); `argv` is the REMAINING tail handed verbatim to the handler
 * (so a passthrough verb forwards its own subcommands, FR-4); `flags` are the parsed
 * globals.
 */
export interface CommandInvocation {
	/** The resolved verb word, or `""` when no command was given (→ usage). */
	readonly verb: string;
	/** The argv tail after the verb (the handler parses its own subcommands/flags). */
	readonly argv: readonly string[];
	/** The parsed global flags. */
	readonly flags: GlobalFlags;
}

// ─────────────────────────────────────────────────────────────────────────────
// The DaemonClient seam (FR-3 / a-AC-3) — the ONLY path to a storage verb
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A request a storage verb dispatches to the daemon (FR-3). `path` is the daemon
 * route (e.g. `/api/memories`, `/api/sessions/prune`); `method` the HTTP verb;
 * `body` the JSON payload. The daemon applies the tenancy scope from the shared
 * credential — the CLI never carries a raw org/workspace partition into SQL.
 */
export interface DaemonRequest {
	/** The HTTP method. */
	readonly method: "GET" | "POST" | "DELETE" | "PATCH";
	/** The daemon route path (e.g. `/api/sessions/prune`). */
	readonly path: string;
	/** The JSON body, when any. */
	readonly body?: unknown;
	/** Optional query params appended to the path. */
	readonly query?: Readonly<Record<string, string>>;
}

/** A daemon response: the HTTP status + the parsed JSON body (or `undefined`). */
export interface DaemonResponse {
	/** The HTTP status code. */
	readonly status: number;
	/** The parsed JSON body, when any. */
	readonly body?: unknown;
}

/**
 * THE SEAM (FR-3 / a-AC-3 / D-2). Every storage-touching handler reaches the daemon
 * ONLY through this. The real impl is a thin loopback `fetch` to `127.0.0.1:3850`
 * stamping the actor/scope headers from the shared credential; the fake records every
 * call so a test asserts (a) storage verbs went through the daemon and (b) NO DeepLake
 * path was imported. There is NO `query(sql)` here on purpose — the CLI dispatches
 * intent (route + body), never SQL; the daemon builds + guards the SQL.
 */
export interface DaemonClient {
	/** Dispatch a request to the daemon. */
	send(req: DaemonRequest): Promise<DaemonResponse>;
	/** Cheap liveness probe (for `status`/`dashboard` connectivity). */
	ping(): Promise<boolean>;
}

/** A recorded call the {@link FakeDaemonClient} captures (for assertions). */
export interface RecordedDaemonCall {
	/** The request that was dispatched. */
	readonly req: DaemonRequest;
}

/** A fake {@link DaemonClient} that records every call + replays canned responses. */
export interface FakeDaemonClient extends DaemonClient {
	/** Every `send` call, in order. */
	readonly calls: readonly RecordedDaemonCall[];
}

/** Options seeding the fake: canned responses keyed by `${method} ${path}`, plus a ping result. */
export interface FakeDaemonClientOptions {
	/** Canned responses keyed by `${method} ${path}` (e.g. `"DELETE /api/sessions/prune"`). */
	readonly responses?: Readonly<Record<string, DaemonResponse>>;
	/** The `ping()` result (defaults to true). */
	readonly alive?: boolean;
}

/**
 * Build a recording {@link FakeDaemonClient} (the seam Wave-2 handler tests drive).
 * An unmatched `send` returns a default `200 {}`. Records every call so a test asserts
 * the storage verb dispatched the EXPECTED route/body and nothing opened DeepLake.
 */
export function createFakeDaemonClient(options: FakeDaemonClientOptions = {}): FakeDaemonClient {
	const responses = options.responses ?? {};
	const alive = options.alive ?? true;
	const calls: RecordedDaemonCall[] = [];
	return {
		get calls(): readonly RecordedDaemonCall[] {
			return calls;
		},
		async send(req: DaemonRequest): Promise<DaemonResponse> {
			calls.push({ req });
			const key = `${req.method} ${req.path}`;
			return responses[key] ?? { status: 200, body: {} };
		},
		async ping(): Promise<boolean> {
			return alive;
		},
	};
}

/**
 * The runtime-path the one-shot CLI stamps on a SESSION-group request (PRD-022d / d-AC-2).
 * The CLI is the `legacy` path (the harness hook is `plugin`); the runtime-path middleware
 * accepts either, so a single deterministic value is sufficient for the loopback client.
 */
export const CLI_RUNTIME_PATH = "legacy" as const;

/**
 * The daemon SESSION groups (PRD-004d / 022a): the runtime-path middleware in front of
 * these REQUIRES both `x-honeycomb-runtime-path` AND `x-honeycomb-session`, 400ing a
 * request missing either BEFORE any handler runs. A one-shot CLI has no prior session, so
 * the loopback client stamps a synthetic per-invocation session id for these paths
 * (d-AC-2 / d-AC-3). The root of the dogfood 400 was these headers being absent.
 */
const SESSION_GROUP_PREFIXES = ["/api/memories", "/memory"] as const;

/** True when `path` targets a session group (so the session + runtime-path headers must be stamped). */
export function isSessionGroupPath(path: string): boolean {
	return SESSION_GROUP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
}

/**
 * Mint a stable-per-process synthetic session id for a stateless CLI invocation (d-AC-3).
 * `cli-<pid>-<counter>` — deterministic enough (no `Date.now()`/`Math.random()`), unique
 * per send within a process, and stable across the handful of calls one verb makes. The
 * runtime-path claim service only needs a non-empty key it can claim; this satisfies it
 * without persisting session state the one-shot CLI does not have.
 */
let cliSessionCounter = 0;
export function mintCliSessionId(): string {
	cliSessionCounter += 1;
	return `cli-${process.pid}-${cliSessionCounter}`;
}

/**
 * The real loopback {@link DaemonClient} (FR-3): a thin `fetch` to `127.0.0.1:3850` that stamps
 * the actor/scope headers from the shared credential and parses the JSON body. This is the
 * production seam the bin wires; it carries NO DeepLake path (it dials the daemon). The
 * `headers` (actor/org/workspace from the credential) are injected so the bin assembly supplies
 * them without this module reading the credential file itself. Constructed-and-tested behind the
 * seam; the live bin assembly is deferred (D-7).
 *
 * ── Session-group header stamping (PRD-022d / d-AC-2 / d-AC-3) ────────────────
 * A request to a SESSION group (`/api/memories`, `/memory`) additionally stamps
 * `x-honeycomb-runtime-path` (`legacy`) AND a synthetic per-invocation `x-honeycomb-session`,
 * which the runtime-path middleware REQUIRES. Without them the request 400s at the middleware
 * before reaching the handler — the dogfood-found root cause of `honeycomb recall` returning
 * 400. A non-session path (e.g. `/api/goals`) carries only the tenancy headers, unchanged.
 * The injected `headers` win on conflict, so a caller can override the runtime-path/session
 * (e.g. a test, or a future plugin-path caller).
 */
export function createLoopbackDaemonClient(options: {
	readonly baseUrl?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly fetchImpl?: typeof fetch;
	/** Override the synthetic-session minter (tests). Defaults to {@link mintCliSessionId}. */
	readonly sessionId?: () => string;
} = {}): DaemonClient {
	const baseUrl = options.baseUrl ?? "http://127.0.0.1:3850";
	const headers = options.headers ?? {};
	const doFetch = options.fetchImpl ?? fetch;
	const mintSession = options.sessionId ?? mintCliSessionId;
	return {
		async send(req: DaemonRequest): Promise<DaemonResponse> {
			const qs =
				req.query !== undefined && Object.keys(req.query).length > 0
					? `?${new URLSearchParams(req.query as Record<string, string>).toString()}`
					: "";
			// Session-group requests get the runtime-path + synthetic session header (d-AC-2/3).
			// The injected `headers` are spread LAST so a caller-supplied value wins.
			const sessionHeaders: Record<string, string> = isSessionGroupPath(req.path)
				? { "x-honeycomb-runtime-path": CLI_RUNTIME_PATH, "x-honeycomb-session": mintSession() }
				: {};
			const res = await doFetch(`${baseUrl}${req.path}${qs}`, {
				method: req.method,
				headers: { "content-type": "application/json", ...sessionHeaders, ...headers },
				...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
			});
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				body = undefined;
			}
			return { status: res.status, body };
		},
		async ping(): Promise<boolean> {
			try {
				const res = await doFetch(`${baseUrl}/health`, { method: "GET" });
				return res.ok;
			} catch {
				return false;
			}
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The CommandDispatcher contract (FR-1) — parse + route
// ─────────────────────────────────────────────────────────────────────────────

/** A line-sink so dispatcher/handler output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/** The outcome of a dispatched command: the process exit code. */
export interface CommandResult {
	/** The process exit code (0 = success; usage with no command is 0, FR-1). */
	readonly exitCode: number;
}

/**
 * THE AUTH-PASSTHROUGH SEAM (FR-4 / a-AC-1). `org`/`workspace`/`login`/`logout` are recognized
 * by {@link AUTH_SUBCOMMANDS} and forwarded VERBATIM — the verb word plus its full argv tail —
 * to the existing auth dispatchers (`src/cli/org.ts`, `src/cli/auth.ts`); the unified dispatcher
 * does NOT re-parse their subcommands. The daemon-assembly wiring binds the real
 * `orgMain`/`authMain` (with their `TokenIssuer` seam); a test injects a recording fake to assert
 * the FULL arg array passed through (a-AC-1).
 */
export interface AuthPassthrough {
	/** Forward `[verb, ...tail]` to the auth dispatcher and return the exit code. */
	dispatch(args: readonly string[]): Promise<number>;
}

/**
 * The injectable dependencies the dispatcher + handlers run against (FR-1 / FR-3).
 * Everything is a seam so a Wave-2 test drives the whole surface against fakes (a
 * {@link FakeDaemonClient}, a temp `dir`, a capturing `out`) with no daemon, no real
 * `~/.honeycomb`, and no DeepLake.
 */
export interface CommandDeps {
	/** The daemon seam — the ONLY path to a storage verb (FR-3). */
	readonly daemon: DaemonClient;
	/** Override the credentials/state directory (tests). Defaults to the real home. */
	readonly dir?: string;
	/** The env (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). NEVER receives a bearer token. */
	readonly out?: OutputSink;
	/**
	 * The auth-passthrough seam (FR-4 / a-AC-1). `org`/`workspace`/`login`/`logout` forward their
	 * FULL argv (verb + tail) here. Optional so a plain handler test still type-checks; the
	 * dispatcher requires it for the passthrough verbs and a test injects a recording fake.
	 */
	readonly auth?: AuthPassthrough;
	/**
	 * The daemon process-lifecycle seam (021b b-AC-2 / b-AC-3). Drives `daemon start|stop|status`
	 * and ensure-running-on-demand (a storage verb auto-starts a down daemon). Optional so a plain
	 * handler test still type-checks; the bin assembly binds the real spawn-based impl and a test
	 * injects a recording fake. Typed as `unknown` here to keep `contracts.ts` free of an import
	 * cycle with `daemon.ts`; the dispatcher narrows it to `DaemonLifecycle` at the call site.
	 */
	readonly lifecycle?: unknown;
}

/**
 * THE DISPATCHER CONTRACT (FR-1 / a-AC-1). Parse global flags → resolve the verb →
 * route to its handler (storage → daemon seam; auth → passthrough; local → FS).
 * Wave 1 declares the shape with an honest-stub body; Wave 2 fills the routing table
 * and rewires `src/cli/index.ts` onto {@link dispatch}.
 */
export interface CommandDispatcher {
	/** Parse a raw argv tail into a typed {@link CommandInvocation} (FR-1). */
	parse(argv: readonly string[]): CommandInvocation;
	/** Route a parsed invocation to its handler and return the exit code (FR-1). */
	dispatch(inv: CommandInvocation, deps: CommandDeps): Promise<CommandResult>;
}
