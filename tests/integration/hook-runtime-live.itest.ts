/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE HOOK RUNTIME — OPT-IN, MUTATES REAL DEEPLAKE (PRD-021c golden path)  ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Wave 2 of go-live: a native Claude-Code-shaped hook event travels         ║
 * ║  END-TO-END from the PRODUCTION hook runtime to a captured DeepLake row,   ║
 * ║  through a REAL assembled daemon (no fakes in the daemon path).            ║
 * ║                                                                          ║
 * ║  THE REAL CHAIN:                                                          ║
 * ║    bootTestDaemon() (021a) → REAL assembleDaemon() against live DeepLake   ║
 * ║      on an EPHEMERAL port (never 3850)                                    ║
 * ║    → the PRODUCTION `DaemonHookClient` (real `fetch` over loopback,        ║
 * ║      tenancy resolved by the PRODUCTION `CredentialReader` reading a       ║
 * ║      temp `credentials.json`)                                             ║
 * ║    → the REAL attached `/api/hooks/capture` (021c c-AC-3 attach)           ║
 * ║    → a REAL append-only `sessions` INSERT → read back by path             ║
 * ║      (poll-convergent).                                                   ║
 * ║    Then a session-end through the production client → the attached         ║
 * ║    `/api/hooks/session-end` serves (the summary path fires).              ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED:                                                        ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip, exit 0.║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of         ║
 * ║      `npm run ci`. Only `npm run test:integration` runs it.                ║
 * ║    - Runs in the token's authorized workspace                             ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`).            ║
 * ║    - Append-only + per-run unique `path`/`session_id`, so the read-back    ║
 * ║      sees only this run's rows; it never reads or clobbers a real session. ║
 * ║                                                                          ║
 * ║  120s CAP. Embeddings may be OFF (BM25). SECRETS: the token reaches the    ║
 * ║  daemon ONLY via the storage layer's env provider — never hardcoded,       ║
 * ║  logged, or echoed. Do NOT run locally — the orchestrator runs it.        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	envCredentialProvider,
	resolveStorageConfig,
} from "../../src/daemon/storage/index.js";

import { createClaudeCodeShim } from "../../src/hooks/claude-code/shim.js";
import {
	createCredentialReader,
	createDaemonHookClient,
	type HookSessionMeta,
	runCapture,
	runSessionEnd,
} from "../../src/hooks/shared/index.js";
import { createFakeSummarySpawn } from "../../src/hooks/shared/session-end.js";

import { bootTestDaemon, type BootedTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();

/** A native Claude-Code `UserPromptSubmit` envelope (the real native payload shape). */
function userPromptSubmitEvent(prompt: string, sessionId: string, path: string) {
	return { name: "UserPromptSubmit", payload: { prompt, session_id: sessionId, transcript_path: path } };
}

/** The session metadata the harness threads onto the turn (NO tenancy — the transport stamps it). */
function meta(sessionId: string, path: string): HookSessionMeta {
	return { sessionId, path, cwd: "/repo/honeycomb", agent: "claude-code" };
}

describe.skipIf(!HAS_TOKEN)("LIVE 021c: native hook event → production runtime → real daemon → real sessions row", () => {
	let booted: BootedTestDaemon;
	let credDir: string;
	let org: string;
	let workspace: string;

	beforeAll(async () => {
		// Resolve the token's authorized tenancy from the env provider (the SAME scope the
		// assembled daemon's storage client resolves), so the captured row lands in-scope.
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

		// Write a real credentials.json the PRODUCTION CredentialReader reads — so the
		// production transport stamps the SAME tenancy the daemon runs under. No fake reader.
		credDir = mkdtempSync(join(tmpdir(), "honeycomb-021c-creds-"));
		writeFileSync(
			join(credDir, "credentials.json"),
			JSON.stringify({
				token: process.env.HONEYCOMB_DEEPLAKE_TOKEN,
				orgId: org,
				orgName: org,
				workspace,
				agentId: "ci-021c-agent",
				savedAt: new Date().toISOString(),
			}),
		);

		// Boot the REAL assembled daemon against live DeepLake on an ephemeral port (021a).
		booted = await bootTestDaemon({ storage: undefinedToLive(provider) });
	}, 120_000);

	afterAll(async () => {
		if (booted) await booted.stop();
		if (credDir) rmSync(credDir, { recursive: true, force: true });
	});

	it(
		"captures a real sessions row through the production DaemonHookClient and reads it back; session-end fires",
		async () => {
			// The PRODUCTION transport over REAL loopback HTTP, tenancy from the PRODUCTION reader.
			const credentials = createCredentialReader({ dir: credDir, env: {} });
			const { host, port } = booted.address;
			const daemonClient = createDaemonHookClient({ credentials, host, port });
			const deps = {
				daemon: daemonClient,
				credentials,
				context: { async render() { return ""; } },
			};

			const shim = createClaudeCodeShim();
			const sessionId = `021c-${RUN_ID}`;
			const path = `conversations/021c-${RUN_ID}`;
			const prompt = `live 021c hook runtime ${RUN_ID}`;

			// REAL shim + normalize → REAL runCapture → PRODUCTION client → REAL daemon → REAL storage.
			const input = shim.normalize(userPromptSubmitEvent(prompt, sessionId, path), meta(sessionId, path));
			expect(input?.event).toBe("user_message");
			expect(input?.runtimePath).toBe("legacy");
			const result = await runCapture(input!, deps, {});
			expect(result.ok, "the production capture path completed end-to-end against the live daemon").toBe(true);

			// Read the row back BY PATH through the REAL /api/hooks/conversation route over loopback.
			const headers = {
				"x-honeycomb-runtime-path": "legacy",
				"x-honeycomb-session": sessionId,
				"x-honeycomb-org": org,
				"x-honeycomb-workspace": workspace,
			};
			let back: Record<string, unknown> | null = null;
			for (let poll = 0; poll < 40 && back === null; poll++) {
				const res = await fetch(`${booted.baseUrl}/api/hooks/conversation?path=${encodeURIComponent(path)}`, {
					headers,
				});
				if (res.status === 200) {
					const conversation = (await res.json()) as { rows: Record<string, unknown>[] };
					if (conversation.rows.length > 0) back = conversation.rows[0];
				}
				if (back === null) await new Promise((r) => setTimeout(r, 350));
			}
			expect(back, "the captured turn is visible on read-back after polling").not.toBeNull();
			const rawMsg = back!.message;
			const messageText = typeof rawMsg === "string" ? rawMsg : JSON.stringify(rawMsg);
			expect(messageText, "the captured prompt survived the live round-trip").toContain(prompt);
			expect(back!.path).toBe(path);

			// SESSION-END through the production client → the attached /api/hooks/session-end serves.
			const endInput = shim.normalize(
				{ name: "SessionEnd", payload: { reason: "Stop", session_id: sessionId, transcript_path: path } },
				meta(sessionId, path),
			);
			const spawn = createFakeSummarySpawn();
			const endResult = await runSessionEnd(endInput!, deps, spawn);
			expect(endResult.ok, "the session-end lifecycle completed (summary path fired)").toBe(true);
			// The detached summary worker was spawned exactly once for this session.
			expect(spawn.spawns).toContain(sessionId);
		},
		120_000,
	);
});

/** Pass the live provider's client through (the harness builds the live client from env when undefined). */
function undefinedToLive(_provider: { read: () => unknown }): undefined {
	// `bootTestDaemon` defaults `storage` to the LIVE `createStorageClient()` (env creds). We let
	// it build the live client itself so the daemon path is 100% production; the test's separate
	// `provider` only resolves the tenancy strings for the read-back assertions.
	void _provider;
	return undefined;
}
