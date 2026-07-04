/**
 * PRD-072c US-072c.1 / US-072c.2 — the registry compatibility-window write target and the
 * advertised RESOLVED ABSOLUTE pid/telemetry paths (fleet ADR Resolved decision 4).
 *
 * Proves: the write target is the fleet-root `registry.json` when the fleet root exists, else the
 * legacy `doctor.daemons.json` (never both); the advertised paths are the SAME paths the resolvers
 * open (coherence); and an `APIARY_HOME` override moves both the write target and the advertised
 * paths under the overridden root. All against a temp HOME.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { honeycombStateDir } from "../../../../src/shared/fleet-root.js";
import { fleetTelemetryDbPath } from "../../../../src/daemon/runtime/telemetry/fleet-store.js";
import {
	fleetRegistryPath,
	honeycombRegistryPidPath,
	honeycombRegistryTelemetryDbPath,
	legacyRegistryPath,
	registerHoneycombWithDoctor,
	resolveRegistryWritePath,
} from "../../../../src/daemon/runtime/telemetry/fleet-registry.js";

let home: string;
const ENV = {} as NodeJS.ProcessEnv;
const PLATFORM: NodeJS.Platform = "linux";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-reg-window-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function opts() {
	return { home, env: ENV, platform: PLATFORM } as const;
}

describe("PRD-072c US-072c.1 — the window write target follows the fleet-root existence", () => {
	it("AC-072c.1.1 writes to the legacy doctor.daemons.json when the fleet root does NOT exist", () => {
		expect(resolveRegistryWritePath(opts())).toBe(legacyRegistryPath(home));
		const result = registerHoneycombWithDoctor({ homeDir: home, env: ENV, platform: PLATFORM });
		expect(result.registryPath).toBe(legacyRegistryPath(home));
		expect(existsSync(legacyRegistryPath(home))).toBe(true);
		// Never both: the fleet-root registry was not written.
		expect(existsSync(fleetRegistryPath(opts()))).toBe(false);
	});

	it("AC-072c.1.1 writes to ~/.apiary/registry.json once the fleet root directory exists (never both)", () => {
		mkdirSync(join(home, ".apiary"), { recursive: true });
		expect(resolveRegistryWritePath(opts())).toBe(fleetRegistryPath(opts()));
		const result = registerHoneycombWithDoctor({ homeDir: home, env: ENV, platform: PLATFORM });
		expect(result.registryPath).toBe(fleetRegistryPath(opts()));
		expect(existsSync(fleetRegistryPath(opts()))).toBe(true);
		expect(existsSync(legacyRegistryPath(home))).toBe(false);
	});

	it("AC-072c.1.1 a re-register REPLACES honeycomb's entry in place (idempotent, no duplicate)", () => {
		mkdirSync(join(home, ".apiary"), { recursive: true });
		registerHoneycombWithDoctor({ homeDir: home, env: ENV, platform: PLATFORM });
		registerHoneycombWithDoctor({ homeDir: home, env: ENV, platform: PLATFORM });
		const doc = JSON.parse(readFileSync(fleetRegistryPath(opts()), "utf8")) as {
			daemons: Array<Record<string, unknown>>;
		};
		expect(doc.daemons.filter((d) => d.name === "honeycomb")).toHaveLength(1);
	});
});

describe("PRD-072c US-072c.2 — advertised paths are the SAME resolved absolute paths the daemon opens", () => {
	it("AC-072c.2.1 the entry's pidPath / telemetryDbPath equal the resolver outputs (coherence)", () => {
		expect(honeycombRegistryPidPath(opts())).toBe(join(honeycombStateDir(opts()), "daemon.pid"));
		expect(honeycombRegistryTelemetryDbPath(opts())).toBe(fleetTelemetryDbPath(opts()));
	});

	it("AC-072c.2.2 an APIARY_HOME override moves both the write target and the advertised paths", () => {
		const overridden = mkdtempSync(join(tmpdir(), "hc-reg-override-"));
		try {
			const env = { APIARY_HOME: overridden } as NodeJS.ProcessEnv;
			const o = { home, env, platform: PLATFORM } as const;
			// The fleet root (== APIARY_HOME) exists, so the write target is that root's registry.json.
			expect(resolveRegistryWritePath(o)).toBe(join(overridden, "registry.json"));
			// The advertised paths resolve under the overridden root, NOT the home default.
			expect(honeycombRegistryPidPath(o)).toBe(join(overridden, "honeycomb", "daemon.pid"));
			expect(honeycombRegistryTelemetryDbPath(o)).toBe(join(overridden, "honeycomb", "telemetry", "honeycomb.sqlite"));
		} finally {
			rmSync(overridden, { recursive: true, force: true });
		}
	});
});
