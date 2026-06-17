/**
 * PRD-004a config resolver suite — a-AC-1 / a-AC-7 (FR-1).
 *
 * Direct tests of the zod runtime-config boundary: default bind, the three env
 * overrides, fail-closed rejection of an invalid bind, and the `widened` posture
 * `HONEYCOMB_BIND` produces. No socket is bound — these prove the resolver in
 * isolation (the server-construction half of a-AC-1 lives in server.test.ts).
 */

import { describe, expect, it } from "vitest";
import {
	envRuntimeConfigProvider,
	type RawRuntimeConfig,
	resolveRuntimeConfig,
	RuntimeConfigError,
} from "../../../src/daemon/runtime/config.js";

/** A `RuntimeConfigProvider` returning a fixed raw record. */
function stub(raw: RawRuntimeConfig): { read(): RawRuntimeConfig } {
	return { read: () => raw };
}

describe("a-AC-1 runtime config: default bind + overrides", () => {
	it("defaults to 127.0.0.1:3850 in local mode when nothing is set", () => {
		const cfg = resolveRuntimeConfig(stub({}));
		expect(cfg.host).toBe("127.0.0.1");
		expect(cfg.port).toBe(3850);
		expect(cfg.mode).toBe("local");
		expect(cfg.widened).toBe(false);
	});

	it("honors HONEYCOMB_PORT", () => {
		expect(resolveRuntimeConfig(stub({ port: "4000" })).port).toBe(4000);
	});

	it("honors HONEYCOMB_HOST", () => {
		expect(resolveRuntimeConfig(stub({ host: "0.0.0.0" })).host).toBe("0.0.0.0");
	});

	it("clamps an out-of-range port into the valid TCP range", () => {
		expect(resolveRuntimeConfig(stub({ port: "0" })).port).toBe(1);
		expect(resolveRuntimeConfig(stub({ port: "999999" })).port).toBe(65535);
	});

	it("falls back to the default port on a non-numeric value", () => {
		expect(resolveRuntimeConfig(stub({ port: "abc" })).port).toBe(3850);
	});

	it("resolves the deployment mode from HONEYCOMB_MODE", () => {
		expect(resolveRuntimeConfig(stub({ mode: "team" })).mode).toBe("team");
		expect(resolveRuntimeConfig(stub({ mode: "hybrid" })).mode).toBe("hybrid");
	});

	it("rejects an unknown mode (fail-closed)", () => {
		expect(() => resolveRuntimeConfig(stub({ mode: "prod" }))).toThrow(RuntimeConfigError);
	});
});

describe("a-AC-1 runtime config: invalid bind is rejected (fail-closed)", () => {
	it("rejects a host that is a URL, not a bare address", () => {
		expect(() => resolveRuntimeConfig(stub({ host: "http://evil/" }))).toThrow(RuntimeConfigError);
	});

	it("rejects a host with whitespace", () => {
		expect(() => resolveRuntimeConfig(stub({ bind: "0.0.0.0 evil" }))).toThrow(RuntimeConfigError);
	});

	it("collects the failing knob in the error issues", () => {
		try {
			resolveRuntimeConfig(stub({ host: "bad/host" }));
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(RuntimeConfigError);
			expect((e as RuntimeConfigError).issues.some((i) => i.includes("host"))).toBe(true);
		}
	});
});

describe("a-AC-7 HONEYCOMB_BIND widens the bind", () => {
	it("uses HONEYCOMB_BIND as the host and marks the bind widened", () => {
		const cfg = resolveRuntimeConfig(stub({ bind: "0.0.0.0" }));
		expect(cfg.host).toBe("0.0.0.0");
		expect(cfg.widened).toBe(true);
	});

	it("HONEYCOMB_BIND takes precedence over HONEYCOMB_HOST", () => {
		const cfg = resolveRuntimeConfig(stub({ host: "127.0.0.1", bind: "0.0.0.0" }));
		expect(cfg.host).toBe("0.0.0.0");
		expect(cfg.widened).toBe(true);
	});

	it("a loopback bind is NOT counted as a widening", () => {
		const cfg = resolveRuntimeConfig(stub({ bind: "127.0.0.1" }));
		expect(cfg.host).toBe("127.0.0.1");
		expect(cfg.widened).toBe(false);
	});

	it("an empty HONEYCOMB_BIND falls back to the host (no accidental empty-host bind)", () => {
		const cfg = resolveRuntimeConfig(stub({ host: "127.0.0.1", bind: "" }));
		expect(cfg.host).toBe("127.0.0.1");
		expect(cfg.widened).toBe(false);
	});
});

describe("FR-1 env provider seam reads HONEYCOMB_PORT/HOST/BIND/MODE", () => {
	it("maps env vars to the raw config record", () => {
		const provider = envRuntimeConfigProvider({
			HONEYCOMB_PORT: "5000",
			HONEYCOMB_HOST: "127.0.0.1",
			HONEYCOMB_BIND: "0.0.0.0",
			HONEYCOMB_MODE: "team",
		} as NodeJS.ProcessEnv);
		const cfg = resolveRuntimeConfig(provider);
		expect(cfg.port).toBe(5000);
		expect(cfg.host).toBe("0.0.0.0"); // BIND wins
		expect(cfg.widened).toBe(true);
		expect(cfg.mode).toBe("team");
	});
});
