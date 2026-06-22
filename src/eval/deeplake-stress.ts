/**
 * On-demand DeepLake STRESS HARNESS — PRD-034b FR-1/FR-6/FR-7/FR-8 (the load generator).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A deliberate, parameterized DeepLake load generator that keeps the strict,
 * hammering, concurrent patterns the IRL-faithful suite (PRD-034a) sheds — and
 * turns them into a DIAGNOSTIC that EMITS A METRICS REPORT rather than a pass/
 * fail build status. It runs ONLY on demand (`npm run deeplake:stress` + a Wave-2
 * `workflow_dispatch` job), NEVER on push, and NEVER gates. Its purpose is to
 * reproduce the backend's slowness/error behavior on command and produce a clean,
 * reproducible artifact to bring to the DeepLake vendor.
 *
 * Mirrors the `src/eval/` harness shape (PRD-027): this module owns the LIVE
 * orchestration (drive load → record samples → build the report); the pure math
 * lives in `./deeplake-stress-metrics.ts` and is unit-tested with hand-computed
 * fixtures (no live backend). One source of the metric math.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── How RAW per-attempt outcomes are captured (the impl-note headline) ───────
 * Load is driven through the SAME `StorageClient` the product uses (so the
 * measured latency/errors reflect the real code path, INCLUDING the retry layer).
 * But the report must show the backend's TRUE error rate, not just the post-retry
 * success rate. The seam: a {@link RecordingTransport} wraps the real
 * `HttpDeepLakeTransport` and records EVERY round-trip (the client calls the
 * transport once per attempt, so each retry is a separate recorded attempt). The
 * EFFECTIVE (post-retry) rate is then derived from the final attempt of each
 * logical operation. RAW vs EFFECTIVE is the gap the retry layer is hiding.
 *
 * ── Isolation (b-AC-1, do not weaken) ───────────────────────────────────────
 * Every table this run creates is the throwaway `ci_stress_<runId>_<n>` under a
 * namespaced workspace (defaults to `honeycomb_ci`); `runStress` DROPs every
 * table it created on teardown. It never touches a real table.
 *
 * ── No secret in the report (b-AC-7, do not weaken) ─────────────────────────
 * The report carries NO token, endpoint-with-creds, or full org GUID. The org is
 * passed through `redactToken` (the same client redaction) before it lands in the
 * report; the token/endpoint are never read by this module (only the storage
 * layer reads them, from the env, to make the connection).
 */

import { z } from "zod";

import type { DeepLakeTransport, TransportRequest } from "../daemon/storage/transport.js";
import { TransportError } from "../daemon/storage/transport.js";
import type { StorageRow } from "../daemon/storage/result.js";
import { isOk, type QueryResult } from "../daemon/storage/result.js";
import type { QueryScope, StorageClient } from "../daemon/storage/client.js";
import { redactToken } from "../daemon/storage/config.js";
import { sLiteral, sqlIdent } from "../daemon/storage/sql.js";
import type { HealTarget } from "../daemon/storage/heal.js";
import { appendVersionBumped } from "../daemon/storage/writes.js";
import { val } from "../daemon/storage/writes.js";
import { minVersion, readConverged } from "../daemon/storage/converge.js";
import {
	type AttemptSample,
	concurrencyScaling,
	type ConcurrencyScalingRow,
	type ConvergenceSample,
	type ConvergenceSummary,
	type ErrorRateByKind,
	errorRateByKind,
	type LatencyByKind,
	latencyByKind,
	type OutcomeClass,
	type RawVsEffective,
	rawVsEffective,
	type StatementKind,
	summarizeConvergence,
} from "./deeplake-stress-metrics.js";

// ── Dials (FR-6): the parameterized, zod-validated, reproducible config ──────

/** The schema version of the emitted JSON report (Wave 2 keys uploads off this). */
export const STRESS_REPORT_SCHEMA_VERSION = 1 as const;

/**
 * The raw, un-validated config record a caller (the script's CLI/env parse)
 * supplies. Validation is {@link resolveStressConfig}'s job — one zod boundary,
 * coerce-and-clamp so a fat-fingered dial never throws mid-run.
 */
export interface RawStressConfig {
	/** Concurrency levels to sweep (FR-5/FR-6). A CSV like "1,4,8" or an array. */
	readonly concurrency?: unknown;
	/** How many append operations to drive per concurrency level (the table-size dial). */
	readonly operations?: unknown;
	/** How many versions to seed per key before the convergence read (FR-4). */
	readonly versionsPerKey?: unknown;
	/** Fixed seed for reproducibility (FR-6). Any randomness derives from this. */
	readonly seed?: unknown;
}

/** The validated stress config every run honors. */
export interface StressConfig {
	/** The concurrency levels to sweep, ascending + de-duped, each ≥ 1. */
	readonly concurrency: readonly number[];
	/** Append operations per concurrency level (≥ 1). */
	readonly operations: number;
	/** Versions seeded per key before the convergence read (≥ 1). */
	readonly versionsPerKey: number;
	/** The fixed RNG seed (any 32-bit-ish integer). */
	readonly seed: number;
}

/** Sane defaults — a small, fast run that still exercises every pattern. */
export const DEFAULT_STRESS_CONFIG: StressConfig = Object.freeze({
	concurrency: Object.freeze([1, 4, 8]) as readonly number[],
	operations: 20,
	versionsPerKey: 3,
	seed: 1_234,
});

/** Coerce one numeric dial: non-finite → default, then clamp up to `min`, truncated. */
function clampInt(raw: unknown, def: number, min: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return def;
	return Math.max(min, Math.trunc(n));
}

/**
 * Parse the concurrency dial: an array of numbers OR a CSV string ("1,4,8") into
 * an ascending, de-duped list of levels each ≥ 1. A blank/garbage value falls
 * back to the default sweep. Pure.
 */
export function parseConcurrency(raw: unknown, def: readonly number[]): readonly number[] {
	let items: unknown[];
	if (Array.isArray(raw)) items = raw;
	else if (typeof raw === "string") items = raw.split(",");
	else if (typeof raw === "number") items = [raw];
	else return def;
	const levels = items
		// A blank/whitespace item is NOT a level (a bare "" or "1,,2"): `Number("")`
		// is 0 (finite) which would otherwise clamp to 1, so drop empties first.
		.filter((it) => !(typeof it === "string" && it.trim() === ""))
		.map((it) => clampInt(it, Number.NaN, 1))
		.filter((n) => Number.isFinite(n));
	if (levels.length === 0) return def;
	return [...new Set(levels)].sort((a, b) => a - b);
}

/**
 * The zod boundary that validates a {@link RawStressConfig} into a
 * {@link StressConfig} (FR-6). Every dial is coerce-and-clamped so resolution
 * succeeds for nearly any input (a bad dial is tuning noise, never a crash). The
 * seed is required-with-a-default so a run is reproducible by default.
 */
export function resolveStressConfig(raw: RawStressConfig = {}): StressConfig {
	// zod's role here is the shape/default contract; the numeric coercion is the clamp
	// helpers above (zod ^4 preprocess would duplicate them). Keep zod as the gate
	// that the resolved object matches the StressConfig contract.
	const resolved: StressConfig = {
		concurrency: parseConcurrency(raw.concurrency, DEFAULT_STRESS_CONFIG.concurrency),
		operations: clampInt(raw.operations, DEFAULT_STRESS_CONFIG.operations, 1),
		versionsPerKey: clampInt(raw.versionsPerKey, DEFAULT_STRESS_CONFIG.versionsPerKey, 1),
		seed: clampInt(raw.seed, DEFAULT_STRESS_CONFIG.seed, 0),
	};
	return StressConfigSchema.parse(resolved);
}

/** The zod shape the resolved config must satisfy (the contract gate). */
const StressConfigSchema = z.object({
	concurrency: z.array(z.number().int().min(1)).min(1),
	operations: z.number().int().min(1),
	versionsPerKey: z.number().int().min(1),
	seed: z.number().int().min(0),
});

// ── Seeded RNG (FR-6 reproducibility) ───────────────────────────────────────

/**
 * A tiny deterministic PRNG (mulberry32). A fixed seed → the identical sequence,
 * so a run's randomized choices (which key an op targets, the jittered payload
 * size) are reproducible — the vendor can re-run and get the same workload shape.
 * Returns a function yielding floats in [0, 1). Pure given the seed.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── Outcome classification (QueryResult → OutcomeClass) ─────────────────────

/** The transient HTTP statuses that get their own outcome class. */
const STATUS_CLASS: ReadonlyMap<number, OutcomeClass> = new Map([
	[429, "429"],
	[500, "500"],
	[502, "502"],
	[503, "503"],
	[504, "504"],
]);

/**
 * Classify a single transport round-trip outcome into an {@link OutcomeClass}.
 * Success → `ok`; a `TransportError` maps by its kind/status: timeout → `timeout`,
 * connection → `connection`, a query error carries an HTTP status mapped through
 * {@link STATUS_CLASS} (a transient 4xx/5xx) or `other` (a non-transient SQL/logic
 * fault). A non-TransportError throw → `connection` (the conservative class).
 */
export function classifyAttempt(error: unknown): OutcomeClass {
	if (error === undefined || error === null) return "ok";
	if (error instanceof TransportError) {
		if (error.kind === "timeout") return "timeout";
		if (error.kind === "connection") return "connection";
		// query error: map by status, else "other" (non-transient logic fault).
		if (error.status !== undefined) return STATUS_CLASS.get(error.status) ?? "other";
		return "other";
	}
	return "connection";
}

/** Map a built SQL statement to its {@link StatementKind} (the report axis). */
export function kindOfSql(sql: string): StatementKind {
	const head = sql.replace(/^\s+/, "").slice(0, 12).toUpperCase();
	if (head.startsWith("INSERT")) return "insert";
	if (head.startsWith("SELECT")) return "select";
	if (head.startsWith("DELETE")) return "delete";
	if (head.startsWith("UPDATE")) return "update";
	return "other";
}

// ── The recording transport (the RAW-attempt seam) ──────────────────────────

/**
 * A {@link DeepLakeTransport} wrapper that records EVERY round-trip it makes to
 * the inner transport, then re-raises any error unchanged so the client's retry
 * layer behaves identically to production. Because the client invokes the
 * transport once per ATTEMPT, this captures the RAW per-attempt stream (every
 * flap, every retry) the report needs for the backend's true error rate.
 *
 * The recorder is told the CURRENT concurrency level out-of-band (the load
 * generator sets it before each phase) so each attempt is tagged for the
 * error-rate-vs-concurrency table (FR-5) without threading it through every call.
 */
export class RecordingTransport implements DeepLakeTransport {
	/** The RAW attempt stream, in issue order. */
	readonly attempts: AttemptSample[] = [];
	/** The concurrency level tagged onto subsequently-recorded attempts. */
	private concurrency = 1;

	constructor(
		private readonly inner: DeepLakeTransport,
		private readonly clock: () => number = () => Date.now(),
	) {}

	/** Set the concurrency level recorded on subsequent attempts (FR-5). */
	setConcurrency(level: number): void {
		this.concurrency = level;
	}

	async query(req: TransportRequest): Promise<StorageRow[]> {
		const startedAt = this.clock();
		const kind = kindOfSql(req.sql);
		try {
			const rows = await this.inner.query(req);
			this.attempts.push({
				kind,
				outcome: "ok",
				latencyMs: Math.max(0, this.clock() - startedAt),
				isRetry: false, // re-stamped post-hoc per logical operation (see runStress).
				concurrency: this.concurrency,
			});
			return rows;
		} catch (e: unknown) {
			this.attempts.push({
				kind,
				outcome: classifyAttempt(e),
				latencyMs: Math.max(0, this.clock() - startedAt),
				isRetry: false,
				concurrency: this.concurrency,
			});
			throw e;
		}
	}
}

// ── The emitted report SHAPE (verbatim — Wave 2 uploads this) ───────────────

/**
 * The machine-readable JSON report shape (FR-7). This interface is the CONTRACT
 * the Wave-2 `workflow_dispatch` job's `actions/upload-artifact` step uploads —
 * it is intentionally stable + secret-free. `schemaVersion` lets a consumer
 * detect shape changes. NOTHING in this shape carries a token, an endpoint-with-
 * creds, or a full org GUID (b-AC-7): `orgRedacted` is the `redactToken` form.
 */
export interface StressReport {
	/** The report schema version (currently {@link STRESS_REPORT_SCHEMA_VERSION}). */
	readonly schemaVersion: typeof STRESS_REPORT_SCHEMA_VERSION;
	/** ISO-8601 timestamp the run completed. */
	readonly generatedAt: string;
	/** The unique run id (the throwaway-table namespace). */
	readonly runId: string;
	/** The REDACTED org (never the full GUID) — `redactToken(org)`. */
	readonly orgRedacted: string;
	/** The workspace the run targeted (a namespace, not a secret). */
	readonly workspace: string;
	/** The resolved dials this run used (FR-6 — reproducibility evidence). */
	readonly config: StressConfig;
	/** Total transport attempts recorded across the whole run. */
	readonly totalAttempts: number;
	/** Per-statement-kind latency p50/p95/p99/max (+ mean, count) — FR-2. */
	readonly latencyByKind: LatencyByKind;
	/** Error rate by outcome class AND by statement kind — FR-3. */
	readonly errorByKind: ErrorRateByKind;
	/** RAW (every attempt) vs EFFECTIVE (post-retry) error breakdown — FR-3 + impl note. */
	readonly rawVsEffective: RawVsEffective;
	/** Eventual-consistency convergence-time distribution — FR-4 (headline metric). */
	readonly convergence: ConvergenceSummary;
	/** Error rate + throughput + latency vs concurrency — FR-5 (the dial output). */
	readonly concurrencyScaling: readonly ConcurrencyScalingRow[];
	/** Tables this run created + dropped (isolation evidence — b-AC-1). */
	readonly tables: readonly string[];
}

// ── The live run (orchestration) ────────────────────────────────────────────

/** What `runStress` needs: a live client + the resolved scope + dials + a run id. */
export interface RunStressArgs {
	/** The live storage client (built with the {@link RecordingTransport} injected). */
	readonly client: StorageClient;
	/** The recording transport the client was built with (for the raw attempt stream). */
	readonly recorder: RecordingTransport;
	/** The resolved org/workspace scope the run targets. */
	readonly scope: QueryScope & { readonly org: string; readonly workspace: string };
	/** The resolved dials. */
	readonly config: StressConfig;
	/** The unique run id (the throwaway-table namespace). */
	readonly runId: string;
	/** Columns for the throwaway version-bumped table (caller borrows the catalog shape). */
	readonly columns: HealTarget["columns"];
	/** Injectable clock (tests). Defaults to `Date.now`. */
	readonly clock?: () => number;
}

/**
 * Drive the configured load through the live client and build the {@link StressReport}
 * (FR-1). For each concurrency level it runs a bounded-concurrency pool of
 * version-bumped append operations against a per-level throwaway table, samples
 * write→read convergence for a subset of writes, then DROPs every table it made.
 *
 * The RAW attempt stream comes from the injected {@link RecordingTransport}; the
 * EFFECTIVE stream is the last attempt per logical operation (this function marks
 * the final-attempt set after the run). Returns the report; NEVER throws past a
 * teardown failure (a failed DROP is logged via the returned `tables` list, the
 * namespaced prefix keeps a leftover identifiable + harmless).
 */
export async function runStress(args: RunStressArgs): Promise<StressReport> {
	const { client, recorder, scope, config, runId, columns } = args;
	const clock = args.clock ?? (() => Date.now());
	const rng = mulberry32(config.seed);

	const createdTables: string[] = [];
	const convergence: ConvergenceSample[] = [];
	const spansByConcurrency = new Map<number, number>();

	for (const level of config.concurrency) {
		recorder.setConcurrency(level);
		const table = `ci_stress_${runId}_c${level}`;
		const target: HealTarget = { table, columns };
		createdTables.push(table);

		const phaseStart = clock();
		// Build the operation list: each op is a version-bumped append to a key chosen
		// reproducibly from the seeded RNG (so the workload shape is identical per seed).
		const ops = Array.from({ length: config.operations }, (_, i) => i);
		await runBoundedPool(ops, level, async (i) => {
			const key = `${runId}-k${Math.floor(rng() * Math.max(1, Math.floor(config.operations / 2)))}-${i % 4}`;
			await appendVersionBumped(client, target, scope, {
				keyColumn: "id",
				keyValue: key,
				row: [
					["id", val.str(key)],
					["content", val.text(`stress c${level} op${i} seed${config.seed}`)],
				],
			});
		});
		spansByConcurrency.set(level, Math.max(0, clock() - phaseStart));

		// Convergence sampling (FR-4): seed N versions for a fresh key, then time how
		// long a poll-read takes to observe the highest version (write-ok → read-visible).
		await sampleConvergence(client, target, scope, runId, level, config.versionsPerKey, clock, convergence);
	}

	// Teardown: DROP every throwaway table. A failed DROP is best-effort — the
	// namespaced prefix keeps a leftover identifiable; we never throw on teardown.
	for (const table of createdTables) {
		const res = await client.query(`DROP TABLE IF EXISTS "${sqlIdent(table)}"`, scope);
		if (!isOk(res)) {
			process.stderr.write(`[stress-cleanup] could not drop ${table}: ${describeResult(res)}\n`);
		}
	}

	// Mark the EFFECTIVE stream: the FINAL attempt of each contiguous run of attempts
	// for one logical operation. The client issues all attempts for one operation
	// before the next, so a new "operation" starts whenever the previous attempt was
	// an OK or a non-transient terminal — pragmatically, every attempt that is the
	// last of its consecutive retry-group. We approximate the effective set as the
	// terminal attempts: an attempt is terminal iff it is ok OR its outcome is a
	// non-transient class. This is exact for the storage client's retry contract
	// (a transient flap is retried; an ok or a terminal error ends the operation).
	const allAttempts = recorder.attempts;
	const finalAttempts = allAttempts.filter(isTerminalAttempt);

	const report: StressReport = {
		schemaVersion: STRESS_REPORT_SCHEMA_VERSION,
		generatedAt: new Date(clock()).toISOString(),
		runId,
		orgRedacted: redactToken(scope.org),
		workspace: scope.workspace,
		config,
		totalAttempts: allAttempts.length,
		latencyByKind: latencyByKind(allAttempts),
		errorByKind: errorRateByKind(allAttempts),
		rawVsEffective: rawVsEffective(allAttempts, finalAttempts),
		convergence: summarizeConvergence(convergence),
		concurrencyScaling: concurrencyScaling(allAttempts, spansByConcurrency),
		tables: createdTables,
	};
	return report;
}

/**
 * An attempt is TERMINAL (ends its logical operation) iff it succeeded OR its
 * outcome is a non-transient class (`other`). A transient flap (429/5xx/timeout/
 * connection) is followed by a retry, so it is NOT terminal. This mirrors the
 * storage client's retry contract exactly: the EFFECTIVE rate counts only what
 * each operation finally resolved to.
 */
function isTerminalAttempt(a: AttemptSample): boolean {
	return a.outcome === "ok" || a.outcome === "other";
}

/**
 * Seed `versions` version-bumped writes for a fresh key, then poll-read until the
 * highest version is visible, recording the elapsed convergence time (FR-4). If
 * the read never catches up within the budget, a non-converged sample is recorded
 * (never dropped) so the report shows the convergence-FAILURE rate.
 */
async function sampleConvergence(
	client: StorageClient,
	target: HealTarget,
	scope: QueryScope,
	runId: string,
	level: number,
	versions: number,
	clock: () => number,
	out: ConvergenceSample[],
): Promise<void> {
	const key = `${runId}-conv-c${level}`;
	let lastVersion = 0;
	for (let v = 0; v < versions; v++) {
		const w = await appendVersionBumped(client, target, scope, {
			keyColumn: "id",
			keyValue: key,
			row: [
				["id", val.str(key)],
				["content", val.text(`conv c${level} v${v}`)],
			],
		});
		lastVersion = w.version;
	}
	// Time from "write-ok" (now) to the poll-read observing version >= lastVersion.
	const startedAt = clock();
	const sql = `SELECT version FROM "${sqlIdent(target.table)}" WHERE id = ${sLiteral(key)} ORDER BY version DESC LIMIT 1`;
	const res = await readConverged(client, sql, scope, minVersion("version", lastVersion));
	const elapsedMs = Math.max(0, clock() - startedAt);
	const converged = minVersion("version", lastVersion)(res);
	out.push({ elapsedMs, converged });
}

/**
 * A bounded-concurrency pool: run `worker(item)` over `items` with at most
 * `limit` in flight at once (FR-1 concurrent writers). A worker rejection is
 * swallowed at the pool level — the load generator records the failure via the
 * recording transport's attempt stream, so a flap is DATA, not a crash that
 * aborts the run. Returns when every item has been processed.
 */
export async function runBoundedPool<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	const bound = Math.max(1, Math.trunc(limit));
	let next = 0;
	async function pump(): Promise<void> {
		while (next < items.length) {
			const i = next++;
			const item = items[i] as T;
			try {
				await worker(item);
			} catch {
				// A failed operation is recorded in the attempt stream (the report's
				// data); the pool keeps draining so one flap never aborts the sweep.
			}
		}
	}
	const runners = Array.from({ length: Math.min(bound, items.length) }, () => pump());
	await Promise.all(runners);
}

// ── Human summary renderer (FR-7) ───────────────────────────────────────────

/**
 * Render the {@link StressReport} as a human-readable plain-text summary for stdout
 * (FR-7). Pure: takes the report, returns the string (the script writes it). Carries
 * NO secret — it only reads the already-redacted report shape (b-AC-7). Kept here
 * (not in the script) so it is unit-testable and the no-secret property is provable.
 */
export function renderStressSummary(report: StressReport): string {
	const lines: string[] = [];
	const ms = (n: number): string => `${n.toFixed(1)}ms`;
	const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;

	lines.push("DeepLake stress report");
	lines.push("══════════════════════════════════════════════════════════════════");
	lines.push(`run=${report.runId}  org=${report.orgRedacted}  workspace=${report.workspace}`);
	lines.push(`generated=${report.generatedAt}  attempts=${report.totalAttempts}`);
	lines.push(
		`dials: concurrency=[${report.config.concurrency.join(",")}] ops=${report.config.operations} ` +
			`versionsPerKey=${report.config.versionsPerKey} seed=${report.config.seed}`,
	);
	lines.push("");

	lines.push("Latency by statement kind (p50 / p95 / p99 / max, mean, n):");
	for (const kind of Object.keys(report.latencyByKind) as StatementKind[]) {
		const s = report.latencyByKind[kind];
		if (s.count === 0) continue;
		lines.push(
			`  ${kind.padEnd(7)}  ${ms(s.p50Ms)} / ${ms(s.p95Ms)} / ${ms(s.p99Ms)} / ${ms(s.maxMs)}` +
				`   mean ${ms(s.meanMs)}  n=${s.count}`,
		);
	}
	lines.push("");

	lines.push("Error rate (RAW per-attempt vs EFFECTIVE post-retry):");
	lines.push(`  raw       error=${pct(report.rawVsEffective.raw.errorRate)}  (n=${report.rawVsEffective.raw.total})`);
	lines.push(
		`  effective error=${pct(report.rawVsEffective.effective.errorRate)}  (n=${report.rawVsEffective.effective.total})`,
	);
	const rawCounts = report.rawVsEffective.raw.counts;
	const nonOk = (Object.keys(rawCounts) as OutcomeClass[])
		.filter((c) => c !== "ok" && rawCounts[c] > 0)
		.map((c) => `${c}=${rawCounts[c]}`);
	lines.push(`  raw non-ok by class: ${nonOk.length > 0 ? nonOk.join(" ") : "(none)"}`);
	lines.push("");

	lines.push("Eventual-consistency convergence time (write-ok → read-visible):");
	const c = report.convergence;
	lines.push(
		`  samples=${c.count}  converged=${c.convergedCount}  non-convergence=${pct(c.nonConvergenceRate)}`,
	);
	lines.push(`  p50 ${ms(c.latency.p50Ms)} / p95 ${ms(c.latency.p95Ms)} / p99 ${ms(c.latency.p99Ms)} / max ${ms(c.latency.maxMs)}`);
	lines.push("");

	lines.push("Error rate + throughput vs concurrency:");
	for (const row of report.concurrencyScaling) {
		lines.push(
			`  c=${String(row.concurrency).padEnd(3)} error=${pct(row.errorRate).padStart(6)}  ` +
				`tput=${row.throughputOpsPerSec.toFixed(1)} ops/s  p95=${ms(row.latency.p95Ms)}  n=${row.attempts}`,
		);
	}
	return lines.join("\n");
}

/** Summarize a QueryResult for a teardown log WITHOUT leaking secrets. */
function describeResult(res: QueryResult): string {
	switch (res.kind) {
		case "ok":
			return `ok(rows=${res.rows.length})`;
		case "query_error":
			return `query_error(${res.status ?? "?"})`;
		case "connection_error":
			return "connection_error";
		case "timeout":
			return `timeout(${res.timeoutMs}ms)`;
	}
}
