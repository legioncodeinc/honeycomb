/**
 * PRD-021b b-AC-6 — no "not wired in this build" path remains in the live CLI dispatch.
 *
 * 020a's scaffold printed an honest "not wired in this build (deferred assembly)" line whenever a
 * handler seam (auth / connector / dashboard) was unbound, and `src/cli/index.ts` left those seams
 * unbound. 021b binds every seam through `buildRuntimeDeps`, so the live path can no longer reach
 * that stub line. This test asserts statically (a) the stub string is gone from the live CLI source
 * the bundle is built from, and (b) `src/cli/index.ts` no longer carries the honest-deferral note.
 *
 * The stub *guards* still live in the 020a handlers (they fire only when a seam is undefined, which
 * the runtime never leaves it) — those are a defense-in-depth fallback for a degraded build, not a
 * live path. This test scopes the assertion to the LIVE dispatch source: `src/cli/index.ts` (the
 * bin entry) and `src/cli/runtime.ts` (the binding layer), which together prove no seam is unbound.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

describe("PRD-021b b-AC-6 — the 'not wired' stub is gone from the live CLI path", () => {
	it("b-AC-6 src/cli/index.ts binds the runtime deps and carries no 'not wired' note", () => {
		const src = readFileSync(join(REPO_ROOT, "src", "cli", "index.ts"), "utf8");
		// The bin builds the FULLY-bound runtime deps...
		expect(src).toMatch(/buildRuntimeDeps/);
		// ...and the old honest-deferral note ("leaves the handler seams unbound") is gone.
		expect(src).not.toMatch(/not wired in this build/);
		expect(src).not.toMatch(/leaves the handler seams unbound/);
	});

	it("b-AC-6 the runtime binds every handler seam the dispatcher consumes", () => {
		const src = readFileSync(join(REPO_ROOT, "src", "cli", "runtime.ts"), "utf8");
		// Each of the seams the 020a dispatcher + handlers read is constructed in the runtime.
		for (const seam of [
			"createLoopbackDaemonClient", // storage verbs (b-AC-1)
			"buildDaemonLifecycle", // daemon verbs + ensure-running (b-AC-2 / b-AC-3)
			"buildAuthPassthrough", // login/org (b-AC-4)
			"buildConnectorRunner", // setup/connect/uninstall
			"buildDashboardLauncher", // dashboard
			"buildStatusHealthSource", // status D1–D5 (b-AC-5)
			"buildOrgDriftHealer", // drift heal (b-AC-4)
		]) {
			expect(src).toContain(seam);
		}
	});

	it("b-AC-6 the runtime never prints the deferred-assembly stub string", () => {
		for (const file of ["runtime.ts", "connector-runner.ts", "health-probes.ts", "token-issuer.ts", "index.ts"]) {
			const src = readFileSync(join(REPO_ROOT, "src", "cli", file), "utf8");
			expect(src).not.toMatch(/not wired in this build/);
		}
	});
});
