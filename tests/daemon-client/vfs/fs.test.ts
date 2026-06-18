/**
 * PRD-015a a-AC-4 / a-AC-6 — session EPERM + dispatch-only storage.
 *
 * Sessions are an append-only event log: write/append/rm/cp/mv targeting a session path
 * reject with EPERM, BEFORE any dispatch (the guard runs first → storage is never touched).
 * Every storage-reaching op goes through the fake dispatch seam — there is no other path,
 * so the thin-client invariant (`DeepLakeFs` opens no DeepLake) holds by construction.
 */

import { describe, expect, it } from "vitest";

import {
	createFakeDaemonDispatch,
	createFakeSnapshotLoader,
	DeepLakeFs,
	SessionPermissionError,
} from "../../../src/daemon-client/vfs/index.js";
import { SCOPE } from "./fixtures.js";

function makeFs() {
	const dispatch = createFakeDaemonDispatch({ respond: () => [] });
	const fs = new DeepLakeFs({ dispatch, scope: SCOPE, snapshots: createFakeSnapshotLoader(null) });
	return { fs, dispatch };
}

const SESSION_PATH = "sessions/2026-06-18/abc.md";

describe("a-AC-4 sessions are append-only — write/append/rm/cp/mv → EPERM", () => {
	it("a-AC-4 writeFile on a session path → EPERM, no dispatch", async () => {
		const { fs, dispatch } = makeFs();
		await expect(fs.writeFile(SESSION_PATH, "x")).rejects.toMatchObject({ code: "EPERM" });
		expect(dispatch.calls).toEqual([]); // rejected BEFORE storage
	});

	it("a-AC-4 appendFile on a session path → EPERM", async () => {
		const { fs } = makeFs();
		await expect(fs.appendFile(SESSION_PATH, "x")).rejects.toBeInstanceOf(SessionPermissionError);
	});

	it("a-AC-4 rm on a session path → EPERM", async () => {
		const { fs } = makeFs();
		await expect(fs.rm(SESSION_PATH)).rejects.toMatchObject({ code: "EPERM" });
	});

	it("a-AC-4 cp where the SOURCE is a session → EPERM", async () => {
		const { fs } = makeFs();
		await expect(fs.cp(SESSION_PATH, "notes/x.md")).rejects.toMatchObject({ code: "EPERM" });
	});

	it("a-AC-4 cp where the DEST is a session → EPERM", async () => {
		const { fs } = makeFs();
		await expect(fs.cp("notes/x.md", SESSION_PATH)).rejects.toMatchObject({ code: "EPERM" });
	});

	it("a-AC-4 mv where either side is a session → EPERM", async () => {
		const { fs } = makeFs();
		await expect(fs.mv(SESSION_PATH, "notes/x.md")).rejects.toMatchObject({ code: "EPERM" });
		await expect(fs.mv("notes/x.md", SESSION_PATH)).rejects.toMatchObject({ code: "EPERM" });
	});

	it("a-AC-4 the EPERM applies regardless of path shape (host-absolute mount)", async () => {
		const { fs } = makeFs();
		await expect(fs.writeFile("/home/u/.honeycomb/memory/sessions/x.md", "x")).rejects.toMatchObject({
			code: "EPERM",
		});
	});
});

describe("a-AC-6 a non-session write routes to the 015b buffer, never opens DeepLake", () => {
	it("a-AC-6 a memory write is ACCEPTED (not EPERM), buffered, and dispatches NO SQL synchronously", async () => {
		// 015b now fills the buffer: a memory write is NOT rejected as EPERM (it is routed), it
		// lands in the shared pending map (visible to the read tier-4 buffer), and the enqueue
		// itself reaches storage ZERO times — the flush (debounced/batched) dispatches later,
		// always through the seam, never opening DeepLake.
		const dispatch = createFakeDaemonDispatch({ respond: () => [] });
		const pending = new Map();
		const fs = new DeepLakeFs({
			dispatch,
			scope: SCOPE,
			snapshots: createFakeSnapshotLoader(null),
			pending,
		});
		await fs.writeFile("notes/keep.md", "hello");
		// Accepted + buffered (cat-after-write sees it via the pending tier), no EPERM, no SQL yet.
		expect(pending.get("notes/keep.md")?.body).toBe("hello");
		expect(dispatch.calls).toEqual([]);
	});
});
