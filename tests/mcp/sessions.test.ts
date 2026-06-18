/**
 * PRD-019d session_search parent-lineage inference — d-AC-5.
 *
 * Given a child session key, `session_search` infers the parent session lineage and
 * stamps it onto the daemon request (this is how OpenClaw resolves a parent session
 * from a child slice). The inference is pure ({@link inferParentSessionKey}); the
 * handler threads it onto the seam call. Driven against a fake seam (no daemon).
 */

import { describe, expect, it } from "vitest";
import {
	type Actor,
	createFakeDaemonApiSeam,
	inferParentSessionKey,
} from "../../mcp/src/index.js";
import { HANDLERS } from "../../mcp/src/handlers.js";

const ACTOR: Actor = { actor: "agent-1", actorType: "agent" };

describe("d-AC-5: session_search infers parent lineage from a child session key", () => {
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

	it("d-AC-5 session_search stamps the inferred parent onto the daemon request", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { transcripts: [] } });
		await HANDLERS.session_search({ query: "deploy bug", sessionKey: "sess-abc::slice-1" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		const body = daemon.calls[0].body as Record<string, unknown>;
		expect(body.sessionKey).toBe("sess-abc::slice-1");
		expect(body.parentSessionKey).toBe("sess-abc");
		expect(daemon.calls[0].path).toBe("/api/sessions/search");
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});

	it("d-AC-5 session_search WITHOUT a sessionKey carries no parentSessionKey", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		await HANDLERS.session_search({ query: "anything" }, ACTOR, daemon);
		const body = daemon.calls[0].body as Record<string, unknown>;
		expect(body.parentSessionKey).toBeUndefined();
		expect(body.sessionKey).toBeUndefined();
	});

	it("d-AC-5 a root child key carries the key but no parent", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		await HANDLERS.session_search({ query: "x", sessionKey: "rootonly" }, ACTOR, daemon);
		const body = daemon.calls[0].body as Record<string, unknown>;
		expect(body.sessionKey).toBe("rootonly");
		expect(body.parentSessionKey).toBeUndefined();
	});
});
