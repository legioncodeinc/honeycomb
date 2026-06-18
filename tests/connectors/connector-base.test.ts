/**
 * PRD-019a — the shared connector base (each AC-named).
 *
 * Verification posture: every test drives a real {@link ClaudeCodeConnector} (the reference
 * concrete) over an in-memory {@link createFakeFs}. NO real `~/.claude`, no temp dir, no daemon.
 * The fake records every write so the idempotency assertion can prove a no-change re-install
 * touches NO file (a-AC-3 — the harness hook-trust fingerprint stays put).
 *
 * a-AC-1     install preserves a third-party hook already in the config.
 * a-AC-2     uninstall removes ONLY Honeycomb's entries + cleanly unlinks an emptied config.
 * a-AC-3     re-install with no change writes NO config file (fingerprint unchanged).
 * a-AC-4     `honeycomb setup` with no target wires BOTH detected harnesses.
 * a-AC-6     skill linking preserves a foreign entry already in the skill dir.
 * index AC-1 setup wires (config + handlers + skill links); uninstall reverses only Honeycomb.
 */

import { describe, expect, it } from "vitest";

import {
	ClaudeCodeConnector,
	type ConnectorFs,
	type ConnectorRegistry,
	createFakeFs,
	type FakeFs,
	HarnessConnector,
	runConnectorCommand,
} from "../../src/connectors/index.js";

const HOME = "/home/dev";
const SETTINGS = `${HOME}/.claude/settings.json`;
const SKILLS_DIR = `${HOME}/.claude/skills`;
const BUNDLE = "/repo/harnesses/claude-code/bundle";

/** Build a Claude Code connector over a fake fs seeded so its bundle sources + home exist. */
function connector(fs: FakeFs, opts: { skillSources?: readonly string[] } = {}): ClaudeCodeConnector {
	return new ClaudeCodeConnector(fs, {
		home: HOME,
		bundleSource: BUNDLE,
		skillSources: opts.skillSources ?? [],
	});
}

/** A fake fs with the compiled bundle handler files + the `~/.claude` install-proof present. */
function seedFs(over: { files?: Record<string, string>; links?: Record<string, string> } = {}): FakeFs {
	return createFakeFs({
		files: {
			[`${HOME}/.claude`]: "", // make `~/.claude` "exist" for detection (configRoot probe)
			[`${BUNDLE}/session-start.js`]: "// session-start handler",
			[`${BUNDLE}/capture.js`]: "// capture handler",
			[`${BUNDLE}/pre-tool-use.js`]: "// pre-tool-use handler",
			[`${BUNDLE}/session-end.js`]: "// session-end handler",
			...over.files,
		},
		links: over.links,
	});
}

/** The parsed config's hook entries flattened to their command strings, per event. */
function commandsByEvent(text: string): Record<string, string[]> {
	const parsed = JSON.parse(text) as { hooks?: Record<string, { hooks: { command: string }[] }[]> };
	const out: Record<string, string[]> = {};
	for (const [event, blocks] of Object.entries(parsed.hooks ?? {})) {
		out[event] = blocks.flatMap((b) => b.hooks.map((h) => h.command));
	}
	return out;
}

describe("PRD-019a connector base — install/uninstall/idempotency/foreign-preserve", () => {
	it("a-AC-1 install preserves a third-party hook already in the config", async () => {
		const foreign = "node /opt/other-tool/hook.js";
		const fs = seedFs({
			files: {
				[SETTINGS]: `${JSON.stringify(
					{ hooks: { SessionStart: [{ hooks: [{ type: "command", command: foreign }] }] } },
					null,
					2,
				)}\n`,
			},
		});

		const result = await connector(fs).install();

		expect(result.wroteConfig).toBe(true);
		const after = commandsByEvent(fs.files.get(SETTINGS) as string);
		// The foreign hook survives...
		expect(after.SessionStart).toContain(foreign);
		// ...alongside Honeycomb's freshly-appended session-start handler.
		expect(after.SessionStart.some((c) => c.includes("session-start.js"))).toBe(true);
		// And a Honeycomb-only event (PreToolUse) carries no foreign entry.
		expect(after.PreToolUse.every((c) => c.includes("pre-tool-use.js"))).toBe(true);
	});

	it("a-AC-2 uninstall removes ONLY Honeycomb's entries and unlinks an emptied config", async () => {
		// Config that holds ONLY Honeycomb (after install) → uninstall must unlink the file.
		const fs = seedFs();
		await connector(fs).install();
		expect(fs.files.has(SETTINGS)).toBe(true);

		const result = await connector(fs).uninstall();

		expect(result.wroteConfig).toBe(true);
		// FR-6: the config held nothing but Honeycomb → the file is cleanly UNLINKED.
		expect(fs.files.has(SETTINGS)).toBe(false);
		// The written handler files are removed too.
		expect(fs.files.has(`${HOME}/.claude/plugins/honeycomb/bundle/session-start.js`)).toBe(false);
	});

	it("a-AC-2 uninstall preserves a foreign hook and keeps the still-populated config", async () => {
		const foreign = "node /opt/other-tool/hook.js";
		const fs = seedFs({
			files: {
				[SETTINGS]: `${JSON.stringify(
					{ hooks: { SessionStart: [{ hooks: [{ type: "command", command: foreign }] }] } },
					null,
					2,
				)}\n`,
			},
		});
		await connector(fs).install();

		await connector(fs).uninstall();

		// The config still EXISTS (foreign hook remains) — never unlinked while populated.
		expect(fs.files.has(SETTINGS)).toBe(true);
		const after = commandsByEvent(fs.files.get(SETTINGS) as string);
		expect(after.SessionStart).toEqual([foreign]);
		// No Honeycomb event keys survive.
		expect(after.PreToolUse).toBeUndefined();
		expect(after.SessionEnd).toBeUndefined();
	});

	it("a-AC-3 re-install with no change writes NO config file (fingerprint unchanged)", async () => {
		const fs = seedFs();
		await connector(fs).install();
		const writesAfterFirst = fs.writes.length;
		const fingerprint = fs.files.get(SETTINGS) as string;

		const second = await connector(fs).install();

		// The idempotency floor: a no-change re-run does NOT write the config.
		expect(second.wroteConfig).toBe(false);
		expect(fs.writes.filter((p) => p === SETTINGS).length).toBe(
			fs.writes.slice(0, writesAfterFirst).filter((p) => p === SETTINGS).length,
		);
		// The serialized config is byte-identical → the harness hook-trust fingerprint is unchanged.
		expect(fs.files.get(SETTINGS)).toBe(fingerprint);
	});

	it("a-AC-3 the second install records zero NEW config writes on the fake fs", async () => {
		const fs = seedFs();
		await connector(fs).install();
		const before = [...fs.writes];

		await connector(fs).install();

		// Every path the second install touched must already have been written by the first
		// (no-change → no new write). The settings path specifically is unchanged.
		const newWrites = fs.writes.slice(before.length);
		expect(newWrites).not.toContain(SETTINGS);
	});

	it("a-AC-4 `honeycomb setup` with no target wires BOTH detected harnesses", async () => {
		// Two distinct detected harnesses, each a ClaudeCodeConnector pointed at its own home.
		const homeA = "/home/dev";
		const homeB = "/home/dev2";
		const fs = createFakeFs({
			files: {
				[`${homeA}/.claude`]: "",
				[`${homeB}/.claude`]: "",
				[`${BUNDLE}/session-start.js`]: "x",
				[`${BUNDLE}/capture.js`]: "x",
				[`${BUNDLE}/pre-tool-use.js`]: "x",
				[`${BUNDLE}/session-end.js`]: "x",
			},
		});
		const registry: ConnectorRegistry = {
			known: () => ["harness-a", "harness-b"],
			build: (slug: string, seam: ConnectorFs): HarnessConnector | undefined => {
				if (slug === "harness-a") return new ClaudeCodeConnector(seam, { home: homeA, bundleSource: BUNDLE });
				if (slug === "harness-b") return new ClaudeCodeConnector(seam, { home: homeB, bundleSource: BUNDLE });
				return undefined;
			},
		};

		const result = await runConnectorCommand({ verb: "setup" }, { fs, registry, out: () => {} });

		expect(result.exitCode).toBe(0);
		// BOTH detected harnesses were wired.
		expect(result.results.map((r) => r.harness)).toEqual(["claude-code", "claude-code"]);
		expect(result.results.every((r) => r.wroteConfig)).toBe(true);
		expect(fs.files.has(`${homeA}/.claude/settings.json`)).toBe(true);
		expect(fs.files.has(`${homeB}/.claude/settings.json`)).toBe(true);
	});

	it("a-AC-4 setup wires NOTHING when no harness is detected", async () => {
		const fs = createFakeFs(); // empty — no `~/.claude` anywhere
		const registry: ConnectorRegistry = {
			known: () => ["harness-a"],
			build: (_slug, seam) => new ClaudeCodeConnector(seam, { home: "/nope", bundleSource: BUNDLE }),
		};

		const result = await runConnectorCommand({ verb: "setup" }, { fs, registry, out: () => {} });

		expect(result.results).toEqual([]);
		expect(fs.writes).toEqual([]);
	});

	it("a-AC-6 skill linking preserves a foreign entry already in the skill dir", async () => {
		const orgSkill = "/repo/skills/org-skill";
		const foreignLinkPath = `${SKILLS_DIR}/foreign-skill`;
		const fs = seedFs({
			// A pre-existing FOREIGN symlink in the skill dir → must be preserved.
			links: { [foreignLinkPath]: "/somewhere/foreign-target" },
		});

		const result = await connector(fs, { skillSources: [orgSkill] }).install();

		// Honeycomb's org skill was symlinked in...
		const ourLink = `${SKILLS_DIR}/org-skill`;
		expect(fs.links.get(ourLink)).toBe(orgSkill);
		expect(result.skillLinks).toContain(ourLink);
		// ...and the foreign link is UNTOUCHED.
		expect(fs.links.get(foreignLinkPath)).toBe("/somewhere/foreign-target");
	});

	it("a-AC-6 skill linking never clobbers a real foreign dir at the link path", async () => {
		const orgSkill = "/repo/skills/org-skill";
		const collision = `${SKILLS_DIR}/org-skill`;
		const fs = seedFs({
			files: { [collision]: "a real foreign directory marker" },
		});

		await connector(fs, { skillSources: [orgSkill] }).install();

		// A real file/dir already occupies the link path → never clobbered, no symlink created.
		expect(fs.links.has(collision)).toBe(false);
		expect(fs.files.get(collision)).toBe("a real foreign directory marker");
	});

	it("a-AC-6 uninstall removes ONLY Honeycomb's skill link, leaving the foreign one", async () => {
		const orgSkill = "/repo/skills/org-skill";
		const foreignLinkPath = `${SKILLS_DIR}/foreign-skill`;
		const fs = seedFs({ links: { [foreignLinkPath]: "/somewhere/foreign-target" } });
		await connector(fs, { skillSources: [orgSkill] }).install();

		await connector(fs, { skillSources: [orgSkill] }).uninstall();

		// Honeycomb's link is gone; the foreign link survives.
		expect(fs.links.has(`${SKILLS_DIR}/org-skill`)).toBe(false);
		expect(fs.links.get(foreignLinkPath)).toBe("/somewhere/foreign-target");
	});

	it("index AC-1 setup wires config + handlers + skill links; uninstall reverses only Honeycomb", async () => {
		const orgSkill = "/repo/skills/org-skill";
		const fs = seedFs();
		const registry: ConnectorRegistry = {
			known: () => ["claude-code"],
			build: (_slug, seam) =>
				new ClaudeCodeConnector(seam, { home: HOME, bundleSource: BUNDLE, skillSources: [orgSkill] }),
		};

		const wired = await runConnectorCommand({ verb: "setup" }, { fs, registry, out: () => {} });

		// Config patched...
		expect(fs.files.has(SETTINGS)).toBe(true);
		// ...handlers written...
		expect(fs.files.has(`${HOME}/.claude/plugins/honeycomb/bundle/session-start.js`)).toBe(true);
		// ...skills linked.
		expect(fs.links.get(`${SKILLS_DIR}/org-skill`)).toBe(orgSkill);
		expect(wired.results).toHaveLength(1);

		const reversed = await runConnectorCommand({ verb: "uninstall" }, { fs, registry, out: () => {} });

		expect(reversed.exitCode).toBe(0);
		// Config (Honeycomb-only) unlinked, handlers removed, skill link removed.
		expect(fs.files.has(SETTINGS)).toBe(false);
		expect(fs.files.has(`${HOME}/.claude/plugins/honeycomb/bundle/session-start.js`)).toBe(false);
		expect(fs.links.has(`${SKILLS_DIR}/org-skill`)).toBe(false);
	});
});
