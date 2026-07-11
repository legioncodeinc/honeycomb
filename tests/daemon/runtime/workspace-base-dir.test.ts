/**
 * `workspaceBaseDirCandidate` (`src/daemon/runtime/assemble.ts`) — the env-selection half of the
 * workspace base dir that anchors `.daemon/logs.db`, `.secrets/`, and `agent.yaml`.
 *
 * Regression guard for the trailing-space defect: a Windows scheduled task whose
 * `set HONEYCOMB_WORKSPACE=<dir> && ...` folded the space before `&&` into the value must NOT divert
 * the daemon's logs + secrets into a divergent `<dir> ` directory (the sibling of the APIARY_HOME
 * trim in fleet-root.ts). The candidate is trimmed; a clean value is returned verbatim.
 */

import { describe, expect, it } from "vitest";

import { honeycombStateDir } from "../../../src/shared/fleet-root.js";
import { resolveLocalQueueBaseDir, workspaceBaseDirCandidate } from "../../../src/daemon/runtime/assemble.js";

describe("workspaceBaseDirCandidate — trims a polluted HONEYCOMB_WORKSPACE", () => {
	it("returns a clean HONEYCOMB_WORKSPACE verbatim", () => {
		expect(workspaceBaseDirCandidate({ HONEYCOMB_WORKSPACE: "C:\\Users\\ada\\.apiary\\honeycomb" })).toBe(
			"C:\\Users\\ada\\.apiary\\honeycomb",
		);
	});

	it("trims a trailing-space HONEYCOMB_WORKSPACE (the scheduled-task `set VAR=value &&` footgun)", () => {
		expect(workspaceBaseDirCandidate({ HONEYCOMB_WORKSPACE: "C:\\Users\\ada\\.apiary\\honeycomb " })).toBe(
			"C:\\Users\\ada\\.apiary\\honeycomb",
		);
	});

	it("falls back to process.cwd() when HONEYCOMB_WORKSPACE is unset or whitespace-only", () => {
		expect(workspaceBaseDirCandidate({})).toBe(process.cwd());
		expect(workspaceBaseDirCandidate({ HONEYCOMB_WORKSPACE: "   " })).toBe(process.cwd());
	});
});

describe("resolveLocalQueueBaseDir — the memory-pipeline queue is home-anchored, NOT cwd/workspace", () => {
	it("resolves to the fleet state root (~/.apiary/honeycomb), independent of HONEYCOMB_WORKSPACE and cwd", () => {
		// The queue is DAEMON-GLOBAL durable state: it must land in `honeycombStateDir()` so a restart from
		// any launch dir reopens the SAME queue. A workspace/cwd anchor scattered it and orphaned pending jobs.
		expect(resolveLocalQueueBaseDir()).toBe(honeycombStateDir());
		// It must NOT be the cwd-scattering workspace base (the pre-fix defect this guards against).
		expect(resolveLocalQueueBaseDir()).not.toBe(process.cwd());
	});
});
