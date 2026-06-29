#!/usr/bin/env node
/**
 * PRD-066e packaged upgrade smoke.
 *
 * Builds a candidate tarball, installs a previous package fixture, boots it once
 * with the local queue disabled, upgrades the temp install to the candidate
 * tarball, then starts/stops the upgraded daemon through the installed CLI.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const packageName = String(pkg.name);
const packageVersion = String(pkg.version);
const root = mkdtempSync(join(tmpdir(), "hc-066e-packaged-upgrade-"));
const packDir = join(root, "pack");
const appDir = join(root, "app");
const workspaceDir = join(root, "workspace");
const homeDir = join(root, "home");
const port = 39_000 + Math.floor(Math.random() * 15_000);
const host = "127.0.0.1";
const daemonDir = join(workspaceDir, ".daemon");
const logsDb = join(daemonDir, "logs.db");
const localQueueDb = join(daemonDir, "local-queue.db");

try {
	mkdirSync(packDir, { recursive: true });
	mkdirSync(appDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });

	const candidateTarball = await npmPackCandidate();
	await npmInit(appDir);
	const previousInstalled = await installPreviousFixture();
	await bootDaemonEntry("previous fixture boot", {
		localQueueEnabled: false,
		entry: installedDaemonEntry(),
	});
	assertFile(logsDb, "pre-upgrade logs.db");

	await runNpm(["install", "--no-audit", "--no-fund", "--omit=optional", "--ignore-scripts", candidateTarball], {
		cwd: appDir,
		label: "install candidate tarball",
	});
	await runInstalledCli(["daemon", "start"], smokeEnv({ localQueueEnabled: true }), "candidate cli first start");
	await waitForHealth("candidate cli first start");
	assertFile(logsDb, "post-upgrade logs.db");
	assertFile(localQueueDb, "post-upgrade local-queue.db");
	assertDbTables(logsDb, ["event_log", "request_log"]);
	assertDbTables(localQueueDb, ["local_job"]);
	await assertDiagnostics();
	await runInstalledCli(["daemon", "stop"], smokeEnv({ localQueueEnabled: true }), "candidate cli first stop");

	await runInstalledCli(["daemon", "start"], smokeEnv({ localQueueEnabled: true }), "candidate cli second start");
	await waitForHealth("candidate cli second start");
	assertDbTables(logsDb, ["event_log", "request_log"]);
	assertDbTables(localQueueDb, ["local_job"]);
	await runInstalledCli(["daemon", "stop"], smokeEnv({ localQueueEnabled: true }), "candidate cli second stop");

	console.log(
		`smoke:local-queue-packaged-upgrade - OK: previous=${previousInstalled} candidate=${basename(candidateTarball)} workspace=<temp>`,
	);
} finally {
	try {
		await runInstalledCli(["daemon", "stop"], smokeEnv({ localQueueEnabled: true }), "cleanup stop", { allowFailure: true });
	} catch {
		// The temp install may not exist if packaging failed early.
	}
	rmSync(root, { recursive: true, force: true });
}

async function npmPackCandidate() {
	const output = await runNpm(["pack", "--pack-destination", packDir], {
		cwd: repoRoot,
		label: "npm pack candidate",
	});
	const tarball = output.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.endsWith(".tgz"));
	if (tarball === undefined) throw new Error(`npm pack did not report a tarball:\n${output.stdout}\n${output.stderr}`);
	return join(packDir, tarball);
}

async function npmInit(cwd) {
	await runNpm(["init", "-y"], { cwd, label: "npm init" });
}

async function installPreviousFixture() {
	const explicit = process.env.HONEYCOMB_PREVIOUS_PACKAGE?.trim();
	const previousSpec = explicit !== undefined && explicit.length > 0 ? explicit : `${packageName}@${packageVersion}`;
	try {
		await runNpm(["install", "--no-audit", "--no-fund", "--omit=optional", "--ignore-scripts", previousSpec], {
			cwd: appDir,
			label: explicit === undefined ? "install published previous package" : "install explicit previous package",
		});
		return explicit === undefined ? "published-package" : "explicit-package";
	} catch (err) {
		const fallbackAllowed = /^(1|true|yes)$/i.test(process.env.HONEYCOMB_ALLOW_PREVIOUS_FIXTURE_FALLBACK ?? "");
		if (!fallbackAllowed) throw err;
		const fallback = "candidate-as-previous-fixture";
		const candidate = (await npmPackCandidate());
		await runNpm(["install", "--no-audit", "--no-fund", "--omit=optional", "--ignore-scripts", candidate], {
			cwd: appDir,
			label: "install candidate as previous fixture fallback",
		});
		console.warn(
			"smoke:local-queue-packaged-upgrade - warning: could not install previous package fixture; using candidate with local queue disabled as previous fixture",
		);
		return fallback;
	}
}

function installedCliEntry() {
	return join(appDir, "node_modules", packageName, "bundle", "cli.js");
}

function installedDaemonEntry() {
	return join(appDir, "node_modules", packageName, "daemon", "index.js");
}

async function runInstalledCli(args, env, label, options = {}) {
	const entry = installedCliEntry();
	if (!existsSync(entry)) throw new Error(`${label}: installed CLI entry not found at ${entry}`);
	return run(process.execPath, [entry, ...args], {
		cwd: appDir,
		env,
		label,
		allowFailure: options.allowFailure,
	});
}

async function bootDaemonEntry(label, options) {
	const entry = options.entry;
	if (!existsSync(entry)) throw new Error(`${label}: daemon entry not found at ${entry}`);
	const child = spawn(process.execPath, ["--experimental-sqlite", entry], {
		cwd: appDir,
		env: smokeEnv({ localQueueEnabled: options.localQueueEnabled }),
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	try {
		await waitForHealth(label);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`${label} failed: ${reason}\n${redactLogText(stdout)}\n${redactLogText(stderr)}`);
	} finally {
		await stopChild(child);
	}
}

function smokeEnv(options) {
	const env = { ...process.env };
	for (const key of [
		"HONEYCOMB_BIND",
		"HONEYCOMB_MODE",
		"HONEYCOMB_DEEPLAKE_ENDPOINT",
		"HONEYCOMB_DEEPLAKE_TOKEN",
		"HONEYCOMB_DEEPLAKE_ORG",
		"HONEYCOMB_DEEPLAKE_WORKSPACE",
		"HONEYCOMB_TOKEN",
		"HONEYCOMB_QUERY_METER_PERSIST",
		"HONEYCOMB_TRACE_SQL",
	]) {
		delete env[key];
	}
	return {
		...env,
		HONEYCOMB_HOST: host,
		HONEYCOMB_PORT: String(port),
		HONEYCOMB_WORKSPACE: workspaceDir,
		HOME: homeDir,
		USERPROFILE: homeDir,
		HONEYCOMB_MODE: "local",
		HONEYCOMB_BIND: "",
		HONEYCOMB_DAEMON_SERVICE: "spawn",
		HONEYCOMB_LOCAL_QUEUE_ENABLED: options.localQueueEnabled ? "true" : "false",
		HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED: "false",
		HONEYCOMB_TOPOLOGY: "single-machine",
		HONEYCOMB_EMBEDDINGS: "false",
		HONEYCOMB_POLLINATING_ENABLED: "false",
		HONEYCOMB_GRAPH_PUSH: "0",
	};
}

async function waitForHealth(label) {
	const startedAt = Date.now();
	const url = `http://${host}:${port}/health`;
	while (Date.now() - startedAt < 25_000) {
		try {
			const response = await fetch(url);
			if (response.status === 200 || response.status === 503) {
				console.log(
					`smoke:local-queue-packaged-upgrade - ${label} /health answered ${response.status} after ${Date.now() - startedAt}ms`,
				);
				return;
			}
		} catch {
			// Keep polling until the daemon binds.
		}
		await sleep(250);
	}
	throw new Error(`${label} timed out waiting for ${url}`);
}

async function assertDiagnostics() {
	const response = await fetch(`http://${host}:${port}/api/diagnostics/local-queue`);
	if (response.status !== 200) throw new Error(`local queue diagnostics returned ${response.status}`);
	const body = await response.json();
	if (body?.localQueue?.enabled !== true) throw new Error("local queue diagnostics did not report enabled=true");
	if (body?.topology?.eligibleForDefaultOn !== true) throw new Error("local queue diagnostics did not report default-on eligible topology");
	if (body?.rollback?.requiresDeepLakeMigration !== false || body?.rollback?.requiresLocalDbDeletion !== false) {
		throw new Error("local queue diagnostics reported a rollback migration/delete requirement");
	}
}

function assertFile(path, label) {
	if (!existsSync(path)) throw new Error(`${label} was not created at ${path}`);
}

function assertDbTables(path, requiredTables) {
	const req = createRequire(import.meta.url);
	const sqlite = req("node:sqlite");
	const db = new sqlite.DatabaseSync(path);
	try {
		const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
		const names = new Set(rows.map((row) => String(row.name)));
		for (const table of requiredTables) {
			if (!names.has(table)) {
				throw new Error(`${path} missing expected table ${table}; found ${[...names].join(", ")}`);
			}
		}
	} finally {
		db.close();
	}
}

async function stopChild(child) {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolveExit) => child.once("exit", resolveExit)),
		sleep(5_000).then(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}),
	]);
}

async function run(command, args, options) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
	if (code !== 0 && options.allowFailure !== true) {
		throw new Error(
			`${options.label} failed with code ${code}\n--- stdout ---\n${redactLogText(stdout)}\n--- stderr ---\n${redactLogText(stderr)}`,
		);
	}
	return { stdout, stderr };
}

async function runNpm(args, options) {
	const npmCli = process.env.npm_execpath;
	if (npmCli !== undefined && npmCli.length > 0) {
		return run(process.execPath, [npmCli, ...args], options);
	}
	return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

async function sleep(ms) {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function redactLogText(value) {
	let redacted = String(value);
	for (const sensitiveValue of [process.env.HONEYCOMB_PREVIOUS_PACKAGE, root, packDir, appDir, workspaceDir, homeDir]) {
		if (sensitiveValue !== undefined && sensitiveValue.length > 0) {
			redacted = redacted.split(sensitiveValue).join("<redacted>");
		}
	}
	return redacted
		.replace(/(authorization|token|api[_-]?key|secret)\s*[:=]\s*[^\s"']+/gi, "$1=<redacted>")
		.replace(/(Bearer)\s+[A-Za-z0-9._~+/-]+=*/g, "$1 <redacted>");
}
