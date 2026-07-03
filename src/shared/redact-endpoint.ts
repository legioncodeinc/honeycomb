/**
 * Redact embedded credentials from an endpoint URL for safe display (CLI output, logs).
 * Persist the raw endpoint unchanged; call this only at echo boundaries.
 */

/**
 * Replace a password in URL userinfo with `****` for display. Usernames without a
 * password are kept. Strings the URL parser cannot handle fall back to a lightweight
 * userinfo scan; anything else is returned unchanged so callers never crash.
 */
export function redactEndpointCredentials(endpoint: string): string {
	if (endpoint.length === 0) return endpoint;
	try {
		const url = new URL(endpoint);
		if (url.password.length === 0) return endpoint;
		url.password = "****";
		return url.toString();
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
