/**
 * PRD-039a a-AC-3 (production wiring, end-to-end) — the LIVE `installed` flag reflects REAL on-disk
 * wiring, not the starved empty set the QA flagged.
 *
 * The 039a endpoint + the `installedHarnesses` seam were plumbed and unit-proven, but PRODUCTION threaded
 * an EMPTY set, so the live `GET /api/diagnostics/harnesses` reported `installed: false` for ALL SIX even
 * when harnesses were genuinely wired. This suite closes that gap: it drives `assembleDaemon` — the SAME
 * composition root the production daemon runs — with the set the production path computes from the cheap
 * disk detector, against a FIXTURE home built under a temp dir (never the real `~`), and proves the live
 * endpoint reports `installed: true` for the wired harnesses and `false` for the rest.
 *
 * The chain proven: `detectInstalledHarnesses(fixtureHome)` → the `installedHarnesses` assembly option →
 * `assembleDaemon` → the `mountHarnessApi` seam → `GET /api/diagnostics/harnesses`. `installed` is shown
 * to be INDEPENDENT of activity (a wired harness with zero captured turns still reads installed; an
 * unwired harness with N turns still reads not-installed).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleDaemon } from "../../../../src/daemon/runtime/assemble.js";
import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { detectInstalledHarnesses } from "../../../../src/daemon/runtime/dashboard/harness-detect.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { StorageClient } from "../../../../src/daemon/storage/client.js";
import type { QueryResult } from "../../../../src/daemon/storage/result.js";
import { fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

interface HarnessStatus {
	readonly name: string;
	readonly installed: boolean;
	readonly active: boolean;
	readonly turnsCaptured: number;
}

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE };
}

/**
 * A fake `StorageClient` whose `query` answers the harness-activity GROUP BY with two seeded
 * harnesses (cursor, claude-code) so we can prove `installed` is INDEPENDENT of activity. Any other
 * query (the `/health` SELECT 1) returns an ok empty result.
 */
function fakeStorageWithActivity(): StorageClient {
	const ok: QueryResult = { kind: "ok", rows: [{ "?column?": 1 }], durationMs: 1 };
	return {
		get endpoint() {
			return "https://example.invalid";
		},
		async connect() {
			return ok;
		},
		async query(sql: string): Promise<QueryResult> {
			if (/GROUP BY\s+agent/i.test(sql) && /FROM\s+"sessions"/i.test(sql)) {
				return {
					kind: "ok",
					durationMs: 1,
					rows: [
						{ agent: "cursor", n: 312, last: "2026-06-22T10:00:00.000Z" },
						{ agent: "claude-code", n: 7, last: "2026-06-21T08:30:00.000Z" },
					],
				};
			}
			return { kind: "ok", rows: [], durationMs: 1 };
		},
	} as unknown as StorageClient;
}

let home: string;
let runtimeDir: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "honeycomb-wire-home-"));
	runtimeDir = mkdtempSync(join(tmpdir(), "honeycomb-wire-rt-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(runtimeDir, { recursive: true, force: true });
});

/** Create a marker file under the fixture home. */
function touchFile(...segments: string[]): void {
	const full = join(home, ...segments);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, "");
}

/** Create a marker directory under the fixture home. */
function touchDir(...segments: string[]): void {
	mkdirSync(join(home, ...segments), { recursive: true });
}

/**
 * Assemble the daemon EXACTLY as production does (the composition root), feeding the installed set the
 * production path computes from the disk detector over the fixture home. Returns the live endpoint's
 * six statuses. A fake storage + provider keeps it hermetic (no live DeepLake); a temp `runtimeDir`
 * keeps the PID/lock guard off the real machine.
 */
async function liveHarnesses(): Promise<HarnessStatus[]> {
	const installedHarnesses = detectInstalledHarnesses(home, home);
	const { daemon } = assembleDaemon({
		config: cfg(),
		storage: fakeStorageWithActivity(),
		provider: stubProvider(fakeCredentialRecord()),
		logger: createRequestLogger({ silent: true }),
		runtimeDir,
		installedHarnesses,
	});
	const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
	expect(res.status).toBe(200);
	const json = (await res.json()) as { harnesses: HarnessStatus[] };
	return json.harnesses;
}

describe("PRD-039a a-AC-3 (production wiring): live `installed` reflects real on-disk markers", () => {
	it("a fixture home with NO markers → the live endpoint reports installed:false for all six", async () => {
		const harnesses = await liveHarnesses();
		expect(harnesses).toHaveLength(6);
		for (const h of harnesses) expect(h.installed).toBe(false);
	});

	it("wiring claude-code + cursor + codex on disk → those three read installed:true live, the rest false", async () => {
		touchFile(".claude", "settings.json"); // claude-code wired
		touchFile(".cursor", "hooks.json"); // cursor wired
		touchDir(".codex", "plugins", "honeycomb"); // codex wired (honeycomb connector pluginRoot)
		const harnesses = await liveHarnesses();
		const by = new Map(harnesses.map((h) => [h.name, h]));
		expect(by.get("claude-code")?.installed).toBe(true);
		expect(by.get("cursor")?.installed).toBe(true);
		expect(by.get("codex")?.installed).toBe(true);
		// The three unwired harnesses read installed:false on the LIVE endpoint.
		expect(by.get("hermes")?.installed).toBe(false);
		expect(by.get("pi")?.installed).toBe(false);
		expect(by.get("openclaw")?.installed).toBe(false);
	});

	it("`installed` is INDEPENDENT of activity: wired+0-turns reads installed; unwired+N-turns does not", async () => {
		// Wire codex (which has ZERO captured turns in the seeded activity). Leave claude-code UNWIRED
		// on disk even though the seeded activity gives it 7 turns.
		touchFile(".codex", "hooks.json");
		const harnesses = await liveHarnesses();
		const by = new Map(harnesses.map((h) => [h.name, h]));
		// codex: freshly wired, never run → installed:true, active:false.
		expect(by.get("codex")?.installed).toBe(true);
		expect(by.get("codex")?.active).toBe(false);
		expect(by.get("codex")?.turnsCaptured).toBe(0);
		// claude-code: NOT wired on disk, yet has 7 captured turns → installed:false, active:true.
		expect(by.get("claude-code")?.installed).toBe(false);
		expect(by.get("claude-code")?.active).toBe(true);
		expect(by.get("claude-code")?.turnsCaptured).toBe(7);
	});

	it("ALL SIX wired on disk → the live endpoint reports installed:true for every harness", async () => {
		touchFile(".claude", "settings.json");
		touchFile(".cursor", "hooks.json");
		touchFile(".codex", "hooks.json");
		touchDir(".hermes", "honeycomb");
		touchDir(".pi", "honeycomb");
		touchDir(".openclaw", "honeycomb");
		const harnesses = await liveHarnesses();
		expect(harnesses).toHaveLength(6);
		for (const h of harnesses) expect(h.installed).toBe(true);
	});
});
