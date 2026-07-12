/**
 * ISS-010 — the injected-token telemetry writer: `recordInjection`.
 *
 * The WRITE seam for the `memory_injections` table (`catalog/memory-injections.ts`):
 * one append-only row per injection event — a recall response or a prime digest
 * served to a harness. Modeled byte-for-byte on `recordAccess`
 * (`../memories/access-log.ts`): the same injectable clock/id deps, the same
 * `appendOnlyInsert` + `healTargetFor` write path (lazy CREATE on first write, no
 * migration), the same agent-scope defaulting (`'default'` / `'global'`).
 *
 * ── Fail-soft (the one rule that cannot bend) ────────────────────────────────
 * Telemetry must NEVER cost a capture or a recall: `recordInjection` NEVER
 * throws. Any storage failure — a missing table on a fresh partition, a
 * transient flap, a misbehaving injected dep — resolves to `{ appended: false }`.
 * Call sites fire-and-forget (`void recordInjection(...)`) so the response path
 * is byte-identical with or without the append landing.
 *
 * ── Skip-on-zero ─────────────────────────────────────────────────────────────
 * A zero-hit or zero-token event carries no metering signal (the KPI sums
 * `tokens`), so the write is SKIPPED entirely when the clamped `hits <= 0` or
 * `tokens <= 0` — the table never accumulates empty rows from cold recalls.
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every value routes through the `writes.ts` `val.*` constructors; the counters
 * are clamped (`Math.max(0, Math.trunc(...))`) before they are inlined into the
 * BIGINT columns (no floats, no negatives). All storage access is through the
 * injected {@link StorageQuery}, never a raw fetch (`audit:sql` clean).
 */

import { randomUUID } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import {
	healTargetFor,
	type InjectionSource,
	isInjectionSource,
	MEMORY_INJECTIONS_TABLE,
} from "../../storage/catalog/index.js";
import { isOk } from "../../storage/result.js";
import { appendOnlyInsert, val, type RowValues } from "../../storage/writes.js";
import type { AgentScope } from "../memories/access-log.js";

/** The schema-default `agent_id` (mirrors `memory_injections.agent_id DEFAULT 'default'`). */
const DEFAULT_AGENT_ID = "default" as const;
/** The schema-default `visibility` (mirrors `memory_injections.visibility DEFAULT 'global'`). */
const DEFAULT_VISIBILITY = "global" as const;

/** Construction deps for the injection-log write (injectable clock + id for determinism). */
export interface InjectionLogDeps {
	/** The DeepLake storage client (daemon-only). The write runs through this. */
	readonly storage: StorageQuery;
	/** A clock for the event `at` stamp; defaults to wall-clock. A test injects a fixed clock. */
	readonly now?: () => Date;
	/** An id generator for the event row; defaults to a UUID. A test injects a deterministic one. */
	readonly newId?: () => string;
}

/** One injection event to meter (a recall response or a prime digest served). */
export interface InjectionEvent {
	/** Which read path served the tokens. Gated through {@link isInjectionSource} before write. */
	readonly source: InjectionSource;
	/** How many hits/entries rode this injection (clamped to a non-negative integer). */
	readonly hits: number;
	/** The estimated token count SERVED (clamped to a non-negative integer). */
	readonly tokens: number;
	/** The harness session id (`x-honeycomb-session`), or `""` when none rode the request. */
	readonly sessionId?: string;
	/** The resolved project id when the request was project-bound, else `""`. */
	readonly projectId?: string;
	/** The owning agent scope; ABSENT → the schema defaults (`'default'` / `'global'`). */
	readonly agent?: AgentScope;
}

/**
 * Resolve an {@link AgentScope} to its concrete `(agentId, visibility)`, applying the schema
 * defaults (the same resolution `recordAccess` applies — an un-scoped caller still writes a
 * self-consistent row, never a partial one).
 */
function resolveAgentScope(agent?: AgentScope): { agentId: string; visibility: string } {
	const agentId = agent?.agentId !== undefined && agent.agentId !== "" ? agent.agentId : DEFAULT_AGENT_ID;
	const visibility = agent?.visibility !== undefined && agent.visibility !== "" ? agent.visibility : DEFAULT_VISIBILITY;
	return { agentId, visibility };
}

/**
 * Record ONE injection event (ISS-010). Appends `(id, at, source, hits, tokens, session_id,
 * project_id, agent_id, visibility)` to `memory_injections` (append-only, heal-aware — lazy
 * CREATE on first write). SKIPS the write when the clamped `hits <= 0` or `tokens <= 0` (a
 * zero event carries no metering signal). FAIL-SOFT: NEVER throws — telemetry must not cost
 * a capture/recall; any failure resolves `{ appended: false }`.
 */
export async function recordInjection(
	event: InjectionEvent,
	deps: InjectionLogDeps,
	scope: QueryScope,
): Promise<{ appended: boolean }> {
	try {
		// Gate the closed taxonomy at the boundary (defense in depth: the type already narrows it,
		// but a caller crossing this seam with a widened string must not write an unknown source).
		if (!isInjectionSource(event.source)) return { appended: false };
		// Clamp: BIGINT columns, no floats, no negatives.
		const hits = Math.max(0, Math.trunc(event.hits));
		const tokens = Math.max(0, Math.trunc(event.tokens));
		// Skip-on-zero: a zero-hit / zero-token event carries no metering signal.
		if (hits <= 0 || tokens <= 0) return { appended: false };

		const now = (deps.now ?? (() => new Date()))();
		const agentScope = resolveAgentScope(event.agent);
		const row: RowValues = [
			["id", val.str((deps.newId ?? randomUUID)())],
			["at", val.str(now.toISOString())],
			["source", val.str(event.source)],
			["hits", val.num(hits)],
			["tokens", val.num(tokens)],
			["session_id", val.str(event.sessionId ?? "")],
			["project_id", val.str(event.projectId ?? "")],
			["agent_id", val.str(agentScope.agentId)],
			["visibility", val.str(agentScope.visibility)],
		];
		const res = await appendOnlyInsert(deps.storage, healTargetFor(MEMORY_INJECTIONS_TABLE), scope, row);
		return { appended: isOk(res) };
	} catch {
		// Fail-soft by contract: telemetry never costs the serving path (see module doc). The
		// dropped event is the accepted trade — the KPI is a meter, not a ledger of record.
		return { appended: false };
	}
}
