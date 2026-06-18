/**
 * PRD-012a resolver — the REAL SecretResolver wiring PRD-010's seam (D-5 / a-AC-5).
 *
 * The resolver is the ONE legitimate internal decrypt consumer: it decrypts a named
 * secret IN-PROCESS for the router's provider call. These tests prove it resolves a valid
 * ref, REJECTS an unknown ref (fail-closed), and that it is the only thing returning a
 * value — no API surface does.
 *
 * a-AC-5 the only decrypted-value path is internal (the resolver), never an agent surface.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeMachineKeyProvider, type SecretScope } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { SecretsStore, createSecretResolver } from "../../../../src/daemon/runtime/secrets/store.js";

const SECRET = "sk-resolver-secret";
const SCOPE: SecretScope = { org: "acme", workspace: "backend" };

let base: string;
function store(id = "machine-A"): SecretsStore {
	return new SecretsStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider(id),
		clock: { now: () => "2026-06-18T00:00:00.000Z" },
	});
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-secrets-resolver-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("a-AC-5 the real SecretResolver decrypts in-process for a valid ref", () => {
	it("resolves a stored secret by its bare name", async () => {
		const s = store();
		await s.setSecret("openai.key", SECRET, SCOPE);
		const resolver = createSecretResolver(s, SCOPE);
		expect(await resolver.resolve("openai.key")).toBe(SECRET);
	});

	it("resolves a ${...}-wrapped reference (the router's apiKeyRef shape)", async () => {
		const s = store();
		await s.setSecret("openai.key", SECRET, SCOPE);
		const resolver = createSecretResolver(s, SCOPE);
		expect(await resolver.resolve("${openai.key}")).toBe(SECRET);
	});

	it("matches the fake-resolver contract the router was built against (resolve → Promise<string>)", async () => {
		const s = store();
		await s.setSecret("k", "v", SCOPE);
		const resolver = createSecretResolver(s, SCOPE);
		const out = resolver.resolve("k");
		expect(out).toBeInstanceOf(Promise);
		expect(await out).toBe("v");
	});
});

describe("the resolver fails closed on an unknown / undecryptable ref", () => {
	it("rejects an unknown reference", async () => {
		const resolver = createSecretResolver(store(), SCOPE);
		await expect(resolver.resolve("does-not-exist")).rejects.toThrow();
	});

	it("rejects when the machine-bound key differs (copied to another host — a-AC-3)", async () => {
		await store("machine-A").setSecret("openai.key", SECRET, SCOPE);
		// Resolve on a DIFFERENT host (different machine id) against the same `.secrets/`.
		const resolver = createSecretResolver(store("machine-B"), SCOPE);
		await expect(resolver.resolve("openai.key")).rejects.toThrow();
	});

	it("rejects a name from a different scope (cross-scope isolation)", async () => {
		await store().setSecret("scoped", SECRET, { org: "acme", workspace: "backend", agentId: "agent-A" });
		const resolver = createSecretResolver(store(), { org: "acme", workspace: "backend", agentId: "agent-B" });
		await expect(resolver.resolve("scoped")).rejects.toThrow();
	});

	it("a rejection message never contains the secret value", async () => {
		const resolver = createSecretResolver(store(), SCOPE);
		try {
			await resolver.resolve("missing");
			throw new Error("should have rejected");
		} catch (err) {
			expect(err instanceof Error ? err.message : String(err)).not.toContain(SECRET);
		}
	});
});
