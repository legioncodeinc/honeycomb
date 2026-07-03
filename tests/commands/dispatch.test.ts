/**
 * PRD-020a a-AC-1 + index AC-1 — the unified dispatcher: parse + route + org/ws passthrough.
 *
 * Proves:
 *   - a-AC-1: global flags parse, the verb resolves, and `org`/`workspace`/`login`/`logout`
 *     forward their FULL arg array to the auth dispatcher (NOT re-parsed).
 *   - index AC-1: a storage verb dispatches THROUGH the `DaemonClient` seam (never DeepLake);
 *     the invariant test proves the static no-storage-import half.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	AUTH_SUBCOMMANDS,
	type AuthPassthrough,
	type CommandDeps,
	createDispatcher,
	createFakeDaemonClient,
	DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE,
	parseInvocation,
	usageText,
	VERB_GROUPS,
	VERB_TABLE,
} from "../../src/commands/index.js";

/** A recording auth-passthrough fake that captures the FULL arg array forwarded (FR-4). */
function recordingAuth(): AuthPassthrough & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		async dispatch(args: readonly string[]): Promise<number> {
			calls.push([...args]);
			return 0;
		},
	};
}

describe("PRD-020a a-AC-1 — the unified dispatcher parses + routes", () => {
	it("a-AC-1 parses leading global flags and resolves the verb, leaving the tail for the handler", () => {
		const inv = parseInvocation(["--json", "recall", "my", "query", "--limit", "5"]);
		expect(inv.flags.json).toBe(true);
		expect(inv.verb).toBe("recall");
		expect(inv.argv).toEqual(["my", "query", "--limit", "5"]);
	});

	it("a-AC-1 prints usage and exits 0 when no command is given (FR-1)", async () => {
		const lines: string[] = [];
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), out: (l) => lines.push(l) };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse([]), deps);
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/usage: honeycomb/);
	});

	it("a-AC-1 --version short-circuits to the version line", async () => {
		const lines: string[] = [];
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), out: (l) => lines.push(l) };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["--version"]), deps);
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/honeycomb v/);
	});

	it("a-AC-1 org/workspace pass the FULL arg array through to the auth dispatcher (FR-4)", async () => {
		const auth = recordingAuth();
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), auth, out: () => {} };
		const d = createDispatcher();

		await d.dispatch(d.parse(["org", "switch", "acme"]), deps);
		await d.dispatch(d.parse(["workspace", "use", "prod"]), deps);
		await d.dispatch(d.parse(["login"]), deps);
		// PRD-049d: `project` is an auth passthrough too — forwarded verbatim to `src/cli/project.ts`.
		await d.dispatch(d.parse(["project", "bind", "api"]), deps);

		// The dispatcher forwards verb + tail verbatim — it does NOT re-parse the subcommand.
		expect(auth.calls).toEqual([
			["org", "switch", "acme"],
			["workspace", "use", "prod"],
			["login"],
			["project", "bind", "api"],
		]);
	});

	it("index AC-1 a storage verb dispatches THROUGH the DaemonClient seam (never DeepLake)", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["recall", "what", "did", "we", "decide"]), deps);
		expect(res.exitCode).toBe(0);
		// The storage verb reached the daemon seam — exactly one dispatched call, to the recall route.
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]?.req.path).toBe("/api/memories/recall");
	});

	it("PRD-045f f-AC-3 `skillify pull` is REGISTERED and DISPATCHES through the daemon seam (not just a table row)", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };
		const d = createDispatcher();

		// The verb resolves (registered) AND the dispatcher routes it as a storage verb to the
		// live skills group — a dead-route or unknown-verb would never reach the daemon seam.
		const res = await d.dispatch(d.parse(["skillify", "pull"]), deps);
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]?.req.path).toBe("/api/skills/pull");
	});

	it("PRD-050a routes `install` as a LOCAL verb through the daemon ensure-running + opener seams (reachable portal opens)", async () => {
		const lines: string[] = [];
		const urls: string[] = [];
		// Bind a TEMP onboarding dir so this dispatcher test never persists to the developer/CI machine's
		// real `~/.deeplake/onboarding.json` or telemetry dedupe ledger — install's handler writes the
		// onboarding marker (and the dedupe ledger lives in the same dir) and would otherwise mutate real
		// state (mirrors install.test.ts). The dispatcher forwards `dir` into the install verb deps;
		// telemetry stays a no-op under the empty build-time PostHog key.
		const dir = mkdtempSync(join(tmpdir(), "hc-dispatch-install-"));
		try {
			// A live daemon so ensure-running short-circuits (no lifecycle needed here); a recording opener;
			// a reachable portal probe so the C-6 honest-dashboard branch takes the open path.
			const deps = {
				daemon: createFakeDaemonClient({ alive: true }),
				openDashboard: (url: string): boolean => {
					urls.push(url);
					return true;
				},
				probeDashboard: async () => true,
				out: (l: string) => lines.push(l),
				dir,
			} as unknown as CommandDeps;
			const d = createDispatcher();
			const res = await d.dispatch(d.parse(["install", "--ref", "alice"]), deps);
			expect(res.exitCode).toBe(0);
			// The verb reached the install handler: a dashboard URL was opened and the ready line printed.
			expect(urls.length).toBeGreaterThan(0);
			expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("PRD-050a (C-6) an unreachable portal through the dispatcher prints one honest sentence and opens nothing", async () => {
		const lines: string[] = [];
		const urls: string[] = [];
		const dir = mkdtempSync(join(tmpdir(), "hc-dispatch-install-"));
		try {
			const deps = {
				daemon: createFakeDaemonClient({ alive: true }),
				openDashboard: (url: string): boolean => {
					urls.push(url);
					return true;
				},
				probeDashboard: async () => false,
				out: (l: string) => lines.push(l),
				dir,
			} as unknown as CommandDeps;
			const d = createDispatcher();
			const res = await d.dispatch(d.parse(["install", "--ref", "alice"]), deps);
			expect(res.exitCode).toBe(0);
			// No browser tab on the unreachable-portal path — just the one-sentence fallback + ready line.
			expect(urls).toHaveLength(0);
			expect(lines).toContain(DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE);
			expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a-AC-1 an unknown command prints usage and exits non-zero", async () => {
		const lines: string[] = [];
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), out: (l) => lines.push(l) };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["frobnicate"]), deps);
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/unknown command/);
	});
});

describe("FR-2 — `--help` lists EVERY command, branded + grouped", () => {
	it("renders the ASCII honeycomb banner atop the usage", () => {
		const help = usageText();
		expect(help).toMatch(/H O N E Y C O M B/);
		// The two-row honeycomb cells render before the version line.
		expect(help.indexOf("\\__/")).toBeLessThan(help.indexOf("usage: honeycomb"));
	});

	it("lists every VERB_TABLE verb (no command silently missing from help)", () => {
		const help = usageText();
		for (const spec of VERB_TABLE) {
			expect(help.includes(`  ${spec.verb} `) || new RegExp(`\\n  ${spec.verb}\\s`).test(help)).toBe(true);
		}
	});

	it("surfaces the auth verbs that regressed — login + logout — in the listing", () => {
		const help = usageText();
		expect(help).toMatch(/\n {2}login\s/);
		expect(help).toMatch(/\n {2}logout\s/);
	});

	it("every auth-passthrough subcommand is also a listed verb (table ⊇ passthrough set)", () => {
		const listed = new Set(VERB_TABLE.map((s) => s.verb));
		for (const sub of AUTH_SUBCOMMANDS) expect(listed.has(sub)).toBe(true);
	});

	it("prints a header for every non-empty group", () => {
		const help = usageText();
		for (const { key, label } of VERB_GROUPS) {
			if (VERB_TABLE.some((s) => s.group === key)) expect(help).toContain(`${label}:`);
		}
	});
});
