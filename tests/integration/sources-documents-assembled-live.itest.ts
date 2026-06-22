/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE Sources + Documents ASSEMBLED-DAEMON SMOKE — OPT-IN, REAL BACKEND. ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-045e: boot the REAL `bootTestDaemon({mode:"local"})` harness against  ║
 * ║  LIVE DeepLake on an EPHEMERAL port (NOT 3850) — the SAME assembly the     ║
 * ║  daemon ships — and drive the now-wired `/api/sources` + `/api/documents`  ║
 * ║  surface end-to-end over HTTP, proving the PRD-013 daemon-wiring gap is    ║
 * ║  closed:                                                                  ║
 * ║                                                                          ║
 * ║    e-AC-2/e-AC-4: POST /api/sources (obsidian, real temp vault) → 201;     ║
 * ║      GET /api/sources lists it (add → list); GET /api/sources/:id/health   ║
 * ║      reports provider health (the "sync" status). NONE return 501.        ║
 * ║    e-AC-3: POST /api/documents (a per-run-unique url) → 202; poll          ║
 * ║      GET /api/documents/:id until `done`; the document's chunks are        ║
 * ║      present + active in `document_chunk` (recallable — keyword-queryable). ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (mirrors product-data-api-live.itest.ts):              ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.    ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`;     ║
 * ║      only `npm run test:integration` runs it.                            ║
 * ║    - Ephemeral port (0): the OS picks a free port; 3850 is never bound.    ║
 * ║    - PER-RUN-UNIQUE urls/roots so reruns never collide; the assembled      ║
 * ║      daemon writes to the REAL artifact tables (no resolveTable seam is    ║
 * ║      exposed at the composition root), so we DELETE/purge our own rows via ║
 * ║      the API in teardown (append-only soft-delete) and never DROP a table. ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT read-backs: this backend serves segments of differing    ║
 * ║  freshness that flap, so every live read-back polls until it converges.    ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from env via the storage layer's          ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ║                                                                          ║
 * ║  Do NOT run locally (no creds) — the orchestrator runs it.                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStorageClient, isOk, sLiteral, sqlIdent, type StorageClient } from "../../src/daemon/storage/index.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import {
	ARTIFACT_ACTIVE,
	DOCUMENT_CHUNK_TABLE,
} from "../../src/daemon/storage/catalog/sources.js";
import { type BootedTestDaemon, bootTestDaemon } from "./_daemon-harness.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** The org/workspace the booted local-mode daemon resolves its scope to (env-over-file). */
const ORG = process.env.HONEYCOMB_DEEPLAKE_ORG ?? "local";
const WORKSPACE = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "default";
const HEADERS = {
	"x-honeycomb-org": ORG,
	"x-honeycomb-workspace": WORKSPACE,
	"content-type": "application/json",
} as const;

/** A per-run suffix so reruns never collide and the proofs are unambiguous. */
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!HAS_TOKEN)("LIVE PRD-045e: /api/sources + /api/documents on the assembled daemon", () => {
	let booted: BootedTestDaemon | null = null;
	let probeStorage: StorageClient;
	let vaultDir: string;
	const scope: QueryScope = { org: ORG, workspace: WORKSPACE };

	beforeAll(async () => {
		const storage = createStorageClient();
		probeStorage = storage;
		booted = await bootTestDaemon({ mode: "local", storage });
		// A real temp vault so the obsidian provider's connect() probe finds a directory.
		vaultDir = mkdtempSync(join(tmpdir(), `honeycomb-045e-${RUN}-`));
		writeFileSync(join(vaultDir, "note.md"), `# 045e ${RUN}\n\nrecallable vault body for ${RUN}\n`);
	}, 120_000);

	afterAll(async () => {
		if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
		if (booted !== null) {
			try {
				await booted.stop();
			} catch {
				// Already stopped — a double stop is a no-op.
			}
		}
	});

	it(
		"e-AC-2/e-AC-4 obsidian source round-trips add → list → sync(health), all live (no 501)",
		async ({ skip }) => {
			await neutralizeIfInfraDegraded("sources-documents-assembled-live:preflight", () => probeStorage.connect(scope), skip);
			expect(booted, "the daemon booted against live DeepLake").not.toBeNull();
			const b = booted!;

			// add: POST /api/sources connects the obsidian source → 201 (registers + queues).
			const add = await fetch(`${b.baseUrl}/api/sources`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ kind: "obsidian", root: vaultDir, settings: { vaultPath: vaultDir } }),
			});
			expect(add.status, "POST /api/sources connects (no 501/400)").toBe(201);
			const addBody = (await add.json()) as { sourceId: string; jobId: string; health?: { state?: string } };
			expect(addBody.sourceId, "a source id was assigned").toBeTypeOf("string");
			expect(addBody.jobId, "an index job was enqueued on the daemon's own queue").toBeTypeOf("string");
			expect(addBody.health?.state, "the obsidian provider connected to the vault dir").toBe("connected");
			const sourceId = addBody.sourceId;

			// list: GET /api/sources surfaces the just-added source (poll-convergent — the
			// registry config row is written append-only and may flap on a stale segment).
			let listed = false;
			for (let poll = 0; poll < 40 && !listed; poll++) {
				const list = await fetch(`${b.baseUrl}/api/sources`, { headers: HEADERS });
				expect(list.status).toBe(200);
				const body = (await list.json()) as { sources: string[] };
				if (body.sources.includes(sourceId)) listed = true;
				else await new Promise((r) => setTimeout(r, 400));
			}
			expect(listed, "the added source appears in GET /api/sources").toBe(true);

			// sync: GET /api/sources/:id/health reports the provider health + store footprint
			// (the "sync" status surface). The handler runs (not 501); state is connected.
			const health = await fetch(`${b.baseUrl}/api/sources/${sourceId}/health`, { headers: HEADERS });
			expect(health.status, "the source health route reaches its handler (no 501)").toBe(200);
			const healthBody = (await health.json()) as { provider?: { state?: string }; status?: string };
			expect(healthBody.provider?.state, "health reports the obsidian provider connected").toBe("connected");

			// cleanup: DELETE /api/sources/:id purges (append-only soft-delete) our config row.
			const del = await fetch(`${b.baseUrl}/api/sources/${sourceId}`, { method: "DELETE", headers: HEADERS });
			expect([200, 404]).toContain(del.status);
		},
		120_000,
	);

	it(
		"e-AC-3 POST /api/documents ingests a doc through the wired worker → done → chunks recallable",
		async () => {
			const b = booted!;
			const url = `https://example.com/045e/${RUN}/a-reasonably-long-document-body-for-chunking`;

			// POST /api/documents → 202 (the worker is wired; NOT the 501 scaffold).
			const post = await fetch(`${b.baseUrl}/api/documents`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ url }),
			});
			expect(post.status, "the document worker is wired → 202, not 501").toBe(202);
			const postBody = (await post.json()) as { documentId: string; status: string };
			const documentId = postBody.documentId;
			expect(documentId, "a document id was assigned").toBeTypeOf("string");

			// poll GET /api/documents/:id until the worker's synchronous ingest converges to `done`.
			let status = postBody.status;
			for (let poll = 0; poll < 60 && status !== "done"; poll++) {
				const get = await fetch(`${b.baseUrl}/api/documents/${documentId}`, { headers: HEADERS });
				if (get.status === 200) {
					const body = (await get.json()) as { status: string };
					status = body.status;
					if (status === "done") break;
				}
				await new Promise((r) => setTimeout(r, 400));
			}
			expect(status, "the ingested document reaches `done` (extract→chunk→embed→index)").toBe("done");

			// recallable: the document's chunks are present + active in `document_chunk`
			// (keyword-searchable rows). Poll-convergent count of active chunks for this doc.
			let activeChunks = 0;
			const chunkSql =
				`SELECT id, status FROM "${sqlIdent(DOCUMENT_CHUNK_TABLE)}" ` +
				`WHERE artifact_id = ${sLiteral(documentId)}`;
			for (let poll = 0; poll < 40 && activeChunks === 0; poll++) {
				const res = await probeStorage.query(chunkSql, scope);
				if (isOk(res)) {
					activeChunks = res.rows.filter((r) => String(r.status ?? "") === ARTIFACT_ACTIVE).length;
				}
				if (activeChunks === 0) await new Promise((r) => setTimeout(r, 400));
			}
			expect(activeChunks, "the ingested document produced recallable (active) chunks").toBeGreaterThan(0);

			// cleanup: soft-delete the document + its linked chunks via the API (append-only).
			const del = await fetch(`${b.baseUrl}/api/documents/${documentId}`, { method: "DELETE", headers: HEADERS });
			expect([200, 404]).toContain(del.status);
		},
		180_000,
	);
});

// A no-token guard so the suite is never silently empty in a non-gated runner.
describe.skipIf(HAS_TOKEN)("LIVE PRD-045e (skipped: no HONEYCOMB_DEEPLAKE_TOKEN)", () => {
	it("is gated off without a live token", () => {
		expect(typeof bootTestDaemon).toBe("function");
	});
});
