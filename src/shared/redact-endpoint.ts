/**
 * Redact embedded credentials from an endpoint URL for safe display (CLI output, logs).
 * Persist the raw endpoint unchanged; call this only at echo boundaries.
 */

/**
 * Query-parameter names that carry a secret. libpq-style connection URIs accept the password
 * in the query string (`?password=`/`?sslpassword=`) and HTTP gateways use `token`/`apikey`, so
 * a userinfo-only redaction would still echo those to stdout. Matched case-insensitively as a
 * substring so `sslpassword`, `access_token`, `api_key`, etc. are all covered.
 */
const SENSITIVE_QUERY_KEY = /pass|secret|token|api[-_]?key|pwd|credential/i;

/**
 * Replace a password in URL userinfo — and any secret-bearing query parameter — with `****`
 * for display. Usernames without a password are kept, and a URL carrying no secret is returned
 * byte-for-byte unchanged. Strings the URL parser cannot handle fall back to a lightweight
 * userinfo scan; anything else is returned unchanged so callers never crash.
 */
export function redactEndpointCredentials(endpoint: string): string {
	if (endpoint.length === 0) return endpoint;
	try {
		const url = new URL(endpoint);
		let changed = false;
		if (url.password.length > 0) {
			url.password = "****";
			changed = true;
		}
		// Snapshot the keys before mutating so iteration is unaffected by `set`.
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_QUERY_KEY.test(key)) {
				url.searchParams.set(key, "****");
				changed = true;
			}
		}
		// Only re-serialize (which re-encodes the query) when we actually masked something;
		// otherwise preserve the caller's exact formatting.
		return changed ? url.toString() : endpoint;
	} catch {
		const match = /^([^:/+#?]+:\/\/)([^@/]*@)(.*)$/.exec(endpoint);
		if (match === null) return endpoint;
		const scheme = match[1];
		const userinfo = match[2];
		const rest = match[3];
		const colon = userinfo.indexOf(":");
		if (colon === -1) return endpoint;
		const user = userinfo.slice(0, colon);
		return `${scheme}${user}:****@${rest}`;
	}
}
