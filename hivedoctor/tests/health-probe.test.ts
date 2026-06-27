/** Health probe classification tests over a real ephemeral node:http server. */

import { afterEach, describe, expect, it } from "vitest";

import { parseReasons, probeHealth } from "../src/health-probe.js";
import { degradedBody, okBody, startMockHealthServer, type MockHealthServer } from "./helpers/health-server.js";

let server: MockHealthServer | undefined;

afterEach(async () => {
	if (server) await server.close();
	server = undefined;
});

describe("probeHealth classification", () => {
	it("classifies a 200 ok response as ok", async () => {
		server = await startMockHealthServer(okBody);
		const result = await probeHealth({ healthUrl: server.url, timeoutMs: 1_000 });
		expect(result.kind).toBe("ok");
	});

	it("classifies an answered-but-degraded response, carrying subsystem reasons", async () => {
		server = await startMockHealthServer(() => degradedBody({ storage: "unreachable", schema: "missing_table" }));
		const result = await probeHealth({ healthUrl: server.url, timeoutMs: 1_000 });
		expect(result.kind).toBe("degraded");
		if (result.kind === "degraded") {
			expect(result.reasons.storage).toBe("unreachable");
			expect(result.reasons.schema).toBe("missing_table");
		}
	});

	it("classifies a non-200 answer as degraded", async () => {
		server = await startMockHealthServer(() => ({ statusCode: 503, body: JSON.stringify({ status: "degraded" }) }));
		const result = await probeHealth({ healthUrl: server.url, timeoutMs: 1_000 });
		expect(result.kind).toBe("degraded");
	});

	it("classifies a refused connection as unreachable-refused", async () => {
		// Start then immediately close so the port is closed -> ECONNREFUSED.
		const s = await startMockHealthServer(okBody);
		const url = s.url;
		await s.close();
		const result = await probeHealth({ healthUrl: url, timeoutMs: 1_000 });
		expect(result.kind).toBe("unreachable-refused");
	});

	it("classifies a hung socket as unreachable-timeout", async () => {
		server = await startMockHealthServer(okBody);
		server.setHang(true);
		const result = await probeHealth({ healthUrl: server.url, timeoutMs: 150 });
		expect(result.kind).toBe("unreachable-timeout");
	});
});

describe("parseReasons", () => {
	it("extracts the storage/embeddings/schema fields", () => {
		const r = parseReasons(JSON.stringify({ reasons: { storage: "reachable", embeddings: "off", schema: "ok" } }));
		expect(r).toEqual({ storage: "reachable", embeddings: "off", schema: "ok" });
	});

	it("returns an empty object for a body with no reasons block", () => {
		expect(parseReasons(JSON.stringify({ status: "ok" }))).toEqual({
			storage: undefined,
			embeddings: undefined,
			schema: undefined,
		});
	});

	it("returns {} for unparseable body (never throws)", () => {
		expect(parseReasons("not json")).toEqual({});
	});
});
