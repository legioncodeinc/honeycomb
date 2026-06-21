/**
 * PRD-033b — the `honeycomb asset` thin-client verb (b-AC-1..6, CLI surface).
 *
 * Each case drives an injected fake sync API + a temp-dir registry + a fixed device + a temp
 * artifact tree — no socket, no live daemon, no real `~`. Proves:
 *   - register lands Local + style + id, ZERO publish calls (b-AC-1);
 *   - promote → publish at the right scope; demote → tombstone (b-AC-2/3/4/5);
 *   - the dispatcher routes `asset` to the handler (storage class, bespoke /api/assets);
 *   - no secret/token is printed.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AssetSyncApi,
	type PublishRequest,
	type PublishResponse,
	type PullRequest,
	type PullResponse,
	type TombstoneRequest,
	type TombstoneResponse,
} from "../../src/daemon/runtime/assets/index.js";
import { createAssetRegistryStore, type DeviceRecord } from "../../src/daemon/runtime/assets/index.js";
import { type AssetCliDeps, createFakeDaemonClient, createDispatcher, parseAssetCliArgs, runAssetVerb } from "../../src/commands/index.js";

// ── Fakes + fixtures ─────────────────────────────────────────────────────────

interface FakeSync extends AssetSyncApi {
	readonly publishes: PublishRequest[];
	readonly tombstones: TombstoneRequest[];
}

function createFakeSync(): FakeSync {
	const publishes: PublishRequest[] = [];
	const tombstones: TombstoneRequest[] = [];
	return {
		get publishes() {
			return publishes;
		},
		get tombstones() {
			return tombstones;
		},
		async publish(req: PublishRequest): Promise<PublishResponse> {
			publishes.push(req);
			return { honeycombId: req.honeycombId, version: 1, published: true };
		},
		async tombstone(req: TombstoneRequest): Promise<TombstoneResponse> {
			tombstones.push(req);
			return { honeycombId: req.honeycombId, version: 2, tombstoned: true };
		},
		async pull(_req: PullRequest): Promise<PullResponse> {
			return { assets: [], tableAbsent: false };
		},
	};
}

const DEVICE: DeviceRecord = { device_id: "dev-1", label: "mario-mac", createdAt: "2026-06-21T12:00:00.000Z" };

function withSink(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line: string) => lines.push(line), lines };
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "hc-asset-cli-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Build CLI deps with injected seams: a fake sync, a temp registry dir, a fixed device. */
function cliDeps(sync: FakeSync, over: Partial<AssetCliDeps> = {}): AssetCliDeps {
	const { out } = withSink();
	return {
		daemon: createFakeDaemonClient(),
		sync,
		registry: createAssetRegistryStore(join(tmp, "registry")),
		device: DEVICE,
		org: "acme",
		workspace: "platform",
		author: "mario",
		out,
		...over,
	};
}

/** Write a skill directory with a SKILL.md at `<tmp>/skill` and return its path. */
function makeSkill(): string {
	const dir = join(tmp, "skill");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\n---\nbody\n", "utf-8");
	return dir;
}

// ── parse ────────────────────────────────────────────────────────────────────

describe("PRD-033b — parseAssetCliArgs", () => {
	it("reads subcommand, positionals, and the register flags", () => {
		expect(parseAssetCliArgs(["register", "./s", "--type", "skill", "--harness", "claude_code", "--style", "User"])).toEqual({
			subCommand: "register",
			args: ["./s"],
			type: "skill",
			harness: "claude_code",
			style: "User",
		});
		expect(parseAssetCliArgs(["promote", "hc_x", "Team"])).toEqual({
			subCommand: "promote",
			args: ["hc_x", "Team"],
			type: "",
			harness: "",
			style: "",
		});
		expect(parseAssetCliArgs(["register", "./s", "--harness=codex"]).harness).toBe("codex");
	});
});

// ── b-AC-1 register ───────────────────────────────────────────────────────────

describe("PRD-033b b-AC-1 — register → Local + style + id, ZERO publish", () => {
	it("registers a skill at Local with the chosen style + a honeycomb_id, no DeepLake write", async () => {
		const sync = createFakeSync();
		const lines: string[] = [];
		const deps = cliDeps(sync, { out: (l) => lines.push(l) });
		const res = await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code", "--style", "User"], deps);

		expect(res.exitCode).toBe(0);
		expect(sync.publishes).toHaveLength(0);
		expect(sync.tombstones).toHaveLength(0);

		const stored = deps.registry!.read();
		expect(stored).toHaveLength(1);
		expect(stored[0]!.tier).toBe("Local");
		expect(stored[0]!.style).toBe("User");
		expect(stored[0]!.honeycombId).toMatch(/^hc_[0-9a-f]{32}$/);
		expect(lines.join("\n")).toMatch(/registered skill/);
	});

	it("a missing --harness fails fast (exit 1), no write", async () => {
		const sync = createFakeSync();
		const res = await runAssetVerb(["register", makeSkill(), "--type", "skill"], cliDeps(sync));
		expect(res.exitCode).toBe(1);
		expect(sync.publishes).toHaveLength(0);
	});

	it("an unreadable path fails (exit 1)", async () => {
		const res = await runAssetVerb(["register", join(tmp, "nope"), "--type", "agent", "--harness", "codex"], cliDeps(createFakeSync()));
		expect(res.exitCode).toBe(1);
	});
});

// ── b-AC-2/3/4 promote scope ──────────────────────────────────────────────────

describe("PRD-033b b-AC-2/4 — promote to Team publishes at org+workspace scope", () => {
	it("Local→Team promote publishes with the workspace scope", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;

		const res = await runAssetVerb(["promote", id, "Team"], deps);
		expect(res.exitCode).toBe(0);
		expect(sync.publishes).toHaveLength(1);
		const req = sync.publishes[0]!;
		expect(req.cell.tier).toBe("Team");
		expect(req.scope.org).toBe("acme");
		expect(req.scope.workspace).toBe("platform");
		expect(req.deviceSet).toEqual([]);
		expect(deps.registry!.read()[0]!.tier).toBe("Team");
	});
});

describe("PRD-033b b-AC-3 — promote to Device publishes at author+device_set scope", () => {
	it("Local→Device promote publishes with the author + this device in the set", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;

		await runAssetVerb(["promote", id, "Device"], deps);
		const req = sync.publishes[0]!;
		expect(req.cell.tier).toBe("Device");
		expect(req.scope.author).toBe("mario");
		expect(req.deviceSet).toContain("dev-1");
	});
});

// ── b-AC-5 demotion tombstones ────────────────────────────────────────────────

describe("PRD-033b b-AC-5 — demote tombstones every wider tier left", () => {
	it("Team→Local demote tombstones Team and Device", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;
		await runAssetVerb(["promote", id, "Team"], deps);

		const res = await runAssetVerb(["demote", id, "Local"], deps);
		expect(res.exitCode).toBe(0);
		const tiers = sync.tombstones.map((t) => t.cell.tier).sort();
		expect(tiers).toEqual(["Device", "Team"]);
		expect(deps.registry!.read()[0]!.tier).toBe("Local");
	});
});

// ── b-AC-6 style + illegal + one cell ─────────────────────────────────────────

describe("PRD-033b b-AC-6 — style flip is orthogonal; bad inputs rejected", () => {
	it("style flips the cell with no publish/tombstone", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code", "--style", "Repository"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;

		const res = await runAssetVerb(["style", id, "User"], deps);
		expect(res.exitCode).toBe(0);
		expect(sync.publishes).toHaveLength(0);
		expect(sync.tombstones).toHaveLength(0);
		expect(deps.registry!.read()[0]!.style).toBe("User");
	});

	it("an invalid tier is rejected (exit 1, no write)", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;
		const res = await runAssetVerb(["promote", id, "Galaxy"], deps);
		expect(res.exitCode).toBe(1);
		expect(sync.publishes).toHaveLength(0);
	});

	it("promote/demote/style on an unknown id is rejected (exit 1)", async () => {
		const sync = createFakeSync();
		const res = await runAssetVerb(["promote", "hc_unknown", "Team"], cliDeps(sync));
		expect(res.exitCode).toBe(1);
		expect(sync.publishes).toHaveLength(0);
	});
});

// ── list + device ─────────────────────────────────────────────────────────────

describe("PRD-033b — list + device", () => {
	it("list renders registered artifacts; empty list prints an honest line", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		const empty = withSink();
		await runAssetVerb(["list"], { ...deps, out: empty.out });
		expect(empty.lines.join("\n")).toMatch(/none registered/i);

		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code"], deps);
		const populated = withSink();
		await runAssetVerb(["list"], { ...deps, out: populated.out });
		expect(populated.lines.join("\n")).toMatch(/hc_[0-9a-f]{32}/);
		expect(populated.lines.join("\n")).toMatch(/Local\/Repository/);
	});

	it("device list prints this machine's id + label; device revoke tombstones the device's Device assets", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		// Register + promote to Device so there is a Device-tier artifact addressed to dev-1.
		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;
		await runAssetVerb(["promote", id, "Device"], deps);

		const listed = withSink();
		await runAssetVerb(["device", "list"], { ...deps, out: listed.out });
		expect(listed.lines.join("\n")).toMatch(/dev-1/);
		expect(listed.lines.join("\n")).toMatch(/mario-mac/);

		const revoked = withSink();
		await runAssetVerb(["device", "revoke", "dev-1"], { ...deps, out: revoked.out });
		// The revoke wrote a Device tombstone addressed to dev-1.
		const deviceT = sync.tombstones.find((t) => t.cell.tier === "Device");
		expect(deviceT).toBeDefined();
		expect(deviceT!.deviceSet).toEqual(["dev-1"]);
	});
});

// ── F-3 promote carries the artifact's CURRENT native bytes ───────────────────

import {
	hashArtifact,
	type FileEntry,
} from "../../src/daemon/runtime/assets/index.js";

/** Write an agent file at `<tmp>/agent.md` and return its path. */
function makeAgent(body = "---\nname: helper\n---\nagent body\n"): string {
	const file = join(tmp, "agent.md");
	writeFileSync(file, body, "utf-8");
	return file;
}

describe("PRD-033 F-3 — promote re-reads the CURRENT native bytes (never empty)", () => {
	it("an AGENT promote publishes the file's real content + a matching contentHash", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		const agentPath = makeAgent();
		await runAssetVerb(["register", agentPath, "--type", "agent", "--harness", "codex"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;
		// The register recorded the absolute source path on the entry (F-3).
		expect(deps.registry!.read()[0]!.sourcePath).toBe(agentPath);

		const res = await runAssetVerb(["promote", id, "Team"], deps);
		expect(res.exitCode).toBe(0);
		expect(sync.publishes).toHaveLength(1);
		const req = sync.publishes[0]!;
		// The published native is the file's REAL content — not empty.
		const onDisk = readFileSync(agentPath, "utf-8");
		expect(req.native).toBe(onDisk);
		expect(req.native.length).toBeGreaterThan(0);
		// And the contentHash is hashArtifact of the real bytes (agent = the file's content).
		const leaves: FileEntry[] = [{ relativePath: "AGENT.md", content: onDisk }];
		expect(req.contentHash).toBe(hashArtifact("agent", leaves));
	});

	it("a SKILL promote publishes the SKILL.md's real content + a matching contentHash", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		const skillDir = makeSkill();
		await runAssetVerb(["register", skillDir, "--type", "skill", "--harness", "claude_code"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;
		expect(deps.registry!.read()[0]!.sourcePath).toBe(skillDir);

		await runAssetVerb(["promote", id, "Team"], deps);
		const req = sync.publishes[0]!;
		// The native is the SKILL.md content the install side writes (symmetric round-trip).
		const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
		expect(req.native).toBe(skillMd);
		expect(req.native.length).toBeGreaterThan(0);
	});

	it("editing the artifact AFTER register, THEN promoting, publishes the EDITED bytes + a fresh hash", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		const agentPath = makeAgent("---\nname: helper\n---\noriginal\n");
		await runAssetVerb(["register", agentPath, "--type", "agent", "--harness", "codex"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;
		const registeredHash = deps.registry!.read()[0]!.localHash;

		// Edit on disk AFTER register — promote must re-read the CURRENT bytes, not a stale snapshot.
		const edited = "---\nname: helper\n---\nEDITED CONTENT\n";
		writeFileSync(agentPath, edited, "utf-8");

		await runAssetVerb(["promote", id, "Team"], deps);
		const req = sync.publishes[0]!;
		expect(req.native).toBe(edited);
		expect(req.native).toContain("EDITED CONTENT");
		// The published hash reflects the edit and differs from the register-time hash.
		const freshHash = hashArtifact("agent", [{ relativePath: "AGENT.md", content: edited }]);
		expect(req.contentHash).toBe(freshHash);
		expect(req.contentHash).not.toBe(registeredHash);
	});

	it("promote with a MOVED/missing source fails clearly (exit 1), NO empty publish", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		const agentPath = makeAgent();
		await runAssetVerb(["register", agentPath, "--type", "agent", "--harness", "codex"], deps);
		const id = deps.registry!.read()[0]!.honeycombId;

		// Move the source away — the recorded path is now unreadable.
		rmSync(agentPath, { force: true });

		const lines: string[] = [];
		const res = await runAssetVerb(["promote", id, "Team"], { ...deps, out: (l) => lines.push(l) });
		expect(res.exitCode).toBe(1);
		// CRITICAL: nothing was published (never an empty native blob).
		expect(sync.publishes).toHaveLength(0);
		expect(lines.join("\n")).toMatch(/cannot read the agent/i);
		expect(lines.join("\n")).toMatch(/re-register/i);
		// The registry stays at Local — the failed promote did not move the cell.
		expect(deps.registry!.read()[0]!.tier).toBe("Local");
	});

	it("an entry registered WITHOUT a source path (back-compat) fails clearly on promote, NO empty publish", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		// Simulate a pre-F-3 entry: a registry record with NO sourcePath field.
		deps.registry!.upsert({
			assetType: "agent",
			harness: "codex",
			tier: "Local",
			style: "Repository",
			version: 0,
			honeycombId: "hc_00000000000000000000000000000001",
			lastSyncedHash: "",
			localHash: "abc",
			remoteHash: "",
			author: "mario",
			org: "acme",
			workspace: "platform",
			deviceSet: [],
		});

		const lines: string[] = [];
		const res = await runAssetVerb(
			["promote", "hc_00000000000000000000000000000001", "Team"],
			{ ...deps, out: (l) => lines.push(l) },
		);
		expect(res.exitCode).toBe(1);
		expect(sync.publishes).toHaveLength(0);
		expect(lines.join("\n")).toMatch(/no source path on record/i);
	});
});

// ── routing + no-secret ───────────────────────────────────────────────────────

describe("PRD-033b — dispatcher routing + no secret printed", () => {
	it("the dispatcher routes `asset` to the handler", async () => {
		const dispatcher = createDispatcher();
		const inv = dispatcher.parse(["asset", "list"]);
		expect(inv.verb).toBe("asset");
		const sync = createFakeSync();
		const res = await dispatcher.dispatch(inv, cliDeps(sync));
		expect(res.exitCode).toBe(0);
	});

	it("no asset invocation ever prints a token/secret marker", async () => {
		const sync = createFakeSync();
		const deps = cliDeps(sync);
		const lines: string[] = [];
		const out = (l: string) => lines.push(l);
		await runAssetVerb(["register", makeSkill(), "--type", "skill", "--harness", "claude_code"], { ...deps, out });
		const id = deps.registry!.read()[0]!.honeycombId;
		await runAssetVerb(["promote", id, "Team"], { ...deps, out });
		await runAssetVerb(["demote", id, "Local"], { ...deps, out });
		await runAssetVerb(["device", "list"], { ...deps, out });
		expect(lines.join("\n")).not.toMatch(/token|secret|bearer|authorization|sk-|x-honeycomb/i);
	});
});
