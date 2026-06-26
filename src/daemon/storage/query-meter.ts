/**
 * Per-source DeepLake query meter (PRD-062a, L-A1/L-A2).
 *
 * ── Why this exists (measure before you cut) ─────────────────────────────────
 * PRD-062 is a P0 cost incident: DeepLake compute tracks install count, not
 * usage, which is the signature of a fixed per-daemon cost (the idle-poll
 * baseline) that every running install pays at zero user activity. The honesty
 * discipline of that PRD is "measure the blast radius before you design the
 * fix" — so every later sub-PRD states its win as a MEASURED before/after, not
 * a hope. This meter is the measurement: it attributes every DeepLake read/write
 * to a `source` label and counts reads vs writes per source, so the team can
 * state "idle baseline is X reads/min/daemon, of which Y% is polling" as a FACT.
 *
 * ── The single choke point ───────────────────────────────────────────────────
 * Every DeepLake read/write in the whole system flows through one place:
 * `StorageClient.query()` (client.ts), which is the only caller of the
 * transport. This meter is invoked from THERE — one instrumentation point, not
 * N call sites. The `source` is supplied by the caller via the OPTIONAL
 * `QueryOptions.source` field and DEFAULTS to `"other"`, so no existing call
 * site breaks and an un-labeled query is visibly counted as `other` until a
 * later wave threads its own label (lease/reaper/capture/recall are owned by
 * later waves; this sub-PRD only builds the meter + the default wiring).
 *
 * ── Zero added cost in the default mode ──────────────────────────────────────
 * Default posture is LOG + IN-MEMORY ONLY: a metered query does an in-memory
 * `Map` increment and nothing else — it adds ZERO additional DeepLake queries
 * (AC-62a.1.2). The meter is a PURE OBSERVER: it never reorders, batches, or
 * suppresses a query, and a metered query returns a byte-identical result to an
 * unmetered one. Optional persistence to `telemetry_counters` is a separate,
 * later concern gated behind `HONEYCOMB_QUERY_METER_PERSIST` (config.ts) and is
 * NOT implemented here — the flag is read and reserved so the meter never itself
 * becomes a write-cost driver.
 */

/**
 * The closed set of `source` labels a DeepLake operation can be attributed to.
 * These mirror PRD-062's three cost drivers (idle poll, capture write, fan-out
 * + recall amplification) broken into the call sites that issue the queries:
 *
 *   - `poll-lease`       — the job-queue lease/discovery scan (idle baseline).
 *   - `poll-reaper`      — the stale-lease reaper scan (idle baseline).
 *   - `capture-write`    — a captured-event append to `sessions`.
 *   - `fan-out-enqueue`  — a pipeline fan-out enqueue into `memory_jobs`.
 *   - `controlled-write` — a per-fact controlled write to `memory`.
 *   - `recall-arm`       — a recall arm (semantic/lexical) read.
 *   - `embedding`        — an embedding-related query.
 *   - `other`            — the DEFAULT for any un-labeled call site.
 */
export const QUERY_SOURCES = [
	"poll-lease",
	"poll-reaper",
	"capture-write",
	"fan-out-enqueue",
	"controlled-write",
	"recall-arm",
	"embedding",
	"other",
] as const;

/** A `source` label attributing a DeepLake operation to its call site. */
export type QuerySource = (typeof QUERY_SOURCES)[number];

/** The default `source` for a call site that has not yet been labeled. */
export const DEFAULT_QUERY_SOURCE: QuerySource = "other";

/** Read vs write tallies for one `source`. */
export interface SourceCounts {
	/** Count of READ statements (SELECT / read-only WITH) attributed to the source. */
	reads: number;
	/** Count of WRITE statements (INSERT/UPDATE/DELETE/DDL/…) attributed to the source. */
	writes: number;
}

/** An immutable snapshot row: a `source` plus its read/write tallies. */
export interface MeterSnapshotEntry extends SourceCounts {
	readonly source: QuerySource;
}

/**
 * A point-in-time copy of the meter's per-source counts plus the rollup totals.
 * Returned by {@link QueryMeter.snapshot}; safe to log or assert on without
 * holding a reference to the live `Map` (so a later increment cannot mutate a
 * snapshot already taken).
 */
export interface MeterSnapshot {
	/** Per-source entries, in the canonical {@link QUERY_SOURCES} order. */
	readonly perSource: MeterSnapshotEntry[];
	/** Sum of all reads across every source. */
	readonly totalReads: number;
	/** Sum of all writes across every source. */
	readonly totalWrites: number;
}

/**
 * In-memory per-source DeepLake query meter.
 *
 * Construct one per daemon (the storage client holds it). It is a plain counter
 * with no I/O: {@link record} increments, {@link snapshot} reads, {@link reset}
 * zeroes. It issues NO DeepLake query and performs NO persistence in this
 * sub-PRD — persistence is gated behind `HONEYCOMB_QUERY_METER_PERSIST` and left
 * unimplemented (the meter must not itself add write cost).
 */
export class QueryMeter {
	/** `source` → {reads, writes}. Lazily populated on first hit per source. */
	private readonly counts = new Map<QuerySource, SourceCounts>();

	/**
	 * Record ONE metered operation against a `source`.
	 *
	 * @param source the attribution label. Callers that have not threaded a label
	 *   pass nothing and the operation is counted under {@link DEFAULT_QUERY_SOURCE}
	 *   (`"other"`), so it is visibly "unlabeled" rather than dropped.
	 * @param isWrite `true` for a write statement (INSERT/UPDATE/DELETE/DDL),
	 *   `false` for a read (SELECT / read-only WITH). The storage client classifies
	 *   this from the statement shape so the split is consistent with the retry
	 *   layer's read/write tag, not guessed per call site.
	 */
	record(source: QuerySource = DEFAULT_QUERY_SOURCE, isWrite = false): void {
		const entry = this.counts.get(source) ?? { reads: 0, writes: 0 };
		if (isWrite) entry.writes += 1;
		else entry.reads += 1;
		this.counts.set(source, entry);
	}

	/**
	 * Take an immutable snapshot of the current per-source counts and rollup
	 * totals. Sources that have never been hit are omitted from `perSource` (a
	 * zero-traffic source contributes nothing), but the entries that ARE present
	 * are emitted in the canonical {@link QUERY_SOURCES} order for stable output.
	 */
	snapshot(): MeterSnapshot {
		const perSource: MeterSnapshotEntry[] = [];
		let totalReads = 0;
		let totalWrites = 0;
		for (const source of QUERY_SOURCES) {
			const entry = this.counts.get(source);
			if (entry === undefined) continue;
			perSource.push({ source, reads: entry.reads, writes: entry.writes });
			totalReads += entry.reads;
			totalWrites += entry.writes;
		}
		return { perSource, totalReads, totalWrites };
	}

	/**
	 * Reset every counter to zero. Used by the idle-baseline harness to start a
	 * clean measurement window, and available if a future caller flushes the meter
	 * per period.
	 */
	reset(): void {
		this.counts.clear();
	}

	/**
	 * Render the current snapshot as a single structured log line for the periodic
	 * diagnostic surface (AC-62a.1.3). The shape is `key=value` pairs so it greps
	 * cleanly and parses without a schema:
	 *
	 *   [query-meter] total_reads=42 total_writes=7 poll-lease=r:30/w:0 capture-write=r:0/w:5 other=r:12/w:2
	 *
	 * A meter with no traffic yet renders the header with zero totals and no
	 * per-source segments, so an idle window is still an explicit, loggable fact.
	 */
	formatLogLine(): string {
		const snap = this.snapshot();
		const segments = snap.perSource.map((e) => `${e.source}=r:${e.reads}/w:${e.writes}`);
		const header = `[query-meter] total_reads=${snap.totalReads} total_writes=${snap.totalWrites}`;
		return segments.length === 0 ? header : `${header} ${segments.join(" ")}`;
	}
}
