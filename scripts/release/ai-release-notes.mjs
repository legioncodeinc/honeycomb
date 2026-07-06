#!/usr/bin/env node
// Generate polished release notes for a version with Claude Sonnet 5 on Bedrock
// (spec #5: every release cuts good release notes). Input: env RELEASE_VERSION
// (e.g. "v0.5.12" or "0.5.12"), the CHANGELOG entry for it, and the commit
// subjects since the previous tag. Output: RELEASE_NOTES.md — used as BOTH the
// GitHub Release body and the Discord message.
//
// FAIL-SOFT: if Bedrock is unreachable / unconfigured, fall back to the raw
// CHANGELOG entry so a release NEVER reds just because note-polishing failed.
//
// AUTH: long-lived AWS creds via the standard env chain. MODEL: BEDROCK_MODEL_ID.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const version = (process.env.RELEASE_VERSION || "").replace(/^v/, "");
if (!version) {
  console.error("ai-release-notes: RELEASE_VERSION is required.");
  process.exit(1);
}
const name = JSON.parse(readFileSync("package.json", "utf8")).name;

// CHANGELOG slice for this version (## vX.Y.Z … up to the next ## heading).
let changelogEntry = "";
if (existsSync("CHANGELOG.md")) {
  const cl = readFileSync("CHANGELOG.md", "utf8");
  const start = cl.indexOf(`## v${version}`);
  if (start !== -1) {
    const rest = cl.slice(start + 3);
    const next = rest.indexOf("\n## ");
    changelogEntry = ("## " + (next === -1 ? rest : rest.slice(0, next))).trim();
  }
}

// Commit subjects since the previous tag (best-effort; fall back to last 30).
let commits = "";
try {
  const prevTag = execSync("git describe --tags --abbrev=0 HEAD^ 2>/dev/null", {
    encoding: "utf8",
  }).trim();
  commits = execSync(`git log ${prevTag}..HEAD --format=%s`, {
    encoding: "utf8",
  }).trim();
} catch {
  commits = execSync("git log -30 --format=%s", { encoding: "utf8" }).trim();
}

let notes = changelogEntry;
try {
  const { invokeClaude } = await import("./bedrock.mjs");
  const text = await invokeClaude({
    maxTokens: 700,
    system: [
      "You write concise, honest release notes for a published npm package.",
      "Given the CHANGELOG entry and recent commit subjects, produce Markdown with:",
      "  - a single one-line headline (no leading '#');",
      "  - a short '### What changed' section of user-facing bullets (no internal jargon);",
      "  - a '### Upgrade notes' section ONLY if an installer must do or know something.",
      "Do NOT invent changes that are not supported by the input. No preamble, no sign-off.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `Package: ${name}\nVersion: v${version}\n\nCHANGELOG entry:\n${
          changelogEntry || "(none)"
        }\n\nRecent commit subjects:\n${commits || "(none)"}`,
      },
    ],
  });
  if (text) notes = text;
  console.log("ai-release-notes: generated notes via Bedrock.");
} catch (e) {
  console.error(
    "ai-release-notes: model call failed, falling back to CHANGELOG entry: " +
      e.message,
  );
}

if (!notes) notes = `Release v${version} of ${name}.`;
writeFileSync("RELEASE_NOTES.md", notes.endsWith("\n") ? notes : notes + "\n");
console.log("ai-release-notes: wrote RELEASE_NOTES.md");
