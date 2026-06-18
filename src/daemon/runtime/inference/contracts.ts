/**
 * Inference contracts — PRD-010 Wave 1 (the typed shapes 010a/010b/010c/010d code against).
 *
 * These are the cross-module data contracts + seams for the model-provider router:
 * the privacy tier (an ORDERED enum), the capability vocabulary, the account /
 * target / policy / workload config shapes, the resolved {@link InferenceConfig},
 * the {@link RoutingDecision} + {@link AttemptRecord} the engine emits, the
 * OpenAI-chat-shaped request/response the gateway maps, and the four SEAMS the
 * Wave-2 Bees build against contention-free: {@link SecretResolver},
 * {@link ProviderTransport}, {@link InferenceRouter}, {@link RoutingHistoryStore}.
 *
 * This is the single most load-bearing Wave-1 artifact for PRD-010 — three Wave-2
 * Bees (010b engine, 010c gateway, 010d CLI) each code against THESE shapes, so
 * they must be right and stable. A genuinely new cross-module field is a Wave-1
 * change (raise it), not a stub edit.
 *
 * ── Boundary vs interior (where zod lives) ──────────────────────────────────
 * zod validates at the UNTRUSTED boundary — the `inference:` config block arriving
 * from `agent.yaml` (010a, validated in `config.ts`) and a gateway request body
 * arriving over HTTP (010c). The resolved {@link InferenceConfig} the engine reads
 * is a plain typed structure: `config.ts` produced it through zod + cross-ref
 * resolution, so the engine trusts it. The rule mirrors `ontology/contracts.ts`
 * and `pipeline/contracts.ts`: the schema DEFINES valid; the leniency lives in HOW
 * a caller applies it.
 *
 * ── The secret-never-persisted/logged/dumped invariant (the central thesis) ──
 * An {@link Account} holds `apiKeyRef` — a `${SECRET_REF}` reference STRING, never
 * a raw key. There is no raw-key field anywhere in these contracts BY
 * CONSTRUCTION, so no layer can accidentally carry, log, dump, or persist a
 * resolved key. Resolution happens at execution time through the
 * {@link SecretResolver} seam and the resolved value lives only in a local
 * variable for the duration of one provider call — it never enters a
 * {@link Target}, a {@link RoutingDecision}, or a {@link RedactedRoutingEvent}.
 * This is 010a a-AC-4 (inline raw key rejected), a-AC-2 (dump shows the
 * reference), and the 010c/010d telemetry-redaction thesis, all anchored in the
 * type shapes here.
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// PrivacyTier — an ORDERED enum (D-4 gate: target.tier >= workload.floor).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The privacy tiers, ORDERED lowest → highest (index = strictness rank). The
 * order is the contract Wave 2 inherits: the privacy gate (010b b-AC-1) admits a
 * target only when `tierRank(target.privacyTier) >= tierRank(workload.minPrivacyTier)`,
 * i.e. a target may be MORE private than the workload requires but never less.
 *
 * Chosen ordering + meaning (pinned here for Wave 2):
 *   - `public`     — data may flow to a third-party hosted provider with no
 *                    special handling (the lowest floor; the default).
 *   - `private`    — data is workspace-private; a target must be at least a
 *                    contractually-private provider (e.g. zero-retention endpoint).
 *   - `restricted` — the most sensitive data; a target must be a fully-controlled
 *                    / local endpoint (the highest floor).
 *
 * A workload at floor `private` therefore admits `private` and `restricted`
 * targets but blocks a `public` one. Frozen so the array is the single source the
 * zod enum, the comparator, and the rank map all read.
 */
export const PRIVACY_TIERS = Object.freeze(["public", "private", "restricted"] as const);

/** A privacy tier drawn from the ordered {@link PRIVACY_TIERS} set. */
export type PrivacyTier = (typeof PRIVACY_TIERS)[number];

/** zod enum over the ordered privacy-tier set (boundary validation for config). */
export const PrivacyTierSchema = z.enum(PRIVACY_TIERS);

/**
 * The strictness rank of a tier (its index in {@link PRIVACY_TIERS}); higher is
 * more private. Pure. Used by {@link tierSatisfies} and the engine's privacy gate.
 */
export function tierRank(tier: PrivacyTier): number {
	return PRIVACY_TIERS.indexOf(tier);
}

/**
 * The privacy comparator the gate uses (D-4 / b-AC-1): does `targetTier` satisfy a
 * workload `floor`? True when the target is AT LEAST as private as the floor —
 * `tierRank(targetTier) >= tierRank(floor)`. A target more private than required
 * passes; a target less private than required is blocked. Pure.
 */
export function tierSatisfies(targetTier: PrivacyTier, floor: PrivacyTier): boolean {
	return tierRank(targetTier) >= tierRank(floor);
}

// ────────────────────────────────────────────────────────────────────────────
// Capability — the closed capability vocabulary (D-4 capability gate).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The closed capability vocabulary (010a open-question answer, pinned here for
 * Wave 2). A {@link Target} advertises the capabilities its model supports; a
 * {@link Workload} declares the capabilities a request REQUIRES, and the
 * capability gate (010b b-AC-1) admits a target only when its set is a SUPERSET of
 * the workload's required set.
 *
 * The v1 token set:
 *   - `chat`      — chat/completion request shape (every text workload needs this).
 *   - `streaming` — the provider can stream tokens (SSE; 010c c-AC-2 needs it).
 *   - `vision`    — the model accepts image inputs.
 *   - `tools`     — the model supports tool/function calling.
 *
 * Closed by design so a typo in `agent.yaml` is a parse error, not a silently
 * unsatisfiable workload. A NEW capability is an additive Wave-1 change to this
 * frozen array (append only — never reorder/remove, targets reference by token).
 * Frozen so the array is the single source the zod enum and the gate both read.
 */
export const CAPABILITIES = Object.freeze(["chat", "streaming", "vision", "tools"] as const);

/** A capability token drawn from the closed {@link CAPABILITIES} vocabulary. */
export type Capability = (typeof CAPABILITIES)[number];

/** zod enum over the closed capability vocabulary (boundary validation for config). */
export const CapabilitySchema = z.enum(CAPABILITIES);

// ────────────────────────────────────────────────────────────────────────────
// Policy modes (D-5).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The three policy modes (D-5 / 010b b-AC-2):
 *   - `strict`    — try targets in the explicit `chain` order; no scoring.
 *   - `automatic` — score ALL surviving candidates and pick the best.
 *   - `hybrid`    — score within an `allowlist` subset of candidates.
 * Frozen so the array is the single source the zod enum reads.
 */
export const POLICY_MODES = Object.freeze(["strict", "automatic", "hybrid"] as const);

/** A policy mode drawn from {@link POLICY_MODES}. */
export type PolicyMode = (typeof POLICY_MODES)[number];

/** zod enum over the policy-mode set (boundary validation for config). */
export const PolicyModeSchema = z.enum(POLICY_MODES);

// ────────────────────────────────────────────────────────────────────────────
// Config shapes — the resolved, cross-ref-validated `inference:` block (010a).
// These are the INTERIOR shapes `config.ts` produces; the engine reads them.
// ────────────────────────────────────────────────────────────────────────────

/**
 * A provider account (010a FR-2). Holds the credential by `apiKeyRef` — a
 * `${SECRET_REF}` reference STRING resolved at use-time through the
 * {@link SecretResolver} seam. There is NO raw-key field by construction (a-AC-4):
 * an inline raw key is rejected at parse, and a dump shows only `apiKeyRef`
 * (a-AC-2). `id` is the name targets reference; `provider` selects the transport.
 */
export interface Account {
	/** The account id targets reference. */
	readonly id: string;
	/** The provider selector (e.g. `anthropic`, `openai`, `local`). */
	readonly provider: string;
	/** The secret REFERENCE (`${SECRET_REF}`) — never a raw key (a-AC-2/a-AC-4). */
	readonly apiKeyRef: string;
}

/**
 * A routable target (010a FR-3) — a concrete model on an account, carrying the
 * privacy tier + capabilities the gates read (a-AC-5). `accountRef` names a real
 * {@link Account} (cross-ref resolved at parse). `contextWindow` is the model's
 * token window the context gate (b-AC-1) compares the request against.
 */
export interface Target {
	/** The target id policies reference. */
	readonly id: string;
	/** The account this target's model runs on (cross-ref to {@link Account.id}). */
	readonly accountRef: string;
	/** The provider model name (e.g. `claude-sonnet-4`). */
	readonly model: string;
	/** The privacy tier this target offers (the privacy gate reads it — a-AC-5). */
	readonly privacyTier: PrivacyTier;
	/** The capabilities this target supports (the capability gate reads them — a-AC-5). */
	readonly capabilities: readonly Capability[];
	/** The model's context window in tokens (the context gate reads it). */
	readonly contextWindow: number;
}

/**
 * A routing policy (010a FR-4) — how to choose among targets. `mode` selects the
 * selection strategy (D-5); `chain` is the ordered target list strict mode walks;
 * `allowlist` is the candidate subset hybrid mode scores within. For `automatic`
 * the engine scores all candidates and `chain`/`allowlist` are advisory.
 */
export interface Policy {
	/** The policy id workloads reference. */
	readonly id: string;
	/** The selection mode (D-5). */
	readonly mode: PolicyMode;
	/** Ordered target ids for `strict` mode (cross-ref to {@link Target.id}). */
	readonly chain: readonly string[];
	/** Candidate target-id subset for `hybrid` scoring (cross-ref to {@link Target.id}). */
	readonly allowlist?: readonly string[];
}

/**
 * A workload (010a FR-5) — binds a kind of work to a policy + its gate floors. The
 * router maps the 006 `ModelClient` workload tokens (`memory_extraction`,
 * `memory_decision`, `memory_dreaming`) and the gateway's request workload onto a
 * {@link Workload} by `name`. `policyRef` names a real {@link Policy};
 * `requiredCapabilities` + `minPrivacyTier` are the gate floors (b-AC-1);
 * `requestContextTokens` is an optional default context hint the context gate uses
 * when a request does not supply its own.
 */
export interface Workload {
	/** The workload name (the router-selection token). */
	readonly name: string;
	/** The policy that governs this workload (cross-ref to {@link Policy.id}). */
	readonly policyRef: string;
	/** Capabilities a target MUST advertise to serve this workload (the gate). */
	readonly requiredCapabilities: readonly Capability[];
	/** The minimum privacy tier a target MUST offer (the gate floor). */
	readonly minPrivacyTier: PrivacyTier;
	/** Optional default context-token hint when a request omits its own. */
	readonly requestContextTokens?: number;
}

/**
 * The resolved + cross-ref-validated `inference:` config (010a FR-8). The whole
 * routing policy in one typed in-memory structure: every workload's `policyRef`
 * names a real policy, every policy's `chain`/`allowlist` names real targets, and
 * every target's `accountRef` names a real account — all guaranteed by
 * `parseInferenceConfig`. The engine reads this; it never re-validates.
 */
export interface InferenceConfig {
	readonly accounts: readonly Account[];
	readonly targets: readonly Target[];
	readonly policies: readonly Policy[];
	readonly workloads: readonly Workload[];
}

// ────────────────────────────────────────────────────────────────────────────
// RoutingDecision + AttemptRecord — what the engine emits (010b).
// ────────────────────────────────────────────────────────────────────────────

/** The outcome of one attempt against one target in a routing decision (010b). */
export const ATTEMPT_OUTCOMES = Object.freeze(["selected", "blocked", "failed"] as const);
/** An attempt outcome. */
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * One attempt against one target in a routing decision (010b b-AC-4). The decision
 * carries an ORDERED list of these — the full attempt sequence (gate blocks +
 * fallback failures + the final selection), so 010d d-AC-2 can render exactly what
 * the router tried and why.
 *
 * `outcome`:
 *   - `blocked` — a gate rejected the target before any provider call (`reason`
 *                 names the gate: privacy/capability/context).
 *   - `failed`  — the provider call failed (`statusCode` is the HTTP-like code;
 *                 401 marks an expiry, other 4xx/5xx triggers fallback — D-6).
 *   - `selected` — this target served the request (the terminal success).
 *
 * REDACTION: `reason` is a short machine/human string (a gate name or a status
 * class) — NEVER a provider error body or any text that could echo a credential.
 */
export interface AttemptRecord {
	/** The target this attempt was against (cross-ref to {@link Target.id}). */
	readonly targetId: string;
	/** Whether the target was selected, gate-blocked, or call-failed. */
	readonly outcome: AttemptOutcome;
	/** HTTP-like status code for a `failed` provider call (e.g. 401, 503). */
	readonly statusCode?: number;
	/** A short redacted reason (gate name / status class) — never a body. */
	readonly reason?: string;
}

/**
 * A routing decision (010b) — the result of `explain`/`execute`/`stream`. Carries
 * the chosen `servingTarget` (the target id that served, or `null` when every
 * candidate was blocked/failed), the ORDERED `attempts` sequence, the decision
 * `mode`, and the `blockedCandidates` with their gate `reasons` for diagnostics.
 *
 * This whole structure is REDACTED by construction: it carries target IDS, gate
 * reasons, and status codes — never a resolved key, a prompt, or a completion. It
 * maps directly onto a {@link RedactedRoutingEvent} for telemetry.
 */
export interface RoutingDecision {
	/** The target id that served the request, or `null` when none could. */
	readonly servingTarget: string | null;
	/** The ordered attempt sequence (gate blocks + fallbacks + the selection). */
	readonly attempts: readonly AttemptRecord[];
	/** The policy mode this decision ran under (D-5). */
	readonly mode: PolicyMode;
	/** The workload this decision routed under. */
	readonly workload: string;
	/** Targets a gate blocked, each with its redacted gate reason. */
	readonly blockedCandidates: readonly { readonly targetId: string; readonly reason: string }[];
}

// ────────────────────────────────────────────────────────────────────────────
// Gateway request/response — OpenAI-chat-shaped (010c maps onto these).
// ────────────────────────────────────────────────────────────────────────────

/** One chat message in an inference request (OpenAI-chat-shaped). */
export interface ChatMessage {
	/** The message role (`system` | `user` | `assistant` | `tool`). */
	readonly role: string;
	/** The message content. */
	readonly content: string;
}

/**
 * An inference request (OpenAI-chat-shaped so the 010c gateway maps cleanly from
 * `/v1/chat/completions`). `requestId` keys the decision + the stream-cancel
 * handle; `workload` selects the {@link Workload}; `messages` is the chat body;
 * `maxTokens`/`stream` mirror the OpenAI fields; `contextTokens` is the request's
 * own context-window estimate the context gate uses (falling back to the
 * workload's `requestContextTokens` hint).
 *
 * The `messages` ARE the request body — they are NEVER persisted to telemetry or
 * echoed into a {@link RoutingDecision}; only the decision metadata is recorded.
 */
export interface InferenceRequest {
	/** The request id (keys the decision + the cancel handle). */
	readonly requestId: string;
	/** The workload to route under (maps to a {@link Workload.name}). */
	readonly workload: string;
	/** The chat body (NEVER persisted to telemetry). */
	readonly messages: readonly ChatMessage[];
	/** Max completion tokens (OpenAI-shaped). */
	readonly maxTokens?: number;
	/** Whether the caller asked for a streamed response (OpenAI-shaped). */
	readonly stream?: boolean;
	/** The request's own context-token estimate for the context gate. */
	readonly contextTokens?: number;
}

/** A non-streamed inference response: the serving target + the raw completion text. */
export interface InferenceResponse {
	/** The target id that served (mirrors {@link RoutingDecision.servingTarget}). */
	readonly servingTarget: string;
	/** The raw completion text the provider returned. */
	readonly output: string;
}

// ────────────────────────────────────────────────────────────────────────────
// SECRET RESOLVER SEAM — PRD-012 builds the real one (fake here for tests).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The secret-resolution SEAM (D-2). Resolves a `${SECRET_REF}` reference to its
 * value at EXECUTION time — the only place a resolved key ever exists, and only
 * for the duration of one provider call. PRD-012 (the secrets subsystem) builds
 * the real resolver later; Wave 1 ships only the seam + a fake. The resolved value
 * MUST NOT be logged, dumped, stored on a {@link Target}, or written to telemetry.
 */
export interface SecretResolver {
	/** Resolve a `${SECRET_REF}` reference to its value. Rejects on an unknown ref. */
	resolve(ref: string): Promise<string>;
}

/**
 * Build a FAKE {@link SecretResolver} for tests from a ref → value table. An
 * unknown ref rejects (the production resolver fails closed on a missing secret).
 * The table lives only in the test; no real `.secrets/` is touched.
 */
export function createFakeSecretResolver(table: Record<string, string>): SecretResolver {
	return {
		resolve(ref: string): Promise<string> {
			if (Object.hasOwn(table, ref)) return Promise.resolve(table[ref] as string);
			return Promise.reject(new Error(`SecretResolver: no secret for reference ${ref}`));
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// PROVIDER TRANSPORT SEAM — real HTTP is a later thin addition (fake here).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A provider-call failure carrying an HTTP-like `statusCode` so the engine can
 * branch on it (D-6): 401 → mark the account expired in-memory; other 4xx/5xx →
 * fall back to the next allowed target. The `message` is a SHORT redacted string,
 * never a raw provider body that could echo a credential.
 */
export class ProviderError extends Error {
	readonly statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "ProviderError";
		this.statusCode = statusCode;
	}
}

/** A successful non-streamed provider result. */
export interface ProviderResult {
	/** The raw completion text. */
	readonly output: string;
}

/** One chunk of a streamed provider result. */
export interface ProviderChunk {
	/** A delta of completion text. */
	readonly delta: string;
}

/**
 * What the engine hands a {@link ProviderTransport} for one call: the resolved
 * target, the resolved secret VALUE (local-only, for the duration of this call),
 * and the request. The transport NEVER persists or logs `apiKey`.
 */
export interface ProviderCall {
	/** The resolved target this call runs against. */
	readonly target: Target;
	/** The resolved secret VALUE — local to this call only, never stored/logged. */
	readonly apiKey: string;
	/** The inference request to execute. */
	readonly request: InferenceRequest;
}

/**
 * The provider-call SEAM (D-6). Executes (or streams) one inference request
 * against one resolved target. A failure throws a {@link ProviderError} carrying
 * the HTTP-like status the engine branches on. Wave 1 ships ONLY the seam + a
 * fake — there is NO real HTTP in Wave 1 (no provider creds in this env). The real
 * transport is a thin later addition; 010b's engine tests run against the fake.
 */
export interface ProviderTransport {
	/** Execute one request; resolves with the completion or rejects with a {@link ProviderError}. */
	execute(call: ProviderCall): Promise<ProviderResult>;
	/** Stream one request; yields {@link ProviderChunk}s or throws a {@link ProviderError}. */
	stream(call: ProviderCall): AsyncIterable<ProviderChunk>;
}

/**
 * A scripted outcome for one target in {@link createFakeProviderTransport}: either
 * a success `text` the fake returns (chunked for `stream`), or a `statusCode` the
 * fake throws as a {@link ProviderError} (so a test drives 401-expiry / 5xx
 * fallback without real HTTP).
 */
export type FakeProviderOutcome = { readonly text: string } | { readonly statusCode: number };

/** A per-target script: target id → the outcome the fake transport produces. */
export type FakeProviderScript = Record<string, FakeProviderOutcome>;

/**
 * Build a FAKE {@link ProviderTransport} for tests. Looks the call's target id up
 * in `script`; a `text` outcome resolves (and streams in two chunks) and a
 * `statusCode` outcome throws a {@link ProviderError}. A target absent from the
 * script throws a 404 {@link ProviderError} (an unscripted target is a test bug,
 * surfaced loudly). Records every call's target id on `.calls` so a test asserts
 * the attempt order (010b b-AC-4 fallback sequence).
 */
export interface FakeProviderTransport extends ProviderTransport {
	/** Every call's target id, in order (the observed attempt sequence). */
	readonly calls: string[];
}

/** Construct a {@link FakeProviderTransport} from a per-target {@link FakeProviderScript}. */
export function createFakeProviderTransport(script: FakeProviderScript): FakeProviderTransport {
	const calls: string[] = [];
	function outcomeFor(targetId: string): FakeProviderOutcome {
		calls.push(targetId);
		const entry = script[targetId];
		if (entry === undefined) {
			throw new ProviderError(404, `fake transport: no script for target ${targetId}`);
		}
		return entry;
	}
	return {
		calls,
		execute(call: ProviderCall): Promise<ProviderResult> {
			const entry = outcomeFor(call.target.id);
			if ("statusCode" in entry) {
				return Promise.reject(new ProviderError(entry.statusCode, `fake transport: status ${entry.statusCode}`));
			}
			return Promise.resolve({ output: entry.text });
		},
		stream(call: ProviderCall): AsyncIterable<ProviderChunk> {
			const entry = outcomeFor(call.target.id);
			if ("statusCode" in entry) {
				throw new ProviderError(entry.statusCode, `fake transport: status ${entry.statusCode}`);
			}
			const text = entry.text;
			async function* gen(): AsyncIterable<ProviderChunk> {
				const mid = Math.ceil(text.length / 2);
				yield { delta: text.slice(0, mid) };
				yield { delta: text.slice(mid) };
			}
			return gen();
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// INFERENCE ROUTER interface — 010c builds the gateway against this shape.
// ────────────────────────────────────────────────────────────────────────────

/** The result of an executed (non-streamed) request: the decision + the output. */
export interface ExecuteResult {
	/** The routing decision (the full attempt sequence + the serving target). */
	readonly decision: RoutingDecision;
	/** The raw completion text from the serving target. */
	readonly output: string;
}

/** The result of a streamed request: the decision + the chunk stream + a cancel handle. */
export interface StreamResult {
	/** The routing decision (resolved once a target is selected). */
	readonly decision: RoutingDecision;
	/** The streamed completion chunks. */
	readonly chunks: AsyncIterable<ProviderChunk>;
	/** Cancel the stream for this request id (010c DELETE /api/inference/requests/:id). */
	cancel(): void;
}

/**
 * The router interface (010b implements; 010c builds the gateway against it). Three
 * entry points + stream cancellation:
 *   - `explain`  — return the {@link RoutingDecision} WITHOUT executing inference
 *                  (010b b-AC-6 / 010c c-AC-1 / 010d d-AC-1). No provider call.
 *   - `execute`  — route + run a non-streamed request; return decision + output.
 *   - `stream`   — route + stream the response; return decision + chunk stream + a
 *                  cancel handle keyed by request id (010c c-AC-2 / c-AC-4).
 *   - `cancel`   — cancel an active stream by request id (010c c-AC-4 DELETE). The
 *                  same handle {@link StreamResult.cancel} exposes, addressable by
 *                  id so the gateway's DELETE route reaches it.
 *
 * Every entry records a redacted decision to the {@link RoutingHistoryStore}.
 */
export interface InferenceRouter {
	/** Resolve the routing decision for a request WITHOUT executing it (b-AC-6). */
	explain(request: InferenceRequest): Promise<RoutingDecision>;
	/** Route + execute a non-streamed request. */
	execute(request: InferenceRequest): Promise<ExecuteResult>;
	/** Route + stream a request; the result carries a cancel handle. */
	stream(request: InferenceRequest): Promise<StreamResult>;
	/** Cancel an active stream by request id (c-AC-4). Returns true if one was cancelled. */
	cancel(requestId: string): boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// RoutingHistoryStore SEAM — append redacted + read redacted (010d reads it).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A REDACTED routing-telemetry event (D-7) — the on-disk shape of a routing
 * decision. By CONSTRUCTION it carries ONLY: the request id, the workload, the
 * serving target id (or null), the ordered attempt sequence, the decision mode,
 * and the blocked-candidate reasons. There is NO field that can hold a secret
 * value, a resolved key, or a request/response body — the shape itself makes a
 * leak unrepresentable. This is the type `RoutingHistoryStore.record` accepts, so
 * the redaction is enforced at the write boundary, not by a read-time scrub
 * (010c c-AC-6 / 010d d-AC-5).
 */
export interface RedactedRoutingEvent {
	/** The inference request this decision served. */
	readonly requestId: string;
	/** The workload the request routed under. */
	readonly workload: string;
	/** The serving target id, or null when every candidate was blocked/failed. */
	readonly servingTarget: string | null;
	/** The policy mode the decision ran under. */
	readonly mode: PolicyMode;
	/** The ordered attempt sequence (gate blocks + fallbacks + selection). */
	readonly attempts: readonly AttemptRecord[];
	/** Targets a gate blocked, each with its redacted gate reason. */
	readonly blockedCandidates: readonly { readonly targetId: string; readonly reason: string }[];
}

/**
 * Derive the {@link RedactedRoutingEvent} from a {@link RoutingDecision}. Pure +
 * total: it copies ONLY the redaction-safe fields, so even if a future decision
 * field carried something sensitive, it could not reach the event unless added
 * here deliberately. This is the single sanctioned decision → event mapping; the
 * store's `record` takes the event, never the raw decision.
 */
export function toRedactedEvent(request: InferenceRequest, decision: RoutingDecision): RedactedRoutingEvent {
	return {
		requestId: request.requestId,
		workload: decision.workload,
		servingTarget: decision.servingTarget,
		mode: decision.mode,
		attempts: decision.attempts,
		blockedCandidates: decision.blockedCandidates,
	};
}

/** The scope a {@link RoutingHistoryStore} read filters by (denormalized telemetry context). */
export interface RoutingHistoryScope {
	/** The org partition. */
	readonly org: string;
	/** The workspace partition. */
	readonly workspace: string;
}

/**
 * The routing-telemetry SEAM (D-7). `record` appends a {@link RedactedRoutingEvent}
 * (append-only, redacted by construction); `recent` reads back the newest events
 * for a scope (010d d-AC-2 reads through it). Wave 1 ships the real impl in
 * `history-store.ts`; 010c's `GET /api/inference/history` and 010d's
 * `honeycomb route status` read through this same interface.
 */
export interface RoutingHistoryStore {
	/** Append one redacted routing event (append-only; never carries a secret/body). */
	record(event: RedactedRoutingEvent): Promise<void>;
	/** Read the newest redacted events for a scope, newest-first, up to `limit`. */
	recent(scope: RoutingHistoryScope, limit: number): Promise<RedactedRoutingEvent[]>;
}

/**
 * A no-op {@link RoutingHistoryStore} the router can default to (and the posture
 * when telemetry storage is not wired). `record` discards; `recent` returns empty.
 * The daemon swaps this for the real `history-store.ts` impl at assembly.
 */
export const noopRoutingHistoryStore: RoutingHistoryStore = {
	record(): Promise<void> {
		return Promise.resolve();
	},
	recent(): Promise<RedactedRoutingEvent[]> {
		return Promise.resolve([]);
	},
};

/**
 * The standard "Wave 2 fills this" thrower (mirrors the ontology/dreaming harness
 * posture). A stubbed seam body calls this so an accidental early call FAILS LOUD
 * with the owning sub-PRD, never silently returns a fake-passing value.
 */
export function notImplemented(what: string): never {
	throw new Error(`inference: ${what} is not implemented in Wave 1 (see CONVENTIONS.md for the owning sub-PRD)`);
}
