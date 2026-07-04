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
 * Cleanup is a SELF-HEALING SWEEP, not an exit hook: a `process.on("exit", …)` handler was
 * tried first, but vitest's worker pool (`forks` by default) tears workers down by killing
 * the child process rather than letting it run to a natural exit, so the handler never fires
 * in practice — proven by measurement, not assumption (a full `vitest run` left every one of
 * its `hc-test-home-*` dirs behind even with the exit hook wired). This used to skip cleanup
 * entirely on top of that same optimistic assumption ("the OS reclaims tmpdir() content"),
 * which does not hold on Windows (this repo's primary dev + CI platform) either: nothing
 * purges `%TEMP%` automatically. Together this accumulated 100k+ stray directories under
 * `%TEMP%` over time — a real incident.
 *
 * The fix: EVERY worker, on startup, sweeps `tmpdir()` for `hc-test-home-*` entries OLDER
 * than `STALE_AFTER_MS` and removes them, before minting its own fresh one. Age-gating is
 * what makes this race-free against sibling workers running the SAME `vitest` invocation —
 * they mint their dirs within milliseconds of each other, all far younger than the staleness
 * floor, so a live sibling's home is never touched. Only genuinely abandoned dirs from a
 * PAST run (whose worker is long gone) are old enough to qualify. Cleanup is therefore
 * incremental — each run mops up the debris of previous runs — rather than requiring every
 * worker to reliably self-clean on its own way out, which the pool does not guarantee.
 *
 * Defense in depth — this is the SYSTEMIC guard. The specific destructive test is ALSO
 * made self-isolating, and a regression test
 * (`tests/daemon/runtime/auth/credentials-home-isolation.test.ts`) asserts
 * `credentialsPath()` resolves UNDER this temp home. Belt and suspenders.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_PREFIX = "hc-test-home-";
/** Only sweep dirs older than this — far beyond how long any single `vitest run` takes, so a
 *  live sibling worker's own dir (minted moments ago) is never in the blast radius. Short
 *  enough that back-to-back `npm run ci` loops (e.g. a QA/fix loop re-running the suite every
 *  few minutes) still get swept promptly instead of piling up across the whole loop. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** Best-effort removal of `hc-test-home-*` dirs left behind by long-finished past runs. */
function sweepStaleIsolatedHomes(): void {
	const root = tmpdir();
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return; // Never let the sweep block the real test run.
	}
	const cutoff = Date.now() - STALE_AFTER_MS;
	for (const name of entries) {
		if (!name.startsWith(HOME_PREFIX)) continue;
		const full = join(root, name);
		try {
			if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
		} catch {
			// Another worker may be mid-sweep of the same stale dir, or it's already gone — fine.
		}
	}
}

sweepStaleIsolatedHomes();

const isolatedHome = mkdtempSync(join(tmpdir(), HOME_PREFIX));

// win32: os.homedir() reads USERPROFILE. POSIX: os.homedir() reads HOME. Set BOTH so the
// redirect holds on every platform the suite runs on, before any test resolves a home path.
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;

// ADR-0003 / PRD-072 fleet-root isolation: `resolveFleetRoot()` honors `APIARY_HOME` (any platform)
// and `XDG_STATE_HOME` (Linux) over the home default. Clear both so a developer's / CI runner's real
// env can never redirect the resolved `~/.apiary` root outside the isolated home during the run. A
// test that exercises those precedence legs sets them explicitly via the injectable helper seams.
delete process.env.APIARY_HOME;
delete process.env.XDG_STATE_HOME;

/** The isolated home dir the run was redirected to (exported for assertions/debugging). */
export const ISOLATED_TEST_HOME = isolatedHome;
