/**
 * Narrow import surface used to validate the packed command dispatcher.
 *
 * The fixture that supplies mutation adapters lives outside the published package. Keep this entry
 * deliberately limited so the tarball does not expose test fakes or individual mutation handlers.
 */
export { createDispatcher } from "./dispatch.js";
export { VERB_TABLE } from "./contracts.js";
