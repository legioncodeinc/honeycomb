/**
 * CLI dispatcher acceptance tests (PRD-064f AC-064f.1 .. AC-064f.6).
 *
 * Each test drives the REAL dispatcher over a fully-faked context (captured stdout,
 * scripted confirm, spy-able deps). No process is spawned, no network/npm/daemon touched.
 */

import { describe, expect, it } from "vitest";

import { dispatch, EXIT_OK, EXIT_DECLINED, EXIT_ERROR } from "../../src/cli/dispatch.js";
import { buildCliHarness, fakeLadder } from "./helpers/fake-cli.js";
import { resolveOptOut } from "../../src/cli/opt-out.js";

describe("dispatch (PRD-064f)", () => {
	describe("AC-064f.1: bare invocation -> ASCII art + menu", () => {
		it("renders the banner art and the command menu with no args", async () => {
			const h = buildCliHarness();
			const code = await dispatch([], h.ctx);

			expect(code).toBe(EXIT_OK);
			const text = h.out.text();
			// The attribution banner carries both wordmarks.
			expect(text).toContain("LEGION CODE INC.");
			expect(text).toContain("ACTIVELOOP");
			expect(text).toContain("HiveDoctor");
			// The menu: a sampling of commands must be listed.
			expect(text).toContain("status");
			expect(text).toContain("diagnose");
			expect(text).toContain("self-update");
		});

		it("--version prints just the version, not the banner", async () => {
			const h = buildCliHarness();
			const code = await dispatch(["--version"], h.ctx);

			expect(code).toBe(EXIT_OK);
			const text = h.out.text();
			expect(text).toContain("0.0.0-dev"); // the test-mode version sentinel
			expect(text).not.toContain("LEGION CODE INC."); // no banner
			expect(text).not.toContain("Commands:"); // no menu
		});

		it("`help` renders the same banner + menu", async () => {
			const h = buildCliHarness();
			const code = await dispatch(["help"], h.ctx);
			expect(code).toBe(EXIT_OK);
			expect(h.out.text()).toContain("Commands:");
		});
	});

	describe("AC-064f.2: status prints health/service/versions/last-heal/opt-out", () => {
		it("prints every required field", async () => {
			const h = buildCliHarness({
				classification: { kind: "degraded", reasons: { storage: "unreachable" } },
				daemonVersion: "1.2.3",
				statusState: { lastHealAt: "2026-06-27T00:00:00.000Z", lastKnownHealth: "degraded" },
				serviceState: "running",
				optOut: resolveOptOut({ cliNoAutoUpdate: true, env: {} }),
			});
			const code = await dispatch(["status"], h.ctx);

			expect(code).toBe(EXIT_OK);
			const text = h.out.text();
			expect(text).toContain("Daemon health:");
			expect(text).toContain("degraded");
			expect(text).toContain("HiveDoctor service:");
			expect(text).toContain("running");
			expect(text).toContain("Daemon version:");
			expect(text).toContain("1.2.3");
			expect(text).toContain("HiveDoctor version:");
			expect(text).toContain("9.9.9-test");
			expect(text).toContain("Last heal:");
			expect(text).toContain("2026-06-27T00:00:00.000Z");
			expect(text).toContain("Auto-update:");
			// Opt-out via the CLI flag is reported honestly with its source.
			expect(text).toContain("disabled (cli)");
		});
	});

	describe("AC-064f.3: diagnose recommends a rung and takes NO action", () => {
		it("reports the recommended rung without running the ladder", async () => {
			const ladder = fakeLadder({ decideResult: { rung: 2, advanced: true } });
			const h = buildCliHarness({
				ladder,
				classification: { kind: "unreachable-refused", detail: "ECONNREFUSED" },
				consecutiveFailures: 3,
			});
			const code = await dispatch(["diagnose"], h.ctx);

			expect(code).toBe(EXIT_OK);
			expect(h.out.text()).toContain("Recommended fix:");
			expect(h.out.text()).toContain("rung 2");
			// THE KEY ASSERTION: diagnose never runs a rung.
			expect(ladder.runCalls).toHaveLength(0);
		});

		it("a healthy daemon yields no recommendation and runs nothing", async () => {
			const ladder = fakeLadder();
			const h = buildCliHarness({ ladder, classification: { kind: "ok" } });
			const code = await dispatch(["diagnose"], h.ctx);
			expect(code).toBe(EXIT_OK);
			expect(h.out.text()).toContain("healthy");
			expect(ladder.runCalls).toHaveLength(0);
		});
	});

	describe("AC-064f.4: uninstall-hivemind confirms before acting; no clear-credentials command", () => {
		it("confirms, then runs rung 3 on yes", async () => {
			const ladder = fakeLadder({ runResult: { ok: true, action: "uninstall-conflicting-hivemind" } });
			const h = buildCliHarness({
				ladder,
				classification: { kind: "degraded", reasons: {} },
				confirm: true,
			});
			const code = await dispatch(["uninstall-hivemind"], h.ctx);

			expect(h.confirmSpy).toHaveBeenCalledTimes(1);
			expect(ladder.runCalls).toEqual([3]);
			expect(code).toBe(EXIT_OK);
		});

		it("aborts and runs nothing when the user declines", async () => {
			const ladder = fakeLadder();
			const h = buildCliHarness({ ladder, confirm: false });
			const code = await dispatch(["uninstall-hivemind"], h.ctx);

			expect(h.confirmSpy).toHaveBeenCalledTimes(1);
			expect(ladder.runCalls).toHaveLength(0);
			expect(code).toBe(EXIT_DECLINED);
		});

		it("does not delete shared ~/.deeplake state (the warning is shown)", async () => {
			const h = buildCliHarness({ confirm: true });
			await dispatch(["uninstall-hivemind"], h.ctx);
			expect(h.out.text()).toContain("NEVER touches shared ~/.deeplake/");
		});

		it("`clear-credentials` is NOT a known command (deferred, OD-4)", async () => {
			const h = buildCliHarness();
			const code = await dispatch(["clear-credentials"], h.ctx);
			// Unknown command -> error exit + the menu, never a credential action.
			expect(code).toBe(EXIT_ERROR);
			expect(h.out.errText()).toContain("Unknown command: clear-credentials");
		});
	});

	describe("AC-064f.5: self-update is the ONLY path that updates HiveDoctor's own package", () => {
		it("`self-update` calls the self-update action", async () => {
			const h = buildCliHarness();
			const code = await dispatch(["self-update"], h.ctx);
			expect(code).toBe(EXIT_OK);
			expect(h.selfUpdate).toHaveBeenCalledTimes(1);
		});

		it("NO other command calls self-update", async () => {
			// Run every other known command and assert self-update is never invoked.
			const otherCommands = [
				"status",
				"diagnose",
				"heal",
				"restart",
				"reinstall",
				"uninstall-hivemind",
				"update",
				"install-service",
				"uninstall-service",
				"logs",
				"help",
			];
			for (const cmd of otherCommands) {
				const h = buildCliHarness({
					// Make the unhealthy path reachable so heal/restart/reinstall actually run.
					classification: { kind: "unreachable-refused", detail: "ECONNREFUSED" },
					confirm: true,
				});
				await dispatch([cmd], h.ctx);
				expect(h.selfUpdate, `command "${cmd}" must not call self-update`).not.toHaveBeenCalled();
			}
		});

		it("`update` (primary) does not call self-update; it calls the primary update action", async () => {
			const h = buildCliHarness();
			await dispatch(["update"], h.ctx);
			expect(h.applyPrimaryUpdate).toHaveBeenCalledTimes(1);
			expect(h.selfUpdate).not.toHaveBeenCalled();
		});

		it("`update --check` previews without applying and never self-updates", async () => {
			const h = buildCliHarness();
			await dispatch(["update", "--check"], h.ctx);
			expect(h.checkPrimaryUpdate).toHaveBeenCalledTimes(1);
			expect(h.applyPrimaryUpdate).not.toHaveBeenCalled();
			expect(h.selfUpdate).not.toHaveBeenCalled();
		});
	});

	describe("AC-064f.6: status/diagnose work when the daemon is down", () => {
		it("status works with an unreachable daemon (null version)", async () => {
			const h = buildCliHarness({
				classification: { kind: "unreachable-refused", detail: "ECONNREFUSED" },
				daemonVersion: null,
			});
			const code = await dispatch(["status"], h.ctx);
			expect(code).toBe(EXIT_OK);
			const text = h.out.text();
			expect(text).toContain("unreachable");
			expect(text).toContain("unknown (daemon unreachable)");
		});

		it("diagnose works with an unreachable daemon", async () => {
			const h = buildCliHarness({
				classification: { kind: "unreachable-timeout" },
				daemonVersion: null,
			});
			const code = await dispatch(["diagnose"], h.ctx);
			expect(code).toBe(EXIT_OK);
			expect(h.out.text()).toContain("Recommended fix:");
		});
	});

	describe("service stubs + restart + logs", () => {
		it("install-service prints 'not yet available' when 064b is not wired", async () => {
			const h = buildCliHarness();
			const code = await dispatch(["install-service"], h.ctx);
			expect(code).toBe(EXIT_OK);
			expect(h.out.text()).toContain("not yet available");
		});

		it("install-service delegates to the 064b module when wired", async () => {
			const h = buildCliHarness({
				serviceModule: {
					install: async () => ({ ok: true, message: "service registered" }),
					uninstall: async () => ({ ok: true, message: "service removed" }),
				},
			});
			await dispatch(["install-service"], h.ctx);
			expect(h.out.text()).toContain("service registered");
		});

		it("restart (rung 1) runs without a confirm gate", async () => {
			const ladder = fakeLadder({ runResult: { ok: true, action: "restart-daemon" } });
			const h = buildCliHarness({ ladder, classification: { kind: "unreachable-refused", detail: "x" } });
			const code = await dispatch(["restart"], h.ctx);
			expect(h.confirmSpy).not.toHaveBeenCalled();
			expect(ladder.runCalls).toEqual([1]);
			expect(code).toBe(EXIT_OK);
		});

		it("logs prints recent incident lines, or a friendly empty message", async () => {
			const withLines = buildCliHarness({ incidents: ['{"id":"a"}', '{"id":"b"}'] });
			await dispatch(["logs"], withLines.ctx);
			expect(withLines.out.text()).toContain('{"id":"a"}');

			const empty = buildCliHarness({ incidents: [] });
			await dispatch(["logs"], empty.ctx);
			expect(empty.out.text()).toContain("No incidents recorded yet.");
		});
	});
});
