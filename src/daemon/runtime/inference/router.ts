/**
 * Inference router HARNESS — PRD-010 Wave 1 (the routing skeleton 010b fills).
 *
 * This is the SKELETON Wave 2 (010b) fills. It implements {@link InferenceRouter}
 * against the resolved {@link InferenceConfig} + a {@link ProviderTransport} + a
 * {@link SecretResolver} + a {@link RoutingHistoryStore}, and wires the SHAPE of
 * the routing pipeline as four internal seams 010b implements:
 *
 *   selectCandidates(workload)        → the targets the workload's policy reaches
 *     → applyGates(candidates, request) → drop targets failing privacy/capability/
 *                                         context (D-4 / b-AC-1)
 *     → selectByMode(survivors, policy) → strict chain / automatic score / hybrid
 *                                         allowlist (D-5 / b-AC-2)
 *     → executeWithFallback(...)        → call targets in order, 4xx/5xx → next,
 *                                         401 → mark account expired (D-6 / b-AC-3/4/5)
 *
 * ── What Wave 1 wires vs. what 010b fills ───────────────────────────────────
 * Wave 1 makes `explain`/`execute`/`stream`/`cancel` EXIST, threads the seams, and
 * RECORDS a redacted event to the {@link RoutingHistoryStore} on every decision.
 * The gate/mode/fallback BODIES are clearly-marked `// WAVE 2 (010b)` stubs that
 * throw {@link notImplemented} — EXCEPT the trivial `explain` case (a single-target
 * policy or a no-candidate policy), which actually resolves so the harness is
 * exercised end-to-end this wave (the decision is built, the event is recorded).
 * `execute`/`stream` delegate to the stubbed fallback path and so throw until 010b
 * fills it; they are honest stubs, never fake-passing.
 *
 * ── The redaction discipline ────────────────────────────────────────────────
 * Every decision is mapped to a {@link RedactedRoutingEvent} via
 * {@link toRedactedEvent} (the single sanctioned decision → event projection) and
 * recorded. A resolved secret value lives ONLY inside `executeWithFallback`'s local
 * scope for the duration of a provider call — it never enters a {@link Target}, a
 * {@link RoutingDecision}, or the recorded event.
 *
 * ── Daemon assembly is DEFERRED (D-9) ───────────────────────────────────────
 * {@link RouterModelClient} adapts the 006 `ModelClient` onto this router. Daemon
 * assembly swaps `noopModelClient` for `new RouterModelClient(router)` — that
 * wiring lands in a LATER step (a documented TODO at the assembly site), NOT this
 * wave. Tests still inject the fake `ModelClient`; the stage code is byte-identical.
 */

import type { ModelClient, ModelRequest, ModelWorkload } from "../pipeline/model-client.js";
import { toModelRequest } from "../pipeline/model-client.js";
import {
	type Account,
	type AttemptRecord,
	type ExecuteResult,
	type InferenceConfig,
	type InferenceRequest,
	type InferenceRouter,
	noopRoutingHistoryStore,
	type Policy,
	ProviderError,
	type ProviderChunk,
	type ProviderTransport,
	type RoutingDecision,
	type RoutingHistoryStore,
	type SecretResolver,
	type StreamResult,
	type Target,
	tierRank,
	tierSatisfies,
	toRedactedEvent,
	type Workload,
} from "./contracts.js";

/** Construction deps for the {@link Router} harness. */
export interface RouterDeps {
	/** The resolved + cross-ref-validated inference config (010a). */
	readonly config: InferenceConfig;
	/** The provider-call seam (fake in tests; real HTTP is a later thin addition). */
	readonly transport: ProviderTransport;
	/** The secret-resolution seam (fake in tests; PRD-012 builds the real one). */
	readonly secrets: SecretResolver;
	/** The telemetry sink; defaults to the no-op store. */
	readonly history?: RoutingHistoryStore;
}

/**
 * The router harness. Construct via {@link createInferenceRouter}. `explain` works
 * for the trivial case this wave; `execute`/`stream` delegate to the 010b-stubbed
 * fallback path. Active stream cancel handles are keyed by request id so
 * {@link cancel} (010c c-AC-4 DELETE) reaches them.
 */
export class Router implements InferenceRouter {
	private readonly config: InferenceConfig;
	private readonly transport: ProviderTransport;
	private readonly secrets: SecretResolver;
	private readonly history: RoutingHistoryStore;
	/** Active stream cancel handles, keyed by request id (c-AC-4). */
	private readonly activeStreams = new Map<string, () => void>();
	/**
	 * Accounts marked expired in-memory for the process lifetime (D-6 / b-AC-5). A
	 * 401 from a provider adds the account id here; later requests degrade its
	 * targets out. 010b populates this in `executeWithFallback`; the field lives on
	 * the harness so the state survives across requests.
	 */
	private readonly expiredAccounts = new Set<string>();

	constructor(deps: RouterDeps) {
		this.config = deps.config;
		this.transport = deps.transport;
		this.secrets = deps.secrets;
		this.history = deps.history ?? noopRoutingHistoryStore;
	}

	/**
	 * Resolve the routing decision for a request WITHOUT executing inference
	 * (b-AC-6 / c-AC-1 / d-AC-1). Wave 1 resolves the TRIVIAL case fully so the
	 * harness is exercised: a workload whose policy reaches zero or one candidate
	 * needs no gate/mode machinery, so the decision is `servingTarget = the single
	 * target` (or `null` when none), with the attempt recorded as `selected`.
	 *
	 * A multi-candidate policy needs the 010b gate + mode pipeline; that path throws
	 * {@link notImplemented} until 010b fills `applyGates`/`selectByMode`. Either
	 * way the resulting decision is recorded as a redacted event.
	 */
	async explain(request: InferenceRequest): Promise<RoutingDecision> {
		const decision = this.publicDecision(this.resolveDecision(request));
		await this.record(request, decision);
		return decision;
	}

	/**
	 * Route + execute a non-streamed request. Wave 1 delegates the provider call to
	 * the 010b-stubbed {@link executeWithFallback}; until 010b fills it, this throws
	 * for any request that resolves to a serving target. The decision is recorded
	 * before the (stubbed) execution so telemetry captures the routing intent.
	 */
	async execute(request: InferenceRequest): Promise<ExecuteResult> {
		const routed = this.resolveDecision(request);
		try {
			const { decision, output } = await this.executeWithFallback(request, routed);
			await this.record(request, decision);
			return { decision, output };
		} catch (err) {
			// Record the true (exhausted) attempt sequence before surfacing the error.
			if (err instanceof RoutingExhaustedError) {
				await this.record(request, err.decision);
			}
			throw err;
		}
	}

	/**
	 * Route + stream a request; the result carries a cancel handle keyed by request
	 * id (c-AC-2 / c-AC-4). Wave 1 delegates the streaming provider call to the
	 * 010b-stubbed {@link streamWithFallback}; until 010b fills it, this throws for
	 * any request that resolves to a serving target.
	 */
	async stream(request: InferenceRequest): Promise<StreamResult> {
		const routed = this.resolveDecision(request);
		try {
			const result = await this.streamWithFallback(request, routed);
			await this.record(request, result.decision);
			return result;
		} catch (err) {
			if (err instanceof RoutingExhaustedError) {
				await this.record(request, err.decision);
			}
			throw err;
		}
	}

	/**
	 * Cancel an active stream by request id (c-AC-4 DELETE). Returns true when a
	 * live stream was found and cancelled. The cancel handle is registered by
	 * {@link streamWithFallback} (010b) when a stream starts and removed when it ends.
	 */
	cancel(requestId: string): boolean {
		const handle = this.activeStreams.get(requestId);
		if (handle === undefined) return false;
		handle();
		this.activeStreams.delete(requestId);
		return true;
	}

	// ── Internal routing seams (Wave 1 shape; 010b fills the bodies) ──────────

	/**
	 * Build the routing decision for a request (b-AC-1/b-AC-2/b-AC-3/b-AC-6). The
	 * pipeline, in order:
	 *
	 *   selectCandidates → degradeUnavailable (b-AC-3) → applyGates (b-AC-1)
	 *     → selectByMode (b-AC-2) → an ordered list of survivors.
	 *
	 * The decision's `servingTarget` is the FIRST survivor in mode order (the target
	 * the router WOULD serve — `explain` stops here, never touching the transport,
	 * b-AC-6). `executeWithFallback` later walks the same ordered survivors trying
	 * each in turn (b-AC-4), so the `attempts` here are the gate `blocked` records
	 * plus a single `selected` for the head survivor; `execute`/`stream` REPLACE
	 * those attempts with the real attempt sequence once the provider calls run.
	 *
	 * A degrade (missing/expired account) and a gate block both keep the target OUT
	 * of the survivor set; the distinction is preserved in the reason string for
	 * telemetry attribution (degrades read `account:*`, gate blocks read the gate
	 * name) per the 010b implementation notes.
	 */
	private resolveDecision(request: InferenceRequest): RoutingDecision {
		const workload = this.workloadFor(request.workload);
		const policy = this.policyFor(workload.policyRef);
		const candidates = this.selectCandidates(workload, policy);

		const blocked: { targetId: string; reason: string }[] = [];
		const attempts: AttemptRecord[] = [];

		// b-AC-3 — degrade targets whose account is missing or expired OUT of the set;
		// survivors remain eligible. Recorded so the decision explains the degrade.
		const available = this.degradeUnavailable(candidates, blocked, attempts);

		// b-AC-1 — hard gates: privacy / capability / context. A failure blocks the
		// candidate outright, BEFORE mode selection.
		const survivors = this.applyGates(available, workload, request, blocked, attempts);

		// b-AC-2 — order the survivors by the policy mode.
		const ordered = this.selectByMode(survivors, policy);

		const serving = ordered[0];
		if (serving !== undefined) {
			attempts.push({ targetId: serving.id, outcome: "selected" });
		}

		// `orderedTargets` is internal routing state the execute/stream paths read to
		// walk the fallback chain; it is NOT part of the on-disk event (stripped by
		// `withAttempts` / `publicDecision` before recording).
		const decision: RoutingDecision & { orderedTargets: readonly Target[] } = {
			servingTarget: serving?.id ?? null,
			attempts,
			mode: policy.mode,
			workload: workload.name,
			blockedCandidates: blocked,
			orderedTargets: ordered,
		};
		return decision;
	}

	/**
	 * The set of targets a policy can reach (its chain ∪ allowlist, or all targets
	 * for an automatic policy with neither). Pure config navigation — no gating yet.
	 * `applyGates` filters this set; `selectByMode` orders it.
	 *
	 * Order matters: chain order is the declaration order strict mode follows and the
	 * stable tiebreak the scorers fall back on, so the chain is walked first (in
	 * order), then any allowlist-only ids, then (for an automatic policy with no
	 * explicit set) config-declaration order.
	 */
	private selectCandidates(_workload: Workload, policy: Policy): Target[] {
		const byId = new Map(this.config.targets.map((t) => [t.id, t]));
		const ordered: string[] = [...policy.chain, ...(policy.allowlist ?? [])];
		if (ordered.length === 0) {
			// An automatic policy with no explicit set scores ALL targets (in config order).
			return policy.mode === "automatic" ? [...this.config.targets] : [];
		}
		const seen = new Set<string>();
		const out: Target[] = [];
		for (const id of ordered) {
			if (seen.has(id)) continue;
			seen.add(id);
			const t = byId.get(id);
			if (t !== undefined) out.push(t);
		}
		return out;
	}

	/**
	 * b-AC-3 — degrade out every candidate whose account is missing (no such account
	 * in config) or marked expired in {@link expiredAccounts} (a prior 401, b-AC-5).
	 * The degraded targets are recorded as `blocked` attempts + blocked-candidates
	 * with an `account:*` reason (distinct from a gate block) so telemetry can
	 * attribute the degrade. Survivors are returned in input order.
	 */
	private degradeUnavailable(
		candidates: readonly Target[],
		blocked: { targetId: string; reason: string }[],
		attempts: AttemptRecord[],
	): Target[] {
		const out: Target[] = [];
		for (const target of candidates) {
			const account = this.accountFor(target.accountRef);
			if (account === undefined) {
				const reason = "account:missing";
				blocked.push({ targetId: target.id, reason });
				attempts.push({ targetId: target.id, outcome: "blocked", reason });
				continue;
			}
			if (this.expiredAccounts.has(account.id)) {
				const reason = "account:expired";
				blocked.push({ targetId: target.id, reason });
				attempts.push({ targetId: target.id, outcome: "blocked", reason });
				continue;
			}
			out.push(target);
		}
		return out;
	}

	/**
	 * b-AC-1 — the hard gates. A candidate is BLOCKED outright when it fails ANY of:
	 *
	 *   - privacy:    `tierSatisfies(target.privacyTier, workload.minPrivacyTier)` is
	 *                 false — the target is LESS private than the workload requires.
	 *   - capability: `target.capabilities` is NOT a superset of
	 *                 `workload.requiredCapabilities`.
	 *   - context:    a context size is known for the request
	 *                 (`request.contextTokens` ?? `workload.requestContextTokens`) and
	 *                 `target.contextWindow` is smaller than it.
	 *
	 * Each block appends a `blocked` AttemptRecord + a blocked-candidate carrying the
	 * gate name so the decision explains WHY. Gates run BEFORE mode selection.
	 * Survivors are returned in input order (mode selection re-orders them).
	 */
	private applyGates(
		candidates: readonly Target[],
		workload: Workload,
		request: InferenceRequest,
		blocked: { targetId: string; reason: string }[],
		attempts: AttemptRecord[],
	): Target[] {
		const contextTokens = request.contextTokens ?? workload.requestContextTokens;
		const out: Target[] = [];
		for (const target of candidates) {
			const reason = gateReason(target, workload, contextTokens);
			if (reason !== null) {
				blocked.push({ targetId: target.id, reason });
				attempts.push({ targetId: target.id, outcome: "blocked", reason });
				continue;
			}
			out.push(target);
		}
		return out;
	}

	/**
	 * b-AC-2 — order the surviving candidates by the policy mode:
	 *
	 *   - `strict`    — keep the explicit `chain` order exactly (no scoring). Survivors
	 *                   are already in chain order from {@link selectCandidates}, so
	 *                   this is the identity ordering.
	 *   - `automatic` — SCORE all survivors and order best-first (see {@link scoreOrder}).
	 *   - `hybrid`    — score, but only WITHIN the policy's `allowlist`; a survivor not
	 *                   in the allowlist is dropped from selection here (it already
	 *                   passed the gates, but hybrid restricts scoring to the allowlist).
	 *
	 * The scoring function (automatic + hybrid) is DETERMINISTIC — no `Math.random`.
	 * See {@link scoreOrder} for the documented key.
	 */
	private selectByMode(survivors: readonly Target[], policy: Policy): Target[] {
		if (policy.mode === "strict") return [...survivors];
		if (policy.mode === "hybrid") {
			const allow = new Set(policy.allowlist ?? []);
			return scoreOrder(survivors.filter((t) => allow.has(t.id)));
		}
		// automatic
		return scoreOrder(survivors);
	}

	/**
	 * Execute the decision's ordered survivors with fallback (b-AC-3/b-AC-4/b-AC-5).
	 * Walks the survivors in mode order; for each it resolves the account secret
	 * through the {@link SecretResolver} (the resolved value lives ONLY in this local
	 * scope, never stored/logged) and calls {@link ProviderTransport.execute}.
	 *
	 *   - success      → append a `selected` attempt and return the output.
	 *   - 401          → mark the account expired in {@link expiredAccounts} (b-AC-5,
	 *                    in-memory, process lifetime), append a `failed` attempt, and
	 *                    skip the rest of THIS account's targets in the chain (b-AC-3),
	 *                    then continue the fallback.
	 *   - other 4xx/5xx → append a `failed` attempt and fall to the next survivor (b-AC-4).
	 *
	 * The `attempts` recorded here REPLACE the head `selected` placeholder from
	 * {@link resolveDecision}: the gate `blocked` records are preserved and the real
	 * provider attempt sequence (failures + the final selection) is appended in order.
	 * Returns the final {@link RoutingDecision} alongside the output so the caller
	 * records the true sequence.
	 */
	private async executeWithFallback(
		request: InferenceRequest,
		decision: RoutingDecision,
	): Promise<{ decision: RoutingDecision; output: string }> {
		const ordered = orderedTargetsOf(decision);
		const gateBlocks = decision.attempts.filter((a) => a.outcome === "blocked");
		const runAttempts: AttemptRecord[] = [];
		const expiredThisRun = new Set<string>();

		for (const target of ordered) {
			const account = this.accountFor(target.accountRef);
			if (account === undefined || expiredThisRun.has(account.id)) {
				// Account vanished or was just expired by an earlier 401 this run — degrade.
				runAttempts.push({ targetId: target.id, outcome: "blocked", reason: "account:expired" });
				continue;
			}
			try {
				const apiKey = await this.secrets.resolve(account.apiKeyRef);
				const result = await this.transport.execute({ target, apiKey, request });
				runAttempts.push({ targetId: target.id, outcome: "selected" });
				const finalDecision = this.withAttempts(decision, gateBlocks, runAttempts, target.id);
				return { decision: finalDecision, output: result.output };
			} catch (err) {
				const statusCode = providerStatus(err);
				runAttempts.push({ targetId: target.id, outcome: "failed", statusCode });
				if (statusCode === 401) {
					// b-AC-5 — mark the account expired in-memory for the process lifetime.
					this.expiredAccounts.add(account.id);
					expiredThisRun.add(account.id);
				}
				// b-AC-4 — any non-401 4xx/5xx (and a 401, after marking) falls through
				// to the next allowed target.
			}
		}

		// Chain exhausted with no serving target.
		const finalDecision = this.withAttempts(decision, gateBlocks, runAttempts, null);
		throw new RoutingExhaustedError(finalDecision);
	}

	/**
	 * The streaming counterpart of {@link executeWithFallback} (c-AC-2). Walks the
	 * ordered survivors; the first that does not immediately throw a
	 * {@link ProviderError} on its first chunk serves the stream. Registers a cancel
	 * handle keyed by request id (c-AC-4) for the lifetime of the stream. The 401 /
	 * 4xx / 5xx fallback + account-expiry rules mirror {@link executeWithFallback}.
	 */
	private async streamWithFallback(request: InferenceRequest, decision: RoutingDecision): Promise<StreamResult> {
		const ordered = orderedTargetsOf(decision);
		const gateBlocks = decision.attempts.filter((a) => a.outcome === "blocked");
		const runAttempts: AttemptRecord[] = [];
		const expiredThisRun = new Set<string>();

		for (const target of ordered) {
			const account = this.accountFor(target.accountRef);
			if (account === undefined || expiredThisRun.has(account.id)) {
				runAttempts.push({ targetId: target.id, outcome: "blocked", reason: "account:expired" });
				continue;
			}
			let iterator: AsyncIterator<ProviderChunk>;
			let first: IteratorResult<ProviderChunk>;
			try {
				const apiKey = await this.secrets.resolve(account.apiKeyRef);
				const iterable = this.transport.stream({ target, apiKey, request });
				iterator = iterable[Symbol.asyncIterator]();
				// Prime the first chunk so a synchronous provider failure triggers fallback.
				first = await iterator.next();
			} catch (err) {
				const statusCode = providerStatus(err);
				runAttempts.push({ targetId: target.id, outcome: "failed", statusCode });
				if (statusCode === 401) {
					this.expiredAccounts.add(account.id);
					expiredThisRun.add(account.id);
				}
				continue;
			}

			runAttempts.push({ targetId: target.id, outcome: "selected" });
			const finalDecision = this.withAttempts(decision, gateBlocks, runAttempts, target.id);

			let cancelled = false;
			const cancel = (): void => {
				cancelled = true;
				this.activeStreams.delete(request.requestId);
				void iterator.return?.(undefined);
			};
			this.activeStreams.set(request.requestId, cancel);

			const self = this;
			async function* chunks(): AsyncIterable<ProviderChunk> {
				try {
					let cur = first;
					while (!cur.done) {
						if (cancelled) return;
						yield cur.value;
						cur = await iterator.next();
					}
				} finally {
					self.activeStreams.delete(request.requestId);
				}
			}

			return { decision: finalDecision, chunks: chunks(), cancel };
		}

		const finalDecision = this.withAttempts(decision, gateBlocks, runAttempts, null);
		throw new RoutingExhaustedError(finalDecision);
	}

	/**
	 * Rebuild a {@link RoutingDecision} after execution: the gate `blocked` records
	 * (preserved from {@link resolveDecision}) followed by the real provider attempt
	 * sequence, with `servingTarget` set to the target that served (or null). Strips
	 * the internal `orderedTargets` field so the recorded event stays redaction-safe.
	 */
	private withAttempts(
		decision: RoutingDecision,
		gateBlocks: readonly AttemptRecord[],
		runAttempts: readonly AttemptRecord[],
		servingTarget: string | null,
	): RoutingDecision {
		return {
			servingTarget,
			attempts: [...gateBlocks, ...runAttempts],
			mode: decision.mode,
			workload: decision.workload,
			blockedCandidates: decision.blockedCandidates,
		};
	}

	// ── Config navigation + telemetry ────────────────────────────────────────

	/** Look up a {@link Workload} by name; throws naming the unknown workload. */
	private workloadFor(name: string): Workload {
		const w = this.config.workloads.find((x) => x.name === name);
		if (w === undefined) throw new Error(`inference: no workload named "${name}"`);
		return w;
	}

	/** Look up a {@link Policy} by id; throws naming the unknown policy. */
	private policyFor(id: string): Policy {
		const p = this.config.policies.find((x) => x.id === id);
		if (p === undefined) throw new Error(`inference: no policy named "${id}"`);
		return p;
	}

	/** Look up an {@link Account} by id; returns undefined when missing (b-AC-3 degrade). */
	private accountFor(id: string): Account | undefined {
		return this.config.accounts.find((x) => x.id === id);
	}

	/**
	 * Strip the internal `orderedTargets` field off a resolved decision so the value
	 * `explain` returns (and records) is a clean {@link RoutingDecision} carrying only
	 * the redaction-safe fields. `execute`/`stream` go through {@link withAttempts}
	 * which already omits it; `explain` uses this.
	 */
	private publicDecision(decision: RoutingDecision): RoutingDecision {
		return {
			servingTarget: decision.servingTarget,
			attempts: decision.attempts,
			mode: decision.mode,
			workload: decision.workload,
			blockedCandidates: decision.blockedCandidates,
		};
	}

	/** Map the decision to a redacted event and record it (D-7). Never carries a secret/body. */
	private async record(request: InferenceRequest, decision: RoutingDecision): Promise<void> {
		await this.history.record(toRedactedEvent(request, decision));
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Module-level routing helpers (pure; the gate predicate + the scorer + the
// internal-state accessors the execute/stream paths read).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Raised when the fallback chain is exhausted with no serving target (b-AC-4 /
 * the 010b open-question "what error shape when the chain is exhausted"). Carries
 * the final {@link RoutingDecision} (the full redacted attempt sequence) so the
 * caller records the true telemetry before surfacing the error to the gateway.
 */
export class RoutingExhaustedError extends Error {
	readonly decision: RoutingDecision;
	constructor(decision: RoutingDecision) {
		super(`inference: routing chain exhausted for workload "${decision.workload}" (no target served)`);
		this.name = "RoutingExhaustedError";
		this.decision = decision;
	}
}

/**
 * The hard-gate predicate (b-AC-1). Returns the gate name a target FAILS, or null
 * when it passes every gate. Pure. Order: privacy → capability → context (the
 * first failing gate names the block reason).
 *
 *   - `gate:privacy`    — `tierSatisfies(target, floor)` false (target less private).
 *   - `gate:capability` — target capabilities not a superset of required.
 *   - `gate:context`    — a context size is known and exceeds `target.contextWindow`.
 */
function gateReason(target: Target, workload: Workload, contextTokens: number | undefined): string | null {
	if (!tierSatisfies(target.privacyTier, workload.minPrivacyTier)) return "gate:privacy";
	const caps = new Set(target.capabilities);
	for (const required of workload.requiredCapabilities) {
		if (!caps.has(required)) return "gate:capability";
	}
	if (contextTokens !== undefined && target.contextWindow < contextTokens) return "gate:context";
	return null;
}

/**
 * The DETERMINISTIC scoring order for `automatic` / `hybrid` modes (b-AC-2). NO
 * `Math.random`, NO clock — a pure total order over the surviving targets so a
 * given config + request always yields the same ordering (stable + reproducible
 * telemetry). The composite key, applied in priority order:
 *
 *   1. privacy-tier rank DESC — prefer the MORE private target (the safer default;
 *      a survivor already satisfies the floor, so preferring higher privacy never
 *      violates the workload and biases toward the stronger-isolation provider).
 *   2. context window DESC — prefer the larger context window (more headroom; the
 *      target least likely to truncate a future-larger request).
 *   3. declaration order ASC — the input order (chain ∪ allowlist ∪ config order)
 *      as the final STABLE tiebreak, so equal-scoring targets keep their declared
 *      precedence and the order is fully determined.
 *
 * Returns a NEW array; does not mutate the input.
 */
function scoreOrder(targets: readonly Target[]): Target[] {
	return targets
		.map((target, index) => ({ target, index }))
		.sort((a, b) => {
			const privacy = tierRank(b.target.privacyTier) - tierRank(a.target.privacyTier);
			if (privacy !== 0) return privacy;
			const context = b.target.contextWindow - a.target.contextWindow;
			if (context !== 0) return context;
			return a.index - b.index;
		})
		.map((entry) => entry.target);
}

/**
 * Read the internal `orderedTargets` routing state off a decision produced by
 * `resolveDecision` (the mode-ordered survivor list the execute/stream fallback
 * walks). The field is attached only to the in-flight decision, never to the
 * recorded {@link RedactedRoutingEvent}; falls back to empty if absent.
 */
function orderedTargetsOf(decision: RoutingDecision): readonly Target[] {
	const ordered = (decision as RoutingDecision & { orderedTargets?: readonly Target[] }).orderedTargets;
	return ordered ?? [];
}

/**
 * Extract the HTTP-like status code from a thrown provider error. A
 * {@link ProviderError} carries its `statusCode`; any other thrown value is
 * treated as a generic 500 so the engine still falls back rather than crashing.
 */
function providerStatus(err: unknown): number {
	if (err instanceof ProviderError) return err.statusCode;
	return 500;
}

/** Build a {@link Router}. The daemon injects the real deps; tests inject fakes. */
export function createInferenceRouter(deps: RouterDeps): InferenceRouter {
	return new Router(deps);
}

// ────────────────────────────────────────────────────────────────────────────
// RouterModelClient — the 006 ModelClient bridge (D-9).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Maps the three 006 `ModelClient` workload tokens onto inference workload names.
 * Wave 1 maps each `memory_*` token to an identically-named inference workload, so
 * an operator's `agent.yaml` declares `workloads: [{ name: memory_extraction, … }]`.
 * A token absent from a deployment's config surfaces as an explicit error at call
 * time (never a silent empty completion), which the caller treats as "no usable
 * output" per the seam contract.
 */
export const MODEL_WORKLOAD_TO_INFERENCE: Readonly<Record<ModelWorkload, string>> = Object.freeze({
	memory_extraction: "memory_extraction",
	memory_decision: "memory_decision",
	memory_dreaming: "memory_dreaming",
});

/**
 * The D-9 bridge: adapts the 006 {@link ModelClient} interface
 * (`complete(workload, prompt)`) onto an {@link InferenceRouter}. Maps the
 * `memory_*` workload onto the inference workload/policy, wraps the prompt as a
 * single-user-message OpenAI-shaped request, calls `execute`, and returns the raw
 * completion string (the seam stays raw-text-in / raw-text-out).
 *
 * Daemon assembly swaps `noopModelClient` for `new RouterModelClient(router)` (a
 * documented TODO at the assembly site) — NOT this wave. Until 010b fills
 * `executeWithFallback`, calling `complete` against a non-trivial route throws; the
 * stage's wrapper treats a rejection as "no usable output" (never fails the job),
 * so the bridge is safe to wire even before 010b lands.
 */
export class RouterModelClient implements ModelClient {
	private readonly router: InferenceRouter;
	private seq = 0;

	constructor(router: InferenceRouter) {
		this.router = router;
	}

	complete(request: ModelRequest): Promise<string>;
	complete(workload: ModelWorkload, prompt: string): Promise<string>;
	async complete(a: ModelRequest | ModelWorkload, b?: string): Promise<string> {
		const req = toModelRequest(a, b);
		const inferenceWorkload = MODEL_WORKLOAD_TO_INFERENCE[req.workload];
		const requestId = `mc-${req.workload}-${this.seq++}`;
		const result = await this.router.execute({
			requestId,
			workload: inferenceWorkload,
			messages: [{ role: "user", content: req.prompt }],
		});
		return result.output;
	}
}
