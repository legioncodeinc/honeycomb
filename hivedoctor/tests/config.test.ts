/** Config resolution tests (PRD-064a defaults + defensive env parsing). */

import { describe, expect, it } from "vitest";

import { DEFAULTS, resolveConfig } from "../src/config.js";

const HOME = "/home/test";

describe("resolveConfig", () => {
	it("returns the PRD-064a defaults when env is empty", () => {
		const cfg = resolveConfig({}, HOME);
		expect(cfg.probeIntervalMs).toBe(DEFAULTS.probeIntervalMs); // 30s
		expect(cfg.healthUrl).toBe("http://127.0.0.1:3850/health");
		expect(cfg.backoffFloorMs).toBe(1_000);
		expect(cfg.backoffCeilingMs).toBe(30_000);
		expect(cfg.restartGiveUpThreshold).toBe(3); // OD-4
		expect(cfg.installHealthIntervalMs).toBe(DEFAULTS.installHealthIntervalMs); // 60 min (064d)
		expect(cfg.workspaceDir).toContain("hivedoctor");
		expect(cfg.daemonPidPath).toContain("daemon.pid");
	});

	it("reads the install-health interval env override", () => {
		const cfg = resolveConfig({ HIVEDOCTOR_INSTALL_HEALTH_INTERVAL_MS: "120000" }, HOME);
		expect(cfg.installHealthIntervalMs).toBe(120_000);
	});

	it("reads valid env overrides", () => {
		const cfg = resolveConfig(
			{
				HIVEDOCTOR_PROBE_INTERVAL_MS: "5000",
				HIVEDOCTOR_HEALTH_URL: "http://127.0.0.1:9999/health",
				HIVEDOCTOR_RESTART_GIVE_UP: "7",
			},
			HOME,
		);
		expect(cfg.probeIntervalMs).toBe(5_000);
		expect(cfg.healthUrl).toBe("http://127.0.0.1:9999/health");
		expect(cfg.restartGiveUpThreshold).toBe(7);
	});

	it("falls back to defaults on malformed values (never throws)", () => {
		const cfg = resolveConfig(
			{
				HIVEDOCTOR_PROBE_INTERVAL_MS: "not-a-number",
				HIVEDOCTOR_PROBE_TIMEOUT_MS: "-5",
				HIVEDOCTOR_HEALTH_URL: "ftp://nope",
				HIVEDOCTOR_RESTART_GIVE_UP: "0",
			},
			HOME,
		);
		expect(cfg.probeIntervalMs).toBe(DEFAULTS.probeIntervalMs);
		expect(cfg.probeTimeoutMs).toBe(DEFAULTS.probeTimeoutMs);
		expect(cfg.healthUrl).toBe(DEFAULTS.healthUrl); // non-http scheme rejected
		expect(cfg.restartGiveUpThreshold).toBe(DEFAULTS.restartGiveUpThreshold); // 0 rejected
	});

	it("normalizes an inverted backoff floor/ceiling (ceiling clamped up to floor)", () => {
		const cfg = resolveConfig(
			{ HIVEDOCTOR_BACKOFF_FLOOR_MS: "10000", HIVEDOCTOR_BACKOFF_CEILING_MS: "2000" },
			HOME,
		);
		expect(cfg.backoffFloorMs).toBe(10_000);
		expect(cfg.backoffCeilingMs).toBe(10_000);
	});

	it("allows a zero cooldown but rejects a negative one", () => {
		expect(resolveConfig({ HIVEDOCTOR_RESTART_COOLDOWN_MS: "0" }, HOME).restartCooldownMs).toBe(0);
		expect(resolveConfig({ HIVEDOCTOR_RESTART_COOLDOWN_MS: "-1" }, HOME).restartCooldownMs).toBe(
			DEFAULTS.restartCooldownMs,
		);
	});
});
