/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-058e — the calibration refit TRIGGER route (L-W9).
 *
 * Wave 1 shipped `fitIsotonic`, `shouldAdoptRefit`, `serializeModel` (the calibration math) with ZERO
 * production callers. This module IS the production caller: a daemon route that reads resolved
 * outcomes from `memory_conflicts` (the winner vs loser confidence → `(f, y)` pairs), fits a fresh
 * calibration curve, ADOPTS it only when it beats the prior on held-out ECE (AC-55e.2.1), and writes
 * the curve to `memory_calibration` via the existing append-only store. It mirrors {@link mountCompactApi}
 * (PRD-030) for the route shape: `POST /api/diagnostics/calibrate` onto the already-mounted, protected
 * `/api/diagnostics` group, ZERO `server.ts` edits.
 *
 * ── The (f, y) pairs (PRD-058e Calibration) ──────────────────────────────────
 * A `supersede` verdict in `memory_conflicts` is the clean ground-truth signal: the winner's raw
 * confidence `f` is evidence it was right (`y = 1`); the loser's `f` is evidence it was wrong
 * (`y = 0`). The two `f`s come from the `memories` rows (joined by id); `memory_conflicts.confidence`
 * is the DETECTION confidence (the `Contra` score), NOT the per-memory `f` — so a JOIN is required.
 * `review` and `keep-both` are NOT clean signals (both memories survived), so they are excluded.
 *
 * ── The refit gate (AC-55e.2.1 / 55e.2.2) ────────────────────────────────────
 *   - COLD-START: fewer than `minSamples` resolved pairs → the IDENTITY model (`C = f`), the `c`
 *     exponent stays `0`, NO write. The curve never perturbs ranking before it has proven itself.
 *   - A refit is ADOPTED only when its held-out ECE is STRICTLY LESS than the prior's (a tie keeps
 *     the incumbent, never churns the curve for no gain). When adopted, the curve + its ECE / Brier
 *     / n_samples are written to `memory_calibration` as a new append-only snapshot.
 *
 * ── Fail-soft (the maintenance posture) ──────────────────────────────────────
 * A request with no resolvable tenancy fails closed at the edge (400). Everything else is best-effort:
 * a read error yields zero pairs → cold-start → identity, no write. A write error is swallowed and
 * reported as `written: false`. A maintenance miss NEVER breaks recall (recall reads the live curve
 * via the calibration source; an absent refit leaves the prior / identity curve intact).
 */

import { randomUUID } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import { MEMORY_CALIBRATION_TABLE, type CalibrationAgentScope } from "../../storage/catalog/memory-lifecycle.js";
import { appendOnlyInsert, val, type RowValues } from "../../storage/writes.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import type { Daemon } from "../server.js";
import {
	DEFAULT_MIN_CALIBRATION_SAMPLES,
	type CalibrationModel,
	type CalibrationSample,
	fitIsotonic,
	shouldAdoptRefit,
	expectedCalibrationError,
	brierScore,
	serializeModel,
	deserializeModel,
	IDENTITY_MODEL,
} from "../memories/calibration.js";

/** The route the calibration trigger is served at (full path `/api/diagnostics/calibrate`). */
export const CALIBRATE_TRIGGER_PATH = "/calibrate" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const CALIBRATE_TRIGGER_GROUP = "/api/diagnostics" as const;

/**
 * How many resolved conflicts one pass reads (bounded so a manual trigger is a normal request). A
 * larger backlog is converged over successive passes (the periodic tick fires every ~1 hour).
 */
export const DEFAULT_CALIBRATE_BATCH = 1_000;

/** The fraction of the resolved-pairs set held out for the ECE comparison (the rest fit the curve). */
const DEFAULT_HELD_OUT_FRACTION = 0.3;

/** The 400 body for a request with no resolvable tenancy (fail-closed at the edge). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** The summary body the trigger returns (the contract the dashboard / CLI render). */
export interface CalibrateSummaryBody {
	/** `true` when the pass ran to completion (even a cold-start no-write pass is `ok`). */
	readonly ok: boolean;
	/** How many resolved `(f, y)` pairs the pass read. */
	readonly nSamples: number;
	/** `true` when the live curve is the dormant identity (`C = f`). */
	readonly identity: boolean;
	/** The held-out ECE of the candidate curve (the gate metric). `0` for the identity model. */
	readonly candidateEce: number;
	/** The held-out ECE of the prior curve. `0` for cold-start. */
	readonly priorEce: number;
	/** `true` when the candidate was ADOPTED (beat the prior on held-out ECE — AC-55e.2.1). */
	readonly adopted: boolean;
	/** `true` when the new curve was written to `memory_calibration`. */
	readonly written: boolean;
	/** `true` when the pass was cold-start (fewer than `minSamples` pairs → identity, no write). */
	readonly coldStart: boolean;
}

/** Options for {@link mountCalibrateApi}. */
export interface MountCalibrateOptions {
	/** The live storage client the read + write run through (guarded primitives). */
	readonly storage: StorageQuery;
	/** The daemon's own tenancy partition (the same `defaultScope` the other diagnostics mounts thread). */
	readonly defaultScope: QueryScope;
	/** The resolved-pairs batch size. Defaults to {@link DEFAULT_CALIBRATE_BATCH}. */
	readonly batch?: number;
	/** The minimum samples before a non-identity fit is attempted. Defaults to {@link DEFAULT_MIN_CALIBRATION_SAMPLES}. */
	readonly minSamples?: number;
	/** The held-out fraction for the ECE comparison. Defaults to {@link DEFAULT_HELD_OUT_FRACTION}. */
	readonly heldOutFraction?: number;
	/** The agent scope the calibration curve is fit for. Defaults to the schema defaults. */
	readonly agent?: CalibrationAgentScope;
	/** Injectable clock for the `fit_at` stamp. Defaults to wall-clock. */
	readonly now?: () => Date;
	/** Injectable id generator for the snapshot row. Defaults to a UUID. */
	readonly newId?: () => string;
}

/** Read a stored float cell, defaulting when absent/garbage. */
function readFloat(value: unknown, def: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : def;
}

/** Resolve an {@link CalibrationAgentScope} to its concrete `(agentId, visibility)` (schema defaults). */
function resolveAgent(agent?: CalibrationAgentScope): { agentId: string; visibility: string } {
	const agentId = agent?.agentId !== undefined && agent.agentId !== "" ? agent.agentId : "default";
	const visibility = agent?.visibility !== undefined && agent.visibility !== "" ? agent.visibility : "global";
	return { agentId, visibility };
}

/**
 * Build the resolved-outcomes SQL: the `memory_conflicts` rows whose live version is `resolved` with a
 * `supersede` verdict and a non-empty `winner_id`, JOINED with `memories` to read each side's raw
 * confidence (`f`). Returns `(winner_id, loser_id, winner_f, loser_f)` tuples. Every identifier routes
 * through `sqlIdent`; the partition rides the `storage.query(sql, scope)` call. The winner's `f` is
 * evidence it was right (`y = 1`); the loser's `f` is evidence it was wrong (`y = 0`).
 */
export function buildResolvedOutcomesSql(limit: number): string {
	const conflictsTbl = sqlIdent("memory_conflicts");
	const memoriesTbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const aCol = sqlIdent("memory_a_id");
	const bCol = sqlIdent("memory_b_id");
	const winnerCol = sqlIdent("winner_id");
	const verdictCol = sqlIdent("verdict");
	const statusCol = sqlIdent("status");
	const versionCol = sqlIdent("version");
	const createdAtCol = sqlIdent("created_at");
	const memIdCol = sqlIdent("id");
	const confidenceCol = sqlIdent("confidence");
	const isDeletedCol = sqlIdent("is_deleted");
	const safeLimit = Math.max(1, Math.trunc(limit));
	return (
		`SELECT c.${winnerCol} AS winner_id, ` +
		`CASE WHEN c.${winnerCol} = c.${aCol} THEN c.${bCol} ELSE c.${aCol} END AS loser_id, ` +
		`wf.${confidenceCol} AS winner_f, lf.${confidenceCol} AS loser_f ` +
		`FROM "${conflictsTbl}" c ` +
		`LEFT JOIN "${memoriesTbl}" wf ON wf.${memIdCol} = c.${winnerCol} AND wf.${isDeletedCol} = 0 ` +
		`LEFT JOIN "${memoriesTbl}" lf ON lf.${memIdCol} = ` +
		`CASE WHEN c.${winnerCol} = c.${aCol} THEN c.${bCol} ELSE c.${aCol} END AND lf.${isDeletedCol} = 0 ` +
		`WHERE c.${versionCol} = (SELECT MAX(i.${versionCol}) FROM "${conflictsTbl}" i WHERE i.${idCol} = c.${idCol}) ` +
		`AND c.${statusCol} = ${sLiteral("resolved")} AND c.${verdictCol} = ${sLiteral("supersede")} ` +
		`AND c.${winnerCol} IS NOT NULL AND c.${winnerCol} <> '' ` +
		// ORDER BY created_at DESC so the LIMIT holds out the MOST RECENT resolved outcomes
		// (the recency-based evaluation contract runCalibratePass documents). Without this the
		// held-out slice was arbitrary — Aikido + CodeRabbit flagged the LIMIT-without-ORDER BY.
		// Tie-broken by id for deterministic pagination (two rows can share a created_at stamp).
		`ORDER BY c.${createdAtCol} DESC, c.${idCol} DESC ` +
		`LIMIT ${safeLimit}`
	);
}

/**
 * Read the resolved outcomes as `(f, y)` {@link CalibrationSample}s (PRD-058e). The winner's `f → y = 1`;
 * the loser's `f → y = 0`. Pairs with an unreadable `f` (a missing `memories` row, a join that returned
 * NULL) are dropped — a garbage `f` contributes nothing. FAIL-SOFT: a read error yields an empty array.
 */
export async function readResolvedOutcomes(
	storage: StorageQuery,
	scope: QueryScope,
	batch: number,
): Promise<CalibrationSample[]> {
	let res;
	try {
		res = await storage.query(buildResolvedOutcomesSql(batch), scope);
	} catch {
		return [];
	}
	if (!isOk(res)) return [];
	const samples: CalibrationSample[] = [];
	for (const row of res.rows as StorageRow[]) {
		const winnerF = readFloat(row.winner_f, Number.NaN);
		const loserF = readFloat(row.loser_f, Number.NaN);
		// Drop pairs where either side's f is unreadable (a missing memories row → a NULL join).
		if (!Number.isFinite(winnerF) || !Number.isFinite(loserF)) continue;
		samples.push({ f: winnerF, y: 1 });
		samples.push({ f: loserF, y: 0 });
	}
	return samples;
}

/**
 * Read the LIVE (highest-`fit_at`) calibration model for the scope (the prior curve). FAIL-SOFT: a
 * missing table / read error → the IDENTITY model (`C = f`). Never throws.
 */
export async function readPriorCalibrationModel(
	storage: StorageQuery,
	scope: QueryScope,
	agent?: CalibrationAgentScope,
): Promise<CalibrationModel> {
	try {
		// Reuse the catalog's read builder so the agent-scope conjunct is single-sourced. The builder
		// lives in the catalog; this read fetches the model_blob the deserialize helper decodes.
		const { buildLatestCalibrationSql } = await import("../../storage/catalog/memory-lifecycle.js");
		const res = await storage.query(buildLatestCalibrationSql(agent), scope);
		if (!isOk(res) || res.rows.length === 0) return IDENTITY_MODEL;
		const row = res.rows[0] as StorageRow;
		return deserializeModel(String(row.model_blob ?? ""));
	} catch {
		return IDENTITY_MODEL;
	}
}

/**
 * Write a new calibration snapshot to `memory_calibration` (PRD-058e). Append-only (one row per refit;
 * the live curve is the highest-`fit_at` row). FAIL-SOFT: returns `false` on a write error, never throws.
 */
export async function writeCalibrationSnapshot(
	storage: StorageQuery,
	scope: QueryScope,
	model: CalibrationModel,
	metrics: { readonly ece: number; readonly brier: number; readonly nSamples: number },
	agent: CalibrationAgentScope,
	deps: { readonly now?: () => Date; readonly newId?: () => string },
): Promise<boolean> {
	const now = (deps.now ?? (() => new Date()))();
	const id = (deps.newId ?? randomUUID)();
	const { agentId, visibility } = resolveAgent(agent);
	const row: RowValues = [
		["id", val.str(id)],
		["fit_at", val.str(now.toISOString())],
		["model_blob", val.str(serializeModel(model))],
		["ece", val.num(metrics.ece)],
		["brier", val.num(metrics.brier)],
		["n_samples", val.num(metrics.nSamples)],
		["agent_id", val.str(agentId)],
		["visibility", val.str(visibility)],
	];
	const target = healTargetFor(MEMORY_CALIBRATION_TABLE);
	const res = await appendOnlyInsert(storage, target, scope, row);
	return isOk(res);
}

/**
 * The pass function the route AND the periodic tick both call (L-W9 / PRD-058e). Reads the resolved
 * outcomes, fits a candidate curve, compares it to the prior on held-out ECE, and — when the candidate
 * beats the prior (AC-55e.2.1) — writes the new curve. COLD-START (fewer than `minSamples` pairs)
 * → identity, no write. FAIL-SOFT throughout.
 */
export async function runCalibratePass(
	scope: QueryScope,
	options: MountCalibrateOptions,
): Promise<CalibrateSummaryBody> {
	const batch = options.batch ?? DEFAULT_CALIBRATE_BATCH;
	const minSamples = options.minSamples ?? DEFAULT_MIN_CALIBRATION_SAMPLES;
	const heldOutFraction = options.heldOutFraction ?? DEFAULT_HELD_OUT_FRACTION;
	const agent = options.agent;

	// Read the resolved (f, y) pairs + the prior curve. Both are fail-soft.
	const samples = await readResolvedOutcomes(options.storage, scope, batch);
	const prior = await readPriorCalibrationModel(options.storage, scope, agent);

	// COLD-START (AC-55e.2.2): fewer than minSamples pairs → identity, no write.
	if (samples.length < minSamples) {
		return {
			ok: true,
			nSamples: samples.length,
			identity: true,
			candidateEce: 0,
			priorEce: 0,
			adopted: false,
			written: false,
			coldStart: true,
		};
	}

	// Split into fit + held-out slices (deterministic on input order so the comparison is stable). The
	// split is sequential (not shuffled) — the resolved-outcomes SQL orders by created_at DESC, so the
	// held-out slice is the MOST RECENT outcomes (the curve is fit on the longer history, evaluated on
	// the recent present — the orientation that answers "is this curve still good").
	const heldOutCount = Math.max(1, Math.trunc(samples.length * heldOutFraction));
	const heldOut = samples.slice(0, heldOutCount);
	const fitSet = samples.slice(heldOutCount);

	const candidate = fitIsotonic(fitSet, minSamples);
	// If the candidate fell back to identity (fit set itself too small after the split), no write.
	if (candidate.identity) {
		return {
			ok: true,
			nSamples: samples.length,
			identity: true,
			// Per the CalibrationSummary contract: candidateEce is `0` for the identity model
			// (the held-out ECE of an identity curve is not a meaningful gate metric — there is
			// no candidate curve to evaluate). The priorEce is still computed (the prior's ECE
			// is meaningful regardless of what the candidate turned out to be). Aikido flagged
			// the prior non-zero candidateEce as a contract contradiction.
			candidateEce: 0,
			priorEce: expectedCalibrationError(heldOut, prior),
			adopted: false,
			written: false,
			coldStart: false,
		};
	}

	// The refit gate (AC-55e.2.1): adopt only when the candidate's held-out ECE is STRICTLY LESS.
	const candidateEce = expectedCalibrationError(heldOut, candidate);
	const priorEce = expectedCalibrationError(heldOut, prior);
	const adopted = shouldAdoptRefit(priorEce, candidateEce);
	if (!adopted) {
		return {
			ok: true,
			nSamples: samples.length,
			identity: false,
			candidateEce,
			priorEce,
			adopted: false,
			written: false,
			coldStart: false,
		};
	}

	// Adopted: write the new curve. The metrics (ECE + Brier) are over the FULL sample set so the
	// snapshot records the curve's quality on ALL the data it consumed, not just the held-out slice.
	const fullEce = expectedCalibrationError(samples, candidate);
	const fullBrier = brierScore(samples, candidate);
	const written = await writeCalibrationSnapshot(
		options.storage,
		scope,
		candidate,
		{ ece: fullEce, brier: fullBrier, nSamples: samples.length },
		agent ?? {},
		{ ...(options.now !== undefined ? { now: options.now } : {}), ...(options.newId !== undefined ? { newId: options.newId } : {}) },
	);
	return {
		ok: true,
		nSamples: samples.length,
		identity: false,
		candidateEce,
		priorEce,
		adopted: true,
		written,
		coldStart: false,
	};
}

/**
 * Attach the calibration refit TRIGGER onto the daemon's already-mounted, protected `/api/diagnostics`
 * group (PRD-058e). Registers `POST /api/diagnostics/calibrate`, which resolves the request scope
 * (header org or the daemon default — fail-closed), reads the resolved outcomes, fits + adopts a curve
 * when it beats the prior, and returns the summary. Call ONCE after `createDaemon(...)`. If the group
 * is not mounted the attach is a no-op. FAIL-SOFT: cold-start → identity, no write.
 */
export function mountCalibrateApi(daemon: Daemon, options: MountCalibrateOptions): void {
	const group = daemon.group(CALIBRATE_TRIGGER_GROUP);
	if (group === undefined) return;

	group.post(CALIBRATE_TRIGGER_PATH, async (c) => {
		const scope = resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const summary = await runCalibratePass(scope, options);
		return c.json(summary, 200);
	});
}
