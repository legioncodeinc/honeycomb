#!/usr/bin/env node
/**
 * TEMP battle-test probe (them-not-us evidence). Talks to the REAL DeepLake backend
 * through the RAW HttpDeepLakeTransport (NO retry, NO result shaping) so we capture the
 * backend's TRUE per-attempt HTTP status + latency — separating backend faults ("them")
 * from our client's retry/classification ("us"). All work is on a throwaway table with
 * DUMMY data (no user content), which we DROP on teardown; error bodies carry no secret.
 *
 * Emits: index-build (CREATE TABLE ... USING deeplake) DDL timing, a status histogram,
 * latency stats per phase, and a few redacted sample error messages.
 */
import { HttpDeepLakeTransport, resolveStorageConfig, envCredentialProvider, buildCreateTableSql } from "../dist/src/daemon/storage/index.js";
import { healTargetFor } from "../dist/src/daemon/storage/catalog/index.js";

const config = resolveStorageConfig(envCredentialProvider());
const transport = new HttpDeepLakeTransport(config.endpoint, config.token);
const org = config.org;
const workspace = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? config.workspace;

// Redact any long hex run + the token, defensively (dummy data → nothing to leak, but be safe).
const redact = (s) => String(s).split(config.token).join("<tok>").replace(/[0-9a-f]{16,}/gi, "<hex>");

function timeoutSignal(ms) {
	const ac = new AbortController();
	setTimeout(() => ac.abort(), ms).unref?.();
	return ac.signal;
}

async function attempt(kind, sql, timeoutMs = 30000) {
	const t0 = process.hrtime.bigint();
	try {
		const rows = await transport.query({ sql, org, workspace, signal: timeoutSignal(timeoutMs) });
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		return { kind, ok: true, ms, status: 200, n: rows.length };
	} catch (e) {
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		return { kind, ok: false, ms, status: e?.status ?? null, errKind: e?.kind ?? "unknown", msg: redact(e?.message ?? String(e)) };
	}
}

const runId = process.env.PROBE_RUN_ID ?? `probe_t${(process.hrtime.bigint() % 1000000000n).toString()}`;
const table = `ci_probe_${runId}`;
const cols = [...healTargetFor("memories").columns, { name: "version", sql: "BIGINT NOT NULL DEFAULT 0" }];

const results = [];
console.log(`probe run=${runId} org=****${org.slice(-4)} workspace=${workspace} endpoint=${config.endpoint}`);

// 1) INDEX BUILD — the CREATE TABLE ... USING deeplake DDL (builds the deeplake index).
const ddl = await attempt("ddl_create_index", buildCreateTableSql(table, cols), 120000);
results.push(ddl);
console.log(`\n[1] index-build DDL (CREATE TABLE USING deeplake): ok=${ddl.ok} ms=${ddl.ms.toFixed(0)} status=${ddl.status}${ddl.ok ? "" : " :: " + ddl.msg}`);

// 2) Sequential single-row INSERT burst.
const N = Number(process.env.PROBE_INSERTS ?? 30);
const idCol = "id";
for (let i = 0; i < N; i++) {
	const id = `${runId}_${i}`;
	const sql = `INSERT INTO "${table}" (${idCol}, content, content_hash, version) VALUES ('${id}', 'dummy probe content ${i}', '${i.toString().padStart(64, "0")}', 1)`;
	results.push(await attempt("insert_seq", sql));
}

// 3) Sequential dedup-probe SELECT burst (the exact BUG-04 shape).
for (let i = 0; i < N; i++) {
	const sql = `SELECT ${idCol} FROM "${table}" WHERE content_hash = '${i.toString().padStart(64, "0")}' LIMIT 1`;
	results.push(await attempt("select_seq", sql));
}

// 4) Concurrent SELECT burst (saturation probe).
const C = Number(process.env.PROBE_CONCURRENCY ?? 16);
const batch = Array.from({ length: C }, (_, i) =>
	attempt("select_conc", `SELECT ${idCol} FROM "${table}" WHERE content_hash = '${(i % N).toString().padStart(64, "0")}' LIMIT 1`),
);
results.push(...(await Promise.all(batch)));

// 5) Teardown DROP (best-effort).
const drop = await attempt("ddl_drop", `DROP TABLE "${table}"`, 60000);
results.push(drop);
console.log(`[5] DROP: ok=${drop.ok} ms=${drop.ms.toFixed(0)} status=${drop.status}${drop.ok ? "" : " :: " + drop.msg}`);

// ── Aggregate ────────────────────────────────────────────────────────────────
const statusHist = {};
for (const r of results) {
	const key = r.ok ? "200(ok)" : `${r.status ?? r.errKind}`;
	statusHist[key] = (statusHist[key] ?? 0) + 1;
}
const byKind = {};
for (const r of results) {
	byKind[r.kind] ??= { n: 0, ok: 0, msTotal: 0, msMax: 0, msList: [] };
	const b = byKind[r.kind];
	b.n++; if (r.ok) b.ok++; b.msTotal += r.ms; b.msMax = Math.max(b.msMax, r.ms); b.msList.push(r.ms);
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

console.log(`\n── Status histogram (RAW per-attempt, no retry) ──`);
for (const [k, v] of Object.entries(statusHist).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);

console.log(`\n── Latency by phase (ok/n, mean, p50/p95/max ms) ──`);
for (const [k, b] of Object.entries(byKind)) {
	console.log(`  ${k.padEnd(18)} ok=${b.ok}/${b.n}  mean=${(b.msTotal / b.n).toFixed(0)}  p50=${pct(b.msList, 50).toFixed(0)}  p95=${pct(b.msList, 95).toFixed(0)}  max=${b.msMax.toFixed(0)}`);
}

const failures = results.filter((r) => !r.ok);
console.log(`\n── Sample redacted error messages (${failures.length} failures total) ──`);
for (const f of failures.slice(0, 6)) console.log(`  [${f.kind}] status=${f.status} kind=${f.errKind} :: ${f.msg?.slice(0, 180)}`);

const totalErr = failures.length / results.length;
console.log(`\nTOTAL: attempts=${results.length}  raw_error_rate=${(totalErr * 100).toFixed(1)}%`);
