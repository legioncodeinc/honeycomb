#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [corePath, scenario = "success", ...argv] = process.argv.slice(2);
if (!corePath) throw new Error("packed CLI core path is required");
const core = await import(pathToFileURL(corePath).href);
const exported = Object.keys(core).sort();
if (JSON.stringify(exported) !== JSON.stringify(["VERB_TABLE", "createDispatcher"])) {
	throw new Error(`packed CLI core exposed an unexpected surface: ${exported.join(", ")}`);
}
const { createDispatcher, VERB_TABLE } = core;
if (scenario === "inventory") {
	process.stdout.write(`${JSON.stringify(VERB_TABLE.map((entry) => entry.verb))}\n`);
	process.exitCode = 0;
} else {
	const root = process.env.HONEYCOMB_CONFORMANCE_ROOT;
	if (!root) throw new Error("HONEYCOMB_CONFORMANCE_ROOT is required");
	mkdirSync(root, { recursive: true });
	const logPath = join(root, "service.log");
	if (scenario === "failure" && argv[0] === "logs") rmSync(logPath, { force: true });
	else writeFileSync(logPath, "packed fixture ready\nAuthorization: Bearer packed-secret\n", "utf8");

	let running = true;
	const failed = (command) => ({ ok: false, message: `${command}: injected runtime failure.` });
	const standard = {
		configPath: root,
		logPath,
		async start() {
			if (scenario === "failure") return failed("start");
			running = true;
			return { ok: true, changed: false, message: "Honeycomb is already running." };
		},
		async stop() {
			if (scenario === "failure") return failed("stop");
			running = false;
			return { ok: true, changed: true, message: "Honeycomb stopped through its installed OS service." };
		},
		async restart() {
			if (scenario === "failure") return failed("restart");
			running = true;
			return { ok: true, changed: true, message: "Honeycomb restarted through its installed OS service." };
		},
		async serviceInstall() {
			return scenario === "failure"
				? failed("service-install")
				: { ok: true, changed: false, message: "service reconciled" };
		},
		async serviceUninstall() {
			return scenario === "failure"
				? failed("service-uninstall")
				: { ok: true, changed: true, message: "service removed" };
		},
		async isServiceInstalled() {
			if (scenario === "failure" && argv[0] === "status") throw new Error("service inspection failed");
			return true;
		},
		async register() {
			return scenario === "failure"
				? failed("register")
				: { ok: true, changed: false, message: "registration reconciled" };
		},
		async isRegistered() {
			return true;
		},
		async update() {
			return scenario === "failure"
				? failed("update")
				: {
						ok: true,
						changed: false,
						message: "Honeycomb is current.",
						details: { fromVersion: "0.21.0", toVersion: "0.21.0" },
					};
		},
	};
	const lifecycle = {
		async start() {
			return { started: false, alreadyRunning: true };
		},
		async stop() {
			running = false;
			return { stopped: true };
		},
		async status() {
			return running
				? { running: true, pid: 4242, port: 3850, serviceManager: "fixture" }
				: { running: false, port: 3850, serviceManager: "fixture" };
		},
		async restart() {
			return { restarted: true, viaService: true };
		},
	};
	const onboarding = {
		schemaVersion: 1,
		installId: "00000000-0000-4000-8000-000000000003",
		phase: "installed",
		firstTimeSetupComplete: true,
		ref: "packed",
		priorTool: { hivemind: "absent" },
		telemetry: { optInTier2: false, reported: {}, sent: [] },
	};
	const deps = {
		daemon: {
			async ping() {
				return true;
			},
			async request() {
				return { ok: true, status: 200, body: {} };
			},
		},
		lifecycle,
		standard,
		dir: join(root, "onboarding"),
		env: {},
		out: (line) => process.stdout.write(`${line}\n`),
		err: (line) => process.stderr.write(`${line}\n`),
		connector: {
			async run({ verb }) {
				return { exitCode: scenario === "failure" && verb === "uninstall" ? 1 : 0, harnesses: [] };
			},
		},
		uninstallSteps: {
			async stopDaemon() {
				if (scenario === "failure") throw new Error("stop failed");
				return { stopped: true };
			},
			unregisterService: () => ({ removed: true, manager: "fixture" }),
			deleteRegistryEntry: () => ({ removed: true }),
			removeStateDir: () => ({ removed: true, dir: root }),
		},
		persistInstalled: () => scenario !== "failure",
		registerWithDoctor: () => scenario !== "failure",
		openDashboard: () => false,
		probeDashboard: async () => false,
		detectFleet: async () => ({
			mode: "fleet",
			signals: { registryHiveEntry: true, hivePortAnswering: false, hiveNpmGlobal: false },
			firedSignals: ["registryHiveEntry"],
		}),
		loadInstallCredentials: () => ({ token: "fixture" }),
		loadOnboarding: () => {
			if (scenario === "failure") throw new Error("telemetry inspection failed");
			return onboarding;
		},
	};
	const dispatcher = createDispatcher();
	const result = await dispatcher.dispatch(dispatcher.parse(argv), deps);
	process.exitCode = result.exitCode;
}
