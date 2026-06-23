/**
 * PRD-045e — the durable sources registry + the provider resolver, over the in-memory
 * append-only {@link FakeArtifactStore}.
 *
 * Verification posture: drive the {@link DeeplakeSourceRegistry} directly (no daemon)
 * and assert the register → list → get → remove round-trip behaves append-only +
 * tenancy-scoped + deterministic-id; then assert the {@link createSourceProviderResolver}
 * maps each kind to the right provider (Obsidian live, Discord/GitHub fail-soft, document
 * null). These are the two deps the composition root could not build before this PRD.
 */

import { describe, expect, it } from "vitest";

import {
	createSourceProviderResolver,
	DeeplakeSourceRegistry,
	SOURCE_CONFIG_KIND,
	sourceIdFor,
} from "../../../../src/daemon/runtime/sources/registry.js";
import { parseSourceConfig } from "../../../../src/daemon/runtime/sources/contracts.js";
import { MEMORY_ARTIFACTS_TABLE } from "../../../../src/daemon/storage/catalog/sources.js";
import { FakeArtifactStore } from "../../../helpers/fake-artifact-store.js";

const SCOPE = { org: "acme", workspace: "backend" };

function config(overrides: Record<string, unknown> = {}) {
	const parsed = parseSourceConfig({ kind: "obsidian", org: "acme", workspace: "backend", root: "/vault", settings: {}, ...overrides });
	if (parsed === null) throw new Error("test config did not parse");
	return parsed;
}

describe("PRD-045e DeeplakeSourceRegistry", () => {
	it("register → list → get round-trips a source (durable, scoped, deterministic id)", async () => {
		const store = new FakeArtifactStore();
		const registry = new DeeplakeSourceRegistry(store, SCOPE, undefined, 0);

		const cfg = config();
		const id = await registry.register(cfg);
		// Deterministic id: register returns exactly what sourceIdFor computes (the property
		// the provider resolver relies on to build a provider BEFORE register runs).
		expect(id).toBe(sourceIdFor(cfg));

		// list() surfaces the registered id.
		expect(await registry.list()).toContain(id);

		// get() round-trips the full config (kind/org/workspace/root/settings) from metadata.
		const got = await registry.get(id);
		expect(got).not.toBeNull();
		expect(got?.kind).toBe("obsidian");
		expect(got?.org).toBe("acme");
		expect(got?.root).toBe("/vault");

		// The config row landed on memory_artifacts with kind=source_config (no new schema).
		const current = store.currentOf(MEMORY_ARTIFACTS_TABLE, id);
		expect(current?.kind).toBe(SOURCE_CONFIG_KIND);
		expect(current?.org_id).toBe("acme");
	});

	it("re-register of the same config is idempotent (same id, version-bumped, never a dup id)", async () => {
		const store = new FakeArtifactStore();
		const registry = new DeeplakeSourceRegistry(store, SCOPE, undefined, 0);
		const cfg = config();
		const id1 = await registry.register(cfg);
		const id2 = await registry.register(cfg);
		expect(id2).toBe(id1);
		// Two appended versions of the SAME id; list de-dups to one.
		const versions = store.rowsOf(MEMORY_ARTIFACTS_TABLE).filter((r) => r.id === id1);
		expect(versions.length).toBe(2);
		expect(await registry.list()).toEqual([id1]);
	});

	it("remove soft-deletes (status advance, never an in-place UPDATE) → falls out of list + get", async () => {
		const store = new FakeArtifactStore();
		const registry = new DeeplakeSourceRegistry(store, SCOPE, undefined, 0);
		const id = await registry.register(config());
		await registry.remove(id);

		expect(await registry.list()).not.toContain(id);
		expect(await registry.get(id)).toBeNull();
		// a-AC-4 mechanism: the removal is an append (status advance), NOT an in-place UPDATE.
		expect(store.emittedUpdate()).toBe(false);
		const current = store.currentOf(MEMORY_ARTIFACTS_TABLE, id);
		expect(current?.status).toBe("deleted");
	});

	it("distinct configs get distinct ids and both list", async () => {
		const store = new FakeArtifactStore();
		const registry = new DeeplakeSourceRegistry(store, SCOPE, undefined, 0);
		const a = await registry.register(config({ root: "/vault-a" }));
		const b = await registry.register(config({ root: "/vault-b" }));
		expect(a).not.toBe(b);
		const list = await registry.list();
		expect(list).toContain(a);
		expect(list).toContain(b);
	});
});

describe("PRD-045e createSourceProviderResolver", () => {
	const resolver = createSourceProviderResolver();

	it("e-AC-4 resolves a configured obsidian source to the real vault provider", () => {
		const provider = resolver.resolve(config({ kind: "obsidian", root: "/vault" }));
		expect(provider).not.toBeNull();
		expect(provider?.kind).toBe("obsidian");
	});

	it("resolves discord fail-soft without creds (instantiated, not dead code)", () => {
		const provider = resolver.resolve(config({ kind: "discord", root: "guild-1" }));
		expect(provider).not.toBeNull();
		expect(provider?.kind).toBe("discord");
	});

	it("resolves github fail-soft without creds (instantiated, not dead code)", () => {
		const provider = resolver.resolve(config({ kind: "github", root: "owner/repo" }));
		expect(provider).not.toBeNull();
		expect(provider?.kind).toBe("github");
	});

	it("a document kind has no /api/sources provider (it flows through /api/documents) → null", () => {
		const provider = resolver.resolve(config({ kind: "document", root: "" }));
		expect(provider).toBeNull();
	});
});
