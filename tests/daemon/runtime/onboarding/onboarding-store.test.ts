/**
 * PRD-050 substrate — the OnboardingStore (`~/.deeplake/onboarding.json`).
 *
 * Verification posture (mirrors `credentials-store.test.ts`): a TEMP onboarding
 * dir created per-test + `dir?` injection, so NO test ever touches the real
 * `~/.deeplake`. Covers: fresh-install defaults on a missing file, fail-soft on a
 * malformed file (no throw), installId stability across load→save→load, the
 * markReported/isReported round-trip, appendSent ordering, and the 0600 file perms
 * (POSIX-guarded — chmod is a no-op on win32).
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FILE_MODE } from "../../../../src/daemon/runtime/auth/index.js";
import {
	type OnboardingState,
	DEFAULT_REF,
	ONBOARDING_FILE_NAME,
	ONBOARDING_SCHEMA_VERSION,
	appendSent,
	freshOnboardingState,
	getOrCreateInstallId,
	isReported,
	loadOnboarding,
	markReported,
	onboardingPath,
	saveOnboarding,
} from "../../../../src/daemon/runtime/onboarding/index.js";

const IS_POSIX = process.platform !== "win32";

/** A UUID-v4 shape check (the installId must be a real randomUUID). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-onboarding-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("fresh-install defaults on a missing file", () => {
	it("returns a fully-defaulted fresh state when the file is absent (never throws)", () => {
		const state = loadOnboarding(dir);
		expect(state.schemaVersion).toBe(ONBOARDING_SCHEMA_VERSION);
		expect(state.phase).toBe("fresh");
		expect(state.firstTimeSetupComplete).toBe(false);
		expect(state.ref).toBe(DEFAULT_REF);
		expect(state.priorTool.hivemind).toBe("absent");
		expect(state.telemetry.optInTier2).toBe(false);
		expect(state.telemetry.reported).toEqual({});
		expect(state.telemetry.sent).toEqual([]);
		expect(state.migration).toBeUndefined();
		// A brand-new random installId (UUID v4).
		expect(state.installId).toMatch(UUID_V4);
	});

	it("mints a DIFFERENT installId on each fresh load (it is not yet persisted)", () => {
		expect(loadOnboarding(dir).installId).not.toBe(loadOnboarding(dir).installId);
	});
});

describe("fail-soft on a malformed file (defaults + no throw)", () => {
	it("returns fresh defaults on invalid JSON garbage", () => {
		writeFileSync(onboardingPath(dir), "{ not json at all");
		let state: OnboardingState | undefined;
		expect(() => {
			state = loadOnboarding(dir);
		}).not.toThrow();
		expect(state?.phase).toBe("fresh");
		expect(state?.installId).toMatch(UUID_V4);
	});

	it("returns fresh defaults when the JSON is valid but fails the zod boundary (wrong shape)", () => {
		// Structurally a JSON object, but missing every required field.
		writeFileSync(onboardingPath(dir), JSON.stringify({ hello: "world" }));
		const state = loadOnboarding(dir);
		expect(state.phase).toBe("fresh");
		expect(state.firstTimeSetupComplete).toBe(false);
	});

	it("rejects a file with a foreign schemaVersion (falls soft to defaults)", () => {
		const foreign = { ...freshOnboardingState(), schemaVersion: 999 };
		writeFileSync(onboardingPath(dir), JSON.stringify(foreign));
		const state = loadOnboarding(dir);
		expect(state.schemaVersion).toBe(ONBOARDING_SCHEMA_VERSION);
		expect(state.phase).toBe("fresh");
	});
});

describe("installId stability across load→save→load", () => {
	it("persists the installId so a reload returns the SAME id", () => {
		const first = loadOnboarding(dir);
		const [installId, withId] = getOrCreateInstallId(first);
		expect(installId).toBe(first.installId);
		saveOnboarding(withId, dir);

		const reloaded = loadOnboarding(dir);
		expect(reloaded.installId).toBe(installId);
		// And a second reload is still the same — it is stable, not regenerated.
		expect(loadOnboarding(dir).installId).toBe(installId);
	});

	it("round-trips a saved state byte-for-byte through the zod boundary", () => {
		const saved: OnboardingState = {
			...freshOnboardingState(),
			phase: "linked",
			firstTimeSetupComplete: true,
			ref: "alice",
			priorTool: { hivemind: "migrated" },
			telemetry: { optInTier2: true, reported: { honeycomb_installed: "2026-01-01T00:00:00.000Z" }, sent: [] },
			migration: { phase: "done", startedAt: "2026-01-01T00:00:00.000Z", backupPath: "/tmp/backup" },
		};
		saveOnboarding(saved, dir);
		const loaded = loadOnboarding(dir);
		expect(loaded).toEqual(saved);
	});
});

describe("getOrCreateInstallId is pure (mints only on a miss)", () => {
	it("returns the existing id + the same object when one is present", () => {
		const state = freshOnboardingState();
		const [id, next] = getOrCreateInstallId(state);
		expect(id).toBe(state.installId);
		expect(next).toBe(state); // same object, no copy
	});

	it("mints a fresh id WITHOUT mutating the input when absent", () => {
		const state: OnboardingState = { ...freshOnboardingState(), installId: "" };
		const [id, next] = getOrCreateInstallId(state);
		expect(id).toMatch(UUID_V4);
		expect(next.installId).toBe(id);
		expect(state.installId).toBe(""); // input untouched (pure)
	});
});

describe("markReported / isReported round-trip", () => {
	it("isReported is false before, true after marking, without mutating the input", () => {
		const state = freshOnboardingState();
		expect(isReported(state, "honeycomb_installed")).toBe(false);

		const marked = markReported(state, "honeycomb_installed", "2026-06-25T00:00:00.000Z");
		expect(isReported(marked, "honeycomb_installed")).toBe(true);
		expect(marked.telemetry.reported.honeycomb_installed).toBe("2026-06-25T00:00:00.000Z");
		// The original is untouched (pure helper).
		expect(isReported(state, "honeycomb_installed")).toBe(false);
	});

	it("marking one event leaves the others unreported", () => {
		const marked = markReported(freshOnboardingState(), "honeycomb_first_link", "2026-06-25T00:00:00.000Z");
		expect(isReported(marked, "honeycomb_first_link")).toBe(true);
		expect(isReported(marked, "honeycomb_installed")).toBe(false);
		expect(isReported(marked, "honeycomb_hivemind_upgrade")).toBe(false);
	});
});

describe("appendSent ordering", () => {
	it("appends records in call order, preserving earlier entries, without mutating the input", () => {
		const s0 = freshOnboardingState();
		const r1 = { event: "honeycomb_installed" as const, at: "2026-06-25T00:00:01.000Z", properties: { a: 1 } };
		const r2 = { event: "honeycomb_first_link" as const, at: "2026-06-25T00:00:02.000Z", properties: { b: 2 } };

		const s1 = appendSent(s0, r1);
		const s2 = appendSent(s1, r2);

		expect(s2.telemetry.sent).toEqual([r1, r2]);
		// Order: r1 first, r2 second.
		expect(s2.telemetry.sent[0]?.event).toBe("honeycomb_installed");
		expect(s2.telemetry.sent[1]?.event).toBe("honeycomb_first_link");
		// Purity: s0 and s1 are not mutated.
		expect(s0.telemetry.sent).toEqual([]);
		expect(s1.telemetry.sent).toEqual([r1]);
	});

	it("survives the persistence round-trip in order", () => {
		let state = freshOnboardingState();
		state = appendSent(state, { event: "honeycomb_installed", at: "t1", properties: {} });
		state = appendSent(state, { event: "honeycomb_first_link", at: "t2", properties: {} });
		saveOnboarding(state, dir);
		const loaded = loadOnboarding(dir);
		expect(loaded.telemetry.sent.map((r) => r.event)).toEqual(["honeycomb_installed", "honeycomb_first_link"]);
	});
});

describe("the written file perms (0600, POSIX) + carries no secret", () => {
	it.skipIf(!IS_POSIX)("writes onboarding.json at 0600", () => {
		saveOnboarding(freshOnboardingState(), dir);
		const fileMode = statSync(onboardingPath(dir)).mode & 0o777;
		expect(fileMode).toBe(FILE_MODE);
	});

	it.skipIf(IS_POSIX)("documents that perms are best-effort on win32 (no assertion)", () => {
		// chmod is a no-op on Windows (NTFS ACLs). We still write with the mode option.
		saveOnboarding(freshOnboardingState(), dir);
		expect(loadOnboarding(dir).phase).toBe("fresh");
	});

	it("creates the dir when absent and writes to the shared onboarding file name", () => {
		const nested = join(dir, "made", "fresh");
		saveOnboarding(freshOnboardingState(), nested);
		const onDisk = JSON.parse(readFileSync(join(nested, ONBOARDING_FILE_NAME), "utf8")) as Record<string, unknown>;
		expect(onDisk.schemaVersion).toBe(ONBOARDING_SCHEMA_VERSION);
		// No secret fields ever land here.
		expect(onDisk.token).toBeUndefined();
		expect(onDisk.keyHash).toBeUndefined();
	});
});
