/**
 * PRD-024 Wave 3 — the dashboard WIRE-LAYER header contract suite.
 *
 * The live-dogfood blind spot: the DOM/app suite mocks `fetch` and only asserts the rendered
 * output, so it never checked WHAT HEADERS the client sends. The live daemon's `/api/memories`
 * group sits behind the runtime-path + session middleware
 * (`src/daemon/runtime/middleware/runtime-path.ts`), which REQUIRES
 * `x-honeycomb-runtime-path: plugin|legacy` AND a non-empty `x-honeycomb-session`. Because the
 * browser client never stamped them, recall (and every diagnostics view) 400'd live and every
 * panel blanked.
 *
 * This suite captures the `init` arg of each `fetchImpl(...)` call and asserts the two
 * non-tenant session headers ARE present — the assertion that would have caught the live
 * failure. It also asserts the client does NOT stamp `x-honeycomb-org` (the local default
 * supplies it; a wrong/empty org would trip the cross-tenant guard).
 */

import { describe, expect, it, vi } from "vitest";

import {
	createWireClient,
	DASHBOARD_SESSION_HEADERS,
	EMPTY_VAULT_SETTINGS,
	HealthBodySchema,
	HealthReasonsSchema,
	SecretNamesSchema,
	VaultSettingsSchema,
} from "../../../src/dashboard/web/wire.js";

/** Lowercase a HeadersInit (object | Headers | array) into a flat record for assertion. */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const h = init?.headers;
	if (h === undefined) return out;
	if (h instanceof Headers) {
		h.forEach((v, k) => (out[k.toLowerCase()] = v));
	} else if (Array.isArray(h)) {
		for (const [k, v] of h) out[k.toLowerCase()] = v;
	} else {
		for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
	}
	return out;
}

/** A fetch mock that records (url, init) for every call and returns a canned JSON body. */
function recordingFetch(body: unknown): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: typeof input === "string" ? input : input.toString(), init });
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("PRD-024 Wave 3: the wire client stamps the runtime-path + session headers", () => {
	it("the recall POST carries x-honeycomb-runtime-path: plugin and a non-empty x-honeycomb-session", async () => {
		const { fetchImpl, calls } = recordingFetch({ hits: [], sources: [], degraded: false });
		const client = createWireClient({ fetchImpl });
		await client.recall("anything");

		const recallCall = calls.find((c) => c.url.includes("/api/memories/recall"));
		expect(recallCall, "recall hit the endpoint").toBeTruthy();
		const headers = headerRecord(recallCall?.init);
		// THE assertion that would have caught the live 400: the session middleware contract.
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
		expect(headers["x-honeycomb-session"].length).toBeGreaterThan(0);
		// It is a POST with the JSON content-type still present (not clobbered by the merge).
		expect(recallCall?.init?.method).toBe("POST");
		expect(headers["content-type"]).toBe("application/json");
		// It must NOT forge a tenant org (the daemon's local default supplies it).
		expect(headers["x-honeycomb-org"]).toBeUndefined();
	});

	it("a diagnostics GET (kpis) carries the same runtime-path + session headers", async () => {
		const { fetchImpl, calls } = recordingFetch({ memoryCount: 0, sessionCount: 0, estimatedSavings: 0 });
		const client = createWireClient({ fetchImpl });
		await client.kpis();

		const kpisCall = calls.find((c) => c.url.includes("/api/diagnostics/kpis"));
		expect(kpisCall, "kpis hit the endpoint").toBeTruthy();
		const headers = headerRecord(kpisCall?.init);
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
		// The accept header is preserved alongside the stamped session headers.
		expect(headers["accept"]).toBe("application/json");
		// No tenant org forged on the GET either.
		expect(headers["x-honeycomb-org"]).toBeUndefined();
	});

	it("the exported header constant carries exactly the two non-credential session headers", () => {
		// No token/secret/credential rides these (D-4): only the runtime-path + session id.
		expect(DASHBOARD_SESSION_HEADERS["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(DASHBOARD_SESSION_HEADERS["x-honeycomb-session"]).toBe("dashboard-web");
		const keys = Object.keys(DASHBOARD_SESSION_HEADERS).map((k) => k.toLowerCase());
		for (const forbidden of ["authorization", "x-honeycomb-org", "x-honeycomb-token", "cookie"]) {
			expect(keys).not.toContain(forbidden);
		}
	});
});

describe("PRD-027 AC-4: recall() carries the ENGINE score in ENGINE order (no `1 - i*0.06` fabrication)", () => {
	/** A fetch mock that answers the recall POST with a canned `{hits,sources,degraded}` body. */
	function recallFetch(body: unknown): typeof fetch {
		return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/memories/recall")) {
				return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
	}

	it("maps each hit to the ENGINE `score`/`kind`/`secondary`, preserving the engine's order (no re-sort)", async () => {
		// The engine returns hits ALREADY ranked DESC by fused RRF — a distilled `memory` fact (0.42)
		// ahead of a raw `session` drill-down (0.17). The OLD fabrication (`1 - i*0.06`) would have
		// stamped 1.00 then 0.94 regardless of these values; the engine score must win.
		const fetchImpl = recallFetch({
			hits: [
				{ source: "memories", id: "deploy/prd-022", text: "distilled fact", score: 0.42, kind: "memory", secondary: false },
				{ source: "sessions", id: "sess-9", text: "raw session dump", score: 0.17, kind: "session", secondary: true },
			],
			sources: ["memories", "sessions"],
			degraded: false,
		});
		const client = createWireClient({ fetchImpl });
		const { memories, degraded } = await client.recall("how do we deploy");

		expect(degraded).toBe(false);
		// ENGINE order preserved verbatim — the distilled fact first, the raw session second.
		expect(memories.map((m) => m.memoryKey)).toEqual(["deploy/prd-022", "sess-9"]);
		// The ENGINE score rides through — NOT the fabricated `1 - i*0.06` (which would be 1.00 / 0.94).
		expect(memories[0]?.score).toBe(0.42);
		expect(memories[1]?.score).toBe(0.17);
		expect(memories[0]?.score).not.toBe(1); // the old fabrication's first value is gone
		// Provenance class threads through so the card can demote the raw session row.
		expect(memories[0]?.kind).toBe("memory");
		expect(memories[0]?.secondary).toBe(false);
		expect(memories[1]?.kind).toBe("session");
		expect(memories[1]?.secondary).toBe(true);
	});

	it("a hit with a LOWER score earlier in the list is NOT re-sorted (the engine owns the order)", async () => {
		// Defensive: even if the engine ever emitted a locally-out-of-DESC pair, the client renders
		// the engine order verbatim — it never re-sorts. (The engine guarantees DESC; the client trusts it.)
		const fetchImpl = recallFetch({
			hits: [
				{ source: "memories", id: "a", text: "first", score: 0.3, kind: "memory", secondary: false },
				{ source: "memory", id: "b", text: "second", score: 0.9, kind: "memory", secondary: false },
			],
			sources: ["memories", "memory"],
			degraded: false,
		});
		const client = createWireClient({ fetchImpl });
		const { memories } = await client.recall("q");
		// Order is the WIRE order (a, b) — the client did not sort b ahead of a on its 0.9 score.
		expect(memories.map((m) => m.memoryKey)).toEqual(["a", "b"]);
		expect(memories.map((m) => m.score)).toEqual([0.3, 0.9]);
	});

	it("degrades gracefully when an older daemon omits score/kind/secondary (.catch defaults)", async () => {
		// A pre-Wave-1 daemon sends only `{source,id,text}`; the schema `.catch()`es to safe defaults
		// (score 0, kind "memory", secondary false) so the client still renders rather than throwing.
		const fetchImpl = recallFetch({
			hits: [{ source: "memory", id: "old", text: "legacy hit" }],
			sources: ["memory"],
			degraded: true,
		});
		const client = createWireClient({ fetchImpl });
		const { memories } = await client.recall("q");
		expect(memories).toHaveLength(1);
		expect(memories[0]?.score).toBe(0);
		expect(memories[0]?.kind).toBe("memory");
		expect(memories[0]?.secondary).toBe(false);
	});
});

describe("PRD-029: health() threads the per-subsystem reasons through the IO boundary defensively", () => {
	/** A fetch mock answering /health with a given body + HTTP status; everything else 404s. */
	function healthFetch(body: BodyInit | null, status = 200): typeof fetch {
		return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/health")) return new Response(body, { status, headers: { "content-type": "application/json" } });
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
	}

	it("a local /health body with reasons → { up:true, reasons:{…} } parsed through zod", async () => {
		const client = createWireClient({
			fetchImpl: healthFetch(JSON.stringify({ status: "ok", pipeline: "ok", reasons: { storage: "reachable", embeddings: "off", schema: "ok" } })),
		});
		const probe = await client.health();
		expect(probe.up).toBe(true);
		expect(probe.reasons).toEqual({ storage: "reachable", embeddings: "off", schema: "ok" });
	});

	it("a public body WITHOUT reasons (mode-gated) → { up:true, reasons:null } — no throw", async () => {
		const client = createWireClient({ fetchImpl: healthFetch(JSON.stringify({ status: "ok", pipeline: "ok" })) });
		const probe = await client.health();
		expect(probe.up).toBe(true);
		expect(probe.reasons).toBeNull();
	});

	it("an EMPTY body (the 503-degraded / bare-200 path) → reasons:null, up tracks res.ok", async () => {
		// Degraded daemon: 503 + empty body. `up` is false (res.ok), reasons null (json() throws, caught).
		const down = createWireClient({ fetchImpl: healthFetch("", 503) });
		const downProbe = await down.health();
		expect(downProbe.up).toBe(false);
		expect(downProbe.reasons).toBeNull();
		// Healthy daemon, but an empty 200 body (pre-029 servers): up true, reasons null, still no throw.
		const up = createWireClient({ fetchImpl: healthFetch("", 200) });
		const upProbe = await up.health();
		expect(upProbe.up).toBe(true);
		expect(upProbe.reasons).toBeNull();
	});

	it("a malformed reasons block degrades each field to its HEALTHY default (no throw into React)", () => {
		// An unknown enum value / wrong type for a field `.catch()`es to the healthy literal.
		const parsed = HealthReasonsSchema.parse({ storage: "weird", embeddings: 42, schema: null });
		expect(parsed).toEqual({ storage: "reachable", embeddings: "on", schema: "ok" });
	});

	it("a network error → { up:false, reasons:null }", async () => {
		const fetchImpl = vi.fn(async (): Promise<Response> => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const probe = await createWireClient({ fetchImpl }).health();
		expect(probe).toEqual({ up: false, reasons: null });
	});

	it("AC-5: the reasons schema is a CLOSED enum set — it cannot carry a free-form secret string", () => {
		// A body trying to smuggle a token into a reason field is rejected → healthy default, never echoed.
		const parsed = HealthBodySchema.parse({ status: "ok", reasons: { storage: "Bearer sk-secret-123", embeddings: "on", schema: "ok" } });
		expect(parsed.reasons?.storage).toBe("reachable"); // the smuggled string is dropped, not surfaced
		expect(JSON.stringify(parsed)).not.toContain("sk-secret-123");
	});
});

describe("PRD-032c: the wire client threads /api/settings (GET+POST) + names-only /api/secrets defensively", () => {
	/** A fetch mock that records (url, init) and routes settings/secrets paths to canned bodies. */
	function vaultFetch(opts: { settings?: unknown; secrets?: unknown; postStatus?: number } = {}): {
		fetchImpl: typeof fetch;
		calls: { url: string; init?: RequestInit }[];
	} {
		const calls: { url: string; init?: RequestInit }[] = [];
		const settings = opts.settings ?? {
			settings: { activeProvider: "anthropic", activeModel: "claude-opus-4-8", "pollinating.enabled": true },
			catalog: [{ id: "anthropic", label: "Anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-8"], openEnded: false }],
		};
		const secrets = opts.secrets ?? { names: ["ANTHROPIC_API_KEY", "DEEPLAKE_TOKEN"] };
		const postStatus = opts.postStatus ?? 201;
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push({ url, init });
			const json = (body: unknown, status = 200): Response =>
				new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			// POST /api/settings/:key — the write. Echo an ok body at the configured status.
			if (url.includes("/api/settings/") && init?.method === "POST") return json({ ok: postStatus < 300 }, postStatus);
			if (url.endsWith("/api/settings") || url.includes("/api/settings?")) return json(settings);
			if (url.endsWith("/api/secrets") || url.includes("/api/secrets?")) return json(secrets);
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
		return { fetchImpl, calls };
	}

	it("vaultSettings() GETs /api/settings and parses { settings, catalog } through zod", async () => {
		const { fetchImpl, calls } = vaultFetch();
		const out = await createWireClient({ fetchImpl }).vaultSettings();
		expect(out.settings["activeProvider"]).toBe("anthropic");
		expect(out.settings["activeModel"]).toBe("claude-opus-4-8");
		expect(out.settings["pollinating.enabled"]).toBe(true);
		expect(out.catalog).toHaveLength(1);
		expect(out.catalog[0]?.models).toContain("claude-opus-4-8");
		// It hit the settings GET (no method = GET) with the session headers.
		const getCall = calls.find((c) => c.url.endsWith("/api/settings"));
		expect(getCall).toBeTruthy();
		const headers = headerRecord(getCall?.init);
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
	});

	it("a malformed /api/settings body degrades to the empty view — never a throw", async () => {
		const { fetchImpl } = vaultFetch({ settings: { settings: "not-an-object", catalog: "nope" } });
		const out = await createWireClient({ fetchImpl }).vaultSettings();
		// Each field `.catch()`es to its empty default; the panel renders its empty state.
		expect(out).toEqual(EMPTY_VAULT_SETTINGS);
	});

	it("a totally absent /api/settings (404) → the empty vault-settings view (safe default)", async () => {
		const fetchImpl = vi.fn(async (): Promise<Response> => new Response("nope", { status: 404 })) as unknown as typeof fetch;
		const out = await createWireClient({ fetchImpl }).vaultSettings();
		expect(out).toEqual(EMPTY_VAULT_SETTINGS);
	});

	it("setSetting() POSTs /api/settings/:key with a JSON { value } body + session headers", async () => {
		const { fetchImpl, calls } = vaultFetch();
		const ok = await createWireClient({ fetchImpl }).setSetting("activeProvider", "openai");
		expect(ok).toBe(true);
		const postCall = calls.find((c) => c.url.includes("/api/settings/activeProvider") && c.init?.method === "POST");
		expect(postCall, "the POST hit /api/settings/activeProvider").toBeTruthy();
		// The body carries the value (a scalar) the Wave-1 handler reads.
		expect(JSON.parse(String(postCall?.init?.body))).toEqual({ value: "openai" });
		// The non-tenant session headers ride the POST (the protected group requires them).
		const headers = headerRecord(postCall?.init);
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
		expect(headers["content-type"]).toBe("application/json");
		// It does NOT forge a tenant org.
		expect(headers["x-honeycomb-org"]).toBeUndefined();
	});

	it("setSetting() encodes a dotted dashboard key into a single safe path segment", async () => {
		const { fetchImpl, calls } = vaultFetch();
		await createWireClient({ fetchImpl }).setSetting("pollinating.enabled", false);
		const postCall = calls.find((c) => c.init?.method === "POST");
		// The dotted key is encodeURIComponent'd; it remains a single segment under /api/settings/.
		expect(postCall?.url).toContain("/api/settings/pollinating.enabled");
		expect(JSON.parse(String(postCall?.init?.body))).toEqual({ value: false });
	});

	it("setSetting() returns false on a rejected write (daemon 400) without throwing", async () => {
		const { fetchImpl } = vaultFetch({ postStatus: 400 });
		const ok = await createWireClient({ fetchImpl }).setSetting("activeModel", "not-a-real-model");
		expect(ok).toBe(false);
	});

	it("setSetting() returns false on a network error (never throws into the caller)", async () => {
		const fetchImpl = vi.fn(async (): Promise<Response> => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const ok = await createWireClient({ fetchImpl }).setSetting("activeProvider", "anthropic");
		expect(ok).toBe(false);
	});

	it("secretNames() returns the NAMES list only (presence) — never a value", async () => {
		const { fetchImpl } = vaultFetch();
		const names = await createWireClient({ fetchImpl }).secretNames();
		expect(names).toEqual(["ANTHROPIC_API_KEY", "DEEPLAKE_TOKEN"]);
		// The body shape is names-only by construction — no `value`/`values` key exists to leak.
		const parsed = SecretNamesSchema.parse({ names: ["X"], values: { X: "sk-leak" } });
		expect(parsed).toEqual({ names: ["X"] }); // an extra `values` is stripped, never surfaced
		expect(JSON.stringify(parsed)).not.toContain("sk-leak");
	});

	it("a malformed /api/secrets body → an empty name list (every provider reads 'not set')", async () => {
		const { fetchImpl } = vaultFetch({ secrets: { names: "boom" } });
		const names = await createWireClient({ fetchImpl }).secretNames();
		expect(names).toEqual([]);
	});

	it("VaultSettingsSchema only accepts SCALAR setting values (a structured value is not surfaced as-is)", () => {
		// The class stores scalars; a stray object value `.catch()`es to "" rather than riding through.
		const parsed = VaultSettingsSchema.parse({ settings: { weird: { nested: "obj" } }, catalog: [] });
		expect(parsed.settings["weird"]).toBe("");
	});
});
