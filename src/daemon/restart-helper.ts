/**
 * The daemon RESTART helper — a tiny, short-lived, detached process the
 * `POST /api/actions/restart` handler spawns (`dashboard/actions-api.ts`).
 *
 * Why a separate process: the daemon enforces a single-instance lock, so a fresh daemon started
 * while the old one still holds the lock would see "already running" and exit — leaving nothing. A
 * self-respawn from inside the dying daemon cannot order itself after its own lock release. This
 * helper is an independent process: it WAITS for the old daemon to release the port/lock (its
 * `/health` stops answering), waits a short grace for the lock file to be removed, then starts a
 * fresh daemon detached and exits. The old daemon triggers its graceful shutdown right after
 * spawning this helper, so the sequence is: old drains → old exits → helper sees /health down →
 * helper starts new daemon → new daemon acquires the lock cleanly.
 *
 * It is intentionally dependency-free (node builtins + global `fetch` only) and fail-soft: if it
 * cannot determine the entry or the wait times out, it still attempts the spawn (a fresh daemon's
 * own stale-lock reclaim is the backstop) and never throws.
 *
 * Inputs (env, stamped by the restart handler):
 *   - HONEYCOMB_RESTART_ENTRY — absolute path to the daemon bundle entry (`daemon/index.js`).
 *   - HONEYCOMB_RESTART_PORT  — the loopback port to poll `/health` on (default 3850).
 */

import { spawn } from "node:child_process";

const port = Number(process.env.HONEYCOMB_RESTART_PORT ?? "3850");
const entry = process.env.HONEYCOMB_RESTART_ENTRY ?? "";

/** Poll cadence while waiting for the old daemon to go down. */
const POLL_INTERVAL_MS = 200;
/** Hard cap on the wait so the helper can never hang forever. */
const MAX_WAIT_MS = 30_000;
/** Per-probe timeout so the outer wait cap is actually enforceable (a wedged socket can't hang us). */
const POLL_TIMEOUT_MS = 1_000;
/** Grace after `/health` goes down, so the old daemon's lock-file removal completes. */
const LOCK_RELEASE_GRACE_MS = 800;

const healthUrl = `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 3850}/health`;

/**
 * True iff the old daemon still answers `/health` (it is still up / holds the lock). Each probe is
 * bounded by {@link POLL_TIMEOUT_MS}: a daemon that accepts the socket but never responds would
 * otherwise hang this `fetch` forever and the helper would never reach the respawn step. A timed-out
 * probe is treated as "still up" (keep waiting until the OUTER {@link MAX_WAIT_MS} deadline); a
 * connection refused/reset means the daemon is genuinely down.
 */
async function stillUp(): Promise<boolean> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS);
	try {
		// ANY completed HTTP response means the old daemon still holds the port/lock — a
		// 503-degraded daemon (storage unreachable pre-login) is still UP. Gating on `res.ok`
		// here would respawn while the old process still holds the single-instance lock.
		await fetch(healthUrl, { method: "GET", signal: ac.signal });
		return true;
	} catch (error) {
		// An aborted (timed-out) probe → still wedged → keep waiting. Refused/reset → down.
		return error instanceof Error && error.name === "AbortError";
	} finally {
		clearTimeout(timer);
	}
}

/** Sleep `ms` (a Promise wrapper around setTimeout, unref'd so it never holds the loop open). */
function sleep(ms: number): Promise<void> {
	return new Promise((r) => {
		const t = setTimeout(r, ms);
		// `unref` is available on the Timeout handle; guard for the typing.
		(t as { unref?: () => void }).unref?.();
	});
}

async function main(): Promise<void> {
	if (entry === "") return; // Nothing to start — the daemon will be re-upped by the next CLI/hook call.

	// Wait for the OLD daemon to release the port (its /health stops answering), bounded by MAX_WAIT_MS.
	const deadline = Date.now() + MAX_WAIT_MS;
	while (Date.now() < deadline) {
		if (!(await stillUp())) break;
		await sleep(POLL_INTERVAL_MS);
	}
	// Brief grace for the graceful-shutdown lock-file removal to land before the new daemon binds.
	await sleep(LOCK_RELEASE_GRACE_MS);

	// Start a fresh daemon, fully detached so it outlives this helper.
	const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore" });
	child.unref();
}

void main();
