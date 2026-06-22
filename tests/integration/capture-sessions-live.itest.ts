/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE sessions CAPTURE SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.   ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-005a: POST a capture event through the daemon's /api/hooks/capture   ║
 * ║  route (in-process via app.request) → assert exactly ONE real `sessions`  ║
 * ║  row is written → read it back by `path`. `sessions` is append-only, so   ║
 * ║  the write is DETERMINISTIC on this backend (no in-place UPDATE flap).    ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like memory-jobs-live.itest.ts:                ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole      ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of ║
 * ║      `npm run test` / `npm run ci`. Run only via `npm run test:integration`║
 * ║    - Runs in the SAME authorized workspace the token is scoped to         ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`) — an        ║
 * ║      invented partition is 403-rejected by the real backend.             ║
 * ║    - Points the capture handler at a per-run THROWAWAY table             ║
 * ║      (`ci_sessions_<run-id>`) with the SAME `SESSIONS_COLUMNS`, and DROPs ║
 * ║      it in afterAll. It NEVER touches a real daemon's `sessions`.         ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's    ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type StorageClient,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import { SESSIONS_COLUMNS } from "../../src/daemon/storage/catalog/sessions-summaries.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import { type RuntimeConfig } from "../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../src/daemon/runtime/middleware/runtime-path.js";
import { createCaptureHandler } from "../../src/daemon/runtime/capture/capture-handler.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_sessions_${RUN_ID}`;

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

describe.skipIf(!HAS_TOKEN)("live sessions capture smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
			}),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably remove rows).
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}`);
	});

	it("POST capture → one real sessions row written + read back by path", async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the capture round-trip on DeepLake
		// weather. A non-transient failure (real defect) or an ok probe continues with full teeth.
		await neutralizeIfInfraDegraded("capture-sessions-live:preflight", () => storage.connect({ org, workspace }), skip);

		// Borrow the single-sourced SESSIONS_COLUMNS under a throwaway table name so
		// the live write never touches a real `sessions`. The capture handler lazily
		// heals the table into existence on the first INSERT (FR-7).
		const sessionsTarget: HealTarget = { table: CI_TABLE, columns: SESSIONS_COLUMNS };
		const daemon = createDaemon({
			config: cfg(),
			storage,
			logger: createRequestLogger({ silent: true }),
			services: { runtimePath: createRuntimePathService() },
		});
		createCaptureHandler({ storage, sessionsTarget, queue: daemon.services.queue }).register(daemon);

		const path = `conversations/${RUN_ID}`;
		const headers = {
			"content-type": "application/json",
			"x-honeycomb-runtime-path": "plugin",
			"x-honeycomb-session": RUN_ID,
			"x-honeycomb-org": org,
			"x-honeycomb-workspace": workspace,
		};
		const body = {
			event: { kind: "user_message", text: `live capture ${RUN_ID}` },
			metadata: {
				sessionId: RUN_ID,
				path,
				cwd: "/repo",
				permissionMode: "default",
				hookEventName: "UserPromptSubmit",
				agentId: "ci-agent",
				org,
				workspace,
				agent: "ci",
				pluginVersion: "0.1.0",
			},
		};

		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(res.status, "capture must succeed against the real backend").toBe(201);
		const captured = (await res.json()) as { ok: boolean; id: string; path: string };
		expect(captured.ok).toBe(true);

		// Read it back through the daemon's own read-back route, scoped to the tenancy.
		const readback = await daemon.app.request(`/api/hooks/conversation?path=${encodeURIComponent(path)}`, {
			headers,
		});
		expect(readback.status).toBe(200);
		const conversation = (await readback.json()) as { path: string; rows: Record<string, unknown>[] };
		// Exactly one row for this fresh per-run path, and it is the row we wrote.
		expect(conversation.rows.length, "exactly one append-only row for this path").toBe(1);
		expect(conversation.rows[0].id).toBe(captured.id);
		// The JSONB `message` round-trips as a parsed object on this backend; normalize
		// to a string either way and assert the captured prompt survived intact (FR-4).
		const raw = conversation.rows[0].message;
		const messageText = typeof raw === "string" ? raw : JSON.stringify(raw);
		expect(messageText).toContain(`live capture ${RUN_ID}`);
	});
});
