/**
 * ModelClient seam — PRD-006 Wave 1 (the typed LLM seam every pipeline stage calls).
 *
 * The model-provider-router is NOT built (PRD-010, locked decision). So the
 * pipeline does NOT know about providers, API keys, or model names. Instead every
 * stage that needs an LLM calls this ONE typed seam:
 *
 *   complete(workload, prompt): Promise<string>
 *
 * `workload` is the router-selection token (e.g. `'memory_extraction'`,
 * `'memory_decision'`) — the stage names the WORKLOAD, and the router (later) maps
 * the workload to a concrete provider+model. Until PRD-010 lands, the daemon
 * injects a real `ModelClient` whose body is the router; tests inject a FAKE that
 * returns canned strings. The stage code is byte-identical in both cases (006a
 * FR-3: "this worker holds no provider knowledge of its own").
 *
 * ── Why a string return, not a parsed object (the defensive-parse boundary) ──
 * `complete` returns the RAW model string — chain-of-thought blocks, malformed
 * JSON, truncation, fences and all. Parsing/validation is the STAGE's job (the
 * extraction stage strips CoT, parses defensively, validates via the contracts).
 * Keeping the seam at "raw text in, raw text out" means the fake can feed exactly
 * the adversarial payloads the defensive parser must survive (CoT-wrapped JSON,
 * truncated JSON, partially-invalid fields) without the seam pre-cleaning them.
 *
 * ── Workloads (the router-selection enum) ───────────────────────────────────
 * The v1 workloads. New stages add a workload here; the router maps each to a
 * model. The token is opaque to the stage beyond "which workload am I".
 *
 * `memory_dreaming` (PRD-009 / D-5) is the corrective-maintenance pass's workload.
 * The router (PRD-010) maps it to a STRONGER target than `memory_extraction`: the
 * dreaming pass reasons over accumulated summaries against the whole entity graph,
 * so it warrants a more capable model than the near-sighted per-chunk extractor.
 * The seam stays "raw text in, raw text out" — the dreaming runner parses the
 * returned mutation set defensively, exactly as the extraction stage parses facts.
 */

/** The router-selection token a stage passes to {@link ModelClient.complete}. */
export const MODEL_WORKLOADS = Object.freeze(["memory_extraction", "memory_decision", "memory_dreaming"] as const);

/** A model workload (router-selection token). */
export type ModelWorkload = (typeof MODEL_WORKLOADS)[number];

/**
 * A single completion request. The stage supplies the system + user prompt
 * already assembled (the seam does no templating); `workload` selects the model.
 */
export interface ModelRequest {
	/** Which workload this is — the router maps it to a provider+model. */
	readonly workload: ModelWorkload;
	/** The fully-assembled prompt to send. */
	readonly prompt: string;
}

/**
 * The typed LLM seam every pipeline stage calls. Returns the RAW completion text;
 * the caller is responsible for stripping CoT, parsing, and validating (006a
 * FR-5/FR-8). A `ModelClient` MUST NOT throw for an ordinary "no model / disabled"
 * case — it returns an empty string so the stage's defensive parser yields an
 * empty (but valid) result rather than failing the job. A genuine transport
 * failure (network, provider 500) MAY reject; the stage wraps the call and treats
 * a rejection as "no usable output" (drop-invalid-keep-partial, never fail the job
 * on a model hiccup).
 */
export interface ModelClient {
	/**
	 * Complete `request.prompt` for `request.workload`, returning the raw model
	 * text. The convenience overload `complete(workload, prompt)` is provided for
	 * call sites that don't want to build a {@link ModelRequest}.
	 */
	complete(request: ModelRequest): Promise<string>;
	complete(workload: ModelWorkload, prompt: string): Promise<string>;
}

/**
 * Normalize the two `complete` call shapes into a {@link ModelRequest}. A
 * `ModelClient` implementation uses this so it supports both the object form and
 * the `(workload, prompt)` form without duplicating the overload plumbing.
 */
export function toModelRequest(a: ModelRequest | ModelWorkload, b?: string): ModelRequest {
	if (typeof a === "string") {
		return { workload: a, prompt: b ?? "" };
	}
	return a;
}

/**
 * The no-op ModelClient the scaffold injects by default (and the posture when the
 * router is absent / extraction is disabled). `complete` resolves to an EMPTY
 * STRING — the defensive parser turns that into an empty-but-valid extraction
 * result, so a stage running with the no-op client produces zero facts/triples and
 * NEVER fails the job. The daemon swaps this for the real router-backed client at
 * construction (PRD-010); tests swap it for a {@link createFakeModelClient}.
 */
export const noopModelClient: ModelClient = {
	complete(_a: ModelRequest | ModelWorkload, _b?: string): Promise<string> {
		return Promise.resolve("");
	},
};

/**
 * A canned-response table for {@link createFakeModelClient}: a per-workload string
 * (or a function of the prompt) the fake returns. A workload absent from the table
 * resolves to "" (the no-op behaviour) so a test only scripts the workloads it
 * exercises.
 */
export type FakeModelScript = Partial<Record<ModelWorkload, string | ((prompt: string) => string)>>;

/**
 * Build a FAKE `ModelClient` for tests (the binding verification posture: stages
 * are verified against a fake model client returning canned extraction/decision
 * JSON — including CoT-wrapped and malformed bodies for the defensive-parse tests).
 *
 * Records every call on `.calls` so a test asserts the stage DID or DID NOT call
 * the model (a-AC-5: disabled → no model call). A scripted entry may be a function
 * of the prompt so a test can vary the response by input (e.g. echo the capped
 * length to prove a-AC-2's input cap reached the model).
 *
 * @example
 * ```ts
 * const model = createFakeModelClient({
 *   memory_extraction: '<think>reasoning</think>{"facts":[{"content":"x","type":"fact","confidence":0.9}],"entities":[]}',
 * });
 * // ... run the stage ...
 * expect(model.calls).toHaveLength(1);
 * expect(model.calls[0].workload).toBe("memory_extraction");
 * ```
 */
export interface FakeModelClient extends ModelClient {
	/** Every `complete` call this fake received, in order. */
	readonly calls: ModelRequest[];
}

/** Construct a {@link FakeModelClient} from a per-workload {@link FakeModelScript}. */
export function createFakeModelClient(script: FakeModelScript = {}): FakeModelClient {
	const calls: ModelRequest[] = [];
	const complete = (a: ModelRequest | ModelWorkload, b?: string): Promise<string> => {
		const req = toModelRequest(a, b);
		calls.push(req);
		const entry = script[req.workload];
		if (entry === undefined) return Promise.resolve("");
		return Promise.resolve(typeof entry === "function" ? entry(req.prompt) : entry);
	};
	return { calls, complete: complete as ModelClient["complete"] };
}
