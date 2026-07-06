#!/usr/bin/env node
// AI changeset author (PR-time). Calls Claude Sonnet 5 on Amazon Bedrock with
// the PR diff + commit subjects and decides a semver bump + a user-facing
// summary, then writes the changeset the gate/bump steps consume.
//
// RULES (release-automation spec #1):
//   * The model may effectively ship ONLY `patch` or `minor`. If it judges the
//     change breaking (`major`) we DO NOT downgrade — we emit `bump=major` and
//     write NO changeset, so the workflow HARD-BLOCKS the PR for a manual major
//     cut. Silently clamping major -> minor would mislabel a breaking change,
//     which is the one semver mistake that actually hurts installers.
//   * If a changeset already exists (a human wrote one, or a prior run), we do
//     NOT call the model — we just report the existing bump so the gate holds.
//
// OUTPUT ($GITHUB_OUTPUT): bump=<patch|minor|major|none>, created=<true|false>,
//                          summary=<one-liner> (only when created).
//
// AUTH: an Amazon Bedrock API key via env AWS_BEARER_TOKEN_BEDROCK (+ AWS_REGION).
// MODEL: env BEDROCK_MODEL_ID (the Sonnet 5 cross-region inference-profile id).
// The actual Bedrock call lives in ./bedrock.mjs. No OIDC, no access-key pair.

import { execSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";

const CHANGESET_DIR = ".changeset";
const PKG_NAME = JSON.parse(readFileSync("package.json", "utf8")).name;

function ghOutput(key, val) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${key}=${val}\n`);
  console.log(`${key}=${val}`);
}

function existingChangeset() {
  if (!existsSync(CHANGESET_DIR)) return null;
  const f = readdirSync(CHANGESET_DIR).find(
    (n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md",
  );
  return f ? `${CHANGESET_DIR}/${f}` : null;
}

function bumpOf(file) {
  const m = readFileSync(file, "utf8").match(/"[^"]+"\s*:\s*(patch|minor|major)/i);
  return m ? m[1].toLowerCase() : null;
}

// 1) Respect an existing changeset — never re-author on top of one.
const existing = existingChangeset();
if (existing) {
  ghOutput("bump", bumpOf(existing) || "none");
  ghOutput("created", "false");
  process.exit(0);
}

// 2) Gather PR context (diff excludes .changeset so the model never sees its
//    own prior output).
const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
if (!base || !head) {
  console.error("ai-changeset: BASE_SHA and HEAD_SHA are required.");
  process.exit(1);
}
const commits = execSync(`git log ${base}..${head} --format=%s`, {
  encoding: "utf8",
}).trim();
const diff = execSync(`git diff ${base}...${head} -- . ":(exclude).changeset"`, {
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 64,
}).slice(0, 80_000);

// 3) Ask Sonnet 5 on Bedrock (auth via Bedrock API key / bearer token).
const { invokeClaude } = await import("./bedrock.mjs");

const system = [
  "You author npm changeset entries for a published CLI/library package.",
  "Choose the semver bump conservatively from the diff and commit subjects:",
  "  patch = bug fix, internal-only change, refactor, docs, tests, or chore;",
  "  minor = a backward-compatible new feature or capability;",
  "  major = a BREAKING change to the public API, CLI surface, or documented behavior.",
  "When torn between two levels, pick the LOWER unless there is a clear breaking change.",
  "Write `summary` as 1-2 sentences describing the change for someone who INSTALLS",
  "the package (user-facing value, not internal mechanics).",
  'Return ONLY minified JSON: {"bump":"patch|minor|major","summary":"..."}',
].join("\n");

const text = await invokeClaude({
  maxTokens: 400,
  system,
  messages: [
    {
      role: "user",
      content: `Package: ${PKG_NAME}\n\nCommit subjects:\n${
        commits || "(none)"
      }\n\nDiff (truncated to 80k):\n${diff}`,
    },
  ],
});
let parsed;
try {
  parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
} catch {
  console.error("ai-changeset: model did not return JSON:\n" + text);
  process.exit(1);
}

const bump = String(parsed.bump || "").toLowerCase();
const summary = String(parsed.summary || "").trim();
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("ai-changeset: invalid bump from model: " + bump);
  process.exit(1);
}

// 4) MAJOR is BLOCKED — never write a major changeset; just signal the block.
if (bump === "major") {
  console.log(
    "ai-changeset: model judged this a MAJOR (breaking) change — blocking, no changeset written.",
  );
  ghOutput("bump", "major");
  ghOutput("created", "false");
  process.exit(0);
}

// 5) Write the changeset (Changesets frontmatter format).
if (!existsSync(CHANGESET_DIR)) mkdirSync(CHANGESET_DIR, { recursive: true });
const slug = `ai-${head.slice(0, 7)}`;
writeFileSync(
  `${CHANGESET_DIR}/${slug}.md`,
  `---\n"${PKG_NAME}": ${bump}\n---\n\n${summary}\n`,
);
console.log(`ai-changeset: wrote ${CHANGESET_DIR}/${slug}.md (${bump}): ${summary}`);
ghOutput("bump", bump);
ghOutput("created", "true");
ghOutput("summary", summary);
