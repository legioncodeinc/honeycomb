/**
 * ISS-010 — the injected-token KPI read (`fetchInjectedTokens` + the /kpis emission).
 *
 * Proves, against a fake `StorageQuery` / the PRD-002 fake transport (no live DeepLake):
 *   - `fetchInjectedTokens` sums `memory_injections.tokens` through the guarded builder,
 *     narrows to the selected project, and FAILS SOFT to 0 on an empty table or a storage error.
 *   - `fetchKpisView` folds `injectedTokens` into the composed KPI view.
 *   - `GET /api/diagnostics/kpis` emits `injectedTokens` alongside the existing band.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult } from "../../../../src/daemon/storage/result.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	fetchInjectedTokens,
	fetchKpisView,
	mountDashboardApi,
} from "../../../../src/daemon/runtime/dashboard/api.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A simple SQL-routing fake StorageQuery: the handler returns rows or "error" for a query_error. */
function fakeStorage(handler: (sql: string) => Record<string, unknown>[] | "error"): {
	storage: StorageQuery;
	seen: string[];
} {
	const seen: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			seen.push(sql);
			const rows = handler(sql);
			if (rows === "error") return { kind: "query_error", message: "boom" };
			return ok(rows as never, rows.length);
		},
	};
	return { storage, seen };
}

describe("ISS-010 fetchInjectedTokens — the measured injected-token SUM", () => {
	it("reads the COALESCEd SUM through the guarded builder and returns the total", async () => {
		const { storage, seen } = fakeStorage((sql) =>
			/FROM\s+"memory_injections"/i.test(sql) ? [{ tokens: 555 }] : [],
		);
		const total = await fetchInjectedTokens(storage, SCOPE);
		expect(total).toBe(555);
		const sumSql = seen.find((s) => /FROM\s+"memory_injections"/i.test(s)) ?? "";
		expect(sumSql).toContain("COALESCE(SUM(tokens), 0)");
		expect(sumSql).not.toMatch(/GROUP BY/i);
	});

	it("narrows to the selected project via the guarded conjunct; no project → workspace-wide", async () => {
		const { storage, seen } = fakeStorage(() => [{ tokens: 1 }]);
		await fetchInjectedTokens(storage, SCOPE, "proj-web");
		await fetchInjectedTokens(storage, SCOPE);
		expect(seen[0]).toMatch(/WHERE project_id = 'proj-web'/);
		expect(seen[1]).not.toMatch(/project_id/);
	});

	it("FAIL-SOFT: 0 on an empty/missing table (no rows) and 0 on a storage error, never a throw", async () => {
		const empty = fakeStorage(() => []);
		await expect(fetchInjectedTokens(empty.storage, SCOPE)).resolves.toBe(0);
		// A NULL cell (a backend that ignored the COALESCE) still lands as 0 via the toNum guard.
		const nullCell = fakeStorage(() => [{ tokens: null }]);
		await expect(fetchInjectedTokens(nullCell.storage, SCOPE)).resolves.toBe(0);
		const erroring = fakeStorage(() => "error");
		await expect(fetchInjectedTokens(erroring.storage, SCOPE)).resolves.toBe(0);
	});

	it("fetchKpisView folds injectedTokens into the composed view", async () => {
		const { storage } = fakeStorage((sql) => {
			if (/FROM\s+"memory_injections"/i.test(sql)) return [{ tokens: 321 }];
			if (/SUM\(LENGTH/i.test(sql)) return [{ chars: 4000 }];
			return [{ n: 7 }];
		});
		const view = await fetchKpisView(storage, SCOPE);
		expect(view.injectedTokens).toBe(321);
		expect(view.estimatedSavings).toBe(1000); // the corpus-mass proxy is untouched by ISS-010.
	});
});

describe("ISS-010 — GET /api/diagnostics/kpis emits injectedTokens", () => {
	function makeDaemon() {
		const fake = new FakeDeepLakeTransport((req: TransportRequest): Record<string, unknown>[] => {
			const sql = req.sql;
			if (/FROM\s+"memory_injections"/i.test(sql)) return [{ tokens: 777 }];
			if (/SUM\(LENGTH/i.test(sql)) return [{ chars: 4000 }];
			if (/FROM\s+"synced_assets"/i.test(sql)) return [{ n: 3 }];
			if (/COUNT\(\*\).*FROM\s+"memories"/i.test(sql)) return [{ n: 42 }];
			if (/COUNT\(\*\).*FROM\s+"sessions"/i.test(sql)) return [{ n: 7 }];
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const config: RuntimeConfig = { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
		const daemon = createDaemon({ config, storage, logger: createRequestLogger({ silent: true }) });
		mountDashboardApi(daemon, { storage });
		return { daemon, fake };
	}

	it("the /kpis body carries the measured meter NEXT TO the corpus proxy (both, honestly labeled)", async () => {
		const { daemon } = makeDaemon();
		const res = await daemon.app.request("/api/diagnostics/kpis", {
			headers: { "x-honeycomb-org": SCOPE.org, "x-honeycomb-workspace": SCOPE.workspace ?? "" },
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as Record<string, number>;
		expect(json.injectedTokens).toBe(777); // the ISS-010 measured meter.
		expect(json.estimatedSavings).toBe(1000); // the 035b corpus-mass proxy, unchanged.
		expect(json.memoryCount).toBe(42);
	});

	it("the injected SUM rides the SHORT (counts) cache: a same-key re-load issues no new queries", async () => {
		const { daemon, fake } = makeDaemon();
		const headers = { "x-honeycomb-org": SCOPE.org, "x-honeycomb-workspace": SCOPE.workspace ?? "" };
		await daemon.app.request("/api/diagnostics/kpis", { headers });
		const afterFirst = fake.requests.length;
		await daemon.app.request("/api/diagnostics/kpis", { headers });
		expect(fake.requests.length).toBe(afterFirst); // fully served from the TTL caches.
	});
});
