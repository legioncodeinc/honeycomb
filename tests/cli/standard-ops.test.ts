import { describe, expect, it } from "vitest";
import type { DaemonServiceController, ServiceSpec } from "../../src/cli/daemon-service.js";
import {
	buildHoneycombStandardOps,
	registryContainsHoneycomb,
	selectNpmInvocation,
	updateHoneycomb,
} from "../../src/cli/standard-ops.js";
import type { DaemonClient } from "../../src/commands/contracts.js";
import type { DaemonLifecycle } from "../../src/commands/daemon.js";
import { HONEYCOMB_VERSION } from "../../src/shared/constants.js";

describe("Honeycomb standard updater npm resolution", () => {
	it("uses the npm CLI bundled beside the active Windows Node runtime", () => {
		const node = "C:\\Program Files\\nodejs\\node.exe";
		const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
		const result = selectNpmInvocation(node, "win32", npmCli);
		expect(result.file).toBe(node);
		expect(result.argvPrefix[0]).toMatch(/npm-cli\.js$/);
	});

	it("uses fixed-argv PATH resolution on Unix when npm is not bundled beside Node", () => {
		expect(selectNpmInvocation("/usr/bin/node", "linux", undefined)).toEqual({ file: "npm", argvPrefix: [] });
	});

	it("fails closed on Windows rather than invoking a shell shim", () => {
		expect(() => selectNpmInvocation("C:\\portable\\node.exe", "win32", undefined)).toThrow(/npm-cli\.js/);
	});
});

describe("Honeycomb Doctor registry inspection", () => {
	it("parses valid state and rejects malformed registry content without a caller-provided path", () => {
		expect(registryContainsHoneycomb('{"daemons":[]}')).toBe(false);
		expect(registryContainsHoneycomb('{"daemons":[{"name":"honeycomb"}]}')).toBe(true);
		expect(() => registryContainsHoneycomb("{not-json")).toThrow();
	});
});

function updaterFixture(pings: readonly boolean[] = [true]): {
	readonly daemon: DaemonClient;
	readonly isServiceInstalled: () => Promise<boolean>;
	readonly restartService: () => Promise<{ ok: boolean; message: string }>;
} {
	let ping = 0;
	return {
		daemon: { ping: async () => pings[ping++] ?? pings.at(-1) ?? false } as unknown as DaemonClient,
		isServiceInstalled: async () => true,
		restartService: async () => ({ ok: true, message: "service restarted" }),
	};
}

describe("Honeycomb updater verification and rollback", () => {
	it("fails before npm or restart when the OS service is not installed", async () => {
		let npmCalls = 0;
		let restarts = 0;
		const result = await updateHoneycomb(false, {
			...updaterFixture(),
			isServiceInstalled: async () => false,
			restartService: async () => {
				restarts++;
				return { ok: true, message: "unexpected" };
			},
			runNpm: async () => {
				npmCalls++;
				return "";
			},
		});
		expect(result).toMatchObject({ ok: false });
		expect(result.message).toMatch(/service-install/);
		expect(npmCalls).toBe(0);
		expect(restarts).toBe(0);
	});

	it("uses fixed npm argv and verifies the globally installed target before reporting success", async () => {
		const calls: string[][] = [];
		const result = await updateHoneycomb(false, {
			...updaterFixture(),
			healthAttempts: 1,
			runNpm: async (args) => {
				calls.push([...args]);
				if (args[0] === "view") return JSON.stringify("9.9.9");
				if (args[0] === "list")
					return JSON.stringify({ dependencies: { "@legioncodeinc/honeycomb": { version: "9.9.9" } } });
				return "";
			},
		});
		expect(result).toMatchObject({ ok: true, changed: true });
		expect(calls).toEqual([
			["view", "@legioncodeinc/honeycomb", "version", "--json"],
			["install", "--global", "@legioncodeinc/honeycomb@9.9.9"],
			["list", "--global", "@legioncodeinc/honeycomb", "--depth=0", "--json"],
		]);
	});

	it("reports rollback only after the restored version, restart, and health are verified", async () => {
		let list = 0;
		const result = await updateHoneycomb(false, {
			...updaterFixture([false, true]),
			healthAttempts: 1,
			runNpm: async (args) => {
				if (args[0] === "view") return JSON.stringify("9.9.9");
				if (args[0] === "list") {
					const version = list++ === 0 ? "9.9.9" : HONEYCOMB_VERSION;
					return JSON.stringify({ dependencies: { "@legioncodeinc/honeycomb": { version } } });
				}
				return "";
			},
		});
		expect(result).toMatchObject({ ok: false, details: { rolledBack: true } });
		expect(result.message).toMatch(/verified healthy/);
	});

	it("raises a hard recovery failure when rollback cannot be verified", async () => {
		const installs: string[] = [];
		const result = await updateHoneycomb(false, {
			...updaterFixture([false]),
			healthAttempts: 1,
			runNpm: async (args) => {
				if (args[0] === "view") return JSON.stringify("9.9.9");
				if (args[0] === "install") installs.push(args.at(-1) ?? "");
				if (args[0] === "list")
					return JSON.stringify({ dependencies: { "@legioncodeinc/honeycomb": { version: "9.9.9" } } });
				return "";
			},
		});
		expect(result).toMatchObject({ ok: false, details: { rolledBack: false } });
		expect(result.message).toMatch(/Manual recovery is required/);
		expect(installs).toEqual(["@legioncodeinc/honeycomb@9.9.9", `@legioncodeinc/honeycomb@${HONEYCOMB_VERSION}`]);
	});
});

const SERVICE_SPEC: ServiceSpec = {
	nodePath: "/usr/bin/node",
	entry: "/fixture/daemon.js",
	nodeFlags: [],
	workspace: "/fixture/honeycomb",
};

function serviceBoundaryFixture(
	registered: boolean,
	restartThrows = false,
	serviceRunning = true,
	daemonRunning = false,
) {
	const calls: string[] = [];
	let healthChecks = 0;
	const controller: DaemonServiceController = {
		manager: "launchd",
		register() {
			calls.push("register");
			return { ok: true, manager: "launchd" };
		},
		unregister() {
			calls.push("unregister");
			return { ok: true, manager: "launchd" };
		},
		restart() {
			calls.push("restart");
			if (restartThrows) throw new Error("manager failed");
			return { ok: true, manager: "launchd" };
		},
		stop() {
			calls.push("stop");
			return { ok: true, manager: "launchd" };
		},
		isRegistered() {
			calls.push("inspect");
			return registered;
		},
		isRunning() {
			calls.push("running");
			return serviceRunning;
		},
	};
	const lifecycle: DaemonLifecycle = {
		async start() {
			calls.push("legacy-start");
			return { started: true, alreadyRunning: false };
		},
		async stop() {
			calls.push("legacy-stop");
			return { stopped: true };
		},
		async status() {
			return { running: daemonRunning, port: 3850 };
		},
		async restart() {
			calls.push("legacy-restart");
			return { restarted: true, viaService: false };
		},
	};
	const daemon = {
		ping: async () => {
			healthChecks++;
			return true;
		},
	} as unknown as DaemonClient;
	return {
		calls,
		get healthChecks() {
			return healthChecks;
		},
		ops: buildHoneycombStandardOps(daemon, lifecycle, SERVICE_SPEC, {
			manager: "launchd",
			controllerFor: () => controller,
			healthAttempts: 1,
			stopAttempts: 1,
			serviceStateAttempts: 1,
		}),
	};
}

describe("Honeycomb baseline service-only lifecycle boundary", () => {
	it.each(["start", "stop", "restart"] as const)("%s fails with guidance when the service is absent", async (verb) => {
		const { calls, ops } = serviceBoundaryFixture(false);
		const result = await ops[verb]();
		expect(result).toMatchObject({ ok: false });
		expect(result.message).toMatch(/service-install/);
		expect(calls).toEqual(["inspect"]);
	});

	it("never falls back to legacy restart when the installed service manager fails", async () => {
		const { calls, ops } = serviceBoundaryFixture(true, true);
		await expect(ops.restart()).rejects.toThrow(/manager failed/);
		expect(calls).toEqual(["inspect", "restart"]);
		expect(calls).not.toContain("legacy-restart");
	});

	it("service-install rejects orphan health when the newly run service is not running", async () => {
		const fixture = serviceBoundaryFixture(false, false, false);
		const result = await fixture.ops.serviceInstall();
		expect(result).toMatchObject({ ok: false });
		expect(result.message).toMatch(/manager reports it is not running/);
		expect(fixture.calls).toEqual(["inspect", "register", "running"]);
		expect(fixture.healthChecks).toBe(0);
	});

	it("service-install fails closed when the controller cannot prove manager-owned running state", async () => {
		let healthChecks = 0;
		const controllerWithoutIdentity = {
			manager: "launchd" as const,
			register: () => ({ ok: true as const, manager: "launchd" as const }),
			unregister: () => ({ ok: true as const, manager: "launchd" as const }),
			restart: () => ({ ok: true as const, manager: "launchd" as const }),
			stop: () => ({ ok: true as const, manager: "launchd" as const }),
			isRegistered: () => false,
		};
		const ops = buildHoneycombStandardOps(
			{
				ping: async () => {
					healthChecks++;
					return true;
				},
			} as unknown as DaemonClient,
			{
				start: async () => ({ started: false, alreadyRunning: false }),
				stop: async () => ({ stopped: true }),
				status: async () => ({ running: false, port: 3850 }),
				restart: async () => ({ restarted: false, viaService: false }),
			},
			SERVICE_SPEC,
			{ manager: "launchd", controllerFor: () => controllerWithoutIdentity, serviceStateAttempts: 1 },
		);
		const result = await ops.serviceInstall();
		expect(result).toMatchObject({ ok: false });
		expect(result.message).toMatch(/manager reports it is not running/);
		expect(healthChecks).toBe(0);
	});

	it("service-uninstall fails when daemon-stop verification still sees an orphan", async () => {
		const fixture = serviceBoundaryFixture(true, false, true, true);
		const result = await fixture.ops.serviceUninstall();
		expect(result).toMatchObject({ ok: false });
		expect(result.message).toMatch(/could not verify that the daemon stopped/);
		expect(fixture.calls).toEqual(["inspect", "unregister"]);
	});
});
