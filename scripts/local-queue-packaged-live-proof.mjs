/**
 * PRD-066 packaged live proof.
 *
 * Packs the current candidate, installs that tarball into a temp app, starts the
 * installed CLI against this machine's real DeepLake credentials, and reads the
 * installed daemon's own query-meter diagnostics. The proof is intentionally
 * read-only against DeepLake: diagnostics and recall perform reads, while the
 * temp workspace/port keep daemon state off the user's normal install.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const packageName = String(pkg.name);
const root = mkdtempSync(join(tmpdir(), "hc-066-package-live-"));
const packDir = join(root, "pack");
const appDir = join(root, "app");
const workspaceDir = join(root, "workspace");
const runtimeDir = join(root, "runtime");
const host = "127.0.0.1";
const port = await findAvailablePort();
const idleWindowMs = Number.parseInt(process.env.HONEYCOMB_PACKAGE_LIVE_IDLE_MS ?? "1500", 10);
const progressIntervalMs = Number.parseInt(process.env.HONEYCOMB_PACKAGE_LIVE_PROGRESS_MS ?? "60000", 10);
const queryTimeoutMs = parsePositiveInt(process.env.HONEYCOMB_PACKAGE_LIVE_QUERY_TIMEOUT_MS, 2_000);
const requestTimeoutMs = parsePositiveInt(
	process.env.HONEYCOMB_PACKAGE_LIVE_REQUEST_TIMEOUT_MS,
	Math.max(30_000, queryTimeoutMs * 6),
);
const autoBuildGraph = parseBool(process.env.HONEYCOMB_PACKAGE_LIVE_AUTO_BUILD_GRAPH, false);
const startBackgroundWorkers = parseBool(process.env.HONEYCOMB_PACKAGE_LIVE_BACKGROUND_WORKERS, false);
const startSummaryWorker = parseBool(process.env.HONEYCOMB_PACKAGE_LIVE_SUMMARY_WORKER, startBackgroundWorkers);
const startPipelineWorker = parseBool(process.env.HONEYCOMB_PACKAGE_LIVE_PIPELINE_WORKER, startBackgroundWorkers);
const startSkillifyWorker = parseBool(process.env.HONEYCOMB_PACKAGE_LIVE_SKILLIFY_WORKER, startBackgroundWorkers);
const startPollinatingWorker = parseBool(process.env.HONEYCOMB_PACKAGE_LIVE_POLLINATING_WORKER, startBackgroundWorkers);
const pollinatingEnabled = parseBool(process.env.HONEYCOMB_PACKAGE_LIVE_POLLINATING_ENABLED, false);
const runId = `pkg_live_${Date.now().toString(36)}_${process.pid}`;
const logPath = process.env.HONEYCOMB_PACKAGE_LIVE_LOG_PATH ?? join(tmpdir(), `hc-066-package-live-${runId}.log`);
let runningDaemon;
let originalEnv;

try {
	mkdirSync(dirname(logPath), { recursive: true });
	log(`smoke:local-queue-packaged-live-proof - run starting run_id=${runId} log_path=${logPath} root=${root}`);
	logMetrics("run start");
	assertLiveCredentialsAvailable();
	mkdirSync(packDir, { recursive: true });
	mkdirSync(appDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });

	log("smoke:local-queue-packaged-live-proof - npm pack starting");
	const candidateTarball = await npmPackCandidate();
	log(`smoke:local-queue-packaged-live-proof - npm pack complete tarball=${candidateTarball}`);
	await runNpm(["init", "-y"], { cwd: appDir, label: "npm init" });
	log("smoke:local-queue-packaged-live-proof - candidate install starting");
	await runNpm(["install", "--no-audit", "--no-fund", "--omit=optional", "--ignore-scripts", candidateTarball], {
		cwd: appDir,
		label: "install candidate tarball",
	});
	log("smoke:local-queue-packaged-live-proof - candidate install complete");

	originalEnv = applyLiveEnv();
	log("smoke:local-queue-packaged-live-proof - daemon import/start starting");
	runningDaemon = await startInstalledDaemon();
	log("smoke:local-queue-packaged-live-proof - daemon import/start returned");
	logMetrics("after daemon start");
	await waitForHealth("candidate package daemon start");
	logMetrics("after health");

	log(
			`smoke:local-queue-packaged-live-proof - idle window starting ms=${idleWindowMs} ` +
			`progress_ms=${progressIntervalMs} request_timeout_ms=${requestTimeoutMs} query_timeout_ms=${queryTimeoutMs} ` +
			`auto_build_graph=${autoBuildGraph} background_workers=${startBackgroundWorkers} ` +
			`summary_worker=${startSummaryWorker} pipeline_worker=${startPipelineWorker} ` +
			`skillify_worker=${startSkillifyWorker} pollinating_worker=${startPollinatingWorker} ` +
			`pollinating_enabled=${pollinatingEnabled}`,
	);
	await sleepWithProgress(idleWindowMs, "idle window");
	log("smoke:local-queue-packaged-live-proof - idle window complete; reading diagnostics");
	logMetrics("before idle diagnostics");
	const idle = await readDiagnostics("idle window");
	logMetrics("after idle diagnostics");
	assertPollReads(idle, 0, "idle local queue should not perform DeepLake poll reads");

	const recallBefore = sourceReads(idle, "recall-arm");
	log("smoke:local-queue-packaged-live-proof - issuing recall read");
	const recall = await fetchJson("/api/memories/recall", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-honeycomb-runtime-path": "plugin",
			"x-honeycomb-session": runId,
		},
		body: JSON.stringify({
			query: `honeycomb packaged live proof ${runId}`,
			limit: 1,
			cwd: workspaceDir,
		}),
	});
	if (recall.status < 200 || recall.status >= 300) {
		throw new Error(`recall live read returned ${recall.status}: ${JSON.stringify(redactBody(recall.body))}`);
	}

	log("smoke:local-queue-packaged-live-proof - recall complete; reading diagnostics");
	logMetrics("after recall");
	const active = await readDiagnostics("after recall");
	logMetrics("after active diagnostics");
	const recallDelta = sourceReads(active, "recall-arm") - recallBefore;
	if (recallDelta <= 0) {
		throw new Error(`recall did not increment the installed daemon query meter; delta=${recallDelta}`);
	}
	assertPollReads(active, 0, "recall through local queue mode should not perform DeepLake poll reads");

	log(
		`smoke:local-queue-packaged-live-proof - OK: tarball=${candidateTarball} ` +
			`idle_poll_reads=${pollReads(idle)} active_poll_reads=${pollReads(active)} ` +
			`recall_reads_delta=${recallDelta} total_reads=${active.queryMeter.snapshot.totalReads} ` +
			`workspace=${workspaceDir}`,
	);
} finally {
	log("smoke:local-queue-packaged-live-proof - cleanup starting");
	if (runningDaemon !== undefined) {
		try {
			log("smoke:local-queue-packaged-live-proof - daemon cleanup starting");
			await runningDaemon.close();
			log("smoke:local-queue-packaged-live-proof - daemon cleanup complete");
		} catch (err) {
			warn(`smoke:local-queue-packaged-live-proof - warning: daemon cleanup failed: ${errorMessage(err)}`);
		}
	}
	if (originalEnv !== undefined) restoreEnv(originalEnv);
	await sleep(300);
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
	} catch (err) {
		warn(`smoke:local-queue-packaged-live-proof - warning: temp cleanup failed at ${root}: ${errorMessage(err)}`);
	}
	log("smoke:local-queue-packaged-live-proof - cleanup complete");
}

function assertLiveCredentialsAvailable() {
	const envCreds =
		process.env.HONEYCOMB_DEEPLAKE_TOKEN !== undefined &&
		process.env.HONEYCOMB_DEEPLAKE_ORG !== undefined &&
		process.env.HONEYCOMB_DEEPLAKE_WORKSPACE !== undefined;
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const fileCreds = home.length > 0 && existsSync(join(home, ".deeplake", "credentials.json"));
	if (!envCreds && !fileCreds) {
		throw new Error(
			"package live proof requires real DeepLake credentials in HONEYCOMB_DEEPLAKE_* or ~/.deeplake/credentials.json",
		);
	}
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

function installedDaemonEntry() {
	return join(appDir, "node_modules", packageName, "daemon", "index.js");
}

async function startInstalledDaemon() {
	const entry = installedDaemonEntry();
	if (!existsSync(entry)) throw new Error(`installed daemon entry not found at ${entry}`);
	const mod = await import(pathToFileURL(entry).href);
	if (typeof mod.runAssembledDaemon !== "function") {
		throw new Error(`installed daemon entry does not export runAssembledDaemon: ${entry}`);
	}
	return mod.runAssembledDaemon({
		runtimeDir,
		workspaceDir,
		autoBuildGraph,
		startBackgroundWorkers,
		startSummaryWorker,
		startPipelineWorker,
		startSkillifyWorker,
		startPollinatingWorker,
	});
}

async function findAvailablePort() {
	const server = createServer();
	return await new Promise((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			server.close((err) => {
				if (err !== undefined) {
					reject(err);
					return;
				}
				if (address === null || typeof address === "string") {
					reject(new Error("could not allocate a loopback port"));
					return;
				}
				resolvePort(address.port);
			});
		});
	});
}

function applyLiveEnv() {
	const patch = {
		HONEYCOMB_HOST: host,
		HONEYCOMB_PORT: String(port),
		HONEYCOMB_WORKSPACE: workspaceDir,
		HONEYCOMB_MODE: "local",
		HONEYCOMB_BIND: "",
		HONEYCOMB_DAEMON_SERVICE: "spawn",
		HONEYCOMB_LOCAL_QUEUE_ENABLED: "true",
		HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED: "false",
		HONEYCOMB_QUERY_TIMEOUT_MS: String(queryTimeoutMs),
		HONEYCOMB_TOPOLOGY: "single-machine",
		HONEYCOMB_EMBEDDINGS: "false",
		HONEYCOMB_POLLINATING_ENABLED: pollinatingEnabled ? "true" : "false",
		HONEYCOMB_GRAPH_PUSH: "0",
		HONEYCOMB_TOKEN: undefined,
		HONEYCOMB_QUERY_METER_PERSIST: undefined,
		HONEYCOMB_TRACE_SQL: undefined,
	};
	const original = {};
	for (const [key, value] of Object.entries(patch)) {
		original[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return original;
}

function restoreEnv(original) {
	for (const [key, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function waitForHealth(label) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 25_000) {
		try {
			const response = await fetch(`http://${host}:${port}/health`);
			if (response.status === 200 || response.status === 503) {
				log(
					`smoke:local-queue-packaged-live-proof - ${label} /health answered ${response.status} after ${Date.now() - startedAt}ms`,
				);
				return;
			}
		} catch {
			// Keep polling until the daemon binds.
		}
		await sleep(250);
	}
	throw new Error(`${label} timed out waiting for http://${host}:${port}/health`);
}

async function readDiagnostics(label) {
	const result = await fetchJson("/api/diagnostics/local-queue");
	if (result.status !== 200) throw new Error(`${label}: local queue diagnostics returned ${result.status}`);
	const body = result.body;
	if (body?.localQueue?.enabled !== true)
		throw new Error(`${label}: local queue diagnostics did not report enabled=true`);
	if (body?.topology?.eligibleForDefaultOn !== true) {
		throw new Error(`${label}: local queue diagnostics did not report default-on eligible topology`);
	}
	if (body?.queryMeter?.snapshot === undefined)
		throw new Error(`${label}: queryMeter snapshot missing from diagnostics`);
	return body;
}

async function fetchJson(path, init) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
	try {
		const response = await fetch(`http://${host}:${port}${path}`, {
			...init,
			signal: controller.signal,
		});
		const text = await response.text();
		let body;
		try {
			body = text.length === 0 ? null : JSON.parse(text);
		} catch {
			body = { raw: text.slice(0, 300) };
		}
		return { status: response.status, body };
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`${path} did not answer within ${requestTimeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}

function assertPollReads(diagnostics, expected, label) {
	const actual = pollReads(diagnostics);
	if (actual !== expected) throw new Error(`${label}; expected ${expected}, got ${actual}`);
}

function pollReads(diagnostics) {
	return sourceReads(diagnostics, "poll-lease") + sourceReads(diagnostics, "poll-reaper");
}

function sourceReads(diagnostics, source) {
	const rows = diagnostics?.queryMeter?.snapshot?.perSource;
	if (!Array.isArray(rows)) return 0;
	return Number(rows.find((entry) => entry?.source === source)?.reads ?? 0);
}

function redactBody(body) {
	if (body === null || typeof body !== "object") return body;
	const copy = { ...body };
	for (const key of Object.keys(copy)) {
		if (/token|secret|credential|authorization/i.test(key)) copy[key] = "[redacted]";
	}
	return copy;
}

function errorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}

function parseBool(value, fallback) {
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function parsePositiveInt(value, fallback) {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
		throw new Error(`${options.label} failed with code ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
	}
	return { stdout, stderr };
}

async function runNpm(args, options) {
	const npmCli = process.env.npm_execpath;
	if (npmCli !== undefined && npmCli.length > 0) return run(process.execPath, [npmCli, ...args], options);
	return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

async function sleep(ms) {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function sleepWithProgress(ms, label) {
	if (ms <= 0) return;
	const startedAt = Date.now();
	let nextProgressAt = Math.max(1, progressIntervalMs);
	while (Date.now() - startedAt < ms) {
		const elapsed = Date.now() - startedAt;
		const remaining = Math.max(0, ms - elapsed);
		await sleep(Math.min(remaining, Math.max(1, progressIntervalMs)));
		const nextElapsed = Date.now() - startedAt;
		if (nextElapsed >= nextProgressAt || nextElapsed >= ms) {
			const memory = process.memoryUsage();
			const cpu = process.cpuUsage();
			log(
				`smoke:local-queue-packaged-live-proof - ${label} progress ` +
					`elapsed_ms=${nextElapsed} remaining_ms=${Math.max(0, ms - nextElapsed)} ` +
					`rss_mb=${toMb(memory.rss)} heap_mb=${toMb(memory.heapUsed)} ` +
					`cpu_user_ms=${Math.round(cpu.user / 1000)} cpu_system_ms=${Math.round(cpu.system / 1000)}`,
			);
			nextProgressAt += Math.max(1, progressIntervalMs);
		}
	}
}

function toMb(bytes) {
	return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function log(message) {
	console.log(message);
	appendLog(message);
}

function warn(message) {
	console.warn(message);
	appendLog(message);
}

function appendLog(message) {
	try {
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never change smoke behavior.
	}
}

function logMetrics(label) {
	const memory = process.memoryUsage();
	const cpu = process.cpuUsage();
	log(
		`smoke:local-queue-packaged-live-proof - metrics stage="${label}" ` +
			`rss_mb=${toMb(memory.rss)} heap_mb=${toMb(memory.heapUsed)} ` +
			`cpu_user_ms=${Math.round(cpu.user / 1000)} cpu_system_ms=${Math.round(cpu.system / 1000)}`,
	);
}
