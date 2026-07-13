/**
 * Extraction stage — PRD-006a (FULLY implemented in Wave 1).
 *
 * The first asynchronous pipeline stage: it takes one raw captured memory and
 * decomposes it into bounded {@link Fact}s and {@link EntityTriple}s for the
 * decision stage. It runs off the write path as a `memory_extraction` job; the
 * raw content was already committed by capture (PRD-005), so a slow or sloppy
 * model never costs a captured memory — extraction is pure enrichment.
 *
 * What this stage does (006a FR-3..10 / a-AC-1..5), in order:
 *   1. GATE (a-AC-5 / FR-9): run only when the pipeline is `enabled` AND the
 *      extraction provider is not `'none'`. Disabled → return empty, NO model call.
 *   2. CAP INPUT (a-AC-2 / FR-6): truncate raw content to `inputCharCap` (~12k)
 *      BEFORE building the prompt, so the model never sees an oversized input.
 *   3. CALL THE MODEL (FR-3): `ModelClient.complete('memory_extraction', prompt)`.
 *      The stage holds NO provider knowledge — the workload selects the model.
 *   4. STRIP CHAIN-OF-THOUGHT (a-AC-1 / FR-5): remove `<think>…</think>` and
 *      reasoning fences BEFORE attempting to parse JSON.
 *   5. PARSE DEFENSIVELY (a-AC-4 / FR-8): extract the JSON object tolerantly
 *      (code fences, leading/trailing prose, truncation) — a parse failure yields
 *      an empty result, never a thrown job.
 *   6. VALIDATE + DROP-INVALID (a-AC-4 / FR-8): validate each fact/triple via the
 *      contracts; drop invalid items with a warning, KEEP the valid ones.
 *   7. BOUND OUTPUT (a-AC-3 / FR-7): cap to `maxFacts` / `maxEntities` and
 *      length-cap each fact's content to `maxFactChars`.
 *
 * It does NOT write `memories` (006c) — its output is material for the decision
 * stage. It threads org/workspace/agent off the {@link StageJob} scope (FR-10).
 *
 * This module exports a pure {@link extractFromText} (the testable core: text +
 * config + model → result) AND a {@link createExtractionHandler} that adapts it to
 * the {@link StageHandler} the worker routes. The pure core is what a-AC-1..5
 * assert against; the handler is the wiring.
 */

import { MEMORY_TYPES, memoryTypeGuidance } from "../../../shared/memory-types.js";
import {
	type EntityTriple,
	type ExtractionResult,
	type Fact,
	parseEntityTriple,
	parseFact,
} from "./contracts.js";
import { DEFAULT_MAX_FACTS, type PipelineConfig, isExtractionEnabled } from "./config.js";
import type { ExtractionGateProbe } from "./reload.js";
import { type ModelClient } from "./model-client.js";
import type { StageHandler, StageJob } from "./stage-worker.js";

/** A minimal structured-log sink for extraction warnings (drop-invalid, etc.). */
export interface ExtractionLogger {
	/** Record a structured event (e.g. `extraction.dropped_invalid`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** The empty result — returned when extraction is gated off or the model is silent. */
const EMPTY_RESULT: ExtractionResult = Object.freeze({ facts: [], entities: [], droppedCount: 0 });

/**
 * Strip chain-of-thought / reasoning blocks from a model completion BEFORE JSON
 * parsing (a-AC-1 / FR-5). Removes, in order:
 *   - paired `<think>…</think>` blocks (the common reasoning-model wrapper), and
 *     the related `<reasoning>…</reasoning>` / `<thinking>…</thinking>` variants;
 *   - an UNCLOSED leading `<think>` (truncated reasoning) up to the first `{` —
 *     so a blob that opens reasoning and never closes it still yields its JSON;
 *   - markdown code fences (```json … ``` / ``` … ```), keeping the inner body.
 * Case-insensitive on the tag names. Pure; returns the cleaned text.
 */
export function stripChainOfThought(raw: string): string {
	let text = raw;
	// 1. Paired reasoning blocks, any of the common tag names, across newlines.
	text = text.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	// 2. An unclosed leading reasoning tag: drop everything from the tag up to the
	//    first JSON object opener, so truncated reasoning never hides the JSON.
	const unclosed = text.match(/<(?:think|thinking|reasoning)\b[^>]*>/i);
	if (unclosed && unclosed.index !== undefined) {
		const brace = text.indexOf("{", unclosed.index);
		if (brace >= 0) text = text.slice(0, unclosed.index) + text.slice(brace);
	}
	// 3. Markdown code fences — keep the inner body, drop the ``` lines.
	text = text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, "$1");
	return text.trim();
}

/**
 * Defensively extract the JSON object from a cleaned model completion (a-AC-4 /
 * FR-8). Tries, in order:
 *   1. `JSON.parse` of the whole trimmed string (the happy path);
 *   2. `JSON.parse` of the substring from the first `{` to the LAST `}` (tolerates
 *      leading/trailing prose the model wrapped around the JSON);
 *   3. a brace-balanced scan from the first `{` (tolerates trailing garbage after
 *      a complete object, and a TRUNCATED object by closing the unbalanced braces).
 * Returns the parsed object, or `null` when nothing parseable is found — the
 * caller turns `null` into the empty result, never a throw.
 */
export function parseExtractionJson(cleaned: string): Record<string, unknown> | null {
	const text = cleaned.trim();
	if (text === "") return null;

	const whole = tryParseObject(text);
	if (whole !== null) return whole;

	const first = text.indexOf("{");
	if (first < 0) return null;

	const last = text.lastIndexOf("}");
	if (last > first) {
		const slice = tryParseObject(text.slice(first, last + 1));
		if (slice !== null) return slice;
	}

	// Truncation tolerance: balance the braces from the first `{`, appending the
	// missing closers, then parse. Recovers `{"facts":[{"content":"x"` → `{}`-ish.
	const repaired = balanceBraces(text.slice(first));
	return repaired === null ? null : tryParseObject(repaired);
}

/** `JSON.parse` that returns a plain object or `null` (never throws, never an array). */
function tryParseObject(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		// A non-JSON / truncated string is an expected model failure mode, not an
		// error to surface: the caller falls back to the empty result (a-AC-4). This
		// is a deliberate, documented non-swallow — the outcome is the `null` return.
		return null;
	}
}

/**
 * Close the unbalanced `{`/`[` in a truncated JSON string so the prefix parses.
 * Respects string literals (a brace inside a `"..."` is not structural) and
 * escapes. Returns the brace-balanced string, or `null` when it is unrecoverable
 * (e.g. ends mid-string-key with no salvageable structure → let the caller give up).
 */
function balanceBraces(text: string): string | null {
	const stack: string[] = [];
	let inStr = false;
	let escaped = false;
	let lastStructural = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') {
			inStr = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push(ch);
			lastStructural = i;
		} else if (ch === "}" || ch === "]") {
			stack.pop();
			lastStructural = i;
		} else if (ch === ":" || ch === "," || (!/\s/.test(ch) && stack.length > 0)) {
			lastStructural = i;
		}
	}
	if (stack.length === 0) return text;
	if (lastStructural < 0) return null;
	// Truncate to the last structural char, drop a dangling comma/colon, then close.
	let prefix = text.slice(0, lastStructural + 1).replace(/[,:]\s*$/, "");
	if (inStr) prefix += '"'; // close a dangling string literal
	const closers = stack
		.reverse()
		.map((open) => (open === "{" ? "}" : "]"))
		.join("");
	return prefix + closers;
}

/**
 * Validate + bound the raw `facts` array from the parsed JSON (a-AC-3 / a-AC-4 /
 * FR-7 / FR-8). Validates each item via {@link parseFact}, drops the invalid ones,
 * drops facts below the `minFactChars` substance floor (ISS-025 — a fragment too
 * short to carry context + what + why is exactly the recall-polluting one-liner
 * class), length-caps each surviving fact's `content` to `maxFactChars`, and caps
 * the kept count to `maxFacts`. Returns the kept facts + the dropped count.
 */
function boundFacts(raw: unknown, config: PipelineConfig): { facts: Fact[]; dropped: number } {
	if (!Array.isArray(raw)) return { facts: [], dropped: 0 };
	const facts: Fact[] = [];
	let dropped = 0;
	for (const item of raw) {
		const fact = parseFact(item);
		if (fact === null) {
			dropped += 1;
			continue;
		}
		// ISS-025: the substance floor — measured on the TRIMMED content so whitespace
		// padding cannot smuggle a fragment past the gate. `0` disables the floor.
		if (fact.content.trim().length < config.extraction.minFactChars) {
			dropped += 1;
			continue;
		}
		// Length-cap the content AFTER validation (a-AC-3 / FR-7).
		const capped = fact.content.length > config.extraction.maxFactChars
			? { ...fact, content: fact.content.slice(0, config.extraction.maxFactChars) }
			: fact;
		facts.push(capped);
		if (facts.length >= config.extraction.maxFacts) break; // bound the count (a-AC-3).
	}
	return { facts, dropped };
}

/**
 * Validate + bound the raw `entities` array (a-AC-3 / a-AC-4 / FR-7 / FR-8). Same
 * drop-invalid policy as facts; caps the kept count to `maxEntities`.
 */
function boundEntities(raw: unknown, config: PipelineConfig): { entities: EntityTriple[]; dropped: number } {
	if (!Array.isArray(raw)) return { entities: [], dropped: 0 };
	const entities: EntityTriple[] = [];
	let dropped = 0;
	for (const item of raw) {
		const triple = parseEntityTriple(item);
		if (triple === null) {
			dropped += 1;
			continue;
		}
		entities.push(triple);
		if (entities.length >= config.extraction.maxEntities) break; // bound the count.
	}
	return { entities, dropped };
}

/**
 * Build the extraction prompt for the (already input-capped) raw text. The model
 * is asked for the D-4 JSON contract. Kept minimal + deterministic — the prompt is
 * not the seam, the workload is; PRD-010's router owns the model behind it.
 *
 * The `type` of each fact is BOUND to the closed taxonomy (PRD: extraction-type
 * binding): the prompt enumerates the six tokens + their meanings, sourced from
 * {@link memoryTypeGuidance} and {@link MEMORY_TYPES} so the instruction can NEVER
 * drift from the single source. The model is told to classify into exactly one;
 * {@link normalizeMemoryType} in the contract is the resilient floor underneath
 * (an off-token answer is coerced, not dropped) — the prompt does the real work.
 */
export function buildExtractionPrompt(cappedText: string, maxFacts: number = DEFAULT_MAX_FACTS): string {
	const typeList = MEMORY_TYPES.join("|");
	return [
		"You maintain the long-term memory of a software engineering agent. From the",
		"captured activity below, extract ONLY what will still be worth recalling in a",
		`future session — AT MOST ${maxFacts} memories, and usually fewer.`,
		"",
		"Each memory you keep must be:",
		"- CONSOLIDATED: merge related observations into ONE memory that carries its",
		"  context (what, where, why it matters). Prefer one substantial memory over",
		"  several fragments.",
		"- SELF-CONTAINED: understandable on its own without this session — name the",
		"  project, module, or file it concerns.",
		"- DURABLE: a decision and its rationale, a convention, a non-obvious gotcha or",
		"  failure mode, a stated preference, or a stable architecture fact.",
		"",
		"Do NOT extract (returning fewer or zero memories is the CORRECT answer for",
		"routine activity):",
		"- ephemeral run results (test counts, build/typecheck outcomes, timings)",
		"- one-off command outcomes or progress notes",
		"- restatements of what is plainly visible in the code or config",
		"- tool-choice trivia (e.g. which test runner a project uses) unless recording a",
		"  decision or non-obvious constraint around it",
		"",
		`Classify each memory's "type" as EXACTLY ONE of: ${typeList}.`,
		"Use this guidance to choose the type:",
		memoryTypeGuidance(),
		"",
		'Respond ONLY with JSON of the form:',
		`{"facts":[{"content":string,"type":one of ${typeList},"confidence":number}],`,
		'"entities":[{"source":string,"relationship":string,"target":string}]}',
		"confidence is between 0 and 1: how confident you are that the memory is BOTH",
		"true AND worth recalling in a future session. Do not include any other text.",
		"",
		"MEMORY:",
		cappedText,
	].join("\n");
}

/**
 * The testable core (a-AC-1..5): given the raw text, config, and a {@link ModelClient},
 * produce the bounded {@link ExtractionResult}. Pure with respect to its deps —
 * the only side effect is the model call + an optional warning log on drops.
 *
 * - Gated off (disabled / provider `none`) → returns {@link EMPTY_RESULT} and DOES
 *   NOT call the model (a-AC-5). This is the single early-return.
 * - Otherwise: cap input (a-AC-2), call model (FR-3), strip CoT (a-AC-1), parse
 *   defensively (a-AC-4), validate + drop-invalid + bound (a-AC-3/4). A model that
 *   throws is caught here and treated as "no usable output" → empty result, job
 *   not failed (the binding rule: a model hiccup never fails extraction).
 */
export async function extractFromText(
	text: string,
	config: PipelineConfig,
	model: ModelClient,
	logger?: ExtractionLogger,
	gate?: ExtractionGateProbe,
): Promise<ExtractionResult> {
	// 1. GATE (a-AC-5 / FR-9) — no model call when off. Evaluated PER JOB (SP-1 / ISS-001):
	//    with a live `gate`, the master `enabled` and the `'auto'` provider-configured signal
	//    are read NOW — a key saved or a toggle flipped after boot is honored by the next job,
	//    with no daemon restart and no boot-time `'auto'`→`'none'` collapse. Without a gate
	//    (pure-config callers, unit tests) the config-only decision is unchanged: `'auto'`
	//    with no provider signal stays conservatively OFF.
	const effectiveConfig = gate === undefined ? config : { ...config, enabled: gate.enabled() };
	if (!isExtractionEnabled(effectiveConfig, gate?.providerConfigured() ?? false)) return EMPTY_RESULT;

	// 2. CAP INPUT (a-AC-2 / FR-6) — before the prompt is built, so the model never
	//    sees more than the cap.
	const capped = text.length > config.extraction.inputCharCap
		? text.slice(0, config.extraction.inputCharCap)
		: text;

	// 3. CALL THE MODEL (FR-3). A transport throw is not a job failure — treat it as
	//    no usable output and keep the partial (empty) result.
	let completion: string;
	try {
		completion = await model.complete("memory_extraction", buildExtractionPrompt(capped, config.extraction.maxFacts));
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		logger?.event("extraction.model_error", { reason });
		return EMPTY_RESULT;
	}

	// 4. STRIP CoT (a-AC-1 / FR-5) then 5. PARSE DEFENSIVELY (a-AC-4 / FR-8).
	const cleaned = stripChainOfThought(completion);
	const parsed = parseExtractionJson(cleaned);
	if (parsed === null) {
		logger?.event("extraction.unparseable", { length: completion.length });
		return EMPTY_RESULT;
	}

	// 6 + 7. VALIDATE + DROP-INVALID + BOUND (a-AC-3 / a-AC-4 / FR-7 / FR-8).
	const factResult = boundFacts(parsed.facts, config);
	const entityResult = boundEntities(parsed.entities, config);
	const droppedCount = factResult.dropped + entityResult.dropped;
	if (droppedCount > 0) {
		logger?.event("extraction.dropped_invalid", {
			dropped: droppedCount,
			keptFacts: factResult.facts.length,
			keptEntities: entityResult.entities.length,
		});
	}

	// Observability: the extraction OUTCOME. `inputChars:0` means the job payload carried no content
	// (a capture-side gap) → the model has nothing to extract → 0 facts → no fan-out → no memory,
	// which is invisible without this. `facts:0` on non-empty input points at the model/prompt instead.
	logger?.event("extraction.result", {
		inputChars: text.length,
		facts: factResult.facts.length,
		entities: entityResult.entities.length,
		dropped: droppedCount,
	});

	return { facts: factResult.facts, entities: entityResult.entities, droppedCount };
}

/** The shape an extraction job's payload carries (besides the scope envelope). */
interface ExtractionPayload {
	/** The raw captured memory content to extract from. */
	readonly content?: unknown;
}

/** Read the raw content string off a job payload (defensively; "" when absent). */
function readContent(payload: Record<string, unknown>): string {
	const c = (payload as ExtractionPayload).content;
	return typeof c === "string" ? c : "";
}

/** Deps for {@link createExtractionHandler}. */
export interface ExtractionHandlerDeps {
	/** The resolved pipeline config (gates + caps). */
	readonly config: PipelineConfig;
	/** The model seam (real router-backed in prod, fake in tests). */
	readonly model: ModelClient;
	/** Optional structured-log sink for warnings. */
	readonly logger?: ExtractionLogger;
	/**
	 * Where extraction hands its result to the next stage. In Wave 1 this defaults
	 * to a no-op (the result is computed + bounded + logged but not yet enqueued for
	 * 006b — daemon-assembly wires the decision enqueue later, consistent with how
	 * PRD-004/005 defer real-service assembly). A test injects a recorder to assert
	 * the bounded result. NEVER writes `memories` (006c owns that).
	 */
	readonly onResult?: (job: StageJob, result: ExtractionResult) => Promise<void> | void;
	/**
	 * The LIVE per-job gate inputs (SP-1 / ISS-001): the current master `enabled` (vault-first,
	 * reload-updated) + the current `'auto'` provider-configured signal (TTL-debounced names-only
	 * secret probe). ABSENT (unit suites, pure-config callers) → the boot config decides alone,
	 * exactly the pre-SP-1 behavior. The daemon assembly always supplies it.
	 */
	readonly gate?: ExtractionGateProbe;
}

/**
 * Adapt {@link extractFromText} into the {@link StageHandler} the worker routes for
 * `memory_extraction` jobs. Reads the raw content off the payload, runs the core,
 * and forwards the bounded result via `onResult`. A handler that completes WITHOUT
 * throwing → the worker marks the job done (a partial/empty result is success, not
 * failure — a-AC-4). It throws only on a genuinely unrecoverable error, which the
 * worker routes to the queue's fail/backoff.
 */
export function createExtractionHandler(deps: ExtractionHandlerDeps): StageHandler {
	return async (job: StageJob): Promise<void> => {
		const content = readContent(job.payload);
		const result = await extractFromText(content, deps.config, deps.model, deps.logger, deps.gate);
		if (deps.onResult) await deps.onResult(job, result);
	};
}
