#!/usr/bin/env node
/**
 * PRD-066d built-daemon smoke.
 *
 * Boots the built daemon entry with a temporary workspace and local queue enabled,
 * proves the two daemon-local SQLite DBs are created, stops it, then boots the
 * same workspace again to prove existing local operational state reopens cleanly.
 *
 * Run after `npm run build`:
 *   node --experimental-sqlite scripts/local-queue-upgrade-smoke.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(repoRoot, "daemon", "index.js");
const workspaceDir = mkdtempSync(join(tmpdir(), "hc-066d-upgrade-"));
const homeDir = join(workspaceDir, "home");
const port = 38_500 + Math.floor(Math.random() * 20_000);
const host = "127.0.0.1";
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const daemonDir = join(workspaceDir, ".daemon");
const logsDb = join(daemonDir, "logs.db");
const localQueueDb = join(daemonDir, "local-queue.db");

if (!existsSync(entry)) {
	console.error(`smoke:local-queue-upgrade - ${entry} not found. Run \`npm run build\` first.`);
	process.exit(1);
}

try {
	mkdirSync(homeDir, { recursive: true });
	await bootAndAssert("first boot");
	assertDbTables(logsDb, ["event_log", "request_log"]);
	assertDbTables(localQueueDb, ["local_job"]);
	await bootAndAssert("second boot");
	console.log(
		`smoke:local-queue-upgrade - OK: built daemon created and reopened local DBs at ${workspaceDir}`,
	);
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}

async function bootAndAssert(label) {
	const child = spawn(process.execPath, ["--experimental-sqlite", entry], {
		cwd: repoRoot,
		env: smokeEnv(),
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
		await waitForHealth(label, child);
		assertFile(logsDb, `${label} logs.db`);
		assertFile(localQueueDb, `${label} local-queue.db`);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`smoke:local-queue-upgrade - ${label} failed on port ${port}: ${reason}\n` +
				`--- stdout ---\n${stdout.trim()}\n--- stderr ---\n${stderr.trim()}`,
		);
	} finally {
		await stopChild(child);
	}
}

function smokeEnv() {
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
		HONEYCOMB_LOCAL_QUEUE_ENABLED: "true",
		HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED: "false",
		HONEYCOMB_EMBEDDINGS: "false",
		HONEYCOMB_POLLINATING_ENABLED: "false",
		HONEYCOMB_GRAPH_PUSH: "0",
	};
}

async function waitForHealth(label, child) {
	const startedAt = Date.now();
	const url = `http://${host}:${port}/health`;
	while (Date.now() - startedAt < 20_000) {
		if (child.exitCode !== null) {
			throw new Error(`${label} daemon exited before /health responded with code ${child.exitCode}`);
		}
		try {
			const response = await fetchWithTimeout(url, HEALTH_REQUEST_TIMEOUT_MS);
			if (response.status === 200 || response.status === 503) {
				console.log(
					`smoke:local-queue-upgrade - ${label} /health answered ${response.status} after ${Date.now() - startedAt}ms`,
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
	const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
	child.kill("SIGTERM");
	const exited = await Promise.race([exit.then(() => true), sleep(5_000).then(() => false)]);
	if (exited) return;
	if (child.exitCode === null) child.kill("SIGKILL");
	await exit;
}

async function fetchWithTimeout(url, timeoutMs) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function sleep(ms) {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
