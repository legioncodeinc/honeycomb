/**
 * PRD-026 AC-T — inference-backed ModelClient factory tests.
 *
 * `buildInferenceModelClient` is the assembly swap: a routable `InferenceConfig` →
 * a `RouterModelClient`; an absent/empty/malformed config → `noopModelClient`
 * (NEVER a throw). The working path is exercised end-to-end through the REAL
 * pieces — the real `.secrets/` store + the real `createSecretResolver` + the real
 * Anthropic transport — with `globalThis.fetch` stubbed so NO network is touched
 * and the fake provider output flows back through `complete("memory_dreaming", …)`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noopModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import {
	createFakeMachineKeyProvider,
	type SecretScope,
} from "../../../../src/daemon/runtime/secrets/contracts.js";
import { SecretsStore } from "../../../../src/daemon/runtime/secrets/store.js";
import type { InferenceConfig } from "../../../../src/daemon/runtime/inference/contracts.js";
import { buildInferenceModelClient } from "../../../../src/daemon/runtime/inference/model-client-factory.js";

const SCOPE: SecretScope = { org: "acme", workspace: "backend" };

/** A complete, routable inference config (single Anthropic account → sonnet → dreaming). */
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
			{
				name: "memory_dreaming",
				policyRef: "default",
				requiredCapabilities: ["chat"],
				minPrivacyTier: "private",
			},
		],
	};
}

let base: string;
let savedFetch: typeof globalThis.fetch;

function makeStore(): SecretsStore {
	return new SecretsStore({ baseDir: base, machineKey: createFakeMachineKeyProvider("machine-A") });
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-mcf-"));
	savedFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = savedFetch;
	rmSync(base, { recursive: true, force: true });
});

describe("AC-T factory: no config → noopModelClient", () => {
	it("returns the no-op client for an absent config path (and never throws)", async () => {
		const client = await buildInferenceModelClient({
			scope: SCOPE,
			secretsStore: makeStore(),
			config: join(base, "does-not-exist.yaml"),
		});
		expect(client).toBe(noopModelClient);
		await expect(client.complete("memory_dreaming", "anything")).resolves.toBe("");
	});

	it("returns the no-op client for an empty (non-routable) config", async () => {
		const client = await buildInferenceModelClient({
			scope: SCOPE,
			secretsStore: makeStore(),
			config: { accounts: [], targets: [], policies: [], workloads: [] },
		});
		expect(client).toBe(noopModelClient);
	});
});

describe("AC-T factory: routable config → working RouterModelClient", () => {
	it("complete('memory_dreaming', …) routes through the real wiring and returns the provider output", async () => {
		const store = makeStore();
		const stored = await store.setSecret("ANTHROPIC_API_KEY", "sk-ant-secret-KEY", SCOPE);
		expect(stored.ok).toBe(true);

		// Stub the global fetch the real Anthropic transport uses — NO network. Assert the
		// resolved key reached the x-api-key header (proving the secret resolver ran).
		const seen: { url: string; apiKey: string; body: string }[] = [];
		globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
			seen.push({ url, apiKey: init.headers["x-api-key"] ?? "", body: init.body });
			return {
				status: 200,
				ok: true,
				text: async () => JSON.stringify({ content: [{ type: "text", text: "DREAMED-OUTPUT" }] }),
			};
		}) as unknown as typeof globalThis.fetch;

		const client = await buildInferenceModelClient({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
		});
		expect(client).not.toBe(noopModelClient);

		const output = await client.complete("memory_dreaming", "consolidate the graph");
		expect(output).toBe("DREAMED-OUTPUT");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.apiKey).toBe("sk-ant-secret-KEY");
		// The prompt is wrapped as a single user message (RouterModelClient's mapping).
		const body = JSON.parse(seen[0]?.body ?? "{}") as { messages: { role: string; content: string }[] };
		expect(body.messages).toEqual([{ role: "user", content: "consolidate the graph" }]);
	});

	it("rejects (no usable output) when the secret is missing, never falling back to noop silently", async () => {
		// A routable config but NO stored secret → the resolver rejects inside the router's
		// executeWithFallback; the chain exhausts and complete() rejects. The stage wrapper
		// (not under test here) treats a rejection as "no usable output".
		globalThis.fetch = (async () => {
			throw new Error("fetch must not be reached when the secret is unresolved");
		}) as unknown as typeof globalThis.fetch;

		const client = await buildInferenceModelClient({
			scope: SCOPE,
			secretsStore: makeStore(),
			config: routableConfig(),
		});
		expect(client).not.toBe(noopModelClient);
		await expect(client.complete("memory_dreaming", "go")).rejects.toThrow();
	});
});
