/**
 * Onboarding barrel — PRD-050 substrate. The single import surface for the
 * machine-local onboarding/install state at `~/.deeplake/onboarding.json` that
 * PRD-050a/050c/050e/050b/050d all consume. Importers pull the {@link OnboardingState}
 * contract, the load/save IO, and the pure helpers from HERE, never the module file.
 */

export {
	type OnboardingState,
	type TelemetryEventName,
	type TelemetrySentRecord,
	DEFAULT_REF,
	ONBOARDING_FILE_NAME,
	ONBOARDING_SCHEMA_VERSION,
	OnboardingStateSchema,
	appendSent,
	freshOnboardingState,
	getOrCreateInstallId,
	isReported,
	loadOnboarding,
	markReported,
	onboardingDir,
	onboardingPath,
	saveOnboarding,
} from "./onboarding-store.js";
