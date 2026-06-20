#!/usr/bin/env node
/**
 * The LOGIN (device-flow) SMOKE — PRD-023 Wave 3.
 *
 * A runnable, human-driven end-to-end proof of the REAL `api.deeplake.ai` connect parity: it drives
 * the SAME production `honeycomb login` device flow + `honeycomb whoami` the CLI ships, against the
 * live backend, and reports PASS/FAIL. It is intentionally a thin wrapper around the bundled CLI
 * (`bundle/cli.js`) so there is ONE source of the real code path — the smoke adds no auth logic of
 * its own, it just runs the verbs an operator would and confirms the shared file landed.
 *
 * Flow (the one un-automatable bit is the browser authorize):
 *   1. `honeycomb login` → the CLI prints the user code + verification URI and opens the browser.
 *      THE HUMAN authorizes in the browser (this is the step no script can do for you).
 *   2. On approval the CLI mints a long-lived org-bound token, GETs /me, and writes the SHARED
 *      `~/.deeplake/credentials.json` (Hivemind shape, 0600) — the same file `hivemind whoami` reads.
 *   3. `honeycomb whoami` → GET /me prints the authenticated user / org / workspace (never the token).
 *
 * ── Token-gated / interactive (mirrors scripts/golden-path-smoke.mjs's gating) ─
 * The device flow needs an INTERACTIVE TTY (a human approves in the browser) and reaches the live
 * `api.deeplake.ai`. To stay safe on CI / credential-less / non-interactive machines this smoke
 * REQUIRES an explicit opt-in: set `HONEYCOMB_LOGIN_SMOKE=1`. Without it the smoke prints a clear
 * message and EXITS 0 (never fails a fork or a CI run that didn't ask for it). With the opt-in but no
 * TTY it also no-ops with a clear message — the browser-authorize step cannot run unattended.
 *
 * To run it for real:
 *     HONEYCOMB_LOGIN_SMOKE=1 npm run smoke:login
 *   (then complete the sign-in in the browser window that opens.)
 *
 * Headless variant (no browser): a pre-issued token still validates via /me. Provide it and the
 * underlying CLI takes the AC-2 path automatically:
 *     HONEYCOMB_LOGIN_SMOKE=1 HONEYCOMB_TOKEN=<key> npm run smoke:login
 *
 * ── Secrets (D-4) ────────────────────────────────────────────────────────────
 * This script NEVER reads, prints, or forwards the bearer token. It only checks env PRESENCE and
 * relays the CLI's own (token-free) stdout. The token rides inside the CLI's `Authorization` header
 * and is written 0600 to the shared file by the CLI — never touched here.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI_BUNDLE = join(REPO_ROOT, "bundle", "cli.js");
const SHARED_CREDS = join(homedir(), ".deeplake", "credentials.json");

/** Print a banner line so the operator sees the smoke's verdict at a glance. */
function banner(line) {
	console.log("");
	console.log("════════════════════════════════════════════════════════════════════");
	console.log(line);
	console.log("════════════════════════════════════════════════════════════════════");
}

// ── Opt-in gate: this is an INTERACTIVE, live-backend smoke. No opt-in → no-op, exit 0.
if (process.env.HONEYCOMB_LOGIN_SMOKE !== "1") {
	banner("LOGIN SMOKE: SKIPPED (opt-in required)");
	console.log(
		"This smoke drives the REAL api.deeplake.ai device flow and needs a human to authorize\n" +
			"in the browser, so it does not run by default. To run it:\n" +
			"\n" +
			"    HONEYCOMB_LOGIN_SMOKE=1 npm run smoke:login          # device flow (opens a browser)\n" +
			"    HONEYCOMB_LOGIN_SMOKE=1 HONEYCOMB_TOKEN=<key> npm run smoke:login   # headless\n",
	);
	process.exit(0);
}

// ── The device flow needs a TTY for the human authorize step; a pre-issued token (headless) does not.
const headless = typeof process.env.HONEYCOMB_TOKEN === "string" && process.env.HONEYCOMB_TOKEN.length > 0;
if (!headless && !process.stdin.isTTY) {
	banner("LOGIN SMOKE: SKIPPED (no interactive TTY)");
	console.log(
		"The device flow requires an interactive terminal so you can authorize in the browser.\n" +
			"Run it from a real terminal, or use the headless variant with HONEYCOMB_TOKEN=<key>.\n",
	);
	process.exit(0);
}

// ── The built CLI bundle is the single source of the real login code path.
if (!existsSync(CLI_BUNDLE)) {
	banner("LOGIN SMOKE: FAIL (CLI bundle missing)");
	console.log(`Expected the built CLI at ${CLI_BUNDLE}. Build it first:\n\n    npm run build\n`);
	process.exit(1);
}

banner(
	headless
		? "LOGIN SMOKE: running the REAL headless (token) login → shared file → whoami"
		: "LOGIN SMOKE: running the REAL device-flow login → shared file → whoami",
);
console.log(
	headless
		? "Validating the pre-issued token via GET /me and writing the shared ~/.deeplake file...\n"
		: "A browser will open. Complete the sign-in there — that is the one step no script can do.\n",
);

// Step 1: `honeycomb login` (device flow, or headless when HONEYCOMB_TOKEN is set). The CLI prints the
// user code + verification URI itself; stdio is inherited so the human sees + interacts with it.
const login = spawnSync(process.execPath, [CLI_BUNDLE, "login"], { stdio: "inherit", env: process.env });
if (login.status !== 0) {
	banner("LOGIN SMOKE: FAIL (login did not complete)");
	console.log("The login verb returned a non-zero exit (denied, expired, or aborted). No shared file written.");
	process.exit(login.status === null ? 1 : login.status);
}

// Step 2: confirm the shared `~/.deeplake/credentials.json` landed (the cross-tool file Hivemind reads).
if (!existsSync(SHARED_CREDS)) {
	banner("LOGIN SMOKE: FAIL (no shared credential written)");
	console.log(`Login reported success but ${SHARED_CREDS} is absent. This is a real bug — investigate.`);
	process.exit(1);
}
console.log(`\nShared credential written: ${SHARED_CREDS}\n`);

// Step 3: `honeycomb whoami` (GET /me) — prints user / org / workspace (never the token).
console.log("Running `honeycomb whoami` to confirm the session resolves identity live...\n");
const whoami = spawnSync(process.execPath, [CLI_BUNDLE, "whoami"], { stdio: "inherit", env: process.env });
if (whoami.status !== 0) {
	banner("LOGIN SMOKE: FAIL (whoami did not resolve the session)");
	console.log("The shared file was written but whoami could not validate it via GET /me. Investigate.");
	process.exit(whoami.status === null ? 1 : whoami.status);
}

banner("LOGIN SMOKE: PASS");
console.log("Device-flow login → shared ~/.deeplake/credentials.json → whoami all proven live.");
console.log("This is the SAME file `hivemind whoami` reads — one login authenticates both tools.");
process.exit(0);
