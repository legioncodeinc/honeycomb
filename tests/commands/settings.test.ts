/**
 * PRD-032b — the `honeycomb settings` thin-client verb + provider→model selector (AC-4 / b-AC-1..4).
 *
 * Proves the verb is a THIN CLIENT routed through the {@link DaemonClient} seam:
 *   - `settings list`            → `GET /api/settings`, renders settings + catalog, prints NO secret;
 *   - `settings get <key>`       → `GET /api/settings/:key`;
 *   - `settings set <key> <val>` → `POST /api/settings/:key` carrying the typed value in the body;
 *   - `settings provider <id> --model <m>` → validates against the SINGLE-SOURCED catalog, then
 *     writes `activeProvider` THEN `activeModel` (an off-catalog provider/model is rejected
 *     client-side; OpenRouter accepts a free-form id, D-6);
 *   - the dispatcher routes `settings` to the daemon seam (no DeepLake import — enforced by the
 *     `src/commands` NON_DAEMON_ROOT invariant test);
 *   - `set` NEVER prints a secret value; the existing `secret` verb stays names-only on
 *     `/api/secrets` (no value-returning verb is added).
 *
 * Every case drives an injected {@link FakeDaemonClient} (mirrors pollinate.test.ts) — no socket, no
 * live daemon, no model, no live run.
 */

import { describe, expect, it } from "vitest";

import {
	type CommandDeps,
	buildStorageRequest,
	coerceSettingValue,
	createDispatcher,
	createFakeDaemonClient,
	parseSettingsCliArgs,
	runSettingsVerb,
	SETTINGS_ENDPOINT,
	STORAGE_VERB_ROUTES,
} from "../../src/commands/index.js";

/** Collect a handler's output lines for assertion. */
function withSink(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line: string) => lines.push(line), lines };
}

describe("PRD-032b — `honeycomb settings` parse + routing", () => {
	it("parseSettingsCliArgs reads subcommand, positional args, and --model", () => {
		expect(parseSettingsCliArgs(["list"])).toEqual({ subCommand: "list", args: [], model: "" });
		expect(parseSettingsCliArgs(["get", "activeModel"])).toEqual({
			subCommand: "get",
			args: ["activeModel"],
			model: "",
		});
		expect(parseSettingsCliArgs(["set", "pollinating.enabled", "true"])).toEqual({
			subCommand: "set",
			args: ["pollinating.enabled", "true"],
			model: "",
		});
		expect(parseSettingsCliArgs(["provider", "anthropic", "--model", "claude-opus-4-8"])).toEqual({
			subCommand: "provider",
			args: ["anthropic"],
			model: "claude-opus-4-8",
		});
		expect(parseSettingsCliArgs(["provider", "openai", "--model=gpt-4o"])).toEqual({
			subCommand: "provider",
			args: ["openai"],
			model: "gpt-4o",
		});
		expect(parseSettingsCliArgs([])).toEqual({ subCommand: "", args: [], model: "" });
	});

	it("coerceSettingValue types booleans + numbers, leaves other strings as-is", () => {
		expect(coerceSettingValue("true")).toBe(true);
		expect(coerceSettingValue("false")).toBe(false);
		expect(coerceSettingValue("42")).toBe(42);
		expect(coerceSettingValue("claude-opus-4-8")).toBe("claude-opus-4-8");
		// A vendor/model id with a dot is NOT a clean number round-trip → stays a string.
		expect(coerceSettingValue("anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
	});

	it("the dispatcher routes `settings` to the daemon seam (storage class, bespoke /api/settings)", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "GET /api/settings": { status: 200, body: { settings: {}, catalog: [] } } },
		});
		const dispatcher = createDispatcher();
		const inv = dispatcher.parse(["settings", "list"]);
		expect(inv.verb).toBe("settings");
		const res = await dispatcher.dispatch(inv, { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]!.req.method).toBe("GET");
		expect(daemon.calls[0]!.req.path).toBe(SETTINGS_ENDPOINT);
	});
});

describe("PRD-032b b-AC-1 — `settings list` renders settings + catalog, no secret printed", () => {
	it("GETs /api/settings and renders the settings + provider catalog", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"GET /api/settings": {
					status: 200,
					body: {
						settings: { activeProvider: "anthropic", activeModel: "claude-opus-4-8", "pollinating.enabled": true },
						catalog: [{ id: "anthropic", label: "Anthropic", models: ["claude-opus-4-8"], openEnded: false }],
					},
				},
			},
		});
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["list"], { daemon, out });
		expect(res.exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text).toMatch(/activeProvider = anthropic/);
		expect(text).toMatch(/activeModel = claude-opus-4-8/);
		expect(text).toMatch(/pollinating\.enabled = true/);
		expect(text).toMatch(/anthropic \(Anthropic\)/);
	});

	it("an empty settings map renders an honest 'none stored yet' line", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "GET /api/settings": { status: 200, body: { settings: {}, catalog: [] } } },
		});
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["list"], { daemon, out });
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/none stored yet/i);
	});

	it("NEVER prints a secret value — list output carries no token/secret/bearer markers", async () => {
		// The daemon's /api/settings returns ONLY the setting class; even if a future response
		// somehow carried a secret-shaped key, the render shows only key = value scalars. We assert
		// the rendered list never contains secret-egress markers.
		const daemon = createFakeDaemonClient({
			responses: {
				"GET /api/settings": {
					status: 200,
					body: {
						settings: { activeProvider: "anthropic", activeModel: "claude-opus-4-8" },
						catalog: [],
					},
				},
			},
		});
		const { out, lines } = withSink();
		await runSettingsVerb(["list"], { daemon, out });
		expect(lines.join("\n")).not.toMatch(/token|secret|bearer|authorization|sk-|x-honeycomb/i);
	});
});

describe("PRD-032b b-AC-2 — `settings get`/`set` round-trip through the daemon", () => {
	it("get <key> GETs /api/settings/:key and renders the value", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "GET /api/settings/activeModel": { status: 200, body: { key: "activeModel", value: "claude-opus-4-8" } } },
		});
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["get", "activeModel"], { daemon, out });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls[0]!.req.method).toBe("GET");
		expect(daemon.calls[0]!.req.path).toBe("/api/settings/activeModel");
		expect(lines.join("\n")).toMatch(/activeModel = claude-opus-4-8/);
	});

	it("get on a missing key (404) prints 'not set' and exits 1", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "GET /api/settings/activeModel": { status: 404, body: { error: "not_found" } } },
		});
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["get", "activeModel"], { daemon, out });
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/not set/i);
	});

	it("set <key> <value> POSTs /api/settings/:key with the typed value in the body", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/settings/pollinating.enabled": { status: 201, body: { ok: true, key: "pollinating.enabled", value: true } } },
		});
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["set", "pollinating.enabled", "true"], { daemon, out });
		expect(res.exitCode).toBe(0);
		const call = daemon.calls[0]!.req;
		expect(call.method).toBe("POST");
		expect(call.path).toBe("/api/settings/pollinating.enabled");
		// The boolean is COERCED to a real boolean in the body, not the string "true".
		expect(call.body).toEqual({ value: true });
		expect(lines.join("\n")).toMatch(/saved/i);
	});

	it("a numeric value is coerced to a number in the POST body", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/settings/dashboard.limit": { status: 201, body: { ok: true } } },
		});
		const res = await runSettingsVerb(["set", "dashboard.limit", "5"], { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls[0]!.req.body).toEqual({ value: 5 });
	});

	it("a daemon 400 (bad key/value) surfaces the reason and exits 1", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/settings/bogus": { status: 400, body: { error: "bad_request", reason: "unknown setting key" } } },
		});
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["set", "bogus", "x"], { daemon, out });
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/unknown setting key/);
	});

	it("set never prints a secret — the echo is only the written key/value scalar", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/settings/activeModel": { status: 201, body: { ok: true, key: "activeModel", value: "claude-opus-4-8" } } },
		});
		const { out, lines } = withSink();
		await runSettingsVerb(["set", "activeModel", "claude-opus-4-8"], { daemon, out });
		expect(lines.join("\n")).not.toMatch(/token|secret|bearer|authorization|sk-/i);
	});
});

describe("PRD-032b b-AC-3 — the provider→model selector validates the catalog + writes provider+model", () => {
	it("a valid provider+model writes activeProvider THEN activeModel (catalog-ordered)", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/settings/activeProvider": { status: 201, body: { ok: true } },
				"POST /api/settings/activeModel": { status: 201, body: { ok: true } },
			},
		});
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["provider", "anthropic", "--model", "claude-opus-4-8"], { daemon, out });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(2);
		// Provider FIRST so the daemon validates the model against the just-written provider.
		expect(daemon.calls[0]!.req.path).toBe("/api/settings/activeProvider");
		expect(daemon.calls[0]!.req.body).toEqual({ value: "anthropic" });
		expect(daemon.calls[1]!.req.path).toBe("/api/settings/activeModel");
		expect(daemon.calls[1]!.req.body).toEqual({ value: "claude-opus-4-8" });
		expect(lines.join("\n")).toMatch(/provider = anthropic, model = claude-opus-4-8/);
	});

	it("a provider with no --model uses the catalog default (models[0])", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/settings/activeProvider": { status: 201, body: { ok: true } },
				"POST /api/settings/activeModel": { status: 201, body: { ok: true } },
			},
		});
		const res = await runSettingsVerb(["provider", "anthropic"], { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		// Anthropic's catalog default is its models[0] = claude-sonnet-4-6.
		expect(daemon.calls[1]!.req.body).toEqual({ value: "claude-sonnet-4-6" });
	});

	it("an off-catalog PROVIDER is rejected client-side and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["provider", "cohere", "--model", "command-r"], { daemon, out });
		expect(res.exitCode).toBe(1);
		expect(daemon.calls).toHaveLength(0);
		expect(lines.join("\n")).toMatch(/unknown provider/i);
	});

	it("an off-catalog MODEL for a closed provider is rejected client-side and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["provider", "anthropic", "--model", "gpt-4o"], { daemon, out });
		expect(res.exitCode).toBe(1);
		expect(daemon.calls).toHaveLength(0);
		expect(lines.join("\n")).toMatch(/not in the Anthropic catalog/i);
	});

	it("OpenRouter accepts a FREE-FORM model id (D-6 passthrough)", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/settings/activeProvider": { status: 201, body: { ok: true } },
				"POST /api/settings/activeModel": { status: 201, body: { ok: true } },
			},
		});
		const res = await runSettingsVerb(
			["provider", "openrouter", "--model", "deepseek/deepseek-chat-v3"],
			{ daemon, out: () => {} },
		);
		expect(res.exitCode).toBe(0);
		expect(daemon.calls[0]!.req.body).toEqual({ value: "openrouter" });
		expect(daemon.calls[1]!.req.body).toEqual({ value: "deepseek/deepseek-chat-v3" });
	});

	it("`settings provider` with no id prints the catalog (the choices) and exits 0", async () => {
		const daemon = createFakeDaemonClient();
		const { out, lines } = withSink();
		const res = await runSettingsVerb(["provider"], { daemon, out });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(0);
		const text = lines.join("\n");
		expect(text).toMatch(/anthropic/);
		expect(text).toMatch(/openai/);
		expect(text).toMatch(/openrouter/);
	});
});

describe("PRD-032b b-AC-4 — loopback-only + the secret verb stays names-only (no value verb)", () => {
	it("an unknown settings subcommand prints usage (exit 1) and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const res = await runSettingsVerb(["bogus"], { daemon, out: () => {} });
		expect(res.exitCode).toBe(1);
		expect(daemon.calls).toHaveLength(0);
	});

	it("no settings invocation reaches anything but /api/settings (loopback-daemon-mediated)", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"GET /api/settings": { status: 200, body: { settings: {}, catalog: [] } },
				"POST /api/settings/activeProvider": { status: 201, body: { ok: true } },
				"POST /api/settings/activeModel": { status: 201, body: { ok: true } },
			},
		});
		await runSettingsVerb(["list"], { daemon, out: () => {} });
		await runSettingsVerb(["provider", "openai", "--model", "gpt-4o"], { daemon, out: () => {} });
		for (const call of daemon.calls) {
			expect(call.req.path.startsWith("/api/settings")).toBe(true);
		}
	});

	it("the `secret` verb remains names-only on /api/secrets — no value-returning verb was added", () => {
		// The secret verb's route is unchanged and points at the names-only group.
		expect(STORAGE_VERB_ROUTES.secret).toBe("/api/secrets");
		// `secret list` is a GET (names only); `secret set <name> <value>` is a POST that STORES
		// (returns ok-no-value). There is no GET /api/secrets/:name value-returning shape here.
		const listReq = buildStorageRequest("secret", ["list"]);
		expect(listReq.method).toBe("GET");
		expect(listReq.path).toBe("/api/secrets");
		const setReq = buildStorageRequest("secret", ["set", "ANTHROPIC_API_KEY", "sk-xxx"]);
		expect(setReq.method).toBe("POST");
		expect(setReq.path).toBe("/api/secrets/set");
		// The settings surface never targets the secrets group.
		const daemonPaths = [SETTINGS_ENDPOINT];
		expect(daemonPaths.every((p) => !p.includes("/api/secrets"))).toBe(true);
	});
});
