/**
 * SSRF-safe document URL fetcher — PRD-045 W1 remediation.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * PRD-045e wired `/api/documents` through the real {@link DurableDocumentWorker},
 * but the composition root injected NO {@link DocumentContentFetcher}, so the worker
 * fell back to {@link echoDocumentContentFetcher} — chunking the URL *string* as the
 * document body instead of the document AT that URL (QA finding W1). This module is
 * the real fetcher the assembly injects so `POST /api/documents` ingests the fetched
 * body.
 *
 * ── The threat (why this is a security boundary) ─────────────────────────────
 * The submitted URL is UNTRUSTED, LLM/agent-supplied input. A naive fetcher is a
 * textbook Server-Side Request Forgery (SSRF) primitive: a caller submits
 * `http://169.254.169.254/latest/meta-data/iam/...` (cloud metadata),
 * `http://127.0.0.1:6379/` (a loopback service), or `http://10.0.0.5/` (an internal
 * host) and the daemon — which sits inside the trusted network — fetches it and
 * returns the body. So this fetcher is hardened, in layers:
 *
 *   1. SCHEME ALLOWLIST. Only `https:` and `http:` are accepted. `file:`, `ftp:`,
 *      `gopher:`, `data:`, etc. are rejected — there is NO local-file ingest mode
 *      (the worker contract is a URL submission; opening a `file:` URL would be a
 *      local-file-disclosure primitive, so it is explicitly blocked). `http:` is
 *      permitted but still passes the SAME IP guard, so http-to-private is blocked.
 *   2. IP-RANGE BLOCK, CHECKED AT CONNECT TIME. The host is resolved and EVERY
 *      resolved address is checked against the private / loopback / link-local /
 *      unique-local / cloud-metadata ranges. The check runs inside the connection
 *      `lookup` hook — the SAME resolution the socket actually connects to — so a
 *      DNS-REBINDING attacker who returns a public IP to a pre-flight probe and a
 *      private IP to the real connect cannot win: the address the socket gets is the
 *      address we validate, atomically.
 *   3. NO TRANSPARENT REDIRECTS. Redirects are followed MANUALLY (bounded count),
 *      and every hop's URL is re-validated through the SAME scheme + IP guard, so a
 *      `302 → http://169.254.169.254/` redirect is blocked exactly like a direct
 *      submission. A cross-scheme redirect to `file:`/`ftp:` is rejected.
 *   4. SIZE CAP. The response body is read with a hard byte ceiling; a server that
 *      streams forever (or a multi-GB file) is aborted at the cap, never buffered
 *      whole.
 *   5. TIMEOUT. A per-request deadline aborts a hung connection so one bad URL can
 *      never wedge the ingest worker.
 *   6. HONEST, NON-SPOOFABLE User-Agent. We send a fixed `honeycomb-document-fetcher`
 *      UA — never a value derived from caller input.
 *   7. NO TOPOLOGY LEAK. A blocked URL surfaces a generic {@link SsrfBlockedError}
 *      whose message names the REASON CLASS (e.g. "blocked address range"), never the
 *      resolved internal IP, so an attacker cannot use error text to map the network.
 *
 * ── Fail-soft contract ───────────────────────────────────────────────────────
 * The fetcher THROWS on failure; it never returns partial/garbage content. The
 * document worker's `ingest` already wraps the fetch in a try/catch and fails THAT
 * job cleanly (the daemon never crashes). A {@link SsrfBlockedError} is distinguished
 * from a transport failure so the API layer can map a blocked URL to a 4xx (caller
 * error) rather than a 5xx (server fault) — see {@link isSsrfBlockedError}.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import type { DocumentContentFetcher, DocumentSubmission } from "./document-worker.js";

/** The fixed, honest User-Agent — never derived from caller input. */
const USER_AGENT = "honeycomb-document-fetcher/1";

/** Default per-request timeout (ms). A hung host can never wedge the ingest worker. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Default response body size cap (bytes). ~5 MB — enough for docs, bounded for safety. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Max redirect hops followed before giving up (every hop re-validated). */
export const DEFAULT_MAX_REDIRECTS = 5;

/** The only URL schemes a document may be fetched over. NO `file:` (local-file-disclosure). */
const ALLOWED_SCHEMES = Object.freeze(["https:", "http:"] as const);

/**
 * A fetch rejected by the SSRF guard (a blocked scheme, a blocked address range, or
 * too many redirects). DISTINCT from a transport failure so the API maps it to a 4xx
 * (caller error), not a 5xx. The message names the REASON CLASS only — never the
 * resolved IP — so error text cannot be used to map internal network topology.
 */
export class SsrfBlockedError extends Error {
	/** A stable discriminator for {@link isSsrfBlockedError} (survives bundling/realm). */
	readonly ssrfBlocked = true as const;
	constructor(reason: string) {
		super(`document url blocked: ${reason}`);
		this.name = "SsrfBlockedError";
	}
}

/** True when `err` is a guard rejection (a blocked URL → the API answers 4xx). */
export function isSsrfBlockedError(err: unknown): err is SsrfBlockedError {
	return err instanceof SsrfBlockedError || (typeof err === "object" && err !== null && (err as { ssrfBlocked?: unknown }).ssrfBlocked === true);
}

/** Tunables for {@link createUrlDocumentFetcher} (all optional; safe defaults). */
export interface UrlFetcherOptions {
	/** Per-request timeout in ms (default {@link DEFAULT_FETCH_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
	/** Response body size cap in bytes (default {@link DEFAULT_MAX_BYTES}). */
	readonly maxBytes?: number;
	/** Max redirect hops (default {@link DEFAULT_MAX_REDIRECTS}). */
	readonly maxRedirects?: number;
	/**
	 * TEST-ONLY escape hatch: when true, the connect-time IP guard ALLOWS loopback so a
	 * test can point the fetcher at an in-process server on `127.0.0.1` WITHOUT hitting
	 * the public internet. NEVER set in production — the assembly always leaves it unset,
	 * so the daemon's fetcher blocks loopback/private/metadata. Only loopback is relaxed
	 * (10/8, 172.16/12, 192.168/16, 169.254/16, etc. stay blocked even under this flag),
	 * so the SSRF-block test still proves a metadata/private address is refused.
	 */
	readonly allowLoopbackForTest?: boolean;
}

/**
 * Decide whether a resolved IPv4/IPv6 address is in a BLOCKED range (private,
 * loopback, link-local, unique-local, multicast, unspecified, or cloud metadata).
 * Returns the blocked reason class, or `null` when the address is a routable public
 * address. Pure + total — an unparseable address is treated as blocked (fail-closed).
 *
 * Blocked v4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8,
 * 169.254.0.0/16 (link-local INCL. 169.254.169.254 cloud metadata), 172.16.0.0/12,
 * 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15 (benchmarking), 224.0.0.0/4 (multicast),
 * 240.0.0.0/4 (reserved). Blocked v6: ::, ::1 (loopback), fc00::/7 (unique-local),
 * fe80::/10 (link-local), ff00::/8 (multicast), and IPv4-mapped `::ffff:a.b.c.d`
 * (re-checked as its embedded v4).
 */
export function classifyBlockedAddress(address: string, allowLoopback = false): string | null {
	const family = isIP(address);
	if (family === 4) return classifyBlockedV4(address, allowLoopback);
	if (family === 6) return classifyBlockedV6(address, allowLoopback);
	return "unparseable address"; // fail-closed: never connect to something we can't classify.
}

/** Classify a dotted-quad IPv4 address. Returns the blocked reason or null. */
function classifyBlockedV4(address: string, allowLoopback = false): string | null {
	const parts = address.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return "unparseable address";
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 0) return "blocked address range"; // 0.0.0.0/8 (this network / unspecified)
	if (a === 10) return "blocked address range"; // 10.0.0.0/8 private
	if (a === 127) return allowLoopback ? null : "blocked address range"; // 127.0.0.0/8 loopback (test escape hatch)
	if (a === 100 && b >= 64 && b <= 127) return "blocked address range"; // 100.64.0.0/10 CGNAT
	if (a === 169 && b === 254) return "blocked address range"; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
	if (a === 172 && b >= 16 && b <= 31) return "blocked address range"; // 172.16.0.0/12 private
	if (a === 192 && b === 0) return "blocked address range"; // 192.0.0.0/24 IETF protocol assignments
	if (a === 192 && b === 168) return "blocked address range"; // 192.168.0.0/16 private
	if (a === 198 && (b === 18 || b === 19)) return "blocked address range"; // 198.18.0.0/15 benchmarking
	if (a >= 224) return "blocked address range"; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
	return null;
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped (`::ffff:…`) or deprecated IPv4-compatible
 * (`::…`) IPv6 address as a dotted-quad string, or `null` when the address embeds no v4.
 *
 * Handles BOTH spellings of the trailing 32 bits, because the WHATWG URL parser normalizes
 * a bracketed literal to the hex-hextet form: `[::ffff:127.0.0.1]` → `::ffff:7f00:1`. A guard
 * that only recognized the dotted spelling would treat `::ffff:7f00:1` (loopback) or
 * `::ffff:a9fe:a9fe` (169.254.169.254 cloud metadata) as a public address — a full SSRF
 * bypass. We accept `a.b.c.d` directly and otherwise decode two trailing hex hextets into the
 * four octets they encode. `input` is already lowercased.
 */
function extractMappedV4(input: string): string | null {
	// Only the v4-mapped (::ffff:…) and deprecated v4-compatible (::… with no other hextets)
	// embeddings carry a reachable v4. Anchor on the `::ffff:` prefix (the only one Node emits
	// for mapped addresses) plus the bare `::` + dotted form.
	const mappedTail = /^::ffff:(.+)$/.exec(input);
	const compatTail = /^::(?!ffff:)([0-9a-f.:]+)$/.exec(input); // ::a.b.c.d / ::w.x form (no ffff)
	const tail = mappedTail?.[1] ?? compatTail?.[1] ?? null;
	if (tail === null) return null;

	// Dotted-decimal trailing form: `::ffff:a.b.c.d`.
	if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;

	// Hex-hextet trailing form: `::ffff:hhhh:hhhh` (what the URL parser emits). Two hextets =
	// the 32 embedded bits; decode to four octets. Compatibility form must embed a full v4
	// (not a lone non-zero hextet that is really a high-bits-set v6), so require two hextets.
	const hextets = tail.split(":");
	if (hextets.length === 2 && hextets.every((h) => /^[0-9a-f]{1,4}$/.test(h))) {
		const hi = Number.parseInt(hextets[0], 16);
		const lo = Number.parseInt(hextets[1], 16);
		if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
			return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
		}
	}
	return null;
}

/** Classify an IPv6 address (lowercased, expanded enough for prefix checks). Returns the blocked reason or null. */
function classifyBlockedV6(raw: string, allowLoopback = false): string | null {
	const address = raw.toLowerCase();
	// An IPv4-mapped address (::ffff:a.b.c.d) is reachable as its embedded v4 — re-check it.
	// CRITICAL: the WHATWG URL parser normalizes `[::ffff:127.0.0.1]` to the HEX-HEXTET form
	// `::ffff:7f00:1`, so a dotted-decimal-only match would let `http://[::ffff:169.254.169.254]/`
	// (→ `::ffff:a9fe:a9fe`) slip through the guard straight to cloud metadata. We extract the
	// embedded v4 from BOTH spellings (dotted `::ffff:a.b.c.d` AND hextet `::ffff:hhhh:hhhh`)
	// and re-classify it as IPv4. Same for the deprecated IPv4-compatible `::a.b.c.d` form.
	const embeddedV4 = extractMappedV4(address);
	if (embeddedV4 !== null) return classifyBlockedV4(embeddedV4, allowLoopback);
	if (address === "::") return "blocked address range"; // unspecified
	if (address === "::1") return allowLoopback ? null : "blocked address range"; // loopback (test escape hatch)
	const head = address.split(":")[0] ?? "";
	const firstHextet = head === "" ? 0 : Number.parseInt(head, 16);
	if (Number.isNaN(firstHextet)) return "unparseable address";
	if ((firstHextet & 0xfe00) === 0xfc00) return "blocked address range"; // fc00::/7 unique-local
	if ((firstHextet & 0xffc0) === 0xfe80) return "blocked address range"; // fe80::/10 link-local
	if ((firstHextet & 0xff00) === 0xff00) return "blocked address range"; // ff00::/8 multicast
	return null;
}

/**
 * Validate a URL's scheme AND — when the host is already a LITERAL IP — its address.
 *
 * ── Why the literal-IP check MUST live here (not only in the connect-time lookup) ──
 * Node's http(s) agent SKIPS the DNS `lookup` hook entirely when the host is already a
 * literal IP (there is nothing to resolve). So a caller submitting `http://127.0.0.1/`
 * or `http://169.254.169.254/` would bypass {@link guardedLookup} completely. We close
 * that hole by classifying a literal-IP host RIGHT HERE, before any socket opens. A
 * hostname still defers its IP check to {@link guardedLookup} (the DNS-rebinding-proof
 * connect-time check). Two layers, no gap.
 *
 * Throws {@link SsrfBlockedError} for a non-http(s) scheme, a missing host, or a
 * literal-IP host in a blocked range. Returns the parsed {@link URL}.
 */
function validateUrlScheme(rawUrl: string, allowLoopback: boolean): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new SsrfBlockedError("malformed url");
	}
	if (!(ALLOWED_SCHEMES as readonly string[]).includes(parsed.protocol)) {
		throw new SsrfBlockedError(`unsupported scheme "${parsed.protocol}"`);
	}
	if (parsed.hostname.length === 0) throw new SsrfBlockedError("missing host");
	// A URL hostname for IPv6 is bracketed (`[::1]`) — strip the brackets before classify.
	const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
	if (isIP(host) !== 0) {
		const reason = classifyBlockedAddress(host, allowLoopback);
		if (reason !== null) throw new SsrfBlockedError(reason);
	}
	return parsed;
}

/**
 * Build a DNS `lookup` hook that validates EVERY resolved address against
 * {@link classifyBlockedAddress} before the socket connects, and only yields an
 * approved address. Because this is the SAME resolution the socket connects through,
 * a DNS-rebinding attacker cannot present a public IP at probe time and a private one
 * at connect time — the address the socket gets is the address validated here.
 */
type GuardedLookup = NonNullable<NonNullable<Parameters<typeof httpRequest>[1]>["lookup"]>;

function guardedLookup(allowLoopback: boolean): GuardedLookup {
	// The http(s) agent calls `lookup(hostname, options, callback)`. We always resolve
	// ALL addresses (so a host that maps to BOTH a public and a private IP is rejected),
	// validate every one, and yield a SINGLE approved address — the http agent does not
	// pass `all: true`, so a single (address, family) callback is the contract it expects.
	const fn = (hostname: string, _options: unknown, callback: (err: Error | null, address: string, family: number) => void): void => {
		dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
			if (err) {
				callback(err, "", 0);
				return;
			}
			const list: LookupAddress[] = Array.isArray(addresses) ? addresses : [];
			if (list.length === 0) {
				callback(new SsrfBlockedError("host did not resolve"), "", 0);
				return;
			}
			for (const entry of list) {
				const reason = classifyBlockedAddress(entry.address, allowLoopback);
				if (reason !== null) {
					callback(new SsrfBlockedError(reason), "", 0);
					return;
				}
			}
			const first = list[0];
			callback(null, first.address, first.family);
		});
	};
	return fn as unknown as GuardedLookup;
}

/** A single HTTP(S) response we care about: status, headers, and the (capped) body. */
interface RawResponse {
	readonly status: number;
	readonly location: string | undefined;
	readonly contentType: string;
	readonly body: Buffer;
}

/**
 * Perform ONE guarded HTTP(S) request to an already-scheme-validated URL, reading at
 * most `maxBytes` of the body under a `timeoutMs` deadline through the guarded
 * `lookup` (the IP guard). Does NOT follow redirects — the caller drives the
 * (re-validated) redirect loop. Rejects on transport error, timeout, or size cap.
 */
function requestOnce(url: URL, timeoutMs: number, maxBytes: number, allowLoopback: boolean): Promise<RawResponse> {
	const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise<RawResponse>((resolve, reject) => {
		const req = requestFn(
			url,
			{
				method: "GET",
				headers: { "user-agent": USER_AGENT, accept: "*/*" },
				lookup: guardedLookup(allowLoopback),
				timeout: timeoutMs,
			},
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				let total = 0;
				let aborted = false;
				res.on("data", (chunk: Buffer) => {
					if (aborted) return;
					total += chunk.length;
					if (total > maxBytes) {
						aborted = true;
						res.destroy();
						req.destroy();
						reject(new Error("response exceeded size cap"));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					if (aborted) return;
					const location = res.headers.location;
					resolve({
						status: res.statusCode ?? 0,
						location: typeof location === "string" ? location : undefined,
						contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : "",
						body: Buffer.concat(chunks),
					});
				});
				res.on("error", (err) => {
					if (!aborted) reject(err);
				});
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("request timed out"));
		});
		req.on("error", (err) => reject(err));
		req.end();
	});
}

/**
 * Collapse fetched bytes to indexable text. HTML is reduced to its text content
 * (scripts/styles stripped, tags removed, entities decompressed for the common few),
 * everything else is decoded as UTF-8. Bounded + dependency-free — recall indexes
 * text, so a crude-but-safe strip beats pulling a parser onto this path.
 */
export function bytesToText(body: Buffer, contentType: string): string {
	const raw = body.toString("utf8");
	if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType) && !/^\s*<!doctype html|^\s*<html/i.test(raw)) {
		return raw;
	}
	return raw
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<\/(?:p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/** Extract a `<title>` from HTML for the document title, or "" when absent. */
function extractTitle(body: Buffer, contentType: string): string {
	if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return "";
	const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body.toString("utf8"));
	return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Build the REAL, SSRF-safe {@link DocumentContentFetcher} the daemon assembly injects
 * into the document worker (replacing {@link echoDocumentContentFetcher}). It validates
 * the scheme, follows redirects MANUALLY re-validating each hop, connects through the
 * connect-time IP guard (defeats DNS rebinding), caps the body + the timeout, and
 * returns the decoded text + title. A blocked URL throws {@link SsrfBlockedError}
 * (→ the API answers 4xx); a transport failure throws a plain Error (→ the job fails
 * cleanly, the daemon serves on).
 */
export function createUrlDocumentFetcher(options: UrlFetcherOptions = {}): DocumentContentFetcher {
	const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const allowLoopback = options.allowLoopbackForTest === true;

	return {
		async fetch(submission: DocumentSubmission): Promise<{ content: string; title?: string }> {
			let current = validateUrlScheme(submission.url.trim(), allowLoopback);
			for (let hop = 0; hop <= maxRedirects; hop++) {
				const res = await requestOnce(current, timeoutMs, maxBytes, allowLoopback);

				// Redirect: re-validate the NEXT hop through the SAME scheme + IP guard
				// (a 3xx Location can point anywhere, incl. a private address or file:).
				if (res.status >= 300 && res.status < 400 && res.location !== undefined) {
					if (hop === maxRedirects) throw new SsrfBlockedError("too many redirects");
					let next: URL;
					try {
						next = new URL(res.location, current);
					} catch {
						throw new SsrfBlockedError("malformed redirect target");
					}
					current = validateUrlScheme(next.toString(), allowLoopback); // scheme + literal-IP guard now; hostname IP guard at connect.
					continue;
				}

				if (res.status < 200 || res.status >= 300) {
					// A non-2xx, non-redirect is a fetch failure (NOT a guard block): the
					// status class is safe to surface (it is the remote server's own code),
					// and it carries no internal-topology information.
					throw new Error(`document fetch failed with status ${res.status}`);
				}

				const content = bytesToText(res.body, res.contentType);
				const title = extractTitle(res.body, res.contentType);
				return title.length > 0 ? { content, title } : { content };
			}
			// Unreachable (the loop returns or throws), but total for the type checker.
			throw new SsrfBlockedError("too many redirects");
		},
	};
}
