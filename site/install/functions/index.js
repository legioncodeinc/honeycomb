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
// static assets (dist/), so the served script is byte-identical to the published, checksummed file
// EXCEPT for the one deliberate exception below: a `?combo=<name>` preset (PRD-002a a-AC-4).
//
// ── PRD-002a a-AC-4: combo/alias URLs are OPTIONAL SUGAR, never the primary mechanism ─────────
// A shell client hitting `/?combo=<name>` (or a browser reading about it on the inspect page) gets
// the SAME install.sh bytes, with ONE extra line prepended: `export HONEYCOMB_INSTALL_PRODUCTS=...`
// (and, when the preset names one, `HONEYCOMB_INSTALL_PROFILE`). install.sh already reads these
// exact environment variables (see its header comment) at normal ENV precedence — this is not a
// second/parallel resolution mechanism, it is the SAME env-var input a repo administrator could set
// by hand, just pre-filled by a memorable URL. Because the bytes are no longer byte-identical to
// the checksummed install.sh, a combo URL is explicitly NOT what SHA256SUMS covers — the inspect
// page's "verify before you run" flow always points at the un-prefixed /install.sh.
const COMBO_PRESETS = {
  // Keep this table's PRODUCT VALUES in sync with the `--code=`/`--profile=` tables in
  // scripts/install/install.sh (resolve_code_products / resolve_profile_products) — this is a
  // separate, install-SITE-side convenience table (env-var injection), not the same code path.
  full: { products: 'honeycomb,doctor,hive,nectar', profile: 'full' },
};

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

  const combo = COMBO_PRESETS[(url.searchParams.get('combo') || '').trim()];
  if (combo !== undefined) {
    // Sugar path (a-AC-4): prepend the env-var assignments install.sh already understands, then
    // stream the UNCHANGED script body after them. `read -r` (used only for the here-doc guard
    // below, not present in install.sh) is not needed — a plain `export` line ahead of the
    // shebang-adjacent comment block is valid POSIX sh regardless of where it lands, since the
    // shebang itself only matters as the FIRST line of the invoking interpreter's own read, and a
    // piped `sh` invocation (`curl ... | sh`) never inspects the shebang at all.
    const body = await assetResp.text();
    const prefix =
      `# --- combo=${escapeForComment(url.searchParams.get('combo'))} preset injected by get.theapiary.sh (PRD-002a sugar; not covered by SHA256SUMS) ---\n` +
      `export HONEYCOMB_INSTALL_PRODUCTS="${escapeForShellDoubleQuotes(combo.products)}"\n` +
      (combo.profile ? `export HONEYCOMB_INSTALL_PROFILE="${escapeForShellDoubleQuotes(combo.profile)}"\n` : '') +
      `# --- end combo preset ---\n`;
    return new Response(prefix + body, {
      status: assetResp.status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        // Never cache a combo-prefixed response under the plain "/" cache key.
        'Cache-Control': 'no-store',
      },
    });
  }

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

// The preset table only ever supplies KNOWN, hardcoded values (never used with untrusted input),
// but both values are still escaped defensively so a future preset added by a careless edit can
// never break out of the double-quoted shell assignment it is injected into.
function escapeForShellDoubleQuotes(value) {
  return String(value).replace(/(["\\$`])/g, '\\$1');
}

function escapeForComment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '');
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
