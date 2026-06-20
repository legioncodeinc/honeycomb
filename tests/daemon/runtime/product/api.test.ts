/**
 * PRD-022c product-data facade — c-AC-3 (skills+rules scoped reads), c-AC-4 (sources mounted,
 * /api/sources answers not 404), c-AC-5 (/api/secrets names-only never a value), and the
 * `mountProductDataApi` one-call seam the assembly (022d) fires.
 *
 * Verification posture: a `Daemon`-shaped object whose `group(path)` returns one bare Hono
 * router per known group; a canned-row storage fake for the version-bumped reads; the REAL
 * 013 sources deps (fake registry/queue/store/provider) and the REAL 012 `SecretsStore` over
 * a temp dir. Then drive every route with `app.request`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Daemon } from "../../../../src/daemon/runtime/server.js";
import type { QueryResult, StorageRow } from "../../../../src/daemon/storage/result.js";
import { ok } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import {
	mountProductDataApi,
	mountSkillsReadApi,
	mountRulesReadApi,
	SKILLS_GROUP,
	RULES_GROUP,
	SOURCES_GROUP,
	SECRETS_GROUP,
	GOALS_GROUP,
	KPIS_GROUP,
} from "../../../../src/daemon/runtime/product/api.js";

import type { SourcesApiDeps } from "../../../../src/daemon/runtime/sources/api.js";
import { createFakeSourceProvider } from "../../../../src/daemon/runtime/sources/contracts.js";
import type { SourceRegistry } from "../../../../src/daemon/runtime/sources/lifecycle.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { FakeArtifactStore } from "../../../helpers/fake-artifact-store.js";

import type { SecretsApiDeps } from "../../../../src/daemon/runtime/secrets/api.js";
import { SecretsStore } from "../../../../src/daemon/runtime/secrets/store.js";
import { createFakeMachineKeyProvider } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { KeyedTableFake } from "./_keyed-harness.js";

const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend", "content-type": "application/json" };

/** A storage fake that returns canned rows for the highest-version skills/rules SELECTs. */
class ReadFake implements StorageQuery {
	constructor(
		private readonly skills: StorageRow[],
		private readonly rules: StorageRow[],
	) {}
	query(sql: string, _scope: QueryScope): Promise<QueryResult> {
		if (/FROM\s+"skills"/i.test(sql)) return Promise.resolve(ok(this.skills.map((r) => ({ ...r })), 1));
		if (/FROM\s+"rules"/i.test(sql)) return Promise.resolve(ok(this.rules.map((r) => ({ ...r })), 1));
		return Promise.resolve(ok([], 1));
	}
}

/**
 * Build a `Daemon`-shaped object whose `group()` serves one router per known group. Mirrors
 * `server.ts`: each group is an `app.basePath(base)` router bound to the ROOT app, so a
 * handler attached AFTER `group()` is returned still registers on the root (a plain
 * `app.route(base, sub)` COPIES routes at call time and would miss the later attach).
 */
function makeDaemon(storage: StorageQuery, mode: "local" | "team" = "local") {
	const app = new Hono();
	const routers = new Map<string, Hono>();
	for (const g of [SKILLS_GROUP, RULES_GROUP, SOURCES_GROUP, SECRETS_GROUP, GOALS_GROUP, KPIS_GROUP]) {
		routers.set(g, app.basePath(g));
	}
	const daemon = {
		app,
		group: (path: string): Hono | undefined => routers.get(path),
		storage,
		config: { mode, port: 0 },
	};
	return { daemon: daemon as unknown as Daemon, app };
}

/** The daemon's configured default tenant (the single LOCAL tenant) injected via defaultScope. */
const DEFAULT_SCOPE = { org: "daemon-default-org", workspace: "daemon-default-ws" } as const;

function fakeQueue(): JobQueueService {
	return {
		async enqueue(_job: JobInput): Promise<string> {
			return "job-1";
		},
		async lease(): Promise<LeasedJob | null> {
			return null;
		},
		async complete(): Promise<void> {},
		async fail(): Promise<void> {},
		start(): void {},
		stop(): void {},
	};
}

function fakeRegistry(): SourceRegistry {
	const ids = ["src-1", "src-2"];
	return {
		async register(): Promise<string> {
			return "src-x";
		},
		async get() {
			return null;
		},
		async remove(): Promise<void> {},
		async list(): Promise<readonly string[]> {
			return ids;
		},
	};
}

function sourcesDeps(): SourcesApiDeps {
	return {
		storage: new FakeArtifactStore(),
		queue: fakeQueue(),
		registry: fakeRegistry(),
		providers: { resolve: () => createFakeSourceProvider([]) },
	};
}

describe("PRD-022c product-data facade", () => {
	let baseDir: string;
	let secretsStore: SecretsStore;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "honeycomb-022c-secrets-"));
		secretsStore = new SecretsStore({ baseDir, machineKey: createFakeMachineKeyProvider("host-a") });
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("c-AC-3 GET /api/skills returns the scoped tenant's mined skills", async () => {
		const storage = new ReadFake(
			[
				{ id: "s1", name: "deploy-flow", scope: "team", visibility: "global", version: 3 },
				{ id: "s2", name: "test-flow", scope: "me", visibility: "private", version: 1 },
			],
			[],
		);
		const { daemon, app } = makeDaemon(storage);
		mountSkillsReadApi(daemon, storage);
		const res = await app.request("/api/skills", { headers: HEADERS });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { skills: Array<{ name: string; version: number }> };
		expect(body.skills.map((s) => s.name)).toContain("deploy-flow");
		expect(body.skills.find((s) => s.name === "deploy-flow")?.version).toBe(3);
	});

	it("c-AC-3 GET /api/rules returns only the ACTIVE rules", async () => {
		const storage = new ReadFake(
			[],
			[
				{ id: "r1", key: "no-secrets-in-logs", name: "No secrets in logs", status: "active", version: 2 },
				{ id: "r2", key: "retired", name: "Retired rule", status: "superseded", version: 5 },
			],
		);
		const { daemon, app } = makeDaemon(storage);
		mountRulesReadApi(daemon, storage);
		const res = await app.request("/api/rules", { headers: HEADERS });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { rules: Array<{ key: string; status: string }> };
		expect(body.rules).toHaveLength(1);
		expect(body.rules[0]?.key).toBe("no-secrets-in-logs");
	});

	it("c-AC-3 skills/rules reads 400 fail-closed without x-honeycomb-org", async () => {
		const storage = new ReadFake([], []);
		const { daemon, app } = makeDaemon(storage);
		mountSkillsReadApi(daemon, storage);
		mountRulesReadApi(daemon, storage);
		expect((await app.request("/api/skills", {})).status).toBe(400);
		expect((await app.request("/api/rules", {})).status).toBe(400);
	});

	it("PRD-022 local mode + NO org header + defaultScope → skills read reaches the engine (200)", async () => {
		// The product-data read regression: a no-org loopback request must resolve to the
		// daemon's configured tenant in local mode (mountProductDataApi threads defaultScope).
		const storage = new ReadFake(
			[{ id: "s1", name: "deploy-flow", scope: "team", visibility: "global", version: 3 }],
			[],
		);
		const { daemon, app } = makeDaemon(storage, "local");
		mountProductDataApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		// Session-less, org-less request (the thin-client shape) — only content-type.
		const res = await app.request("/api/skills", { headers: { "content-type": "application/json" } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { skills: Array<{ name: string }> };
		expect(body.skills.map((s) => s.name)).toContain("deploy-flow");
	});

	it("PRD-022 local mode + NO org header + NO defaultScope → skills read still 400 (defensive)", async () => {
		const storage = new ReadFake([], []);
		const { daemon, app } = makeDaemon(storage, "local");
		mountProductDataApi(daemon, { storage }); // no defaultScope → fail-closed
		expect((await app.request("/api/skills", {})).status).toBe(400);
	});

	it("PRD-022 TEAM mode + NO org header → skills read STILL 400 even WITH a defaultScope", async () => {
		const storage = new ReadFake([], []);
		const { daemon, app } = makeDaemon(storage, "team");
		// Even with a defaultScope, team mode must not fall back — tenancy still required.
		mountProductDataApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		expect((await app.request("/api/skills", {})).status).toBe(400);
		expect((await app.request("/api/rules", {})).status).toBe(400);
	});

	it("PRD-022 org header present (local, with defaultScope) → the read still answers via the header scope", async () => {
		const storage = new ReadFake(
			[{ id: "s1", name: "deploy-flow", scope: "team", visibility: "global", version: 3 }],
			[],
		);
		const { daemon, app } = makeDaemon(storage, "local");
		mountProductDataApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await app.request("/api/skills", { headers: HEADERS });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { skills: Array<{ name: string }> };
		expect(body.skills.map((s) => s.name)).toContain("deploy-flow");
	});

	it("PRD-022 goals upsert: local mode + NO org header + defaultScope → write lands (201)", async () => {
		// A keyed-engine write also honours the fallback (mountProductDataApi threads it to goals/kpis).
		const storage = new KeyedTableFake("goals");
		const { daemon, app } = makeDaemon(storage, "local");
		mountProductDataApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await app.request("/api/goals", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "k1", value: "v1" }),
		});
		expect(res.status).toBe(201);
	});

	it("PRD-022 goals upsert: TEAM mode + NO org header → STILL 400 even WITH a defaultScope", async () => {
		const storage = new KeyedTableFake("goals");
		const { daemon, app } = makeDaemon(storage, "team");
		mountProductDataApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await app.request("/api/goals", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "k1", value: "v1" }),
		});
		expect(res.status).toBe(400);
	});

	it("c-AC-4 mountProductDataApi wires /api/sources so it answers (not 404)", async () => {
		const storage = new ReadFake([], []);
		const { daemon, app } = makeDaemon(storage);
		mountProductDataApi(daemon, { storage, sources: sourcesDeps() });
		const res = await app.request("/api/sources", { headers: HEADERS });
		expect(res.status).not.toBe(404);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sources: string[] };
		expect(body.sources).toEqual(["src-1", "src-2"]);
	});

	it("c-AC-5 /api/secrets returns NAMES only, never a value", async () => {
		const storage = new ReadFake([], []);
		const { daemon, app } = makeDaemon(storage);
		const secretsDeps: SecretsApiDeps = { store: secretsStore };
		mountProductDataApi(daemon, { storage, secrets: secretsDeps });

		// Store a secret (the value goes in, nothing comes back but ok + name).
		const stored = await app.request("/api/secrets/openai.key", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ value: "sk-super-secret-value" }),
		});
		expect(stored.status).toBe(201);
		const storedBody = await stored.text();
		expect(storedBody).not.toContain("sk-super-secret-value");

		// List → names only.
		const list = await app.request("/api/secrets", { headers: HEADERS });
		expect(list.status).toBe(200);
		const listBody = await list.text();
		expect(listBody).toContain("openai.key");
		expect(listBody).not.toContain("sk-super-secret-value");

		// There is NO value-returning GET /api/secrets/:name route (the absence is the property).
		const probe = await app.request("/api/secrets/openai.key", { headers: HEADERS });
		expect(probe.status).toBe(404);
	});

	it("c-AC-4/c-AC-5 sources + secrets mounts are skipped when their deps are absent (no throw)", async () => {
		const storage = new ReadFake([], []);
		const { daemon, app } = makeDaemon(storage);
		// No sources/secrets deps → those mounts are skipped; goals/kpis/skills/rules still wire.
		mountProductDataApi(daemon, { storage });
		// skills still answers (proves the facade wired the always-on reads).
		expect((await app.request("/api/skills", { headers: HEADERS })).status).toBe(200);
	});
});
