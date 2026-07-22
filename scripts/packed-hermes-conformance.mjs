#!/usr/bin/env node
/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const work = mkdtempSync(join(tmpdir(), "honeycomb-packed-hermes-"));
const runtimeNode = process.env.HONEYCOMB_CONFORMANCE_NODE ?? process.execPath;
if (!isAbsolute(runtimeNode) || !existsSync(runtimeNode)) {
	throw new Error("HONEYCOMB_CONFORMANCE_NODE must name an existing absolute Node executable");
}

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
	throw new Error("could not locate npm-cli.js");
}

function assert(result, label) {
	if (result.status !== 0)
		throw new Error(`${label}: exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
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
		const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--json"], { encoding: "utf8" }));
		tarball = resolve(packed[0].filename);
		ownsTarball = true;
	}
	const install = join(work, "install");
	execFileSync(process.execPath, [npmCli, "install", "--prefix", install, "--ignore-scripts", tarball], {
		stdio: "ignore",
	});

	const packageRoot = join(install, "node_modules", "@legioncodeinc", "honeycomb");
	const cli =
		process.platform === "win32"
			? join(packageRoot, "bundle", "cli.js")
			: join(install, "node_modules", ".bin", "honeycomb");
	const hermesHome = join(work, "hermes");
	const env = { ...process.env, HOME: join(work, "home"), HERMES_HOME: hermesHome, NO_COLOR: "1" };
	const configPath = join(hermesHome, "config.yaml");
	await mkdir(hermesHome, { recursive: true });
	await writeFile(
		configPath,
		[
			"# foreign comment",
			"hooks:",
			"  post_tool_call:",
			"    - command: /opt/foreign-audit # preserve",
			"      timeout: 9",
			"foreign_setting: keep-me",
			"",
		].join("\n"),
	);
	const run = (args) => spawnSync(runtimeNode, [cli, ...args], { encoding: "utf8", env });

	assert(run(["--help"]), "packed help");
	assert(run(["connect", "hermes", "--no-color"]), "packed Hermes connect");
	const installed = readFileSync(configPath, "utf8");
	for (const token of [
		"# foreign comment",
		"/opt/foreign-audit # preserve",
		"foreign_setting: keep-me",
		"on_session_finalize:",
		"mcp_servers:",
		"_honeycomb: true",
	]) {
		if (!installed.includes(token)) throw new Error(`packed Hermes install omitted ${token}`);
	}
	for (const file of [
		"honeycomb/manifest.json",
		"honeycomb/bundle/session-start.mjs",
		"honeycomb/bundle/capture.mjs",
		"honeycomb/bundle/session-end.mjs",
		"honeycomb/mcp/server.mjs",
	]) {
		if (!existsSync(join(hermesHome, file))) throw new Error(`packed Hermes install omitted ${file}`);
	}

	const sessionId = "packed-hermes-native-protocol";
	const baseEvent = { session_id: sessionId, cwd: work, transcript_path: join(work, "transcript.jsonl") };
	const hookCases = [
		{
			label: "session start",
			file: "session-start.mjs",
			args: [],
			payload: { ...baseEvent, hook_event_name: "on_session_start", extra: { source: "packed-conformance" } },
		},
		{
			label: "user capture",
			file: "capture.mjs",
			args: [],
			payload: { ...baseEvent, hook_event_name: "pre_llm_call", extra: { user_message: "verify package" } },
		},
		{
			label: "user recall",
			file: "capture.mjs",
			args: ["--honeycomb-recall"],
			payload: { ...baseEvent, hook_event_name: "pre_llm_call", extra: { user_message: "verify package" } },
		},
		{
			label: "tool capture",
			file: "capture.mjs",
			args: [],
			payload: {
				...baseEvent,
				hook_event_name: "post_tool_call",
				tool_name: "terminal",
				tool_input: { command: "pwd" },
				extra: { result: "ok" },
			},
		},
		{
			label: "assistant capture",
			file: "capture.mjs",
			args: [],
			payload: { ...baseEvent, hook_event_name: "post_llm_call", extra: { assistant_response: "verified" } },
		},
		{
			label: "session finalize",
			file: "session-end.mjs",
			args: [],
			payload: { ...baseEvent, hook_event_name: "on_session_finalize", extra: { reason: "complete" } },
		},
	];
	for (const hookCase of hookCases) {
		const result = spawnSync(runtimeNode, [join(hermesHome, "honeycomb", "bundle", hookCase.file), ...hookCase.args], {
			encoding: "utf8",
			env,
			input: JSON.stringify(hookCase.payload),
		});
		assert(result, `packed Hermes native ${hookCase.label}`);
	}

	assert(run(["uninstall", "hermes", "--yes", "--no-color"]), "packed Hermes uninstall");
	const removed = readFileSync(configPath, "utf8");
	for (const token of ["# foreign comment", "/opt/foreign-audit # preserve", "foreign_setting: keep-me"]) {
		if (!removed.includes(token)) throw new Error(`packed Hermes uninstall removed foreign content: ${token}`);
	}
	if (removed.includes("_honeycomb: true") || existsSync(join(hermesHome, "honeycomb")))
		throw new Error("packed Hermes uninstall left empty Honeycomb-owned state behind");

	// A user may have placed their own file below the Honeycomb root. A second uninstall
	// must preserve it rather than recursively removing the directory we originally created.
	assert(run(["connect", "hermes", "--no-color"]), "packed Hermes reconnect");
	const foreignOwnedRootFile = join(hermesHome, "honeycomb", "foreign.keep");
	await writeFile(foreignOwnedRootFile, "foreign content");
	assert(run(["uninstall", "hermes", "--yes", "--no-color"]), "packed Hermes foreign-root uninstall");
	if (!existsSync(foreignOwnedRootFile))
		throw new Error("packed Hermes uninstall removed a foreign Honeycomb-root file");

	// Managed artifacts are removed only while their content still matches the atomic
	// ownership manifest. User modifications must survive uninstall.
	const modifiedHome = join(work, "modified-artifact-hermes");
	await mkdir(modifiedHome, { recursive: true });
	const modifiedEnv = { ...env, HERMES_HOME: modifiedHome };
	const modifiedRun = (args) => spawnSync(runtimeNode, [cli, ...args], { encoding: "utf8", env: modifiedEnv });
	assert(modifiedRun(["connect", "hermes", "--no-color"]), "packed Hermes modified-artifact connect");
	const modifiedCapture = join(modifiedHome, "honeycomb", "bundle", "capture.mjs");
	await writeFile(modifiedCapture, "// user modified\n");
	assert(modifiedRun(["uninstall", "hermes", "--yes", "--no-color"]), "packed Hermes modified-artifact uninstall");
	if (readFileSync(modifiedCapture, "utf8") !== "// user modified\n")
		throw new Error("packed Hermes uninstall removed or changed a modified managed artifact");
	if (!existsSync(join(modifiedHome, "honeycomb", "manifest.json")))
		throw new Error("packed Hermes uninstall removed ownership evidence for a modified managed artifact");

	// A pre-existing managed target with no Honeycomb ownership manifest must fail
	// closed before config or any other artifact is changed.
	const foreignArtifactHome = join(work, "foreign-artifact-hermes");
	const foreignCapture = join(foreignArtifactHome, "honeycomb", "bundle", "capture.mjs");
	await mkdir(dirname(foreignCapture), { recursive: true });
	await writeFile(foreignCapture, "// foreign capture\n");
	const foreignArtifact = spawnSync(runtimeNode, [cli, "connect", "hermes", "--no-color"], {
		encoding: "utf8",
		env: { ...env, HERMES_HOME: foreignArtifactHome },
	});
	if (foreignArtifact.status === 0) throw new Error("packed Hermes connect overwrote an unowned managed artifact");
	if (readFileSync(foreignCapture, "utf8") !== "// foreign capture\n")
		throw new Error("packed Hermes foreign-artifact refusal changed the existing artifact");
	if (existsSync(join(foreignArtifactHome, "config.yaml")))
		throw new Error("packed Hermes foreign-artifact refusal left a partial config behind");

	// A conflicting foreign MCP key must fail closed before config or artifacts are written.
	const conflictHome = join(work, "foreign-mcp-hermes");
	await mkdir(conflictHome, { recursive: true });
	const conflictConfigPath = join(conflictHome, "config.yaml");
	const conflictConfig = "mcp_servers:\n  honeycomb:\n    command: /opt/acme/not-ours\n    args: []\n";
	await writeFile(conflictConfigPath, conflictConfig);
	const conflict = spawnSync(runtimeNode, [cli, "connect", "hermes", "--no-color"], {
		encoding: "utf8",
		env: { ...env, HERMES_HOME: conflictHome },
	});
	if (conflict.status === 0) throw new Error("packed Hermes connect accepted a foreign honeycomb MCP server");
	if (readFileSync(conflictConfigPath, "utf8") !== conflictConfig || existsSync(join(conflictHome, "honeycomb")))
		throw new Error("packed Hermes foreign MCP refusal left partial state behind");

	console.log(`packed-hermes-conformance OK - ${pkg.name}@${pkg.version} install/uninstall is isolated and reversible`);
} finally {
	if (ownsTarball && tarball) rmSync(tarball, { force: true });
	rmSync(work, { recursive: true, force: true });
}
