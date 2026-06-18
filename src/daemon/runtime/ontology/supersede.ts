/**
 * Shared supersede-by-version-bump helper — PRD-008 Wave 1 (the core 008b/008c reuse).
 *
 * Superseding a claim attribute is the ONE mechanic both Wave-2 Bees need: 008b
 * runs it when a conflicting sibling lands in the same slot (b-AC-1), and 008c's
 * apply path runs it for an explicit `claim.supersede` operation (c-AC-4). So it is
 * implemented FULLY here, once, as the shared core — not stubbed.
 *
 * ── Why append + APPEND-MARK, never in-place UPDATE (008b FR-6 / b-AC-2) ─────
 * The DeepLake query endpoint coalesces two rapid UPDATEs to the same row and can
 * silently drop one (see `storage/writes.ts`); worse, against the REAL backend an
 * in-place by-id UPDATE does NOT reliably land at all — the backend round-robins a
 * scan across segments of differing freshness and the SET-by-id never converges (the
 * exact trap `memory_jobs` + `pipeline/graph-persist.ts` already hit and solved by
 * going APPEND-ONLY + highest-version-per-id reads). So a status change is NEVER an
 * in-place mutate of the claim row. Instead supersession is TWO appends-of-record:
 *
 *   1. APPEND the new claim at slot `version` N+1 with `status='active'` via
 *      {@link appendNewVersion} (heal-aware; survives the UPDATE-coalescing +
 *      segment-freshness flap). The new claim has its OWN deterministic id.
 *   2. MARK the prior sibling superseded by APPENDING A NEW VERSION OF THE PRIOR id —
 *      same `id` as the prior row, the prior id's own `version` + 1, `status =
 *      'superseded'` + `superseded_by` = newId, every other column copied forward
 *      INTACT (no content mutate). The prior id's HIGHEST version then reads as
 *      superseded. This is {@link appendPriorSuperseded} — an INSERT, never an UPDATE.
 *
 * Both the new claim and the superseded mark are appends, so the path has ZERO
 * in-place UPDATEs and is immune to the UPDATE-coalescing / by-id-SET flap.
 *
 * ── Current state of an attribute = its HIGHEST version (poll-convergent) ────
 * Because the mark is an append, RAW-ROW counting by status is WRONG: a prior id now
 * has TWO physical rows on disk (its original active version and its superseded
 * version), and the original keeps its old `status='active'` forever. The current
 * state of an attribute id is therefore its HIGHEST-version row, resolved exactly
 * like `graph-persist.ts`'s `latestById`. {@link readCurrentStateById} is that read.
 * The slot's current ACTIVE claim is still the highest-version active row per
 * `claim_key` (the catalog's {@link buildHighestActiveVersionSql}); the prior id's
 * current state is its highest version (superseded).
 *
 * ── Resolving the prior sibling: POLL-CONVERGENT read (live-determinism) ─────
 * Before marking, we must find the prior active row's `id`. This backend serves a
 * read from segments of differing freshness that flap NON-MONOTONICALLY, so a single
 * `SELECT … LIMIT 1` can land on a STALE segment and MISS a row that is already
 * durably written. A scan can only UNDER-report presence (miss a row), never INVENT
 * one — exactly the property `pipeline/graph-persist.ts` relies on. So the prior-row
 * lookup is POLLED up to {@link PRIOR_POLLS} times and takes the FIRST hit: polling
 * can only turn a false-absent into the true-present, converging toward the durable
 * truth without fabricating a row. On the deterministic fake the first poll is
 * authoritative, so a present prior short-circuits immediately (a live-only cost).
 *
 * If the caller already knows the prior id (the common case — the conflict detector
 * found it), it passes `priorId` and the lookup is skipped entirely.
 *
 * ── Constraints are NOT auto-superseded (D-7 / b-AC-5) ──────────────────────
 * This helper supersedes the row it is TOLD to. The constraint-exemption rule lives
 * in the CALLER (008b's conflict path skips constraints; 008c requires a deliberate
 * op), not here — a deliberate `claim.supersede` of a constraint through the control
 * plane is legitimate. The helper stays mechanism, not policy.
 *
 * ── SQL safety (008b FR-9 / a-AC-7) ─────────────────────────────────────────
 * Every value routes through the PRD-002d `val.*` constructors (→ `sLiteral` /
 * `eLiteral`); both appends go through the heal-aware `appendOnlyInsert` (→ guarded
 * `buildInsert`). The current-state read builds its SELECT through `sqlIdent` /
 * `sLiteral`. No value is hand-quoted; no raw fetch. `audit:sql` scans `src/daemon`.
 */

import crypto from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import {
	buildHighestActiveVersionSql,
	CLAIM_ACTIVE,
	CLAIM_SUPERSEDED,
} from "../../storage/catalog/knowledge-graph.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, type RowValues, val } from "../../storage/writes.js";
import type { Attribute, AttributeSlot } from "./contracts.js";

/** The `entity_attributes` table the supersede path writes. */
const T_ATTRIBUTES = "entity_attributes";

/**
 * How many times the prior-sibling lookup polls before concluding the slot has no
 * prior active row. Mirrors `pipeline/graph-persist.ts`'s `PROBE_POLLS`: this
 * backend serves a read from segments of differing freshness, so a just-written
 * prior row is reliably seen by the second pass. A scan never invents a row, so
 * polling only ever turns a false-absent into the true-present. On the fake the
 * first poll is authoritative.
 */
export const PRIOR_POLLS = 8;

/** ISO timestamp for `created_at` / `updated_at`. */
function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Derive a stable id for a claim-attribute VERSION row from its slot identity +
 * version. Prefixed `attr_`. Deterministic so a re-run of the same (aspect, slot,
 * version) resolves the SAME id — the idempotency property the live backend needs
 * (mirrors the entity/dependency/mention id derivation in graph-persist.ts). Pure.
 */
export function attributeVersionId(aspectId: string, slot: AttributeSlot, version: number): string {
	const material = `${aspectId}:${slot.groupKey}:${slot.claimKey}:${version}`;
	const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
	return `attr_${hash}`;
}

/**
 * The stable `claim_key` a version chain shares. The catalog's `claim_key` column
 * is the lineage key the reader ({@link buildHighestActiveVersionSql}) resolves on,
 * so every version of a claim in the same (aspect, group, claim) slot MUST carry the
 * same `claim_key`. We derive it deterministically from the slot identity so two
 * independent writers targeting the same slot agree on the chain. Pure.
 */
export function slotClaimKey(aspectId: string, slot: AttributeSlot): string {
	const material = `${aspectId}:${slot.groupKey}:${slot.claimKey}`;
	const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
	return `ck_${hash}`;
}

/** The new attribute the caller wants to land as the current claim in a slot. */
export interface SupersedeNewAttribute {
	/** attribute | constraint (carried onto the appended row). */
	readonly kind: Attribute["kind"];
	/** The claim value text. */
	readonly content: string;
	/** Confidence in the new claim, 0..1. */
	readonly confidence: number;
	/** Importance of the new claim, 0..1. */
	readonly importance: number;
	/** Provenance back to the memory + (optional) proposal that produced it (a-AC-3). */
	readonly provenance: Attribute["provenance"];
	/** The agent the row is scoped to (D-2). */
	readonly agentId: string;
	/** Row visibility (default `global`). */
	readonly visibility?: string;
}

/** Arguments to {@link supersedeClaim} — the shared supersede-by-version-bump signature. */
export interface SupersedeClaimArgs {
	/** The entity the claim hangs under (carried for the caller's auditing; not on the attr row). */
	readonly entityId: string;
	/** The aspect the claim hangs under. */
	readonly aspectId: string;
	/** The navigable subdivision inside the aspect (a-AC-5). */
	readonly groupKey: string;
	/** The specific updateable slot the claim occupies (a-AC-5). */
	readonly claimKey: string;
	/** The new claim to land as `status='active'` at version N+1. */
	readonly newAttribute: SupersedeNewAttribute;
	/**
	 * The prior sibling's row id, when the caller already knows it (the common case:
	 * the conflict detector found it). When absent, the prior active row is resolved
	 * by a POLL-CONVERGENT read on the slot's `claim_key`. When there is genuinely no
	 * prior row (a first claim in the slot), leave it unset — the append still runs
	 * and nothing is marked.
	 */
	readonly priorId?: string;
}

/** The outcome of a {@link supersedeClaim} call, for the caller's audit trail. */
export interface SupersedeResult {
	/** The id of the newly-appended active claim row. */
	readonly newId: string;
	/** The version the new row was appended at (N+1). */
	readonly version: number;
	/** The prior sibling's id that was marked superseded, or `null` if there was none. */
	readonly supersededId: string | null;
}

/**
 * Supersede a claim by APPEND + MARK (the shared 008b/008c core — 008b b-AC-1,
 * 008c c-AC-4).
 *
 * Steps:
 *   1. Resolve the prior active row id for the slot (caller-supplied `priorId`, else
 *      a POLL-CONVERGENT read on the slot's `claim_key`).
 *   2. APPEND the new claim at slot version N+1 with `status='active'` via
 *      {@link appendNewVersion}. The version chain is keyed by the slot's `claim_key`,
 *      so the reader resolves the highest-version active row as current.
 *   3. If a prior row exists, MARK it superseded by APPENDING a new version of the
 *      PRIOR id ({@link appendPriorSuperseded}): same `id`, the prior id's own
 *      version + 1, `status='superseded'` + `superseded_by`=newId, every other column
 *      copied forward INTACT (no content mutate). The prior id's HIGHEST version then
 *      reads as superseded — full history stays on disk (b-AC-2). This is an INSERT,
 *      NOT an in-place UPDATE: a by-id SET does not reliably land on the real backend
 *      (it round-robins stale segments), so the append-only mark is the convergent
 *      mechanism. When there is no prior row, nothing is marked.
 *
 * NEVER an in-place mutate of a claim row (008b FR-6). Returns the new id, the
 * appended slot version, and the superseded prior id (or null).
 */
export async function supersedeClaim(
	storage: StorageQuery,
	scope: QueryScope,
	args: SupersedeClaimArgs,
): Promise<SupersedeResult> {
	const target = healTargetFor(T_ATTRIBUTES);
	const slot: AttributeSlot = { groupKey: args.groupKey, claimKey: args.claimKey };
	const claimKeyValue = slotClaimKey(args.aspectId, slot);

	// 1. Resolve the prior active row id (caller-supplied, else poll-convergent read).
	const priorId =
		args.priorId ?? (await readPriorActiveId(storage, scope, claimKeyValue));

	// 2. APPEND the new active claim at slot version N+1.
	const now = nowIso();
	const { version, newId } = await appendNewVersion(storage, target, scope, args, slot, claimKeyValue, now);

	// 3. MARK the prior sibling superseded by APPENDING a new version of the PRIOR id
	//    (never an in-place UPDATE — that does not converge live). Skipped when there
	//    is no prior. The prior id's highest version then reads as superseded.
	let supersededId: string | null = null;
	if (priorId !== null && priorId !== "" && priorId !== newId) {
		await appendPriorSuperseded(storage, target, scope, priorId, newId, claimKeyValue, slot, now);
		supersededId = priorId;
	}

	return { newId, version, supersededId };
}

/**
 * APPEND the new active claim version (008b FR-5 / b-AC-1).
 *
 * Computes N+1 by reading the current MAX(version) for the slot's `claim_key`, then
 * builds the FULL `entity_attributes` row — with a deterministic `id` keyed off the
 * resolved version so the row's `id` column matches the returned `newId` exactly
 * (the supersede-mark guard depends on that equality) and a re-run resolves the same
 * row. The insert goes through the heal-aware {@link appendOnlyInsert} (the version
 * column is supplied explicitly, so this is a plain append, not the version-bump
 * primitive's internal re-read), which creates/heals the table lazily on first write.
 *
 * Every value routes through the guarded `val.*` constructors.
 */
async function appendNewVersion(
	storage: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	args: SupersedeClaimArgs,
	slot: AttributeSlot,
	claimKeyValue: string,
	now: string,
): Promise<{ version: number; newId: string }> {
	const a = args.newAttribute;
	const version = (await readMaxClaimVersion(storage, scope, claimKeyValue)) + 1;
	const newId = attributeVersionId(args.aspectId, slot, version);

	await appendOnlyInsert(storage, target, scope, [
		["id", val.str(newId)],
		["aspect_id", val.str(args.aspectId)],
		["agent_id", val.str(a.agentId)],
		["memory_id", val.str(a.provenance.memoryId)],
		["kind", val.str(a.kind)],
		["content", val.text(a.content)],
		["confidence", val.num(clamp01(a.confidence))],
		["importance", val.num(clamp01(a.importance))],
		["status", val.str(CLAIM_ACTIVE)],
		["superseded_by", val.str("")],
		["claim_key", val.str(claimKeyValue)],
		["group_key", val.str(slot.groupKey)],
		["version", val.num(version)],
		["visibility", val.str(a.visibility ?? "global")],
		["created_at", val.str(now)],
		["updated_at", val.str(now)],
	]);

	// Provenance note: `memory_id` IS the mandatory provenance (a-AC-3). The catalog's
	// `entity_attributes` has no dedicated `source`/`proposal_id` columns, so the
	// proposal link (when an 008c apply supplies one) is carried by the deterministic
	// id lineage + the `ontology_proposals` row the control plane appends; the
	// attribute row never loses its memory trace.
	void a.provenance.proposalId;
	void a.provenance.source;

	return { version, newId };
}

/**
 * MARK the prior sibling superseded by APPENDING a new version of the PRIOR id
 * (008b FR-3/FR-6 / b-AC-2 — the live-correct replacement for the in-place UPDATE).
 *
 * Why an append, not an UPDATE: a by-id `SET status='superseded'` does NOT reliably
 * land on the real backend — it round-robins a scan across segments of differing
 * freshness and the in-place mutate can be coalesced or simply never converge (the
 * same trap `memory_jobs` + `graph-persist.ts` solved by going append-only). So the
 * mark is an INSERT of a NEW version row carrying the SAME `id` as the prior, the
 * prior id's own `version` + 1, `status='superseded'`, and `superseded_by`=newId. The
 * prior id's HIGHEST version then reads as superseded ({@link readCurrentStateById}),
 * while the prior's original active row stays INTACT on disk so full history survives.
 *
 * The prior row's other columns (content, aspect_id, kind, …) are COPIED FORWARD from
 * its current state so the superseded version is a complete, self-consistent row — the
 * content is copied UNCHANGED (never mutated, b-AC-2). When the prior's current state
 * cannot be read (a stale-segment miss that never converged, or a caller-supplied
 * priorId with no readable row), a minimal superseded row is appended carrying just the
 * identity + status + the slot's `claim_key`, so the mark still lands.
 *
 * Every value routes through the guarded `val.*` constructors; the insert is heal-aware.
 */
async function appendPriorSuperseded(
	storage: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	priorId: string,
	newId: string,
	claimKeyValue: string,
	slot: AttributeSlot,
	now: string,
): Promise<void> {
	const prior = await readCurrentStateById(storage, scope, priorId);
	const priorVersion =
		prior && Number.isFinite(Number(prior.version)) ? Number(prior.version) : 0;
	const markVersion = priorVersion + 1;

	// Copy the prior's columns forward UNCHANGED, overriding only the status pointer +
	// the version + updated_at. A missing prior (unconverged read) falls back to the
	// slot identity we already hold, so the mark still lands as a complete row.
	const str = (key: string, fallback = ""): string => {
		const v = prior?.[key];
		return typeof v === "string" ? v : fallback;
	};
	const num = (key: string, fallback: number): number => {
		const v = prior?.[key];
		const n = typeof v === "number" ? v : Number(v);
		return Number.isFinite(n) ? n : fallback;
	};

	const row: RowValues = [
		["id", val.str(priorId)],
		["aspect_id", val.str(str("aspect_id"))],
		["agent_id", val.str(str("agent_id", "default"))],
		["memory_id", val.str(str("memory_id"))],
		["kind", val.str(str("kind", "attribute"))],
		["content", val.text(str("content"))],
		["confidence", val.num(num("confidence", 1))],
		["importance", val.num(num("importance", 0.5))],
		["status", val.str(CLAIM_SUPERSEDED)],
		["superseded_by", val.str(newId)],
		["claim_key", val.str(str("claim_key", claimKeyValue))],
		["group_key", val.str(str("group_key", slot.groupKey))],
		["version", val.num(markVersion)],
		["visibility", val.str(str("visibility", "global"))],
		["created_at", val.str(str("created_at", now))],
		["updated_at", val.str(now)],
	];

	await appendOnlyInsert(storage, target, scope, row);
}

/**
 * Read the CURRENT STATE of an attribute id = its HIGHEST-version row (the
 * poll-convergent "latest by id" read, mirroring `graph-persist.ts`'s `latestById`).
 *
 * Because the supersede mark is an APPEND, an attribute id can have multiple physical
 * rows on disk; the current state is the one with the greatest `version`. Reading raw
 * rows and counting by `status` is WRONG — a historical version keeps its old status.
 * This read resolves the single current row for `id`. POLL-CONVERGENT: a stale segment
 * can miss the latest version but never invents one, so polling converges UP to the
 * durable current state. Returns the row, or `null` when no row is readable.
 */
export async function readCurrentStateById(
	storage: StorageQuery,
	scope: QueryScope,
	id: string,
): Promise<StorageRow | null> {
	const tbl = sqlIdent(T_ATTRIBUTES);
	const idCol = sqlIdent("id");
	const versionCol = sqlIdent("version");
	const sql =
		`SELECT * FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(id)} ` +
		`ORDER BY ${versionCol} DESC LIMIT 1`;
	let best: StorageRow | null = null;
	let bestVersion = -Infinity;
	for (let poll = 0; poll < PRIOR_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) {
			const row = res.rows[0] as StorageRow;
			const v = typeof row.version === "number" ? row.version : Number(row.version);
			const ver = Number.isFinite(v) ? v : 0;
			if (ver >= bestVersion) {
				bestVersion = ver;
				best = row;
			}
		}
	}
	return best;
}

/**
 * Read the current MAX(version) for a slot's `claim_key`; 0 when the slot has no
 * rows yet. Uses the heal-aware highest-active read shape but over ALL statuses (a
 * superseded prior still counts toward the version high-water mark, so N+1 never
 * collides with a superseded row's version). POLL-CONVERGENT: a stale segment can
 * miss the latest version, never invent one, so polling converges UP to the true max.
 */
async function readMaxClaimVersion(
	storage: StorageQuery,
	scope: QueryScope,
	claimKeyValue: string,
): Promise<number> {
	const tbl = sqlIdent(T_ATTRIBUTES);
	const claimKeyCol = sqlIdent("claim_key");
	const versionCol = sqlIdent("version");
	const sql =
		`SELECT ${versionCol} FROM "${tbl}" ` +
		`WHERE ${claimKeyCol} = ${sLiteral(claimKeyValue)} ` +
		`ORDER BY ${versionCol} DESC LIMIT 1`;
	let max = 0;
	for (let poll = 0; poll < PRIOR_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) {
			const raw = (res.rows[0] as StorageRow).version;
			const n = typeof raw === "number" ? raw : Number(raw);
			if (Number.isFinite(n) && n > max) max = n;
		}
	}
	return max;
}

/**
 * POLL-CONVERGENT read of the prior ACTIVE row id for a slot's `claim_key`. Uses the
 * catalog's {@link buildHighestActiveVersionSql} (the canonical "current claim" read)
 * and returns the resolved row's `id`, or `null` after every poll came back empty.
 * Polled because a single read can land on a stale segment and miss a durably-written
 * row; a scan never invents one, so polling converges UP to the durable truth.
 */
async function readPriorActiveId(
	storage: StorageQuery,
	scope: QueryScope,
	claimKeyValue: string,
): Promise<string | null> {
	const sql = buildHighestActiveVersionSql(claimKeyValue);
	for (let poll = 0; poll < PRIOR_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) {
			const row = res.rows[0] as StorageRow;
			const id = row.id;
			if (typeof id === "string" && id !== "") return id;
		}
	}
	return null;
}

/** Clamp a score into [0, 1]; non-finite → 0. */
function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

/**
 * Re-export the catalog supersession status constants so a caller (008b/008c) reads
 * the SAME literals this helper writes, never a hand-typed string.
 */
export { CLAIM_ACTIVE, CLAIM_SUPERSEDED };

/**
 * Re-export the catalog read builder + escaping helpers so a caller that needs the
 * raw SQL (e.g. 008c's dry-run plan) reaches them through this module — one supersede
 * surface. The supersede MARK is no longer a catalog UPDATE builder: it is the
 * append-only {@link appendPriorSuperseded} inside this module, so `buildSupersedeMarkSql`
 * (the in-place UPDATE that did not converge live) is intentionally NOT re-exported.
 */
export { buildHighestActiveVersionSql, sLiteral, sqlIdent };
