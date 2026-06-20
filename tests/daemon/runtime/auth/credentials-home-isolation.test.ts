/**
 * REGRESSION LOCK for the credential data-loss guard (Fix A, defense in depth).
 *
 * ── The incident this locks against ─────────────────────────────────────────
 * PRD-023 repointed `credentialsPath()` / `legacyCredentialsPath()` at the SHARED
 * `~/.deeplake/credentials.json` (the file `hivemind login` writes). A unit test that
 * dispatched `honeycomb logout` with NO isolated home then `unlinkSync`d the real file
 * on every `npm run ci`, wiping the developer's real login. The systemic fix is the
 * global vitest `setupFiles` (tests/setup/isolate-home.ts), which redirects
 * `os.homedir()` to a throwaway temp dir BEFORE any test runs.
 *
 * ── What this test asserts ──────────────────────────────────────────────────
 * That the global guard is actually in force during the suite: under the test HOME,
 * `credentialsPath()` (the shared `~/.deeplake` target a real `logout` deletes) and
 * `legacyCredentialsPath()` (the legacy `~/.honeycomb` fallback) BOTH resolve UNDER the
 * temp home and NEVER under the developer's real home directory. If someone removes the
 * `setupFiles` wiring, this test fails loudly instead of a real credential file dying
 * silently. It is intentionally tiny and reads no files — it asserts the resolved paths.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { credentialsPath, legacyCredentialsPath } from "../../../../src/daemon/runtime/auth/index.js";

describe("Fix A — credential paths resolve under the isolated test HOME, never the real ~/.deeplake", () => {
	it("credentialsPath() resolves under the OS temp root (the isolated test home), not the real home", () => {
		const resolved = credentialsPath();
		// The global setupFiles redirect points USERPROFILE/HOME at a mkdtemp dir under tmpdir().
		expect(resolved.startsWith(tmpdir())).toBe(true);
		// And it is specifically the throwaway test-home prefix the setup file creates.
		expect(resolved).toContain("hc-test-home-");
		// Hard positive: it is the shared `.deeplake/credentials.json` target — but UNDER temp space
		// (join() yields the platform-correct separator, so this holds on win32 + POSIX).
		expect(resolved.endsWith(join(".deeplake", "credentials.json"))).toBe(true);
	});

	it("legacyCredentialsPath() (the ~/.honeycomb fallback) also resolves under the isolated test home", () => {
		const resolved = legacyCredentialsPath();
		expect(resolved.startsWith(tmpdir())).toBe(true);
		expect(resolved).toContain("hc-test-home-");
	});
});
