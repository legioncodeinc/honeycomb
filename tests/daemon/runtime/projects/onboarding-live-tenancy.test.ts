/**
 * ISS-003 — `mountOnboardingApi` reads tenancy AT REQUEST TIME, not at boot.
 *
 * The bug: assembly passed `org: scope.org, workspace: scope.workspace ?? ""` — plain string
 * SNAPSHOTS evaluated at mount time. The daemon's `scope` object itself is LIVE (mtime-gated
 * getters over `~/.deeplake/credentials.json`), so every OTHER surface followed a workspace
 * switch while the onboarding bind kept writing under the BOOT tenancy until a restart.
 * The fix passes GETTERS over the live scope; the handlers already read `options.org` /
 * `options.workspace` per call.
 *
 * Verification posture: a REAL local-mode daemon + `mountOnboardingApi` with getter-backed
 * options over a mutable scope holder (standing in for the live daemon scope). Binds run
 * before and after a simulated workspace switch; the projects cache is tenancy-stamped
 * (`cacheForTenancy`), so the recorded org/workspace proves WHICH tenancy each bind saw.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import {
	type BindAck,
	mountOnboardingApi,
} from "../../../../src/daemon/runtime/projects/onboarding-api.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import type { StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok } from "../../../../src/daemon/storage/result.js";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

let browseRoot: string;
let cacheDir: string;
beforeEach(() => {
	browseRoot = mkdtempSync(join(tmpdir(), "hc-live-tenancy-"));
	cacheDir = mkdtempSync(join(tmpdir(), "hc-live-tenancy-cache-"));
});
afterEach(() => {
	for (const d of [browseRoot, cacheDir]) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

/** The mutable stand-in for the daemon's LIVE scope (its getters re-resolve per read). */
interface LiveScopeHolder {
	org: string;
	workspace: string;
}

/**
 * Build the daemon with getter-backed onboarding options — the EXACT shape the composition
 * root now passes (ISS-003 fix): `org`/`workspace` are getters over the live scope object.
 */
function buildDaemon(holder: LiveScopeHolder): Daemon {
	const storage: StorageQuery = {
		async query() {
			return ok([], 0);
		},
	};
	const daemon = createDaemon({
		config: cfg(),
		storage: storage as never,
		logger: createRequestLogger({ silent: true }),
	});
	mountOnboardingApi(daemon, {
		get org(): string {
			return holder.org;
		},
		get workspace(): string {
			return holder.workspace;
		},
		projectsDir: cacheDir,
		browseRoot,
	});
	return daemon;
}

function readCache(): { org: string; workspace: string; bindings: Array<{ path: string; projectId: string }> } {
	return JSON.parse(readFileSync(join(cacheDir, "projects.json"), "utf8"));
}

async function bind(daemon: Daemon, path: string, name: string): Promise<BindAck> {
	const res = await daemon.app.request("/api/diagnostics/projects/bind", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path, name }),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as BindAck;
}

describe("ISS-003 — onboarding bind uses request-time tenancy", () => {
	it("a bind AFTER a simulated workspace switch lands under the NEW workspace (same mount)", async () => {
		const holder: LiveScopeHolder = { org: "acme", workspace: "backend" };
		const daemon = buildDaemon(holder); // mounted ONCE, under the boot tenancy…

		const folderA = join(browseRoot, "project-a");
		const folderB = join(browseRoot, "project-b");
		mkdirSync(folderA);
		mkdirSync(folderB);

		await bind(daemon, folderA, "proj-a");
		expect(readCache()).toMatchObject({ org: "acme", workspace: "backend" });

		// …the operator switches workspace (the live daemon scope re-resolves)…
		holder.workspace = "frontend";

		// …and the NEXT bind must land under the NEW workspace, with no re-mount and no restart.
		await bind(daemon, folderB, "proj-b");
		const after = readCache();
		expect(after).toMatchObject({ org: "acme", workspace: "frontend" });
		// The tenancy guard reset the foreign-tenancy cache — the new-workspace binding stands alone,
		// proving the handler resolved "frontend" at REQUEST time (a boot snapshot would have kept
		// appending under "backend").
		expect(after.bindings.map((b) => b.projectId)).toEqual(["proj-b"]);
	});

	it("an org switch is honored the same way", async () => {
		const holder: LiveScopeHolder = { org: "acme", workspace: "backend" };
		const daemon = buildDaemon(holder);
		const folder = join(browseRoot, "post-switch");
		mkdirSync(folder);

		holder.org = "globex"; // switched BEFORE any bind — even the first write sees the live value.
		await bind(daemon, folder, "proj-x");
		expect(readCache()).toMatchObject({ org: "globex", workspace: "backend" });
	});
});
