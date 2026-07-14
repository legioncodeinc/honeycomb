#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("prepare-packed-artifact must run through npm");

const raw = execFileSync(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts"], {
	cwd: resolve("."),
	encoding: "utf8",
});
const packed = JSON.parse(raw);
const filename = packed[0]?.filename;
if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");

const manifest = resolve(".pack-result.json");
const tarball = resolve(filename);
// Exclusive creation fails closed if a stale file or symlink already occupies the manifest path.
writeFileSync(manifest, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
if (process.env.GITHUB_ENV) {
	appendFileSync(
		process.env.GITHUB_ENV,
		`HONEYCOMB_PACKED_TARBALL=${tarball}\nHONEYCOMB_PACK_MANIFEST=${manifest}\n`,
		"utf8",
	);
}
process.stdout.write(`${tarball}\n`);
