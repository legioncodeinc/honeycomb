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
writeFileSync(manifest, raw, "utf8");
if (process.env.GITHUB_ENV) {
	appendFileSync(
		process.env.GITHUB_ENV,
		`HONEYCOMB_PACKED_TARBALL=${tarball}\nHONEYCOMB_PACK_MANIFEST=${manifest}\n`,
		"utf8",
	);
}
process.stdout.write(`${tarball}\n`);
