import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/index.js";

const ENV_KEYS = [
	"HONEYCOMB_NO_AUTO_UPDATE",
	"HIVEDOCTOR_HEALTH_URL",
	"HIVEDOCTOR_WORKSPACE_DIR",
	"HIVEDOCTOR_STATUS_PAGE_PORT",
	"HIVEDOCTOR_PROBE_INTERVAL_MS",
	"HIVEDOCTOR_STARTUP_GRACE_MS",
	"HIVEDOCTOR_INSTALL_HEALTH_INTERVAL_MS",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const priorEnv: Partial<Record<EnvKey, string | undefined>> = {};
let blocker: Server | null = null;
let workspace: string | null = null;

async function blockEphemeralPort(): Promise<number> {
	const server = createServer((_req, res) => {
		res.writeHead(200);
		res.end("blocked");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	blocker = server;
	const address = server.address();
	if (address === null || typeof address !== "object") throw new Error("expected TCP address");
	return address.port;
}

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		const value = priorEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

describe("hivedoctor run lifecycle", () => {
	afterEach(async () => {
		restoreEnv();
		if (blocker !== null) {
			await new Promise<void>((resolve) => blocker?.close(() => resolve()));
			blocker = null;
		}
		if (workspace !== null) {
			rmSync(workspace, { recursive: true, force: true });
			workspace = null;
		}
	});

	it("stays alive until SIGTERM even when the local status-page port is already bound", async () => {
		for (const key of ENV_KEYS) priorEnv[key] = process.env[key];
		const blockedPort = await blockEphemeralPort();
		workspace = mkdtempSync(join(tmpdir(), "hivedoctor-run-watchdog-"));
		process.env.HONEYCOMB_NO_AUTO_UPDATE = "1";
		process.env.HIVEDOCTOR_HEALTH_URL = "http://127.0.0.1:1/health";
		process.env.HIVEDOCTOR_WORKSPACE_DIR = workspace;
		process.env.HIVEDOCTOR_STATUS_PAGE_PORT = String(blockedPort);
		process.env.HIVEDOCTOR_PROBE_INTERVAL_MS = "5";
		process.env.HIVEDOCTOR_STARTUP_GRACE_MS = "60000";
		process.env.HIVEDOCTOR_INSTALL_HEALTH_INTERVAL_MS = "5";

		let settled = false;
		const running = runCli(["run", "--no-auto-update"]).finally(() => {
			settled = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(settled).toBe(false);

		process.emit("SIGTERM", "SIGTERM");
		await expect(running).resolves.toBe(0);
		expect(settled).toBe(true);
	}, 10_000);
});
