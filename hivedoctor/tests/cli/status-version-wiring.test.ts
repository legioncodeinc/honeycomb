/**
 * `status` keeps reading the RUNNING daemon's `/health` version, even after the auto-update
 * engine was rewired to read the globally-installed PACKAGE version instead (the live-bug fix).
 *
 * The split must be honest: `status` shows what is RUNNING (so it reads `/health`), while the
 * update engine + reinstall-verify reason about what is INSTALLED ON DISK (so they read
 * `npm ls -g`). This test proves the production CLI wiring keeps the status seam on `/health`
 * by pointing `buildCliContext` at a real mock `/health` server and asserting it reports the
 * server's version -- a value `npm ls` could never produce.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCliContext } from "../../src/cli/index.js";
import { startMockHealthServer, type MockHealthServer } from "../helpers/health-server.js";

let server: MockHealthServer;
const PRIOR_HEALTH_URL = process.env.HIVEDOCTOR_HEALTH_URL;

beforeEach(async () => {
	// A mock /health reporting a distinctive version string `npm ls` would never emit.
	server = await startMockHealthServer(() => ({
		statusCode: 200,
		body: JSON.stringify({ status: "ok", version: "5.5.5-daemon" }),
	}));
	process.env.HIVEDOCTOR_HEALTH_URL = server.url;
});

afterEach(async () => {
	if (PRIOR_HEALTH_URL === undefined) delete process.env.HIVEDOCTOR_HEALTH_URL;
	else process.env.HIVEDOCTOR_HEALTH_URL = PRIOR_HEALTH_URL;
	await server.close();
});

describe("status command version wiring (post auto-update fix)", () => {
	it("readDaemonVersion reads the running daemon's /health version, not npm", async () => {
		const ctx = buildCliContext(["status"]);
		const version = await ctx.deps.readDaemonVersion();
		// The /health body's version is surfaced verbatim -- proof the status seam stayed on the
		// daemon-version reader rather than being repointed at the package-version reader.
		expect(version).toBe("5.5.5-daemon");
	});

	it("readDaemonVersion returns null when the daemon /health is down (AC-064f.6)", async () => {
		await server.close();
		const ctx = buildCliContext(["status"]);
		const version = await ctx.deps.readDaemonVersion();
		expect(version).toBeNull();
	});
});
