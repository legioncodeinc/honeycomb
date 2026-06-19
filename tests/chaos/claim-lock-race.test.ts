/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CHAOS — REAL multi-process claim-lock race (PRD-020d FR-4 / d-AC-1).     ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The exactly-one-banner guarantee is `openSync(path,"wx")` (O_CREAT |     ║
 * ║  O_EXCL): the FIRST process to create the claim file wins, every racer    ║
 * ║  hits EEXIST and SKIPS — so exactly ONE banner shows across racing hook   ║
 * ║  processes. The unit test drives this against the in-memory               ║
 * ║  `createInMemoryStateFs` FAKE, whose EEXIST is a single-threaded `Map`    ║
 * ║  check. That proves the LOGIC, not the OS-level guarantee.                ║
 * ║                                                                          ║
 * ║  THIS test removes the fake. It spawns N *real* child processes (via      ║
 * ║  `node:child_process.fork`) that EACH load the REAL `createClaimLock` /   ║
 * ║  `nodeStateFs` from `src/notifications/state.ts` and race to `claim()`    ║
 * ║  the SAME claim file in a shared `os.tmpdir()` dir. The kernel — not a    ║
 * ║  Map — arbitrates the O_EXCL create across genuinely-separate processes.  ║
 * ║  We collect each child's WON/LOST verdict and assert EXACTLY ONE won and  ║
 * ║  N-1 saw EEXIST and skipped, across several rounds to shake out races.    ║
 * ║                                                                          ║
 * ║  ── How the child imports the REAL `.ts` source (node-builtin only) ──    ║
 * ║  A forked child has no Vitest/Vite loader, and Node's native             ║
 * ║  type-stripping won't resolve the source's `.js` relative specifiers     ║
 * ║  (Node16 resolution: `state.ts` imports `./contracts.js`, but only        ║
 * ║  `contracts.ts` exists on disk). So each child first `module.register()`s ║
 * ║  a tiny ESM resolve hook (written into the temp dir) that rewrites an      ║
 * ║  unresolved relative `.js` specifier to its `.ts` sibling, THEN imports    ║
 * ║  the genuine `src/notifications/state.ts`. No new dependency — only        ║
 * ║  `node:module`, `node:fs`, `node:url`. The claim path exercised is        ║
 * ║  byte-for-byte the production `createClaimLock` over `nodeStateFs`.       ║
 * ║                                                                          ║
 * ║  CI-SAFE: no network, no backend, no fixed paths — only real OS           ║
 * ║  file-locking + a unique `os.tmpdir()` dir, cleaned in afterAll.          ║
 * ║  If TWO children EVER win, that is a REAL defect in the exactly-one        ║
 * ║  guarantee: the assertion FAILS — it must never be loosened to >=1.       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Absolute path to the REAL source the child loads (resolved from this file). */
const STATE_TS = fileURLToPath(new URL("../../src/notifications/state.ts", import.meta.url));

/** How many real child processes race per round (well above the 2-proc minimum). */
const RACERS = 8;
/** How many independent rounds we run to shake out timing-dependent races. */
const ROUNDS = 6;

/**
 * A node-builtin ESM resolve hook: when a relative `.js` specifier does NOT resolve
 * on disk (the Node16-resolution `./contracts.js` case, where only `contracts.ts`
 * exists), retry it as `.ts`. Native type-stripping then loads the TS source. This
 * is the ONLY way to import the unbuilt `.ts` source tree in a bare forked child
 * without adding a loader dependency — it touches only `node:fs` + `node:url`.
 */
const RESOLVE_HOOK_SRC = [
	'import { existsSync } from "node:fs";',
	'import { fileURLToPath } from "node:url";',
	"export async function resolve(specifier, context, next) {",
	'  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {',
	"    try {",
	'      const parent = context.parentURL ? new URL(".", context.parentURL) : undefined;',
	"      if (!existsSync(fileURLToPath(new URL(specifier, parent)))) {",
	'        const tsSpec = specifier.slice(0, -3) + ".ts";',
	"        if (existsSync(fileURLToPath(new URL(tsSpec, parent)))) return next(tsSpec, context);",
	"      }",
	"    } catch {",
	"      /* fall through to the default resolver */",
	"    }",
	"  }",
	"  return next(specifier, context);",
	"}",
].join("\n");

/**
 * The worker each child runs. argv: [stateDir, key, hookUrl, stateTsUrl]. It registers
 * the resolve hook, imports the REAL `createClaimLock` + `nodeStateFs`, points the
 * state dir at the shared temp dir, races to claim the SAME key, and prints a single
 * verdict line: `WON` (created the claim) / `LOST` (saw EEXIST and skipped) /
 * `ERROR:<msg>` (a genuine non-EEXIST FS failure — which must NEVER be a silent loss).
 */
const WORKER_SRC = [
	'import { register } from "node:module";',
	'import { pathToFileURL } from "node:url";',
	"const [, , stateDir, key, hookUrl, stateTsUrl] = process.argv;",
	"register(hookUrl);",
	"let verdict;",
	"try {",
	"  const mod = await import(stateTsUrl);",
	"  const lock = mod.createClaimLock({ dir: stateDir, fs: mod.nodeStateFs });",
	'  verdict = lock.claim(key) ? "WON" : "LOST";',
	"} catch (err) {",
	'  verdict = "ERROR:" + (err && err.message ? err.message : String(err));',
	"}",
	'process.stdout.write(verdict + "\\n");',
].join("\n");

interface RoundResult {
	readonly wins: number;
	readonly losses: number;
	readonly errors: string[];
}

describe("CHAOS: real multi-process claim-lock race (exactly-one-banner)", () => {
	let dir: string;
	let workerPath: string;
	let hookUrl: string;
	let stateTsUrl: string;

	beforeAll(() => {
		// A unique temp dir per run → parallel test execution / repeats never collide.
		dir = mkdtempSync(join(tmpdir(), "hc-chaos-claim-"));
		const hookPath = join(dir, "ts-resolve-hook.mjs");
		workerPath = join(dir, "claim-worker.mjs");
		writeFileSync(hookPath, RESOLVE_HOOK_SRC, "utf-8");
		writeFileSync(workerPath, WORKER_SRC, "utf-8");
		hookUrl = pathToFileURL(hookPath).href;
		stateTsUrl = pathToFileURL(STATE_TS).href;
	});

	afterAll(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort — the OS reclaims tmp eventually.
		}
	});

	/**
	 * Run ONE round: fork {@link RACERS} children that all race to claim the SAME key.
	 * Each child contends on the SAME claim file under the real kernel O_EXCL semantics.
	 * Returns the WON/LOST/ERROR tally.
	 */
	async function runRound(roundKey: string): Promise<RoundResult> {
		const children = Array.from(
			{ length: RACERS },
			() =>
				new Promise<string>((resolve, reject) => {
					const child = fork(workerPath, [dir, roundKey, hookUrl, stateTsUrl], { silent: true });
					let out = "";
					let err = "";
					child.stdout?.on("data", (c) => {
						out += String(c);
					});
					child.stderr?.on("data", (c) => {
						err += String(c);
					});
					const timer = setTimeout(() => {
						child.kill("SIGKILL");
						reject(new Error(`claim worker timed out; stderr=${err.slice(0, 800)}`));
					}, 20_000);
					child.on("error", (e) => {
						clearTimeout(timer);
						reject(e);
					});
					child.on("exit", (code) => {
						clearTimeout(timer);
						const verdict = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
						if (verdict === "") {
							reject(new Error(`claim worker gave no verdict (exit ${code}); stderr=${err.slice(0, 800)}`));
							return;
						}
						resolve(verdict);
					});
				}),
		);

		const verdicts = await Promise.all(children);
		return {
			wins: verdicts.filter((v) => v === "WON").length,
			losses: verdicts.filter((v) => v === "LOST").length,
			errors: verdicts.filter((v) => v.startsWith("ERROR:")),
		};
	}

	it(`across ${ROUNDS} rounds of ${RACERS} REAL racing processes: EXACTLY ONE wins, ${RACERS - 1} skip`, async () => {
		for (let round = 0; round < ROUNDS; round++) {
			// A fresh key per round → a fresh claim file, so each round is an independent race
			// (a prior round's winner never pre-claims the next round's key).
			const { wins, losses, errors } = await runRound(`chaos-banner-${round}`);

			// No racer may hit a non-EEXIST FS error — that would mean the seam mis-handled a
			// genuine failure (a real error must surface, never become a silent "loss").
			expect(errors, `round ${round}: real FS error in a racer: ${errors.join(" | ")}`).toEqual([]);

			// THE INVARIANT (FR-4 / d-AC-1): EXACTLY ONE banner. Two winners under a real race is
			// a REAL defect — do NOT loosen this to >=1.
			expect(wins, `round ${round}: exactly one process must win the claim`).toBe(1);

			// Every other racer must have cleanly lost (seen EEXIST and skipped).
			expect(losses, `round ${round}: the other ${RACERS - 1} racers must skip on EEXIST`).toBe(RACERS - 1);

			// Total accounting: every spawned child reported exactly one verdict.
			expect(wins + losses, `round ${round}: all ${RACERS} racers accounted for`).toBe(RACERS);

			// Yield the event loop between fork bursts so this CPU-heavy chaos test stays a polite
			// neighbor under parallel CI execution (it never monopolizes the scheduler).
			await new Promise((r) => setTimeout(r, 10));
		}
	}, 180_000);
});
