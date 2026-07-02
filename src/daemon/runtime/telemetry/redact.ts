/**
 * Redaction for fleet log lines — PRD-071c (AC-071c.3.2 / AC-10).
 *
 * `service_logs` rows are polled read-only by doctor and eventually rendered on hive's
 * health rail, so a line must never carry a token, credential value, raw `Authorization` header,
 * org secret, memory body, or PII. Log lines are free-form TEXT (unlike the structured
 * `service_status`/`service_metrics` rows, which are numeric/enum/timestamp columns that cannot
 * hold a secret by construction), so this module applies a best-effort pattern-based scrub before
 * a line is ever written.
 *
 * Two tiers:
 *   1. Known key=value / header shapes (`Authorization: ...`, `token=...`, `Bearer <jwt>`, …) are
 *      REDACTED in place — the line stays useful (method/path/status still legible) with only the
 *      sensitive span replaced.
 *   2. A line carrying an unredactable high-entropy blob (a private-key block, or a long
 *      contiguous base64/hex-looking token not already caught by a known key) is DROPPED entirely
 *      (`null`) rather than partially redacted — PRD-071c's "if a line cannot be safely redacted,
 *      it is dropped rather than written."
 *
 * This is a defense-in-depth scrub, not the only guard: the message strings this module receives
 * are themselves built from the daemon's own {@link RequestLogRecord}/{@link EventLogRecord} shapes,
 * which already carry no header/token/body field (see `logger.ts`). Redaction here protects against
 * a future caller accidentally formatting a secret-shaped value into an event's `fields` bag.
 */

/**
 * A secret VALUE in either shape a log line actually carries: a JSON quoted string (`"..."`, the
 * form `formatEventLogMessage()` serializes event fields into) or a bare key=value token.
 */
const JSON_OR_KV_VALUE = String.raw`(?:"[^"]*"|[^\s,}]+)`;

/** Patterns for known secret-shaped key=value / header spans. Replaced with `[REDACTED]`. */
function secretSpanPatterns(): RegExp[] {
	return [
		/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
		// Consume the FULL credential after `Authorization:`, including a `Basic <blob>` /
		// `Bearer <blob>` scheme+value pair (the old pattern stopped at the scheme word).
		/"?Authorization"?\s*[:=]\s*(?:"[^"]*"|(?:[^\s"]+\s+)?[^\s"]+)/gi,
		new RegExp(String.raw`"?\b(api[_-]?key|apikey)\b"?\s*[:=]\s*${JSON_OR_KV_VALUE}`, "gi"),
		new RegExp(String.raw`"?\b(password|passwd|pwd)\b"?\s*[:=]\s*${JSON_OR_KV_VALUE}`, "gi"),
		new RegExp(String.raw`"?\b(secret|token|credential)s?\b"?\s*[:=]\s*${JSON_OR_KV_VALUE}`, "gi"),
		new RegExp(String.raw`"?\bcookie\b"?\s*[:=]\s*${JSON_OR_KV_VALUE}`, "gi"),
		/\bsk-[A-Za-z0-9]{16,}/gi,
	];
}

/** Patterns that mean the WHOLE line must be dropped — it cannot be safely partially redacted. */
function hardDropPatterns(): RegExp[] {
	return [
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
		// A long contiguous base64/hex-looking token (80+ chars) not already caught by a named key
		// above — long enough that it is very unlikely to be legitimate log prose, but short/common
		// tokens (ids, hashes under 80 chars) are left alone so normal log lines stay useful.
		/\b[A-Za-z0-9+/_-]{80,}={0,2}\b/,
	];
}

/**
 * Redact known secret-shaped spans from a log message, or return `null` when the line carries
 * material that cannot be safely partially redacted (AC-071c.3.2). Never throws.
 */
export function redactLogMessage(raw: string): string | null {
	for (const pattern of hardDropPatterns()) {
		if (pattern.test(raw)) return null;
	}
	let out = raw;
	for (const pattern of secretSpanPatterns()) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}
