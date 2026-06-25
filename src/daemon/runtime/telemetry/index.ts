/**
 * Telemetry barrel — PRD-050e (operator adoption telemetry, Path B). The single import surface for the
 * egress chokepoint + the glass-box view. Emit sites (install / login / migration / the Tier-2 seam) and
 * the `honeycomb telemetry --show` verb import from HERE, never the module files — so `emit.ts` stays the
 * ONLY module that references the PostHog capture path (e-AC-7).
 */

export {
	type AllowedProperties,
	type AllowedPropertyKey,
	type CountBucket,
	type EmitDeps,
	type EmitOptions,
	type EmitOutcome,
	type EmitSkipReason,
	type TelemetryClock,
	type TelemetryFetch,
	type TelemetryFetchRequestInit,
	type TelemetryFetchResponse,
	type TelemetryTier,
	ALLOWED_PROPERTY_KEYS,
	BANNED_PROPERTY_KEYS,
	COUNT_BUCKETS,
	DEFAULT_EMIT_TIMEOUT_MS,
	ENV_DO_NOT_TRACK,
	ENV_TELEMETRY,
	POSTHOG_CAPTURE_PATH,
	POSTHOG_HOST,
	POSTHOG_KEY,
	TIER1_EVENTS,
	buildAllowedProperties,
	bucketCount,
	captureUrl,
	emitHivemindUpgrade,
	emitTelemetry,
	isOptedOut,
	platformFacts,
	systemTelemetryClock,
	tierForEvent,
} from "./emit.js";

export {
	type GlassBoxDeps,
	type GlassBoxInputs,
	type GlassBoxView,
	type PendingTelemetryRow,
	buildGlassBoxView,
	renderGlassBoxText,
} from "./glass-box.js";
