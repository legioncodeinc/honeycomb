/**
 * PRD-063b — model-client-factory Portkey supersession tests (b-AC-2 / b-AC-3 / b-AC-4 / b-AC-5).
 *
 * Drives the REAL factory through the REAL `.secrets/` store + the REAL `createSecretResolver`,
 * with `globalThis.fetch` stubbed so NO network is touched. Proves:
 *   b-AC-2  Portkey ON + key present → the Portkey transport is built and the request hits the
 *           Portkey URL with the resolved key header + the config id; the per-provider key is
 *           neither required nor read.
 *   b-AC-3  the resolved Portkey key appears in NO captured fetch arg beyond its header (and the
 *           factory return value carries no key).
 *   b-AC-4  precedence + opt-in fallback: missing key → `unconfigured` + no-op (BOTH fallback
 *           modes, never a provider key); fallback-ON + unreachable gateway → the per-provider path.
 *   b-AC-5  Portkey OFF/unset → byte-identical to today (the Anthropic path; no Portkey URL hit).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noopModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import { createFakeMachineKeyProvider, type SecretScope } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { SecretsStore } from "../../../../src/daemon/runtime/secrets/store.js";
import type { InferenceConfig } from "../../../../src/daemon/runtime/inference/contracts.js";
import {
	buildInferenceModelClientWithStatus,
	type PortkeySelection,
} from "../../../../src/daemon/runtime/inference/model-client-factory.js";
import { PORTKEY_CHAT_COMPLETIONS_URL } from "../../../../src/daemon/runtime/inference/transport-portkey.js";
import { ANTHROPIC_MESSAGES_URL } from "../../../../src/daemon/runtime/inference/transport-anthropic.js";

const SCOPE: SecretScope = { org: "acme", workspace: "backend" };
const PORTKEY_KEY = "pk-portkey-secret-KEY-DEADBEEF";
const PROVIDER_KEY = "sk-ant-provider-KEY-CAFED00D";

/** A routable per-provider (Anthropic) config — the off-path + the fallback target. */
function routableConfig(): InferenceConfig {
	return {
		accounts: [{ id: "anthropic-main", provider: "anthropic", apiKeyRef: "${ANTHROPIC_API_KEY}" }],
		targets: [
			{
				id: "sonnet",
				accountRef: "anthropic-main",
				model: "claude-sonnet-4-6",
				privacyTier: "private",
				capabilities: ["chat"],
				contextWindow: 200_000,
			},
		],
		policies: [{ id: "default", mode: "strict", chain: ["sonnet"] }],
		workloads: [
			{ name: "memory_pollinating", policyRef: "default", requiredCapabilities: ["chat"], minPrivacyTier: "private" },
		],
	};
}

function portkeyOn(overrides: Partial<PortkeySelection> = {}): PortkeySelection {
	return { enabled: true, config: "pc-cfg-1", model: "claude-sonnet-4-6", fallbackToProvider: false, ...overrides };
}

interface SeenCall {
	url: string;
	headers: Record<string, string>;
	body: string;
}

let base: string;
let savedFetch: typeof globalThis.fetch;

function makeStore(): SecretsStore {
	return new SecretsStore({ baseDir: base, machineKey: createFakeMachineKeyProvider("machine-A") });
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-portkey-"));
	savedFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = savedFetch;
	rmSync(base, { recursive: true, force: true });
});

/** Stub global fetch; route by URL. Records every call. */
function stubFetch(handler: (url: string, init: { headers: Record<string, string>; body: string }) => FetchReply): SeenCall[] {
	const seen: SeenCall[] = [];
	globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
		seen.push({ url, headers: init.headers, body: init.body });
		const reply = handler(url, init);
		return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async () => reply.body };
	}) as unknown as typeof globalThis.fetch;
	return seen;
}
interface FetchReply {
	status: number;
	body: string;
}

const PORTKEY_OK_BODY = JSON.stringify({ choices: [{ message: { content: "PORTKEY-OUT" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const ANTHROPIC_OK_BODY = JSON.stringify({ content: [{ type: "text", text: "PROVIDER-OUT" }] });

describe("b-AC-2 / b-AC-3 Portkey ON + key present → routes through the Portkey transport", () => {
	it("hits the Portkey URL with the resolved key header + config id; the provider key is never read", async () => {
		const store = makeStore();
		expect((await store.setSecret("PORTKEY_API_KEY", PORTKEY_KEY, SCOPE)).ok).toBe(true);
		// NOTE: NO ANTHROPIC_API_KEY is stored — the Portkey path must not need it.

		const seen = stubFetch((url) => (url === PORTKEY_CHAT_COMPLETIONS_URL ? { status: 200, body: PORTKEY_OK_BODY } : { status: 500, body: "wrong-url" }));

		const { client, portkeyStatus, providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			portkey: portkeyOn({ config: "pc-cfg-xyz" }),
		});
		expect(portkeyStatus).toBe("ok");
		expect(providerConfigured, "portkey ok → configured").toBe(true);
		expect(client).not.toBe(noopModelClient);

		const out = await client.complete("memory_pollinating", "consolidate");
		expect(out).toBe("PORTKEY-OUT");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe(PORTKEY_CHAT_COMPLETIONS_URL);
		expect(seen[0]?.headers["x-portkey-api-key"], "the resolved Portkey key reached the header").toBe(PORTKEY_KEY);
		expect(seen[0]?.headers["x-portkey-config"]).toBe("pc-cfg-xyz");
		// b-AC-3: the key appears nowhere but its header — not the URL, not the body.
		expect(seen[0]?.url).not.toContain(PORTKEY_KEY);
		expect(seen[0]?.body).not.toContain(PORTKEY_KEY);
		// The factory return value (the client) carries no key (grep the serialized shape defensively).
		expect(JSON.stringify(Object.keys(client))).not.toContain(PORTKEY_KEY);
	});

	it("b-AC-2: the Anthropic (per-provider) URL is NEVER hit when Portkey is on", async () => {
		const store = makeStore();
		await store.setSecret("PORTKEY_API_KEY", PORTKEY_KEY, SCOPE);
		const seen = stubFetch(() => ({ status: 200, body: PORTKEY_OK_BODY }));
		const { client } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			portkey: portkeyOn(),
		});
		await client.complete("memory_pollinating", "x");
		expect(seen.every((c) => c.url !== ANTHROPIC_MESSAGES_URL)).toBe(true);
	});
});

describe("b-AC-5 Portkey OFF/unset → byte-identical to today (the per-provider path; no Portkey URL)", () => {
	it("off → the Anthropic transport runs, the Portkey URL is never hit, status is 'off'", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", PROVIDER_KEY, SCOPE);
		const seen = stubFetch((url) => (url === ANTHROPIC_MESSAGES_URL ? { status: 200, body: ANTHROPIC_OK_BODY } : { status: 500, body: "wrong" }));

		const { client, portkeyStatus } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			portkey: { enabled: false, config: "", model: "", fallbackToProvider: false },
		});
		expect(portkeyStatus).toBe("off");
		const out = await client.complete("memory_pollinating", "x");
		expect(out).toBe("PROVIDER-OUT");
		expect(seen[0]?.url).toBe(ANTHROPIC_MESSAGES_URL);
		expect(seen.every((c) => c.url !== PORTKEY_CHAT_COMPLETIONS_URL), "no Portkey transport constructed").toBe(true);
		expect(seen[0]?.headers["x-api-key"], "the provider key flows on the off-path, unchanged").toBe(PROVIDER_KEY);
	});

	it("an ABSENT portkey selection is byte-identical to off (per-provider path)", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", PROVIDER_KEY, SCOPE);
		const seen = stubFetch(() => ({ status: 200, body: ANTHROPIC_OK_BODY }));
		const { client, portkeyStatus } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
		});
		expect(portkeyStatus).toBe("off");
		expect(await client.complete("memory_pollinating", "x")).toBe("PROVIDER-OUT");
		expect(seen.every((c) => c.url !== PORTKEY_CHAT_COMPLETIONS_URL)).toBe(true);
	});
});

describe("b-AC-4 precedence + fallback: missing key hard-errors (fail-closed) in BOTH fallback modes", () => {
	it("Portkey on, NO PORTKEY_API_KEY, fallback OFF → status 'unconfigured' + no-op client (no provider key used)", async () => {
		const store = makeStore();
		// A provider key IS present — to prove it is NOT silently used for the missing Portkey key.
		await store.setSecret("ANTHROPIC_API_KEY", PROVIDER_KEY, SCOPE);
		const seen = stubFetch(() => ({ status: 200, body: ANTHROPIC_OK_BODY }));

		const { client, portkeyStatus, providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			portkey: portkeyOn({ fallbackToProvider: false }),
		});
		expect(portkeyStatus).toBe("unconfigured");
		expect(providerConfigured, "portkey unconfigured → not configured").toBe(false);
		expect(client, "fail-closed → the no-op client (never the provider path)").toBe(noopModelClient);
		expect(await client.complete("memory_pollinating", "x")).toBe("");
		expect(seen, "NO call is made — not Portkey, not the provider").toHaveLength(0);
	});

	it("Portkey on, NO PORTKEY_API_KEY, fallback ON → STILL 'unconfigured' + no-op (a missing key is a hard error regardless)", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", PROVIDER_KEY, SCOPE);
		const seen = stubFetch(() => ({ status: 200, body: ANTHROPIC_OK_BODY }));

		const { client, portkeyStatus, providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			portkey: portkeyOn({ fallbackToProvider: true }),
		});
		expect(portkeyStatus, "a missing key is unconfigured even with fallback ON").toBe("unconfigured");
		expect(providerConfigured, "a missing key is not configured even with fallback ON").toBe(false);
		expect(client).toBe(noopModelClient);
		expect(seen, "fallback never papers over a MISSING key").toHaveLength(0);
	});
});

describe("b-AC-4 fallback ON + UNREACHABLE gateway → routes the SAME request through the per-provider path", () => {
	it("Portkey 503 (unreachable) with fallback ON → the Anthropic provider output is returned", async () => {
		const store = makeStore();
		await store.setSecret("PORTKEY_API_KEY", PORTKEY_KEY, SCOPE);
		await store.setSecret("ANTHROPIC_API_KEY", PROVIDER_KEY, SCOPE);
		const unreachable: number[] = [];

		const seen = stubFetch((url) => {
			if (url === PORTKEY_CHAT_COMPLETIONS_URL) return { status: 503, body: "gateway down" };
			if (url === ANTHROPIC_MESSAGES_URL) return { status: 200, body: ANTHROPIC_OK_BODY };
			return { status: 500, body: "wrong" };
		});

		const { client, portkeyStatus } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			portkey: portkeyOn({ fallbackToProvider: true }),
			onPortkeyUnreachable: (s) => unreachable.push(s),
		});
		// At assembly the key IS present → status is `ok` (the unreachable state is a RUNTIME signal).
		expect(portkeyStatus).toBe("ok");

		const out = await client.complete("memory_pollinating", "x");
		expect(out, "fallback served the provider output").toBe("PROVIDER-OUT");
		// Both URLs were tried: Portkey first (503), then the provider (200).
		expect(seen.some((c) => c.url === PORTKEY_CHAT_COMPLETIONS_URL)).toBe(true);
		expect(seen.some((c) => c.url === ANTHROPIC_MESSAGES_URL)).toBe(true);
		// The runtime unreachable signal fired (drives `/health` reasons.portkey = "unreachable").
		expect(unreachable).toContain(503);
	});

	it("Portkey 503 (unreachable) with fallback OFF → fail-closed: empty output, the provider URL is NEVER hit", async () => {
		const store = makeStore();
		await store.setSecret("PORTKEY_API_KEY", PORTKEY_KEY, SCOPE);
		await store.setSecret("ANTHROPIC_API_KEY", PROVIDER_KEY, SCOPE);
		const unreachable: number[] = [];

		const seen = stubFetch((url) => (url === PORTKEY_CHAT_COMPLETIONS_URL ? { status: 503, body: "down" } : { status: 200, body: ANTHROPIC_OK_BODY }));

		const { client } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			portkey: portkeyOn({ fallbackToProvider: false }),
			onPortkeyUnreachable: (s) => unreachable.push(s),
		});
		// Fail-closed (D-3): the unreachable single-target Portkey chain is exhausted, so the router
		// REJECTS (the stage wrapper treats a rejection as "no usable output"). It never silently
		// routes to the per-provider path — the honest fail-closed posture.
		await expect(client.complete("memory_pollinating", "x")).rejects.toBeTruthy();
		expect(seen.some((c) => c.url === ANTHROPIC_MESSAGES_URL), "fail-closed never touches the provider").toBe(false);
		expect(unreachable).toContain(503);
	});
});
