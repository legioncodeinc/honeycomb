/**
 * GLOBAL HOME ISOLATION for the whole unit-test run (the systemic data-loss guard).
 *
 * ── Why this file exists (a real incident) ──────────────────────────────────
 * PRD-023 made `~/.deeplake/credentials.json` the SHARED login file (one
 * `hivemind login` OR `honeycomb login` authenticates both tools). It also pointed
 * `credentialsPath()` / `legacyCredentialsPath()` (in
 * `src/daemon/runtime/auth/credentials-store.ts`) at the user's REAL home via
 * `os.homedir()`. Any test that exercises a destructive auth path WITHOUT injecting a
 * temp dir — e.g. `honeycomb logout`, which `unlinkSync`s `credentialsPath()` — would
 * then delete the developer's REAL Hivemind/Honeycomb login on every `npm run ci`.
 * That actually happened (the b-AC-6 passthrough test dispatched `["logout"]` with no
 * isolated home). Recovery is a fresh `hivemind login`, but recovery is not a fix.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 * This is wired as a vitest `setupFiles` entry (see `vitest.config.ts`), so it runs in
 * EVERY test worker BEFORE any test code. It redirects the home directory to a fresh
 * per-run temp dir so `os.homedir()` can NEVER resolve to the real home in any test —
 * regardless of whether that test remembered to inject its own dir:
 *
 *   - `USERPROFILE` — on win32, `os.homedir()` reads this env var. Setting it relocates
 *     the resolved home on Windows (this repo's primary dev + CI platform).
 *   - `HOME` — on POSIX, `os.homedir()` reads this. Set for Linux/macOS CI parity.
 *
 * Both are set to a `mkdtempSync(tmpdir()/hc-test-home-…)` directory. With this in
 * place, `credentialsPath()` → `<tmp>/.deeplake/credentials.json` and
 * `legacyCredentialsPath()` → `<tmp>/.honeycomb/credentials.json` for the entire run —
 * so even a test that performs a real `logout` only ever unlinks throwaway temp space.
 *
 * Cleanup is intentionally NOT performed: the dir lives under the OS temp root, it is
 * per-process and tiny, and a `finally` rm could race parallel workers / a still-open
 * handle. The OS reclaims `tmpdir()` content; leaving it is the safe, simple choice.
 *
 * Defense in depth — this is the SYSTEMIC guard. The specific destructive test is ALSO
 * made self-isolating, and a regression test
 * (`tests/daemon/runtime/auth/credentials-home-isolation.test.ts`) asserts
 * `credentialsPath()` resolves UNDER this temp home. Belt and suspenders.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedHome = mkdtempSync(join(tmpdir(), "hc-test-home-"));

// win32: os.homedir() reads USERPROFILE. POSIX: os.homedir() reads HOME. Set BOTH so the
// redirect holds on every platform the suite runs on, before any test resolves a home path.
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;

/** The isolated home dir the run was redirected to (exported for assertions/debugging). */
export const ISOLATED_TEST_HOME = isolatedHome;
