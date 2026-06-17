/**
 * Transport abstraction for DeepLake (PRD-002a, binding decision in the ledger).
 *
 * The client logic — org header, timeout race, result-union, redaction,
 * tracing — is verified against a FAKE in-memory transport, never a live
 * endpoint (no DeepLake credentials in CI). The real transport does the HTTP
 * call; the fake (in `tests/helpers/fake-deeplake.ts`) replays canned
 * responses. Both implement this one interface so the client is identical in
 * test and prod.
 *
 * The transport surface is deliberately thin and raw: it returns rows or
 * throws a typed `TransportError`, and the CLIENT is what maps those into the
 * `QueryResult` union. Keeping classification in the client (not the transport)
 * means the fake only has to throw the right `TransportErrorKind` to exercise
 * every branch — which is exactly what Wave 2 needs to simulate
 * missing-table/column, 402, timeout, and connection-drop cases.
 */

import type { StorageRow } from "./result.js";

/** What kind of failure the transport hit, before client classification. */
export type TransportErrorKind = "query" | "connection" | "timeout";

/**
 * Raw failure raised by a transport. The client maps `kind` onto the
 * `QueryResult` union. `status` carries the HTTP status for query failures
 * (e.g. 402, 404, 500) so heal/billing logic in Wave 2 can branch on it.
 */
export class TransportError extends Error {
	readonly kind: TransportErrorKind;
	readonly status?: number;
	constructor(kind: TransportErrorKind, message: string, status?: number) {
		super(message);
		this.name = "TransportError";
		this.kind = kind;
		if (status !== undefined) this.status = status;
	}
}

/** Per-request context passed to the transport on every query. */
export interface TransportRequest {
	/** The fully-built SQL statement (already escaped by upstream layers). */
	readonly sql: string;
	/** Resolved org sent as a request header so DeepLake enforces tenancy. */
	readonly org: string;
	/** Workspace/partition the statement targets. */
	readonly workspace: string;
	/** Abort signal wired to the client's per-statement timeout. */
	readonly signal: AbortSignal;
}

/**
 * The transport contract. One method: run a statement and return rows, or
 * throw a `TransportError`. No retry, no concurrency control, no result
 * shaping — those belong to the client so the fake transport stays trivial.
 */
export interface DeepLakeTransport {
	query(req: TransportRequest): Promise<StorageRow[]>;
}

/** Header name DeepLake reads to attribute traffic by client family. */
export const DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
/** Header name DeepLake reads to scope a request to an org partition. */
export const DEEPLAKE_ORG_HEADER = "X-Activeloop-Org-Id";

/**
 * Real HTTP transport against the DeepLake SQL endpoint. Daemon-only; this is
 * the single place a network call to DeepLake is issued. It does NOT retry or
 * bound concurrency itself — the client wraps it (Wave 2 adds the
 * Semaphore/retry layer on top per `guides/03-deeplake-sql-api.md`). Here it
 * just issues one request and classifies the wire outcome into a
 * `TransportError` the client can map.
 */
export class HttpDeepLakeTransport implements DeepLakeTransport {
	constructor(
		private readonly endpoint: string,
		private readonly token: string,
	) {}

	async query(req: TransportRequest): Promise<StorageRow[]> {
		let resp: Response;
		try {
			resp = await fetch(`${this.endpoint}/workspaces/${req.workspace}/tables/query`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
					[DEEPLAKE_ORG_HEADER]: req.org,
					[DEEPLAKE_CLIENT_HEADER]: "honeycomb",
				},
				signal: req.signal,
				body: JSON.stringify({ query: req.sql }),
			});
		} catch (e: unknown) {
			// AbortError fires when the client's timeout signal aborts. Map it to
			// the timeout kind so the client emits a timeout result, not a generic
			// connection error.
			if (e instanceof Error && e.name === "AbortError") {
				throw new TransportError("timeout", "request aborted by timeout signal");
			}
			const message = e instanceof Error ? e.message : String(e);
			throw new TransportError("connection", message);
		}
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			throw new TransportError("query", `${resp.status}: ${text.slice(0, 200)}`, resp.status);
		}
		const raw = (await resp.json().catch(() => null)) as { columns?: string[]; rows?: unknown[][] } | null;
		if (!raw?.rows || !raw?.columns) return [];
		const columns = raw.columns;
		return raw.rows.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
	}
}
