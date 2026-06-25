/**
 * PRD-050d — the idempotent, reversible-via-backup Hivemind uninstaller (d-AC-3 / d-AC-5 / d-AC-7).
 *
 * Drives `backupAndUninstallHivemind` + `restoreHivemindBackup` against a temp HOME with the npm-remove
 * seam injected (no real `npm` spawns). The decisive assertions:
 *   d-AC-3  a present `~/.hivemind` is backed up to a timestamped path THEN removed; the npm remove fires.
 *   d-AC-5  the uninstall is IDEMPOTENT (re-run on an already-absent dir is a clean no-op), the shared
 *           `~/.deeplake` credential dir is NEVER touched, and a throwing npm remover never aborts.
 *   d-AC-7  a backup can be RESTORED (the rollback primitive), bringing `~/.hivemind` back byte-for-byte.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	HIVEMIND_BACKUP_PREFIX,
	HIVEMIND_NPM_PACKAGE,
	backupAndUninstallHivemind,
	hivemindDirPath,
	restoreHivemindBackup,
	sharedCredentialDirPath,
} from "../../../../src/daemon/runtime/onboarding/hivemind-uninstall.js";

let home: string;

/** Seed a `~/.hivemind` dir with a sentinel config file so the backup/restore can be verified by content. */
function seedHivemind(contents = "hivemind-config-v1"): void {
	const dir = hivemindDirPath(home);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), contents, "utf8");
}

/** Seed the shared `~/.deeplake` credential dir + file (the file the uninstall must NEVER touch). */
function seedSharedCredential(): string {
	const dir = sharedCredentialDirPath(home);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "credentials.json");
	writeFileSync(path, '{"token":"SHARED-DO-NOT-DELETE","orgId":"org-acme"}', "utf8");
	return path;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-hm-uninstall-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("d-AC-3 backup-then-uninstall", () => {
	it("backs up `~/.hivemind` to a timestamped path THEN removes the original; the npm remove fires", () => {
		seedHivemind("payload-A");
		let npmArg: string | undefined;
		const result = backupAndUninstallHivemind({
			homeDir: home,
			now: () => "2026-06-25T12:00:00.000Z",
			npmRemove: (pkg) => {
				npmArg = pkg;
				return true;
			},
		});

		// The original is gone, the backup exists with the same bytes.
		expect(existsSync(hivemindDirPath(home))).toBe(false);
		expect(result.removed).toBe(true);
		expect(result.backupPath).toBeDefined();
		expect(result.backupPath?.includes(HIVEMIND_BACKUP_PREFIX)).toBe(true);
		expect(readFileSync(join(result.backupPath as string, "config.json"), "utf8")).toBe("payload-A");

		// The npm global remove was attempted against the Hivemind package.
		expect(npmArg).toBe(HIVEMIND_NPM_PACKAGE);
		expect(result.npmRemoved).toBe(true);
	});
});

describe("d-AC-5 idempotent + credential-safe + npm-failure-tolerant", () => {
	it("is a clean no-op when `~/.hivemind` is already absent (safe to re-run)", () => {
		const result = backupAndUninstallHivemind({ homeDir: home, npmRemove: () => false });
		expect(result.removed).toBe(false);
		expect(result.backupPath).toBeUndefined();
	});

	it("re-running after a successful uninstall is a clean no-op (idempotent)", () => {
		seedHivemind();
		backupAndUninstallHivemind({ homeDir: home, now: () => "2026-06-25T12:00:00.000Z", npmRemove: () => true });
		// Second run: nothing left to remove.
		const second = backupAndUninstallHivemind({ homeDir: home, now: () => "2026-06-25T13:00:00.000Z", npmRemove: () => true });
		expect(second.removed).toBe(false);
	});

	it("NEVER touches the shared `~/.deeplake` credential dir/file", () => {
		seedHivemind();
		const credPath = seedSharedCredential();
		backupAndUninstallHivemind({ homeDir: home, now: () => "2026-06-25T12:00:00.000Z", npmRemove: () => true });
		// The shared credential survives the uninstall verbatim.
		expect(existsSync(sharedCredentialDirPath(home))).toBe(true);
		expect(existsSync(credPath)).toBe(true);
		expect(readFileSync(credPath, "utf8")).toContain("SHARED-DO-NOT-DELETE");
	});

	it("a THROWING npm remover does not abort the dir backup+remove (best-effort npm)", () => {
		seedHivemind("payload-B");
		// A misbehaving custom seam THROWS — the module must catch it and still complete the
		// load-bearing dir half (backup + remove), reporting npmRemoved:false (best-effort npm, d-AC-5).
		const result = backupAndUninstallHivemind({
			homeDir: home,
			now: () => "2026-06-25T12:00:00.000Z",
			npmRemove: () => {
				throw new Error("npm exploded");
			},
		});
		expect(result.removed).toBe(true);
		expect(result.npmRemoved).toBe(false);
		expect(existsSync(hivemindDirPath(home))).toBe(false);
		expect(readFileSync(join(result.backupPath as string, "config.json"), "utf8")).toBe("payload-B");
	});
});

describe("d-AC-7 the backup can be restored (the rollback primitive)", () => {
	it("restores `~/.hivemind` byte-for-byte from a backup", () => {
		seedHivemind("payload-C");
		const result = backupAndUninstallHivemind({ homeDir: home, now: () => "2026-06-25T12:00:00.000Z", npmRemove: () => true });
		expect(existsSync(hivemindDirPath(home))).toBe(false);

		const restored = restoreHivemindBackup(result.backupPath as string, { homeDir: home });
		expect(restored).toBe(true);
		expect(existsSync(hivemindDirPath(home))).toBe(true);
		expect(readFileSync(join(hivemindDirPath(home), "config.json"), "utf8")).toBe("payload-C");
	});

	it("restoring a non-existent backup returns false (fail-soft, never a throw)", () => {
		const restored = restoreHivemindBackup(join(home, ".hivemind-backup-nope"), { homeDir: home });
		expect(restored).toBe(false);
	});
});
