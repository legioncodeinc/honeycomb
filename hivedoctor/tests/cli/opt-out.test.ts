/**
 * Opt-out precedence tests (PRD-064e AC-064e.4, OD-5): CLI flag > env > state > pin.
 */

import { describe, expect, it } from "vitest";

import { resolveOptOut, ENV_NO_AUTO_UPDATE, ENV_PIN_VERSION } from "../../src/cli/opt-out.js";

describe("resolveOptOut (precedence)", () => {
	it("nothing set -> enabled", () => {
		const r = resolveOptOut({ cliNoAutoUpdate: false, env: {} });
		expect(r.autoUpdateDisabled).toBe(false);
		expect(r.source).toBe("none");
	});

	it("CLI flag wins over everything", () => {
		const r = resolveOptOut({
			cliNoAutoUpdate: true,
			env: { [ENV_NO_AUTO_UPDATE]: "0" },
			stateAutoUpdateDisabled: false,
		});
		expect(r.autoUpdateDisabled).toBe(true);
		expect(r.source).toBe("cli");
	});

	it("env toggle disables when CLI flag absent", () => {
		const r = resolveOptOut({ cliNoAutoUpdate: false, env: { [ENV_NO_AUTO_UPDATE]: "1" } });
		expect(r.autoUpdateDisabled).toBe(true);
		expect(r.source).toBe("env");
	});

	it("state toggle disables when CLI + env absent", () => {
		const r = resolveOptOut({ cliNoAutoUpdate: false, env: {}, stateAutoUpdateDisabled: true });
		expect(r.autoUpdateDisabled).toBe(true);
		expect(r.source).toBe("state");
	});

	it("a pin alone disables forward updates", () => {
		const r = resolveOptOut({ cliNoAutoUpdate: false, env: { [ENV_PIN_VERSION]: "1.2.3" } });
		expect(r.autoUpdateDisabled).toBe(true);
		expect(r.pinnedVersion).toBe("1.2.3");
		expect(r.source).toBe("pin");
	});

	it("a pin is surfaced even when the CLI flag is the disabling source", () => {
		const r = resolveOptOut({
			cliNoAutoUpdate: true,
			env: { [ENV_PIN_VERSION]: "2.0.0" },
		});
		expect(r.autoUpdateDisabled).toBe(true);
		expect(r.pinnedVersion).toBe("2.0.0");
		expect(r.source).toBe("cli");
	});

	it("an empty env pin is ignored", () => {
		const r = resolveOptOut({ cliNoAutoUpdate: false, env: { [ENV_PIN_VERSION]: "   " } });
		expect(r.autoUpdateDisabled).toBe(false);
		expect(r.pinnedVersion).toBeUndefined();
	});

	it("a state pin disables when env has none", () => {
		const r = resolveOptOut({ cliNoAutoUpdate: false, env: {}, statePinnedVersion: "3.1.4" });
		expect(r.autoUpdateDisabled).toBe(true);
		expect(r.pinnedVersion).toBe("3.1.4");
	});
});
