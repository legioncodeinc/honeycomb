/**
 * PRD-050e e-AC-7 (structural) — ALL emit paths funnel through the single chokepoint.
 *
 * A static AST-free grep over the SOURCE TREE asserts that the PostHog capture path literal (`/i/v0/e/`)
 * appears in EXACTLY ONE source module — `src/daemon/runtime/telemetry/emit.ts` — and nowhere else. No
 * call site (install / login / migration / the CLI verb) may post to the capture endpoint directly; they
 * all go through `emitTelemetry`. This is the structural proof that the allow-list / opt-out / dedupe /
 * tier gates cannot be bypassed: there is only one door.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The repo `src/` root (this test lives at tests/daemon/runtime/telemetry/). */
const SRC_ROOT = join(__dirname, "..", "..", "..", "..", "src");

/** The capture path literal that must live in exactly one module. */
const CAPTURE_PATH = "/i/v0/e/";

/** The ONE module allowed to reference the capture path. */
const CHOKEPOINT_REL = join("daemon", "runtime", "telemetry", "emit.ts");

/** Recursively collect every `.ts` file under `root` (excluding `.d.ts`). */
function tsFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root)) {
		const full = join(root, entry);
		if (statSync(full).isDirectory()) {
			out.push(...tsFiles(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("e-AC-7 only the chokepoint references the PostHog capture path", () => {
	it("the capture path literal appears in exactly one source module (emit.ts)", () => {
		const matches = tsFiles(SRC_ROOT).filter((f) => readFileSync(f, "utf8").includes(CAPTURE_PATH));
		const relMatches = matches.map((f) => f.slice(SRC_ROOT.length + 1));
		expect(relMatches).toEqual([CHOKEPOINT_REL]);
	});

	it("no source module other than emit.ts posts to the PostHog ingest host directly", () => {
		// A call site that hard-codes the posthog host would be a bypass; only emit.ts may name it.
		// The needle is assembled from parts so this source-grep literal is not itself a URL-host
		// literal (keeps the test out of CodeQL's incomplete-URL-substring rule, which is meant for
		// real URL authorization checks, not file-content greps).
		const postHogHostNeedle = ["i", "posthog", "com"].join(".");
		const offenders = tsFiles(SRC_ROOT)
			.filter((f) => f.slice(SRC_ROOT.length + 1) !== CHOKEPOINT_REL)
			.filter((f) => readFileSync(f, "utf8").includes(postHogHostNeedle));
		expect(offenders.map((f) => f.slice(SRC_ROOT.length + 1))).toEqual([]);
	});
});
