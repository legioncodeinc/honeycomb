/**
 * The DETACHED HYGIENE CHILD entry point — runs the session-start side-effecting seams
 * (autoPullSkills / autoPullAssets / spawnGraphPull) in a child process that the hook
 * parent spawned via `child_process.spawn(..., { detached: true })` + `unref()`.
 *
 * ── WHY THIS EXISTS (the latency-budget fix) ──────────────────────────────────
 * The hook parent (the `bundle/index.js` Claude Code invokes on SessionStart) used to
 * run these three seams IN-PROCESS via `backgroundPull` (which detaches the await but
 * NOT the underlying fetch I/O). The pending loopback sockets kept the parent's event
 * loop alive for ~seconds AFTER the response was written, so Claude Code's hook runner
 * perceived the hook as still running — re-introducing the very timeout the
 * fire-and-forget refactor was meant to escape. Calling `process.exit(0)` in the
 * parent to force exit CRASHES on Windows (libuv assertion when sockets are
 * mid-flight: `!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c:76).
 *
 * The fix: the parent writes its response, then spawns THIS child detached + unref'd,
 * then exits naturally with NO in-flight hygiene I/O. This child takes over the
 * hygiene work in its OWN process; the parent's loop empties immediately and exits
 * cleanly on every platform. The child's lifetime is decoupled — it runs to completion
 * and exits on its own; if it crashes, the fail-soft contract still holds (the parent
 * already returned a successful response and the seams are idempotent so a missed pull
 * here just means the next session-start pulls again).
 *
 * ── CONTRACT ──────────────────────────────────────────────────────────────────
 * Input: the session metadata as JSON in the `HONEYCOMB_HYGIENE_META` env var (set by
 * the parent before spawn). The credential is re-read from disk via the SAME
 * `createCredentialReader` the parent uses (`~/.deeplake/credentials.json`) — the child
 * inherits the parent's HOME, so the file resolves the same way. NO secrets are passed
 * via argv/env (the credential never leaves disk → process).
 *
 * Output: none. The child writes nothing to stdout (the parent already owns stdout).
 * Failures write a single line to stderr and exit 0 (never non-zero — a hygiene
 * failure is best-effort, not a hook failure, and a non-zero exit would surface as a
 * spurious error in some monitors).
 *
 * ── THIN CLIENT (D-2) ─────────────────────────────────────────────────────────
 * Same discipline as `index.ts`: NO DeepLake. The seams POST to the loopback daemon.
 */

import { createCredentialReader } from "../../../src/hooks/shared/credential-reader.js";
import { createSessionStartSeams } from "../../../src/hooks/shared/session-start-seams.js";
import type { HookSessionMeta } from "../../../src/hooks/shared/contracts.js";

/** The env var the parent sets to pass the session metadata JSON to this child. */
export const HYGIENE_META_ENV = "HONEYCOMB_HYGIENE_META" as const;

/**
 * Run the three hygiene seams in this child process. Reads the meta from the env,
 * reads the credential from disk, builds the production seams, and awaits the three
 * pulls (skills + assets + graph). Fully fail-soft: any error is swallowed and the
 * child exits 0. Never throws.
 */
export async function runHygieneChild(): Promise<void> {
	let meta: HookSessionMeta;
	try {
		const raw = process.env[HYGIENE_META_ENV];
		if (typeof raw !== "string" || raw.length === 0) return;
		const parsed = JSON.parse(raw) as Partial<HookSessionMeta>;
		meta = {
			sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "hygiene-child",
			path: typeof parsed.path === "string" ? parsed.path : "conversations/hygiene",
			...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
		};
	} catch {
		// Malformed/missing meta → nothing to do. Exit clean (best-effort).
		return;
	}

	try {
		const credentials = createCredentialReader();
		const credential = await credentials.read();
		const seams = createSessionStartSeams({ credentials });
		// Run the three side-effecting pulls. Each seam is already fail-soft + idempotent +
		// time-budgeted, so a failure in one does not block the others (they are sequenced
		// only for determinism, not because there is a dependency between them).
		await seams.autoPullSkills(credential).catch(() => {});
		await seams.autoPullAssets(credential).catch(() => {});
		await seams.spawnGraphPull(meta).catch(() => {});
	} catch (err) {
		// A wiring-level failure (credential read, seam construction) — surface ONE line so
		// an operator with stderr capture can see why hygiene stopped, but never fail the child.
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: hygiene child failed (fail-soft): ${reason}\n`);
	}
}

// Production: when invoked as the bundled binary, run the hygiene pulls. Never on
// import — a test imports `runHygieneChild` to drive it deterministically.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith("/hygiene.js")) {
	void runHygieneChild().finally(() => {
		// The child has NO response to emit, so let the loop drain naturally once the pulls
		// settle. The seams' own timeouts bound how long this takes.
	});
}
