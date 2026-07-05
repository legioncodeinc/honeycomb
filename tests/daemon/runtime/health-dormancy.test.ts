/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-073b — dormancy surfacing on the `/health` detail + the gated-captures counter (AC-named).
 *
 * A gate without surfacing is a silent drop (which the parent forbids). The health detail carries two
 * machine-readable dormancy reasons — `capture_dormant_no_project` (zero bindings) and
 * `capture_blocked_tenancy_unconfirmed` — present ONLY while their condition holds, plus a per-reason
 * gated-captures counter. The mode gate strips `reasons` from the PUBLIC team/hybrid body (PRD-029).
 */

import { describe, expect, it } from "vitest";

import {
	buildHealthDetail,
	CAPTURE_BLOCKED_TENANCY_UNCONFIRMED,
	CAPTURE_DORMANT_NO_PROJECT,
	NO_ACTIVE_PROJECT_GUIDANCE,
	publicHealthDetail,
} from "../../../src/daemon/runtime/health.js";
import { createGatedCapturesCounter } from "../../../src/daemon/runtime/capture/gated-captures.js";

describe("073b-AC-1.1: /health carries capture_dormant_no_project while zero bindings exist", () => {
	it("present with the bind-guidance string when captureDormantNoProject is true", () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: false, captureDormantNoProject: true });
		expect(detail.reasons?.captureDormant?.code).toBe(CAPTURE_DORMANT_NO_PROJECT);
		expect(detail.reasons?.captureDormant?.guidance).toBe(NO_ACTIVE_PROJECT_GUIDANCE);
		// A dormant daemon stays HEALTHY (200 / status ok) — dormancy is a reason, not a degradation.
		expect(detail.status).toBe("ok");
	});

	it("absent once a project is bound (captureDormantNoProject false → cleared on the next read)", () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: false, captureDormantNoProject: false });
		expect(detail.reasons?.captureDormant).toBeUndefined();
	});
});

describe("073b-AC-1.2: /health carries capture_blocked_tenancy_unconfirmed while tenancy is unconfirmed", () => {
	it("present when captureTenancyUnconfirmed is true; cleared when false", () => {
		const blocked = buildHealthDetail({ status: "ok", embeddingsEnabled: false, captureTenancyUnconfirmed: true });
		expect(blocked.reasons?.captureTenancyUnconfirmed?.code).toBe(CAPTURE_BLOCKED_TENANCY_UNCONFIRMED);
		const confirmed = buildHealthDetail({ status: "ok", embeddingsEnabled: false, captureTenancyUnconfirmed: false });
		expect(confirmed.reasons?.captureTenancyUnconfirmed).toBeUndefined();
	});
});

describe("073b-AC-1.3: team/hybrid PUBLIC /health strips the dormancy reasons (PRD-029 split preserved)", () => {
	it("local keeps reasons; team drops the whole reasons block", () => {
		const detail = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: false,
			captureDormantNoProject: true,
			captureTenancyUnconfirmed: true,
		});
		expect(publicHealthDetail(detail, "local").reasons?.captureDormant).toBeDefined();
		const teamBody = publicHealthDetail(detail, "team");
		expect(teamBody.reasons).toBeUndefined();
		expect(teamBody.status).toBe("ok"); // the coarse bit is unchanged
	});
});

describe("073b-AC-3.1: the gated-captures counter is partitioned by reason on the health detail", () => {
	it("the counter increments per reason and rides the health detail's capture block", () => {
		const gated = createGatedCapturesCounter();
		gated.increment("no_bound_project");
		gated.increment("no_bound_project");
		gated.increment("tenancy_unconfirmed");
		expect(gated.read()).toEqual({ no_bound_project: 2, tenancy_unconfirmed: 1 });
		expect(gated.total()).toBe(3);

		const detail = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: false,
			captureDroppedEvents: 0,
			captureGated: gated.read(),
		});
		expect(detail.reasons?.capture?.gated).toEqual({ no_bound_project: 2, tenancy_unconfirmed: 1 });
	});

	it("the capture block is omitted entirely when neither counter is wired (bare createDaemon)", () => {
		const detail = buildHealthDetail({ status: "ok", embeddingsEnabled: false });
		expect(detail.reasons?.capture).toBeUndefined();
	});
});
