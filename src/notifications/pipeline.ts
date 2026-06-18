/**
 * The notifications pipeline — PRD-020d (FR-1 / FR-2 / d-AC-1 / d-AC-3 / d-AC-4 / d-AC-5).
 *
 * `drain(session_start)`:
 *   1. read persistent state + the local sources (rules evaluated for the trigger + the queue),
 *      and fetch backend notifications THROUGH THE DAEMON — the local "primary-banner" fetch and
 *      the backend fetch run in PARALLEL, each bounded by an INDEPENDENT ~1.5s timeout (FR-2 /
 *      d-AC-3), so session-start latency stays ~1.5s even if one source hangs;
 *   2. FAIL-SOFT: any fetch that throws OR times out contributes ZERO candidates and NEVER blocks
 *      the session (FR-2 / d-AC-3);
 *   3. suppress already-shown persistent notifications (FR-5 / d-AC-4) and lost claim-race ones
 *      (FR-4 / d-AC-1); a transient that wins its claim re-emits each session (FR-6 / d-AC-5);
 *   4. pick the single primary banner under the priority model (higher wins; id as the stable
 *      tie-break), record a shown persistent in state, and return it.
 *
 * Thin client: backend notifications come via the {@link BackendNotificationSource} seam (FR-3),
 * never DeepLake. Every source is injected so a test drives the race (d-AC-1), the show-once
 * (d-AC-4), the re-emit (d-AC-5), and the hung-backend timeout (d-AC-3) deterministically.
 */

import {
	type BackendNotificationSource,
	type ClaimLock,
	type DrainResult,
	type Notification,
	type NotificationsPipeline,
	type NotificationsState,
	type NotificationTrigger,
	type PipelineDeps,
} from "./contracts.js";

/** The default per-fetch timeout budget (FR-2 / d-AC-3) — bounds session-start latency. */
export const DEFAULT_PIPELINE_TIMEOUT_MS = 1500;

/**
 * The local notification sources evaluated for a trigger (FR-1). `rules` is the "primary-banner"
 * fetch (rules evaluated for `session_start`); `queue` is the persistent queue. Both are local +
 * fast, but are still bounded by the per-fetch timeout so a pathological source can never hang
 * the session. Optional: an absent source contributes nothing.
 */
export interface NotificationSource {
	/** Produce the candidate notifications for the trigger. Bounded by the per-fetch timeout. */
	fetch(trigger: NotificationTrigger): Promise<readonly Notification[]>;
}

/**
 * The seams the pipeline drains against (FR-1..FR-6). Extends the stable {@link PipelineDeps}
 * (state + lock + backend + timeout) with the local rule/queue sources. Keeping the extension
 * here (not in `contracts.ts`) preserves the Wave-1 contract surface while wiring the full drain.
 */
export interface PipelineDepsFull extends PipelineDeps {
	/** The "primary-banner" rule source (rules evaluated for the trigger). Optional. */
	readonly rules?: NotificationSource;
	/** The persistent queue source. Optional. */
	readonly queue?: NotificationSource;
	/**
	 * Optional clock for the timeout (defaults to `setTimeout`/`clearTimeout`). A test injects a
	 * fake clock so the ~1.5s timeout fires deterministically (d-AC-3) without real wall time.
	 */
	readonly clock?: TimeoutClock;
}

/** A minimal timeout clock so a test drives the ~1.5s bound with a fake (d-AC-3). */
export interface TimeoutClock {
	/** Schedule `cb` after `ms`; returns a handle for {@link TimeoutClock.clear}. */
	setTimeout(cb: () => void, ms: number): unknown;
	/** Cancel a scheduled callback. */
	clear(handle: unknown): void;
}

/** The real `setTimeout`/`clearTimeout` clock. */
const realClock: TimeoutClock = {
	setTimeout(cb: () => void, ms: number): unknown {
		return setTimeout(cb, ms);
	},
	clear(handle: unknown): void {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/**
 * Race `work` against a `ms` timeout, FAIL-SOFT (FR-2 / d-AC-3). Resolves to `work`'s value on
 * success; resolves to `fallback` if `work` rejects OR the timeout fires first. NEVER rejects —
 * a hung or failing source can never block the session. The timer is always cleared so a
 * fake-clock test sees no dangling handle.
 */
async function withTimeoutSoft<T>(
	work: Promise<T>,
	ms: number,
	fallback: T,
	clock: TimeoutClock,
): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const finish = (value: T): void => {
			if (settled) return;
			settled = true;
			clock.clear(handle);
			resolve(value);
		};
		const handle = clock.setTimeout(() => finish(fallback), ms);
		work.then(
			(value) => finish(value),
			() => finish(fallback), // swallow the rejection (fail-soft, FR-2).
		);
	});
}

/** Fetch a source through the soft timeout, returning `[]` on hang/failure (fail-soft). */
async function fetchSoft(
	source: NotificationSource | BackendNotificationSource | undefined,
	trigger: NotificationTrigger,
	ms: number,
	clock: TimeoutClock,
): Promise<readonly Notification[]> {
	if (source === undefined) return [];
	// Both source shapes expose `fetch`; the backend's takes no arg, the local's takes the trigger.
	const work = (source as NotificationSource).fetch(trigger);
	return withTimeoutSoft(work, ms, [], clock);
}

/**
 * Pick the single primary banner under the priority model (FR-1). Higher `priority` wins; the id
 * (lexicographic) is the stable tie-break so the pick is deterministic across racing drains.
 * Returns `null` when there are no eligible candidates.
 */
function pickPrimary(candidates: readonly Notification[]): Notification | null {
	let best: Notification | null = null;
	for (const n of candidates) {
		if (best === null || n.priority > best.priority || (n.priority === best.priority && n.id < best.id)) {
			best = n;
		}
	}
	return best;
}

/** The claim key for a notification — transient ones share a per-id claim across racing procs. */
function claimKey(n: Notification): string {
	return `notif-${n.id}`;
}

/**
 * Build the {@link NotificationsPipeline} (FR-1 / FR-2). The persistent-state, claim-lock,
 * backend, and local rule/queue seams are all injected so a test drives the race (d-AC-1), the
 * show-once (d-AC-4), the re-emit (d-AC-5), and the timeout (d-AC-3) deterministically.
 */
export function createNotificationsPipeline(deps: PipelineDepsFull): NotificationsPipeline {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS;
	const clock = deps.clock ?? realClock;
	const state: NotificationsState = deps.state;
	const lock: ClaimLock = deps.lock;

	return {
		async drain(trigger: NotificationTrigger): Promise<DrainResult> {
			// 1. Fan out: the local "primary-banner" (rules) fetch, the queue fetch, and the backend
			// fetch run in PARALLEL, each independently bounded + fail-soft (FR-2 / d-AC-3).
			const [ruleN, queueN, backendN] = await Promise.all([
				fetchSoft(deps.rules, trigger, timeoutMs, clock),
				fetchSoft(deps.queue, trigger, timeoutMs, clock),
				fetchSoft(deps.backend, trigger, timeoutMs, clock),
			]);
			const candidates = [...ruleN, ...queueN, ...backendN];

			const suppressed: string[] = [];

			// 2. Suppress already-shown PERSISTENT notifications (show-once, FR-5 / d-AC-4).
			const afterStateFilter = candidates.filter((n) => {
				if (n.kind === "persistent") {
					const key = n.dedupKey ?? n.id;
					if (state.wasShown(key)) {
						suppressed.push(n.id);
						return false;
					}
				}
				return true;
			});

			// 3. Claim each remaining candidate. The FIRST process to claim a key wins (FR-4 /
			// d-AC-1); a racer that loses the claim is suppressed → exactly ONE banner across racing
			// procs. The claim is HELD for the whole drain — NEVER released mid-drain — so a
			// concurrent racer that already lost can never be "let back in" (the bug a synchronous
			// in-drain release would reintroduce). Re-emit of a transient (FR-6 / d-AC-5) is the
			// SESSION BOUNDARY's job, not this drain's: the claim file is per-session-ephemeral, so a
			// LATER session re-claims a released key. Tests drive that boundary with `lock.release`.
			const eligible: Notification[] = [];
			for (const n of afterStateFilter) {
				if (lock.claim(claimKey(n))) {
					eligible.push(n);
				} else {
					suppressed.push(n.id);
				}
			}

			// 4. Pick the single primary banner under the priority model (FR-1).
			const banner = pickPrimary(eligible);

			// 5. Book-keeping. The chosen PERSISTENT banner is recorded as shown (show-once next
			// session, FR-5 / d-AC-4) — a re-show is then suppressed by state, NOT by the claim. A
			// transient records NOTHING in state, so once the session boundary releases its claim it
			// re-emits while the cause persists (FR-6 / d-AC-5). No claim is released here.
			if (banner !== null && banner.kind === "persistent") {
				state.markShown({
					id: banner.id,
					dedupKey: banner.dedupKey ?? banner.id,
					shownAt: new Date().toISOString(),
				});
			}

			return { banner, suppressed };
		},
	};
}
