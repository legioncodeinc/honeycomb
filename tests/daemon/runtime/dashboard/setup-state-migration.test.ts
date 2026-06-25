/**
 * PRD-050d — the `GET /setup/state` migration extension (d-AC-1 / d-AC-6 / d-AC-7).
 *
 * Mounts `mountSetupStateGroup` against a temp HOME (mirroring `setup-state.test.ts`) and asserts the
 * additive migration fields:
 *   d-AC-1  a `~/.hivemind` dir present (with no recorded migration) DERIVES `priorTool.hivemind:"present"`.
 *   d-AC-6  a recorded `priorTool.hivemind:"migrated"` is reported verbatim (never downgraded by the probe).
 *   d-AC-7  a NON-TERMINAL `migration.phase` is surfaced verbatim so the dashboard offers resume/rollback.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SETUP_STATE_PATH, mountSetupStateGroup } from "../../../../src/daemon/runtime/dashboard/setup-state.js";

let home: string;

/** Mount the setup-state read at the real path, pointing the loaders at the temp `~/.deeplake`. */
function build(): Hono {
	const root = new Hono();
	const deeplakeDir = join(home, ".deeplake");
	mountSetupStateGroup(root, "local", { homeDir: home, credentialsDir: deeplakeDir, onboardingDir: deeplakeDir });
	return root;
}

/** Write an onboarding.json with the given overrides folded onto a valid fresh state. */
function writeOnboarding(over: Record<string, unknown>): void {
	mkdirSync(join(home, ".deeplake"), { recursive: true });
	const base = {
		schemaVersion: 1,
		installId: "11111111-1111-4111-8111-111111111111",
		phase: "fresh",
		firstTimeSetupComplete: false,
		ref: "mario",
		priorTool: { hivemind: "absent" },
		telemetry: { optInTier2: false, reported: {}, sent: [] },
	};
	writeFileSync(join(home, ".deeplake", "onboarding.json"), JSON.stringify({ ...base, ...over }), "utf8");
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-setup-state-mig-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("d-AC-1 prior-tool detection drives the coexistence-warning render", () => {
	it("DERIVES priorTool.hivemind='present' when `~/.hivemind` exists and no migration was recorded", async () => {
		mkdirSync(join(home, ".hivemind"), { recursive: true });
		// No onboarding file → fresh state (priorTool absent), but the dir probe upgrades it to present.
		const body = await (await build().request(SETUP_STATE_PATH)).json();
		expect(body.credentials.hivemind).toBe(true);
		expect(body.priorTool).toEqual({ hivemind: "present" });
	});

	it("reports priorTool.hivemind='absent' when no `~/.hivemind` dir exists", async () => {
		const body = await (await build().request(SETUP_STATE_PATH)).json();
		expect(body.priorTool).toEqual({ hivemind: "absent" });
	});
});

describe("d-AC-6 a recorded 'migrated' value is honored verbatim (never downgraded by the dir probe)", () => {
	it("reports priorTool.hivemind='migrated' even if a `~/.hivemind` dir still lingers", async () => {
		mkdirSync(join(home, ".hivemind"), { recursive: true }); // a stale dir...
		writeOnboarding({ priorTool: { hivemind: "migrated" }, phase: "migrated" });
		const body = await (await build().request(SETUP_STATE_PATH)).json();
		// ...does NOT downgrade a recorded `migrated` to `present`.
		expect(body.priorTool).toEqual({ hivemind: "migrated" });
		expect(body.phase).toBe("migrated");
	});
});

describe("d-AC-7 a non-terminal migration.phase is surfaced for resume/rollback", () => {
	it("surfaces an interrupted migration marker verbatim (the dashboard offers resume/rollback)", async () => {
		writeOnboarding({
			priorTool: { hivemind: "present" },
			migration: { phase: "uninstall", startedAt: "2026-06-25T12:00:00.000Z", backupPath: "/home/u/.hivemind-backup-x" },
		});
		const body = await (await build().request(SETUP_STATE_PATH)).json();
		expect(body.migration).toEqual({
			phase: "uninstall",
			startedAt: "2026-06-25T12:00:00.000Z",
			backupPath: "/home/u/.hivemind-backup-x",
		});
	});

	it("omits the migration block entirely on a machine that never migrated", async () => {
		const body = await (await build().request(SETUP_STATE_PATH)).json();
		expect(body.migration).toBeUndefined();
	});
});
