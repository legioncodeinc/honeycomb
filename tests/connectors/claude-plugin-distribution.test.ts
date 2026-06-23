/**
 * The Claude Code marketplace plugin is DISTRIBUTABLE — schema-valid + fully shipped.
 *
 * Two regressions this suite locks closed:
 *   1. `.claude-plugin/marketplace.json` used an INVALID `{ "source": { "source": "git-subdir", … } }`
 *      shape that `claude plugin validate` rejects (`plugins.0.source: Invalid input`), so the
 *      marketplace could not even be ADDED. The accepted shape is a string source (a relative path
 *      like `./harnesses/claude-code`, an `owner/repo`, or a URL). This test pins the valid shape.
 *   2. The npm `files` allowlist shipped the plugin's `.claude-plugin` + `bundle` but NOT the hooks
 *      manifest, so an npm-installed Honeycomb had a hook-LESS plugin. The hooks manifest now lives at
 *      `harnesses/claude-code/hooks/hooks.json` (the location Claude Code's plugin loader reads) and
 *      MUST be in the allowlist. This test asserts the allowlist covers it.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(rel: string): unknown {
	return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

/**
 * Mirrors the accepted `claude plugin validate` marketplace source contract: a plugin `source` must
 * be a non-empty STRING (relative path / `owner/repo` / URL). The rejected shape is an OBJECT
 * (`{ source: "git-subdir", path: … }`) — exactly the original bug.
 */
function isAcceptedMarketplaceSource(source: unknown): boolean {
	return typeof source === "string" && source.length > 0;
}

describe("Claude Code marketplace.json is schema-valid (the shape `claude plugin validate` accepts)", () => {
	const marketplace = readJson(".claude-plugin/marketplace.json") as {
		name: string;
		plugins: { name: string; source: unknown }[];
	};

	it("the marketplace + plugin are both named `honeycomb`", () => {
		expect(marketplace.name).toBe("honeycomb");
		expect(marketplace.plugins.map((p) => p.name)).toContain("honeycomb");
	});

	it("every plugin source is the ACCEPTED string shape, never the rejected `git-subdir` object", () => {
		for (const plugin of marketplace.plugins) {
			expect(
				isAcceptedMarketplaceSource(plugin.source),
				`plugin "${plugin.name}" source must be a string, got: ${JSON.stringify(plugin.source)}`,
			).toBe(true);
			// Belt-and-braces: it must NOT be the object shape the validator rejects.
			expect(typeof plugin.source).not.toBe("object");
		}
	});

	it("the honeycomb plugin source points at the in-repo plugin dir", () => {
		const honeycomb = marketplace.plugins.find((p) => p.name === "honeycomb");
		expect(honeycomb?.source).toBe("./harnesses/claude-code");
	});

	it("the referenced plugin manifest exists and is itself valid (name matches)", () => {
		const plugin = readJson("harnesses/claude-code/.claude-plugin/plugin.json") as { name: string };
		expect(plugin.name).toBe("honeycomb");
	});
});

describe("the npm `files` allowlist ships a registerable, hook-bearing plugin", () => {
	const pkg = readJson("package.json") as { files: string[] };

	it("ships the root marketplace manifest", () => {
		expect(pkg.files).toContain(".claude-plugin");
	});

	it("ships the plugin manifest + bundle", () => {
		expect(pkg.files).toContain("harnesses/claude-code/.claude-plugin");
		expect(pkg.files).toContain("harnesses/claude-code/bundle");
	});

	it("ships the HOOKS manifest (the regression: it was missing) at hooks/", () => {
		// The hooks manifest lives at harnesses/claude-code/hooks/hooks.json — the location Claude
		// Code's plugin loader reads. The allowlist must cover that dir or the shipped plugin has no
		// hooks (capture dies).
		const coversHooks = pkg.files.some(
			(f) => f === "harnesses/claude-code/hooks" || f === "harnesses/claude-code/hooks/hooks.json",
		);
		expect(coversHooks, "package.json `files` must include the claude-code hooks manifest").toBe(true);
	});

	it("the hooks manifest actually exists at the shipped location and declares the 6 lifecycle hooks", () => {
		const hooks = readJson("harnesses/claude-code/hooks/hooks.json") as { hooks: Record<string, unknown> };
		for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
			expect(Object.keys(hooks.hooks)).toContain(event);
		}
	});
});
