/**
 * HoneycombClient core — PRD-019e Wave 2 (the fetch-only typed client).
 *
 * The fetch-only typed client (FR-1 / e-AC-3). It builds a request (URL + actor
 * headers + token), dispatches it through the injectable {@link Fetch} seam, applies
 * the {@link RetryPolicy} split (GET retries on transient failure, mutations do NOT),
 * and maps failures to the typed error model: non-2xx → {@link ApiError}, transport →
 * {@link NetworkError}, budget → {@link TimeoutError}. It opens NO DeepLake and pulls
 * in NO Node-only module — only the standard `fetch`, `AbortController`, and
 * `setTimeout` globals that exist in Node, Bun, AND the browser (D-2 / e-AC-3).
 *
 * The grouped sub-surfaces (`memory`, `hooks`, …) cover the full daemon reach (FR-3);
 * the ergonomic `remember`/`recall` sit at the top level (FR-2). Value-safe secrets
 * (FR-9 / e-AC-6) list NAMES + exec REDACTED output only — there is no value field on
 * the type surface, and the impl never reaches for one.
 */

import {
	ApiError,
	type ConnectorsApi,
	defaultRetryPolicy,
	type DocumentsApi,
	type Fetch,
	type GoalsApi,
	type HealthApi,
	type HooksApi,
	type HoneycombClient,
	type HoneycombClientOptions,
	type HttpMethod,
	type MemoryApi,
	NetworkError,
	type RecallOptions,
	type RecallResult,
	type RememberOptions,
	type RetryPolicy,
	type SecretName,
	type SecretsApi,
	type SkillsApi,
	type SourcesApi,
	TimeoutError,
} from "./contracts.js";

/** The default per-request timeout budget (ms). Per-call override lands via opts. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The sentinel `secrets.exec` returns when the daemon did not attach an explicit
 * `redactedOutput` (FR-9 / e-AC-6). The SDK NEVER promotes a raw `stdout`/`output`
 * field — surfacing this token is fail-closed value-safety, not data loss.
 */
export const SECRET_REDACTED = "[REDACTED]";

/** The loopback hosts the SDK trusts to carry a plaintext bearer token. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when it is safe to attach the bearer token to `baseUrl` (FR-6 / security):
 * the URL is HTTPS (any host, the team/hybrid mode) OR points at a loopback host
 * (the default local-daemon mode). A plaintext `http://` URL to any non-loopback
 * host is UNSAFE — sending the token there would exfiltrate the credential to
 * whoever controls that host. An unparseable URL is treated as unsafe (fail-closed).
 */
export function isTokenTransportSafe(baseUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return false; // unparseable → fail closed, never attach the token.
	}
	if (parsed.protocol === "https:") return true;
	if (parsed.protocol === "http:") return LOOPBACK_HOSTS.has(parsed.hostname);
	return false;
}

/**
 * The actor + runtime-path headers every authenticated call stamps (FR-2 / FR-6).
 * Mirrors the `x-honeycomb-*` header namespace the daemon already speaks
 * (`x-honeycomb-org`, `x-honeycomb-session`, `x-honeycomb-runtime-path`); the SDK is
 * a thin client, so it stamps `plugin` like the MCP server (D-6) — the daemon
 * enforces, the SDK only stamps.
 */
const HEADER_ACTOR = "x-honeycomb-actor";
const HEADER_ACTOR_TYPE = "x-honeycomb-actor-type";
const HEADER_RUNTIME_PATH = "x-honeycomb-runtime-path";

/** One internal request the pipeline dispatches. */
interface SdkRequest {
	readonly method: HttpMethod;
	readonly path: string;
	readonly body?: unknown;
	/** Per-call timeout override (ms); falls back to the client budget. */
	readonly timeoutMs?: number;
}

/**
 * Construct a {@link HoneycombClient} (FR-1 / FR-6). Resolves the seams (fetch,
 * retry, timeout) from the options with sane defaults so the client stays
 * native-dep-free and testable. Every grouped method routes through one private
 * `request` pipeline so the actor/token stamping, the retry split, and the error
 * mapping live in ONE place (no per-method duplication — jscpd-safe).
 */
export function createHoneycombClient(opts: HoneycombClientOptions): HoneycombClient {
	const fetchImpl: Fetch = opts.fetch ?? ((input, init): Promise<Response> => fetch(input, init));
	const retry: RetryPolicy = opts.retry ?? defaultRetryPolicy();
	const clientTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const baseUrl = opts.daemonUrl.replace(/\/+$/, "");
	// Whether it is safe to attach the bearer token to this base URL. The token is a
	// credential; sending it in cleartext to a non-loopback host would exfiltrate it to
	// whoever controls `daemonUrl`. We allow the token ONLY on a loopback daemon (the
	// default local mode) or over HTTPS (the team/hybrid mode) — never on plaintext
	// `http://` to a remote host (SSRF-adjacent credential exposure). FR-6 / security.
	const tokenTransportSafe = isTokenTransportSafe(baseUrl);

	/** Build the headers carried on EVERY call: actor + actorType + runtime-path + token (FR-2 / FR-6). */
	function buildHeaders(hasBody: boolean): Record<string, string> {
		const headers: Record<string, string> = {
			[HEADER_ACTOR]: opts.actor,
			[HEADER_ACTOR_TYPE]: opts.actorType,
			// The SDK is a plugin-path thin client; the daemon enforces, we stamp (D-6).
			[HEADER_RUNTIME_PATH]: "plugin",
		};
		if (hasBody) headers["content-type"] = "application/json";
		// Token rides on Authorization; it is carried, never logged (FR-6 / security).
		// It is attached ONLY when the transport is safe (loopback or HTTPS) so a
		// misconfigured/hostile plaintext-remote `daemonUrl` cannot exfiltrate the
		// credential. A non-loopback plaintext URL gets NO Authorization header.
		if (opts.token !== undefined && opts.token.length > 0 && tokenTransportSafe) {
			headers.authorization = `Bearer ${opts.token}`;
		}
		return headers;
	}

	/**
	 * Dispatch ONE attempt through the fetch seam with a timeout budget. Resolves the
	 * Response, or throws {@link TimeoutError} when the budget elapses, or
	 * {@link NetworkError} on a transport failure (the fetch seam rejecting).
	 */
	async function dispatchOnce(req: SdkRequest, budgetMs: number): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, budgetMs);
		try {
			const init: RequestInit = {
				method: req.method,
				headers: buildHeaders(req.body !== undefined),
				signal: controller.signal,
			};
			if (req.body !== undefined) init.body = JSON.stringify(req.body);
			return await fetchImpl(`${baseUrl}${req.path}`, init);
		} catch (err) {
			// An abort we triggered is a timeout; anything else is a transport failure.
			if (timedOut) {
				throw new TimeoutError(`request to ${req.path} exceeded ${budgetMs}ms`, budgetMs);
			}
			throw new NetworkError(`transport failure calling ${req.path}`, err);
		} finally {
			clearTimeout(timer);
		}
	}

	/** True for a 5xx or 429 — the transient class GET retries on (FR-5). */
	function isTransientStatus(status: number): boolean {
		return status === 429 || (status >= 500 && status <= 599);
	}

	/** Sleep `ms`, used between retry attempts (skipped when 0 so tests stay fast). */
	function sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * The single request pipeline (FR-2 / FR-4 / FR-5 / FR-6). Stamps the headers,
	 * dispatches through the seam, applies the retry split (GET → up to
	 * `retry.maxAttempts("GET")`, mutations → 1), and maps the outcome to the typed
	 * errors. Returns the parsed JSON body on 2xx.
	 *
	 * Retry covers BOTH a transient transport failure ({@link NetworkError}) AND a
	 * transient status (429/5xx) — but ONLY for idempotent GET. A mutation gets ONE
	 * attempt so the SDK never double-applies a non-idempotent write (FR-5).
	 */
	async function request<T>(req: SdkRequest): Promise<T> {
		const budgetMs = req.timeoutMs ?? clientTimeoutMs;
		const maxAttempts = retry.maxAttempts(req.method);
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let res: Response;
			try {
				res = await dispatchOnce(req, budgetMs);
			} catch (err) {
				lastError = err;
				// A TimeoutError is terminal — re-throw it as-is (do not retry past budget).
				if (err instanceof TimeoutError) throw err;
				// NetworkError: retry only if attempts remain (GET). Mutations exit the loop.
				if (attempt < maxAttempts) {
					await sleep(retry.backoffMs(attempt));
					continue;
				}
				throw err;
			}

			if (res.ok) return (await parseBody(res)) as T;

			// Non-2xx. A transient status is retryable for GET; everything else is terminal.
			if (isTransientStatus(res.status) && attempt < maxAttempts) {
				lastError = new ApiError(`daemon returned ${res.status} for ${req.path}`, res.status, await safeBody(res));
				await sleep(retry.backoffMs(attempt));
				continue;
			}
			throw new ApiError(`daemon returned ${res.status} for ${req.path}`, res.status, await safeBody(res));
		}

		// Loop exhausted (only reachable when every attempt was transient).
		if (lastError !== undefined) throw lastError;
		throw new NetworkError(`request to ${req.path} failed after ${maxAttempts} attempts`);
	}

	/** Parse a 2xx body as JSON, tolerating an empty body (returns undefined). */
	async function parseBody(res: Response): Promise<unknown> {
		const text = await res.text();
		if (text.length === 0) return undefined;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	/** Read a non-2xx body for diagnostics without throwing on a bad parse. */
	async function safeBody(res: Response): Promise<unknown> {
		try {
			return await parseBody(res);
		} catch {
			return undefined;
		}
	}

	// ── memory (FR-3) ──────────────────────────────────────────────────────────
	const memory: MemoryApi = {
		async search(query: string, o?: RecallOptions): Promise<readonly RecallResult[]> {
			const body = await request<{ results?: readonly RecallResult[] }>({
				method: "POST",
				path: "/api/memories/search",
				body: { query, limit: o?.limit },
			});
			return body?.results ?? [];
		},
		async store(text: string, o?: RememberOptions): Promise<void> {
			await request<void>({ method: "POST", path: "/api/memories", body: { text, path: o?.path } });
		},
		async get(path: string): Promise<RecallResult | undefined> {
			return await request<RecallResult | undefined>({
				method: "GET",
				path: `/api/memories/${encodeURIComponent(path)}`,
			});
		},
		async list(prefix?: string): Promise<readonly RecallResult[]> {
			const qs = prefix !== undefined ? `?prefix=${encodeURIComponent(prefix)}` : "";
			const body = await request<{ results?: readonly RecallResult[] }>({
				method: "GET",
				path: `/api/memories${qs}`,
			});
			return body?.results ?? [];
		},
	};

	// ── hooks / connectors / documents / sources / skills / goals / health (FR-3) ─
	const hooks: HooksApi = {
		async call(endpoint: string, body: unknown): Promise<unknown> {
			return await request<unknown>({ method: "POST", path: `/api/hooks/${endpoint}`, body });
		},
	};
	const connectors: ConnectorsApi = {
		async list(): Promise<readonly unknown[]> {
			return await listOf("/api/connectors");
		},
	};
	const documents: DocumentsApi = {
		async list(): Promise<readonly unknown[]> {
			return await listOf("/api/documents");
		},
	};
	const sources: SourcesApi = {
		async list(): Promise<readonly unknown[]> {
			return await listOf("/api/sources");
		},
	};
	const skills: SkillsApi = {
		async list(): Promise<readonly unknown[]> {
			return await listOf("/api/skills");
		},
	};
	const goals: GoalsApi = {
		async list(): Promise<readonly unknown[]> {
			return await listOf("/api/goals");
		},
		async add(goal: string): Promise<void> {
			await request<void>({ method: "POST", path: "/api/goals", body: { goal } });
		},
	};
	const health: HealthApi = {
		async check(): Promise<{ readonly ok: boolean }> {
			const body = await request<{ ok?: boolean; status?: string }>({ method: "GET", path: "/health" });
			return { ok: body?.ok === true || body?.status === "ok" };
		},
	};

	/** Shared GET-list helper so the seven list endpoints don't duplicate the shape (jscpd-safe). */
	async function listOf(path: string): Promise<readonly unknown[]> {
		const body = await request<unknown>({ method: "GET", path });
		if (Array.isArray(body)) return body;
		if (body !== null && typeof body === "object") {
			// Tolerate the daemon's `{ <plural>: [...] }` envelopes (e.g. `{ names }`, `{ sources }`).
			const values = Object.values(body as Record<string, unknown>);
			const arr = values.find((v) => Array.isArray(v));
			if (Array.isArray(arr)) return arr;
		}
		return [];
	}

	// ── value-safe secrets (FR-9 / e-AC-6): names + redacted output ONLY ─────────
	const secrets: SecretsApi = {
		async list(prefix?: string): Promise<readonly SecretName[]> {
			// `/api/secrets` returns `{ names: string[] }` — NAMES only, never a value.
			const body = await request<{ names?: readonly string[] }>({ method: "GET", path: "/api/secrets" });
			const names = body?.names ?? [];
			const filtered = prefix !== undefined ? names.filter((n) => n.startsWith(prefix)) : names;
			return filtered.map((name) => ({ name }));
		},
		async exec(command: string): Promise<{ readonly redactedOutput: string }> {
			// `/api/secrets/exec` returns a REDACTED, scope-checked status — never a raw value.
			const body = await request<{ redactedOutput?: string }>({
				method: "POST",
				path: "/api/secrets/exec",
				body: { command },
			});
			// VALUE-SAFE FLOOR (FR-9 / e-AC-6): surface ONLY the explicitly-redacted
			// projection. We never promote a raw `stdout`/`output` field — if the daemon
			// fails to attach `redactedOutput`, the SDK returns the redaction sentinel
			// rather than risk leaking an unredacted value the daemon mistakenly sent.
			const redactedOutput =
				typeof body?.redactedOutput === "string" ? body.redactedOutput : SECRET_REDACTED;
			return { redactedOutput };
		},
	};

	return {
		async remember(text: string, o?: RememberOptions): Promise<void> {
			await memory.store(text, o);
		},
		async recall(query: string, o?: RecallOptions): Promise<readonly RecallResult[]> {
			return await memory.search(query, o);
		},
		memory,
		hooks,
		connectors,
		documents,
		sources,
		skills,
		goals,
		health,
		secrets,
	};
}
