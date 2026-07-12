/**
 * SP-1 / ISS-001 — the PER-JOB live extraction gate (`'auto'` is no longer collapsed at boot).
 *
 * Verification posture: drive `extractFromText` / `createExtractionHandler` with a fake
 * model client + a live gate (fake clock), no daemon. Proves:
 *   - the auto-collapse-removal REGRESSION MATRIX: explicit provider and `'none'`/no-key
 *     paths behave exactly as before (the gate only ever decides the `'auto'` + master-gate
 *     questions);
 *   - `'auto'` + gate.providerConfigured() true → extraction RUNS (the model is called);
 *   - `'auto'` + gate.providerConfigured() false → NO model call (fail-closed);
 *   - the master gate flips LIVE between two jobs of the SAME handler (no rebuild);
 *   - a provider key added mid-run is picked up by the NEXT job once the TTL lapses
 *     (fake clock — the "save a key, memory starts forming, no restart" acceptance);
 *   - a gate-less call (unit/pure-config posture) is byte-identical to the old behavior.
 */

import { describe, expect, it } from "vitest";

import { PipelineConfigSchema } from "../../../../src/daemon/runtime/pipeline/config.js";
import {
	createExtractionHandler,
	extractFromText,
} from "../../../../src/daemon/runtime/pipeline/extraction.js";
import { createFakeModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import {
	createLiveExtractionGate,
	type LiveExtractionGate,
	PIPELINE_RELOAD_DEBOUNCE_MS,
} from "../../../../src/daemon/runtime/pipeline/reload.js";
import type { StageJob } from "../../../../src/daemon/runtime/pipeline/stage-worker.js";

const EXTRACTION_JSON = '{"facts":[{"content":"x","type":"fact","confidence":0.9}],"entities":[]}';

/** A config whose `extractionProvider` is exactly as given (enabled defaults true here). */
function cfg(extractionProvider: string, enabled = true): ReturnType<typeof PipelineConfigSchema.parse> {
	return PipelineConfigSchema.parse({ enabled, extractionProvider });
}

/** A live gate over a mutable secret-name set + a manual clock. */
function liveGate(input: {
	enabled?: boolean;
	credentialNames?: readonly string[];
	names: () => readonly string[];
	now: () => number;
}): LiveExtractionGate {
	return createLiveExtractionGate({
		enabled: input.enabled ?? true,
		credentialNames: input.credentialNames ?? ["ANTHROPIC_API_KEY"],
		listSecretNames: input.names,
		now: input.now,
	});
}

/** A minimal extraction StageJob carrying `content`. */
function job(content: string): StageJob {
	return {
		id: "job-1",
		kind: "memory_extraction",
		attempt: 1,
		scope: { org: "acme", workspace: "backend", agentId: "default" },
		payload: { content },
	};
}

describe("the auto-collapse-removal regression matrix (explicit-provider + no-key paths)", () => {
	it("explicit provider: runs regardless of the provider probe (an operator override is honored)", async () => {
		const model = createFakeModelClient({ memory_extraction: EXTRACTION_JSON });
		const gate = liveGate({ names: () => [], now: () => 0 }); // probe says NOT configured…
		const result = await extractFromText("text", cfg("fake-router"), model, undefined, gate);
		expect(model.calls).toHaveLength(1); // …but the explicit override still runs.
		expect(result.facts).toHaveLength(1);
	});

	it("explicit 'none': never calls the model, even with a key present and the gate live", async () => {
		const model = createFakeModelClient({ memory_extraction: EXTRACTION_JSON });
		const gate = liveGate({ names: () => ["ANTHROPIC_API_KEY"], now: () => 0 });
		const result = await extractFromText("text", cfg("none"), model, undefined, gate);
		expect(model.calls).toHaveLength(0);
		expect(result.facts).toHaveLength(0);
	});

	it("'auto' + NO key: fail-closed, no model call (the old boot collapse's honest half, kept)", async () => {
		const model = createFakeModelClient({ memory_extraction: EXTRACTION_JSON });
		const gate = liveGate({ names: () => [], now: () => 0 });
		const result = await extractFromText("text", cfg("auto"), model, undefined, gate);
		expect(model.calls).toHaveLength(0);
		expect(result.facts).toHaveLength(0);
	});

	it("'auto' + key present: extraction runs (the provider-derived default)", async () => {
		const model = createFakeModelClient({ memory_extraction: EXTRACTION_JSON });
		const gate = liveGate({ names: () => ["ANTHROPIC_API_KEY"], now: () => 0 });
		const result = await extractFromText("text", cfg("auto"), model, undefined, gate);
		expect(model.calls).toHaveLength(1);
		expect(result.facts).toHaveLength(1);
	});

	it("without a gate the pure-config decision is unchanged ('auto' stays conservatively off)", async () => {
		const model = createFakeModelClient({ memory_extraction: EXTRACTION_JSON });
		expect((await extractFromText("t", cfg("auto"), model)).facts).toHaveLength(0);
		expect(model.calls).toHaveLength(0);
		expect((await extractFromText("t", cfg("fake-router"), model)).facts).toHaveLength(1);
	});
});

describe("the live master gate (memory toggle) flips between jobs of ONE handler", () => {
	it("gate.enabled() overrides the boot config per job — off → on with no rebuild", async () => {
		const model = createFakeModelClient({ memory_extraction: EXTRACTION_JSON });
		const gate = liveGate({ enabled: false, names: () => ["ANTHROPIC_API_KEY"], now: () => 0 });
		const results: number[] = [];
		const handler = createExtractionHandler({
			config: cfg("auto", true), // the boot config said enabled…
			model,
			gate,
			onResult: (_job, result) => {
				results.push(result.facts.length);
			},
		});
		await handler(job("first"));
		expect(model.calls).toHaveLength(0); // …but the LIVE gate says off → no model call.
		gate.setEnabled(true); // the reload seam applied the dashboard toggle.
		await handler(job("second"));
		expect(model.calls).toHaveLength(1); // the SAME handler now extracts.
		expect(results).toEqual([0, 1]);
	});
});

describe("a key saved mid-run reaches the NEXT job within the TTL (fake clock)", () => {
	it("'auto' extraction turns on ~1s after the key lands, no restart, no handler rebuild", async () => {
		let nowMs = 0;
		let names: readonly string[] = [];
		const model = createFakeModelClient({ memory_extraction: EXTRACTION_JSON });
		const gate = liveGate({ names: () => names, now: () => nowMs });
		const handler = createExtractionHandler({ config: cfg("auto"), model, gate });

		await handler(job("before the key")); // boot state: no key → no LLM.
		expect(model.calls).toHaveLength(0);

		names = ["ANTHROPIC_API_KEY"]; // the operator saves the provider key (out-of-band).
		nowMs += PIPELINE_RELOAD_DEBOUNCE_MS + 1; // one TTL window later…
		await handler(job("after the key"));
		expect(model.calls).toHaveLength(1); // …the very next job extracts.
	});
});
