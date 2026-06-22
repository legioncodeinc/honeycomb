/**
 * SSRF-safe document URL fetcher — PRD-045 W1 remediation proof.
 *
 * The QA W1 finding: the composition root injected NO fetcher, so the document worker
 * chunked the URL STRING as content. This suite proves the REAL fetcher
 * ({@link createUrlDocumentFetcher}):
 *   - ingests the FETCHED body (text + title), not the URL string — via an IN-PROCESS
 *     loopback server (NO public-internet access in tests);
 *   - BLOCKS private / loopback / link-local / cloud-metadata addresses at the guard
 *     (the SSRF defense), returning an {@link SsrfBlockedError};
 *   - BLOCKS non-http(s) schemes (`file:` is never a network-or-file primitive);
 *   - enforces a response SIZE CAP and a TIMEOUT;
 *   - RE-VALIDATES every redirect hop through the same guard (a 302 → metadata is blocked).
 *
 * The loopback server is reached ONLY with the test escape hatch
 * (`allowLoopbackForTest: true`); every block test runs against the DEFAULT (production)
 * fetcher, so the guard proven blocking is the SAME guard the daemon runs.
 */

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	bytesToText,
	classifyBlockedAddress,
	createUrlDocumentFetcher,
	isSsrfBlockedError,
} from "../../../../src/daemon/runtime/sources/url-fetcher.js";
import type { DocumentSubmission } from "../../../../src/daemon/runtime/sources/document-worker.js";

const SCOPE = { org: "acme", workspace: "backend" } as const;
const sub = (url: string): DocumentSubmission => ({ url, org: SCOPE.org, workspace: SCOPE.workspace });

/** A handler for the in-process test server: returns [status, body, headers]. */
type Responder = (path: string) => { status: number; body: string; headers?: Record<string, string> };

/** Start a loopback test server with a per-request responder. Returns the base url + close fn. */
async function startServer(responder: Responder): Promise<{ base: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		const r = responder(req.url ?? "/");
		res.writeHead(r.status, { "content-type": "text/plain; charset=utf-8", ...(r.headers ?? {}) });
		res.end(r.body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("PRD-045 W1 — SSRF-safe URL document fetcher", () => {
	let srv: { base: string; close: () => Promise<void> } | undefined;
	afterEach(async () => {
		if (srv) await srv.close();
		srv = undefined;
	});

	describe("real-body ingest (NOT the URL string)", () => {
		it("fetches the document BODY at the URL and returns it as content + title (DONE-criterion)", async () => {
			srv = await startServer(() => ({
				status: 200,
				body: "<html><head><title>Hello Doc</title></head><body><p>real body content here</p></body></html>",
				headers: { "content-type": "text/html; charset=utf-8" },
			}));
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true });
			const out = await fetcher.fetch(sub(`${srv.base}/doc`));

			// The content is the FETCHED body, NOT the URL string (the W1 bug).
			expect(out.content).toContain("real body content here");
			expect(out.content).not.toContain(srv.base); // the url string is NOT the content.
			expect(out.title).toBe("Hello Doc");
		});

		it("returns plain text verbatim for a non-HTML content type", async () => {
			srv = await startServer(() => ({ status: 200, body: "line one\nline two\n" }));
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true });
			const out = await fetcher.fetch(sub(`${srv.base}/plain.txt`));
			expect(out.content).toContain("line one");
			expect(out.content).toContain("line two");
		});
	});

	describe("SSRF guard — blocks private / loopback / metadata addresses (DEFAULT/production fetcher)", () => {
		it("BLOCKS a loopback (127.0.0.1) URL with the production fetcher → SsrfBlockedError, not a fetch", async () => {
			// Start a real loopback server so a NAIVE fetcher WOULD succeed — the guard must refuse.
			srv = await startServer(() => ({ status: 200, body: "secret loopback service response" }));
			const fetcher = createUrlDocumentFetcher(); // no escape hatch → production posture.
			await expect(fetcher.fetch(sub(`${srv.base}/internal`))).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("BLOCKS the cloud-metadata address 169.254.169.254 → SsrfBlockedError", async () => {
			const fetcher = createUrlDocumentFetcher();
			await expect(
				fetcher.fetch(sub("http://169.254.169.254/latest/meta-data/iam/security-credentials/")),
			).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("BLOCKS a private 10.0.0.0/8 address → SsrfBlockedError", async () => {
			const fetcher = createUrlDocumentFetcher();
			await expect(fetcher.fetch(sub("http://10.0.0.5/internal"))).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("BLOCKS a private 192.168.0.0/16 address → SsrfBlockedError", async () => {
			const fetcher = createUrlDocumentFetcher();
			await expect(fetcher.fetch(sub("http://192.168.1.1/admin"))).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("BLOCKS an IPv4-mapped IPv6 literal to cloud metadata — [::ffff:169.254.169.254] (SSRF-bypass regression)", async () => {
			// The WHATWG URL parser normalizes this bracketed literal to the hex-hextet form
			// `::ffff:a9fe:a9fe`; a dotted-decimal-only guard classified that as PUBLIC and
			// fetched cloud metadata. The literal-IP pre-check in validateUrlScheme must refuse it.
			const fetcher = createUrlDocumentFetcher();
			await expect(
				fetcher.fetch(sub("http://[::ffff:169.254.169.254]/latest/meta-data/iam/security-credentials/")),
			).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("BLOCKS an IPv4-mapped IPv6 literal to loopback — [::ffff:127.0.0.1] (SSRF-bypass regression)", async () => {
			const fetcher = createUrlDocumentFetcher();
			await expect(fetcher.fetch(sub("http://[::ffff:127.0.0.1]:6379/"))).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("the error message names a REASON CLASS, never the resolved internal IP (no topology leak)", async () => {
			const fetcher = createUrlDocumentFetcher();
			await fetcher.fetch(sub("http://169.254.169.254/")).then(
				() => expect.fail("should have thrown"),
				(err: unknown) => {
					expect(isSsrfBlockedError(err)).toBe(true);
					const msg = err instanceof Error ? err.message : String(err);
					expect(msg).not.toContain("169.254.169.254");
				},
			);
		});
	});

	describe("scheme allowlist", () => {
		it("BLOCKS a file: URL (no local-file-disclosure primitive)", async () => {
			const fetcher = createUrlDocumentFetcher();
			await expect(fetcher.fetch(sub("file:///etc/passwd"))).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("BLOCKS a non-http(s) scheme (gopher:)", async () => {
			const fetcher = createUrlDocumentFetcher();
			await expect(fetcher.fetch(sub("gopher://example.com/"))).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("BLOCKS a malformed URL", async () => {
			const fetcher = createUrlDocumentFetcher();
			await expect(fetcher.fetch(sub("not a url at all"))).rejects.toSatisfy(isSsrfBlockedError);
		});
	});

	describe("size cap + timeout", () => {
		it("ABORTS a response that exceeds the byte cap (no unbounded buffering)", async () => {
			srv = await startServer(() => ({ status: 200, body: "x".repeat(10_000) }));
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true, maxBytes: 1_000 });
			await expect(fetcher.fetch(sub(`${srv.base}/big`))).rejects.toThrow(/size cap/i);
		});

		it("succeeds when the body is under the cap (boundary sanity)", async () => {
			srv = await startServer(() => ({ status: 200, body: "y".repeat(500) }));
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true, maxBytes: 1_000 });
			const out = await fetcher.fetch(sub(`${srv.base}/small`));
			expect(out.content.length).toBe(500);
		});

		it("TIMES OUT a hung server rather than wedging the worker", async () => {
			// A server that never responds → the request must abort on the deadline.
			const server = createServer(() => {
				/* deliberately never call res.end() */
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as AddressInfo;
			try {
				const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true, timeoutMs: 150 });
				await expect(fetcher.fetch(sub(`http://127.0.0.1:${port}/hang`))).rejects.toThrow(/timed out/i);
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		});
	});

	describe("redirect re-validation (DNS-rebinding / open-redirect defense)", () => {
		it("RE-VALIDATES a redirect target through the guard — a 302 → metadata is BLOCKED", async () => {
			// The loopback server (allowed via the escape hatch) 302s to the metadata IP, which
			// the guard must REFUSE on the next hop even though the first hop was allowed.
			srv = await startServer((path) => {
				if (path === "/redirect") {
					return { status: 302, body: "", headers: { location: "http://169.254.169.254/latest/" } };
				}
				return { status: 200, body: "should never reach here" };
			});
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true });
			await expect(fetcher.fetch(sub(`${srv.base}/redirect`))).rejects.toSatisfy(isSsrfBlockedError);
		});

		it("follows an allowed redirect to a fetchable body (loopback → loopback under the hatch)", async () => {
			srv = await startServer((path) => {
				if (path === "/start") return { status: 302, body: "", headers: { location: "/final" } };
				return { status: 200, body: "redirected body landed" };
			});
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true });
			const out = await fetcher.fetch(sub(`${srv.base}/start`));
			expect(out.content).toContain("redirected body landed");
		});

		it("BLOCKS a redirect to a file: scheme", async () => {
			srv = await startServer(() => ({ status: 302, body: "", headers: { location: "file:///etc/passwd" } }));
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true });
			await expect(fetcher.fetch(sub(`${srv.base}/to-file`))).rejects.toSatisfy(isSsrfBlockedError);
		});
	});

	describe("non-2xx handling", () => {
		it("a 404 from an allowed host is a fetch failure (NOT a guard block)", async () => {
			srv = await startServer(() => ({ status: 404, body: "nope" }));
			const fetcher = createUrlDocumentFetcher({ allowLoopbackForTest: true });
			await fetcher.fetch(sub(`${srv.base}/missing`)).then(
				() => expect.fail("should have thrown"),
				(err: unknown) => {
					expect(isSsrfBlockedError(err)).toBe(false); // a transport/status failure, NOT a guard block.
					expect(err instanceof Error ? err.message : "").toMatch(/status 404/);
				},
			);
		});
	});

	describe("classifyBlockedAddress (the pure guard core)", () => {
		it.each([
			["127.0.0.1", "loopback"],
			["10.1.2.3", "private 10/8"],
			["172.16.0.1", "private 172.16/12"],
			["172.31.255.254", "private 172.16/12 upper"],
			["192.168.0.1", "private 192.168/16"],
			["169.254.169.254", "metadata / link-local"],
			["100.64.0.1", "CGNAT"],
			["0.0.0.0", "unspecified"],
			["::1", "v6 loopback"],
			["fc00::1", "v6 unique-local"],
			["fe80::1", "v6 link-local"],
			["::ffff:127.0.0.1", "v4-mapped loopback (dotted)"],
			["::ffff:10.0.0.1", "v4-mapped private (dotted)"],
			// Regression — the WHATWG URL parser normalizes `[::ffff:127.0.0.1]` to the
			// HEX-HEXTET form below; a dotted-only guard let these reach cloud metadata (SSRF bypass).
			["::ffff:7f00:1", "v4-mapped loopback (hextet, URL-normalized)"],
			["::ffff:a9fe:a9fe", "v4-mapped 169.254.169.254 metadata (hextet)"],
			["::ffff:0a00:1", "v4-mapped 10.0.0.1 (hextet)"],
			["::ffff:c0a8:101", "v4-mapped 192.168.1.1 (hextet)"],
		])("BLOCKS %s (%s)", (addr) => {
			expect(classifyBlockedAddress(addr)).not.toBeNull();
		});

		it("ALLOWS a v4-mapped PUBLIC address in both spellings (no over-block)", () => {
			expect(classifyBlockedAddress("::ffff:8.8.8.8")).toBeNull();
			expect(classifyBlockedAddress("::ffff:0808:0808")).toBeNull(); // 8.8.8.8 hextet form
		});

		it.each([["8.8.8.8"], ["1.1.1.1"], ["93.184.216.34"], ["2606:2800:220:1:248:1893:25c8:1946"]])(
			"ALLOWS public address %s",
			(addr) => {
				expect(classifyBlockedAddress(addr)).toBeNull();
			},
		);

		it("allows loopback ONLY when the test escape hatch is set", () => {
			expect(classifyBlockedAddress("127.0.0.1")).not.toBeNull(); // default: blocked
			expect(classifyBlockedAddress("127.0.0.1", true)).toBeNull(); // hatch: allowed
			// the hatch relaxes ONLY loopback — a private address stays blocked even under it.
			expect(classifyBlockedAddress("10.0.0.1", true)).not.toBeNull();
			expect(classifyBlockedAddress("169.254.169.254", true)).not.toBeNull();
		});
	});

	describe("bytesToText (HTML → text reduction)", () => {
		it("strips scripts/styles/tags and decodes the common entities", () => {
			const html = "<html><body><script>evil()</script><style>x{}</style><p>A &amp; B &lt;ok&gt;</p></body></html>";
			const text = bytesToText(Buffer.from(html), "text/html");
			expect(text).not.toContain("evil()");
			expect(text).not.toContain("x{}");
			expect(text).toContain("A & B <ok>");
		});

		it("returns non-HTML bytes verbatim", () => {
			const text = bytesToText(Buffer.from("plain text\nbody"), "text/plain");
			expect(text).toBe("plain text\nbody");
		});
	});
});
