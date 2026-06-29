/**
 * HiveDoctor health probe (PRD-064a scope + technical considerations).
 *
 * Probes `GET http://127.0.0.1:3850/health` over node:http with a short timeout and
 * classifies the result into one of four kinds so the loop drives the RIGHT rung
 * instead of blindly restarting (064a goal: "targeted, not blind"):
 *
 *   - ok                    - the daemon answered 200 with status `ok`.
 *   - degraded              - the daemon answered but a subsystem is down; carries the
 *                             per-subsystem reasons parsed from src/daemon/runtime/health.ts.
 *   - unreachable-refused   - the connection was refused/reset (daemon is down).
 *   - unreachable-timeout   - the socket accepted but never responded (daemon is wedged).
 *
 * The refused-vs-timeout distinction is load-bearing (064a technical considerations:
 * "treat connection-refused, timeout, and non-200 distinctly - refused vs hung vs
 * degraded drive different rungs"): a refused daemon is simply down (restart), a hung
 * one is wedged (the memory_jobs-backlog failure mode this PRD exists to fix).
 *
 * Built-ins ONLY: node:http (design principle 1; no fetch wrapper, no npm client). The
 * probe NEVER throws - any error resolves to a classification, so the loop can always
 * continue. It parses the structured `{ status, reasons:{ storage, embeddings, schema } }`
 * shape from health.ts defensively: missing/garbage detail still classifies coarsely.
 */

import { request } from "node:http";

/** The per-subsystem reasons mirror of src/daemon/runtime/health.ts `HealthReasons`. */
export interface ProbeHealthReasons {
	/** Storage reachability. */
	readonly storage?: string;
	/** Embed seam state. */
	readonly embeddings?: string;
	/** Schema/required-table presence. */
	readonly schema?: string;
}

/** The four mutually-exclusive classifications a probe resolves to. */
export type HealthClassification =
	| { readonly kind: "ok" }
	| { readonly kind: "degraded"; readonly reasons: ProbeHealthReasons }
	| { readonly kind: "unreachable-refused"; readonly detail: string }
	| { readonly kind: "unreachable-timeout" };

/** Options for {@link probeHealth}. */
export interface ProbeOptions {
	/** The `/health` URL to probe. */
	readonly healthUrl: string;
	/** Per-probe timeout in ms; a wedged socket is classified `unreachable-timeout` after this. */
	readonly timeoutMs: number;
}

/** The raw bytes + status of a `/health` response, before classification. */
interface RawResponse {
	readonly statusCode: number;
	readonly body: string;
}

/**
 * Issue one bounded `GET` over node:http. Resolves to a {@link RawResponse} on a
 * completed response, or rejects with an Error whose `.code`/`.message` lets the
 * classifier tell refused from timed-out. The timeout aborts the request so a
 * never-responding socket can never hang the loop (mirrors restart-helper.ts's
 * POLL_TIMEOUT_MS discipline).
 */
function rawGet(healthUrl: string, timeoutMs: number): Promise<RawResponse> {
	return new Promise<RawResponse>((resolve, reject) => {
		let settled = false;
		const finishErr = (err: Error): void => {
			if (settled) return;
			settled = true;
			reject(err);
		};
		const finishOk = (res: RawResponse): void => {
			if (settled) return;
			settled = true;
			resolve(res);
		};

		const req = request(healthUrl, { method: "GET" }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => {
				// Cap the buffered body so a misbehaving endpoint streaming megabytes can never
				// exhaust memory in the can't-crash process. 64 KiB is far more than /health needs.
				if (chunks.length < 256) chunks.push(chunk);
			});
			res.on("end", () => {
				finishOk({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
			});
			res.on("error", (err) => finishErr(err instanceof Error ? err : new Error("response_error")));
		});

		req.setTimeout(timeoutMs, () => {
			// Tag the abort so the classifier maps it to `unreachable-timeout`, not refused.
			req.destroy(Object.assign(new Error("probe_timeout"), { code: "HIVEDOCTOR_TIMEOUT" }));
		});
		req.on("error", (err) => finishErr(err instanceof Error ? err : new Error("request_error")));
		req.end();
	});
}

/**
 * Parse the structured `/health` body into coarse reasons, defensively. The daemon's
 * health.ts emits `{ status, reasons?: { storage, embeddings, schema } }`; a body that
 * is missing, not JSON, or missing `reasons` yields an empty reasons object (still a
 * valid `degraded` classification - we just have no subsystem detail to target on).
 */
export function parseReasons(body: string): ProbeHealthReasons {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed === null || typeof parsed !== "object") return {};
		const reasons = (parsed as Record<string, unknown>).reasons;
		if (reasons === null || typeof reasons !== "object") return {};
		const r = reasons as Record<string, unknown>;
		const out: ProbeHealthReasons = {
			storage: typeof r.storage === "string" ? r.storage : undefined,
			embeddings: typeof r.embeddings === "string" ? r.embeddings : undefined,
			schema: typeof r.schema === "string" ? r.schema : undefined,
		};
		return out;
	} catch {
		// Non-JSON / unparseable body: no subsystem detail, but the daemon DID answer, so the
		// caller still classifies it `degraded` coarsely rather than unreachable.
		return {};
	}
}

/** True iff the parsed top-level `status` field reads `ok`. */
function isStatusOk(body: string): boolean {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed === null || typeof parsed !== "object") return false;
		return (parsed as Record<string, unknown>).status === "ok";
	} catch {
		return false;
	}
}

/**
 * Probe `/health` once and classify. NEVER throws: a transport error becomes a
 * `unreachable-*` classification, a 200/`ok` becomes `ok`, and any other answered
 * response becomes `degraded` (with whatever reasons the body carried). This total
 * mapping is what lets the watch loop always make a decision and continue.
 */
export async function probeHealth(options: ProbeOptions): Promise<HealthClassification> {
	try {
		const res = await rawGet(options.healthUrl, options.timeoutMs);
		if (res.statusCode === 200 && isStatusOk(res.body)) return { kind: "ok" };
		// Answered but not a clean ok (non-200, or 200 with a non-ok status): degraded, with
		// any per-subsystem reasons the body carried so the loop can target the right rung.
		return { kind: "degraded", reasons: parseReasons(res.body) };
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === "HIVEDOCTOR_TIMEOUT") return { kind: "unreachable-timeout" };
		// Connection refused/reset/DNS - the daemon is genuinely down.
		const detail = error instanceof Error ? (typeof code === "string" ? code : error.message) : "unknown";
		return { kind: "unreachable-refused", detail };
	}
}
