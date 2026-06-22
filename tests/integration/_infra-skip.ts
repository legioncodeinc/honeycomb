/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  INFRA-DEGRADED → NEUTRAL run-level signal (PRD-034a, D-2 / FR-4 / a-AC-3). ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The live-integration suite asserts what a REAL user depends on            ║
 * ║  (correctness / tenancy / idempotency / no-data-loss / graceful-degrade),  ║
 * ║  NOT that DeepLake answered fast this minute. But a SUSTAINED backend       ║
 * ║  outage — every attempt a 502/503/504/429/timeout/connection-drop AFTER    ║
 * ║  the storage client's bounded transient-retry has already given up — is    ║
 * ║  not a bug in our code and must NOT red the run. It also must NOT be a      ║
 * ║  silent green: a correctness assertion that never got to run is UNKNOWN,    ║
 * ║  not PASS. The faithful outcome is a NEUTRAL "infra-unavailable" SKIP.      ║
 * ║                                                                            ║
 * ║  This module is the ONE home of that classification + the run-level         ║
 * ║  sentinel the Wave-2 `ci.yaml` job maps to a NEUTRAL conclusion. It reuses  ║
 * ║  the storage layer's EXISTING transient classification (`isTransientResult`)║
 * ║  verbatim — the same 502/503/504/429/timeout/connection set the client's    ║
 * ║  retry already trusts — so "infra-degraded" here means EXACTLY what the     ║
 * ║  storage layer calls transient, never a looser local guess.                 ║
 * ║                                                                            ║
 * ║  ── The contract (quoted verbatim in CONVENTIONS-infra-skip.md) ──          ║
 * ║   • SENTINEL FILE: `<HONEYCOMB_INFRA_SKIP_DIR or ./.infra-skip>/             ║
 * ║       infra-degraded.json` — written the FIRST time a test classifies its   ║
 * ║       run as infra-degraded. Its presence after the run = NEUTRAL.          ║
 * ║   • CONSOLE LINE: a single line beginning `##honeycomb-infra-degraded##`     ║
 * ║       followed by the same JSON, on stdout, for a log-grep fallback.        ║
 * ║   • NO SECRET: the JSON carries only counts + a redacted reason string +    ║
 * ║       the offending statement kind/status — never a token, org, or SQL body.║
 * ║                                                                            ║
 * ║  The directory is gitignored (`.infra-skip/`). Nothing here imports a live  ║
 * ║  credential; the marker is pure run-metadata.                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isTransientResult } from "../../src/daemon/storage/index.js";
import type { QueryResult } from "../../src/daemon/storage/index.js";

/**
 * The directory the run-level sentinel marker is written to. Overridable via
 * `HONEYCOMB_INFRA_SKIP_DIR` so the Wave-2 workflow can point it at a known,
 * uploadable path; defaults to `./.infra-skip` (gitignored). The marker filename
 * is fixed so the workflow reads ONE documented path.
 */
export const INFRA_SKIP_DIR = process.env.HONEYCOMB_INFRA_SKIP_DIR ?? join(process.cwd(), ".infra-skip");

/** The fixed marker filename inside {@link INFRA_SKIP_DIR}. */
export const INFRA_SKIP_FILENAME = "infra-degraded.json";

/** The full documented sentinel path the Wave-2 `ci.yaml` job reads. */
export const INFRA_SKIP_MARKER_PATH = join(INFRA_SKIP_DIR, INFRA_SKIP_FILENAME);

/** The console-line prefix the workflow greps for as a transport-agnostic fallback. */
export const INFRA_SKIP_CONSOLE_PREFIX = "##honeycomb-infra-degraded##";

/**
 * The redaction-safe payload written to the sentinel file + console line. It
 * carries ONLY run-metadata — no token, no org, no SQL body — so the marker is
 * safe to upload as a CI artifact.
 */
export interface InfraDegradedSentinel {
	/** Always `"infra-unavailable"` — the single neutral reason code. */
	readonly outcome: "infra-unavailable";
	/** Which test/operation first classified the run as infra-degraded. */
	readonly firstSeenIn: string;
	/** A short, redacted human reason (statement kind + status, never the SQL). */
	readonly reason: string;
	/** How many transient backend failures were observed across the run so far. */
	readonly transientFailures: number;
	/** ISO timestamp the sentinel was written. */
	readonly at: string;
}

/**
 * Classify ONE storage result as a transient backend flap — the SAME predicate
 * the storage client's retry trusts (`isTransientResult`): a `connection_error`,
 * a `timeout`, or a `query_error` carrying a transient HTTP status
 * (429/500/502/503/504). A non-transient `query_error` (42P01 missing-table, a
 * 400 syntax, a 401/403 permission) is NOT infra-degraded — it is a real defect
 * the suite must still surface as a RED. Re-exported so a test reads "is this an
 * infra flap?" through the one classification, never a hand-rolled status check.
 */
export function isInfraTransient(result: QueryResult): boolean {
	return isTransientResult(result);
}

/**
 * A one-line, secret-free summary of a non-ok result — the statement KIND and the
 * HTTP status only. Never the SQL body, never the message (a backend message can
 * echo an identifier). Used as the sentinel's `reason`.
 */
export function describeTransient(result: QueryResult): string {
	switch (result.kind) {
		case "ok":
			return "ok";
		case "query_error":
			return `query_error status=${result.status ?? "?"}`;
		case "connection_error":
			return "connection_error";
		case "timeout":
			return `timeout(${result.timeoutMs}ms)`;
	}
}

// ── Run-level singleton state (per worker process) ──────────────────────────
//
// Vitest runs the integration files serially (`fileParallelism: false`) but each
// in its own module graph; this counter is per-process. The marker FILE is the
// cross-process source of truth — once ANY worker writes it, the run is degraded.
// The in-process counter just accumulates the count for that worker's writes.

let transientFailureCount = 0;
let sentinelWritten = false;

/** Reset the in-process counter (test-only; the marker file is the real signal). */
export function __resetInfraSkipForTest(): void {
	transientFailureCount = 0;
	sentinelWritten = false;
}

/** How many transient backend failures this worker has recorded so far. */
export function infraTransientCount(): number {
	return transientFailureCount;
}

/**
 * Record one observed transient backend failure (after the client's own retry has
 * already exhausted). Pure accounting — it does NOT itself mark the run degraded;
 * a test decides that via {@link markRunInfraDegraded} once its operation is
 * DOMINATED by transient failures (every attempt flapped), so a single isolated
 * blip never neutralizes a run that could still assert correctness.
 */
export function recordTransientFailure(): void {
	transientFailureCount += 1;
}

/**
 * Write the run-level infra-degraded sentinel (idempotent within a worker): the
 * marker FILE at {@link INFRA_SKIP_MARKER_PATH} + the distinct console LINE the
 * Wave-2 workflow maps to a NEUTRAL conclusion. Carries only redaction-safe
 * run-metadata. Safe to call more than once; only the first write per worker
 * does I/O.
 *
 * A test calls this ONLY when its operation was sustained-transient (the backend
 * is down, not our code), immediately before skipping itself — so the run resolves
 * NEUTRAL, never a false-green correctness pass and never a hard red on our code.
 */
export function markRunInfraDegraded(firstSeenIn: string, reason: string): InfraDegradedSentinel {
	const sentinel: InfraDegradedSentinel = {
		outcome: "infra-unavailable",
		firstSeenIn,
		reason,
		transientFailures: transientFailureCount,
		at: new Date().toISOString(),
	};
	if (!sentinelWritten) {
		sentinelWritten = true;
		try {
			mkdirSync(INFRA_SKIP_DIR, { recursive: true });
			writeFileSync(INFRA_SKIP_MARKER_PATH, `${JSON.stringify(sentinel, null, 2)}\n`);
		} catch {
			// The console line is the fallback signal; never let a marker-write failure
			// throw past this seam and red a run we are trying to neutralize.
		}
	}
	// The distinct console line is emitted EVERY call so it survives even if the
	// file write failed; the workflow greps for the prefix.
	// eslint-disable-next-line no-console
	console.log(`${INFRA_SKIP_CONSOLE_PREFIX} ${JSON.stringify(sentinel)}`);
	return sentinel;
}

/**
 * The guard a live test wraps a critical read/write in: run `op` and, if every
 * attempt flapped transiently (the result is non-ok AND `isInfraTransient`), mark
 * the run infra-degraded and SKIP via the injected `skip` (vitest's `ctx.skip()`),
 * which aborts the test as SKIPPED — not failed. A non-transient failure (real
 * defect) or an ok result is returned to the caller UNCHANGED so the correctness
 * assertions still run with full teeth. This is the ONLY place immediacy yields to
 * the backend: correctness never does.
 *
 * @param label   the test/operation name recorded in the sentinel (no secret).
 * @param op      the storage call producing a {@link QueryResult}.
 * @param skip    vitest's `ctx.skip` (or `skip` from the test signature) — called
 *                with a reason to abort the current test as SKIPPED.
 * @returns       the ok (or non-transient) result; never returns on a transient skip.
 */
export async function neutralizeIfInfraDegraded(
	label: string,
	op: () => Promise<QueryResult>,
	skip: (note?: string) => void,
): Promise<QueryResult> {
	const result = await op();
	if (result.kind !== "ok" && isInfraTransient(result)) {
		recordTransientFailure();
		const reason = describeTransient(result);
		markRunInfraDegraded(label, reason);
		// vitest's ctx.skip() throws to abort the test as SKIPPED (neutral), not failed.
		skip(`infra-unavailable: ${reason}`);
	}
	return result;
}
