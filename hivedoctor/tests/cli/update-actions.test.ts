/**
 * The CLI update-action mapping (FIX 1): `update --check` must PREVIEW (no mutation), while
 * `update` applies the real transaction. This proves the routing over a fake engine whose
 * previewUpdate / runUpdateTransaction are spies -- so it is impossible for `--check` to take
 * the mutating path even by accident.
 */

import { describe, expect, it, vi } from "vitest";

import { createUpdateActions } from "../../src/cli/update-actions.js";
import type {
	UpdateEngine,
	UpdatePreview,
	UpdateTransactionResult,
} from "../../src/update/update-engine.js";

/** A fake engine with spy preview + transaction so we can assert exactly which path ran. */
function fakeEngine(opts: {
	preview?: UpdatePreview;
	transaction?: UpdateTransactionResult;
}): {
	engine: UpdateEngine;
	previewUpdate: ReturnType<typeof vi.fn>;
	runUpdateTransaction: ReturnType<typeof vi.fn>;
} {
	const previewUpdate = vi.fn(
		async (): Promise<UpdatePreview> => opts.preview ?? { eligible: false, fromVersion: null, reason: "already_current" },
	);
	const runUpdateTransaction = vi.fn(
		async (): Promise<UpdateTransactionResult> => opts.transaction ?? { status: "no_update" },
	);
	return { engine: { previewUpdate, runUpdateTransaction }, previewUpdate, runUpdateTransaction };
}

describe("createUpdateActions: `update --check` routes to preview, never the transaction", () => {
	it("checkPrimaryUpdate calls previewUpdate ONLY (never runUpdateTransaction)", async () => {
		const fe = fakeEngine({ preview: { eligible: true, fromVersion: "0.1.8", toVersion: "0.1.9" } });
		const selfUpdate = vi.fn(async () => "self");
		const actions = createUpdateActions(fe.engine, selfUpdate);

		const line = await actions.checkPrimaryUpdate();

		expect(fe.previewUpdate).toHaveBeenCalledTimes(1);
		expect(fe.runUpdateTransaction).not.toHaveBeenCalled();
		expect(line).toBe("Update available: 0.1.8 -> 0.1.9.");
	});

	it("checkPrimaryUpdate reports the no-go reason when not eligible (still no transaction)", async () => {
		const fe = fakeEngine({ preview: { eligible: false, fromVersion: "0.1.9", reason: "already_current" } });
		const actions = createUpdateActions(fe.engine, vi.fn(async () => "self"));

		const line = await actions.checkPrimaryUpdate();

		expect(line).toBe("No update: already_current.");
		expect(fe.runUpdateTransaction).not.toHaveBeenCalled();
	});

	it("applyPrimaryUpdate runs the real transaction (never previewUpdate)", async () => {
		const fe = fakeEngine({
			transaction: { status: "updated", fromVersion: "0.1.8", toVersion: "0.1.9" },
		});
		const actions = createUpdateActions(fe.engine, vi.fn(async () => "self"));

		const line = await actions.applyPrimaryUpdate();

		expect(fe.runUpdateTransaction).toHaveBeenCalledTimes(1);
		expect(fe.previewUpdate).not.toHaveBeenCalled();
		expect(line).toBe("Update updated: 0.1.8 -> 0.1.9.");
	});

	it("applyPrimaryUpdate reports updated_unverified honestly", async () => {
		const fe = fakeEngine({
			transaction: { status: "updated_unverified", fromVersion: "0.1.8", toVersion: "0.1.9" },
		});
		const actions = createUpdateActions(fe.engine, vi.fn(async () => "self"));
		const line = await actions.applyPrimaryUpdate();
		expect(line).toBe("Update updated_unverified: 0.1.8 -> 0.1.9.");
	});

	it("selfUpdate is passed straight through", async () => {
		const selfUpdate = vi.fn(async () => "HiveDoctor updated");
		const fe = fakeEngine({});
		const actions = createUpdateActions(fe.engine, selfUpdate);
		expect(await actions.selfUpdate()).toBe("HiveDoctor updated");
		expect(fe.previewUpdate).not.toHaveBeenCalled();
		expect(fe.runUpdateTransaction).not.toHaveBeenCalled();
	});
});
