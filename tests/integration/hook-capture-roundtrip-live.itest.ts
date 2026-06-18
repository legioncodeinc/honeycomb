/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE HOOK→DAEMON→STORAGE COMPOSITION SMOKE — OPT-IN, MUTATES REAL DEEPLAKE║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The SAME vertical slice as tests/composition/hook-capture-roundtrip.test ║
 * ║  but against a REAL live DeepLake backend instead of the fake transport.  ║
 * ║  A native Claude-Code `UserPromptSubmit` event flows through the REAL      ║
 * ║  shim + normalize core → the REAL `runCapture` → the authored             ║
 * ║  `DaemonHookClient` (the deferred transport glue) → `daemon.app.request`   ║
 * ║  (in-process, no socket) → the REAL runtime-path + permission middleware → ║
 * ║  the REAL `attachHooksHandlers` capture handler → a REAL append-only       ║
 * ║  INSERT → read back by path. Proves the real surfaces COMPOSE against a    ║
 * ║  real backend, not just a double.                                         ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (mirrors capture-sessions-live.itest.ts /       ║
 * ║  summary-write-live.itest.ts):                                           ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, the run exits 0.                                        ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of  ║
 * ║      `npm run test` / `npm run ci`. Only `npm run test:integration` runs   ║
 * ║      it.                                                                  ║
 * ║    - Runs in the authorized workspace the token is scoped to               ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`).            ║
 * ║    - Points the capture handler at a per-run THROWAWAY table              ║
 * ║      (`ci_compose_sessions_<run-id>`) with the SAME `SESSIONS_COLUMNS`;    ║
 * ║      the handler lazily HEALs it into existence on the first INSERT, and   ║
 * ║      it is DROPped in afterAll. It NEVER touches a real `sessions`.        ║
 * ║                                                                          ║
 * ║  120s PER-TEST TIMEOUT: a live hook→daemon→storage round-trip plus a       ║
 * ║  poll-convergent read-back is slower than the 60s live-suite default.      ║
 * ║  Following the just-merged document-worker-live.itest.ts precedent, the    ║
 * ║  heavy test sets a 120_000 third-arg.                                     ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT read-back: this backend serves reads from segments of     ║
 * ║  differing freshness, so a single immediate read of a just-written row can ║
 * ║  under-report. We poll until the row is visible — a read can miss the      ║
 * ║  write but never invents one, so polling converges UP to the durable row.  ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's     ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ║                                                                          ║
 * ║  Do NOT run this locally (no creds) — the orchestrator runs it.           ║
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
import { attachHooksHandlers } from "../../src/daemon/runtime/capture/attach.js";

import { createClaudeCodeShim } from "../../src/hooks/claude-code/shim.js";
import { runCapture } from "../../src/hooks/shared/index.js";
import type { CaptureGateEnv, HookCoreDeps, HookSessionMeta } from "../../src/hooks/shared/index.js";

import { createDaemonHookClient } from "../composition/daemon-hook-client.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run THROWAWAY table — the `sessions` shape, isolated, DROPped in teardown. */
const CI_TABLE = `ci_compose_sessions_${RUN_ID}`;

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	// `local` mode: the permission middleware is open, so the slice exercises the REAL
	// runtime-path middleware against the real backend without a real authenticator.
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A Claude-Code `UserPromptSubmit` native hook event (the real native payload shape). */
function userPromptSubmitEvent(prompt: string) {
	return { name: "UserPromptSubmit", payload: { prompt } };
}

/** The session metadata the harness threads onto the turn (the shim's own shape — NO tenancy). */
function meta(sessionId: string, path: string): HookSessionMeta {
	return {
		sessionId,
		path,
		cwd: "/repo/honeycomb",
		permissionMode: "default",
		agentId: "ci-compose-agent",
		agent: "claude-code",
	};
}

/** Default capture env: permissive gate (capture enabled, no worker marker). */
const CAPTURE_ENV: CaptureGateEnv = {};

describe.skipIf(!HAS_TOKEN)("LIVE COMPOSITION: real hook → real core → real daemon → real storage round-trip", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
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

	it(
		"normalizes + captures one real sessions row through the full real chain, reads it back by path (poll-convergent), and a second runtime path 409s",
		async () => {
			// Borrow the single-sourced SESSIONS_COLUMNS under a throwaway table name so the
			// live write never touches a real `sessions`. The capture handler lazily heals
			// the table into existence on the first INSERT (FR-7).
			const sessionsTarget: HealTarget = { table: CI_TABLE, columns: SESSIONS_COLUMNS };
			const daemon = createDaemon({
				config: cfg(),
				storage,
				logger: createRequestLogger({ silent: true }),
				services: { runtimePath: createRuntimePathService() },
			});
			// The REAL daemon-side attach step pointed at the throwaway table.
			attachHooksHandlers(daemon, { storage, queue: daemon.services.queue, sessionsTarget });

			// The authored transport glue (the deferred assembly step), resolving the live tenancy.
			const daemonClient = createDaemonHookClient(daemon, { org, workspace });
			const deps: HookCoreDeps = {
				daemon: daemonClient,
				credentials: { async read() { return undefined; } },
				context: { async render() { return ""; } },
			};

			const shim = createClaudeCodeShim();
			const sessionId = `compose-${RUN_ID}`;
			const path = `conversations/${RUN_ID}`;
			const prompt = `live compose round-trip ${RUN_ID}`;

			// REAL shim + REAL normalize engine: native event → normalized HookInput.
			const input = shim.normalize(userPromptSubmitEvent(prompt), meta(sessionId, path));
			expect(input, "the real shim normalized the native event").toBeDefined();
			expect(input?.event).toBe("user_message");
			expect(input?.runtimePath).toBe("legacy");

			// REAL runCapture → authored transport → REAL handler → REAL live storage.
			const result = await runCapture(input!, deps, CAPTURE_ENV);
			expect(result.ok, "the real capture path completed end-to-end against the live backend").toBe(true);

			// Read the turn back BY PATH through the REAL /api/hooks/conversation route, scoped
			// to the tenancy. Poll-convergent: a just-written row may not be visible immediately.
			const headers = {
				"x-honeycomb-runtime-path": "legacy",
				"x-honeycomb-session": sessionId,
				"x-honeycomb-org": org,
				"x-honeycomb-workspace": workspace,
			};
			let back: Record<string, unknown> | null = null;
			for (let poll = 0; poll < 40 && back === null; poll++) {
				const readback = await daemon.app.request(`/api/hooks/conversation?path=${encodeURIComponent(path)}`, {
					headers,
				});
				if (readback.status === 200) {
					const conversation = (await readback.json()) as { rows: Record<string, unknown>[] };
					if (conversation.rows.length > 0) back = conversation.rows[0];
				}
				if (back === null) await new Promise((r) => setTimeout(r, 350));
			}
			expect(back, "the captured turn is visible on read-back after polling").not.toBeNull();
			// The JSONB message round-trips (string or parsed object on this backend); the
			// captured prompt survived intact (FR-4).
			const raw = back!.message;
			const messageText = typeof raw === "string" ? raw : JSON.stringify(raw);
			expect(messageText, "the captured prompt survived the live round-trip").toContain(prompt);
			expect(messageText).toContain("user_message");
			// The dedicated columns carry the normalized provenance onto the row.
			expect(back!.path).toBe(path);
			expect(back!.filename, "hook event name → filename column").toBe("UserPromptSubmit");

			// SECOND runtime path (`plugin`) on the SAME session → the REAL runtime-path
			// middleware fires its 409 end-to-end, before any write.
			const conflict = await daemonClient.send({
				endpoint: "capture",
				body: {
					event: { kind: "user_message", text: `second path ${RUN_ID}` },
					metadata: { sessionId, path },
				},
				meta: { sessionId, path },
				runtimePath: "plugin",
			});
			expect(conflict.status, "the real runtime-path middleware rejects the second path 409").toBe(409);
		},
		120_000,
	);
});
