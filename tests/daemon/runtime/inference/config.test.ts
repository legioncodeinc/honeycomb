/**
 * PRD-010a — inference config contract tests (a-AC-1..5, each AC-named).
 *
 * Verification posture (EXECUTION_LEDGER-prd-010): the zod CORE
 * (`parseInferenceConfig`) is the target — no file read, no live backend. Each
 * `describe`/`it` names the AC it proves so the ledger maps 1:1.
 */

import { describe, expect, it } from "vitest";

import {
	dumpInferenceConfig,
	InferenceConfigError,
	parseInferenceConfig,
} from "../../../../src/daemon/runtime/inference/config.js";

/** A complete, valid `inference:` block used as the happy-path fixture. */
function validBlock(): unknown {
	return {
		accounts: [{ id: "anthropic-main", provider: "anthropic", apiKey: "${ANTHROPIC_API_KEY}" }],
		targets: [
			{
				id: "sonnet",
				account: "anthropic-main",
				model: "claude-sonnet-4",
				privacy: "private",
				capabilities: ["chat", "streaming"],
				contextWindow: 200_000,
			},
		],
		policies: [{ id: "default", mode: "strict", chain: ["sonnet"] }],
		workloads: [
			{
				name: "memory_extraction",
				policy: "default",
				requiredCapabilities: ["chat"],
				minPrivacyTier: "private",
			},
		],
	};
}

describe("a-AC-1: a valid inference block parses and cross-refs resolve", () => {
	it("parses the four sections and resolves workload→policy→target→account", () => {
		const cfg = parseInferenceConfig(validBlock());
		expect(cfg.accounts).toHaveLength(1);
		expect(cfg.targets).toHaveLength(1);
		expect(cfg.policies).toHaveLength(1);
		expect(cfg.workloads).toHaveLength(1);
		// Cross-refs are intact: workload→policy, policy→target, target→account.
		expect(cfg.workloads[0]?.policyRef).toBe("default");
		expect(cfg.policies[0]?.chain).toEqual(["sonnet"]);
		expect(cfg.targets[0]?.accountRef).toBe("anthropic-main");
	});

	it("accepts the secret reference and stores it as the reference (not resolved)", () => {
		const cfg = parseInferenceConfig(validBlock());
		expect(cfg.accounts[0]?.apiKeyRef).toBe("${ANTHROPIC_API_KEY}");
	});
});

describe("a-AC-2: a dumped config shows the secret reference, never the value", () => {
	it("dumps apiKey as the ${SECRET_REF} reference only", () => {
		const cfg = parseInferenceConfig(validBlock());
		const dumped = dumpInferenceConfig(cfg) as {
			accounts: { id: string; provider: string; apiKey: string }[];
		};
		expect(dumped.accounts[0]?.apiKey).toBe("${ANTHROPIC_API_KEY}");
		// No resolved key can appear — there is none in the parsed structure. Prove
		// the serialized dump carries only the reference, never a raw-key shape.
		const serialized = JSON.stringify(dumped);
		expect(serialized).toContain("${ANTHROPIC_API_KEY}");
		expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
	});
});

describe("a-AC-3: a workload naming a non-existent policy fails the parse by name", () => {
	it("throws InferenceConfigError identifying the dangling policy ref", () => {
		const block = validBlock() as { workloads: { policy: string }[] };
		block.workloads[0].policy = "ghost-policy";
		let caught: unknown;
		try {
			parseInferenceConfig(block);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(InferenceConfigError);
		const issues = (caught as InferenceConfigError).issues.join(" ");
		expect(issues).toContain("memory_extraction");
		expect(issues).toContain("ghost-policy");
	});

	it("also catches a dangling policy→target ref and a dangling target→account ref", () => {
		const block = validBlock() as {
			policies: { chain: string[] }[];
			targets: { account: string }[];
		};
		block.policies[0].chain = ["no-such-target"];
		block.targets[0].account = "no-such-account";
		let caught: unknown;
		try {
			parseInferenceConfig(block);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(InferenceConfigError);
		const issues = (caught as InferenceConfigError).issues.join(" ");
		expect(issues).toContain("no-such-target");
		expect(issues).toContain("no-such-account");
	});
});

describe("a-AC-4: an inline raw API key is rejected in favor of a secret reference", () => {
	it("rejects an account apiKey that is a raw key, not a ${SECRET_REF}", () => {
		const block = validBlock() as { accounts: { apiKey: string }[] };
		block.accounts[0].apiKey = "sk-live-deadbeefdeadbeefdeadbeef";
		let caught: unknown;
		try {
			parseInferenceConfig(block);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(InferenceConfigError);
		const issues = (caught as InferenceConfigError).issues.join(" ");
		expect(issues).toMatch(/SECRET_REF\} reference|reference, not an inline raw key/i);
		// The rejected raw value is NOT echoed in the error (no key leaks to a log).
		expect(issues).not.toContain("sk-live-deadbeefdeadbeefdeadbeef");
	});

	it("rejects a malformed reference shape (something that is not exactly ${NAME})", () => {
		const block = validBlock() as { accounts: { apiKey: string }[] };
		block.accounts[0].apiKey = "${KEY} trailing";
		expect(() => parseInferenceConfig(block)).toThrow(InferenceConfigError);
	});
});

describe("a-AC-5: targets expose their privacy tier and capabilities to the engine", () => {
	it("carries privacyTier + capabilities + contextWindow on each resolved target", () => {
		const cfg = parseInferenceConfig(validBlock());
		const target = cfg.targets[0];
		expect(target?.privacyTier).toBe("private");
		expect(target?.capabilities).toEqual(["chat", "streaming"]);
		expect(target?.contextWindow).toBe(200_000);
	});

	it("rejects an unknown capability token (the vocabulary is closed)", () => {
		const block = validBlock() as { targets: { capabilities: string[] }[] };
		block.targets[0].capabilities = ["chat", "telepathy"];
		expect(() => parseInferenceConfig(block)).toThrow(InferenceConfigError);
	});

	it("rejects an unknown privacy tier (the tier enum is closed)", () => {
		const block = validBlock() as { targets: { privacy: string }[] };
		block.targets[0].privacy = "ultra-secret";
		expect(() => parseInferenceConfig(block)).toThrow(InferenceConfigError);
	});
});
