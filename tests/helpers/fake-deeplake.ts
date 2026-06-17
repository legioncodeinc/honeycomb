/**
 * Fake in-memory DeepLake transport (PRD-002 test foundation).
 *
 * The binding verification posture (EXECUTION_LEDGER-prd-002.md): there is NO
 * live DeepLake in CI, so the storage client and every Wave-2 layer (escaping
 * 002b, healing 002c, write patterns 002d, vector 002e) are verified against
 * this fake. It implements the same `DeepLakeTransport` interface the real
 * HTTP transport does, so the client under test is byte-identical to prod.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW WAVE 2 USES IT (read this before writing a heal/write/vector test)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Construct one, enqueue what the next call(s) should return/throw, hand it to
 * `createStorageClient({ transport: fake, provider })`, then assert on the
 * client's `QueryResult` and on `fake.requests` (every statement that went out,
 * with its resolved org + workspace).
 *
 *   const fake = new FakeDeepLakeTransport();
 *
 *   // 1. canned success rows for the next query:
 *   fake.enqueueRows([{ id: "a", version: 2 }]);
 *
 *   // 2. a server-side rejection (missing table / column / 402 / syntax):
 *   fake.enqueueQueryError("relation \"memory\" does not exist", 404);
 *   fake.enqueueQueryError("insufficient balance", 402);
 *
 *   // 3. a wire failure (no server response — DNS/TCP/TLS):
 *   fake.enqueueConnectionError("ECONNREFUSED");
 *
 *   // 4. a timeout — slow query that the client's abort signal cancels.
 *   //    `delayMs` is honoured against the injected AbortSignal, so set the
 *   //    client timeout BELOW delayMs to drive a timeout result:
 *   fake.enqueueSlow([{ ok: 1 }], 5_000);   // resolves after 5s OR aborts first
 *
 *   // 5. information_schema rows for a heal introspection SELECT (002c):
 *   fake.enqueueRows([{ column_name: "id" }, { column_name: "version" }]);
 *
 *   // 6. vector scored-ID rows (002e): IDs + normalized scores, no content:
 *   fake.enqueueRows([{ id: "x", score: 0.91 }, { id: "y", score: 0.42 }]);
 *
 * Responses are a FIFO queue: the Nth call consumes the Nth enqueued response.
 * If the queue is empty, the fake throws (test bug — you under-enqueued). To
 * make the fake answer by inspecting the SQL instead of FIFO, pass a
 * `responder` to the constructor (see below) — useful for healing, where one
 * test issues an introspection SELECT then an ALTER then an INSERT and each
 * needs a different answer keyed on the statement.
 *
 * Every issued request is recorded in `fake.requests` so a test can assert the
 * org/workspace scope reached the wire (a-AC-2) and the exact SQL built.
 */

import type { StorageRow } from "../../src/daemon/storage/result.js";
import type { DeepLakeTransport, TransportRequest } from "../../src/daemon/storage/transport.js";
import { TransportError } from "../../src/daemon/storage/transport.js";

/** A recorded request, for post-hoc assertions. */
export interface RecordedRequest {
	readonly sql: string;
	readonly org: string;
	readonly workspace: string;
}

/** A scripted response: rows, a typed error, or a delayed (slow) result. */
type ScriptedResponse =
	| { type: "rows"; rows: StorageRow[] }
	| { type: "error"; error: TransportError }
	| { type: "slow"; rows: StorageRow[]; delayMs: number };

/**
 * A SQL-aware responder. Return the rows for a statement, or throw a
 * `TransportError`. Used instead of the FIFO queue when a test needs the answer
 * to depend on the statement (the heal flow: SELECT → ALTER → retry).
 */
export type Responder = (req: TransportRequest) => StorageRow[] | Promise<StorageRow[]>;

export class FakeDeepLakeTransport implements DeepLakeTransport {
	/** Every statement issued through this transport, in order. */
	readonly requests: RecordedRequest[] = [];
	private readonly queue: ScriptedResponse[] = [];
	private readonly responder?: Responder;

	/**
	 * @param responder optional SQL-aware answer function. When provided, the
	 * FIFO queue is bypassed and this is called for every statement. Throw a
	 * `TransportError` from it to simulate a failure.
	 */
	constructor(responder?: Responder) {
		this.responder = responder;
	}

	/** Enqueue a successful rows response for the next call. */
	enqueueRows(rows: StorageRow[]): this {
		this.queue.push({ type: "rows", rows });
		return this;
	}

	/** Enqueue a server-side rejection (missing table/column, 402, syntax…). */
	enqueueQueryError(message: string, status?: number): this {
		this.queue.push({ type: "error", error: new TransportError("query", message, status) });
		return this;
	}

	/** Enqueue a wire failure with no server response (DNS/TCP/TLS). */
	enqueueConnectionError(message: string): this {
		this.queue.push({ type: "error", error: new TransportError("connection", message) });
		return this;
	}

	/**
	 * Enqueue an explicit transport-level timeout error. Most timeout tests
	 * should prefer `enqueueSlow` (which exercises the client's real abort race);
	 * this exists for the path where the transport itself reports a timeout.
	 */
	enqueueTimeoutError(message = "request timed out"): this {
		this.queue.push({ type: "error", error: new TransportError("timeout", message) });
		return this;
	}

	/**
	 * Enqueue a slow response that resolves after `delayMs` UNLESS the client's
	 * abort signal fires first — in which case it rejects with an abort-shaped
	 * `TransportError("timeout")`, exactly like the real HTTP transport does when
	 * `AbortSignal.timeout` fires. Drive a timeout result by setting the client
	 * timeout below `delayMs`.
	 */
	enqueueSlow(rows: StorageRow[], delayMs: number): this {
		this.queue.push({ type: "slow", rows, delayMs });
		return this;
	}

	async query(req: TransportRequest): Promise<StorageRow[]> {
		this.requests.push({ sql: req.sql, org: req.org, workspace: req.workspace });

		if (this.responder) {
			// Honour an already-aborted signal so responder-mode tests can also
			// drive timeouts if they choose to await.
			if (req.signal.aborted) throw new TransportError("timeout", "aborted");
			return this.responder(req);
		}

		const next = this.queue.shift();
		if (!next) {
			throw new Error(
				"FakeDeepLakeTransport: no scripted response queued for this call " +
					`(sql=${req.sql.slice(0, 80)}). Enqueue one before the call.`,
			);
		}
		if (next.type === "error") throw next.error;
		if (next.type === "rows") return next.rows;
		return this.resolveSlow(next, req.signal);
	}

	/** Race the configured delay against the client's abort signal. */
	private resolveSlow(next: { rows: StorageRow[]; delayMs: number }, signal: AbortSignal): Promise<StorageRow[]> {
		return new Promise<StorageRow[]>((resolve, reject) => {
			if (signal.aborted) {
				reject(new TransportError("timeout", "aborted"));
				return;
			}
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(next.rows);
			}, next.delayMs);
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(new TransportError("timeout", "aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

/**
 * Minimal valid config record for `envCredentialProvider`-style provider seams
 * in tests. Pass to a stub provider so config resolution succeeds without real
 * secrets. Override fields per test (e.g. drop `token` to drive a fail-closed
 * config error).
 */
export function fakeCredentialRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		endpoint: "https://fake.deeplake.test",
		token: "fake-token-abcd",
		org: "fake-org",
		workspace: "fake-ws",
		queryTimeoutMs: 10_000,
		traceSql: false,
		...overrides,
	};
}

/** A `CredentialProvider` returning a fixed record (composes with the above). */
export function stubProvider(record: Record<string, unknown>): { read(): Record<string, unknown> } {
	return { read: () => record };
}
