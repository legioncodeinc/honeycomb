#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const work = mkdtempSync(join(tmpdir(), "honeycomb-packed-cli-"));
const driver = resolve("scripts/fixtures/packed-cli-driver.mjs");
const baseline = [
	"start",
	"stop",
	"restart",
	"status",
	"logs",
	"install",
	"uninstall",
	"service-install",
	"service-uninstall",
	"update",
	"register",
	"telemetry",
];
const priorCommands = [
	"remember",
	"recall",
	"memory",
	"sessions",
	"pollinate",
	"maintenance",
	"capture",
	"skill",
	"skillify",
	"asset",
	"ontology",
	"graph",
	"sources",
	"goal",
	"agent",
	"route",
	"secret",
	"settings",
	"login",
	"logout",
	"whoami",
	"org",
	"workspace",
	"workspaces",
	"project",
	"setup",
	"install",
	"status",
	"start",
	"stop",
	"daemon",
	"dashboard",
	"hook",
	"harness",
	"telemetry",
	"update",
	"uninstall",
	"connect",
];

function npmCliPath() {
	const fromEnv = process.env.npm_execpath;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const bin = dirname(process.execPath);
	for (const candidate of [
		join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
		resolve(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("could not locate npm-cli.js for packed conformance");
}

function assertResult(result, expected, label) {
	if (result.status !== expected) {
		throw new Error(
			`${label}: expected exit ${expected}, got ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
		);
	}
}

let tarball;
let ownsTarball = false;
try {
	const npmCli = npmCliPath();
	const prebuilt = process.env.HONEYCOMB_PACKED_TARBALL;
	if (prebuilt !== undefined) {
		tarball = resolve(prebuilt);
		const fromWorkspace = relative(resolve("."), tarball);
		if (
			isAbsolute(fromWorkspace) ||
			fromWorkspace.startsWith("..") ||
			basename(tarball) !== `legioncodeinc-honeycomb-${pkg.version}.tgz`
		)
			throw new Error("HONEYCOMB_PACKED_TARBALL must be the current workspace package tarball");
		if (!existsSync(tarball)) throw new Error("HONEYCOMB_PACKED_TARBALL does not exist");
	} else {
		const packed = JSON.parse(
			execFileSync(process.execPath, [npmCli, "pack", "--json"], { cwd: resolve("."), encoding: "utf8" }),
		);
		tarball = resolve(packed[0].filename);
		ownsTarball = true;
	}
	const install = join(work, "install");
	execFileSync(process.execPath, [npmCli, "install", "--prefix", install, "--ignore-scripts", tarball], {
		stdio: "ignore",
	});
	const packageRoot = join(install, "node_modules", "@legioncodeinc", "honeycomb");
	const cli = join(packageRoot, "bundle", "cli.js");
	const core = join(packageRoot, "bundle", "cli-core.js");
	if (!existsSync(core)) throw new Error("packed artifact is missing importable CLI core");
	const coreSource = readFileSync(core, "utf8");
	for (const forbidden of [
		"createFakeDaemonClient",
		"HONEYCOMB_CONFORMANCE_ROOT",
		"packed fixture ready",
		"injected runtime failure",
	]) {
		if (coreSource.includes(forbidden))
			throw new Error(`packed CLI core contains forbidden fixture surface: ${forbidden}`);
	}
	const env = {
		...process.env,
		APIARY_HOME: join(work, "apiary"),
		HONEYCOMB_CONFORMANCE_ROOT: join(work, "fixture"),
		NO_COLOR: "1",
	};
	const runBin = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
	const runFixture = (scenario, args) =>
		spawnSync(process.execPath, [driver, core, scenario, ...args], { encoding: "utf8", env });

	const helpResult = runBin(["--help"]);
	assertResult(helpResult, 0, "packed help");
	const help = helpResult.stdout;
	for (const token of [
		"HONEYCOMB",
		"Legion Code Inc. x Activeloop",
		"Service lifecycle",
		"Installation",
		"Fleet",
		"Diagnostics",
		"Product commands",
		...baseline,
	]) {
		if (!help.includes(token)) throw new Error(`packed help is missing ${token}`);
	}
	const versionResult = runBin(["--version"]);
	assertResult(versionResult, 0, "packed version");
	if (versionResult.stdout !== `honeycomb v${pkg.version}\n`)
		throw new Error("packed --version drifted from package.json");
	const versionJsonResult = runBin(["--version", "--json"]);
	assertResult(versionJsonResult, 0, "packed JSON version");
	const version = JSON.parse(versionJsonResult.stdout);
	if (version.product !== "honeycomb" || version.version !== pkg.version || version.ok !== true)
		throw new Error("packed JSON version contract failed");
	const helpJsonResult = runBin(["--help", "--json"]);
	assertResult(helpJsonResult, 0, "packed JSON help");
	const parsedHelp = JSON.parse(helpJsonResult.stdout);
	if (!parsedHelp.ok || /HONEYCOMB|Legion Code/.test(helpJsonResult.stdout))
		throw new Error("packed JSON help is not clean");
	const unknown = runBin(["not-a-command", "--json"]);
	assertResult(unknown, 2, "packed unknown command");
	if (JSON.parse(unknown.stdout).ok !== false) throw new Error("packed unknown command JSON contract failed");

	const inventoryResult = runFixture("inventory", []);
	assertResult(inventoryResult, 0, "packed inventory");
	const inventory = JSON.parse(inventoryResult.stdout);
	if (inventory.length !== 43) throw new Error(`packed command inventory expected 43, got ${inventory.length}`);
	for (const command of priorCommands) {
		if (!inventory.includes(command)) throw new Error(`packed command inventory regressed ${command}`);
	}

	const commandArgs = {
		logs: ["--no-follow"],
		uninstall: ["--yes"],
		update: ["--check"],
	};
	for (const command of baseline) {
		const tail = commandArgs[command] ?? [];
		for (const json of [false, true]) {
			const suffix = json ? [...tail, "--json"] : tail;
			const success = runFixture("success", [command, ...suffix]);
			assertResult(success, 0, `packed ${command} ${json ? "JSON" : "human"} success`);
			if (command === "logs" && /packed-secret|Bearer/iu.test(`${success.stdout}${success.stderr}`)) {
				throw new Error(`packed logs ${json ? "JSON" : "human"} output leaked an unredacted credential`);
			}
			if (json) {
				const body = JSON.parse(success.stdout);
				if (body.product !== "honeycomb" || body.command !== command || body.ok !== true)
					throw new Error(`packed ${command} JSON success envelope failed`);
			} else if (`${success.stdout}${success.stderr}`.trim().length === 0) {
				throw new Error(`packed ${command} human success was empty`);
			}

			const failure = runFixture("failure", [command, ...suffix]);
			assertResult(failure, 1, `packed ${command} ${json ? "JSON" : "human"} runtime failure`);
			if (json) {
				const body = JSON.parse(failure.stdout);
				if (body.product !== "honeycomb" || body.command !== command || body.ok !== false)
					throw new Error(`packed ${command} JSON failure envelope failed`);
			} else if (`${failure.stdout}${failure.stderr}`.trim().length === 0) {
				throw new Error(`packed ${command} human runtime failure was empty`);
			}
		}

		const usage = runFixture("success", [command, "--bogus", "--json"]);
		assertResult(usage, 2, `packed ${command} malformed usage`);
		const usageBody = JSON.parse(usage.stdout);
		if (usageBody.product !== "honeycomb" || usageBody.command !== command || usageBody.ok !== false)
			throw new Error(`packed ${command} usage envelope failed`);
	}
	console.log("packed-cli-conformance OK - full 12-command human/JSON success/failure/usage matrix");
} finally {
	if (ownsTarball && tarball) rmSync(tarball, { force: true });
	rmSync(work, { recursive: true, force: true });
}
