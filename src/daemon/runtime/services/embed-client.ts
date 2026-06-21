/**
 * Embed-client seam — PRD-005a establishes, PRD-005b FILLS (the proven seam pattern).
 *
 * ── WHAT THIS MODULE OWNS (Wave 1 / 005a) ───────────────────────────────────
 * The typed {@link EmbedClient} interface the capture handler calls — WITHOUT
 * awaiting — after it INSERTs a `sessions` row (D-3: embedding is inline-async
 * fire-and-forget). 005a ships a NO-OP default ({@link noopEmbedClient}) so the
 * capture path is complete and green today: the row is written with
 * `message_embedding` NULL and the no-op embed does nothing.
 *
 * ── WHAT 005b FILLS (the Wave-2 contract — READ THIS) ────────────────────────
 * 005b builds the REAL embed client (the nomic-embed-text-v1.5 daemon client,
 * 768-dim, with a timeout) AND the single attach-UPDATE of `message_embedding`
 * on the row id. The seam is shaped so 005b fills it WITHOUT editing the capture
 * handler:
 *
 *   1. Implement {@link EmbedClient}: `embed(text)` returns a `number[]` (768
 *      floats) or `null` (disabled / unreachable / non-768 → leave the column
 *      NULL, b-AC-2 / b-AC-3 / b-AC-5). It MUST resolve quickly or honour its own
 *      timeout — the capture handler does not await it, but 005b owns the attach
 *      that follows, so a hung embed must not leak.
 *   2. Implement {@link EmbeddingAttacher}: given the row id + the freshly-INSERTed
 *      `sessions` row's identity (id, scope) and the computed vector, issue the
 *      SINGLE attach-UPDATE of `message_embedding`. A single non-concurrent attach
 *      UPDATE is safe on DeepLake (D-3); eventual visibility is fine for recall.
 *   3. Provide a factory `createEmbedAttachment(deps)` returning an
 *      {@link EmbedAttachment} (the `{ client, attacher }` pair). The capture
 *      handler takes an injected `EmbedAttachment` (defaulting to
 *      {@link noopEmbedAttachment}); 005b passes the real one at daemon
 *      construction — NO capture-handler edit.
 *
 * The capture handler's call site is already non-blocking: it computes + attaches
 * the embedding in a fire-and-forget continuation that is NEVER awaited before the
 * HTTP response returns (b-AC-4). With the no-op default that continuation is a
 * cheap no-op; with 005b's real attachment it computes the vector and issues the
 * attach-UPDATE off the turn path. A throw anywhere in that continuation is caught
 * and logged, never surfaced to the captured turn (fail-soft — b-AC-3).
 *
 * 005b's tests drive a FAKE embed client (enabled→768 attached; disabled→null;
 * fail→null+logged+capture still succeeds; non-768→rejected→null; non-blocking).
 * The capture handler is verified independently in 005a against the no-op default.
 *
 * ── Enable toggle (PRD-025 D-1: DEFAULT-ON / opt-OUT) ─────────────────────────
 * Embeddings are ENABLED by default for a fresh user. `HONEYCOMB_EMBEDDINGS` is an
 * opt-OUT switch: UNSET or `true`/`1` → ENABLED; an EXPLICIT `false`/`0` → disabled
 * (clean lexical-only). Any other value is treated as the default (enabled) — only a
 * deliberate `false`/`0` turns semantic recall off. This INVERTS the prior 005b
 * default (unset → off); the null-on-failure contract below is unchanged. Mirrors the
 * `HONEYCOMB_*` env convention used by the storage config (`HONEYCOMB_DEEPLAKE_*`).
 *
 * ── Embed daemon URL (005b) ───────────────────────────────────────────────────
 * `HONEYCOMB_EMBED_URL` controls where the embed daemon is reachable (default:
 * `http://127.0.0.1:3851`). The real daemon is PRD-embeddings-runtime; this client
 * sends a POST to `<url>/embed` with `{ text }` and expects `{ vector: number[] }`.
 * On unreachable / non-200 / wrong-dim → null (b-AC-3 / b-AC-5).
 *
 * ── Timeout (005b) ────────────────────────────────────────────────────────────
 * `HONEYCOMB_EMBED_TIMEOUT_MS` controls the per-call timeout (default: 5 000 ms).
 * A timed-out call resolves to null so the attach-UPDATE is skipped.
 */

import { EMBEDDING_DIMS, serializeFloat4Array } from "../../storage/vector.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { sqlIdent, sLiteral } from "../../storage/sql.js";

/** The 768-dim embedding the schema's `message_embedding` FLOAT4[] column holds. */
export const SESSIONS_EMBEDDING_DIMS = 768 as const;

/**
 * Computes an embedding vector for a piece of text (005b fills with the real
 * nomic daemon client). Returns the vector, or `null` when embeddings are
 * disabled, the embed daemon is unreachable, or the returned vector is the wrong
 * dimension — in every `null` case the capture row keeps `message_embedding` NULL
 * and the event stays lexically searchable (b-AC-2 / b-AC-3 / b-AC-5).
 *
 * Implementations MUST NOT throw for the expected failure modes (disabled /
 * unreachable / wrong-dim): they return `null`. The capture handler's
 * fire-and-forget wrapper additionally guards against an unexpected throw.
 */
export interface EmbedClient {
	/** Compute the embedding for `text`, or `null` to leave the column NULL. */
	embed(text: string): Promise<readonly number[] | null>;
}

/** The identity of the freshly-INSERTed `sessions` row an attach targets. */
export interface EmbeddingTarget {
	/** The `sessions.id` of the row the capture handler just INSERTed. */
	readonly id: string;
	/** The resolved `{ org, workspace }` partition the row was written under. */
	readonly scope: QueryScope;
}

/**
 * Attaches a computed embedding to a previously-INSERTed `sessions` row via the
 * SINGLE attach-UPDATE of `message_embedding` (005b fills). A single
 * non-concurrent attach UPDATE is safe on DeepLake (D-3). Resolves when the
 * attach has been issued (or has decided to do nothing); never throws into the
 * capture path.
 */
export interface EmbeddingAttacher {
	/** Issue the single `UPDATE … SET message_embedding = … WHERE id = target.id`. */
	attach(target: EmbeddingTarget, vector: readonly number[]): Promise<void>;
}

/**
 * The `{ client, attacher }` pair the capture handler is injected with. 005b
 * builds the real pair via its `createEmbedAttachment(deps)` factory and passes
 * it at daemon construction; 005a defaults to {@link noopEmbedAttachment}.
 */
export interface EmbedAttachment {
	/** Computes the vector (or `null`). */
	readonly client: EmbedClient;
	/** Issues the single attach-UPDATE of the computed vector. */
	readonly attacher: EmbeddingAttacher;
}

/** The no-op embed client (005a default): never computes a vector. */
export const noopEmbedClient: EmbedClient = {
	async embed(): Promise<readonly number[] | null> {
		return null;
	},
};

/** The no-op attacher (005a default): never issues an attach-UPDATE. */
export const noopEmbeddingAttacher: EmbeddingAttacher = {
	async attach(): Promise<void> {
		/* no-op stub — 005b issues the single attach-UPDATE here */
	},
};

/**
 * The no-op embed attachment the capture handler uses by default (005a). Capture
 * INSERTs the row with `message_embedding` NULL and the fire-and-forget embed
 * continuation does nothing. 005b swaps this for the real `{ client, attacher }`
 * at daemon construction — the capture handler is untouched.
 */
export const noopEmbedAttachment: EmbedAttachment = {
	client: noopEmbedClient,
	attacher: noopEmbeddingAttacher,
};

// ── 005b implementation ────────────────────────────────────────────────────────

/** Default embed daemon base URL (PRD-embeddings-runtime; future build). */
export const DEFAULT_EMBED_URL = "http://127.0.0.1:3851" as const;
/** Default per-call timeout for the embed daemon request. */
export const DEFAULT_EMBED_TIMEOUT_MS = 5_000;

/** Resolved options for {@link createEmbedClient}. */
export interface EmbedClientOptions {
	/** Whether embeddings are enabled; false/absent → always return null (b-AC-2). */
	readonly enabled: boolean;
	/** Base URL of the embed daemon (POST `<url>/embed`). */
	readonly url: string;
	/** Per-call timeout in milliseconds; a timed-out call resolves to null (b-AC-3). */
	readonly timeoutMs: number;
}

/**
 * Resolve {@link EmbedClientOptions} from the environment (PRD-025 D-1: default-on).
 *
 * - `HONEYCOMB_EMBEDDINGS` is opt-OUT: UNSET or `true`/`1` → ENABLED; an EXPLICIT
 *   `false`/`0` → disabled. Any other value falls back to the default (enabled) — only
 *   a deliberate `false`/`0` turns embeddings off (D-1 / AC-1). Whitespace + case are
 *   tolerated (` FALSE ` reads as off) so a sloppy env value still degrades cleanly.
 * - `HONEYCOMB_EMBED_URL` overrides the base URL (default {@link DEFAULT_EMBED_URL}).
 * - `HONEYCOMB_EMBED_TIMEOUT_MS` overrides the timeout (default {@link DEFAULT_EMBED_TIMEOUT_MS}).
 */
export function resolveEmbedClientOptions(env: NodeJS.ProcessEnv = process.env): EmbedClientOptions {
	// D-1: default-on. Only an explicit `false`/`0` disables; unset / anything else → enabled.
	const raw = (env.HONEYCOMB_EMBEDDINGS ?? "").trim().toLowerCase();
	const enabled = !(raw === "false" || raw === "0");
	const url = env.HONEYCOMB_EMBED_URL ?? DEFAULT_EMBED_URL;
	const rawTimeout = Number(env.HONEYCOMB_EMBED_TIMEOUT_MS);
	const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.trunc(rawTimeout) : DEFAULT_EMBED_TIMEOUT_MS;
	return { enabled, url, timeoutMs };
}

/**
 * The embed daemon response shape. The daemon returns `{ vector: number[] }` on
 * success; any other shape or a non-200 status → null (b-AC-3 / b-AC-5).
 */
interface EmbedDaemonResponse {
	readonly vector: number[];
}

/**
 * Narrow an unknown JSON body into an {@link EmbedDaemonResponse}. Returns the typed
 * response only when `vector` is a non-empty array; otherwise null.
 */
function parseEmbedResponse(body: unknown): EmbedDaemonResponse | null {
	if (body === null || typeof body !== "object") return null;
	const candidate = body as Record<string, unknown>;
	if (!Array.isArray(candidate.vector)) return null;
	const vector = candidate.vector as unknown[];
	if (vector.length === 0) return null;
	// Every element must be a finite number; otherwise the vector is malformed.
	for (const v of vector) {
		if (typeof v !== "number" || !Number.isFinite(v)) return null;
	}
	return { vector: vector as number[] };
}

/**
 * A minimal logger the embed client uses to record failures (b-AC-3). Decoupled
 * so the attach UPDATE path can log without depending on the full daemon logger.
 */
export interface EmbedLogger {
	/** Record a structured event (e.g. `embed.failed`, `embed.dim_rejected`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** A no-op logger (default when the daemon does not inject one). */
const silentLogger: EmbedLogger = { event(): void {} };

/**
 * Dependencies for {@link createEmbedAttachment}.
 *
 * `storage` is the DeepLake storage client the attacher issues the single
 * attach-UPDATE through (never a hand-rolled fetch to DeepLake — FR-6 of 002). The
 * scope for the UPDATE is carried per-row via {@link EmbeddingTarget}.
 */
export interface EmbedAttachmentDeps {
	/** The DeepLake storage client. The attacher issues the UPDATE through this. */
	readonly storage: StorageQuery;
	/** Embed-client options (enable toggle, URL, timeout). Defaults to env resolution. */
	readonly options?: EmbedClientOptions;
	/** Optional structured-log sink for embed failures. */
	readonly logger?: EmbedLogger;
}

/**
 * The real `EmbedClient` implementation (005b / b-AC-1..5).
 *
 * - When `enabled` is false → always returns null (b-AC-2).
 * - When the daemon call throws / returns non-200 → logs + returns null (b-AC-3).
 * - When the returned vector is not exactly 768-dim → logs + returns null (b-AC-5).
 * - On success → returns the typed `readonly number[]` vector (b-AC-1).
 */
class DaemonEmbedClient implements EmbedClient {
	constructor(
		private readonly options: EmbedClientOptions,
		private readonly logger: EmbedLogger,
	) {}

	async embed(text: string): Promise<readonly number[] | null> {
		// b-AC-2: disabled → skip entirely, column stays null.
		if (!this.options.enabled) return null;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
		try {
			const res = await fetch(`${this.options.url}/embed`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
				signal: controller.signal,
			});
			if (!res.ok) {
				// b-AC-3: non-200 → log + null.
				this.logger.event("embed.failed", { status: res.status, reason: "non-200 response" });
				return null;
			}
			const body: unknown = await res.json();
			const parsed = parseEmbedResponse(body);
			if (parsed === null) {
				// b-AC-3: malformed response → log + null.
				this.logger.event("embed.failed", { reason: "malformed daemon response" });
				return null;
			}
			// b-AC-5: dim guard — reject non-768 vectors.
			if (parsed.vector.length !== EMBEDDING_DIMS) {
				this.logger.event("embed.dim_rejected", { expected: EMBEDDING_DIMS, actual: parsed.vector.length });
				return null;
			}
			// b-AC-1: success.
			return parsed.vector;
		} catch (err: unknown) {
			// b-AC-3: network error / abort (timeout) → log + null, never throw.
			const reason = err instanceof Error ? err.message : String(err);
			this.logger.event("embed.failed", { reason });
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * The real `EmbeddingAttacher` implementation (005b / b-AC-1).
 *
 * Issues the SINGLE `UPDATE "sessions" SET message_embedding = <vector> WHERE id = <id>`
 * against the injected storage client (FR-2 / D-3). Every value goes through the
 * 002b SQL-safety helpers: the vector literal is the output of `serializeFloat4Array`
 * (a pre-validated numeric fragment, kind `raw`); the row id goes through `sLiteral`
 * (kind `literal`). The `sessions` table identifier goes through `sqlIdent`. This
 * satisfies `audit:sql` (which scans `src/daemon` for raw interpolation).
 *
 * A single attach-UPDATE is safe on DeepLake because it targets an exact row id
 * (no read-modify-write race; the column starts null and is written once). Eventual
 * visibility is acceptable for recall (D-3).
 */
class StorageEmbeddingAttacher implements EmbeddingAttacher {
	constructor(
		private readonly storage: StorageQuery,
		private readonly logger: EmbedLogger,
	) {}

	async attach(target: EmbeddingTarget, vector: readonly number[]): Promise<void> {
		// Validate the dimension one final time before building any SQL (b-AC-5).
		// In production the EmbedClient already guards this, but the Attacher must
		// be independently safe since it accepts any vector passed to it.
		if (vector.length !== EMBEDDING_DIMS) {
			this.logger.event("attach.dim_rejected", { expected: EMBEDDING_DIMS, actual: vector.length });
			return;
		}

		// Build the attach-UPDATE through the SQL-safety helpers (FR-6 / guides/17).
		// serializeFloat4Array produces a `ARRAY[...]::float4[]` numeric fragment —
		// safe to inline directly (it is a computed numeric literal, not user input).
		const tbl = sqlIdent("sessions");
		const col = sqlIdent("message_embedding");
		const idCol = sqlIdent("id");
		const vecLit = serializeFloat4Array(vector);
		const idLit = sLiteral(target.id);
		const sql = `UPDATE "${tbl}" SET ${col} = ${vecLit} WHERE ${idCol} = ${idLit}`;

		const result = await this.storage.query(sql, target.scope);
		if (result.kind !== "ok") {
			// Fail-soft: log the storage failure but do NOT throw back into the capture path.
			this.logger.event("attach.update_failed", { id: target.id, kind: result.kind });
		}
	}
}

/**
 * Factory: build the real `{ client, attacher }` pair (005b / FR-1..8).
 *
 * Pass the returned {@link EmbedAttachment} to `createCaptureHandler` as the
 * `embed` dep at daemon construction — the capture handler is untouched.
 *
 * @example
 * ```ts
 * const embed = createEmbedAttachment({ storage, logger });
 * const captureHandler = createCaptureHandler({ storage, sessionsTarget, queue, embed });
 * ```
 */
export function createEmbedAttachment(deps: EmbedAttachmentDeps): EmbedAttachment {
	const options = deps.options ?? resolveEmbedClientOptions();
	const logger = deps.logger ?? silentLogger;
	return {
		client: new DaemonEmbedClient(options, logger),
		attacher: new StorageEmbeddingAttacher(deps.storage, logger),
	};
}
