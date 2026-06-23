/**
 * PRD-006a Extraction — a-AC-1..a-AC-5 (Wave 1 scaffold + extraction).
 *
 * Verification posture (EXECUTION_LEDGER-prd-006 / pipeline CONVENTIONS §5):
 *   - The extraction CORE (`extractFromText`) is verified against a FAKE
 *     `ModelClient` (`createFakeModelClient`) returning canned extraction JSON —
 *     including CoT-wrapped, truncated, and partially-invalid bodies — exactly the
 *     adversarial shapes the defensive parser must survive. No live model.
 *   - The fake records `.calls`, so a-AC-5 asserts the model was NOT called when
 *     extraction is gated off.
 *   - Each test is named after the AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *
 * a-AC-6 (worker crash mid-job → reaper reclaims + retry) is proven separately in
 * `stage-worker.test.ts` (it exercises the queue + worker harness, not the core).
 */

import { describe, expect, it } from "vitest";

import {
	type PipelineConfig,
	PipelineConfigSchema,
	createFakeModelClient,
	createExtractionHandler,
	type ExtractionResult,
	extractFromText,
	parseExtractionJson,
	type StageJob,
	stripChainOfThought,
} from "../../../../src/daemon/runtime/pipeline/index.js";
import { buildExtractionPrompt } from "../../../../src/daemon/runtime/pipeline/extraction.js";
import { extractionFanOut } from "../../../../src/daemon/runtime/pipeline/fan-out.js";
import type {
	JobInput,
	JobQueueService,
	LeasedJob,
} from "../../../../src/daemon/runtime/services/job-queue.js";
import {
	MEMORY_TYPES,
	isMemoryType,
	memoryTypeGuidance,
} from "../../../../src/shared/memory-types.js";

// ── Config fixture: extraction ENABLED with the D-1 caps (override per test). ──
function enabledConfig(overrides: Record<string, unknown> = {}): PipelineConfig {
	return PipelineConfigSchema.parse({
		enabled: true,
		extractionProvider: "fake-router",
		...overrides,
	});
}

// A canned extraction body with one valid fact + one valid triple, no CoT.
const CLEAN_JSON =
	'{"facts":[{"content":"the daemon binds 127.0.0.1:3850","type":"fact","confidence":0.9}],' +
	'"entities":[{"source":"daemon","relationship":"binds","target":"127.0.0.1:3850"}]}';

// A recorder for the handler's onResult, to assert the bounded result reached it.
function recorder(): { results: ExtractionResult[]; onResult: (j: StageJob, r: ExtractionResult) => void } {
	const results: ExtractionResult[] = [];
	return { results, onResult: (_j, r) => void results.push(r) };
}

describe("a-AC-1 raw memory → facts (0-1 confidence) + triples, CoT stripped before parse", () => {
	it("parses a <think>…</think>-wrapped JSON blob correctly", async () => {
		const wrapped = `<think>Let me find the facts. The user said the daemon binds a port.</think>\n${CLEAN_JSON}`;
		const model = createFakeModelClient({ memory_extraction: wrapped });

		const result = await extractFromText("the daemon binds 127.0.0.1:3850", enabledConfig(), model);

		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].workload).toBe("memory_extraction");
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0]).toEqual({
			content: "the daemon binds 127.0.0.1:3850",
			type: "fact",
			confidence: 0.9,
		});
		// confidence is within 0..1.
		expect(result.facts[0].confidence).toBeGreaterThanOrEqual(0);
		expect(result.facts[0].confidence).toBeLessThanOrEqual(1);
		expect(result.entities).toEqual([{ source: "daemon", relationship: "binds", target: "127.0.0.1:3850" }]);
		expect(result.droppedCount).toBe(0);
	});

	it("stripChainOfThought removes paired and fenced reasoning, keeping the JSON", () => {
		const blob = "```json\n<think>reasoning here</think>" + CLEAN_JSON + "\n```";
		const cleaned = stripChainOfThought(blob);
		expect(cleaned).not.toContain("<think>");
		expect(cleaned).not.toContain("```");
		expect(parseExtractionJson(cleaned)).not.toBeNull();
	});

	it("recovers JSON from a TRUNCATED (unclosed) completion without throwing", () => {
		// An unclosed <think> and a truncated object — the defensive parser must
		// still salvage the one complete fact rather than failing the job.
		const truncated =
			'<think>reasoning that never closes {"facts":[{"content":"x","type":"fact","confidence":0.8}';
		const result = parseExtractionJson(stripChainOfThought(truncated));
		expect(result).not.toBeNull();
		expect(Array.isArray((result as { facts?: unknown }).facts)).toBe(true);
	});
});

describe("a-AC-2 oversized input → capped ~12,000 chars before the model call", () => {
	it("the prompt the fake model receives never carries more than inputCharCap content", async () => {
		// 20k of 'x' — well over the 12k default cap.
		const huge = "x".repeat(20_000);
		let seenPromptLength = -1;
		const model = createFakeModelClient({
			memory_extraction: (prompt: string) => {
				seenPromptLength = prompt.length;
				return CLEAN_JSON;
			},
		});

		await extractFromText(huge, enabledConfig(), model);

		// The prompt = a fixed template header + the capped content. The content the
		// model saw must be ≤ the cap (12_000), so the whole prompt is far below 20k.
		expect(model.calls).toHaveLength(1);
		expect(seenPromptLength).toBeLessThan(20_000);
		// Bound the prompt by the cap PLUS the prompt's own header (measured from an
		// empty-content prompt), not a magic constant — so this stays the real
		// content-cap invariant when the template (e.g. the taxonomy guidance) grows.
		const headerLength = buildExtractionPrompt("").length;
		expect(seenPromptLength).toBeLessThanOrEqual(12_000 + headerLength);
		// And the raw 20k input is NOT present verbatim (it was truncated).
		expect(model.calls[0].prompt).not.toContain("x".repeat(12_001));
	});

	it("honours a custom inputCharCap from config", async () => {
		const huge = "y".repeat(5_000);
		let seen = "";
		const model = createFakeModelClient({
			memory_extraction: (p: string) => {
				seen = p;
				return CLEAN_JSON;
			},
		});
		await extractFromText(huge, enabledConfig({ extraction: { inputCharCap: 100 } }), model);
		// At most 100 'y' chars survive the cap.
		expect(seen).not.toContain("y".repeat(101));
		expect(seen).toContain("y".repeat(100));
	});
});

describe("a-AC-3 oversized result → bounded ≤20 facts / ≤50 entities + per-fact length", () => {
	it("feeds 30 facts and 60 entities → keeps exactly 20 / 50", async () => {
		const facts = Array.from({ length: 30 }, (_, i) => ({
			content: `fact number ${i}`,
			type: "fact",
			confidence: 0.8,
		}));
		const entities = Array.from({ length: 60 }, (_, i) => ({
			source: `s${i}`,
			relationship: "rel",
			target: `t${i}`,
		}));
		const model = createFakeModelClient({ memory_extraction: JSON.stringify({ facts, entities }) });

		const result = await extractFromText("raw", enabledConfig(), model);

		expect(result.facts).toHaveLength(20);
		expect(result.entities).toHaveLength(50);
	});

	it("length-caps each fact's content to maxFactChars", async () => {
		const long = "z".repeat(5_000);
		const model = createFakeModelClient({
			memory_extraction: JSON.stringify({
				facts: [{ content: long, type: "fact", confidence: 0.9 }],
				entities: [],
			}),
		});

		const result = await extractFromText("raw", enabledConfig({ extraction: { maxFactChars: 500 } }), model);

		expect(result.facts).toHaveLength(1);
		expect(result.facts[0].content.length).toBe(500);
	});
});

describe("a-AC-4 partially-invalid output → invalid dropped + warned, valid kept, job NOT failed", () => {
	it("drops invalid facts/triples, keeps the valid ones, and records the dropped count", async () => {
		const body = JSON.stringify({
			facts: [
				{ content: "valid fact", type: "fact", confidence: 0.9 }, // valid
				{ content: "", type: "fact", confidence: 0.5 }, // invalid: empty content
				{ content: "bad conf", type: "fact", confidence: 1.7 }, // invalid: conf > 1
				{ content: "no type", confidence: 0.5 }, // invalid: missing type
				{ content: "valid two", type: "pref", confidence: 0.4 }, // valid
			],
			entities: [
				{ source: "a", relationship: "r", target: "b" }, // valid
				{ source: "a", target: "b" }, // invalid: missing relationship
				"not an object", // invalid
			],
		});
		const warnings: string[] = [];
		const logger = { event: (name: string) => void warnings.push(name) };
		const model = createFakeModelClient({ memory_extraction: body });

		const result = await extractFromText("raw", enabledConfig(), model, logger);

		expect(result.facts.map((f) => f.content)).toEqual(["valid fact", "valid two"]);
		expect(result.entities).toEqual([{ source: "a", relationship: "r", target: "b" }]);
		// 3 invalid facts + 2 invalid entities dropped.
		expect(result.droppedCount).toBe(5);
		expect(warnings).toContain("extraction.dropped_invalid");
	});

	it("the stage handler COMPLETES (does not throw) on partially-invalid output", async () => {
		const body = JSON.stringify({
			facts: [{ content: "kept", type: "fact", confidence: 0.9 }, { bad: true }],
			entities: [],
		});
		const model = createFakeModelClient({ memory_extraction: body });
		const rec = recorder();
		const handler = createExtractionHandler({ config: enabledConfig(), model, onResult: rec.onResult });

		const job: StageJob = {
			id: "j1",
			kind: "memory_extraction",
			attempt: 1,
			scope: { org: "o", workspace: "w", agentId: "default" },
			payload: { content: "raw", org: "o", workspace: "w", agent_id: "default" },
		};

		// Must resolve, NOT reject — a partial result is success (a-AC-4).
		await expect(handler(job)).resolves.toBeUndefined();
		expect(rec.results).toHaveLength(1);
		expect(rec.results[0].facts).toHaveLength(1);
		expect(rec.results[0].droppedCount).toBe(1);
	});

	it("totally-unparseable model output → empty result, job not failed", async () => {
		const model = createFakeModelClient({ memory_extraction: "I cannot help with that. No JSON here." });
		const result = await extractFromText("raw", enabledConfig(), model);
		expect(result).toEqual({ facts: [], entities: [], droppedCount: 0 });
	});
});

describe("a-AC-5 disabled / provider 'none' → extraction does not run (no model call)", () => {
	it("pipeline disabled → no model call, empty result", async () => {
		const model = createFakeModelClient({ memory_extraction: CLEAN_JSON });
		const config = PipelineConfigSchema.parse({ enabled: false, extractionProvider: "fake-router" });

		const result = await extractFromText("raw", config, model);

		expect(model.calls).toHaveLength(0);
		expect(result).toEqual({ facts: [], entities: [], droppedCount: 0 });
	});

	it("extractionProvider 'none' (even when enabled) → no model call, empty result", async () => {
		const model = createFakeModelClient({ memory_extraction: CLEAN_JSON });
		const config = PipelineConfigSchema.parse({ enabled: true, extractionProvider: "none" });

		const result = await extractFromText("raw", config, model);

		expect(model.calls).toHaveLength(0);
		expect(result.facts).toHaveLength(0);
	});

	it("the handler also makes no model call when gated off", async () => {
		const model = createFakeModelClient({ memory_extraction: CLEAN_JSON });
		const config = PipelineConfigSchema.parse({ enabled: true, extractionProvider: "none" });
		const rec = recorder();
		const handler = createExtractionHandler({ config, model, onResult: rec.onResult });

		await handler({
			id: "j2",
			kind: "memory_extraction",
			attempt: 1,
			scope: { org: "o", workspace: "w", agentId: "default" },
			payload: { content: "raw" },
		});

		expect(model.calls).toHaveLength(0);
		expect(rec.results[0]).toEqual({ facts: [], entities: [], droppedCount: 0 });
	});
});

describe("extraction-type binding — the prompt instructs the closed six-token taxonomy", () => {
	it("the prompt names every taxonomy token and carries the shared guidance", () => {
		const prompt = buildExtractionPrompt("some captured memory text");
		// Asserts against the SINGLE SOURCE: a drift in MEMORY_TYPES / memoryTypeGuidance
		// updates the prompt automatically, and this assertion follows it.
		for (const token of MEMORY_TYPES) {
			expect(prompt).toContain(token);
		}
		// The exact guidance block (every token + when to use it) is embedded verbatim.
		expect(prompt).toContain(memoryTypeGuidance());
		// The JSON-shape hint reads as the closed set, not a free-form string.
		expect(prompt).toContain(`one of ${MEMORY_TYPES.join("|")}`);
	});
});

describe("extraction-type binding — an off-enum model type flows to a VALID fan-out fact_type", () => {
	// A recording fake queue — only enqueue is exercised by the fan-out.
	function recordingQueue(): { queue: JobQueueService; enqueued: JobInput[] } {
		const enqueued: JobInput[] = [];
		const queue: JobQueueService = {
			async enqueue(job: JobInput): Promise<string> {
				enqueued.push(job);
				return `job-${enqueued.length}`;
			},
			async lease(): Promise<LeasedJob | null> {
				return null;
			},
			async complete(): Promise<void> {},
			async fail(): Promise<void> {},
			start(): void {},
			stop(): void {},
		};
		return { queue, enqueued };
	}

	it("model emits type:'banana' → extraction coerces → decision fan-out enqueues fact_type:'fact'", async () => {
		// Drive the real extraction core with a fake model emitting an off-enum type, then
		// run the real extraction→decision fan-out over the bounded result. The forwarded
		// fact (decision job payload) must carry a valid taxonomy token.
		const body = JSON.stringify({
			facts: [{ content: "the API returns 429 under load", type: "banana", confidence: 0.9 }],
			entities: [],
		});
		const model = createFakeModelClient({ memory_extraction: body });
		const config = PipelineConfigSchema.parse({ enabled: true, extractionProvider: "fake-router" });

		const result = await extractFromText("raw", config, model);
		expect(result.facts).toHaveLength(1); // KEPT, not dropped.
		expect(result.facts[0].type).toBe("fact"); // coerced to the floor.

		const { queue, enqueued } = recordingQueue();
		const job: StageJob = {
			id: "j-e2e",
			kind: "memory_extraction",
			attempt: 1,
			scope: { org: "o", workspace: "w", agentId: "a" },
			payload: { content: "raw" },
		};
		await extractionFanOut(queue)(job, result);

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].kind).toBe("memory_decision");
		const forwarded = (enqueued[0].payload.facts as Array<{ type: string }>)[0];
		expect(isMemoryType(forwarded.type)).toBe(true);
		expect(forwarded.type).toBe("fact");
	});

	it("model emits a synonym type:'rule' → kept and folded to 'convention' end-to-end", async () => {
		const body = JSON.stringify({
			facts: [{ content: "prefer named exports", type: "rule", confidence: 0.85 }],
			entities: [],
		});
		const model = createFakeModelClient({ memory_extraction: body });
		const config = PipelineConfigSchema.parse({ enabled: true, extractionProvider: "fake-router" });

		const result = await extractFromText("raw", config, model);
		expect(result.facts[0].type).toBe("convention");

		const { queue, enqueued } = recordingQueue();
		await extractionFanOut(queue)(
			{
				id: "j2",
				kind: "memory_extraction",
				attempt: 1,
				scope: { org: "o", workspace: "w", agentId: "a" },
				payload: { content: "raw" },
			},
			result,
		);
		const forwarded = (enqueued[0].payload.facts as Array<{ type: string }>)[0];
		expect(forwarded.type).toBe("convention");
		expect(isMemoryType(forwarded.type)).toBe(true);
	});
});
