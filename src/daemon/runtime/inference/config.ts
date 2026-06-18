/**
 * Inference config contract — PRD-010a (the AC-bearing deliverable: a-AC-1..5).
 *
 * Parses, validates, and cross-reference-resolves the `inference:` block of
 * `agent.yaml` into the resolved {@link InferenceConfig} the routing engine reads.
 * Mirrors the fail-closed zod pattern in `pipeline/config.ts` / `runtime/config.ts`:
 * a single `safeParse` boundary, then a deterministic cross-reference pass that
 * FAILS the parse (naming the offender) on any dangling reference. This is the ONE
 * place untrusted config crosses into typed inference policy (zod-at-boundary).
 *
 * ── The five ACs this module owns ───────────────────────────────────────────
 *   a-AC-1  a valid `inference:` block parses AND cross-refs resolve (workload →
 *           real policy, policy → real targets, target → real account).
 *   a-AC-2  `apiKey: ${SECRET_REF}` → {@link dumpInferenceConfig} shows the
 *           reference, the resolved key never appears (there is no resolved key in
 *           the parsed structure at all — by construction).
 *   a-AC-3  a workload naming a non-existent policy → parse FAILS with an error
 *           identifying the dangling ref by name.
 *   a-AC-4  an account/target with an INLINE raw key (not a `${...}` reference) →
 *           REJECTED at parse via a zod refinement with a clear message.
 *   a-AC-5  a valid block → each {@link Target} exposes its `privacyTier` +
 *           `capabilities` to the engine.
 *
 * ── Secret-ref enforcement is the security floor (a-AC-4 / D-2) ──────────────
 * The credential field accepts ONLY a `${SECRET_REF}` reference string. An inline
 * raw key (anything not matching the reference shape) is rejected with a message
 * that does NOT echo the rejected value (so a fat-fingered real key never lands in
 * a log). The reference is STORED AS-IS in {@link Account.apiKeyRef}; it is never
 * resolved here — resolution happens at execution time through the
 * `SecretResolver` seam. The parsed structure therefore contains no raw key by
 * construction, which is what makes {@link dumpInferenceConfig} safe (a-AC-2).
 */

import { promises as fs } from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { CapabilitySchema, type InferenceConfig, PolicyModeSchema, PrivacyTierSchema } from "./contracts.js";

/**
 * The `${SECRET_REF}` reference shape (a-AC-4). A credential field MUST be exactly
 * `${NAME}` where NAME is an env-var-style token — an inline raw key (no `${…}`
 * wrapper) is rejected. Anchored so a value like `sk-live-…` or `${KEY} oops` does
 * not match.
 */
const SECRET_REF_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * A structured inference-config error. Carries the flattened issues so the daemon
 * logs exactly which section/ref failed. Distinct type (mirrors
 * `PipelineConfigError` / `RuntimeConfigError`) so a config failure is never
 * mistaken for a runtime request failure. The issue strings name the offending ref
 * (a-AC-3) but NEVER echo a rejected credential value (a-AC-4).
 */
export class InferenceConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid inference config: ${issues.join("; ")}`);
		this.name = "InferenceConfigError";
		this.issues = issues;
	}
}

/**
 * The credential-field schema (a-AC-4): a trimmed non-empty string that MUST match
 * the {@link SECRET_REF_PATTERN}. The refinement message is generic ("must be a
 * `${SECRET_REF}` reference, not an inline key") and deliberately does NOT include
 * the rejected value, so a real key fat-fingered into config never reaches a log.
 */
const SecretRef = z
	.string()
	.trim()
	.min(1, "apiKey must not be empty")
	.refine((v) => SECRET_REF_PATTERN.test(v), {
		message: "apiKey must be a ${SECRET_REF} reference, not an inline raw key",
	});

/** zod shape for one account (010a FR-2). `apiKey` is the secret REFERENCE only. */
const AccountSchema = z.object({
	id: z.string().trim().min(1, "account.id must not be empty"),
	provider: z.string().trim().min(1, "account.provider must not be empty"),
	apiKey: SecretRef,
});

/** zod shape for one target (010a FR-3). Carries the privacy tier + capabilities (a-AC-5). */
const TargetSchema = z.object({
	id: z.string().trim().min(1, "target.id must not be empty"),
	account: z.string().trim().min(1, "target.account must not be empty"),
	model: z.string().trim().min(1, "target.model must not be empty"),
	privacy: PrivacyTierSchema,
	capabilities: z.array(CapabilitySchema).default([]),
	contextWindow: z.number().int().positive().default(8_192),
});

/** zod shape for one policy (010a FR-4). `chain` for strict order; `allowlist` for hybrid. */
const PolicySchema = z.object({
	id: z.string().trim().min(1, "policy.id must not be empty"),
	mode: PolicyModeSchema,
	chain: z.array(z.string().trim().min(1)).default([]),
	allowlist: z.array(z.string().trim().min(1)).optional(),
});

/** zod shape for one workload (010a FR-5). Binds a policy + the gate floors. */
const WorkloadSchema = z.object({
	name: z.string().trim().min(1, "workload.name must not be empty"),
	policy: z.string().trim().min(1, "workload.policy must not be empty"),
	requiredCapabilities: z.array(CapabilitySchema).default([]),
	minPrivacyTier: PrivacyTierSchema.default("public"),
	requestContextTokens: z.number().int().positive().optional(),
});

/**
 * The `inference:` block shape (010a FR-1). The four sections. zod validates the
 * SHAPE (types, enums, the secret-ref refinement); the cross-reference resolution
 * runs AFTER, in {@link resolveCrossRefs}.
 */
const InferenceBlockSchema = z.object({
	accounts: z.array(AccountSchema).default([]),
	targets: z.array(TargetSchema).default([]),
	policies: z.array(PolicySchema).default([]),
	workloads: z.array(WorkloadSchema).default([]),
});

/** The zod-parsed (pre-cross-ref) block. */
type InferenceBlock = z.infer<typeof InferenceBlockSchema>;

/**
 * Resolve every cross-reference, collecting EVERY dangling ref (not just the
 * first) so one parse reports all problems. Each issue NAMES the offending ref
 * (a-AC-1 / a-AC-3):
 *   - a target's `account` MUST name a real account;
 *   - a policy's `chain` + `allowlist` targets MUST name real targets;
 *   - a workload's `policy` MUST name a real policy.
 * Returns the issue list (empty when the graph is fully connected).
 */
function resolveCrossRefs(block: InferenceBlock): string[] {
	const issues: string[] = [];
	const accountIds = new Set(block.accounts.map((a) => a.id));
	const targetIds = new Set(block.targets.map((t) => t.id));
	const policyIds = new Set(block.policies.map((p) => p.id));

	for (const t of block.targets) {
		if (!accountIds.has(t.account)) {
			issues.push(`target "${t.id}" references unknown account "${t.account}"`);
		}
	}
	for (const p of block.policies) {
		for (const ref of p.chain) {
			if (!targetIds.has(ref)) {
				issues.push(`policy "${p.id}" chain references unknown target "${ref}"`);
			}
		}
		for (const ref of p.allowlist ?? []) {
			if (!targetIds.has(ref)) {
				issues.push(`policy "${p.id}" allowlist references unknown target "${ref}"`);
			}
		}
	}
	for (const w of block.workloads) {
		if (!policyIds.has(w.policy)) {
			issues.push(`workload "${w.name}" references unknown policy "${w.policy}"`);
		}
	}
	return issues;
}

/** Map the zod-parsed block onto the resolved {@link InferenceConfig} the engine reads. */
function toInferenceConfig(block: InferenceBlock): InferenceConfig {
	return {
		accounts: block.accounts.map((a) => ({ id: a.id, provider: a.provider, apiKeyRef: a.apiKey })),
		targets: block.targets.map((t) => ({
			id: t.id,
			accountRef: t.account,
			model: t.model,
			privacyTier: t.privacy,
			capabilities: t.capabilities,
			contextWindow: t.contextWindow,
		})),
		policies: block.policies.map((p) => ({
			id: p.id,
			mode: p.mode,
			chain: p.chain,
			...(p.allowlist === undefined ? {} : { allowlist: p.allowlist }),
		})),
		workloads: block.workloads.map((w) => ({
			name: w.name,
			policyRef: w.policy,
			requiredCapabilities: w.requiredCapabilities,
			minPrivacyTier: w.minPrivacyTier,
			...(w.requestContextTokens === undefined ? {} : { requestContextTokens: w.requestContextTokens }),
		})),
	};
}

/**
 * Parse + validate + cross-ref-resolve a raw `inference:` block into the resolved
 * {@link InferenceConfig} (010a FR-1/FR-6 / a-AC-1/a-AC-3/a-AC-4/a-AC-5). This is
 * the ZOD CORE — fully tested, independent of the file read. Fails closed:
 *   1. zod shape validation (types, enums, the secret-ref refinement a-AC-4);
 *   2. cross-reference resolution naming any dangling ref (a-AC-1/a-AC-3).
 * Throws {@link InferenceConfigError} listing EVERY issue.
 */
export function parseInferenceConfig(raw: unknown): InferenceConfig {
	const parsed = InferenceBlockSchema.safeParse(raw ?? {});
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new InferenceConfigError(issues);
	}
	const crossRefIssues = resolveCrossRefs(parsed.data);
	if (crossRefIssues.length > 0) {
		throw new InferenceConfigError(crossRefIssues);
	}
	return toInferenceConfig(parsed.data);
}

/**
 * A redacted dump of a resolved {@link InferenceConfig} for diagnostics (a-AC-2 /
 * 010a FR-7). Each account's credential is shown as the secret REFERENCE
 * (`apiKeyRef`) ONLY — the resolved value never appears (and never existed in the
 * parsed structure). Targets expose `privacyTier` + `capabilities` (a-AC-5) so an
 * operator can audit the gate inputs. Pure; returns a plain object safe to log.
 */
export function dumpInferenceConfig(cfg: InferenceConfig): object {
	return {
		accounts: cfg.accounts.map((a) => ({ id: a.id, provider: a.provider, apiKey: a.apiKeyRef })),
		targets: cfg.targets.map((t) => ({
			id: t.id,
			account: t.accountRef,
			model: t.model,
			privacyTier: t.privacyTier,
			capabilities: [...t.capabilities],
			contextWindow: t.contextWindow,
		})),
		policies: cfg.policies.map((p) => ({
			id: p.id,
			mode: p.mode,
			chain: [...p.chain],
			...(p.allowlist === undefined ? {} : { allowlist: [...p.allowlist] }),
		})),
		workloads: cfg.workloads.map((w) => ({
			name: w.name,
			policy: w.policyRef,
			requiredCapabilities: [...w.requiredCapabilities],
			minPrivacyTier: w.minPrivacyTier,
			...(w.requestContextTokens === undefined ? {} : { requestContextTokens: w.requestContextTokens }),
		})),
	};
}

/**
 * Thin YAML-backed loader: read `filePath`, parse YAML, pull the `inference:`
 * block, and resolve it via {@link parseInferenceConfig}. Returns `null` when the
 * file is absent OR the `inference:` block is absent (the daemon runs without
 * inference configured — a missing block is not an error). A PRESENT but invalid
 * block still throws {@link InferenceConfigError} (fail-closed). This wrapper is
 * deliberately thin; the zod CORE above is what the tests target.
 */
export async function loadInferenceConfigFromYaml(filePath: string): Promise<InferenceConfig | null> {
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (err: unknown) {
		// A missing file means inference is simply not configured here.
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const doc = parseYaml(text) as unknown;
	if (doc === null || typeof doc !== "object") return null;
	const block = (doc as Record<string, unknown>).inference;
	if (block === undefined || block === null) return null;
	return parseInferenceConfig(block);
}
