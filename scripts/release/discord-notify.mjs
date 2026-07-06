#!/usr/bin/env node
// Announce a release on Discord via webhook (spec #6). Reads:
//   DISCORD_WEBHOOK_URL  — the webhook (a SECRET; never commit it),
//   RELEASE_VERSION      — e.g. "v0.5.12" or "0.5.12",
//   RELEASE_NOTES.md     — the notes produced by ai-release-notes.mjs.
//
// FAIL-SOFT: a missing webhook or a Discord hiccup logs and exits 0 so it can
// never red a release that already published to npm.

import { readFileSync, existsSync } from "node:fs";

const url = process.env.DISCORD_WEBHOOK_URL;
if (!url) {
  console.log("discord-notify: DISCORD_WEBHOOK_URL not set — skipping.");
  process.exit(0);
}

const version = (process.env.RELEASE_VERSION || "").replace(/^v/, "");
const pkg = JSON.parse(readFileSync("package.json", "utf8")).name;
const notes = existsSync("RELEASE_NOTES.md")
  ? readFileSync("RELEASE_NOTES.md", "utf8").trim()
  : `Release v${version}`;

// Discord embed description caps at 4096 chars — trim with an ellipsis.
const description = notes.length > 4000 ? notes.slice(0, 3990) + "\n…" : notes;

const payload = {
  username: "honeycomb releases",
  embeds: [
    {
      title: `${pkg} v${version}`,
      url: `https://www.npmjs.com/package/${pkg}/v/${version}`,
      description,
      color: 0xf5a623,
    },
  ],
};

try {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    console.error(`discord-notify: Discord returned ${r.status}: ${await r.text()}`);
  } else {
    console.log("discord-notify: posted release to Discord.");
  }
} catch (e) {
  console.error("discord-notify: post failed (non-fatal): " + e.message);
}
