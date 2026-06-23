#!/usr/bin/env node
/**
 * Daemon-bundle load smoke — catches the class of regression that the in-process
 * Vitest suite structurally cannot: a BUILT `daemon/index.js` that throws at module
 * load (e.g. an esbuild ESM bundle whose transitively-bundled CJS dep does a dynamic
 * `require(...)` the bundle can't execute → "Dynamic require of X is not supported").
 *
 * The integration tests assemble the daemon IN PROCESS (tsx/vitest) and never import
 * the esbuild bundle, so a bundle-only break (like the `yaml` dynamic-require the
 * inference-config loader pulled in) ships green and only surfaces when a human runs
 * `honeycomb daemon start`. This smoke closes that gap cheaply.
 *
 * How: spawn the bundle with NO DeepLake creds for a short window. We do NOT assert
 * the daemon fully boots (that needs creds + network) — only that it does not die
 * from a MODULE-LOAD / bundling error. A clean import either keeps the process alive
 * (it proceeds to its own startup, which may then fail on missing creds — fine) or
 * exits without a load-error signature. Any load-error signature in stderr fails.
 *
 * Run AFTER `npm run build`. Exit 0 = bundle loads; exit 1 = a load/bundling error.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(repoRoot, "daemon", "index.js");

if (!existsSync(entry)) {
	console.error(`smoke:daemon-bundle — ${entry} not found. Run \`npm run build\` first.`);
	process.exit(1);
}

/** Signatures that mean the BUNDLE itself failed to load (vs a runtime/creds failure). */
const LOAD_ERROR_SIGNATURES = [
	"Dynamic require of", // esbuild ESM dynamic-require shim throw (the yaml regression)
	"is not supported",
	"SyntaxError",
	"ERR_MODULE_NOT_FOUND",
	"Cannot find module",
	"Cannot find package",
	"ERR_REQUIRE_ESM",
	"Named export",
	"does not provide an export",
	"ReferenceError", // e.g. a missing banner/global referenced at module scope
];

const WATCH_MS = 3000;

// Spawn the bundle with creds STRIPPED so it cannot accidentally connect to a real
// backend; we only care about module load. `windowsHide` keeps it quiet on Windows.
const child = spawn(process.execPath, [entry], {
	cwd: repoRoot,
	env: {
		...process.env,
		HONEYCOMB_DEEPLAKE_TOKEN: "",
		HONEYCOMB_DEEPLAKE_ENDPOINT: "",
		HONEYCOMB_POLLINATING_ENABLED: "",
		// Park runtime state in a temp-ish subdir so the smoke never touches a real .secrets/.daemon.
		HONEYCOMB_WORKSPACE: resolve(repoRoot, ".smoke-daemon-bundle"),
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});

let stderr = "";
let stdout = "";
child.stdout.on("data", (b) => {
	stdout += String(b);
});
child.stderr.on("data", (b) => {
	stderr += String(b);
});

let settled = false;
const finish = (code, why) => {
	if (settled) return;
	settled = true;
	try {
		child.kill();
	} catch {
		/* already gone */
	}
	const combined = `${stdout}\n${stderr}`;
	const hit = LOAD_ERROR_SIGNATURES.find((s) => combined.includes(s));
	if (hit) {
		console.error(`smoke:daemon-bundle — FAIL: the daemon bundle failed to load (matched "${hit}").`);
		console.error("─── captured output ───");
		console.error(combined.trim().split("\n").slice(0, 30).join("\n"));
		process.exit(1);
	}
	console.log(`smoke:daemon-bundle — OK: daemon/index.js loaded without a bundling/module error (${why}).`);
	process.exit(0);
};

// If the process throws a load error it usually exits fast and non-zero with the
// signature in stderr; if it loads cleanly it keeps running (its own startup), so we
// stop watching after WATCH_MS and treat "no load-error signature" as success.
child.on("exit", () => finish(0, "process exited"));
child.on("error", (err) => {
	stderr += `\nspawn error: ${err?.message ?? err}`;
	finish(1, "spawn error");
});
setTimeout(() => finish(0, `survived ${WATCH_MS}ms`), WATCH_MS);
