/**
 * Embed daemon entry root — PRD-025 Wave 2 (D-2 / D-3 / D-6).
 *
 * A separate long-lived process that generates 768-dim `nomic-embed-text-v1.5`
 * embedding vectors for the Hivemind daemon over a loopback HTTP/NDJSON-ish IPC
 * (`POST <url>/embed { text } -> { vector }`, `GET <url>/health`). The Hivemind
 * daemon OWNS this process: it spawns, health-checks, and crash-restarts it as a
 * single supervised child (see `src/daemon/runtime/services/embed-supervisor.ts`).
 * This entry is the child the supervisor spawns; it is ALSO independently
 * runnable (`node embeddings/embed-daemon.js`) for the Wave-3 live verification.
 *
 * Build-order tier "plugins/native": it imports only shared constants, never the
 * daemon core or the DeepLake path. The heavy inference stack
 * (`@huggingface/transformers`, an OPTIONAL dependency, ~600 MB with the model)
 * is loaded LAZILY via dynamic `import()` inside {@link warmup} — never at module
 * load — so:
 *   - the esbuild bundle keeps it `external` and a CI install without the optional
 *     dep can still import this module (the supervisor's unit tests drive a FAKE
 *     child and never touch the real model),
 *   - importing this module costs nothing until the daemon actually starts.
 *
 * ── Model + revision pin (D-2 open sub-decision, RESOLVED) ────────────────────
 * The model is `nomic-ai/nomic-embed-text-v1.5` at the q8 (quantized int8) ONNX
 * weights, pinned to a fixed git revision ({@link MODEL_REVISION}) for
 * reproducibility across upgrades. transformers.js downloads + caches the model
 * under {@link modelCacheDir} (`~/.honeycomb/embed-models/` by default, override
 * with `HONEYCOMB_EMBED_CACHE_DIR`) on first warmup; subsequent starts reuse the
 * cached dir with no network. The ~600 MB is ACQUIRED at first run, NEVER packed
 * into the npm tarball (D-2 / AC-7).
 *
 * ── nomic prefix convention ───────────────────────────────────────────────────
 * nomic-embed-text-v1.5 is trained with task prefixes. Stored/recalled documents
 * use `search_document: <text>`; the recall query side is the client's concern,
 * but the daemon defaults to the document prefix so a captured turn and a stored
 * memory embed consistently. The prefix is applied here, transparently to callers.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { HONEYCOMB_VERSION } from "../../src/shared/constants.js";

/** The embedding dimension the schema's `FLOAT4[]` columns hold (PRD-025 AC-6). MUST stay 768. */
export const EMBED_DIMS = 768 as const;

/** The pinned model id (D-2 / out-of-scope to swap — PRD-025). */
export const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5" as const;

/**
 * The pinned model revision (D-2 open sub-decision RESOLVED). A fixed, immutable
 * git COMMIT SHA so the q8 weights are reproducible across `npm i` upgrades — never
 * a moving `main`, and never the model NAME `"v1.5"` (which is NOT a git ref on the
 * HF repo: the files live on `main`, so `revision: "v1.5"` 404s at warmup —
 * `resolve/v1.5/tokenizer.json`). This SHA is the `main` HEAD of
 * `nomic-ai/nomic-embed-text-v1.5` that carries `tokenizer.json`, `config.json`, and
 * `onnx/model_quantized.onnx` (the q8 weights `dtype:"q8"` resolves). Wave-3 live-fix.
 */
export const MODEL_REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab" as const;

/** The quantization the daemon loads (q8 = int8). Footprint/latency floor for CPU inference. */
export const MODEL_QUANTIZATION = "q8" as const;

/** The nomic document-side task prefix applied before embedding (training convention). */
export const DOCUMENT_PREFIX = "search_document: " as const;

/** Default loopback host the embed daemon binds (never a public interface). */
export const EMBED_HOST = "127.0.0.1" as const;
/** Default loopback port the embed daemon binds (matches the client's `DEFAULT_EMBED_URL`). */
export const EMBED_PORT = 3851 as const;

/**
 * Resolve the bind port with the precedence: explicit `override` → a VALID
 * `HONEYCOMB_EMBED_PORT` → `EMBED_PORT`. The env value is only honored when it
 * parses to a finite, in-range port ([0, 65536)); anything else falls back to
 * `EMBED_PORT`: unset (`Number(undefined)` → `NaN`), garbage (`"abc"` → `NaN`),
 * empty (`""`, guarded before `Number` since `Number("")` is `0`), or out of
 * range (`"99999"`).
 *
 * Why this is its own function: `Number(undefined)` is `NaN`, and `??` only
 * coalesces `null`/`undefined` — NOT `NaN`. So `options.port ?? Number(env...) ??
 * EMBED_PORT` yields `NaN` on an unset env, and `server.listen(NaN, …)` throws
 * `options.port should be >= 0 and < 65536`. This guards that footgun and is
 * unit-tested without binding a socket (PRD-025 Wave-3 live-fix).
 */
export function resolveEmbedPort(
	override: number | undefined,
	rawEnvPort: string | undefined,
): number {
	if (override !== undefined) return override;
	// `Number("")` is 0 (a valid port), so guard empty string explicitly first.
	if (rawEnvPort === undefined || rawEnvPort.trim().length === 0) return EMBED_PORT;
	const envPort = Number(rawEnvPort);
	return Number.isInteger(envPort) && envPort >= 0 && envPort < 65536 ? envPort : EMBED_PORT;
}

/** Static description of the embed daemon process. */
export interface EmbedDaemonInfo {
	/** The build version (self-reported, matches the root package). */
	readonly version: string;
	/** The pinned model id. */
	readonly model: string;
	/** The pinned model revision. */
	readonly revision: string;
	/** The embedding dimension. */
	readonly dims: number;
}

/** Return embed-daemon info without starting it (used by `--info` + tests). */
export function embedDaemonInfo(): EmbedDaemonInfo {
	return { version: HONEYCOMB_VERSION, model: MODEL_ID, revision: MODEL_REVISION, dims: EMBED_DIMS };
}

/**
 * Resolve the model cache directory transformers.js downloads + reuses the model
 * under. Defaults to `~/.honeycomb/embed-models/`; `HONEYCOMB_EMBED_CACHE_DIR`
 * overrides it (the documented offline/air-gapped pre-stage points this at a
 * pre-populated dir). Pure — reads env only.
 */
export function modelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.HONEYCOMB_EMBED_CACHE_DIR;
	if (override !== undefined && override.length > 0) return override;
	const home = env.HOME ?? env.USERPROFILE ?? process.cwd();
	return `${home}/.honeycomb/embed-models`;
}

/**
 * The minimal feature-extraction pipeline shape the daemon calls. transformers.js
 * returns this from `pipeline("feature-extraction", ...)`. Typed structurally so
 * this module never needs the optional dep's types at compile time.
 */
type FeatureExtractor = (
	input: string,
	options: { pooling: "mean"; normalize: boolean },
) => Promise<{ readonly data: Float32Array | number[]; readonly dims?: readonly number[] }>;

/** The optional `@huggingface/transformers` module shape {@link warmup} actually uses. */
type TransformersModule = {
	env: { cacheDir?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean };
	pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<FeatureExtractor>;
};

/**
 * Load the optional `@huggingface/transformers` stack. Routed through a variable +
 * `new Function` so the type checker does NOT try to resolve the optional dep at
 * compile time (it is genuinely absent in CI); the import resolves at runtime on the
 * daemon host. A test-only seam ({@link __setTransformersLoaderForTest}) can swap this
 * to drive a rejecting load WITHOUT downloading the ~600 MB model or depending on
 * whether the optional dep happens to be installed.
 */
let loadTransformers: () => Promise<TransformersModule> = async () => {
	const moduleSpecifier = "@huggingface/transformers";
	const dynamicImport = new Function("m", "return import(m);") as (m: string) => Promise<unknown>;
	return (await dynamicImport(moduleSpecifier)) as TransformersModule;
};

/** The lazily-loaded, warmed embedding pipeline (null until {@link warmup} resolves). */
let extractor: FeatureExtractor | null = null;
/** The in-flight warmup promise, so concurrent warmups share one model load. */
let warming: Promise<void> | null = null;

/**
 * Warm the model ONCE (D-3: the first-call load is absorbed here, OFF the turn
 * path — the supervisor calls this in the background right after the child binds).
 * Lazily dynamic-imports the optional `@huggingface/transformers` stack, configures
 * the pinned cache dir + offline-aware env, and builds the q8 feature-extraction
 * pipeline. Idempotent + concurrency-safe: a second call returns the same promise.
 *
 * Throws ONLY when the optional dep is genuinely absent or the model cannot be
 * acquired — the supervisor catches that and keeps recall on the lexical path
 * (D-4), never crashing the host daemon.
 */
export async function warmup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (extractor !== null) return;
	if (warming !== null) return warming;
	warming = (async (): Promise<void> => {
		// Load the optional inference stack ONLY here, never at module load — so a CI
		// install without it can still import this file. Routed through the
		// `loadTransformers` seam (default: a runtime dynamic import the type checker
		// does not resolve at compile time; a test can swap it to fail deterministically).
		const transformers = await loadTransformers();
		// Pin the cache dir so the ~600 MB lands in one reused place (D-2 cached dir).
		transformers.env.cacheDir = modelCacheDir(env);
		// Offline pre-stage (D-2): when `HONEYCOMB_EMBED_OFFLINE` is set, forbid network
		// fetches so an air-gapped host fails loud instead of hanging on a download.
		if ((env.HONEYCOMB_EMBED_OFFLINE ?? "").trim().length > 0) {
			transformers.env.allowRemoteModels = false;
		}
		extractor = await transformers.pipeline("feature-extraction", MODEL_ID, {
			revision: MODEL_REVISION,
			dtype: MODEL_QUANTIZATION,
		});
		// A warm pipeline absorbs the first real call's latency: run one throwaway embed
		// so the very first recall query is fast (D-3 — warmup is not on the turn path).
		await extractor(DOCUMENT_PREFIX + "warmup", { pooling: "mean", normalize: true });
	})();
	try {
		await warming;
	} finally {
		warming = null;
	}
}

/**
 * Compute the 768-dim embedding for `text` (the nomic document prefix is applied).
 * Returns a plain `number[]` of length {@link EMBED_DIMS}, or throws when the model
 * is not warm or the output dimension is wrong (the caller — the HTTP handler —
 * maps a throw to a non-200 so the client leaves the column NULL, AC-6).
 */
export async function embed(text: string, env: NodeJS.ProcessEnv = process.env): Promise<number[]> {
	if (extractor === null) await warmup(env);
	if (extractor === null) throw new Error("embed model not available");
	const out = await extractor(DOCUMENT_PREFIX + text, { pooling: "mean", normalize: true });
	const vector = Array.from(out.data as ArrayLike<number>);
	if (vector.length !== EMBED_DIMS) {
		// AC-6: the dim invariant is the schema lock. A wrong-dim model output is a hard
		// error here so it is never written — the client maps the non-200 to a NULL column.
		throw new Error(`embed dim mismatch: expected ${EMBED_DIMS}, got ${vector.length}`);
	}
	return vector;
}

/** The cap for the surfaced `warmError` reason — short enough for a log line + a /health field. */
export const WARM_ERROR_MAX = 300 as const;

/**
 * Reduce a warmup failure to a short, redacted one-line reason safe to log + expose
 * on `/health` (Wave-3 live-fix: "observable degradation"). The transformers.js
 * errors we care about are model-resolution failures (e.g. a bad revision 404:
 * `Could not locate file: ".../resolve/<rev>/tokenizer.json"`) and the optional-dep
 * absent error — model URLs + error text only. Defensively strips anything that
 * looks like a bearer token / `Authorization:` header / a `token=`/`hf_…` secret in
 * case a future transformers.js error ever embeds one, collapses whitespace, and
 * truncates to {@link WARM_ERROR_MAX} so neither the log nor /health can carry a secret.
 */
export function redactWarmError(err: unknown): string {
	const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "warmup failed";
	const redacted = raw
		// HuggingFace user-access tokens (hf_… ) — never let one ride along in an error.
		.replace(/\bhf_[A-Za-z0-9]+/g, "[redacted]")
		// `Authorization: Bearer …` / `token=…` / `api_key=…` style leaks.
		.replace(/(authorization|bearer|token|api[_-]?key|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		// Collapse newlines/whitespace into a single-line reason.
		.replace(/\s+/g, " ")
		.trim();
	return redacted.length > WARM_ERROR_MAX ? `${redacted.slice(0, WARM_ERROR_MAX - 1)}…` : redacted;
}

/**
 * ISS-007/ISS-008: cap on QUEUED (not-yet-running) /embed requests. Once the FIFO inference
 * queue holds this many waiters, further /embed requests 503 immediately ("embed queue full")
 * instead of piling onto a saturated (or silently degrading) model — the client maps a non-200
 * to a NULL column / lexical recall, so shedding here is safe and bounded by construction.
 */
export const EMBED_QUEUE_MAX = 32 as const;

/**
 * FIFO accounting, split so the admission gate matches the documented contract exactly:
 * `queuedCount` is WAITERS ONLY (admission sheds on it — the cap is on queued, not-yet-running
 * requests), `runningCount` is the at-most-one inference occupying the runtime. `/health`
 * surfaces the TOTAL (queued + running) as `queueDepth` — "work in the daemon" — which is the
 * pre-split meaning its consumers already parse.
 */
let queuedCount = 0;
let runningCount = 0;
/** The FIFO chain serializing inferences (concurrency 1, with an event-loop yield between). */
let inferenceChain: Promise<void> = Promise.resolve();

/**
 * ISS-007/ISS-008 — keep `/health` answerable while inference runs.
 *
 * WHY /health can answer mid-inference: transformers.js dispatches to onnxruntime, whose
 * `session.run` is async — the heavy compute happens on the runtime's own thread pool (node
 * backend) or in awaited WASM slices, so the JS event loop is not held for the whole embed.
 * BUT under load, back-to-back inferences dispatched concurrently can saturate the loop with
 * tensor pre/post-processing and starve a pending `/health` GET for seconds — the live-observed
 * ISS-007 signature (accepts TCP, never replies; the supervisor's probe times out at 2s).
 *
 * The fix is structural, not incidental:
 *   1. `/health` is handled FIRST in the request handler, reads only in-memory flags, and never
 *      enters this queue — it is never behind an inference.
 *   2. /embed requests are SERIALIZED through this FIFO (concurrency 1) instead of all running
 *      concurrently, so at most one inference occupies the runtime at a time.
 *   3. A macrotask YIELD (`setImmediate`) runs before EACH dequeued inference, guaranteeing any
 *      pending `/health` request gets an event-loop turn between inferences.
 *   4. The queue is BOUNDED ({@link EMBED_QUEUE_MAX}): overflow 503s immediately (the client's
 *      NULL-column / lexical fallback), so a wedged or slow model produces fast failures, not an
 *      unbounded pile-up.
 *
 * STRETCH SEAM (deliberately not done here): if a future backend performs truly SYNCHRONOUS
 * single-call inference that blocks the loop for the whole embed, the inside of this function
 * (the `embed(text, env)` call) is the single seam to move onto a `node:worker_threads` Worker —
 * the queue, cap, yield, and /health contract above are already worker-shaped and would not change.
 */
function enqueueEmbed(text: string, env: NodeJS.ProcessEnv): Promise<number[]> | null {
	// Shed on QUEUED waiters only — the documented cap. The running inference does not consume
	// queue capacity (it already left the queue), so effective capacity is exactly
	// EMBED_QUEUE_MAX waiters + 1 running, busy or not.
	if (queuedCount >= EMBED_QUEUE_MAX) return null; // shed: the caller 503s "embed queue full".
	queuedCount += 1;
	const run: Promise<number[]> = inferenceChain.then(async () => {
		// This waiter is now RUNNING, not queued — hand its slot back to the queue.
		queuedCount -= 1;
		runningCount += 1;
		// Yield one macrotask so a queued /health (or any pending accept) answers between inferences.
		await new Promise<void>((r) => setImmediate(r));
		return embed(text, env);
	});
	// The chain must survive a rejected inference (the next waiter still runs) — swallow here only
	// for chaining; the caller still observes the rejection through `run`.
	inferenceChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run.finally(() => {
		runningCount -= 1;
	});
}

/** Read a request body to a string with a hard size cap (defends against a runaway body). */
async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > maxBytes) throw new Error("request body too large");
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Send a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(payload);
}

/** A running embed daemon handle (the supervisor closes it on stop). */
export interface RunningEmbedDaemon {
	/** The resolved bind address. */
	readonly address: { host: string; port: number };
	/** Whether the model has finished warming (the supervisor reports this on /health). */
	ready(): boolean;
	/** Gracefully close the HTTP listener. */
	close(): Promise<void>;
}

/**
 * Start the embed daemon HTTP listener (PRD-025 Wave 2). Binds loopback-only and
 * serves:
 *   - `GET  /health` → `{ ok, ready, warmFailed, warmError, model, revision, dims,
 *     version }` (the supervisor's liveness + warm probe). `warmError` is null until
 *     warmup throws, then a short REDACTED reason (the 404 / missing-dep text) so an
 *     operator/the dashboard sees WHY recall is degraded — NEVER any secret (AC-7).
 *   - `POST /embed`  → `{ vector: number[768] }` on success; a non-200 `{ error }`
 *     when the model is not warm / the dim is wrong (the client maps that to a NULL
 *     column, D-4 / AC-6). The error body carries a redacted reason — never the
 *     input text, never a token.
 *
 * Warmup is kicked OFF the bind path (D-3): the server starts answering /health
 * immediately (with `ready:false`) and the model loads in the background, so the
 * supervisor's spawn returns fast and recall degrades to lexical until warm.
 */
export async function startEmbedDaemon(
	options: { host?: string; port?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunningEmbedDaemon> {
	const env = options.env ?? process.env;
	const host = options.host ?? env.HONEYCOMB_EMBED_HOST ?? EMBED_HOST;
	// Defensive: `options.port` (explicit) wins, then a VALID env port, else EMBED_PORT.
	// Never `Number(env...)` raw here — unset → NaN → `server.listen(NaN)` throws.
	const port = resolveEmbedPort(options.port, env.HONEYCOMB_EMBED_PORT);

	let warmFailed = false;
	// A short, redacted reason WHY warmup failed (Wave-3 live-fix: "observable
	// degradation"). Surfaced on /health so an operator/the dashboard can see the
	// cause without reproducing the model load by hand. NEVER a secret/token — the
	// model id + revision + transformers.js error text only; truncated to a cap.
	let warmError: string | null = null;
	// D-3: warm in the background. A failure leaves `ready:false` + `warmFailed`, so
	// /embed keeps 503-ing and recall stays lexical — the host daemon is never crashed.
	void warmup(env).catch((err: unknown) => {
		warmFailed = true;
		warmError = redactWarmError(err);
		// Surface WHY to stderr (the daemon's own log) — a one-line, redacted reason so
		// the 404/missing-dep/etc. is discoverable from the log, not only via reproduction.
		process.stderr.write(`[honeycomb-embed] warmup failed: ${warmError}\n`);
	});

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async (): Promise<void> => {
			try {
				if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
					// ISS-007: /health is answered FIRST, from in-memory flags only — it never enters the
					// inference queue, so it stays answerable while embeds run (the supervisor's liveness
					// probe depends on exactly this; see the enqueueEmbed doc for the full contract).
					sendJson(res, 200, {
						ok: true,
						ready: extractor !== null,
						warmFailed,
						// The redacted warmup-failure reason (null until/unless warmup throws). No secret.
						warmError,
						// ISS-007 additive load signals (no secret — two numbers/bools): whether an inference
						// is queued/running right now, and how deep the FIFO is. The supervisor treats any
						// 200 as live; these exist for doctor/dashboard glanceability.
						busy: queuedCount + runningCount > 0,
						queueDepth: queuedCount + runningCount,
						...embedDaemonInfo(),
					});
					return;
				}
				if (req.method === "POST" && req.url === "/embed") {
					const raw = await readBody(req);
					let text: unknown;
					try {
						text = (JSON.parse(raw) as { text?: unknown }).text;
					} catch {
						sendJson(res, 400, { error: "malformed request body" });
						return;
					}
					if (typeof text !== "string" || text.length === 0) {
						sendJson(res, 400, { error: "missing or empty text" });
						return;
					}
					if (extractor === null) {
						// Not warm yet (D-3) — the client treats the non-200 as "unavailable" and
						// leaves the column NULL (lexical fallback). The reason is generic (no input).
						sendJson(res, 503, { error: "model not ready" });
						return;
					}
					// ISS-007: route through the BOUNDED serialized inference queue (never a direct
					// concurrent dispatch) so /health stays answerable between inferences and overload
					// sheds fast instead of piling up. A full queue → 503 (the client's NULL-column path).
					const queued = enqueueEmbed(text, env);
					if (queued === null) {
						sendJson(res, 503, { error: "embed queue full" });
						return;
					}
					const vector = await queued;
					sendJson(res, 200, { vector });
					return;
				}
				sendJson(res, 404, { error: "not found" });
			} catch (err: unknown) {
				// Redact: never echo the input text or any token — a generic reason only (AC-7).
				const reason = err instanceof Error ? err.message : "embed failed";
				sendJson(res, 500, { error: reason });
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	// Read the ACTUAL bound port (when `port` was 0, the OS assigned an ephemeral one).
	const bound = server.address();
	const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;

	return {
		address: { host, port: boundPort },
		ready: () => extractor !== null,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

/** Reset the warmed model (test-only seam so a suite can drive warmup deterministically). */
export function __resetForTest(): void {
	extractor = null;
	warming = null;
	loadTransformers = defaultLoadTransformers;
	// ISS-007: reset the inference FIFO so a suite's shed/depth assertions start clean.
	queuedCount = 0;
	runningCount = 0;
	inferenceChain = Promise.resolve();
}

/** The production transformers loader, captured so `__resetForTest` can restore it. */
const defaultLoadTransformers = loadTransformers;

/**
 * Swap the `@huggingface/transformers` loader (test-only seam). A test passes a loader
 * that rejects to drive a warmup failure WITHOUT downloading the ~600 MB model or
 * depending on whether the optional dep is installed. `__resetForTest` restores the
 * real one.
 */
export function __setTransformersLoaderForTest(fake: () => Promise<never>): void {
	loadTransformers = fake as unknown as typeof loadTransformers;
}

/** Inject a fake extractor (test-only seam — drives /embed without the real 600 MB model). */
export function __setExtractorForTest(fake: FeatureExtractor | null): void {
	extractor = fake;
}

/**
 * Whether this module is executed directly as the embed-daemon entry (the bundled
 * `embeddings/embed-daemon.js` the supervisor spawns), vs imported by a test. Only
 * the direct-execution path binds the socket.
 */
function isMainEntry(): boolean {
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry.length === 0) return false;
	try {
		return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith("/embed-daemon.js");
	} catch {
		return false;
	}
}

// Production auto-listen: ONLY when run as the spawned entry, never on import.
if (isMainEntry()) {
	startEmbedDaemon().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[honeycomb-embed] failed to start: ${message}\n`);
		process.exitCode = 1;
	});
}
