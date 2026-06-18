/**
 * PRD-010 — routing_history catalog + redaction-by-construction tests.
 *
 * Two layers:
 *   1. CATALOG: `routing_history` is in CATALOG with `scope: "none"` +
 *      `pattern: "append-only"`, validates, and resolves via `healTargetFor` —
 *      no live backend (the binding DoD at the catalog level).
 *   2. REDACTION BY CONSTRUCTION: the `RoutingHistoryStore.record` boundary
 *      accepts only a `RedactedRoutingEvent`, and the on-disk `event` JSONB it
 *      builds carries NO secret/key/body — asserted by recording an event through
 *      a fake storage client and inspecting the exact SQL the store emits.
 */

import { describe, expect, it } from "vitest";
import type { RedactedRoutingEvent } from "../../../../src/daemon/runtime/inference/contracts.js";
import { createRoutingHistoryStore } from "../../../../src/daemon/runtime/inference/history-store.js";
import { CATALOG, catalogTable, healTargetFor, REGISTRY } from "../../../../src/daemon/storage/catalog/index.js";
import {
	ROUTING_HISTORY_COLUMNS,
	ROUTING_HISTORY_TABLE,
} from "../../../../src/daemon/storage/catalog/routing-history.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult } from "../../../../src/daemon/storage/result.js";
import { validateColumnDefs } from "../../../../src/daemon/storage/schema.js";

/** Find a column's `sql` from a ColumnDef array. */
function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

/** A recording fake storage client that captures every SQL string it is handed. */
function recordingStorage(): { query: (sql: string, scope: QueryScope) => Promise<QueryResult>; sql: string[] } {
	const sql: string[] = [];
	return {
		sql,
		query(statement: string): Promise<QueryResult> {
			sql.push(statement);
			return Promise.resolve(ok([], 0));
		},
	};
}

describe("PRD-010 routing_history catalog table", () => {
	it("carries the telemetry columns: id, org_id, workspace_id, request_id, workload, created_at, event(JSONB)", () => {
		expect(() => validateColumnDefs(ROUTING_HISTORY_TABLE, ROUTING_HISTORY_COLUMNS)).not.toThrow();
		expect(colSql(ROUTING_HISTORY_COLUMNS, "id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(ROUTING_HISTORY_COLUMNS, "org_id")).toBeDefined();
		expect(colSql(ROUTING_HISTORY_COLUMNS, "workspace_id")).toBeDefined();
		expect(colSql(ROUTING_HISTORY_COLUMNS, "request_id")).toBeDefined();
		expect(colSql(ROUTING_HISTORY_COLUMNS, "workload")).toBeDefined();
		expect(colSql(ROUTING_HISTORY_COLUMNS, "created_at")).toBeDefined();
		// event is a nullable JSONB body (the sanctioned schemaless use).
		expect(colSql(ROUTING_HISTORY_COLUMNS, "event")).toBe("JSONB");
	});

	it("flows into CATALOG + REGISTRY as append-only / scope none (D-7)", () => {
		const record = catalogTable(ROUTING_HISTORY_TABLE);
		expect(record, "routing_history in the catalog").toBeDefined();
		expect(record?.pattern).toBe("append-only");
		expect(record?.scope).toBe("none");
		expect(record?.embeddingColumns).toEqual([]);
		expect(REGISTRY.primitiveFor(ROUTING_HISTORY_TABLE)).toBe("appendOnlyInsert");
		expect(CATALOG.some((t) => t.name === ROUTING_HISTORY_TABLE)).toBe(true);
		expect(healTargetFor(ROUTING_HISTORY_TABLE).table).toBe(ROUTING_HISTORY_TABLE);
	});
});

describe("PRD-010 redaction by construction (c-AC-6 / d-AC-5 at the impl level)", () => {
	const scope: QueryScope = { org: "org-1", workspace: "ws-1" };

	/** A redacted event carrying only routing metadata (the only shape `record` accepts). */
	const event: RedactedRoutingEvent = {
		requestId: "req-123",
		workload: "memory_extraction",
		servingTarget: "sonnet",
		mode: "strict",
		attempts: [
			{ targetId: "haiku", outcome: "failed", statusCode: 503, reason: "5xx" },
			{ targetId: "sonnet", outcome: "selected" },
		],
		blockedCandidates: [{ targetId: "opus", reason: "privacy" }],
	};

	it("records the event as an append-only INSERT carrying only redacted metadata", async () => {
		const storage = recordingStorage();
		const store = createRoutingHistoryStore({ storage, scope, clock: { now: () => 1_700_000_000_000 } });
		await store.record(event);

		// Exactly one INSERT into routing_history (append-only, heal probes aside the
		// fake never errors so no heal retry fires).
		const insert = storage.sql.find((s) => s.includes("INSERT INTO") && s.includes("routing_history"));
		expect(insert, "an append-only INSERT into routing_history").toBeDefined();
		const stmt = insert as string;
		// The redacted metadata IS present: request id, workload, serving target,
		// status code, gate reason.
		expect(stmt).toContain("req-123");
		expect(stmt).toContain("memory_extraction");
		expect(stmt).toContain("sonnet");
		expect(stmt).toContain("503");
		expect(stmt).toContain("privacy");
	});

	it("the recorded SQL can carry no secret/key/body — the event type forbids it", async () => {
		const storage = recordingStorage();
		const store = createRoutingHistoryStore({ storage, scope, clock: { now: () => 1_700_000_000_000 } });
		await store.record(event);
		const all = storage.sql.join("\n");
		// There is no field on RedactedRoutingEvent that can hold a key/prompt/
		// completion, so the emitted SQL contains none — a compile-time guarantee
		// re-checked at runtime. (A leak would require widening the event type.)
		expect(all).not.toMatch(/sk-[A-Za-z0-9]/);
		expect(all).not.toContain("ANTHROPIC_API_KEY");
		expect(all).not.toContain("messages");
		expect(all).not.toContain("completion");
	});
});
