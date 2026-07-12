/**
 * ISS-012 REGRESSION — the lifecycle literal GETs must not be shadowed by GET /:id (SP-7 route-order guard).
 *
 * Pre-fix, `GET /api/memories/conflicts`, `/stale-refs`, and `/history` 404'd whenever the full
 * memories API was mounted: `mountMemoriesApi` registered the parametric `GET /:id` FIRST (assemble
 * step 7) and `mountLifecycleApi` registered the literal routes LATER (assemble step 7a-ter) — Hono
 * matches routes in registration order, so `/:id` captured `id === "conflicts"` etc. and answered
 * `{error:"not_found", id:"conflicts"}`. The fix registers the three literals INSIDE
 * `mountMemoriesApi` BEFORE `/:id` (the exact shape of the /prime route-shadow fix, prime.test.ts).
 *
 * These tests mount the seams in the production order and assert all THREE literal routes answer
 * non-404 while `GET /:id` still resolves a real id through the parametric handler.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountMemoriesApi } from "../../../../src/daemon/runtime/memories/index.js";
import { mountLifecycleApi } from "../../../../src/daemon/runtime/memories/lifecycle-api.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** Fully-formed session-group headers (org + runtime-path + session). */
function headers(): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": "sess-iss012",
		"content-type": "application/json",
	};
}

/** A SQL-aware responder: one conflict row, one stale-ref row, one lifecycle-history row, one memory. */
function lifecycleResponder(req: TransportRequest): Record<string, unknown>[] {
	if (/FROM\s+"memory_conflicts"/i.test(req.sql)) {
		return [
			{ id: "c1", memory_a_id: "mem_a", memory_b_id: "mem_b", verdict: "contradicts", winner_id: "", status: "open", contra_score: 0.9 },
		];
	}
	if (/FROM\s+"memory_history"/i.test(req.sql)) {
		return [
			{ id: "h1", memory_id: "mem_a", changed_by: "pipeline", operation: "conflict_detect", after_payload: "{}", created_at: "2026-07-01T00:00:00.000Z" },
		];
	}
	if (/ref_status/i.test(req.sql) && /FROM\s+"memories"/i.test(req.sql)) {
		return [{ id: "mem_s", ref_status: "stale", stale_refs: JSON.stringify(["src/gone.ts"]), verified_at: "2026-07-01T00:00:00.000Z" }];
	}
	if (/FROM\s+"memories"/i.test(req.sql)) {
		return [{ id: "mem_real", content: "a real memory", key: "a real memory" }];
	}
	return [];
}

function makeDaemon() {
	const fake = new FakeDeepLakeTransport(lifecycleResponder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

const LITERAL_ROUTES = ["/api/memories/conflicts", "/api/memories/stale-refs", "/api/memories/history"] as const;

describe("ISS-012 REGRESSION — lifecycle literal GETs win against GET /:id (route-order guard, SP-7)", () => {
	it("mountMemoriesApi alone serves all THREE literal routes non-404 (registered before /:id)", async () => {
		const { daemon, storage } = makeDaemon();
		mountMemoriesApi(daemon, { storage });

		for (const route of LITERAL_ROUTES) {
			const res = await daemon.app.request(route, { method: "GET", headers: headers() });
			expect(res.status, route).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			// The bug signature was the /:id handler's {error:"not_found", id:"conflicts"} — never that.
			expect(body, route).not.toHaveProperty("error");
		}
	});

	it("the three literal routes answer their OWN list shapes (not the /:id memory shape)", async () => {
		const { daemon, storage } = makeDaemon();
		mountMemoriesApi(daemon, { storage });

		const conflicts = (await (await daemon.app.request("/api/memories/conflicts", { method: "GET", headers: headers() })).json()) as {
			conflicts: { id: string }[];
			status: string;
		};
		expect(conflicts.status).toBe("open");
		expect(conflicts.conflicts.map((c) => c.id)).toEqual(["c1"]);

		const staleRefs = (await (await daemon.app.request("/api/memories/stale-refs", { method: "GET", headers: headers() })).json()) as {
			staleRefs: { memoryId: string }[];
		};
		expect(staleRefs.staleRefs.map((s) => s.memoryId)).toEqual(["mem_s"]);

		const history = (await (await daemon.app.request("/api/memories/history?type=lifecycle", { method: "GET", headers: headers() })).json()) as {
			history: { operation: string }[];
			type: string;
		};
		expect(history.type).toBe("lifecycle");
		expect(history.history.map((h) => h.operation)).toEqual(["conflict_detect"]);
	});

	it("mountMemoriesApi + mountLifecycleApi in the production order still routes the literals (the shim's duplicates are never reached)", async () => {
		const { daemon, storage } = makeDaemon();
		// Production order (assemble steps 7 then 7a-ter): the full API mounts first (registers the
		// literals before /:id), THEN the standalone lifecycle seam fires as a back-compat net.
		mountMemoriesApi(daemon, { storage });
		mountLifecycleApi(daemon, { storage });

		for (const route of LITERAL_ROUTES) {
			const res = await daemon.app.request(route, { method: "GET", headers: headers() });
			expect(res.status, route).toBe(200);
			expect((await res.json()) as object, route).not.toHaveProperty("error");
		}
	});

	it("GET /api/memories/:id still resolves a real id through the parametric handler (no regression on /:id)", async () => {
		const { daemon, storage } = makeDaemon();
		mountMemoriesApi(daemon, { storage });
		mountLifecycleApi(daemon, { storage });

		const res = await daemon.app.request("/api/memories/mem_real", { method: "GET", headers: headers() });
		expect([200, 404]).toContain(res.status);
		if (res.status === 200) {
			const body = (await res.json()) as { memory?: { id?: string } };
			expect(body.memory).toBeDefined();
		} else {
			// Even a 404 must be the /:id handler echoing THIS id — proof routing reached /:id.
			const body = (await res.json()) as { error?: string; id?: string };
			expect(body.id).toBe("mem_real");
		}
	});
});
