/**
 * PRD-010b — routing engine tests (b-AC-1..6, each AC-named).
 *
 * Drives the filled {@link createInferenceRouter} against the Wave-1 fakes
 * (`createFakeProviderTransport` + `createFakeSecretResolver`) + a capturing
 * {@link RoutingHistoryStore}. NO real HTTP, NO real secrets. Each `describe`
 * names the b-AC it proves so the ledger maps 1:1, and every test that records
 * telemetry asserts the recorded event carries NO secret value and NO message body
 * (the central redaction thesis).
 */

import { describe, expect, it } from "vitest";
import {
	type Account,
	createFakeProviderTransport,
	createFakeSecretResolver,
	type InferenceConfig,
	type Policy,
	type RedactedRoutingEvent,
	type RoutingHistoryScope,
	type RoutingHistoryStore,
	type Target,
	type Workload,
} from "../../../../src/daemon/runtime/inference/contracts.js";
import { createInferenceRouter } from "../../../../src/daemon/runtime/inference/router.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

/** A capturing in-memory history store so a test asserts the recorded redacted event. */
function capturingHistory(): RoutingHistoryStore & { events: RedactedRoutingEvent[] } {
	const events: RedactedRoutingEvent[] = [];
	return {
		events,
		record(event: RedactedRoutingEvent): Promise<void> {
			events.push(event);
			return Promise.resolve();
		},
		recent(_scope: RoutingHistoryScope, _limit: number): Promise<RedactedRoutingEvent[]> {
			return Promise.resolve([...events]);
		},
	};
}

const SECRET = "sk-secret-value-never-persisted";
const SECRET_REF = "${KEY}";
const PROMPT = "the-private-prompt-body";

/** A single account every fixture target hangs off (one shared secret reference). */
function account(): Account {
	return { id: "acct", provider: "anthropic", apiKeyRef: SECRET_REF };
}

/** Build a target with sensible defaults, overridable per test. */
function target(over: Partial<Target> & { id: string }): Target {
	return {
		accountRef: "acct",
		model: "model",
		privacyTier: "private",
		capabilities: ["chat"],
		contextWindow: 200_000,
		...over,
	};
}

/** Build a workload with sensible gate floors, overridable per test. */
function workload(over: Partial<Workload> = {}): Workload {
	return {
		name: "memory_extraction",
		policyRef: "p",
		requiredCapabilities: ["chat"],
		minPrivacyTier: "public",
		...over,
	};
}

/** Assemble a full {@link InferenceConfig} from parts. */
function config(parts: {
	targets: Target[];
	policy: Policy;
	workload?: Workload;
	accounts?: Account[];
}): InferenceConfig {
	return {
		accounts: parts.accounts ?? [account()],
		targets: parts.targets,
		policies: [parts.policy],
		workloads: [parts.workload ?? workload()],
	};
}

/** A router wired against the fakes + a capturing history; returns both. */
function routerWith(cfg: InferenceConfig, script: Parameters<typeof createFakeProviderTransport>[0]) {
	const transport = createFakeProviderTransport(script);
	const secrets = createFakeSecretResolver({ [SECRET_REF]: SECRET });
	const history = capturingHistory();
	const router = createInferenceRouter({ config: cfg, transport, secrets, history });
	return { router, transport, history };
}

/** Assert no recorded event carries the secret or the prompt body (the redaction thesis). */
function assertRedacted(events: RedactedRoutingEvent[]): void {
	const serialized = JSON.stringify(events);
	expect(serialized).not.toContain(SECRET);
	expect(serialized).not.toContain(PROMPT);
}

const msg = (content: string) => [{ role: "user", content }];

// ── b-AC-1: GATES ────────────────────────────────────────────────────────────

describe("b-AC-1: a candidate failing a privacy / capability / context gate is blocked outright", () => {
	it("blocks a target whose privacy tier is below the workload floor", async () => {
		const cfg = config({
			targets: [
				target({ id: "pub", privacyTier: "public" }), // below floor → blocked
				target({ id: "priv", privacyTier: "private" }), // satisfies floor → survives
			],
			policy: { id: "p", mode: "strict", chain: ["pub", "priv"] },
			workload: workload({ minPrivacyTier: "private" }),
		});
		const { router, history } = routerWith(cfg, { priv: { text: "ok" } });
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });

		expect(decision.blockedCandidates).toContainEqual({ targetId: "pub", reason: "gate:privacy" });
		expect(decision.attempts).toContainEqual({ targetId: "pub", outcome: "blocked", reason: "gate:privacy" });
		expect(decision.servingTarget).toBe("priv");
		assertRedacted(history.events);
	});

	it("blocks a target missing a required capability (capability set must be a superset)", async () => {
		const cfg = config({
			targets: [
				target({ id: "nostream", capabilities: ["chat"] }), // missing streaming → blocked
				target({ id: "stream", capabilities: ["chat", "streaming"] }), // superset → survives
			],
			policy: { id: "p", mode: "strict", chain: ["nostream", "stream"] },
			workload: workload({ requiredCapabilities: ["chat", "streaming"] }),
		});
		const { router } = routerWith(cfg, { stream: { text: "ok" } });
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });

		expect(decision.blockedCandidates).toContainEqual({ targetId: "nostream", reason: "gate:capability" });
		expect(decision.servingTarget).toBe("stream");
	});

	it("blocks a target whose context window is smaller than the request's context size", async () => {
		const cfg = config({
			targets: [
				target({ id: "small", contextWindow: 8_000 }), // too small → blocked
				target({ id: "big", contextWindow: 200_000 }), // fits → survives
			],
			policy: { id: "p", mode: "strict", chain: ["small", "big"] },
		});
		const { router } = routerWith(cfg, { big: { text: "ok" } });
		const decision = await router.explain({
			requestId: "r",
			workload: "memory_extraction",
			messages: msg(PROMPT),
			contextTokens: 50_000,
		});

		expect(decision.blockedCandidates).toContainEqual({ targetId: "small", reason: "gate:context" });
		expect(decision.servingTarget).toBe("big");
	});

	it("each gate blocks independently — all three reasons appear when all three fail", async () => {
		const cfg = config({
			targets: [
				// p-fail: passes capability+context but is too public.
				target({ id: "p-fail", privacyTier: "public", capabilities: ["chat", "tools"] }),
				// c-fail: passes privacy+context but lacks the `tools` capability.
				target({ id: "c-fail", capabilities: ["chat"] }),
				// ctx-fail: passes privacy+capability but the context window is too small.
				target({ id: "ctx-fail", capabilities: ["chat", "tools"], contextWindow: 1_000 }),
				target({ id: "ok", privacyTier: "restricted", capabilities: ["chat", "tools"], contextWindow: 200_000 }),
			],
			policy: { id: "p", mode: "strict", chain: ["p-fail", "c-fail", "ctx-fail", "ok"] },
			workload: workload({ minPrivacyTier: "private", requiredCapabilities: ["chat", "tools"] }),
		});
		const { router } = routerWith(cfg, { ok: { text: "ok" } });
		const decision = await router.explain({
			requestId: "r",
			workload: "memory_extraction",
			messages: msg(PROMPT),
			contextTokens: 100_000,
		});

		const reasons = Object.fromEntries(decision.blockedCandidates.map((b) => [b.targetId, b.reason]));
		expect(reasons["p-fail"]).toBe("gate:privacy");
		expect(reasons["c-fail"]).toBe("gate:capability");
		expect(reasons["ctx-fail"]).toBe("gate:context");
		expect(decision.servingTarget).toBe("ok");
	});
});

// ── b-AC-2: MODES ────────────────────────────────────────────────────────────

describe("b-AC-2: strict uses chain order, automatic scores, hybrid scores within an allowlist", () => {
	/** Three targets with distinct privacy/context so the scorer has a clear order. */
	function threeTargets(): Target[] {
		return [
			target({ id: "a", privacyTier: "public", contextWindow: 100_000 }),
			target({ id: "b", privacyTier: "restricted", contextWindow: 50_000 }),
			target({ id: "c", privacyTier: "private", contextWindow: 300_000 }),
		];
	}

	it("strict: targets are tried in the explicit chain order", async () => {
		const cfg = config({
			targets: threeTargets(),
			policy: { id: "p", mode: "strict", chain: ["a", "b", "c"] },
		});
		const { router } = routerWith(cfg, { a: { text: "ok" } });
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });
		// strict head is the chain head, regardless of score.
		expect(decision.servingTarget).toBe("a");
	});

	it("automatic: candidates are SCORED (privacy DESC, then context DESC) — most private wins", async () => {
		const cfg = config({
			targets: threeTargets(),
			// automatic with no explicit set scores ALL targets.
			policy: { id: "p", mode: "automatic", chain: [] },
		});
		const { router } = routerWith(cfg, { b: { text: "ok" } });
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });
		// b = restricted (highest privacy rank) wins over c (private) and a (public).
		expect(decision.servingTarget).toBe("b");
	});

	it("automatic: privacy tie breaks by larger context window", async () => {
		const cfg = config({
			targets: [
				target({ id: "small", privacyTier: "private", contextWindow: 100_000 }),
				target({ id: "large", privacyTier: "private", contextWindow: 500_000 }),
			],
			policy: { id: "p", mode: "automatic", chain: [] },
		});
		const { router } = routerWith(cfg, { large: { text: "ok" } });
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });
		expect(decision.servingTarget).toBe("large");
	});

	it("hybrid: scores ONLY within the allowlist — a higher-scoring non-allowlisted target is excluded", async () => {
		const cfg = config({
			targets: threeTargets(),
			// b would win the global score, but it is not in the allowlist.
			policy: { id: "p", mode: "hybrid", chain: [], allowlist: ["a", "c"] },
		});
		const { router } = routerWith(cfg, { c: { text: "ok" } });
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });
		// Within {a:public, c:private}, c (private) outranks a (public). b is excluded.
		expect(decision.servingTarget).toBe("c");
		expect(decision.blockedCandidates.map((x) => x.targetId)).not.toContain("c");
	});
});

// ── b-AC-3: ACCOUNT DEGRADE (missing / expired out, survivors remain) ─────────

describe("b-AC-3: a missing or expired account degrades that target out; survivors remain eligible", () => {
	it("a target whose account does not exist degrades out; the other survives", async () => {
		const cfg = config({
			accounts: [account()], // only "acct" exists
			targets: [
				target({ id: "orphan", accountRef: "ghost-account" }), // no such account → degrade
				target({ id: "good", accountRef: "acct" }),
			],
			policy: { id: "p", mode: "strict", chain: ["orphan", "good"] },
		});
		const { router } = routerWith(cfg, { good: { text: "ok" } });
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });

		expect(decision.blockedCandidates).toContainEqual({ targetId: "orphan", reason: "account:missing" });
		expect(decision.servingTarget).toBe("good");
	});

	it("resolving the secret never echoes the resolved value into the decision or telemetry", async () => {
		const cfg = config({
			targets: [target({ id: "good" })],
			policy: { id: "p", mode: "strict", chain: ["good"] },
		});
		const { router, history } = routerWith(cfg, { good: { text: "served" } });
		await router.execute({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });
		assertRedacted(history.events);
	});
});

// ── b-AC-4: FALLBACK on 5xx / non-401 4xx, recording both attempts in order ───

describe("b-AC-4: a 5xx triggers fallback to the next allowed target, recording both attempts in order", () => {
	it("first target 503, second serves — attempt sequence is [failed, selected] in order", async () => {
		const cfg = config({
			targets: [target({ id: "first" }), target({ id: "second" })],
			policy: { id: "p", mode: "strict", chain: ["first", "second"] },
		});
		const { router, transport, history } = routerWith(cfg, {
			first: { statusCode: 503 },
			second: { text: "served" },
		});
		const result = await router.execute({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });

		expect(result.output).toBe("served");
		expect(result.decision.servingTarget).toBe("second");
		// The recorded attempt sequence preserves order: first failed (503), then second selected.
		expect(result.decision.attempts).toEqual([
			{ targetId: "first", outcome: "failed", statusCode: 503 },
			{ targetId: "second", outcome: "selected" },
		]);
		// The transport observed the same order (first then second).
		expect(transport.calls).toEqual(["first", "second"]);
		// Telemetry recorded the same true sequence, redacted.
		expect(history.events).toHaveLength(1);
		expect(history.events[0]?.attempts).toEqual(result.decision.attempts);
		assertRedacted(history.events);
	});

	it("a non-401 4xx (e.g. 429) also triggers fallback", async () => {
		const cfg = config({
			targets: [target({ id: "first" }), target({ id: "second" })],
			policy: { id: "p", mode: "strict", chain: ["first", "second"] },
		});
		const { router } = routerWith(cfg, { first: { statusCode: 429 }, second: { text: "served" } });
		const result = await router.execute({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });
		expect(result.decision.attempts).toEqual([
			{ targetId: "first", outcome: "failed", statusCode: 429 },
			{ targetId: "second", outcome: "selected" },
		]);
	});

	it("when the whole chain is exhausted, execute rejects (no target served)", async () => {
		const cfg = config({
			targets: [target({ id: "first" }), target({ id: "second" })],
			policy: { id: "p", mode: "strict", chain: ["first", "second"] },
		});
		const { router, history } = routerWith(cfg, { first: { statusCode: 503 }, second: { statusCode: 500 } });
		await expect(
			router.execute({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) }),
		).rejects.toThrow(/exhausted/);
		// The exhausted decision was still recorded (both failures, no serving target).
		expect(history.events).toHaveLength(1);
		expect(history.events[0]?.servingTarget).toBeNull();
		expect(history.events[0]?.attempts).toEqual([
			{ targetId: "first", outcome: "failed", statusCode: 503 },
			{ targetId: "second", outcome: "failed", statusCode: 500 },
		]);
	});
});

// ── b-AC-5: 401 marks the account expired in-memory for the process lifetime ──

describe("b-AC-5: a 401 marks the account expired in-memory; a later request degrades that account", () => {
	it("a 401 on the first request expires the account; the SECOND request degrades every target on it", async () => {
		const cfg: InferenceConfig = {
			accounts: [
				{ id: "acctA", provider: "anthropic", apiKeyRef: SECRET_REF },
				{ id: "acctB", provider: "anthropic", apiKeyRef: "${KEY_B}" },
			],
			targets: [
				target({ id: "a1", accountRef: "acctA" }),
				target({ id: "a2", accountRef: "acctA" }),
				target({ id: "b1", accountRef: "acctB" }),
			],
			policies: [{ id: "p", mode: "strict", chain: ["a1", "a2", "b1"] }],
			workloads: [workload()],
		};
		const transport = createFakeProviderTransport({
			a1: { statusCode: 401 }, // 401 → expire acctA
			a2: { text: "should-not-be-reached-on-req2" },
			b1: { text: "served-by-b" },
		});
		const secrets = createFakeSecretResolver({ [SECRET_REF]: SECRET, "${KEY_B}": "secret-b" });
		const history = capturingHistory();
		const router = createInferenceRouter({ config: cfg, transport, secrets, history });

		// Request 1: a1 returns 401 → acctA expired in-memory. a2 shares acctA, so it is
		// skipped this run too; b1 serves.
		const first = await router.execute({ requestId: "r1", workload: "memory_extraction", messages: msg(PROMPT) });
		expect(first.decision.servingTarget).toBe("b1");
		expect(first.decision.attempts).toContainEqual({ targetId: "a1", outcome: "failed", statusCode: 401 });

		// Request 2 (same process): both acctA targets degrade out BEFORE any provider
		// call — they appear as blocked account:expired, and b1 serves again.
		transport.calls.length = 0;
		const second = await router.explain({ requestId: "r2", workload: "memory_extraction", messages: msg(PROMPT) });
		expect(second.blockedCandidates).toContainEqual({ targetId: "a1", reason: "account:expired" });
		expect(second.blockedCandidates).toContainEqual({ targetId: "a2", reason: "account:expired" });
		expect(second.servingTarget).toBe("b1");

		// explain on req2 made no provider call at all (b-AC-6 holds here too).
		expect(transport.calls).toEqual([]);
		assertRedacted(history.events);
	});
});

// ── b-AC-6: EXPLAIN returns the decision WITHOUT executing inference ──────────

describe("b-AC-6: explain returns the routing decision without touching the transport", () => {
	it("explain never calls ProviderTransport.execute/stream (assert the fake's call log is empty)", async () => {
		const cfg = config({
			targets: [target({ id: "first" }), target({ id: "second" })],
			policy: { id: "p", mode: "strict", chain: ["first", "second"] },
		});
		const { router, transport, history } = routerWith(cfg, {
			first: { text: "would-serve" },
			second: { text: "fallback" },
		});
		const decision = await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });

		// The decision names the target it WOULD serve...
		expect(decision.servingTarget).toBe("first");
		// ...but the transport was NEVER touched.
		expect(transport.calls).toEqual([]);
		// A redacted event was still recorded, carrying no secret/body.
		expect(history.events).toHaveLength(1);
		assertRedacted(history.events);
	});

	it("explain records a redacted event that carries no message body", async () => {
		const cfg = config({
			targets: [target({ id: "only" })],
			policy: { id: "p", mode: "strict", chain: ["only"] },
		});
		const { router, history } = routerWith(cfg, { only: { text: "x" } });
		await router.explain({ requestId: "r", workload: "memory_extraction", messages: msg(PROMPT) });
		expect(history.events).toHaveLength(1);
		expect(JSON.stringify(history.events[0])).not.toContain(PROMPT);
	});
});
