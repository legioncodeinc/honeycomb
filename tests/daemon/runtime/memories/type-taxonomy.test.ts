/**
 * The CLOSED memory-type taxonomy — SERVER gate suite.
 *
 * Proves, against the same fake-but-real SQL-aware `StorageQuery` harness the 022a suite
 * uses, that `POST /api/memories` enforces the six-token enum at the zod boundary:
 *   - each of the six {@link MEMORY_TYPES} is ACCEPTED (201) and lands its token in the
 *     INSERT (the `type` column value);
 *   - an OMITTED type defaults to `fact` in the INSERT (the column DDL default, unchanged);
 *   - an UNKNOWN type is REJECTED with a 400 that NAMES the valid set, BEFORE any INSERT
 *     reaches storage (write-time gate; no silent coerce).
 *
 * The gate constrains ONLY this user-facing path — the autonomous pipeline writes its
 * model-assigned `fact_type` directly (see `fan-out.ts`), never through this schema.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountMemoriesApi, storeMemory } from "../../../../src/daemon/runtime/memories/index.js";
import { resolvePipelineConfig } from "../../../../src/daemon/runtime/pipeline/config.js";
import { MEMORY_TYPES } from "../../../../src/shared/memory-types.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";
const SESSION = "sess-taxonomy";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** Session-group headers for a fully-formed in-process request (org + runtime-path + session). */
function headers(): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		"content-type": "application/json",
	};
}

/** A responder whose dedup probe finds no existing row, so every store INSERTs. */
function makeDaemon() {
	const responder = (_req: TransportRequest): Record<string, unknown>[] => [];
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	mountMemoriesApi(daemon, { storage });
	return { daemon, fake };
}

/** The single `INSERT INTO "memories"` SQL the store produced (the row whose `type` we assert). */
function memoriesInsertSql(fake: FakeDeepLakeTransport): string | undefined {
	return fake.requests.map((r) => r.sql).find((sql) => /INSERT INTO\s+"memories"/i.test(sql));
}

describe("memory-type taxonomy — POST /api/memories enum gate", () => {
	for (const type of MEMORY_TYPES) {
		it(`accepts the valid type "${type}" (201) and lands its token in the INSERT`, async () => {
			const { daemon, fake } = makeDaemon();
			const res = await daemon.app.request("/api/memories", {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ content: `a memory of type ${type}`, type }),
			});
			expect(res.status).toBe(201);
			const insert = memoriesInsertSql(fake);
			expect(insert, "the store must have INSERTed a memories row").toBeDefined();
			// The `type` column value is rendered as a single-quoted literal by the SQL helpers.
			expect(insert).toContain(`'${type}'`);
		});
	}

	it("defaults to 'fact' when type is omitted (the column DDL default, no migration)", async () => {
		const { daemon, fake } = makeDaemon();
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ content: "an untyped memory" }),
		});
		expect(res.status).toBe(201);
		const insert = memoriesInsertSql(fake);
		expect(insert).toBeDefined();
		expect(insert).toContain("'fact'");
	});

	it("REJECTS an unknown type with a 400 that names the valid set, before any INSERT", async () => {
		const { daemon, fake } = makeDaemon();
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ content: "a memory", type: "banana" }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string; issues: { path: string; message: string }[] };
		expect(json.error).toBe("bad_request");
		// The 400 message NAMES the valid set (every token) so the caller can self-correct.
		const messages = json.issues.map((i) => i.message).join(" ");
		for (const t of MEMORY_TYPES) expect(messages).toContain(t);
		// The gate is write-time: a rejected type never reaches an INSERT.
		expect(memoriesInsertSql(fake)).toBeUndefined();
	});
});

describe("memory-type taxonomy — internal/default writes still yield 'fact'", () => {
	it("an internal storeMemory with no type lands 'fact' (the system path is unbroken by the gate)", async () => {
		const fake = new FakeDeepLakeTransport((_req: TransportRequest) => []);
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		// Call the write adapter DIRECTLY (the controlled-writes ADD path the pipeline uses),
		// bypassing the API zod gate entirely — exactly how an internal/system write reaches storage.
		const result = await storeMemory(
			{ content: "an internally-stored fact", scope: { org: ORG, workspace: WORKSPACE } },
			{ storage, config: resolvePipelineConfig(), newId: () => "mem-internal-1" },
		);
		expect(result.outcome.action).toBe("inserted");
		expect(memoriesInsertSql(fake)).toContain("'fact'");
	});
});
