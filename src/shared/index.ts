/**
 * Barrel for shared constants and types. The `@honeycomb/shared` path alias
 * resolves here. Targets import shared values from this surface, never by
 * re-declaring them.
 */
export {
	DAEMON_HOST,
	DAEMON_PORT,
	HONEYCOMB_VERSION,
	PRODUCT_SLUG,
} from "./constants.js";
export {
	DEFAULT_MEMORY_TYPE,
	MEMORY_TYPE_DESCRIPTIONS,
	MEMORY_TYPES,
	isMemoryType,
	memoryTypeGuidance,
	type MemoryType,
} from "./memory-types.js";
