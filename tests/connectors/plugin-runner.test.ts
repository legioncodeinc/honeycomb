/**
 * The `claude plugin` runner seam — `parsePluginEnabled` reads `claude plugin list` honestly.
 *
 * The D5 capture-health signal for Claude Code is "is the marketplace plugin installed AND enabled?"
 * — read from `claude plugin list`. This suite pins the parser against the REAL CLI output shape so a
 * disabled or absent plugin is never reported as healthy.
 */

import { describe, expect, it } from "vitest";

import { parsePluginEnabled } from "../../src/connectors/plugin-runner.js";

// The real `claude plugin list` block shape (captured live): a `<name>@<marketplace>` header then a
// `Version:` / `Scope:` / `Status: ✔ enabled | ✘ disabled` set of lines, one block per plugin.
const ENABLED = `Installed plugins:

  ❯ gitkraken-hooks@gitkraken
    Version: 3.1.68
    Scope: user
    Status: ✘ disabled

  ❯ honeycomb@honeycomb
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled
`;

const DISABLED = `Installed plugins:

  ❯ honeycomb@honeycomb
    Version: 0.1.0
    Scope: user
    Status: ✘ disabled
`;

const ABSENT = `Installed plugins:

  ❯ gitkraken-hooks@gitkraken
    Version: 3.1.68
    Scope: user
    Status: ✔ enabled
`;

describe("parsePluginEnabled — reads `claude plugin list` honestly", () => {
	it("true when the plugin is installed AND enabled", () => {
		expect(parsePluginEnabled(ENABLED, "honeycomb")).toBe(true);
	});

	it("false when the plugin is installed but DISABLED", () => {
		expect(parsePluginEnabled(DISABLED, "honeycomb")).toBe(false);
	});

	it("false when the plugin is ABSENT from the list", () => {
		expect(parsePluginEnabled(ABSENT, "honeycomb")).toBe(false);
	});

	it("false on empty / unparseable output (never a false green)", () => {
		expect(parsePluginEnabled("", "honeycomb")).toBe(false);
		expect(parsePluginEnabled("garbage", "honeycomb")).toBe(false);
	});

	it("does not confuse a similarly-named neighbour's status with honeycomb's", () => {
		// honeycomb disabled, a neighbour enabled — must report honeycomb's OWN (disabled) status.
		const mixed = `Installed plugins:

  ❯ honeycomb@honeycomb
    Status: ✘ disabled

  ❯ honeycomb-extras@other
    Status: ✔ enabled
`;
		expect(parsePluginEnabled(mixed, "honeycomb")).toBe(false);
	});
});
