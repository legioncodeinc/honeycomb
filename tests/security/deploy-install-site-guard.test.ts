/**
 * Security test suite for the deploy-install-site workflow guard (pentest mitigation).
 *
 * PENTEST FINDING: Unprotected `v*` tag push can publish arbitrary installer bytes to production.
 * ROOT CAUSE: Any collaborator with tag-creation permissions could push a v* tag pointing to an
 * arbitrary commit (not on the protected main branch), triggering a deployment of attacker-controlled
 * installer scripts to get.theapiary.sh without review.
 *
 * MITIGATION (defense-in-depth):
 * 1. Protected environment: The workflow requires manual approval via the `production` environment.
 * 2. Branch ancestry verification: The workflow verifies that the triggering tag is reachable from
 *    the protected main branch (i.e., the tag's commit has passed through main's required PR reviews
 *    and CI quality gates).
 * 3. Immutable tag semantics: Tags are immutable refs; re-pushing the same tag name is rejected by Git.
 *
 * This test suite verifies the branch ancestry verification logic (mitigation #2) by simulating the
 * git merge-base check that runs in the workflow. The protected environment requirement (mitigation #1)
 * is enforced by GitHub's environment protection rules and cannot be unit-tested here, but is documented
 * in SECURITY.md and site/install/README.md.
 *
 * TEST STRATEGY:
 * - Parse the actual workflow YAML to verify the environment and guard step are present
 * - Simulate the git merge-base --is-ancestor check with various tag/branch scenarios
 * - Verify that tags NOT on main are rejected (the exploit scenario)
 * - Verify that tags ON main are accepted (the legitimate release scenario)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/deploy-install-site.yaml";

/**
 * Simulates the git merge-base --is-ancestor check from the workflow guard step.
 * Returns true if tagSha is an ancestor of (or equal to) mainSha, false otherwise.
 *
 * In the real workflow, this is: `git merge-base --is-ancestor "$TAG_SHA" "$MAIN_SHA"`
 * For testing, we simulate the ancestry relationship with a simple commit graph model.
 */
function isAncestor(tagSha: string, mainSha: string, commitGraph: Map<string, string[]>): boolean {
	// If tag and main point to the same commit, the tag is trivially reachable from main.
	if (tagSha === mainSha) {
		return true;
	}

	// BFS from mainSha backwards through the commit graph to see if we can reach tagSha.
	const visited = new Set<string>();
	const queue = [mainSha];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current)) {
			continue;
		}
		visited.add(current);

		if (current === tagSha) {
			return true;
		}

		// Add parents to the queue (commitGraph maps commit -> parents).
		const parents = commitGraph.get(current) || [];
		queue.push(...parents);
	}

	return false;
}

describe("deploy-install-site workflow security guard", () => {
	it("workflow YAML declares the protected 'production' environment", async () => {
		// SECURITY PROPERTY: The workflow must require the 'production' environment, which is
		// configured with required reviewers in GitHub Settings → Environments. This ensures
		// that even if a tag passes the ancestry check, a human must approve the deployment.
		const workflowYaml = await readFile(join(process.cwd(), WORKFLOW_PATH), "utf8");

		// Verify the environment block is present in the deploy job.
		expect(workflowYaml).toContain("environment:");
		expect(workflowYaml).toContain("name: production");
		expect(workflowYaml).toContain("url: https://get.theapiary.sh");

		// Verify the security comment explaining the environment requirement is present.
		expect(workflowYaml).toContain("SECURITY: Require manual approval via a protected environment");
		expect(workflowYaml).toContain("deploying malicious installer bytes");
	});

	it("workflow YAML includes the branch ancestry verification guard step", async () => {
		// SECURITY PROPERTY: The workflow must verify that the triggering tag is reachable from
		// the protected main branch before building or deploying any installer bytes.
		const workflowYaml = await readFile(join(process.cwd(), WORKFLOW_PATH), "utf8");

		// Verify the guard step is present and runs on tag push events.
		expect(workflowYaml).toContain("Guard — verify tag is on protected main branch");
		expect(workflowYaml).toContain("if: github.event_name == 'push' && github.ref_type == 'tag'");

		// Verify the step fetches full history (fetch-depth: 0) so ancestry can be checked.
		expect(workflowYaml).toContain("fetch-depth: 0");

		// Verify the step uses git merge-base --is-ancestor to check ancestry.
		expect(workflowYaml).toContain("git merge-base --is-ancestor");

		// Verify the step exits with error if the tag is not reachable from main.
		expect(workflowYaml).toContain("exit 1");
		expect(workflowYaml).toContain("NOT reachable from the protected main branch");
	});

	it("workflow YAML runs the guard step BEFORE the build step", async () => {
		// SECURITY PROPERTY: The ancestry check must run before any installer bytes are read,
		// built, or deployed. This ensures that malicious bytes never reach the build or Cloudflare.
		const workflowYaml = await readFile(join(process.cwd(), WORKFLOW_PATH), "utf8");

		// Extract the steps section and verify the guard comes before the build.
		const stepsMatch = workflowYaml.match(/steps:([\s\S]*)/);
		expect(stepsMatch).toBeTruthy();
		const stepsSection = stepsMatch![1];

		const guardIndex = stepsSection.indexOf("Guard — verify tag is on protected main branch");
		const buildIndex = stepsSection.indexOf("Build the install surface");
		const deployIndex = stepsSection.indexOf("Deploy to Cloudflare Pages");

		expect(guardIndex).toBeGreaterThan(-1);
		expect(buildIndex).toBeGreaterThan(-1);
		expect(deployIndex).toBeGreaterThan(-1);

		// Guard must come before build and deploy.
		expect(guardIndex).toBeLessThan(buildIndex);
		expect(guardIndex).toBeLessThan(deployIndex);
	});

	describe("branch ancestry verification logic", () => {
		it("rejects a tag pointing to a commit NOT on main (exploit scenario)", () => {
			// EXPLOIT SCENARIO: An attacker with tag-creation permissions pushes a v* tag pointing
			// to an arbitrary commit that is NOT on the protected main branch. This commit contains
			// malicious installer scripts. The workflow must reject this tag and abort the deploy.
			//
			// Commit graph:
			//   main:    A <- B <- C <- D (mainSha)
			//   attacker:     B <- E <- F (tagSha, NOT on main)
			//
			// The attacker's commit F is not reachable from main (D), so the guard must reject it.

			const commitGraph = new Map<string, string[]>([
				["sha-D", ["sha-C"]], // main HEAD
				["sha-C", ["sha-B"]],
				["sha-B", ["sha-A"]],
				["sha-A", []], // root
				["sha-F", ["sha-E"]], // attacker's tag
				["sha-E", ["sha-B"]], // branched from B
			]);

			const mainSha = "sha-D";
			const attackerTagSha = "sha-F";

			// The attacker's tag is NOT reachable from main.
			const result = isAncestor(attackerTagSha, mainSha, commitGraph);
			expect(result).toBe(false);

			// In the real workflow, this would cause the guard step to exit 1 and abort the deploy.
		});

		it("accepts a tag pointing to the current main HEAD (legitimate release scenario)", () => {
			// LEGITIMATE SCENARIO: A maintainer creates a release tag pointing to the current main
			// HEAD. This commit has passed through main's required PR reviews and CI quality gates.
			// The workflow must accept this tag and proceed with the deploy (after manual approval).
			//
			// Commit graph:
			//   main: A <- B <- C <- D (mainSha, also tagSha)
			//
			// The tag points to the same commit as main, so it is trivially reachable.

			const commitGraph = new Map<string, string[]>([
				["sha-D", ["sha-C"]], // main HEAD, also the tag
				["sha-C", ["sha-B"]],
				["sha-B", ["sha-A"]],
				["sha-A", []], // root
			]);

			const mainSha = "sha-D";
			const tagSha = "sha-D"; // tag points to main HEAD

			// The tag is reachable from main (it IS main).
			const result = isAncestor(tagSha, mainSha, commitGraph);
			expect(result).toBe(true);

			// In the real workflow, this would pass the guard step and proceed to the build
			// (after manual approval via the protected environment).
		});

		it("accepts a tag pointing to an ancestor commit on main (legitimate release scenario)", () => {
			// LEGITIMATE SCENARIO: A maintainer creates a release tag pointing to an older commit
			// on main (e.g., to re-release a previous version). This commit has passed through main's
			// required PR reviews and CI quality gates. The workflow must accept this tag.
			//
			// Commit graph:
			//   main: A <- B <- C (tagSha) <- D (mainSha)
			//
			// The tag points to commit C, which is an ancestor of main HEAD (D).

			const commitGraph = new Map<string, string[]>([
				["sha-D", ["sha-C"]], // main HEAD
				["sha-C", ["sha-B"]], // tag points here
				["sha-B", ["sha-A"]],
				["sha-A", []], // root
			]);

			const mainSha = "sha-D";
			const tagSha = "sha-C"; // tag points to an ancestor of main

			// The tag is reachable from main (it's an ancestor).
			const result = isAncestor(tagSha, mainSha, commitGraph);
			expect(result).toBe(true);

			// In the real workflow, this would pass the guard step and proceed to the build.
		});

		it("rejects a tag pointing to a commit on a feature branch NOT merged to main", () => {
			// EXPLOIT SCENARIO: An attacker pushes a v* tag pointing to a commit on a feature branch
			// that has NOT been merged to main. This commit has NOT passed through main's required
			// PR reviews and CI quality gates. The workflow must reject this tag.
			//
			// Commit graph:
			//   main:    A <- B <- C <- D (mainSha)
			//   feature:      B <- E <- F (tagSha, NOT merged to main)
			//
			// The feature branch commit F is not reachable from main (D).

			const commitGraph = new Map<string, string[]>([
				["sha-D", ["sha-C"]], // main HEAD
				["sha-C", ["sha-B"]],
				["sha-B", ["sha-A"]],
				["sha-A", []], // root
				["sha-F", ["sha-E"]], // feature branch tag
				["sha-E", ["sha-B"]], // branched from B
			]);

			const mainSha = "sha-D";
			const featureTagSha = "sha-F";

			// The feature branch tag is NOT reachable from main.
			const result = isAncestor(featureTagSha, mainSha, commitGraph);
			expect(result).toBe(false);

			// In the real workflow, this would cause the guard step to exit 1 and abort the deploy.
		});

		it("rejects a tag pointing to a commit that will be merged to main in the future", () => {
			// EXPLOIT SCENARIO: An attacker pushes a v* tag pointing to a commit on a feature branch
			// that is AHEAD of main (i.e., main has not yet merged the feature branch). Even though
			// the feature branch may eventually be merged, the tag is not yet reachable from main at
			// the time of the tag push. The workflow must reject this tag.
			//
			// Commit graph:
			//   main:    A <- B <- C (mainSha)
			//   feature:      B <- C <- D <- E (tagSha, ahead of main)
			//
			// The feature branch commit E is not reachable from main (C) because main has not yet
			// merged the feature branch.

			const commitGraph = new Map<string, string[]>([
				["sha-C", ["sha-B"]], // main HEAD
				["sha-B", ["sha-A"]],
				["sha-A", []], // root
				["sha-E", ["sha-D"]], // feature branch tag (ahead of main)
				["sha-D", ["sha-C"]], // feature branch continues from main
			]);

			const mainSha = "sha-C";
			const futureTagSha = "sha-E";

			// The future tag is NOT reachable from main (main is behind).
			const result = isAncestor(futureTagSha, mainSha, commitGraph);
			expect(result).toBe(false);

			// In the real workflow, this would cause the guard step to exit 1 and abort the deploy.
			// The attacker would need to merge the feature branch to main first, which would require
			// passing PR reviews and CI quality gates.
		});

		it("accepts a tag after a merge commit brings the feature branch into main", () => {
			// LEGITIMATE SCENARIO: A feature branch is merged to main via a merge commit. A maintainer
			// then creates a release tag pointing to a commit on the merged feature branch. This commit
			// is now reachable from main (via the merge commit), so the workflow must accept the tag.
			//
			// Commit graph:
			//   main:    A <- B <- C <- M (mainSha, merge commit)
			//   feature:      B <- D <- E (tagSha)
			//                       ^
			//                       |
			//                       M (merge commit has two parents: C and E)
			//
			// The tag points to commit E, which is reachable from main (M) via the merge commit.

			const commitGraph = new Map<string, string[]>([
				["sha-M", ["sha-C", "sha-E"]], // main HEAD (merge commit with two parents)
				["sha-C", ["sha-B"]],
				["sha-B", ["sha-A"]],
				["sha-A", []], // root
				["sha-E", ["sha-D"]], // feature branch tag
				["sha-D", ["sha-B"]], // feature branch
			]);

			const mainSha = "sha-M";
			const mergedTagSha = "sha-E";

			// The tag is reachable from main (via the merge commit).
			const result = isAncestor(mergedTagSha, mainSha, commitGraph);
			expect(result).toBe(true);

			// In the real workflow, this would pass the guard step and proceed to the build.
		});
	});

	describe("workflow trigger conditions", () => {
		it("workflow triggers on v* tag push", async () => {
			// SECURITY PROPERTY: The workflow must trigger on v* tag push events, which is the
			// release mechanism. This is the attack vector (an attacker pushes a malicious v* tag),
			// so the guard must run on this trigger.
			const workflowYaml = await readFile(join(process.cwd(), WORKFLOW_PATH), "utf8");

			expect(workflowYaml).toContain("on:");
			expect(workflowYaml).toContain("push:");
			expect(workflowYaml).toContain("tags:");
			expect(workflowYaml).toContain('"v*"');
		});

		it("workflow skips the guard step on workflow_dispatch", async () => {
			// SECURITY PROPERTY: The guard step only runs on tag push events, not on manual
			// workflow_dispatch events. Manual deploys from main are operator-initiated and
			// do not need the tag ancestry check (there is no tag to verify).
			const workflowYaml = await readFile(join(process.cwd(), WORKFLOW_PATH), "utf8");

			// Verify the guard step is conditional on tag push events.
			expect(workflowYaml).toContain("if: github.event_name == 'push' && github.ref_type == 'tag'");

			// Verify workflow_dispatch is a valid trigger (for manual deploys).
			expect(workflowYaml).toContain("workflow_dispatch:");
		});
	});

	describe("documentation and security policy", () => {
		it("SECURITY.md documents the production deployment protection controls", async () => {
			// SECURITY PROPERTY: The security policy must document the defense-in-depth controls
			// for the installer deployment, so operators and auditors understand the mitigations.
			const securityMd = await readFile(join(process.cwd(), "SECURITY.md"), "utf8");

			expect(securityMd).toContain("Production deployment protection");
			expect(securityMd).toContain("get.theapiary.sh");
			expect(securityMd).toContain("Protected environment");
			expect(securityMd).toContain("Branch ancestry verification");
			expect(securityMd).toContain("Manual approval");
			expect(securityMd).toContain("required reviewers");
		});

		it("site/install/README.md documents the security controls", async () => {
			// SECURITY PROPERTY: The installer site README must document the security controls
			// and the one-time operator setup steps (configuring the protected environment).
			const installReadme = await readFile(join(process.cwd(), "site/install/README.md"), "utf8");

			expect(installReadme).toContain("Security controls (defense-in-depth)");
			expect(installReadme).toContain("Protected environment");
			expect(installReadme).toContain("Branch ancestry verification");
			expect(installReadme).toContain("Immutable tag semantics");
			expect(installReadme).toContain("Configure the protected `production` environment");
			expect(installReadme).toContain("Required reviewers");
		});
	});
});
