/**
 * The fleet check-in / heartbeat service — PRD-071a (AC-2 / AC-3 / AC-6 / AC-071a.2 / AC-071a.3).
 *
 * Writes and refreshes honeycomb's `service_status` row in the fleet telemetry SQLite (Contract B)
 * so hivedoctor can merge a live binding-time / last-seen / health view without honeycomb pushing
 * anything (ADR-0001). `start()` stamps the binding time for THIS process and writes the initial
 * row; a fixed-interval heartbeat then advances `last_seen` (and re-reads health) even when
 * nothing else changed, so hivedoctor can tell "quiet" apart from "dead" (AC-3 / AC-071a.3.1). A
 * restart re-stamps `binding_time` while the registry entry and DB path stay unchanged (AC-6 /
 * AC-071a.3.2) — that stability is `fleet-registry.ts` + `fleet-store.ts`'s job, not this module's.
 *
 * The health value is NEVER recomputed here (071a technical considerations): it is read from the
 * SAME thunk the daemon's own `/health` reports (`assemble.ts`'s cached `healthBit`), so the two
 * can never disagree (AC-071a.2.2).
 */

import type { DaemonService } from "../services/types.js";
import { FLEET_SERVICE_NAME, type FleetTelemetryStore } from "./fleet-store.js";
import { unrefTimer } from "./unref-timer.js";

/** The coarse health value read from the SAME source `/health` reports. */
export type FleetHealthValue = "ok" | "degraded" | "unconfigured";

/** An injectable clock so binding-time / last-seen are deterministic in tests. */
export interface CheckinClock {
	now(): Date;
}
export const systemCheckinClock: CheckinClock = { now: () => new Date() };

/** The heartbeat cadence (PRD-071 suggests every 5-10s; hivedoctor polls roughly every ~1s). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 7_500;

export interface CheckinDeps {
	/** The fleet telemetry store to write the status row into. */
	readonly store: FleetTelemetryStore;
	/** Read the SAME health value `/health` reports (never recomputed here). */
	readonly health: () => FleetHealthValue;
	/** Whether the DeepLake storage client is currently reachable, when the caller can tell. */
	readonly deeplakeConnected?: () => boolean;
	readonly heartbeatIntervalMs?: number;
	readonly clock?: CheckinClock;
	readonly serviceName?: string;
}

export interface CheckinService extends DaemonService {
	/** The binding time stamped by the most recent `start()`, or `undefined` before the first start. */
	readonly bindingTime: string | undefined;
	/** Test-only hook: run one heartbeat tick synchronously without waiting on the real interval. */
	_tickForTest?(): void;
}

/**
 * Create the real check-in service. `start()` stamps `binding_time` for this process lifetime and
 * writes the first status row synchronously (so a read immediately after `start()` resolves — no
 * "waiting for the first tick" window); `stop()` clears the heartbeat interval. `start`/`stop` are
 * idempotent-friendly per {@link DaemonService}.
 */
export function createCheckinService(deps: CheckinDeps): CheckinService {
	const clock = deps.clock ?? systemCheckinClock;
	const serviceName = deps.serviceName ?? FLEET_SERVICE_NAME;
	const intervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	let timer: ReturnType<typeof setInterval> | null = null;
	let bindingTimeIso: string | undefined;

	function writeStatus(): void {
		const nowIso = clock.now().toISOString();
		const connected = deps.deeplakeConnected?.();
		deps.store.upsertStatus({
			name: serviceName,
			bindingTime: bindingTimeIso ?? nowIso,
			lastSeen: nowIso,
			health: deps.health(),
			...(connected !== undefined
				? { deeplakeConnected: connected, ...(connected ? { deeplakeLastComm: nowIso } : {}) }
				: {}),
		});
	}

	return {
		get bindingTime(): string | undefined {
			return bindingTimeIso;
		},
		async start(): Promise<void> {
			// AC-6 / AC-071a.3.2: a restart re-stamps binding_time for the new process; the registry
			// entry + DB path (owned by fleet-registry.ts / fleet-store.ts) are untouched by this.
			bindingTimeIso = clock.now().toISOString();
			writeStatus();
			if (timer !== null) clearInterval(timer);
			timer = setInterval(writeStatus, intervalMs);
			// Never hold the process open just for this heartbeat (mirrors other daemon timers).
			unrefTimer(timer);
		},
		async stop(): Promise<void> {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
		_tickForTest(): void {
			writeStatus();
		},
	};
}

/** The inert stub the bootstrap defaults to (mirrors `noopJobQueueService`'s convention). */
export const noopCheckinService: CheckinService = Object.freeze({
	bindingTime: undefined,
	async start(): Promise<void> {},
	async stop(): Promise<void> {},
});
