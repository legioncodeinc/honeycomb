/**
 * Notifications + environment-health barrel — PRD-020d.
 *
 * The public surface: the {@link NotificationsPipeline} contract, the {@link ClaimLock} +
 * {@link NotificationsState} seams (real-FS factories + in-memory fakes, D-5), the
 * {@link HealthCheck} contract with the five {@link HealthDimensionId} D1..D5 dimensions +
 * the {@link HealthDimension} result shape (consumed by 020a `status` + 020c status bar),
 * and the {@link AutoWiring} seam reusing the 019a connector (D-4). Wave 1 is contracts +
 * honest stubs; Wave 2 fills the bodies. See CONVENTIONS.md before filling.
 */

export {
	type AutoWiring,
	type BackendNotificationSource,
	type ClaimLock,
	createFakeBackendSource,
	createFakeClaimLock,
	createFakeNotificationsState,
	type DrainResult,
	type FakeClaimLock,
	type FakeNotificationsState,
	type HealthCheck,
	type HealthDimension,
	type HealthDimensionId,
	type HealthReport,
	HEALTH_DIMENSION_IDS,
	HEALTH_DIMENSION_LABELS,
	HEALTH_DIMENSION_WIRABLE,
	type Notification,
	type NotificationKind,
	type NotificationsPipeline,
	type NotificationsState,
	type NotificationsStateData,
	type NotificationTrigger,
	notImplemented,
	type PersistentRecord,
	type PipelineDeps,
} from "./contracts.js";

export {
	createHealthCheck,
	type HealthCheckDeps,
	type HealthProbes,
	type ProbeOutcome,
} from "./health.js";

export {
	createNotificationsPipeline,
	DEFAULT_PIPELINE_TIMEOUT_MS,
	type NotificationSource,
	type PipelineDepsFull,
	type TimeoutClock,
} from "./pipeline.js";

export {
	CLAIM_DIR_NAME,
	createClaimLock,
	createInMemoryStateFs,
	createNotificationsState,
	nodeStateFs,
	STATE_FILE_NAME,
	type StateFs,
	StateFsError,
	type StateLocation,
} from "./state.js";

export {
	type AutoWiringDeps,
	createAutoWiring,
} from "./auto-wiring.js";
