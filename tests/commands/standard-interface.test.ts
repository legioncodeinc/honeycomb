import { mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDispatcher, createFakeDaemonClient, type DaemonLifecycle } from "../../src/commands/index.js";
import type { HoneycombStandardOps } from "../../src/commands/standard-interface.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { deps: Record<string, unknown>; lines: string[]; lifecycle: DaemonLifecycle } {
	const dir = mkdtempSync(join(tmpdir(), "honeycomb-standard-"));
	dirs.push(dir);
	const logPath = join(dir, "service.log");
	writeFileSync(logPath, "ready\nAuthorization: Bearer secret-token\napi_key=super-secret\n", "utf8");
	let running = true;
	const lifecycle: DaemonLifecycle = {
		async start() {
			const was = running;
			running = true;
			return { started: !was, alreadyRunning: was };
		},
		async stop() {
			const was = running;
			running = false;
			return { stopped: was };
		},
		async status() {
			return running
				? { running: true, pid: 42, port: 3850, serviceManager: "schtasks" }
				: { running: false, port: 3850, serviceManager: "schtasks" };
		},
		async restart() {
			running = true;
			return { restarted: true, viaService: true };
		},
	};
	const standard: HoneycombStandardOps = {
		configPath: dir,
		logPath,
		logFs: { readFile: (path) => readFile(path, "utf8"), realpath, watch: (path, cb) => watch(path, cb) },
		async start() {
			const changed = !running;
			running = true;
			return { ok: true, changed, message: changed ? "service started" : "service already running" };
		},
		async stop() {
			const changed = running;
			running = false;
			return { ok: true, changed, message: changed ? "service stopped" : "service already stopped" };
		},
		async restart() {
			running = true;
			return { ok: true, changed: true, message: "service restarted and healthy" };
		},
		async serviceInstall() {
			return { ok: true, changed: false, message: "service reconciled" };
		},
		async serviceUninstall() {
			return { ok: true, changed: true, message: "service removed; state preserved" };
		},
		async isServiceInstalled() {
			return true;
		},
		async register() {
			return { ok: true, changed: false, message: "registration reconciled" };
		},
		async isRegistered() {
			return true;
		},
		async update(checkOnly) {
			return {
				ok: true,
				changed: false,
				message: checkOnly ? "update checked" : "already current",
				details: { fromVersion: "0.21.0", toVersion: "0.21.0" },
			};
		},
	};
	const lines: string[] = [];
	return {
		lifecycle,
		lines,
		deps: {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			standard,
			out: (line: string) => {
				lines.push(line);
			},
			err: (line: string) => {
				lines.push(line);
			},
		},
	};
}

describe("PRD-003 Honeycomb standard operational interface", () => {
	it("rejects malformed baseline options with usage exit 2 and no operation", async () => {
		const { deps, lines } = fixture();
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse(["restart", "--bogus", "--json"]), deps as never);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(lines.join("\n"))).toMatchObject({
			product: "honeycomb",
			command: "restart",
			ok: false,
		});
	});

	it("never consumes --dry-run into a mutating update or service uninstall", async () => {
		const update = fixture();
		let checked = false;
		update.deps.standard = {
			...(update.deps.standard as HoneycombStandardOps),
			async update(checkOnly) {
				checked = checkOnly;
				return { ok: true, message: "checked" };
			},
		};
		const dispatcher = createDispatcher();
		expect(
			(await dispatcher.dispatch(dispatcher.parse(["update", "--dry-run", "--json"]), update.deps as never)).exitCode,
		).toBe(0);
		expect(checked).toBe(true);

		const uninstall = fixture();
		let serviceRemoved = false;
		uninstall.deps.standard = {
			...(uninstall.deps.standard as HoneycombStandardOps),
			async serviceUninstall() {
				serviceRemoved = true;
				return { ok: true, message: "removed" };
			},
		};
		expect(
			(
				await dispatcher.dispatch(
					dispatcher.parse(["service-uninstall", "--dry-run", "--json"]),
					uninstall.deps as never,
				)
			).exitCode,
		).toBe(2);
		expect(serviceRemoved).toBe(false);
	});

	it.each(["install", "uninstall"])("%s rejects malformed usage before mutation", async (command) => {
		const { deps, lines } = fixture();
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse([command, "--bogus", "--json"]), deps as never);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(lines.join("\n"))).toMatchObject({ product: "honeycomb", command, ok: false });
	});

	for (const command of [
		"start",
		"stop",
		"restart",
		"service-install",
		"service-uninstall",
		"register",
		"status",
		"update",
	] as const) {
		it(`${command} supports global --json after the command with one clean envelope`, async () => {
			const { deps, lines } = fixture();
			const dispatcher = createDispatcher();
			const argv = command === "update" ? [command, "--check", "--json"] : [command, "--json"];
			const result = await dispatcher.dispatch(dispatcher.parse(argv), deps as never);
			expect(result.exitCode).toBe(0);
			expect(lines).toHaveLength(1);
			const body = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
			expect(body).toMatchObject({ product: "honeycomb", command, ok: true });
			expect(lines[0]).not.toMatch(/\u001b|Legion Code/);
		});
	}

	it("logs --no-follow is product-bound and redacts stored secrets without modifying the file", async () => {
		const { deps, lines } = fixture();
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(
			dispatcher.parse(["logs", "--lines", "100", "--no-follow", "--json"]),
			deps as never,
		);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(lines[0] ?? "") as { lines: string[] };
		expect(body.lines.join("\n")).not.toContain("secret-token");
		expect(body.lines.join("\n")).not.toContain("super-secret");
	});

	it("logs defaults to the last 100 lines", async () => {
		const { deps, lines } = fixture();
		const logPath = (deps.standard as HoneycombStandardOps).logPath;
		writeFileSync(logPath, Array.from({ length: 150 }, (_, index) => `line-${index + 1}`).join("\n"), "utf8");
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse(["logs", "--no-follow", "--json"]), deps as never);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(lines[0] ?? "") as { lines: string[] };
		expect(body.lines).toHaveLength(100);
		expect(body.lines[0]?.trimEnd()).toBe("line-51");
	});

	it("Ctrl+C ends default log follow cleanly with exit 0", async () => {
		const { deps } = fixture();
		const dispatcher = createDispatcher();
		const pending = dispatcher.dispatch(dispatcher.parse(["logs"]), deps as never);
		setTimeout(() => process.emit("SIGINT"), 20);
		expect((await pending).exitCode).toBe(0);
	});

	it("unknown commands and malformed log options return usage exit 2", async () => {
		const first = fixture();
		const dispatcher = createDispatcher();
		expect((await dispatcher.dispatch(dispatcher.parse(["nope", "--json"]), first.deps as never)).exitCode).toBe(2);
		const second = fixture();
		expect(
			(await dispatcher.dispatch(dispatcher.parse(["logs", "--lines", "zero", "--json"]), second.deps as never))
				.exitCode,
		).toBe(2);
	});

	it("logs rejects attempts to select a sibling product source", async () => {
		const { deps } = fixture();
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(
			dispatcher.parse(["logs", "--path", "../doctor/service.log", "--no-follow"]),
			deps as never,
		);
		expect(result.exitCode).toBe(2);
	});

	it("logs fails closed when an injected adapter path escapes Honeycomb state", async () => {
		const { deps, lines } = fixture();
		deps.standard = {
			...(deps.standard as HoneycombStandardOps),
			logPath: join((deps.standard as HoneycombStandardOps).configPath, "..", "doctor", "service.log"),
		};
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse(["logs", "--no-follow", "--json"]), deps as never);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ command: "logs", ok: false });
		expect(lines.join("\n")).toContain("outside its owned log directory");
	});

	it("logs returns runtime exit 1 when Honeycomb's authoritative source is missing", async () => {
		const { deps, lines } = fixture();
		rmSync((deps.standard as HoneycombStandardOps).logPath, { force: true });
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse(["logs", "--no-follow", "--json"]), deps as never);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ product: "honeycomb", command: "logs", ok: false });
	});

	it("logs accepts --since without exposing a path selector", async () => {
		const { deps } = fixture();
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse(["logs", "--since", "1h", "--no-follow"]), deps as never);
		expect(result.exitCode).toBe(0);
	});

	it("redacts credentials and terminal controls from adapter failures", async () => {
		const { deps, lines } = fixture();
		deps.standard = {
			...(deps.standard as HoneycombStandardOps),
			async serviceInstall() {
				throw new Error("Authorization: Bearer secret-token\u001b[31m");
			},
		};
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse(["service-install"]), deps as never);
		expect(result.exitCode).toBe(1);
		expect(lines.join("\n")).toContain("Authorization: [REDACTED]");
		expect(lines.join("\n")).not.toMatch(/secret-token|\u001b/);
	});

	it("status preserves the standard human field order", async () => {
		const { deps, lines } = fixture();
		const dispatcher = createDispatcher();
		expect((await dispatcher.dispatch(dispatcher.parse(["status"]), deps as never)).exitCode).toBe(0);
		const text = lines.join("\n");
		const labels = ["Product:", "Service:", "Process:", "Health:", "Registration:", "Update:", "Config:", "Logs:"];
		const positions = labels.map((label) => text.indexOf(label));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("registry inspection errors make status a runtime failure instead of unregistered success", async () => {
		const { deps, lines } = fixture();
		deps.standard = {
			...(deps.standard as HoneycombStandardOps),
			async isRegistered() {
				throw new Error("registry is unreadable");
			},
		};
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(dispatcher.parse(["status", "--json"]), deps as never);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ command: "status", ok: false });
	});

	it("telemetry inspection errors return runtime failure in human and JSON modes", async () => {
		const dispatcher = createDispatcher();
		for (const json of [false, true]) {
			const base = fixture();
			const result = await dispatcher.dispatch(dispatcher.parse(["telemetry", ...(json ? ["--json"] : [])]), {
				...base.deps,
				loadOnboarding: () => {
					throw new Error("unreadable");
				},
			} as never);
			expect(result.exitCode).toBe(1);
			expect(base.lines.join("\n")).toContain("could not be inspected");
		}
	});

	it("status JSON represents stopped, not-installed state without starting the service", async () => {
		const base = fixture();
		let starts = 0;
		const deps = {
			...base.deps,
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle: {
				...base.lifecycle,
				async start() {
					starts++;
					return { started: true, alreadyRunning: false };
				},
				async status() {
					return { running: false, port: 3850 };
				},
			},
			standard: {
				...(base.deps.standard as HoneycombStandardOps),
				async isServiceInstalled() {
					return false;
				},
			},
		};
		const dispatcher = createDispatcher();
		expect((await dispatcher.dispatch(dispatcher.parse(["status", "--json"]), deps as never)).exitCode).toBe(0);
		expect(JSON.parse(base.lines[0] ?? "")).toMatchObject({
			installation: "not-installed",
			process: { state: "stopped" },
			health: { state: "unknown" },
		});
		expect(starts).toBe(0);
	});

	it("telemetry reports enabled and opted-out states and rejects malformed usage", async () => {
		const enabled = fixture();
		const dispatcher = createDispatcher();
		expect(
			(await dispatcher.dispatch(dispatcher.parse(["telemetry", "--json"]), { ...enabled.deps, env: {} } as never))
				.exitCode,
		).toBe(0);
		expect(JSON.parse(enabled.lines[0] ?? "")).toMatchObject({ state: "enabled", destination: "hosted" });

		const optedOut = fixture();
		expect(
			(
				await dispatcher.dispatch(dispatcher.parse(["telemetry", "--json"]), {
					...optedOut.deps,
					env: { HONEYCOMB_TELEMETRY: "0" },
				} as never)
			).exitCode,
		).toBe(0);
		expect(JSON.parse(optedOut.lines[0] ?? "")).toMatchObject({ state: "opted-out", destination: "disabled" });

		const malformed = fixture();
		expect(
			(await dispatcher.dispatch(dispatcher.parse(["telemetry", "--bogus", "--json"]), malformed.deps as never))
				.exitCode,
		).toBe(2);
		expect(JSON.parse(malformed.lines[0] ?? "")).toMatchObject({ command: "telemetry", ok: false });
	});

	for (const state of [
		{ name: "running", installed: true, running: true, healthy: true },
		{ name: "stopped", installed: true, running: false, healthy: false },
		{ name: "not-installed", installed: false, running: false, healthy: false },
		{ name: "unhealthy", installed: true, running: true, healthy: false },
	] as const) {
		it(`AC-c9 ${state.name} status has exact human and JSON goldens`, async () => {
			const dispatcher = createDispatcher();
			for (const json of [false, true]) {
				const base = fixture();
				const deps = {
					...base.deps,
					daemon: createFakeDaemonClient({ alive: state.healthy }),
					lifecycle: {
						...base.lifecycle,
						async status() {
							return state.running
								? { running: true, pid: 42, port: 3850, serviceManager: "schtasks" }
								: state.installed
									? { running: false, port: 3850, serviceManager: "schtasks" }
									: { running: false, port: 3850 };
						},
					},
					standard: {
						...(base.deps.standard as HoneycombStandardOps),
						configPath: "/fixture/honeycomb",
						logPath: "/fixture/honeycomb/service.log",
						async isServiceInstalled() {
							return state.installed;
						},
					},
				};
				const result = await dispatcher.dispatch(
					dispatcher.parse(["status", ...(json ? ["--json"] : [])]),
					deps as never,
				);
				expect(result.exitCode).toBe(0);
				const output = json ? JSON.stringify(JSON.parse(base.lines[0] ?? ""), null, 2) : base.lines.join("\n");
				expect(output).toMatchSnapshot(`${state.name}-${json ? "json" : "human"}`);
			}
		});
	}

	it("AC-c9 missing logs have exact human and JSON failure goldens", async () => {
		const dispatcher = createDispatcher();
		for (const json of [false, true]) {
			const base = fixture();
			rmSync((base.deps.standard as HoneycombStandardOps).logPath, { force: true });
			const result = await dispatcher.dispatch(
				dispatcher.parse(["logs", "--no-follow", ...(json ? ["--json"] : [])]),
				base.deps as never,
			);
			expect(result.exitCode).toBe(1);
			const output = json ? JSON.stringify(JSON.parse(base.lines[0] ?? ""), null, 2) : base.lines.join("\n");
			expect(output).toMatchSnapshot(`missing-log-${json ? "json" : "human"}`);
		}
	});

	for (const state of [
		{ name: "enabled", env: {} },
		{ name: "opted-out", env: { HONEYCOMB_TELEMETRY: "0" } },
	] as const) {
		it(`AC-c9 telemetry ${state.name} has exact human and JSON goldens`, async () => {
			const dispatcher = createDispatcher();
			const onboarding = {
				schemaVersion: 1,
				installId: "00000000-0000-4000-8000-000000000003",
				phase: "installed",
				firstTimeSetupComplete: true,
				ref: "golden",
				priorTool: { hivemind: "absent" },
				telemetry: { optInTier2: false, reported: {}, sent: [] },
			};
			for (const json of [false, true]) {
				const base = fixture();
				const deps = { ...base.deps, env: state.env, loadOnboarding: () => onboarding };
				const result = await dispatcher.dispatch(
					dispatcher.parse(["telemetry", ...(json ? ["--json"] : [])]),
					deps as never,
				);
				expect(result.exitCode).toBe(0);
				const output = json ? JSON.stringify(JSON.parse(base.lines[0] ?? ""), null, 2) : base.lines.join("\n");
				const stable = output
					.replace(/arch=\S+/gu, "arch=<ARCH>")
					.replace(/node=\S+/gu, "node=<NODE>")
					.replace(/os=\S+/gu, "os=<OS>");
				expect(stable).toMatchSnapshot(`telemetry-${state.name}-${json ? "json" : "human"}`);
			}
		});
	}
});
