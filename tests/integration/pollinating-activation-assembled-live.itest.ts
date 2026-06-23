/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-045d d-AC-2 — LIVE ASSEMBLED-DAEMON POLLINATING ACTIVATION PROOF.        ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Proves an ENABLED pollinating pass runs to COMPLETION through the FULLY-      ║
 * ║  ASSEMBLED daemon — the gap 045d closes (the loop was wired but never       ║
 * ║  proven end-to-end with the gate flipped). Unlike the 026 consolidation     ║
 * ║  itest (which constructs the worker directly), this boots the REAL          ║
 * ║  `assembleDaemon()` composition root with the pollinating gate ON, so the      ║
 * ║  worker is built + STARTED by the composition root — then drives the chain: ║
 * ║                                                                            ║
 * ║    POST /api/diagnostics/pollinate  (the assembled trigger ENQUEUES a job)      ║
 * ║      → the assembled, gate-started worker LEASES the `pollinating` job          ║
 * ║      → runs the real `memory_pollinating` MODEL (Anthropic via agent.yaml)      ║
 * ║      → APPLIES mutations through the 008c control plane (submitProposal)     ║
 * ║      → records the append-only STATE update (`last_pass_at` advances,        ║
 * ║        `pending_job_id` clears) via the trigger's recordPassComplete.        ║
 * ║                                                                            ║
 * ║  The d-AC-2 assertion: the `default`-agent `pollinating_state` counter's        ║
 * ║  `last_pass_at` ADVANCES from its pre-trigger baseline — the live proof the  ║
 * ║  assembled gate started the worker AND a pass ran to completion. (A          ║
 * ║  zero-mutation pass still completes + stamps state — the activation proof is ║
 * ║  the STATE ADVANCE, not the mutation count; the 026 consolidation itest      ║
 * ║  owns the "consolidation actually happens" proof.)                          ║
 * ║                                                                            ║
 * ║  GATED + SKIP-SAFE (mirrors pollinating-consolidation-live):                    ║
 * ║    - `describe.skipIf(...)` SKIPS CLEANLY unless BOTH                        ║
 * ║      `HONEYCOMB_DEEPLAKE_TOKEN` AND `ANTHROPIC_API_KEY` are present. So the  ║
 * ║      run is NEVER forced ON in CI (PRD-031/034) — `npm run test`/`ci` never  ║
 * ║      touch it (`.itest.ts` + the `tests/integration/**` exclusion).         ║
 * ║    - The gate is flipped via an INJECTED pollinating-config provider            ║
 * ║      (`{ enabled: true }`), NOT by mutating `process.env` — so the           ║
 * ║      assembled composition root starts the worker exactly as production      ║
 * ║      would with the operator switch ON, with zero global-env leakage.        ║
 * ║    - Ephemeral port (0) — never 3850; PID/lock in a per-boot temp dir.       ║
 * ║                                                                            ║
 * ║  SECRETS: the DeepLake token reaches storage ONLY via the env credential    ║
 * ║  provider; the Anthropic key is read from `ANTHROPIC_API_KEY`, stored in a   ║
 * ║  TEMP machine-bound `.secrets/` under `$HONEYCOMB_WORKSPACE` (the temp dir   ║
 * ║  the worker resolves the `${ANTHROPIC_API_KEY}` ref under), then referenced  ║
 * ║  by the committed `agent.yaml` — EXACTLY the production resolution path.      ║
 * ║  Neither secret is hardcoded, logged, or echoed.                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	resolveStorageConfig,
	type QueryScope,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import { SecretsStore, createMachineKeyProvider } from "../../src/daemon/runtime/secrets/store.js";
import { PollinatingConfigSchema } from "../../src/daemon/runtime/pollinating/config.js";
import { createPollinatingTrigger, type PollinatingScope } from "../../src/daemon/runtime/pollinating/trigger.js";
import { POLLINATE_DEFAULT_AGENT_ID } from "../../src/daemon/runtime/pollinating/api.js";
import { type BootedTestDaemon, bootTestDaemon } from "./_daemon-harness.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

/** BOTH gates: live DeepLake AND a real Anthropic key. Either absent → SKIP cleanly. */
const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const GATED = HAS_TOKEN && HAS_KEY;

/** The committed `agent.yaml` (the real `inference:` block the daemon loads). */
const AGENT_YAML = join(process.cwd(), "agent.yaml");

describe.skipIf(!GATED)("PRD-045d d-AC-2 live assembled-daemon pollinating activation (gated)", () => {
	let storage: StorageClient;
	let scope: QueryScope;
	let workspaceDir: string;
	let prevWorkspaceEnv: string | undefined;
	let booted: BootedTestDaemon | null = null;

	beforeAll(async () => {
		// Resolve the daemon's live tenancy (org + the authorized CI workspace) from env.
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });

		// Point the daemon's workspace base dir at a throwaway temp dir so the worker resolves
		// its `.secrets/` (and the `${ANTHROPIC_API_KEY}` ref) under it, not the real home. The
		// committed `agent.yaml` is passed explicitly (agentConfigPath) so the inference block
		// loads from the repo while the key ref decrypts from the temp `.secrets/`. The secret
		// is stored under the DAEMON's scope (org + the resolved workspace) — the SAME scope the
		// worker lifts onto the SecretScope (`secretScopeFromQueryScope`).
		workspaceDir = mkdtempSync(join(tmpdir(), "hc-pollinate-activation-"));
		prevWorkspaceEnv = process.env.HONEYCOMB_WORKSPACE;
		process.env.HONEYCOMB_WORKSPACE = workspaceDir;

		const secretsStore = new SecretsStore({ baseDir: workspaceDir, machineKey: createMachineKeyProvider() });
		await secretsStore.setSecret("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY ?? "", {
			org: scope.org,
			workspace: scope.workspace ?? "default",
		});

		// Boot the REAL assembled daemon with the pollinating gate FLIPPED ON via an injected
		// provider (NOT process.env) + the committed agent.yaml. The composition root builds AND
		// starts the real pollinating worker (the path d-AC-2 proves), leasing from the live queue.
		booted = await bootTestDaemon({
			mode: "local",
			workspaceDir,
			agentConfigPath: AGENT_YAML,
			pollinatingConfigProvider: {
				read: () => ({ enabled: true, backfillOnFirstRun: true }),
			},
		});
	}, 120_000);

	afterAll(async () => {
		if (booted !== null) {
			try {
				await booted.stop();
			} catch {
				/* already stopped */
			}
		}
		if (workspaceDir) {
			try {
				rmSync(workspaceDir, { recursive: true, force: true });
			} catch {
				/* best-effort temp cleanup */
			}
		}
		if (prevWorkspaceEnv === undefined) delete process.env.HONEYCOMB_WORKSPACE;
		else process.env.HONEYCOMB_WORKSPACE = prevWorkspaceEnv;
	});

	/** A trigger over the live scope to READ the `default`-agent `pollinating_state` (poll-convergent). */
	function readTrigger() {
		return createPollinatingTrigger({
			storage,
			scope,
			config: PollinatingConfigSchema.parse({ enabled: true }),
			// A no-op enqueuer: this trigger is used ONLY to read state, never to enqueue.
			enqueuer: { async enqueue() { return "read-only"; } },
		});
	}

	const POLLINATE_SCOPE: PollinatingScope = { agentId: POLLINATE_DEFAULT_AGENT_ID };

	/** Poll a check to convergence (DeepLake eventual consistency — never a single read). */
	async function pollUntil(check: () => Promise<boolean>, attempts = 90, delayMs = 1_000): Promise<boolean> {
		for (let i = 0; i < attempts; i++) {
			if (await check()) return true;
			await new Promise((r) => setTimeout(r, delayMs));
		}
		return false;
	}

	it(
		"an enabled pass runs to completion on the assembled daemon: enqueue → lease → model → apply → state advance",
		async ({ skip }) => {
			// INFRA-DEGRADED preflight: a sustained DeepLake outage resolves NEUTRAL (skip), not red.
			await neutralizeIfInfraDegraded("pollinating-activation-assembled-live:preflight", () => storage.connect(scope), skip);

			expect(booted, "the assembled daemon booted with pollinating ENABLED").not.toBeNull();
			const b = booted!;

			// ── Baseline: the `default`-agent state's `last_pass_at` BEFORE we trigger. ──
			const before = await readTrigger().readState(POLLINATE_SCOPE);

			// ── Kick the loop through the ASSEMBLED trigger endpoint. With pollinating ENABLED the
			// ack is NOT the disabled `skipped` shape — it is `enqueued` (a job was queued) or
			// `running` (a pass already pending / below threshold). Either way the master switch
			// is ON and the assembled worker is leasing. ──
			const res = await fetch(`${b.baseUrl}/api/diagnostics/pollinate`, { method: "POST" });
			expect(res.status, "the assembled pollinate trigger acks 202").toBe(202);
			const ack = (await res.json()) as { triggered: boolean; status: string; reason?: string };
			// The gate is ON, so it must NOT report the disabled-skip shape.
			expect(ack.status, "pollinating is ENABLED → not the disabled skip").not.toBe("skipped");

			// ── d-AC-2: poll the append-only state until `last_pass_at` ADVANCES past the
			// baseline — the live proof the assembled worker LEASED the job, ran the pass
			// (model → 008c apply), and recorded the completion state (recordPassComplete). A
			// zero-mutation pass still stamps state, so the activation proof is the STATE ADVANCE. ──
			const advanced = await pollUntil(async () => {
				const now = await readTrigger().readState(POLLINATE_SCOPE);
				// `last_pass_at` is an ISO string; "advanced" = a newer non-empty stamp than before,
				// AND the pending guard cleared (the runner cleared `pending_job_id` on completion).
				const stampAdvanced = now.lastPassAt !== "" && now.lastPassAt > before.lastPassAt;
				return stampAdvanced && now.pendingJobId === "";
			});

			const after = await readTrigger().readState(POLLINATE_SCOPE);
			// eslint-disable-next-line no-console
			console.log(
				`[045d d-AC-2 receipt] last_pass_at ${JSON.stringify(before.lastPassAt)} -> ${JSON.stringify(after.lastPassAt)} ` +
					`pending_job_id=${JSON.stringify(after.pendingJobId)}`,
			);

			expect(
				advanced,
				"d-AC-2: the assembled worker ran an enabled pass to completion (last_pass_at advanced, pending cleared)",
			).toBe(true);
		},
		600_000,
	);
});
