/**
 * PRD-020c Cursor extension shell suite — c-AC-1..6 + the b-AC-5 webview-embed assertion.
 *
 * The extension SHELL is driven entirely through seams (D-2 / D-7): the `ExtensionHost` fake (no
 * `vscode`), a `HookWiring`/`SkillSync` over a REAL 019a `HarnessConnector` backed by the 019a
 * `FakeFs` (D-4 — no forked merge engine), a `DashboardWebviewRenderer` over the canonical 020b
 * `renderDashboard` (D-6 — no duplicate view code), a `StatusBarHealthSource` over a 020d
 * `HealthCheck`, and a fake `LoginFlow` writing the shared 0600 creds. Every AC lands a NAMED
 * `it(...)` here.
 *
 * Why a real connector (not a fake): c-AC-1/c-AC-2/c-AC-3 assert the connector RULES (copy bundle,
 * idempotent foreign-preserving merge, no-clobber symlinks). Wrapping the genuine 019a
 * `HarnessConnector` base over a `FakeFs` exercises those rules end-to-end through the extension's
 * `HookWiring`/`SkillSync` seams — proving the shell reuses 019a rather than re-implementing them.
 */

import { describe, expect, it } from "vitest";

import {
	type ConnectorFs,
	createFakeFs,
	type FakeFs,
	HarnessConnector,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	type SkillLinkTarget,
} from "../../src/connectors/index.js";
import {
	createFakeDashboardDataSource,
	type DashboardData,
	renderDashboard,
} from "../../src/dashboard/index.js";
import {
	createHealthCheck,
	type HealthProbes,
	type ProbeOutcome,
} from "../../src/notifications/index.js";
import {
	activate,
	connectorHookWiring,
	connectorSkillSync,
	createFakeExtensionHost,
	createFakeLoginFlow,
	dashboardWebviewRenderer,
	EXTENSION_COMMANDS,
	type ExtensionDeps,
	healthSourceFromCheck,
	paintStatusBar,
	renderDashboardHtml,
} from "../../harnesses/cursor/extension/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// A real Cursor connector subclass (mirrors ClaudeCodeConnector) for the c-AC-1..3 rules.
// ─────────────────────────────────────────────────────────────────────────────

/** The Cursor 1.7+ lifecycle events the extension wires (FR-2). */
const CURSOR_EVENT_MAP: Readonly<Record<string, string>> = {
	"session-start": "sessionStart",
	user_message: "beforeSubmitPrompt",
	"pre-tool-use": "preToolUse",
	post_tool: "postToolUse",
	assistant_message: "afterAgentResponse",
	stop: "stop",
	"session-end": "sessionEnd",
	"graph-on-stop": "stop",
};

const CURSOR_HANDLERS: ReadonlyArray<{ logical: string; file: string; timeout: number }> = [
	{ logical: "session-start", file: "session-start.js", timeout: 10 },
	{ logical: "user_message", file: "capture.js", timeout: 10 },
	{ logical: "pre-tool-use", file: "pre-tool-use.js", timeout: 60 },
	{ logical: "post_tool", file: "capture.js", timeout: 15 },
	{ logical: "assistant_message", file: "capture.js", timeout: 30 },
	{ logical: "stop", file: "capture.js", timeout: 30 },
	{ logical: "session-end", file: "session-end.js", timeout: 60 },
	{ logical: "graph-on-stop", file: "graph-on-stop.js", timeout: 30 },
];

/** A real 019a connector for Cursor — the extension's HookWiring/SkillSync wrap THIS (D-4). */
class CursorTestConnector extends HarnessConnector {
	readonly harness = "cursor";
	constructor(
		fs: ConnectorFs,
		private readonly home: string,
		private readonly bundleSource: string,
		private readonly skillSources: readonly string[],
	) {
		super(fs);
	}
	protected configPath(): string {
		return `${this.home}/.cursor/hooks.json`;
	}
	protected hookHandlers(): readonly HookHandlerEntry[] {
		return CURSOR_HANDLERS.map((h) => ({
			event: CURSOR_EVENT_MAP[h.logical] as string,
			handlerPath: `${this.home}/.cursor/${HONEYCOMB_MARKER}/bundle/${h.file}`,
			sourcePath: `${this.bundleSource}/${h.file}`,
			command: `node "${this.home}/.cursor/${HONEYCOMB_MARKER}/bundle/${h.file}"`,
			timeout: h.timeout,
		}));
	}
	protected skillLinkTargets(): readonly SkillLinkTarget[] {
		const dirs = [`${this.home}/.cursor/skills-cursor`, `${this.home}/project/.cursor/skills`];
		return dirs.flatMap((dir) => this.skillSources.map((source) => ({ dir, source })));
	}
	protected eventNameMap(): Readonly<Record<string, string>> {
		return CURSOR_EVENT_MAP;
	}
	protected configRoot(): string {
		return `${this.home}/.cursor`;
	}
}

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/cursor/bundle";
const SKILLS = ["/repo/.cursor/skills/cursor-ide-stinger"];

/** Seed the FakeFs with the bundle source files so the connector can copy them (c-AC-1). */
function bundleSeed(): Record<string, string> {
	const seed: Record<string, string> = {};
	for (const h of CURSOR_HANDLERS) seed[`${BUNDLE}/${h.file}`] = `// ${h.file}\n`;
	return seed;
}

/** A health check whose probes return canned D1–D5 outcomes (one failing). */
function fakeHealth(outcomes: Record<"D1" | "D2" | "D3" | "D4" | "D5", ProbeOutcome>) {
	const probes: HealthProbes = {
		async probeCli(): Promise<ProbeOutcome> {
			return outcomes.D1;
		},
		async probeDaemon(): Promise<ProbeOutcome> {
			return outcomes.D2;
		},
		async probeCursorAgent(): Promise<ProbeOutcome> {
			return outcomes.D3;
		},
		async probeCursorLogin(): Promise<ProbeOutcome> {
			return outcomes.D4;
		},
		async probeHooksWired(): Promise<ProbeOutcome> {
			return outcomes.D5;
		},
	};
	const autoWiring = { async wire(): Promise<boolean> {
		return false;
	}, async unwire(): Promise<void> {} };
	return createHealthCheck({ probes, autoWiring });
}

/** Build the extension deps over a connector + fakes. Returns the deps + the underlying fs/connector. */
function buildDeps(
	overrides: { fs?: FakeFs; down?: boolean; data?: DashboardData; loginPath?: string; verifyUrl?: string } = {},
): { deps: ExtensionDeps; fs: FakeFs; connector: CursorTestConnector } {
	const fs = overrides.fs ?? createFakeFs({ files: bundleSeed() });
	const connector = new CursorTestConnector(fs, HOME, BUNDLE, SKILLS);
	const source = createFakeDashboardDataSource({ down: overrides.down ?? false, data: overrides.data });
	const deps: ExtensionDeps = {
		hooks: connectorHookWiring(connector),
		skills: connectorSkillSync(connector),
		dashboard: dashboardWebviewRenderer(source),
		health: healthSourceFromCheck(
			fakeHealth({
				D1: { ok: true, detail: "0.1.0" },
				D2: { ok: true },
				D3: { ok: true },
				D4: { ok: false, detail: "logged out" },
				D5: { ok: true },
			}),
		),
		login: createFakeLoginFlow({
			credentialsPath: overrides.loginPath ?? `${HOME}/.honeycomb/credentials.json`,
			...(overrides.verifyUrl !== undefined ? { verificationUrl: overrides.verifyUrl } : {}),
		}),
	};
	return { deps, fs, connector };
}

/** A populated dashboard data the webview-embed assertion paints. */
function fullData(): DashboardData {
	return {
		kpis: { memoryCount: 12, sessionCount: 4, estimatedSavings: 0 },
		sessions: { sessions: [{ sessionId: "s1", project: "/p", startedAt: "2026-06-18", eventCount: 0, status: "captured" }] },
		settings: { orgId: "org_1", orgName: "Acme", workspace: "default", settings: { embeddings: "on" } },
		graph: { built: true, nodes: [{ id: "n1", label: "f", kind: "function" }], edges: [] },
		rules: { rules: [{ id: "r1", title: "No em dashes", active: true }] },
		skillSync: { skills: [{ name: "cursor-ide-stinger", scope: "org", syncState: "pulled" }] },
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-1 — Wire/Refresh copies the bundle + idempotent hooks.json merge
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-020c c-AC-1 Wire/Refresh Hooks copies the bundle + idempotently merges hooks.json", () => {
	it("c-AC-1 wiring copies harnesses/cursor/bundle handlers into ~/.cursor/honeycomb/bundle and writes hooks.json", async () => {
		const { deps, fs } = buildDeps();
		const host = createFakeExtensionHost();
		await activate(host, deps);

		// The wireHooks command is registered (FR-1); run it.
		const handler = host.commands.get(EXTENSION_COMMANDS.wireHooks);
		expect(handler).toBeDefined();
		await handler?.();

		// Bundle handlers were copied into ~/.cursor/honeycomb/bundle/ (c-AC-1).
		expect(fs.files.has(`${HOME}/.cursor/${HONEYCOMB_MARKER}/bundle/session-start.js`)).toBe(true);
		expect(fs.files.has(`${HOME}/.cursor/${HONEYCOMB_MARKER}/bundle/capture.js`)).toBe(true);
		// hooks.json was written with the wired Cursor lifecycle events.
		const config = fs.files.get(`${HOME}/.cursor/hooks.json`);
		expect(config).toBeDefined();
		const parsed = JSON.parse(config as string) as { hooks: Record<string, unknown> };
		for (const event of ["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "afterAgentResponse", "stop", "sessionEnd"]) {
			expect(Object.keys(parsed.hooks)).toContain(event);
		}
	});

	it("c-AC-1 a second wire is idempotent — the hooks.json is not rewritten (fingerprint stable)", async () => {
		const { deps, fs } = buildDeps();
		// First wire writes the config.
		const first = await deps.hooks.wire();
		expect(first.wroteConfig).toBe(true);
		const writesAfterFirst = fs.writes.filter((p) => p.endsWith("hooks.json")).length;
		// Second wire over the unchanged config is a no-op (writeJsonIfChanged → false).
		const second = await deps.hooks.wire();
		expect(second.wroteConfig).toBe(false);
		const writesAfterSecond = fs.writes.filter((p) => p.endsWith("hooks.json")).length;
		expect(writesAfterSecond).toBe(writesAfterFirst);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-2 — skill sync symlinks without clobbering existing entries
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-020c c-AC-2 skill sync symlinks org/team skills without clobbering existing entries", () => {
	it("c-AC-2 sync creates skill symlinks into ~/.cursor/skills-cursor and <project>/.cursor/skills", async () => {
		const { deps } = buildDeps();
		const links = await deps.skills.sync();
		expect(links).toContain(`${HOME}/.cursor/skills-cursor/cursor-ide-stinger`);
		expect(links).toContain(`${HOME}/project/.cursor/skills/cursor-ide-stinger`);
	});

	it("c-AC-2 a foreign entry already at the link path is NOT clobbered", async () => {
		// Seed a FOREIGN symlink at one target path (points somewhere else).
		const fs = createFakeFs({
			files: bundleSeed(),
			links: { [`${HOME}/.cursor/skills-cursor/cursor-ide-stinger`]: "/some/foreign/skill" },
		});
		const { deps } = buildDeps({ fs });
		const links = await deps.skills.sync();
		// The foreign symlink target is preserved (never clobbered, c-AC-2)…
		expect(fs.links.get(`${HOME}/.cursor/skills-cursor/cursor-ide-stinger`)).toBe("/some/foreign/skill");
		// …and our link is NOT among those reported created for that clobbered path.
		expect(links).not.toContain(`${HOME}/.cursor/skills-cursor/cursor-ide-stinger`);
		// The OTHER (project) target is still linked to OUR source.
		expect(fs.links.get(`${HOME}/project/.cursor/skills/cursor-ide-stinger`)).toBe(SKILLS[0]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-3 — foreign hooks preserved (only Honeycomb entries added/updated)
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-020c c-AC-3 Wire/Refresh preserves foreign hooks (only Honeycomb entries change)", () => {
	it("c-AC-3 a pre-existing foreign hook entry survives wiring + a re-wire", async () => {
		// Seed hooks.json with a FOREIGN entry (no honeycomb marker / sentinel).
		const foreignConfig = {
			hooks: {
				sessionStart: [{ hooks: [{ type: "command", command: "node /third-party/foreign.js" }] }],
			},
		};
		const fs = createFakeFs({
			files: { ...bundleSeed(), [`${HOME}/.cursor/hooks.json`]: `${JSON.stringify(foreignConfig, null, 2)}\n` },
		});
		const { deps } = buildDeps({ fs });
		await deps.hooks.wire();
		const config = JSON.parse(fs.files.get(`${HOME}/.cursor/hooks.json`) as string) as {
			hooks: Record<string, { hooks: { command: string }[] }[]>;
		};
		// The foreign entry is still present (preserved, c-AC-3).
		const sessionStartCommands = config.hooks.sessionStart.flatMap((b) => b.hooks.map((h) => h.command));
		expect(sessionStartCommands).toContain("node /third-party/foreign.js");
		// Honeycomb's own entry was added alongside it (only HC entries added/updated).
		expect(sessionStartCommands.some((c) => c.includes(`${HONEYCOMB_MARKER}/bundle/`))).toBe(true);

		// A re-wire is idempotent AND still preserves the foreign entry (no duplication).
		await deps.hooks.wire();
		const config2 = JSON.parse(fs.files.get(`${HOME}/.cursor/hooks.json`) as string) as {
			hooks: Record<string, { hooks: { command: string }[] }[]>;
		};
		const cmds2 = config2.hooks.sessionStart.flatMap((b) => b.hooks.map((h) => h.command));
		expect(cmds2.filter((c) => c === "node /third-party/foreign.js")).toHaveLength(1);
		expect(cmds2.filter((c) => c.includes(`${HONEYCOMB_MARKER}/bundle/`))).toHaveLength(1);
	});

	it("c-AC-3 unwire strips ONLY Honeycomb hooks, leaving the foreign entry", async () => {
		const foreignConfig = {
			hooks: { sessionStart: [{ hooks: [{ type: "command", command: "node /third-party/foreign.js" }] }] },
		};
		const fs = createFakeFs({
			files: { ...bundleSeed(), [`${HOME}/.cursor/hooks.json`]: `${JSON.stringify(foreignConfig, null, 2)}\n` },
		});
		const { deps } = buildDeps({ fs });
		await deps.hooks.wire();
		await deps.hooks.unwire();
		const config = JSON.parse(fs.files.get(`${HOME}/.cursor/hooks.json`) as string) as {
			hooks: Record<string, { hooks: { command: string }[] }[]>;
		};
		const cmds = config.hooks.sessionStart.flatMap((b) => b.hooks.map((h) => h.command));
		expect(cmds).toContain("node /third-party/foreign.js");
		expect(cmds.some((c) => c.includes(`${HONEYCOMB_MARKER}/bundle/`))).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-4 — D1–D5 status bar flags a failing dimension
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-020c c-AC-4 the status bar renders D1–D5 and visibly flags a failing dimension", () => {
	it("c-AC-4 activation paints D1–D5 into the status bar with the failing dimension flagged", async () => {
		const { deps } = buildDeps(); // D4 is failing in the default health
		const host = createFakeExtensionHost();
		await activate(host, deps);

		// The status bar was shown with a glyph per dimension (FR-4).
		expect(host.statusBar.shown).toBe(true);
		expect(host.statusBar.text).toContain("Honeycomb");
		// Five glyphs, with exactly one failing (D4) → one ✗.
		expect((host.statusBar.text.match(/✓/g) ?? []).length).toBe(4);
		expect((host.statusBar.text.match(/✗/g) ?? []).length).toBe(1);
		// The tooltip flags the failing dimension visibly.
		expect(host.statusBar.tooltip).toContain("FAILING");
		expect(host.statusBar.tooltip).toContain("D4");
	});

	it("c-AC-4 paintStatusBar reports hasFailure when any dimension fails", () => {
		const allOk = paintStatusBar([
			{ id: "D1", label: "cli", ok: true },
			{ id: "D2", label: "daemon", ok: true },
		]);
		expect(allOk.hasFailure).toBe(false);
		const oneFail = paintStatusBar([
			{ id: "D1", label: "cli", ok: true },
			{ id: "D5", label: "hooks", ok: false, detail: "stale" },
		]);
		expect(oneFail.hasFailure).toBe(true);
		expect(oneFail.tooltip).toContain("stale");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-5 — login writes the shared ~/.honeycomb/credentials.json at 0600
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-020c c-AC-5 no-terminal login writes the shared credentials.json at mode 0600", () => {
	it("c-AC-5 the login command writes ~/.honeycomb/credentials.json at 0o600 and opens the device URL", async () => {
		const loginPath = `${HOME}/.honeycomb/credentials.json`;
		const { deps } = buildDeps({ loginPath, verifyUrl: "https://honeycomb.example/device?code=ABCD" });
		const host = createFakeExtensionHost();
		await activate(host, deps);

		const handler = host.commands.get(EXTENSION_COMMANDS.login);
		expect(handler).toBeDefined();
		await handler?.();

		// The login flow wrote the SHARED credentials path at mode 0600 (c-AC-5).
		const fakeLogin = deps.login as ReturnType<typeof createFakeLoginFlow>;
		const write = fakeLogin.writes.get(loginPath);
		expect(write).toBeDefined();
		expect(write?.mode).toBe(0o600);
		// The browser device URL was opened externally (no terminal).
		expect(host.openedUrls).toContain("https://honeycomb.example/device?code=ABCD");
	});

	it("c-AC-5 api-key login also lands the shared creds at 0600 (no browser URL opened)", async () => {
		const loginPath = `${HOME}/.honeycomb/credentials.json`;
		const { deps } = buildDeps({ loginPath });
		const host = createFakeExtensionHost();
		await activate(host, { ...deps, loginMode: "api-key" });
		await host.commands.get(EXTENSION_COMMANDS.login)?.();

		const fakeLogin = deps.login as ReturnType<typeof createFakeLoginFlow>;
		expect(fakeLogin.attempts).toContain("api-key");
		expect(fakeLogin.writes.get(loginPath)?.mode).toBe(0o600);
		// No device URL → nothing opened externally.
		expect(host.openedUrls).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-6 + b-AC-5 — the webview embeds the SAME 020b views as the daemon dashboard
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-020c c-AC-6 / b-AC-5 the dashboard webview embeds the SAME views as the daemon dashboard", () => {
	it("c-AC-6 opening the dashboard renders the six 020b views into the webview HTML", async () => {
		const { deps } = buildDeps({ data: fullData() });
		const host = createFakeExtensionHost();
		await activate(host, deps);
		await host.commands.get(EXTENSION_COMMANDS.openDashboard)?.();

		const html = host.webviewHtml;
		expect(html).toBeTruthy();
		// Every canonical 020b view title appears in the embedded webview (FR-6 / c-AC-6).
		for (const title of ["KPIs", "Sessions", "Settings", "Codebase graph", "Rules", "Skill-sync"]) {
			expect(html).toContain(title);
		}
		expect(html).toContain('data-connectivity="reachable"');
	});

	it("b-AC-5 the webview HTML is derived from the SAME renderDashboard ViewBlock tree (one impl)", async () => {
		// THE EMBED-EQUIVALENCE ASSERTION: the webview renderer calls the SAME 020b `renderDashboard`
		// the daemon-served dashboard uses; serializing its output is the ONLY thing the webview adds.
		const data = fullData();
		const source = createFakeDashboardDataSource({ data });
		// The daemon-dashboard render (canonical 020b output).
		const canonical = await renderDashboard(source);
		// The webview renderer over the SAME source.
		const webviewRenderer = dashboardWebviewRenderer(createFakeDashboardDataSource({ data }));
		const webviewHtml = await webviewRenderer.renderHtml();
		// The webview HTML is EXACTLY the serialization of the canonical ViewBlock tree — proving the
		// webview embeds 020b's views verbatim (no duplicate view code, D-6 / b-AC-5 / c-AC-6).
		expect(webviewHtml).toBe(renderDashboardHtml(canonical));
		// And it carries each canonical view's title (the embed is the real view tree, not a stub).
		for (const view of canonical.views) {
			if (view.title !== undefined) expect(webviewHtml).toContain(view.title);
		}
	});

	it("FR-9 a daemon-down webview shows the connectivity banner ALONE (never a hang/blank)", async () => {
		const { deps } = buildDeps({ down: true });
		const host = createFakeExtensionHost();
		await activate(host, deps);
		await host.commands.get(EXTENSION_COMMANDS.openDashboard)?.();
		const html = host.webviewHtml;
		expect(html).toContain('data-connectivity="unreachable"');
		expect(html).toContain("Daemon unreachable");
		// The six views are NOT painted when the daemon is down (the banner is alone).
		expect(html).not.toContain("KPIs");
	});
});
