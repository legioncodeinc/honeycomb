/**
 * PRD-026 AC-T — inference-backed ModelClient factory tests.
 *
 * `buildInferenceModelClient` is the assembly swap: a routable `InferenceConfig` →
 * a `RouterModelClient`; an absent/empty/malformed config → `noopModelClient`
 * (NEVER a throw). The working path is exercised end-to-end through the REAL
 * pieces — the real `.secrets/` store + the real `createSecretResolver` + the real
 * Anthropic transport — with `globalThis.fetch` stubbed so NO network is touched
 * and the fake provider output flows back through `complete("memory_pollinating", …)`.
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
import {
	buildInferenceModelClient,
	buildInferenceModelClientWithStatus,
} from "../../../../src/daemon/runtime/inference/model-client-factory.js";
import {
	EXTRACTION_PROVIDER_AUTO_RESOLVED,
	EXTRACTION_PROVIDER_NONE,
	isExtractionEnabled,
	resolveEffectiveExtractionProvider,
	resolvePipelineConfig,
} from "../../../../src/daemon/runtime/pipeline/config.js";

const SCOPE: SecretScope = { org: "acme", workspace: "backend" };

/** A complete, routable inference config (single Anthropic account → sonnet → pollinating). */
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
				name: "memory_pollinating",
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
		await expect(client.complete("memory_pollinating", "anything")).resolves.toBe("");
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
	it("complete('memory_pollinating', …) routes through the real wiring and returns the provider output", async () => {
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
				text: async () => JSON.stringify({ content: [{ type: "text", text: "POLLINATED-OUTPUT" }] }),
			};
		}) as unknown as typeof globalThis.fetch;

		const client = await buildInferenceModelClient({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
		});
		expect(client).not.toBe(noopModelClient);

		const output = await client.complete("memory_pollinating", "consolidate the graph");
		expect(output).toBe("POLLINATED-OUTPUT");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.apiKey).toBe("sk-ant-secret-KEY");
		// The prompt is wrapped as a single user message (RouterModelClient's mapping).
		const body = JSON.parse(seen[0]?.body ?? "{}") as { messages: { role: string; content: string }[] };
		expect(body.messages).toEqual([{ role: "user", content: "consolidate the graph" }]);
	});

	it("PRD-032d d-AC-1: a vault provider/model override WINS over the agent.yaml target (vault-driven selection)", async () => {
		// The committed `agent.yaml` config selects `claude-sonnet-4-6` (routableConfig). The vault
		// `setting` selected `claude-opus-4-8`. With the override fed to the factory, the router must
		// call the OVERRIDE model — proving the vault wins over agent.yaml — while the credential STILL
		// resolves through the same `${SECRET_REF}` (the override never touches `apiKeyRef`, FR-2).
		const store = makeStore();
		const stored = await store.setSecret("ANTHROPIC_API_KEY", "sk-ant-secret-KEY", SCOPE);
		expect(stored.ok).toBe(true);

		const seen: { apiKey: string; body: string }[] = [];
		globalThis.fetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
			seen.push({ apiKey: init.headers["x-api-key"] ?? "", body: init.body });
			return {
				status: 200,
				ok: true,
				text: async () => JSON.stringify({ content: [{ type: "text", text: "OPUS-OUTPUT" }] }),
			};
		}) as unknown as typeof globalThis.fetch;

		const client = await buildInferenceModelClient({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(), // agent.yaml says sonnet…
			providerModelOverride: { provider: "anthropic", model: "claude-opus-4-8" }, // …vault says opus.
		});
		expect(client).not.toBe(noopModelClient);

		const output = await client.complete("memory_pollinating", "consolidate the graph");
		expect(output).toBe("OPUS-OUTPUT");
		expect(seen).toHaveLength(1);
		// The vault model — NOT the agent.yaml `claude-sonnet-4-6` — reached the provider call.
		const body = JSON.parse(seen[0]?.body ?? "{}") as { model: string };
		expect(body.model).toBe("claude-opus-4-8");
		// FR-2: the credential still resolved through the `${SECRET_REF}` secret path (unchanged).
		expect(seen[0]?.apiKey).toBe("sk-ant-secret-KEY");
	});

	it("PRD-032d d-AC-3: NO override → the agent.yaml target stands (no regression)", async () => {
		// Absent a vault override, the committed `agent.yaml` selection (`claude-sonnet-4-6`) is used
		// verbatim — the wire-back never regresses an install with no vault setting.
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", "sk-ant-secret-KEY", SCOPE);
		const seen: { body: string }[] = [];
		globalThis.fetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
			seen.push({ body: init.body });
			return {
				status: 200,
				ok: true,
				text: async () => JSON.stringify({ content: [{ type: "text", text: "SONNET-OUTPUT" }] }),
			};
		}) as unknown as typeof globalThis.fetch;

		const client = await buildInferenceModelClient({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			// no providerModelOverride.
		});
		await client.complete("memory_pollinating", "go");
		const body = JSON.parse(seen[0]?.body ?? "{}") as { model: string };
		expect(body.model).toBe("claude-sonnet-4-6");
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
		await expect(client.complete("memory_pollinating", "go")).rejects.toThrow();
	});
});

describe("providerConfigured: honest, fail-closed on CREDENTIAL resolution (the false-positive fix)", () => {
	it("routable config but NO stored key → providerConfigured is FALSE even though the client is non-noop", async () => {
		// The exact false positive: `isRoutable` is satisfied (account + workload declared), so the
		// factory returns a REAL RouterModelClient — but the `${ANTHROPIC_API_KEY}` secret is absent,
		// so every runtime call would silently no-op. The honest signal must be FALSE (so `/health`
		// says `unconfigured` and the `'auto'` extraction gate stays disabled), NOT the coarse
		// `client !== noopModelClient` identity that this bug reported as `true`.
		const { client, providerConfigured, portkeyStatus } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: makeStore(), // no secret stored
			config: routableConfig(),
		});
		expect(portkeyStatus).toBe("off");
		expect(client, "the client is still a real router client (so the pipeline wires)").not.toBe(noopModelClient);
		expect(providerConfigured, "but the credential is ABSENT → fail-closed to false").toBe(false);
	});

	it("routable config WITH the stored key present → providerConfigured is TRUE", async () => {
		const store = makeStore();
		expect((await store.setSecret("ANTHROPIC_API_KEY", "sk-ant-secret-KEY", SCOPE)).ok).toBe(true);
		const { client, providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
		});
		expect(client).not.toBe(noopModelClient);
		expect(providerConfigured, "the ${SECRET_REF} key resolves → configured").toBe(true);
	});

	it("a stored key under a DIFFERENT name than the account's apiKeyRef → providerConfigured is FALSE", async () => {
		// Presence is checked against the account's REFERENCED name, not any stored secret. A key
		// stored under the wrong name does not make the declared provider usable.
		const store = makeStore();
		await store.setSecret("SOME_OTHER_KEY", "sk-ant-secret-KEY", SCOPE);
		const { providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(), // references ${ANTHROPIC_API_KEY}
		});
		expect(providerConfigured).toBe(false);
	});

	it("no config (absent path) → providerConfigured is FALSE (the honest no-provider posture)", async () => {
		const { client, providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: makeStore(),
			config: join(base, "does-not-exist.yaml"),
		});
		expect(client).toBe(noopModelClient);
		expect(providerConfigured).toBe(false);
	});

	it("a provider/model override does NOT change the credential check (apiKeyRef is preserved) → key present stays TRUE", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", "sk-ant-secret-KEY", SCOPE);
		const { providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
			providerModelOverride: { provider: "anthropic", model: "claude-opus-4-8" },
		});
		expect(providerConfigured, "the override never touches apiKeyRef → the same key still resolves").toBe(true);
	});
});

describe("the 'auto' extraction gate follows the CORRECTED provider signal (end-to-end)", () => {
	// This is the gate assemble.ts drives: it feeds `built.providerConfigured` (now credential-aware)
	// into `resolveEffectiveExtractionProvider`. We compose the two here to prove the false positive is
	// closed — a routable-but-keyless config no longer flips `'auto'` on.
	const enabledAutoConfig = () => resolvePipelineConfig({ read: () => ({ enabled: true }) }); // extractionProvider defaults to 'auto'

	it("routable config, NO key → 'auto' collapses to 'none' → extraction DISABLED", async () => {
		const { providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: makeStore(), // no key
			config: routableConfig(),
		});
		expect(providerConfigured).toBe(false);
		const resolved = resolveEffectiveExtractionProvider(enabledAutoConfig(), providerConfigured);
		expect(resolved.extractionProvider).toBe(EXTRACTION_PROVIDER_NONE);
		expect(isExtractionEnabled(resolved)).toBe(false);
	});

	it("routable config, key present → 'auto' collapses to the resolved marker → extraction ENABLED", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", "sk-ant-secret-KEY", SCOPE);
		const { providerConfigured } = await buildInferenceModelClientWithStatus({
			scope: SCOPE,
			secretsStore: store,
			config: routableConfig(),
		});
		expect(providerConfigured).toBe(true);
		const resolved = resolveEffectiveExtractionProvider(enabledAutoConfig(), providerConfigured);
		expect(resolved.extractionProvider).toBe(EXTRACTION_PROVIDER_AUTO_RESOLVED);
		expect(isExtractionEnabled(resolved)).toBe(true);
	});
});
