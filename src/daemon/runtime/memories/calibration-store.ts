/**
 * PRD-058e, the calibration-curve store reader (the introspection data source).
 *
 * Reads the LIVE calibration snapshot, the highest-`fit_at` row of
 * `memory_calibration` (`catalog/memory-lifecycle.ts`), and shapes it into the
 * `GET /api/memories/calibration` payload: the curve's held-out `ece` / `brier` /
 * `n_samples` and a reliability-diagram payload (058d). FAIL-SOFT: a missing table
 * (no refit has run yet), an empty table, or any query error yields the
 * COLD-START introspection shape (identity curve, zero metrics, empty diagram),
 * never a throw, so the endpoint always answers honestly that calibration is
 * dormant until the first refit.
 *
 * The reliability diagram is derived from the stored CURVE (the isotonic step
 * function) rather than re-deriving from raw samples (the snapshot stores the
 * fitted curve + aggregate metrics, not the raw `(f,y)` pairs), so the dashboard
 * renders the shape of `g` across the confidence range. When more is needed (the
 * per-bin observed accuracy from the held-out slice) it is a 058d follow-on; this
 * surface is the curve + its committed metrics.
 *
 * All reads go through the injected {@link StorageQuery}; every identifier through
 * `sqlIdent` via the catalog builder. No value is interpolated (the read carries
 * none).
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { buildLatestCalibrationSql, type CalibrationAgentScope } from "../../storage/catalog/memory-lifecycle.js";
import {
	applyCalibration,
	deserializeModel,
	DEFAULT_ECE_BINS,
	IDENTITY_MODEL,
	type CalibrationModel,
	type ReliabilityBin,
} from "./calibration.js";

/** The `GET /api/memories/calibration` introspection payload (PRD-058e API spec). */
export interface CalibrationIntrospection {
	/** The held-out Expected Calibration Error of the live curve (0 when cold-start). */
	readonly ece: number;
	/** The held-out Brier score of the live curve (0 when cold-start). */
	readonly brier: number;
	/** How many resolved `(f,y)` pairs the live curve was fit on (0 when cold-start). */
	readonly nSamples: number;
	/** When the live curve was fit (ISO-8601), or `null` when no curve has been fit yet. */
	readonly fitAt: string | null;
	/** True when the live curve is the dormant identity (`C = f`), no proven calibration yet. */
	readonly identity: boolean;
	/** The reliability-diagram payload derived from the live curve (058d). */
	readonly reliabilityDiagram: ReliabilityBin[];
}

/** The cold-start introspection shape: identity curve, zero metrics, a flat diagram. */
function coldStart(bins: number): CalibrationIntrospection {
	return {
		ece: 0,
		brier: 0,
		nSamples: 0,
		fitAt: null,
		identity: true,
		reliabilityDiagram: curveDiagram(IDENTITY_MODEL, bins),
	};
}

/**
 * Read the live calibration introspection for a scope (PRD-058e). Returns the
 * latest snapshot's metrics + a reliability diagram of its curve, or the
 * cold-start shape when no snapshot exists / any read error (fail-soft). Never
 * throws.
 *
 * `agent` scopes the read to the OWNING agent's calibration slice (D-2): `memory_calibration` is an
 * agent-scoped engine table, so a global "newest snapshot" read could return ANOTHER agent's curve in a
 * multi-agent workspace. ABSENT → the schema defaults (`'default'` / `'global'`), so an un-scoped caller
 * reads one consistent agent slice rather than the whole partition.
 */
export async function readCalibrationIntrospection(
	storage: StorageQuery,
	scope: QueryScope,
	bins: number = DEFAULT_ECE_BINS,
	agent?: CalibrationAgentScope,
): Promise<CalibrationIntrospection> {
	let res: QueryResult;
	try {
		res = await storage.query(buildLatestCalibrationSql(agent), scope);
	} catch {
		return coldStart(bins);
	}
	if (!isOk(res) || res.rows.length === 0) return coldStart(bins);

	const row = res.rows[0] as StorageRow;
	const model = deserializeModel(String(row.model_blob ?? ""));
	return {
		ece: readFloat(row.ece, 0),
		brier: readFloat(row.brier, 0),
		nSamples: readInt(row.n_samples, 0),
		fitAt: row.fit_at === undefined || row.fit_at === null || String(row.fit_at) === "" ? null : String(row.fit_at),
		identity: model.identity,
		reliabilityDiagram: curveDiagram(model, bins),
	};
}

/**
 * Build a reliability-diagram payload from the CURVE alone (PRD-058e): for each
 * bin, the bin's confidence midpoint mapped through `g` is the predicted
 * calibrated confidence. With no raw samples persisted in the snapshot, this
 * renders the SHAPE of `g` (the calibration map) across the range; per-bin
 * observed accuracy is a 058d follow-on with the held-out slice. The identity
 * curve yields the diagonal (predicted == midpoint), the visual "uncalibrated"
 * baseline. Pure.
 */
function curveDiagram(model: CalibrationModel, bins: number): ReliabilityBin[] {
	const m = Math.max(1, Math.trunc(bins));
	const out: ReliabilityBin[] = [];
	for (let b = 0; b < m; b++) {
		const lower = b / m;
		const upper = (b + 1) / m;
		const mid = (lower + upper) / 2;
		out.push({
			lower,
			upper,
			meanConfidence: mid,
			accuracy: applyCalibration(model, mid),
			count: 0, // no raw samples in the snapshot, the curve shape, not the empirical histogram.
		});
	}
	return out;
}

/** Read a stored float cell, defaulting when absent/garbage. */
function readFloat(value: unknown, def: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : def;
}

/** Read a stored count cell into a non-negative integer. */
function readInt(value: unknown, def: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : def;
}
