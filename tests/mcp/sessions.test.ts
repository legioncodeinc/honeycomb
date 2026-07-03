/**
 * Session-key lineage inference — `inferParentSessionKey` (PRD-019d FR-5 / d-AC-5).
 *
 * `session_search` / `session_bypass` were UNREGISTERED (C-2, 2026-07-03): they dialed
 * `/api/sessions/*`, a route group the daemon never mounts, so every call 404'd. This
 * suite now covers ONLY the pure, still-exported `inferParentSessionKey` helper — the
 * pieces that dialed the daemon are gone along with the tool.
 */

import { describe, expect, it } from "vitest";
import { inferParentSessionKey } from "../../mcp/src/index.js";

describe("d-AC-5: inferParentSessionKey derives parent lineage from a child session key", () => {
	it("d-AC-5 inferParentSessionKey derives the parent from a child key", () => {
		expect(inferParentSessionKey("sess-abc::slice-1")).toBe("sess-abc");
		expect(inferParentSessionKey("parent#child")).toBe("parent");
		expect(inferParentSessionKey("a/b/c")).toBe("a/b"); // nearest ancestor
		expect(inferParentSessionKey("root.child")).toBe("root");
	});

	it("d-AC-5 a root session key (no separator) has no inferred parent", () => {
		expect(inferParentSessionKey("rootonly")).toBeUndefined();
		expect(inferParentSessionKey("")).toBeUndefined();
		expect(inferParentSessionKey("::leading")).toBeUndefined();
		expect(inferParentSessionKey("trailing::")).toBeUndefined();
	});
});
