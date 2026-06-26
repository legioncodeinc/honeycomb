/**
 * Idle-baseline measurement harness (PRD-062a, US-62a.2 / L-A2).
 *
 * ── What this measures ───────────────────────────────────────────────────────
 * PRD-062's prime suspect is the IDLE-POLL BASELINE: a daemon with an empty
 * `memory_jobs` queue and no user activity still issues DeepLake reads forever,
 * because two workers poll the queue and each lease fans into several physical
 * reads. This harness reproduces that shape WITHOUT a live daemon or live
 * DeepLake credentials: it drives a `StorageClient` (over the FAKE in-memory
 * transport this repo already uses in tests) through the query meter and records
 * the per-source read/write counts a fixed "idle window" would produce, so the
 * idle reads/min and the polling share are a MEASURED number, not an inference.
 *
 * ── Why a fake, not a live daemon ────────────────────────────────────────────
 * CI has no DeepLake credentials (the binding-verification posture). The meter
 * is a pure in-memory observer at the single storage choke point, so the count
 * it produces is identical whether the query hit the real endpoint or the fake —
 * the harness therefore proves the meter ATTRIBUTES and COUNTS correctly using
 * the injectable transport, and the smoker fills the live reads/min number into
 * the report scaffold from a real idle daemon run separately.
 *
 * The harness is intentionally tiny and side-effect-free: it takes a metered
 * client, a description of the queries an idle window issues (how many lease and
 * reaper reads per tick, how many ticks), runs them through the real
 * `query()`/meter path, and returns the meter snapshot plus a derived
 * reads/min figure. No timers, no sleeps — the window duration is a parameter so
 * the test is deterministic and instant.
 */

import type { StorageClient } from "../../src/daemon/storage/client.js";
import type { MeterSnapshot, QuerySource } from "../../src/daemon/storage/query-meter.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";

/** One kind of query an idle window issues, and how many of it per tick. */
export interface IdleQuerySpec {
	/** The attribution label this query carries. */
	readonly source: QuerySource;
	/** A representative SQL statement (drives the read/write classification). */
	readonly sql: string;
	/** How many of this query the window issues per tick. */
	readonly perTick: number;
}

/** Inputs describing the idle window to replay. */
export interface IdleBaselineRun {
	/** The metered storage client to drive (over a fake transport in tests). */
	readonly client: StorageClient;
	/** The org/workspace scope every query carries. */
	readonly scope: QueryScope;
	/** The queries an idle daemon issues per poll tick. */
	readonly perTick: IdleQuerySpec[];
	/** How many poll ticks the window covers. */
	readonly ticks: number;
	/** The wall-clock duration the `ticks` represent, in seconds (for reads/min). */
	readonly windowSeconds: number;
}

/** The measured baseline a window produced. */
export interface IdleBaselineResult {
	/** The meter's per-source snapshot at window close. */
	readonly snapshot: MeterSnapshot;
	/** Total DeepLake reads observed in the window. */
	readonly totalReads: number;
	/** Reads per minute, extrapolated from `totalReads` over `windowSeconds`. */
	readonly readsPerMinute: number;
	/** Share of reads attributable to polling (`poll-lease` + `poll-reaper`), 0..1. */
	readonly pollingShare: number;
}

/** The two `source` labels that make up the idle-poll baseline. */
const POLL_SOURCES: ReadonlySet<QuerySource> = new Set<QuerySource>(["poll-lease", "poll-reaper"]);

/**
 * Replay an idle window through the metered client and return the measured
 * baseline. Every query goes through the real `StorageClient.query()` path, so
 * the meter counts exactly what a live idle daemon would; the only difference is
 * the transport is a fake whose responses the caller has scripted.
 *
 * The caller is responsible for enqueuing enough fake responses (one per query
 * issued = `ticks * sum(perTick)`); the harness does not touch the transport.
 */
export async function runIdleBaseline(run: IdleBaselineRun): Promise<IdleBaselineResult> {
	for (let tick = 0; tick < run.ticks; tick++) {
		for (const spec of run.perTick) {
			for (let i = 0; i < spec.perTick; i++) {
				await run.client.query(spec.sql, run.scope, { source: spec.source });
			}
		}
	}

	const snapshot = run.client.meterSnapshot();
	const totalReads = snapshot.totalReads;
	const pollingReads = snapshot.perSource
		.filter((e) => POLL_SOURCES.has(e.source))
		.reduce((sum, e) => sum + e.reads, 0);
	const readsPerMinute = run.windowSeconds > 0 ? (totalReads / run.windowSeconds) * 60 : 0;
	const pollingShare = totalReads > 0 ? pollingReads / totalReads : 0;

	return { snapshot, totalReads, readsPerMinute, pollingShare };
}
