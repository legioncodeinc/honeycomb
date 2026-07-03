/**
 * PRD-039a daemon-side harness telemetry suite — the `mountHarnessApi` attach step.
 *
 * `mountHarnessApi` is the single named seam the daemon assembly calls after `createDaemon(...)` to
 * wire `GET /api/diagnostics/harnesses` onto the already-mounted, protected `/api/diagnostics` group
 * (mirroring `mountDashboardApi`). This suite proves the 039a acceptance criteria end-to-end through
 * `daemon.app.request(...)`:
 *   - a-AC-1: ALL SIX canonical harnesses every call, idle ones present + zeroed (never omitted).
 *   - a-AC-2: `turnsCaptured`/`lastSeen` are the REAL COUNT/MAX over seeded `sessions` GROUP BY agent;
 *     a harness with rows reports the real count + timestamp, one without reports 0 / null. No fabrication.
 *   - a-AC-3: `installed` reflects the injected harness-sync wiring set, independent of activity.
 *   - a-AC-4: the `active` flag is derived (`turnsCaptured > 0`) and returned explicitly.
 *   - a-AC-5: ONE guarded GROUP BY (sqlIdent-built); a storage error fails soft to all six zeroed
 *     (no 500); the response carries NO token/secret.
 *   - 039c: the folded capability descriptor carries Cursor's `agents` and Claude Code's NONE (c-AC-4).
 *
 * Plus the derive-or-assert invariant (a-OQ-3): the canonical six EQUAL the shims `src/hooks` ships,
 * so a seventh shim cannot silently skip the page.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	buildHarnessActivitySql,
	buildHarnessStatuses,
	mountHarnessApi,
	type HarnessStatus,
} from "../../../../src/daemon/runtime/dashboard/harness-api.js";
import {
	CANONICAL_HARNESS_IDS,
	CANONICAL_SHIMS,
	HARNESS_CAPABILITIES,
} from "../../../../src/daemon/runtime/dashboard/harness-registry.js";
import {
	createClaudeCodeShim,
	createCodexShim,
	createCursorShim,
	createHermesShim,
	createOpenClawShim,
	createPiShim,
} from "../../../../src/hooks/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

const THE_SIX = ["claude-code", "codex", "cursor", "hermes", "pi", "openclaw"];

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE };
}

/**
 * A SQL-aware responder for the `sessions` GROUP BY activity query. `seed` controls which harnesses
 * have rows (so we can prove the real-vs-zero split). `fail` makes storage return a non-ok result to
 * prove the fail-soft path. Cursor + claude-code get real counts; the other four are absent (→ 0).
 */
function responder(seed: boolean) {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		if (/GROUP BY\s+agent/i.test(sql) && /FROM\s+"sessions"/i.test(sql)) {
			if (!seed) return [];
			// Only TWO harnesses captured; the other four must come back zeroed (a-AC-1 / a-AC-2).
			return [
				{ agent: "cursor", n: 312, last: "2026-06-22T10:00:00.000Z" },
				{ agent: "claude-code", n: 7, last: "2026-06-21T08:30:00.000Z" },
			];
		}
		return [];
	};
}

function makeDaemon(seed: boolean) {
	const fake = new FakeDeepLakeTransport(responder(seed));
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

/** A daemon whose storage transport always throws → the query path returns a non-ok result (fail-soft). */
function makeFailingDaemon() {
	const fake = new FakeDeepLakeTransport(() => {
		throw new Error("deeplake unreachable");
	});
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

async function getHarnesses(seed: boolean, installed: ReadonlySet<string>): Promise<HarnessStatus[]> {
	const { daemon, storage } = makeDaemon(seed);
	mountHarnessApi(daemon, { storage, installedHarnesses: installed });
	const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
	expect(res.status).toBe(200);
	const json = (await res.json()) as { harnesses: HarnessStatus[] };
	return json.harnesses;
}

describe("PRD-039a a-OQ-3: the canonical six are derived-from / asserted-against the shim set", () => {
	it("CANONICAL_HARNESS_IDS equals the harness ids the shim factories ship (no drift, no 7th skip)", () => {
		// The shim set IS the source of truth (the SAME `create<Harness>Shim()` factories the capture
		// pipeline runs). If a SEVENTH shim ships, this set diverges from THE_SIX and the test fails.
		const fromFactories = [
			createClaudeCodeShim(),
			createCodexShim(),
			createCursorShim(),
			createHermesShim(),
			createPiShim(),
			createOpenClawShim(),
		].map((s) => s.harness);
		expect([...CANONICAL_HARNESS_IDS].sort()).toEqual([...THE_SIX].sort());
		expect([...CANONICAL_SHIMS].map((s) => s.harness).sort()).toEqual(fromFactories.sort());
	});
});

describe("PRD-039a a-AC-1 / a-AC-2: all six always, with real activity from the sessions GROUP BY", () => {
	it("returns exactly the six canonical harnesses every call (idle ones present + zeroed)", async () => {
		const harnesses = await getHarnesses(true, new Set());
		expect(harnesses.map((h) => h.name).sort()).toEqual([...THE_SIX].sort());
		expect(harnesses).toHaveLength(6);
	});

	it("a harness with rows reports the REAL COUNT + MAX; one without reports 0 / null (no fabrication)", async () => {
		const harnesses = await getHarnesses(true, new Set());
		const cursor = harnesses.find((h) => h.name === "cursor");
		const claude = harnesses.find((h) => h.name === "claude-code");
		const codex = harnesses.find((h) => h.name === "codex");
		// Real, seeded values — not synthesized.
		expect(cursor?.turnsCaptured).toBe(312);
		expect(cursor?.lastSeen).toBe("2026-06-22T10:00:00.000Z");
		expect(claude?.turnsCaptured).toBe(7);
		expect(claude?.lastSeen).toBe("2026-06-21T08:30:00.000Z");
		// A harness with NO rows is present, zeroed — never omitted, never faked.
		expect(codex?.turnsCaptured).toBe(0);
		expect(codex?.lastSeen).toBeNull();
	});

	it("with an empty sessions table, all six come back zeroed (0 turns, null last-seen, inactive)", async () => {
		const harnesses = await getHarnesses(false, new Set());
		expect(harnesses).toHaveLength(6);
		for (const h of harnesses) {
			expect(h.turnsCaptured).toBe(0);
			expect(h.lastSeen).toBeNull();
			expect(h.active).toBe(false);
		}
	});
});

describe("PRD-039a a-AC-4: the `active` flag is derived (turnsCaptured > 0) and returned explicitly", () => {
	it("active iff the harness has captured at least one turn", async () => {
		const harnesses = await getHarnesses(true, new Set());
		expect(harnesses.find((h) => h.name === "cursor")?.active).toBe(true);
		expect(harnesses.find((h) => h.name === "claude-code")?.active).toBe(true);
		expect(harnesses.find((h) => h.name === "codex")?.active).toBe(false);
		expect(harnesses.find((h) => h.name === "pi")?.active).toBe(false);
	});
});

describe("PRD-039a a-AC-3: installed reflects the wiring set, independent of activity", () => {
	it("installed=true for a wired harness and false otherwise — both 'wired+0 turns' and 'unwired+N turns' representable", async () => {
		// Wire codex (no activity) + cursor (has activity); leave the rest unwired (cursor has N turns).
		const harnesses = await getHarnesses(true, new Set(["codex", "cursor"]));
		const codex = harnesses.find((h) => h.name === "codex");
		const cursor = harnesses.find((h) => h.name === "cursor");
		const claude = harnesses.find((h) => h.name === "claude-code");
		// codex: installed but inactive (0 turns) — the "freshly wired, never run" case.
		expect(codex?.installed).toBe(true);
		expect(codex?.active).toBe(false);
		// cursor: installed AND active.
		expect(cursor?.installed).toBe(true);
		expect(cursor?.active).toBe(true);
		// claude-code: NOT wired in this set, yet has 7 captured turns — both states are honest.
		expect(claude?.installed).toBe(false);
		expect(claude?.active).toBe(true);
	});
});

describe("PRD-039a a-AC-5: guarded + fail-soft + secure", () => {
	it("the activity SQL is built with sqlIdent (no interpolated value) and is one GROUP BY", () => {
		const sql = buildHarnessActivitySql();
		expect(sql).toContain('FROM "sessions"');
		expect(sql).toContain("GROUP BY agent");
		expect(sql).toContain("COUNT(*)");
		expect(sql).toContain("MAX(creation_date)");
		// No quote/semicolon injection surface — only bare identifiers + aggregates.
		expect(sql).not.toMatch(/;\s*\w/);
	});

	it("a non-ok storage result returns all six with zeroed activity (NO 500)", async () => {
		const { daemon, storage } = makeFailingDaemon();
		mountHarnessApi(daemon, { storage, installedHarnesses: new Set(["cursor"]) });
		const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
		// Fail-soft: still 200 with all six, activity zeroed, installed intact.
		expect(res.status).toBe(200);
		const json = (await res.json()) as { harnesses: HarnessStatus[] };
		expect(json.harnesses).toHaveLength(6);
		for (const h of json.harnesses) {
			expect(h.turnsCaptured).toBe(0);
			expect(h.lastSeen).toBeNull();
		}
		// installed still reflects the injected set even though activity failed soft.
		expect(json.harnesses.find((h) => h.name === "cursor")?.installed).toBe(true);
	});

	it("the response carries NO token/secret (only ids, booleans, a count, an ISO, statics)", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountHarnessApi(daemon, { storage, installedHarnesses: new Set(THE_SIX) });
		const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
		const raw = await res.text();
		// No credential-shaped strings ride the body.
		for (const needle of [
			"token",
			"Bearer",
			"authorization",
			"secret",
			"api_key",
			"apikey",
			"password",
			"credential",
		]) {
			expect(raw.toLowerCase()).not.toContain(needle.toLowerCase());
		}
	});

	it("BEFORE attach the diagnostics group answers the 501 scaffold for /harnesses", async () => {
		const { daemon } = makeDaemon(true);
		const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
		expect(res.status).toBe(501);
	});
});

describe("attribution: the page-counted `agent` token EQUALS the shim's canonical id (rename-safe)", () => {
	it("buildHarnessStatuses attributes a row keyed by the shim's own harness token to that harness", () => {
		// Seed ONE captured turn per canonical shim, keyed on the SAME token the shim declares
		// (`shim.harness`). This is exactly what the capture seam now stamps into `sessions.agent`.
		// If a future rename drifts the page's canonical id from the stamped token, this fails.
		const rows = CANONICAL_SHIMS.map((shim, i) => ({
			agent: shim.harness,
			n: i + 1,
			last: `2026-06-2${i}T00:00:00.000Z`,
		}));
		const statuses = buildHarnessStatuses(rows, new Set());
		for (const shim of CANONICAL_SHIMS) {
			const status = statuses.find((s) => s.name === shim.harness);
			expect(status, `${shim.harness} appears on the page`).toBeDefined();
			// The seeded row attributes: real count, active, non-null lastSeen — NOT 0/false/null.
			expect(status?.turnsCaptured, `${shim.harness} counts its captured turn`).toBeGreaterThan(0);
			expect(status?.active).toBe(true);
			expect(status?.lastSeen).not.toBeNull();
		}
	});

	it("a harness with claude-code rows reports turnsCaptured>0/active/lastSeen; one with none reports 0/false/null", async () => {
		// The regression the fix targets: a session captured by claude-code (now `agent="claude-code"`)
		// makes the claude-code card truthful, while a harness with no rows stays honestly zeroed.
		const harnesses = await getHarnesses(true, new Set());
		const claude = harnesses.find((h) => h.name === "claude-code");
		expect(claude?.turnsCaptured).toBeGreaterThan(0);
		expect(claude?.active).toBe(true);
		expect(claude?.lastSeen).not.toBeNull();
		const pi = harnesses.find((h) => h.name === "pi");
		expect(pi?.turnsCaptured).toBe(0);
		expect(pi?.active).toBe(false);
		expect(pi?.lastSeen).toBeNull();
	});

	it("an empty `agent` token attributes to NO harness (the pre-fix `agent=''` reads 0 everywhere)", () => {
		// Proves WHY the bug zeroed every harness: a row with `agent=''` matches none of the six.
		const statuses = buildHarnessStatuses([{ agent: "", n: 99, last: "2026-06-23T00:00:00.000Z" }], new Set());
		for (const s of statuses) {
			expect(s.turnsCaptured).toBe(0);
			expect(s.active).toBe(false);
			expect(s.lastSeen).toBeNull();
		}
	});
});

describe("PRD-039c c-AC-4 (server-folded descriptor): Cursor carries `agents`, Claude Code does not", () => {
	it("the folded capability descriptor reflects the real shim divergences", async () => {
		const harnesses = await getHarnesses(true, new Set());
		const cursor = harnesses.find((h) => h.name === "cursor");
		const claude = harnesses.find((h) => h.name === "claude-code");
		const hermes = harnesses.find((h) => h.name === "hermes");
		const openclaw = harnesses.find((h) => h.name === "openclaw");
		// Cursor: agents present (cursor-agent + claude fallback) + plugin runtime path.
		expect(cursor?.capabilities.agents).toBeDefined();
		expect(cursor?.capabilities.agents?.binary).toBe("cursor-agent");
		expect(cursor?.capabilities.agents?.fallbackBin).toBe("claude");
		expect(cursor?.capabilities.runtimePath).toBe("plugin");
		// Claude Code: NO agents (the absence is the point) + the full native lifecycle map + legacy path.
		// It is the REFERENCE shim, so it maps the MOST native events (the full lifecycle incl.
		// SubagentStop) and carries no agents panel — the divergence c-AC-4 asserts.
		expect(claude?.capabilities.agents).toBeUndefined();
		expect(claude?.capabilities.runtimePath).toBe("legacy");
		expect(claude?.capabilities.lifecycleEvents).toEqual([
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"Stop",
			"SubagentStop",
			"SessionEnd",
		]);
		// Claude Code has strictly MORE lifecycle events than Cursor (the reference is the richest).
		expect(claude?.capabilities.lifecycleEvents.length).toBeGreaterThan(
			cursor?.capabilities.lifecycleEvents.length ?? 0,
		);
		// C-1 claim-reduction: only three harnesses are supported today.
		expect(cursor?.capabilities.supportStatus).toBe("supported");
		expect(claude?.capabilities.supportStatus).toBe("supported");
		expect(harnesses.find((h) => h.name === "codex")?.capabilities.supportStatus).toBe("supported");
		expect(hermes?.capabilities.supportStatus).toBe("in-progress");
		expect(openclaw?.capabilities.supportStatus).toBe("in-progress");
		expect(harnesses.find((h) => h.name === "pi")?.capabilities.supportStatus).toBe("in-progress");
		expect(hermes?.capabilities.mcpRegistration).toBeUndefined();
		expect(openclaw?.capabilities.contractedTools).toBeUndefined();
	});

	it("the registry descriptors agree with the folded response (single source, c-OQ-2)", () => {
		// The pure builder over canonical rows folds the SAME descriptors the registry exposes.
		const statuses = buildHarnessStatuses([], new Set());
		for (const s of statuses) {
			expect(s.capabilities).toEqual(HARNESS_CAPABILITIES[s.name]);
		}
	});
});
