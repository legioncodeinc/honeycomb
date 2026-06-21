/**
 * PRD-026 AC-T — the committed repo-root `agent.yaml` parses into a routable
 * inference config.
 *
 * This pins the contract between the file the daemon assembly reads
 * (`AGENT_CONFIG_FILE_NAME` under the workspace root) and the config parser: the
 * `inference:` block must load (no dangling cross-refs), expose the
 * `memory_dreaming` workload the dreaming runner calls, route to the
 * `claude-sonnet-4-6` target, and carry the `${ANTHROPIC_API_KEY}` secret REFERENCE
 * only — NEVER an inline key (the a-AC-4 floor). If the file drifts (a typo, an inline
 * key, a broken ref) this test fails before any live run.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadInferenceConfigFromYaml } from "../../../../src/daemon/runtime/inference/config.js";
import { AGENT_CONFIG_FILE_NAME } from "../../../../src/daemon/runtime/assemble.js";

/** The repo root (this file is tests/daemon/runtime/inference/ → up four). */
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const AGENT_YAML = join(REPO_ROOT, AGENT_CONFIG_FILE_NAME);

describe("AC-T: the committed agent.yaml inference block", () => {
	it("parses into a routable config (cross-refs resolve, no throw)", async () => {
		const cfg = await loadInferenceConfigFromYaml(AGENT_YAML);
		expect(cfg, "agent.yaml must contain a parseable inference: block").not.toBeNull();
		if (cfg === null) return;
		expect(cfg.accounts.length).toBeGreaterThan(0);
		expect(cfg.targets.length).toBeGreaterThan(0);
		expect(cfg.policies.length).toBeGreaterThan(0);
		expect(cfg.workloads.length).toBeGreaterThan(0);
	});

	it("exposes the memory_dreaming workload routed to claude-sonnet-4-6", async () => {
		const cfg = await loadInferenceConfigFromYaml(AGENT_YAML);
		if (cfg === null) throw new Error("agent.yaml did not parse");
		const dreaming = cfg.workloads.find((w) => w.name === "memory_dreaming");
		expect(dreaming, "the dreaming runner calls the memory_dreaming workload").toBeDefined();
		// The workload's policy resolves to a target whose model is the sonnet snapshot.
		const policy = cfg.policies.find((p) => p.id === dreaming?.policyRef);
		expect(policy).toBeDefined();
		const targetId = policy?.chain[0];
		const target = cfg.targets.find((t) => t.id === targetId);
		expect(target?.model).toBe("claude-sonnet-4-6");
		expect(target?.capabilities).toContain("chat");
	});

	it("carries the ${ANTHROPIC_API_KEY} secret REFERENCE only — never an inline key (a-AC-4)", async () => {
		const cfg = await loadInferenceConfigFromYaml(AGENT_YAML);
		if (cfg === null) throw new Error("agent.yaml did not parse");
		// The account credential is stored as the `${SECRET_REF}` reference; an inline raw key
		// would have been rejected at parse (the loader would throw), so reaching here AND seeing
		// the `${...}` shape is the proof the file holds no secret.
		for (const account of cfg.accounts) {
			expect(account.apiKeyRef).toMatch(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/);
		}
		const anthropic = cfg.accounts.find((a) => a.provider === "anthropic");
		expect(anthropic?.apiKeyRef).toBe("${ANTHROPIC_API_KEY}");
	});
});
