import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const creds = JSON.parse(readFileSync(join(homedir(), ".deeplake", "credentials.json"), "utf-8"));
process.env.HONEYCOMB_DEEPLAKE_TOKEN = creds.token;
process.env.HONEYCOMB_DEEPLAKE_ENDPOINT = creds.apiUrl;
process.env.HONEYCOMB_DEEPLAKE_ORG = creds.orgId;
const storage = (await import("./src/daemon/storage/index.ts")).createStorageClient({});
const { serializeFloat4Array } = await import("./src/daemon/storage/vector.ts");
const scope = { org: creds.orgId, workspace: creds.workspaceId ?? "default" };

// --- Fetch a query vector ---
async function embed(text) {
  const r = await fetch("http://127.0.0.1:3851/embed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `search_query: ${text}` }),
  });
  return (await r.json()).vector;
}

// --- Pull a candidate set: lexical matches + cosine top-K, fused ---
async function gather(queryText) {
  const vecLit = serializeFloat4Array(await embed(queryText));
  // Cosine top 15 (semantic arm)
  const cosSql = `SELECT id, content, importance, ((content_embedding <#> ${vecLit})) AS neg_cos FROM memories WHERE is_deleted = 0 AND ARRAY_LENGTH(content_embedding, 1) > 0 ORDER BY content_embedding <#> ${vecLit} LIMIT 15`;
  const cos = await storage.query(cosSql, scope);
  // Lexical matches (all rows matching the term)
  const lexSql = `SELECT id, content, importance FROM memories WHERE content::text ILIKE '%${queryText.replace(/'/g, "''")}%' AND is_deleted = 0 LIMIT 50`;
  const lex = await storage.query(lexSql, scope);
  return { cosine: cos.rows ?? [], lexical: lex.rows ?? [] };
}

// --- Pairwise cosine between two memory embeddings (cheap, in-process) ---
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { let s = 0; for (const x of a) s += x*x; return Math.sqrt(s); }
function cosine(a, b) { return dot(a,b) / (norm(a)*norm(b)); }

// --- Cluster collapse: greedy, threshold-based ---
function collapse(rows, embeddings, threshold = 0.85) {
  // rows: [{id, content, importance, neg_cos}], embeddings: Map<id, number[]>
  // RRF-style: walk rows in ranked order; for each, check if it's a near-dup
  // of any already-kept row. If so, merge (keep higher-importance; bump its score).
  const kept = [];
  const dropped = [];
  for (const row of rows) {
    const emb = embeddings.get(row.id);
    let isDup = false;
    for (const k of kept) {
      const kEmb = embeddings.get(k.id);
      if (!emb || !kEmb) continue;
      const sim = cosine(emb, kEmb);
      if (sim >= threshold) {
        isDup = true;
        // Promote: if this dropped row had higher importance, it becomes the rep
        if ((row.importance ?? 0) > (k.importance ?? 0)) {
          k.id = row.id; k.content = row.content; k.importance = row.importance;
        }
        k.clusterSize = (k.clusterSize ?? 1) + 1;
        break;
      }
    }
    if (isDup) dropped.push(row);
    else kept.push({ ...row, clusterSize: 1 });
  }
  return { kept, dropped };
}

// --- RRF fuse (simple) ---
function rrf(rows, armWeight = 1.0) {
  return rows.map((r, i) => ({ ...r, rrf: 1 / (60 + i + 1) * armWeight }));
}

async function run(queryText) {
  const { cosine, lexical } = await gather(queryText);

  // Pull embeddings for every candidate so we can do pairwise similarity
  const ids = new Set([...cosine.map(r=>r.id), ...lexical.map(r=>r.id)]);
  const embMap = new Map();
  for (const id of ids) {
    const r = await storage.query(`SELECT content_embedding FROM memories WHERE id = '${id}' LIMIT 1`, scope);
    if (r.rows?.[0]?.content_embedding) embMap.set(id, r.rows[0].content_embedding);
  }

  // RRF fuse the two arms (each contributes 1/(60+rank))
  const cosRRF = rrf(cosine, 1.0);
  const lexRRF = rrf(lexical.map((r,i) => ({...r, neg_cos: 0})), 0.7); // lexical slightly downweighted
  const fused = new Map();
  for (const r of [...cosRRF, ...lexRRF]) {
    const prev = fused.get(r.id) ?? { ...r, rrf: 0 };
    prev.rrf += r.rrf;
    if (r.neg_cos !== undefined && (prev.neg_cos === undefined || r.neg_cos !== 0)) prev.neg_cos = r.neg_cos;
    fused.set(r.id, prev);
  }
  const ranked = [...fused.values()].sort((a,b) => b.rrf - a.rrf);

  // BEFORE: top 8 (no collapse)
  console.log(`\n=========== query: "${queryText}" ===========`);
  console.log("--- BEFORE cluster collapse (RRF top 8) ---");
  ranked.slice(0, 8).forEach((r, i) => {
    const t = r.id === "mem_mr8iqcyi_5p5a1hpl" ? " <<<<< TARGET" : "";
    console.log(`  ${(i+1).toString().padStart(2)} | rrf=${r.rrf.toFixed(5)} | imp=${r.importance} | ${r.content.slice(0,75)}${t}`);
  });

  // AFTER: collapse + show top 5
  const { kept } = collapse(ranked, embMap, 0.85);
  console.log("--- AFTER cluster collapse (top 5, threshold=0.85) ---");
  kept.slice(0, 5).forEach((r, i) => {
    const t = r.id === "mem_mr8iqcyi_5p5a1hpl" ? " <<<<< TARGET" : "";
    const csize = r.clusterSize > 1 ? ` (cluster of ${r.clusterSize})` : "";
    console.log(`  ${(i+1).toString().padStart(2)} | rrf=${r.rrf.toFixed(5)} | imp=${r.importance}${csize} | ${r.content.slice(0,75)}${t}`);
  });
}

await run("honeycomb");
await run("local queue");
