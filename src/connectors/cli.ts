/**
 * `honeycomb setup` / `connect <harness>` / `uninstall` CLI — PRD-019a (a-AC-4 / index AC-1).
 *
 *   - `honeycomb setup`               — detect every installed harness and wire it (a-AC-4 / FR-7).
 *   - `honeycomb connect <harness>`   — wire ONE named harness (FR-7).
 *   - `honeycomb uninstall [<harness>]` — reverse ONLY Honeycomb's footprint (a-AC-2 / FR-6);
 *     no target → reverse every detected harness.
 *
 * ── Boundary: install-time only, NO DeepLake (FR-9 / D-2) ───────────────────
 * This is a thin install-time tool. It imports neither `src/daemon/storage` nor the daemon
 * core; it constructs {@link HarnessConnector}s over an injected {@link ConnectorFs} and calls
 * `install()`/`uninstall()`. The connectors touch the local filesystem ONLY — they open NO
 * DeepLake, hold no daemon handle, and stamp no runtime path (runtime calls are the hooks' job,
 * 019b). The `src/connectors` root is in `NON_DAEMON_ROOTS` (invariant.test.ts) so this holds
 * by construction.
 *
 * Note (honest deferral, matches 001–018): the bundled `honeycomb` bin is not yet extended to
 * dispatch here; that is the deferred pure-wiring assembly step (mirrors `org.ts` / `skillify.ts`).
 * This module is constructed-and-tested — the AC-named test drives {@link runConnectorCommand}
 * with a {@link createFakeFs} and a fake connector registry.
 */

import type { ConnectorFs, ConnectorRunResult, HarnessConnector } from "./contracts.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface ConnectorOutputSink {
	(line: string): void;
}

/**
 * Builds a {@link HarnessConnector} for a harness slug over the supplied {@link ConnectorFs}.
 * The real registry (daemon-assembly wiring) supplies the concrete connectors bound to the
 * real `node:fs`-backed seam + the user's home; the AC-named test supplies fakes over a
 * {@link createFakeFs}. Returns `undefined` for an unknown slug.
 */
export interface ConnectorRegistry {
	/** Build the connector for `harness`, or `undefined` when the slug is unknown. */
	build(harness: string, fs: ConnectorFs): HarnessConnector | undefined;
	/** Every harness slug the registry knows (so `setup` can ask each whether it is detected). */
	known(): readonly string[];
}

/** The injectable seams the connector CLI runs against (a-AC-4). */
export interface ConnectorCommandDeps {
	/** The filesystem seam (real `node:fs` wrapper in prod; `createFakeFs` in tests). */
	readonly fs: ConnectorFs;
	/** The connector registry (which harness slugs exist + how to build each). */
	readonly registry: ConnectorRegistry;
	/** The output sink (defaults to `console.log`). */
	readonly out?: ConnectorOutputSink;
}

/** Outcome of a connector command: exit code + the per-harness run results. */
export interface ConnectorCommandResult {
	readonly exitCode: number;
	/** The install/uninstall results, one per harness wired/reversed. */
	readonly results: readonly ConnectorRunResult[];
}

/** The parsed `setup`/`connect`/`uninstall` invocation: the verb + an optional harness arg. */
export interface ConnectorInvocation {
	/** The verb (`setup` | `connect` | `uninstall` | ""). */
	readonly verb: string;
	/** The harness slug (for `connect <harness>` / `uninstall <harness>`), if any. */
	readonly harness?: string;
}

/** Parse a raw argv tail: the first non-flag word is the verb, the second the harness slug. */
export function parseConnectorArgs(argv: readonly string[]): ConnectorInvocation {
	const words = argv.filter((a) => !a.startsWith("--"));
	const verb = words[0] ?? "";
	const harness = words[1];
	return harness === undefined ? { verb } : { verb, harness };
}

/** Detect every known harness installed on this box (a-AC-4 / FR-7). */
async function detectAll(deps: ConnectorCommandDeps): Promise<string[]> {
	const detected: string[] = [];
	for (const slug of deps.registry.known()) {
		const connector = deps.registry.build(slug, deps.fs);
		if (connector === undefined) continue;
		const platforms = await connector.detectPlatforms();
		if (platforms.length > 0) detected.push(slug);
	}
	return detected;
}

/**
 * `honeycomb setup` — wire EVERY detected harness (a-AC-4 / FR-7). With no target on a box with
 * two detected harnesses, both are wired. Each connector's `install()` is foreign-preserving +
 * idempotent, so re-running `setup` writes nothing where nothing changed.
 */
async function runSetup(deps: ConnectorCommandDeps, out: ConnectorOutputSink): Promise<ConnectorCommandResult> {
	const detected = await detectAll(deps);
	if (detected.length === 0) {
		out("No harnesses detected. Install a supported harness, then re-run `honeycomb setup`.");
		return { exitCode: 0, results: [] };
	}
	const results: ConnectorRunResult[] = [];
	for (const slug of detected) {
		const connector = deps.registry.build(slug, deps.fs);
		if (connector === undefined) continue;
		const result = await connector.install();
		results.push(result);
		out(`Wired ${slug}${result.wroteConfig ? "" : " (already up to date)"}.`);
	}
	return { exitCode: 0, results };
}

/** `honeycomb connect <harness>` — wire ONE named harness (FR-7). */
async function runConnect(
	harness: string,
	deps: ConnectorCommandDeps,
	out: ConnectorOutputSink,
): Promise<ConnectorCommandResult> {
	if (harness === "") {
		out("usage: honeycomb connect <harness>");
		return { exitCode: 1, results: [] };
	}
	const connector = deps.registry.build(harness, deps.fs);
	if (connector === undefined) {
		out(`Unknown harness '${harness}'. Known: ${deps.registry.known().join(", ")}.`);
		return { exitCode: 1, results: [] };
	}
	const result = await connector.install();
	out(`Wired ${harness}${result.wroteConfig ? "" : " (already up to date)"}.`);
	return { exitCode: 0, results: [result] };
}

/**
 * `honeycomb uninstall [<harness>]` — reverse ONLY Honeycomb's footprint (a-AC-2 / FR-6). A
 * target reverses that one; no target reverses every detected harness. Foreign hooks/skills +
 * a still-populated config are always preserved; an emptied config is cleanly unlinked.
 */
async function runUninstall(
	harness: string | undefined,
	deps: ConnectorCommandDeps,
	out: ConnectorOutputSink,
): Promise<ConnectorCommandResult> {
	const slugs = harness !== undefined && harness !== "" ? [harness] : await detectAll(deps);
	const results: ConnectorRunResult[] = [];
	for (const slug of slugs) {
		const connector = deps.registry.build(slug, deps.fs);
		if (connector === undefined) {
			out(`Unknown harness '${slug}'. Known: ${deps.registry.known().join(", ")}.`);
			return { exitCode: 1, results };
		}
		const result = await connector.uninstall();
		results.push(result);
		out(`Removed Honeycomb from ${slug}.`);
	}
	return { exitCode: 0, results };
}

/**
 * Run a parsed connector command (a-AC-4 / index AC-1). The seams are injected so the AC-named
 * test drives the whole surface against a {@link createFakeFs} + a fake registry — no real `~`,
 * no daemon. Every path is install-time filesystem only.
 */
export async function runConnectorCommand(
	inv: ConnectorInvocation,
	deps: ConnectorCommandDeps,
): Promise<ConnectorCommandResult> {
	const out = deps.out ?? ((line: string): void => console.log(line));

	if (inv.verb === "setup") return runSetup(deps, out);
	if (inv.verb === "connect") return runConnect(inv.harness ?? "", deps, out);
	if (inv.verb === "uninstall") return runUninstall(inv.harness, deps, out);

	out("usage: honeycomb <setup | connect <harness> | uninstall [<harness>]>");
	return { exitCode: inv.verb === "" ? 0 : 1, results: [] };
}

/** Convenience entry: parse + run a connector argv tail in one call. */
export function connectorMain(argv: readonly string[], deps: ConnectorCommandDeps): Promise<ConnectorCommandResult> {
	return runConnectorCommand(parseConnectorArgs(argv), deps);
}
