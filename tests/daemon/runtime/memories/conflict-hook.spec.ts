/**
 * PRD-058b LIVE (C-1) — the conflict-hook builder + claim-outcome derivation unit suite.
 *
 * Pins the two new pieces the live wiring adds:
 *   - `deriveClaimOutcome`: an affirmative claim and its single-negation contradiction land OPPOSITE
 *     outcomes (they compete in the resolver); two affirmations agree.
 *   - `createControlledWriteConflictHook`: builds voters from the committed memory + candidates and runs
 *     `detectAndProject`, projecting an open conflict for a genuine contradiction; a no-candidate call is
 *     a no-op; the hook never throws (fail-soft).
 */

import { describe, expect, it } from "vitest";

import {
	OUTCOME_AFFIRM,
	OUTCOME_NEGATE,
	deriveClaimOutcome,
} from "../../../../src/daemon/runtime/memories/claim-outcome.js";
import { createControlledWriteConflictHook } from "../../../../src/daemon/runtime/memories/conflict-hook.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };

describe("PRD-058b deriveClaimOutcome — the resolver's competing-vs-agreeing split", () => {
	it("an affirmative claim and its single-negation contradiction land OPPOSITE outcomes", () => {
		const affirm = deriveClaimOutcome("we deploy on fridays");
		const negate = deriveClaimOutcome("we never deploy on fridays");
		expect(affirm).toBe(OUTCOME_AFFIRM);
		expect(negate).toBe(OUTCOME_NEGATE);
		expect(affirm).not.toBe(negate); // they compete.
	});

	it("two affirmations land the SAME outcome (they agree, no false competition)", () => {
		expect(deriveClaimOutcome("we deploy on fridays")).toBe(deriveClaimOutcome("we ship on fridays"));
	});

	it("an empty/garbage string → the conservative affirm default (never a throw)", () => {
		expect(deriveClaimOutcome("")).toBe(OUTCOME_AFFIRM);
		expect(deriveClaimOutcome("!!! ??? ...")).toBe(OUTCOME_AFFIRM);
	});

	it("a double negation flips back to affirm (polarity parity)", () => {
		// two negation markers ("not" + "no") → even → affirm.
		expect(deriveClaimOutcome("it is not true that we have no deploys")).toBe(OUTCOME_AFFIRM);
	});

	it("an OVERLAP token (in BOTH the negation set AND an antonym negative pole) flips exactly ONCE, not twice", () => {
		// `remove` is in NEGATION_TOKENS and is the negative pole of `add`/`remove`; `stop` and `false`
		// likewise. The parity counts each token at most once (the `||` dedupes the overlap), so a single
		// such token is ONE flip → negate. A double-count regression would make these even → affirm, which
		// would WRONGLY make "add X" and "remove X" agree and break the resolver's winner/loser split.
		expect(deriveClaimOutcome("remove the cache flag")).toBe(OUTCOME_NEGATE); // one flip, not two.
		expect(deriveClaimOutcome("stop the worker")).toBe(OUTCOME_NEGATE);
		expect(deriveClaimOutcome("the value is false")).toBe(OUTCOME_NEGATE);
		// The competing pair the resolver relies on: an affirmative add vs its remove land OPPOSITE outcomes.
		expect(deriveClaimOutcome("add the cache flag")).toBe(OUTCOME_AFFIRM);
		expect(deriveClaimOutcome("add the cache flag")).not.toBe(deriveClaimOutcome("remove the cache flag"));
	});
});

/** A fixed 768-dim vector so the detector's claim-slot `sim` is high (the same-subject signal). */
function fakeEmbed(): EmbedClient {
	return { async embed(): Promise<readonly number[]> { return Array.from({ length: 768 }, () => 0.05); } };
}

function storageCapturing(): { storage: ReturnType<typeof createStorageClient>; inserts: string[] } {
	const inserts: string[] = [];
	const responder = (req: TransportRequest): Record<string, unknown>[] => {
		if (/INSERT\s+INTO\s+"memory_conflicts"/i.test(req.sql)) inserts.push(req.sql);
		return [];
	};
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, inserts };
}

describe("PRD-058b createControlledWriteConflictHook — the live detection seam", () => {
	it("projects an OPEN conflict for a genuine contradiction (committed fact vs its candidate)", async () => {
		const { storage, inserts } = storageCapturing();
		const hook = createControlledWriteConflictHook({ storage, embed: fakeEmbed() });
		const out = await hook.detect(
			{ id: "mem_b", content: "we never deploy on fridays" },
			[{ id: "mem_a", content: "we deploy on fridays" }],
			SCOPE,
		);
		expect(out.projectedIds.length).toBeGreaterThanOrEqual(1);
		expect(inserts.some((sql) => /'open'/.test(sql))).toBe(true); // status open, the safety default.
	});

	it("is a no-op with no candidates (the candidate-bounded short-circuit)", async () => {
		const { storage, inserts } = storageCapturing();
		const hook = createControlledWriteConflictHook({ storage, embed: fakeEmbed() });
		const out = await hook.detect({ id: "mem_solo", content: "typescript is the language" }, [], SCOPE);
		expect(out.projectedIds).toHaveLength(0);
		expect(inserts).toHaveLength(0);
	});

	it("fail-soft: a storage that throws on the projection read never throws out of the hook", async () => {
		const failing = {
			query: async (sql: string) => {
				// A version-read for the projection append throws; the hook must swallow it.
				throw new Error("storage down");
				return sql;
			},
		} as never;
		const hook = createControlledWriteConflictHook({ storage: failing, embed: fakeEmbed() });
		// detectAndProject is fail-soft; the hook must resolve (never reject) even when storage explodes.
		await expect(
			hook.detect({ id: "mem_b", content: "we never deploy on fridays" }, [{ id: "mem_a", content: "we deploy on fridays" }], SCOPE),
		).resolves.toBeDefined();
	});
});
