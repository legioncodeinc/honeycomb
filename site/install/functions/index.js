// site/install/functions/index.js — Cloudflare Pages Function for GET / content negotiation.
//
// The get.pnpm.io / sh.rustup.rs pattern: the SAME url serves a script to a pipe and a
// human page to a browser.
//
//   GET / from a SHELL client (curl/wget/fetch — UA/Accept that isn't an HTML browser)
//     → serve scripts/install/install.sh as text/plain, so `curl -fsSL https://get.theapiary.sh | sh` works.
//   GET / from a BROWSER (Accept: text/html)
//     → serve the human "inspect before piping" index.html.
//
// The static asset routes (/install.sh, /install.ps1, /SHA256SUMS, /index.html) are served
// directly by Pages from dist/ with the text/plain + nosniff headers pinned in _headers.
// This Function only governs the ROOT path "/".
//
// Pages Functions run on the Workers runtime; `context.env.ASSETS.fetch` reads the deployed
// static assets (dist/), so the served script is byte-identical to the published, checksummed file.

// The inspect-page CSP (kept in sync with the `/` + `/index.html` rules in _headers). The page uses
// only one inline <style>, one inline <script> (copy handler), an inline SVG, and a data: favicon.
const INSPECT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Only intercept the bare root. Everything else (the explicit /install.sh etc.) falls
  // through to the static asset pipeline + _headers.
  if (url.pathname !== '/') {
    return next();
  }

  if (wantsHtml(request)) {
    // Browser → the inspect page. Pages Functions do NOT inherit _headers for function-generated
    // responses, and env.ASSETS.fetch('/index.html') wouldn't match the "/" rule anyway — so set
    // the inspect-page security headers EXPLICITLY here (the authoritative source for the bare "/").
    const assetResp = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    return new Response(assetResp.body, {
      status: assetResp.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': INSPECT_CSP,
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // Shell client → stream the canonical install.sh as plain text so `| sh` works.
  const scriptUrl = new URL('/install.sh', url);
  const assetResp = await env.ASSETS.fetch(new Request(scriptUrl, request));
  // Re-wrap to GUARANTEE the content-type a pipe needs, regardless of asset defaults.
  return new Response(assetResp.body, {
    status: assetResp.status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// A request "wants HTML" only when it is an actual browser navigation: Accept lists text/html
// AND it is not a known CLI user-agent. curl/wget/fetch send `Accept: */*` (or omit it), so the
// default (no text/html preference) routes them to the script — exactly the rustup/pnpm behavior.
function wantsHtml(request) {
  const ua = (request.headers.get('User-Agent') || '').toLowerCase();
  // Explicit CLI fetchers never get HTML, even on the off chance they send an Accept header.
  if (/\b(curl|wget|fetch|libcurl|powershell|httpie|python-requests)\b/.test(ua)) {
    return false;
  }
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html');
}
