/**
 * Daemon-version reader tests (PRD-064f `status`): parse the /health version field
 * defensively; an unreachable daemon yields null (AC-064f.6).
 */

import { describe, expect, it } from "vitest";

import { parseDaemonVersion, readDaemonVersion } from "../../src/cli/daemon-version.js";

describe("parseDaemonVersion", () => {
	it("extracts a version string from a health body", () => {
		expect(parseDaemonVersion('{"status":"ok","version":"1.2.3"}')).toBe("1.2.3");
	});
	it("trims whitespace", () => {
		expect(parseDaemonVersion('{"version":"  4.5.6  "}')).toBe("4.5.6");
	});
	it("returns null for a missing version", () => {
		expect(parseDaemonVersion('{"status":"ok"}')).toBeNull();
	});
	it("returns null for a non-string version", () => {
		expect(parseDaemonVersion('{"version":123}')).toBeNull();
	});
	it("returns null for non-JSON", () => {
		expect(parseDaemonVersion("not json")).toBeNull();
	});
	it("returns null for an empty version", () => {
		expect(parseDaemonVersion('{"version":""}')).toBeNull();
	});
});

describe("readDaemonVersion (unreachable)", () => {
	it("resolves null when the daemon is unreachable (no crash)", async () => {
		// Port 1 is reserved/unbound; the connection is refused immediately.
		const v = await readDaemonVersion({ healthUrl: "http://127.0.0.1:1/health", timeoutMs: 500 });
		expect(v).toBeNull();
	});
});
