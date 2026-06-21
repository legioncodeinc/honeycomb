#!/usr/bin/env node
// PRD-025 Wave 2 (D-2 / D-3 / AC-1 / AC-7) — first-run embedding-deps heal.
//
// Mirrors scripts/ensure-tree-sitter.mjs: a fast, NON-FATAL sanity check run from
// the `postinstall` hook. It HEALS NOTHING heavy and DOWNLOADS NOTHING here — the
// ~600 MB model is acquired LATER, lazily, on the daemon's first warmup (D-2: the
// model is acquired at first run, NEVER packed into the npm tarball; D-3: the
// download is background-warm and never blocks login or the first recall). This
// script only REPORTS whether the optional inference stack
// (`@huggingface/transformers`) resolved, so a consumer sees one clear line at
// install time instead of an opaque failure when the daemon later tries to warm.
//
// Why it stays in the `files` allowlist + `postinstall`: parity with
// ensure-tree-sitter (the install hook references it by path), and a deterministic,
// non-fatal install experience. It ALWAYS exits 0 (unless strict CI mode) — an
// end-user `npm i` must NEVER hard-break because the optional embed stack is absent;
// embeddings simply stay OFF until the deps are present (the BM25 lexical fallback
// has no quality cliff — PRD-025 D-4).

import { createRequire } from "node:module";

const ROOT = process.cwd();
const require = createRequire(`${ROOT}/`);

// Recursion guard for nested npm calls (parity with ensure-tree-sitter).
if (process.env.ENSURE_EMBED_RUNNING) process.exit(0);

// The opt-OUT (PRD-025 D-1): an explicit `HONEYCOMB_EMBEDDINGS=false`/`0` means the
// user does not want embeddings — say so and exit cleanly, never probing.
const raw = (process.env.HONEYCOMB_EMBEDDINGS ?? "").trim().toLowerCase();
if (raw === "false" || raw === "0") {
  console.error(
    "[ensure-embed-deps] HONEYCOMB_EMBEDDINGS opt-out set — embeddings disabled, recall is lexical-only. Skipping.",
  );
  process.exit(0);
}

// The optional inference stack. It is an `optionalDependency` (~600 MB with its
// native ONNX runtime), so a slimmed / offline / `--no-optional` install legitimately
// lacks it. Resolve-only: we do NOT import it (importing would load native bindings
// at install time — exactly what we avoid; the daemon loads it lazily on warmup).
let present = true;
try {
  require.resolve("@huggingface/transformers");
} catch {
  present = false;
}

if (present) {
  console.error(
    "[ensure-embed-deps] OK — @huggingface/transformers present. The nomic-embed-text-v1.5 model " +
      "(~600 MB) downloads + caches on first daemon warmup (one time), then reuses the cached dir.",
  );
  process.exit(0);
}

// Absent: this is the COMMON, non-error case for a lean install. Embeddings stay OFF
// and recall is the BM25/ILIKE lexical fallback (no quality cliff — D-4). In strict CI
// mode a missing optional stack can be made a hard signal; otherwise it is informational.
const strict = process.env.HONEYCOMB_STRICT_POSTINSTALL === "1";
console.error(
  "[ensure-embed-deps] @huggingface/transformers not installed — semantic recall is OFF; recall " +
    "falls back to lexical (BM25/ILIKE), which is fine. To enable semantic recall, install the " +
    "optional embedding deps (`npm i @huggingface/transformers`) and restart the daemon." +
    (strict ? " (strict mode — failing this install)" : " (non-fatal)"),
);
process.exit(strict ? 1 : 0);
