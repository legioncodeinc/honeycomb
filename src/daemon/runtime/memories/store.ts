/**
 * The memory WRITE adapters — PRD-022a (a-AC-3 / a-AC-4 / FR-3 / FR-5).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WIRING ONLY (ledger D-1). This module calls the EXISTING controlled-writes
 * engine (`src/daemon/runtime/pipeline/controlled-writes.ts`) — the ONLY stage
 * that mutates `memories` — from the HTTP handlers. It adds NO new write policy,
 * NO new retention rule, and NO new schema. `store` is an ADD; `modify` is a
 * version-bumped UPDATE; `forget` is a version-bumped soft-DELETE (tombstone) —
 * each is the existing engine path, never an in-place UPDATE (the DeepLake lesson:
 * DeepLake coalesces UPDATEs and can drop one).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The reason-gate + audit (a-AC-4 / FR-5) ──────────────────────────────────
 * `modify` and `forget` REQUIRE a `reason`. The reason-gate is enforced at the
 * zod boundary in the handler (a body without a reason is a 400 before the engine
 * is reached); this module additionally refuses to run the mutation when the
 * reason is blank (defense in depth) AND writes an append-only `memory_history`
 * audit row recording the operation, the target, and the reason — so no memory
 * mutation is silent. The audit row uses the existing `memory_history` table
 * (append-only INSERT, PRD-003a a-AC-2) through the guarded `appendOnlyInsert`.
 *
 * ── How it reaches storage ───────────────────────────────────────────────────
 * Through the injected {@link StorageQuery} only (never a raw fetch — `audit:sql`
 * scans `src/daemon`). The controlled-writes engine builds every memory-row value
 * through the `writes.ts` primitives + SQL-safety helpers; the audit row here does
 * the same via `val.*` + `appendOnlyInsert`. The org/workspace partition rides the
 * per-request {@link QueryScope}; `agent_id` is the engine-table scope column.
 *
 * ── Embeddings off (ledger D-4) ──────────────────────────────────────────────
 * The store path takes an injected {@link EmbedClient}, defaulting to the no-op
 * ({@link noopEmbedClient}) so a stored row lands with `content_embedding` NULL
 * and stays lexically recallable — exactly the data-API proof posture.
 */

import { createHash, randomUUID } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk } from "../../storage/result.js";
import { appendOnlyInsert, val, type RowValues } from "../../storage/writes.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import type { PipelineConfig } from "../pipeline/config.js";
import { resolvePipelineConfig } from "../pipeline/config.js";
import {
	applyControlledWrite,
	type ControlledWriteHandlerDeps,
	type ControlledWriteOutcome,
} from "../pipeline/controlled-writes.js";
import type { Proposal } from "../pipeline/contracts.js";
import { type EmbedClient, noopEmbedClient } from "../services/embed-client.js";

/** The audited mutation operations the `memory_history` row records (FR-5). */
export type MutationOperation = "store" | "modify" | "forget";

/** Construction deps shared by the write adapters. */
export interface MemoryWriteDeps {
	/** The DeepLake storage client (daemon-only). Every write goes through this. */
	readonly storage: StorageQuery;
	/**
	 * The resolved pipeline config (the controlled-writes gates). Defaults to env
	 * resolution. For the explicit user-driven mutate path, `modify`/`forget`
	 * compose a config with `autonomous.allowUpdateDelete` forced on (the user IS
	 * the authorization) — see {@link buildMutateConfig}.
	 */
	readonly config?: PipelineConfig;
	/** The embed seam (005b). Defaults to the no-op (embeddings off, ledger D-4). */
	readonly embed?: EmbedClient;
	/** A clock for audit/row timestamps; defaults to wall-clock. */
	readonly now?: () => Date;
	/** An id generator for new memory rows + audit rows. Defaults to a UUID. */
	readonly newId?: () => string;
}

/** The validated, scoped store request (the `POST /api/memories` body + scope). */
export interface StoreMemoryRequest {
	/** The memory content to land. */
	readonly content: string;
	/** Optional normalized content the dedup hash is computed over (defaults to `content`). */
	readonly normalizedContent?: string;
	/** Optional fact type (the `type` column); defaults to `'fact'`. */
	readonly type?: string;
	/** The agent the memory is scoped to; defaults to the scope's resolution. */
	readonly agentId?: string;
	/** The storage partition the write lands under (org/workspace). */
	readonly scope: QueryScope;
}

/** The validated, scoped modify/forget request (requires a `reason`, a-AC-4). */
export interface MutateMemoryRequest {
	/** The `memories.id` to modify/forget. */
	readonly id: string;
	/** The required mutation reason (audited). A blank reason is rejected. */
	readonly reason: string;
	/** For `modify`: the new content. Ignored for `forget`. */
	readonly content?: string;
	/** The agent the memory is scoped to. */
	readonly agentId?: string;
	/** The storage partition the mutation lands under (org/workspace). */
	readonly scope: QueryScope;
}

/** The result the handler serializes for a write. */
export interface MemoryWriteResult {
	/** The controlled-write engine's typed outcome. */
	readonly outcome: ControlledWriteOutcome;
	/** True when an audit row was written to `memory_history` (modify/forget). */
	readonly audited: boolean;
}

/** A confidence high enough to clear the controlled-write ADD gate for a deliberate store. */
const DELIBERATE_WRITE_CONFIDENCE = 1.0;

/** Resolve the base pipeline config (env) unless one is injected. */
function baseConfig(deps: MemoryWriteDeps): PipelineConfig {
	return deps.config ?? resolvePipelineConfig();
}

/**
 * Compose the controlled-write deps from the adapter deps + a config. The embed
 * client defaults to the no-op so a stored row lands with `content_embedding`
 * NULL (embeddings off). The id generator threads through so a test asserts the
 * exact inserted id.
 */
function writeDeps(deps: MemoryWriteDeps, config: PipelineConfig): ControlledWriteHandlerDeps {
	return {
		storage: deps.storage,
		config,
		embed: deps.embed ?? noopEmbedClient,
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.newId !== undefined ? { newId: deps.newId } : {}),
	};
}

/**
 * Build the config the explicit user mutate path (`modify`/`forget`) runs under:
 * the base config with `autonomous.allowUpdateDelete` forced ON. The user issuing
 * an authenticated `memory_modify`/`memory_forget` with a reason IS the
 * authorization for the mutation — the autonomous gate exists to stop the
 * AUTONOMOUS pipeline from mutating without review, not to block a deliberate
 * user request. Shadow/frozen are still honored (a frozen daemon writes nothing).
 */
function buildMutateConfig(base: PipelineConfig): PipelineConfig {
	return {
		...base,
		autonomous: { ...base.autonomous, allowUpdateDelete: true },
	};
}

/**
 * Store a memory (a-AC-3 / FR-3): wire `POST /api/memories` to the controlled-writes
 * ADD path, landing a real `memories` row that is then recallable. Builds an `add`
 * proposal at a deliberate-write confidence so the ADD gate passes, and applies it
 * through the existing engine. Returns the engine outcome (the new/deduped id).
 */
export async function storeMemory(
	request: StoreMemoryRequest,
	deps: MemoryWriteDeps,
): Promise<MemoryWriteResult> {
	const config = baseConfig(deps);
	const proposal: Proposal = {
		action: "add",
		confidence: DELIBERATE_WRITE_CONFIDENCE,
		reason: "user store via /api/memories",
	};
	const outcome = await applyControlledWrite(
		{
			proposal,
			content: request.content,
			normalizedContent: request.normalizedContent ?? request.content,
			factConfidence: DELIBERATE_WRITE_CONFIDENCE,
			...(request.type !== undefined ? { factType: request.type } : {}),
			...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
		},
		request.scope,
		writeDeps(deps, config),
	);
	return { outcome, audited: false };
}

/**
 * Modify a memory (a-AC-4 / FR-5): wire `memory_modify` to the controlled-writes
 * UPDATE path as an append-only version bump (NEVER an in-place UPDATE), and write
 * an append-only `memory_history` audit row recording the reason. Refuses a blank
 * reason (the handler's zod already 400s; this is defense in depth).
 */
export async function modifyMemory(
	request: MutateMemoryRequest,
	deps: MemoryWriteDeps,
): Promise<MemoryWriteResult> {
	return mutateMemory("modify", "update", request, deps);
}

/**
 * Forget a memory (a-AC-4 / FR-5): wire `memory_forget` to the controlled-writes
 * DELETE path as an append-only version-bumped soft-delete (tombstone, `is_deleted = 1`),
 * and write an append-only `memory_history` audit row recording the reason.
 */
export async function forgetMemory(
	request: MutateMemoryRequest,
	deps: MemoryWriteDeps,
): Promise<MemoryWriteResult> {
	return mutateMemory("forget", "delete", request, deps);
}

/** The shared modify/forget body: reason-gate → engine version bump → audit row. */
async function mutateMemory(
	operation: "modify" | "forget",
	action: "update" | "delete",
	request: MutateMemoryRequest,
	deps: MemoryWriteDeps,
): Promise<MemoryWriteResult> {
	// a-AC-4: reason-gate (defense in depth; the handler's zod already 400s a missing reason).
	if (request.reason.trim() === "") {
		throw new MemoryReasonRequiredError(operation);
	}

	const config = buildMutateConfig(baseConfig(deps));
	const content = action === "update" ? (request.content ?? "") : "";
	const proposal: Proposal = {
		action,
		targetId: request.id,
		confidence: DELIBERATE_WRITE_CONFIDENCE,
		reason: request.reason,
	};
	const outcome = await applyControlledWrite(
		{
			proposal,
			content,
			normalizedContent: content,
			factConfidence: DELIBERATE_WRITE_CONFIDENCE,
			...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
		},
		request.scope,
		writeDeps(deps, config),
	);

	// a-AC-4 / FR-5: write the append-only audit row so the mutation is accountable.
	//
	// ── Ordering (security L-1): mutate FIRST, then audit. ───────────────────────
	// The version-bump mutation lands before the `memory_history` row is written. On
	// the append-only DeepLake backend the mutation cannot be rolled back, and an
	// audit-first ordering would risk an audit row for a mutation that then fails — a
	// worse asymmetry. So the mutation leads and the audit follows. Critically, an
	// audit-write failure is NOT swallowed: `writeAuditRow` returns `false`, which is
	// SURFACED on the response as `audited:false` (the handler serializes it) so a
	// mutation whose provenance row failed to land is OBSERVABLE, never silent. The
	// reason-gate (the accountability requirement) is enforced at the zod boundary +
	// here BEFORE the mutation, so a reasonless mutation can never land in the first
	// place. This is the accepted L-1 posture (no silent mutation; `audited` observable).
	const audited = await writeAuditRow(operation, request, deps);
	return { outcome, audited };
}

/** Thrown when a modify/forget reaches the engine with a blank reason (should never happen post-zod). */
export class MemoryReasonRequiredError extends Error {
	constructor(operation: MutationOperation) {
		super(`memory ${operation} requires a non-empty reason`);
		this.name = "MemoryReasonRequiredError";
	}
}

/**
 * Write the append-only `memory_history` audit row (FR-5). Records the operation,
 * the target memory id, the actor (`harness` — the user-driven mutate path), and
 * the reason in `after_payload` so a later audit reads exactly why a memory was
 * modified/forgotten. Every value routes through `val.*` and the row is inserted
 * via the guarded `appendOnlyInsert` (no hand-quoted SQL).
 */
async function writeAuditRow(
	operation: "modify" | "forget",
	request: MutateMemoryRequest,
	deps: MemoryWriteDeps,
): Promise<boolean> {
	const now = (deps.now ?? (() => new Date()))().toISOString();
	const auditId = (deps.newId ?? randomUUID)();
	const reasonPayload = JSON.stringify({ operation, reason: request.reason });
	const row: RowValues = [
		["id", val.str(auditId)],
		["memory_id", val.str(request.id)],
		// The user-driven mutate path is a harness-originated change (vs pipeline/pipeline-shadow).
		["changed_by", val.str("harness")],
		["operation", val.str(operation)],
		["before_payload", val.text("")],
		["after_payload", val.text(reasonPayload)],
		["created_at", val.str(now)],
	];
	const result = await appendOnlyInsert(deps.storage, healTargetFor("memory_history"), request.scope, row);
	return isOk(result);
}

/** A stable deterministic hash of content (exposed for tests asserting dedup identity). */
export function memoryContentHash(normalizedContent: string): string {
	return createHash("sha256").update(normalizedContent, "utf8").digest("hex");
}
