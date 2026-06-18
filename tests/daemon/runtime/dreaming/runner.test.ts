/**
 * PRD-009 Dreaming Session-Runner HARNESS — the Wave-1 contract Wave 2 builds on.
 *
 * These tests pin the HARNESS behaviour (the seam contract), not 009b/009c payload
 * assembly (which the Wave-1 stubs leave as no-ops). They prove:
 *   - the payload-strategy seam is honored (null payload → empty pass, no model call);
 *   - a non-null payload drives the `memory_dreaming` workload (the stronger target);
 *   - the returned mutation set is applied through the 008c control plane, with
 *     destructive ops routed to PENDING review and additive ops applied directly (D-6);
 *   - a malformed model body never fails the pass (drop-invalid);
 *   - the state-updater fires once on success (b-AC-5).
 *
 * Drives a FAKE transport (the 008c apply path), a FAKE ModelClient, a FAKE strategy,
 * and a FAKE state-updater. No `.skip` / `.only`.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope, type StorageQuery } from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createFakeModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import {
	createDreamingRunner,
	type DreamingPayload,
	type DreamingPayloadStrategy,
	type DreamingStateUpdater,
} from "../../../../src/daemon/runtime/dreaming/runner.js";
import {
	type DreamingJobPayload,
	type DreamingPassMode,
	MUTATION_KIND_TO_OPERATION,
} from "../../../../src/daemon/runtime/dreaming/contracts.js";

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };

function storageWith(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, transport };
}

/** Everything absent / every mutation succeeds — the "all new" world (008c apply path). */
const allNew = (): StorageRow[] => [];

/** A strategy returning a fixed payload (or null for the empty-pass case). */
function fakeStrategy(payload: DreamingPayload | null, mode: DreamingPassMode = "incremental"): DreamingPayloadStrategy {
	return { mode, loadPayload: async () => payload };
}

/** A state-updater recording its calls. */
class FakeStateUpdater implements DreamingStateUpdater {
	readonly calls: { agentId: string; passAt: string }[] = [];
	async recordPassComplete(agentId: string, passAt: string): Promise<void> {
		this.calls.push({ agentId, passAt });
	}
}

const JOB: DreamingJobPayload = { mode: "incremental", agentId: "agent-alpha", enqueuedAt: "", tokensAtEnqueue: 0 };

describe("dreaming runner harness — payload-strategy seam", () => {
	it("a null payload completes an EMPTY pass: no model call, state still updated", async () => {
		const { storage, transport } = storageWith(allNew);
		const model = createFakeModelClient({ memory_dreaming: '{"mutations":[],"summary":"x"}' });
		const updater = new FakeStateUpdater();
		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy: fakeStrategy(null),
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(JOB);

		expect(model.calls).toHaveLength(0); // never called the model for nothing.
		expect(result.outcomes).toEqual([]);
		expect(transport.requests.filter((r) => /INSERT/i.test(r.sql))).toHaveLength(0);
		expect(updater.calls).toHaveLength(1); // pass finalized → pending guard releases.
		expect(updater.calls[0].agentId).toBe("agent-alpha");
	});
});

describe("dreaming runner harness — model workload + 008c apply seam (D-6 / b-AC-2 / b-AC-6)", () => {
	it("calls the memory_dreaming workload and routes destructive ops to PENDING review", async () => {
		const { storage, transport } = storageWith(allNew);
		// A merge (destructive) + a create_entity (additive bounded).
		const body = JSON.stringify({
			summary: "folded two dup entities; added one",
			mutations: [
				{ kind: "merge_entities", payload: { from: "ent_a", into: "ent_b" }, rationale: "duplicates", confidence: 0.95 },
				{ kind: "create_entity", payload: { name: "Honeycomb", type: "project" }, rationale: "missing", confidence: 0.9 },
			],
		});
		const model = createFakeModelClient({ memory_dreaming: body });
		const updater = new FakeStateUpdater();
		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy: fakeStrategy({ prompt: "dream...", tokenBudget: 128_000 }),
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(JOB);

		// b-AC-6: the stronger dreaming workload was used.
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].workload).toBe("memory_dreaming");

		// Two mutations submitted, in order.
		expect(result.outcomes.map((o) => o.kind)).toEqual(["merge_entities", "create_entity"]);
		// b-AC-2: merge_entities → entity.merge → PENDING review (destructive, not bounded).
		expect(MUTATION_KIND_TO_OPERATION.merge_entities).toBe("entity.merge");
		expect(result.outcomes[0].route).toBe("pending");
		expect(result.outcomes[0].status).toBe("pending");
		// create_entity → entity.create → direct apply (bounded).
		expect(result.outcomes[1].route).toBe("direct");
		expect(result.outcomes[1].status).toBe("applied");

		// The destructive merge wrote ONLY a `pending` proposal row, NOT an applied apply.
		const sqls = transport.requests.map((r) => r.sql);
		expect(sqls.some((s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s) && /'pending'/.test(s))).toBe(true);
		// The additive create applied → an `applied` proposal row + an entities write.
		expect(sqls.some((s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s) && /'applied'/.test(s))).toBe(true);

		// The summary + last_pass_at surface; state updated once (b-AC-5).
		expect(result.summary).toContain("folded two dup entities");
		expect(updater.calls).toHaveLength(1);
		expect(result.lastPassAt).not.toBe("");
	});

	it("a malformed / truncated model body never fails the pass (drop-invalid)", async () => {
		const { storage } = storageWith(allNew);
		const model = createFakeModelClient({ memory_dreaming: '<think>reasoning</think>{ "mutations": [ {"kind":' }); // truncated JSON.
		const updater = new FakeStateUpdater();
		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy: fakeStrategy({ prompt: "dream...", tokenBudget: 1000 }),
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(JOB);
		expect(result.outcomes).toEqual([]); // nothing applied.
		expect(updater.calls).toHaveLength(1); // pass still completes.
	});

	it("strips a CoT block + fence and applies the embedded mutation set", async () => {
		const { storage } = storageWith(allNew);
		const wrapped =
			'<think>let me reason</think>```json\n{"summary":"s","mutations":[{"kind":"create_attribute","payload":{"aspectId":"asp_1","groupKey":"role","claimKey":"title","content":"Staff","memoryId":"mem_1"},"confidence":0.9}]}\n```';
		const model = createFakeModelClient({ memory_dreaming: wrapped });
		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy: fakeStrategy({ prompt: "p", tokenBudget: 1000 }),
			model,
			stateUpdater: new FakeStateUpdater(),
		});
		const result = await runner.runPass(JOB);
		expect(result.outcomes).toHaveLength(1);
		expect(result.outcomes[0].kind).toBe("create_attribute");
		expect(result.outcomes[0].route).toBe("direct");
	});
});
