/**
 * The DeepLake billing client + TTL-cached infra read-model — PRD-060c (c-AC-1 .. c-AC-7).
 *
 * This is the cost side of the ROI ledger: a daemon-side, creds-gated, fail-soft client over the REAL
 * `api.deeplake.ai` billing API (spec at `/docs/doc.json`), plus an in-memory TTL cache that the page
 * reads over loopback (060e). It is the SOLE outbound billing egress and the SOLE holder of billing
 * credentials — and it reuses the EXISTING DeepLake auth credential (`~/.deeplake/credentials.json`,
 * via {@link loadDiskCredentials}) rather than minting its own.
 *
 * ── Hardened-fetch posture, mirrored from `deeplake-issuer.ts` (c-AC-3) ──────
 *   - INJECTABLE `fetch` ({@link BillingFetch}) so tests NEVER hit the network — they replay canned
 *     `/billing/*` responses through a fake. The production default is the global `fetch`.
 *   - RETRY on 429 / 5xx with bounded exponential-ish backoff (the same `isRetryable` classification
 *     and `250 * 2**attempt` cadence the issuer uses), capped by {@link DEFAULT_MAX_RETRIES}.
 *   - BOUNDED per-attempt timeout via an injectable {@link Sleeper} + an `AbortController` budget, so a
 *     hung upstream surfaces as `unreachable` rather than wedging the daemon.
 *   - BEARER-TOKEN REDACTION: the token rides ONLY in the `Authorization: Bearer` header, never a URL,
 *     never a log line. The HTTP-error message carries the status + a TRUNCATED body, never the token
 *     (parity with {@link AuthHttpError}). A test asserts the token never appears in emitted logs.
 *
 * ── Fail-soft, never a fabricated value (c-AC-2 / c-AC-7) ────────────────────
 * NONE of the read paths throw and none wedge the daemon. The read-model's `status` discriminant is how
 * 060e distinguishes "billed $0" from "couldn't read billing":
 *   - NO credentials                          → `unauthenticated` (no upstream call is even attempted).
 *   - BOTH endpoints unreachable / 5xx-after-retries → `unreachable`.
 *   - SOME endpoints ok, some failed          → `partial` (available lines populated, missing flagged).
 *   - ALL endpoints ok                        → `ok`.
 * A missing line is `undefined` + named in `missing[]`, NEVER a silent `0`.
 *
 * ── Integer cents end to end (c-AC-6) ────────────────────────────────────────
 * The API returns INTEGER cents; the read-model keeps them integer cents (no float conversion — that is
 * 060e's render edge). The zod schemas coerce defensively with `z.number().int().catch(0)` so a malformed
 * field degrades to `0` cents rather than a `NaN`/float — but the parse of a present endpoint is itemized,
 * and an ABSENT endpoint is flagged `missing`, not zeroed.
 *
 * ── TTL cache (c-AC-4) ───────────────────────────────────────────────────────
 * The read-model is an in-memory TTL cache (NO DeepLake table). A second `read()` within the TTL returns
 * the cached snapshot WITHOUT re-hitting upstream; an expired read re-fetches. The clock is injectable so
 * a test advances time deterministically. A `partial`/`unreachable`/`unauthenticated` result is cached the
 * same as `ok` (the page should not hammer a flapping backend), with the same TTL.
 *
 * ── The `session_type` breakdown (c-AC-5) ────────────────────────────────────
 * `GET /billing/usage/compute` returns GPU sessions broken out by `session_type`
 * (`query` | `embedding` | `ingestion`), each with `gpu_hours` × `price_cents_per_gpu_hour`. This module
 * EXPOSES that breakdown itemized + summable as integer cents; 060d COMPOSES it with the Haiku skillify
 * token cost into the pollination total (this module does not compute the pollination figure).
 *
 * Daemon-side: this module touches the network + reads the credential file via {@link loadDiskCredentials};
 * it opens NO DeepLake connection, so the storage-import invariant holds.
 */

import { z } from "zod";

import {
	type DiskCredentials,
	DEFAULT_DEEPLAKE_API_URL,
	loadDiskCredentials,
} from "../auth/index.js";

// ────────────────────────────────────────────────────────────────────────────
// The injectable seams (fetch / sleep / clock / creds).
// ────────────────────────────────────────────────────────────────────────────

/** The minimal `fetch` response shape the client reads (a subset of the DOM `Response`). */
export interface BillingFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

/** The request init the client passes (method + headers + abort signal). */
export interface BillingFetchRequestInit {
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly signal?: AbortSignal;
}

/** The injectable `fetch` the billing client issues every request through (the network seam). */
export type BillingFetch = (url: string, init?: BillingFetchRequestInit) => Promise<BillingFetchResponse>;

/** A sleeper so the retry backoff is injectable (a test passes a no-wait sleeper). */
export type Sleeper = (ms: number) => Promise<void>;

/** The real wall-clock sleeper. */
export const realSleeper: Sleeper = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** An injectable monotonic clock so the TTL cache is deterministic in tests. Returns epoch ms. */
export interface BillingClock {
	now(): number;
}

/** The default wall-clock implementation (epoch ms). */
export const systemBillingClock: BillingClock = {
	now(): number {
		return Date.now();
	},
};

/**
 * The credential source — defaults to the SHARED `~/.deeplake/credentials.json` via
 * {@link loadDiskCredentials}. A test injects a fake returning a canned record (or `null` for the
 * unauthenticated path) so it never reads the real file. Returning `null` ⇒ `unauthenticated`.
 */
export type BillingCredsSource = () => DiskCredentials | null;

// ────────────────────────────────────────────────────────────────────────────
// Defaults (parity with the issuer's hardened-fetch posture).
// ────────────────────────────────────────────────────────────────────────────

/** Default retry budget on 429 / 5xx — bounded so a flaky backend surfaces rather than hangs (parity). */
export const DEFAULT_MAX_RETRIES = 3;
/** Default per-attempt timeout (ms) — a hung upstream becomes `unreachable`, never a wedge. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Default cache TTL (ms). Billing moves slowly, so a coarse TTL avoids hammering the backend (c-AC-4). */
export const DEFAULT_TTL_MS = 5 * 60_000;

/** The `X-Deeplake-Client` header value — attributes traffic to honeycomb (parity with the issuer). */
export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
/** The org-scoping header DeepLake reads. */
export const DEEPLAKE_ORG_HEADER = "X-Activeloop-Org-Id";
/** The honeycomb client-family value. */
export const DEEPLAKE_CLIENT_VALUE = "honeycomb";

// ────────────────────────────────────────────────────────────────────────────
// The REAL `api.deeplake.ai` billing wire shapes (spec `/docs/doc.json`).
// All money is INTEGER cents; the field names are kept EXACT against the spec.
// ────────────────────────────────────────────────────────────────────────────

/** Integer-cents coercion: a present-but-malformed field degrades to `0` cents, never NaN/float (c-AC-6). */
const centsField = z.number().int().catch(0);
/** A non-negative number field (hours / units) tolerated defensively, integer NOT required (gpu_hours is fractional). */
const numberField = z.number().catch(0);

/** One compute-tier line from `GET /billing/summary` → `compute.by_tier[]`. */
export const ComputeTierSchema = z.object({
	tier: z.string().catch(""),
	hours: numberField,
	cost_cents: centsField,
	unit_price_cents: centsField,
});
export type ComputeTier = z.infer<typeof ComputeTierSchema>;

/** The prior-period comparison block from `GET /billing/summary` → `comparison`. */
export const BillingComparisonSchema = z.object({
	compute_cost_previous: centsField,
	total_cost_previous: centsField,
	delta_pct: numberField,
});
export type BillingComparison = z.infer<typeof BillingComparisonSchema>;

/** The compute block from `GET /billing/summary` → `compute`. */
export const BillingComputeSchema = z.object({
	total_cost_cents: centsField,
	total_pod_hours: numberField,
	by_tier: z.array(ComputeTierSchema).catch([]),
});
export type BillingCompute = z.infer<typeof BillingComputeSchema>;

/** `GET /billing/summary` — compute / storage / transfer totals + projection + prior-period delta. */
export const BillingSummarySchema = z.object({
	balance_cents: centsField,
	period_start: z.string().catch(""),
	period_end: z.string().catch(""),
	total_cost_cents: centsField,
	storage_cost_cents: centsField,
	transfer_cost_cents: centsField,
	projected_end_of_period_cents: centsField,
	compute: BillingComputeSchema,
	comparison: BillingComparisonSchema,
});
export type BillingSummary = z.infer<typeof BillingSummarySchema>;

/** The `session_type` enum DeepLake bills GPU sessions under (c-AC-5). */
export const SESSION_TYPES = ["query", "embedding", "ingestion"] as const;
/** A single GPU `session_type` value. */
export type SessionType = (typeof SESSION_TYPES)[number];
/** The zod enum mirroring {@link SESSION_TYPES}. */
export const SessionTypeSchema = z.enum(SESSION_TYPES);

/** One GPU-session row from `GET /billing/usage/compute` → `sessions[]`. */
export const ComputeSessionSchema = z.object({
	session_type: SessionTypeSchema,
	gpu_hours: numberField,
	gpu_units: numberField,
	price_cents_per_gpu_hour: centsField,
	// Finding (billing-zero): keep `total_cost_cents` OPTIONAL/nullish so a MISSING field (absent on the
	// wire) stays `undefined` and is distinguishable from a legitimate explicit `0` (a free session). The
	// `.catch(undefined)` keeps a present-but-malformed value from throwing while NOT collapsing it to 0
	// -- `buildSessionTypeBreakdown` derives a cost ONLY when the field is truly absent, never over an
	// explicit 0 (which would overwrite a legitimately-free session with gpu_hours x price).
	total_cost_cents: centsField.optional().nullable().catch(undefined),
});
export type ComputeSession = z.infer<typeof ComputeSessionSchema>;

/** `GET /billing/usage/compute` — GPU sessions broken out by `session_type` (the 060d feed). */
export const ComputeUsageSchema = z.object({
	total_cost_cents: centsField,
	total_gpu_hours: numberField,
	sessions: z.array(ComputeSessionSchema).catch([]),
});
export type ComputeUsage = z.infer<typeof ComputeUsageSchema>;

// ────────────────────────────────────────────────────────────────────────────
// The read-model shape (what 060d / 060e consume over loopback).
// ────────────────────────────────────────────────────────────────────────────

/** The status discriminant — how 060e tells "billed $0" from "couldn't read billing" (c-AC-2 / c-AC-7). */
export type BillingStatus = "ok" | "partial" | "unreachable" | "unauthenticated";

/**
 * One `session_type` line in the breakdown (c-AC-5): integer cents, itemized + summable. `cost_cents` is
 * the upstream `total_cost_cents` when present, else `gpu_hours × price_cents_per_gpu_hour` rounded to
 * integer cents (the breakdown is what 060d composes — the math is kept in integer cents, no float leak).
 */
export interface SessionTypeLine {
	readonly session_type: SessionType;
	readonly gpu_hours: number;
	readonly price_cents_per_gpu_hour: number;
	readonly cost_cents: number;
}

/** The infra cost read-model — integer cents throughout, status-discriminated, never a fabricated value. */
export interface InfraCostReadModel {
	/** `ok` | `partial` | `unreachable` | `unauthenticated` (c-AC-2 / c-AC-7). */
	readonly status: BillingStatus;
	/** The endpoints that failed (named so the page flags the missing line, never silently zeros it). */
	readonly missing: readonly string[];
	/** The parsed `GET /billing/summary` (compute/storage/transfer + projection + delta) — absent when missing. */
	readonly summary?: BillingSummary;
	/** The parsed `GET /billing/usage/compute` (GPU sessions by session_type) — absent when missing. */
	readonly compute?: ComputeUsage;
	/** The itemized `session_type` breakdown (c-AC-5), summable to {@link sessionTypeTotalCents}. */
	readonly sessionTypes: readonly SessionTypeLine[];
	/** Epoch-ms the snapshot was assembled (the TTL anchor). */
	readonly fetchedAt: number;
}

/** Sum the `session_type` breakdown lines to integer cents (c-AC-5 summable). */
export function sessionTypeTotalCents(lines: readonly SessionTypeLine[]): number {
	return lines.reduce((sum, line) => sum + line.cost_cents, 0);
}

// ────────────────────────────────────────────────────────────────────────────
// The client (the outbound egress — the SOLE billing caller).
// ────────────────────────────────────────────────────────────────────────────

/** A redacted billing HTTP failure: carries the status + a truncated body, NEVER the token (c-AC-3). */
export class BillingHttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "BillingHttpError";
		this.status = status;
	}
}

/** Options for {@link createInfraCostReadModel} (every seam injectable for tests). */
export interface InfraCostReadModelOptions {
	/** The injectable `fetch` (defaults to the global `fetch`). Tests pass a fake replaying `/billing/*`. */
	readonly fetch?: BillingFetch;
	/** The injectable retry sleeper (defaults to the real wall clock). */
	readonly sleep?: Sleeper;
	/** The injectable cache clock (defaults to wall-clock epoch ms). */
	readonly clock?: BillingClock;
	/** The credential source (defaults to {@link loadDiskCredentials} against the real `~/.deeplake`). */
	readonly creds?: BillingCredsSource;
	/** Override the credentials dir (threaded into the default creds source for temp-HOME tests). */
	readonly dir?: string;
	/** Max retries on 429 / 5xx (defaults to {@link DEFAULT_MAX_RETRIES}). */
	readonly maxRetries?: number;
	/** Per-attempt timeout in ms (defaults to {@link DEFAULT_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
	/** Cache TTL in ms (defaults to {@link DEFAULT_TTL_MS}). */
	readonly ttlMs?: number;
}

/** The public read-model surface 060d/060e consume over loopback. */
export interface InfraCostReadModel_API {
	/**
	 * Read the infra cost snapshot — TTL-cached (c-AC-4). A second call within the TTL returns the cached
	 * snapshot WITHOUT re-hitting upstream; an expired call re-fetches. NEVER throws, NEVER fabricates a
	 * value (c-AC-2 / c-AC-7).
	 */
	read(): Promise<InfraCostReadModel>;
	/** Force-invalidate the cache so the next {@link read} re-fetches (e.g. a manual "refresh" affordance). */
	invalidate(): void;
}

/** True for a status the hardened-fetch posture retries (rate-limit / transient server error — parity). */
function isRetryable(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

/** Build the headers every billing request carries (token in the Authorization header ONLY — c-AC-3). */
function billingHeaders(creds: DiskCredentials): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${creds.token}`,
		"Content-Type": "application/json",
		[DEEPLAKE_CLIENT_HEADER]: DEEPLAKE_CLIENT_VALUE,
	};
	if (creds.orgId.length > 0) headers[DEEPLAKE_ORG_HEADER] = creds.orgId;
	return headers;
}

/** Strip the trailing slash so path concatenation is clean (parity with `resolveApiUrl`). */
function resolveBillingApiUrl(creds: DiskCredentials): string {
	const base = creds.apiUrl !== undefined && creds.apiUrl.length > 0 ? creds.apiUrl : DEFAULT_DEEPLAKE_API_URL;
	return base.replace(/\/+$/, "");
}

/**
 * The `session_type` breakdown (c-AC-5) from a parsed compute-usage payload. Each line carries integer
 * cents: the upstream `total_cost_cents` when present, else `round(gpu_hours × price_cents_per_gpu_hour)`
 * — the derivation stays in integer cents (no float leak past the rounding boundary).
 */
function buildSessionTypeBreakdown(usage: ComputeUsage): SessionTypeLine[] {
	return usage.sessions.map((s) => {
		const derived = Math.round(s.gpu_hours * s.price_cents_per_gpu_hour);
		// Finding (billing-zero): derive `gpu_hours x price` ONLY when the upstream `total_cost_cents` is
		// truly ABSENT (`null`/`undefined`). A present explicit `0` (a legitimately-free session) is
		// PRESERVED verbatim, never recomputed -- the prior `> 0` test collapsed a real 0 into a derived
		// cost and overstated the bill.
		const cost_cents = s.total_cost_cents !== undefined && s.total_cost_cents !== null ? s.total_cost_cents : derived;
		return {
			session_type: s.session_type,
			gpu_hours: s.gpu_hours,
			price_cents_per_gpu_hour: s.price_cents_per_gpu_hour,
			cost_cents,
		};
	});
}

/**
 * Build the creds-gated, fail-soft infra cost read-model (PRD-060c). The returned object is the SOLE
 * billing egress + creds-holder; 060d/060e consume {@link InfraCostReadModel_API.read} over loopback.
 *
 * Every seam (`fetch`/`sleep`/`clock`/`creds`) is injectable; the production defaults are the global
 * `fetch`, the real wall clock, and {@link loadDiskCredentials}. The token NEVER reaches a URL or a log
 * line here (c-AC-3).
 */
export function createInfraCostReadModel(options: InfraCostReadModelOptions = {}): InfraCostReadModel_API {
	const doFetch = options.fetch ?? (globalThis.fetch as unknown as BillingFetch);
	const sleep = options.sleep ?? realSleeper;
	const clock = options.clock ?? systemBillingClock;
	const dir = options.dir;
	const loadCreds: BillingCredsSource = options.creds ?? ((): DiskCredentials | null => loadDiskCredentials(dir));
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

	let cached: InfraCostReadModel | undefined;

	/**
	 * Issue one GET with 429/5xx retry + bounded per-attempt timeout (c-AC-3). Resolves the parsed JSON on
	 * success, or `null` on ANY failure (timeout, non-retryable status, retries exhausted, abort) — the
	 * caller maps `null` to a `missing` line, NEVER a throw (c-AC-2 / c-AC-7). The token rides only in the
	 * header; the (truncated) error body never carries it.
	 */
	async function getJson(apiUrl: string, path: string, headers: Record<string, string>): Promise<unknown> {
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const resp = await doFetch(`${apiUrl}${path}`, { method: "GET", headers, signal: controller.signal });
				if (resp.ok) {
					return await resp.json().catch(() => null);
				}
				if (isRetryable(resp.status) && attempt < maxRetries) {
					clearTimeout(timer);
					// Exponential-ish backoff: 250ms, 500ms, 1000ms — bounded by maxRetries (parity).
					await sleep(250 * 2 ** attempt);
					continue;
				}
				// A non-retryable failure OR retries exhausted → fail-soft `null` (no throw, no fabricated value).
				return null;
			} catch {
				// A network error / timeout-abort: retry while budget remains, else fail-soft `null`.
				if (attempt < maxRetries) {
					clearTimeout(timer);
					await sleep(250 * 2 ** attempt);
					continue;
				}
				return null;
			} finally {
				clearTimeout(timer);
			}
		}
		return null;
	}

	/** Parse a present payload through a schema, or `undefined` when the endpoint failed (`null`). */
	function parseOrMissing<T>(raw: unknown, schema: z.ZodType<T>): T | undefined {
		if (raw === null || raw === undefined) return undefined;
		const result = schema.safeParse(raw);
		return result.success ? result.data : undefined;
	}

	/** Do the two reads, classify the status, build the snapshot. NEVER throws (c-AC-2). */
	async function fetchSnapshot(): Promise<InfraCostReadModel> {
		const creds = loadCreds();
		// No credentials → `unauthenticated`; no upstream call is even attempted (c-AC-2).
		if (creds === null || creds.token.length === 0) {
			return { status: "unauthenticated", missing: [], sessionTypes: [], fetchedAt: clock.now() };
		}

		const apiUrl = resolveBillingApiUrl(creds);
		const headers = billingHeaders(creds);

		const [summaryRaw, computeRaw] = await Promise.all([
			getJson(apiUrl, "/billing/summary", headers),
			getJson(apiUrl, "/billing/usage/compute", headers),
		]);

		const summary = parseOrMissing(summaryRaw, BillingSummarySchema);
		const compute = parseOrMissing(computeRaw, ComputeUsageSchema);

		const missing: string[] = [];
		if (summary === undefined) missing.push("/billing/summary");
		if (compute === undefined) missing.push("/billing/usage/compute");

		// ALL failed → `unreachable`; SOME failed → `partial`; NONE failed → `ok` (c-AC-2 / c-AC-7).
		const okCount = (summary !== undefined ? 1 : 0) + (compute !== undefined ? 1 : 0);
		const status: BillingStatus = okCount === 0 ? "unreachable" : okCount === 2 ? "ok" : "partial";

		const sessionTypes = compute !== undefined ? buildSessionTypeBreakdown(compute) : [];

		return {
			status,
			missing,
			...(summary !== undefined ? { summary } : {}),
			...(compute !== undefined ? { compute } : {}),
			sessionTypes,
			fetchedAt: clock.now(),
		};
	}

	return {
		async read(): Promise<InfraCostReadModel> {
			const now = clock.now();
			// A second read within the TTL returns the cached snapshot WITHOUT re-hitting upstream (c-AC-4).
			if (cached !== undefined && now - cached.fetchedAt < ttlMs) {
				return cached;
			}
			const snapshot = await fetchSnapshot();
			cached = snapshot;
			return snapshot;
		},
		invalidate(): void {
			cached = undefined;
		},
	};
}
