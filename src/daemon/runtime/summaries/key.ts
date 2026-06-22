/**
 * Tier-1 KEY derivation — PRD-046b (b-AC-2 / b-AC-3), folded into the EXISTING summary
 * gate pass so there is NO second LLM round-trip.
 *
 * The 3-tier zoom memory's Tier 1 is an INDEX ENTRY: a ≤1-sentence, keyword-dense
 * headline the agent skims to decide whether to zoom into the Tier-2 summary
 * (`memory.summary`) or the Tier-3 raw turns (`sessions`). Key sharpness is the
 * make-or-break for the whole feature (a bland key is ignored, wasting the prime) —
 * see `library/knowledge/private/ai/distillation-and-tier1-keys.md`.
 *
 * ── The two-step grounded discipline (b-AC-3) ────────────────────────────────
 * A distilled memory that INVENTS a fact poisons every future session that reads it.
 * So the gate emits ONE structured object in a fixed order — structured extraction
 * FIRST, then the grounded narrative, then the key DERIVED from the grounded facts:
 *
 *   1. `extraction` — facts ONLY (goals · decisions · changes · blockers · next),
 *      pulled out before any prose. Facts-first prevents the narrative from
 *      confabulating.
 *   2. `summary` — the Tier-2 narrative, grounded ONLY in step-1 facts (→ `memory.summary`).
 *   3. `key` — the Tier-1 headline, derived from the grounded summary, never from the
 *      raw turns directly, so it inherits the grounding (→ `memory.key`).
 *
 * The {@link parseSummaryGate} parser tolerates a fenced/prefixed JSON body, validates
 * the shape with zod (the UNTRUSTED gate-output boundary), and runs a DETERMINISTIC
 * GROUNDING GUARD: every significant content word in the key must appear in the
 * extraction facts. A key that smuggles in an un-extracted noun is REJECTED back to a
 * key derived purely from the extraction (the anti-confabulation floor that does not
 * depend on the gate model behaving).
 *
 * ── No new generation (b-AC-2 reuse) ─────────────────────────────────────────
 * This module owns ONLY the prompt text + the parse/ground discipline. The worker
 * (`worker.ts`) runs the SAME `SummaryGenCli` gate it already runs; it just asks for
 * the structured object instead of bare markdown and reads `{ summary, key }` off the
 * parse. The prime (046c) then reads `key` with a pure SQL skim — no generation at
 * read time (b-AC-4).
 *
 * ── Secrets (b-AC-5) ─────────────────────────────────────────────────────────
 * The events are scrubbed with `redactSecrets` at the prompt boundary by the worker
 * BEFORE they reach this prompt (the same deterministic floor the bare-markdown gate
 * used), so no secret/PII can reach the extraction, the summary, or the key.
 */

import { z } from "zod";

import { redactSecrets } from "../skillify/miner.js";

/** Max length of a Tier-1 key (a headline, not a paragraph). A longer key is truncated. */
export const MAX_KEY_CHARS = 200;

/**
 * The structured extraction facts the gate pulls out FIRST (b-AC-3 step 1). Every field
 * defaults to an empty list so a partial extraction still parses (drop-invalid at the
 * boundary, never throw). These are the ONLY facts the summary + key may use.
 */
export const ExtractionSchema = z.object({
	/** What the user/session set out to do. */
	goals: z.array(z.string()).default([]),
	/** Decisions reached (the load-bearing "what was decided"). */
	decisions: z.array(z.string()).default([]),
	/** Concrete changes / fixes that landed (the outcome-bearing facts). */
	changes: z.array(z.string()).default([]),
	/** Blockers / open problems encountered. */
	blockers: z.array(z.string()).default([]),
	/** Follow-ups / next steps. */
	next: z.array(z.string()).default([]),
});

/** The validated structured extraction (the grounding source of truth). */
export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * The structured object the summary gate emits (b-AC-2 / b-AC-3). Order is meaningful:
 * `extraction` (facts) → `summary` (grounded narrative) → `key` (derived headline).
 */
export const SummaryGateSchema = z.object({
	/** Step 1: the facts pulled out before any prose (the grounding source). */
	extraction: ExtractionSchema.default({ goals: [], decisions: [], changes: [], blockers: [], next: [] }),
	/** Step 2: the Tier-2 narrative, grounded ONLY in the extraction (→ `memory.summary`). */
	summary: z.string().default(""),
	/** Step 3: the Tier-1 key, derived from the grounded summary (→ `memory.key`). */
	key: z.string().default(""),
});

/** The validated gate object (pre-grounding-guard). */
export type SummaryGateOutput = z.infer<typeof SummaryGateSchema>;

/**
 * The grounded result the worker writes: the Tier-2 `summary` body + the Tier-1 `key`,
 * both proven grounded in the extraction. {@link parseSummaryGate} returns this, or
 * `null` when the gate output is unusable (so the worker treats it like an empty gate
 * result — remove the placeholder, write nothing).
 */
export interface GroundedSummary {
	/** The Tier-2 narrative summary (→ `memory.summary`). Never empty when this is returned. */
	readonly summary: string;
	/** The Tier-1 ≤1-sentence keyword-dense key (→ `memory.key`). Never empty. */
	readonly key: string;
	/** The structured extraction the summary + key are grounded in (for diagnostics/tests). */
	readonly extraction: Extraction;
}

// ════════════════════════════════════════════════════════════════════════════
// The gate prompt — structured extraction FIRST, then grounded narrative, then key.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The instruction block prepended to the rendered events (b-AC-2 / b-AC-3). It asks for
 * ONE JSON object in the fixed grounded order. The worker appends the scrubbed,
 * ordered events after `Events:`; this is the SAME shell-out the bare-markdown gate
 * used, so there is no second round-trip.
 *
 * The key instructions encode the good-vs-bad-key bar from the strategy doc: front-load
 * the subsystem + the OUTCOME ("X broke, fixed via Y"), keyword-dense, self-contained.
 */
export const SUMMARY_GATE_INSTRUCTIONS =
	"You are a session-memory distiller. Read the conversation below and emit EXACTLY ONE " +
	"JSON object (no preamble, no markdown fences, no trailing prose) with this shape:\n" +
	"{\n" +
	'  "extraction": { "goals": [], "decisions": [], "changes": [], "blockers": [], "next": [] },\n' +
	'  "summary": "<a concise wiki-style markdown summary>",\n' +
	'  "key": "<ONE keyword-dense sentence>"\n' +
	"}\n\n" +
	"Work in THREE grounded steps, in order:\n" +
	"  1. extraction — pull the FACTS out FIRST: goals, decisions, concrete changes/fixes, " +
	"blockers, and follow-ups. Use SHORT factual phrases. Invent NOTHING not present in the conversation.\n" +
	"  2. summary — write the narrative summary using ONLY facts from step 1. Do not add anything " +
	"the extraction does not contain.\n" +
	"  3. key — derive ONE sentence from the summary: keyword-forward, self-contained (it must make " +
	"sense cold, months later), front-loading the SUBSYSTEM and the OUTCOME. " +
	'Prefer "X broke and was fixed with Y" over "discussed X". Do NOT introduce any noun not in the extraction.\n\n';

/**
 * Build the full structured gate prompt from the rendered, ALREADY-SCRUBBED event body
 * (b-AC-2). The worker scrubs + renders the events (secret-safe, b-AC-5) and passes the
 * body here; this only prepends the grounded-distillation instructions + the session id.
 */
export function buildStructuredSummaryPrompt(sessionId: string, renderedEvents: string): string {
	return `${SUMMARY_GATE_INSTRUCTIONS}Session: ${sessionId}\nEvents:\n${renderedEvents}\n`;
}

// ════════════════════════════════════════════════════════════════════════════
// Parse + ground — tolerant JSON extraction, zod validation, grounding guard.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract the first balanced top-level JSON object from a gate response (b-AC-2). The
 * gate is asked for bare JSON, but a host CLI may wrap it in a ```json fence or add a
 * line of preamble; this finds the first `{ … }` span by brace-matching (string-aware,
 * so a brace inside a quoted value never breaks the scan). Returns the JSON text, or
 * `null` when there is no object.
 */
export function extractJsonObject(raw: string): string | null {
	const start = raw.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return raw.slice(start, i + 1);
		}
	}
	return null;
}

/** Lowercased significant content tokens (≥4 chars or all-caps acronyms / identifiers). */
function significantTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	// Split on non-word (keep `_`/`-`/`.` inside identifiers like `deeplake_hybrid_record`).
	for (const rawTok of text.split(/[^A-Za-z0-9_.\-]+/)) {
		const tok = rawTok.replace(/^[._-]+|[._-]+$/g, "");
		if (tok === "") continue;
		const lower = tok.toLowerCase();
		// Keep identifiers/long words (the searchable nouns) and short ALL-CAPS acronyms (CI, RRF, SQL).
		if (tok.length >= 4 || /^[A-Z0-9]{2,}$/.test(tok)) tokens.add(lower);
	}
	return tokens;
}

/** The flattened set of significant tokens across every extraction fact (the grounding corpus). */
function extractionTokens(extraction: Extraction): Set<string> {
	const all = [
		...extraction.goals,
		...extraction.decisions,
		...extraction.changes,
		...extraction.blockers,
		...extraction.next,
	].join(" ");
	return significantTokens(all);
}

/**
 * STOP-WORD-ish common verbs/connectives a grounded headline may use even if the
 * extraction phrased the same fact differently. These carry no fact, so allowing them
 * never lets a confabulated NOUN through — the guard only rejects a key whose
 * SUBSTANTIVE tokens are absent from the extraction.
 */
const GROUNDING_ALLOW = new Set<string>([
	"fixed",
	"broke",
	"broken",
	"added",
	"switched",
	"changed",
	"shipped",
	"failed",
	"failing",
	"removed",
	"with",
	"via",
	"using",
	"into",
	"from",
	"after",
	"before",
	"returns",
	"return",
	"because",
	"then",
	"when",
	"never",
	"always",
	"must",
]);

/**
 * Token-set grounding core: is every significant token in `key` either present in the
 * `corpus` token set or an allowed connective/verb? The single grounding rule both the
 * episodic ({@link isKeyGrounded}) and durable ({@link isKeyGroundedInText}) paths share,
 * so the anti-confabulation floor is derived ONCE and never forks.
 */
function isGroundedInTokens(key: string, corpus: ReadonlySet<string>): boolean {
	for (const tok of significantTokens(key)) {
		if (corpus.has(tok)) continue;
		if (GROUNDING_ALLOW.has(tok)) continue;
		return false;
	}
	return true;
}

/**
 * Is `key` GROUNDED in the extraction (b-AC-3)? True iff every significant token in the
 * key is either (a) present in the extraction facts, or (b) an allowed connective/verb.
 * A key that introduces a NOUN absent from the extraction is NOT grounded — the gate
 * confabulated, and the caller falls back to a key derived purely from the extraction.
 */
export function isKeyGrounded(key: string, extraction: Extraction): boolean {
	return isGroundedInTokens(key, extractionTokens(extraction));
}

/**
 * Is `key` GROUNDED in a raw `content` string (the DURABLE-fact grounding floor, 046b
 * b-AC-3 ported to facts)? A `memories` fact is ALREADY a distilled, curated truth, so
 * its own `content` is the grounding corpus — a durable key may invent no noun the fact
 * does not already assert. Same rule as {@link isKeyGrounded}, with the content tokens as
 * the corpus instead of an extraction's. Used to PROVE a derived durable key is honest.
 */
export function isKeyGroundedInText(key: string, content: string): boolean {
	return isGroundedInTokens(key, significantTokens(content));
}

/** Collapse to one line and cap at {@link MAX_KEY_CHARS} (a key is a headline). */
function oneLineKey(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= MAX_KEY_CHARS ? oneLine : `${oneLine.slice(0, MAX_KEY_CHARS)}…`;
}

/**
 * Derive a DETERMINISTIC fallback key PURELY from the extraction (b-AC-3). Used when the
 * gate omits a key OR emits one that fails the grounding guard. Prefers the
 * outcome-bearing facts (changes → decisions → blockers → goals → next), front-loading
 * the subsystem + outcome the way the good-key bar asks. Guaranteed grounded because it
 * is built only from extracted facts.
 */
export function deriveKeyFromExtraction(extraction: Extraction): string {
	const firstNonEmpty = (...lists: readonly string[][]): string => {
		for (const list of lists) {
			for (const item of list) {
				const trimmed = item.trim();
				if (trimmed !== "") return trimmed;
			}
		}
		return "";
	};
	const lead = firstNonEmpty(extraction.changes, extraction.decisions, extraction.blockers);
	const context = firstNonEmpty(extraction.goals, extraction.next);
	if (lead !== "" && context !== "" && significantTokens(context).size > 0) {
		return oneLineKey(`${context} — ${lead}`);
	}
	const single = lead !== "" ? lead : context;
	return single === "" ? "" : oneLineKey(single);
}

/**
 * Parse the structured gate response into a {@link GroundedSummary} (b-AC-2 / b-AC-3).
 *
 *   1. Extract the first balanced JSON object (tolerant of fences/preamble).
 *   2. Validate the shape with zod (the untrusted gate-output boundary) — a malformed
 *      body yields `null` (the worker treats it as an empty gate result).
 *   3. GROUND the key: if the gate's key is missing OR fails {@link isKeyGrounded},
 *      derive the key PURELY from the extraction so a confabulated noun can never reach
 *      `memory.key`. If even that is empty (no extraction), fall back to a trimmed
 *      single-line slice of the summary so the key is never blank.
 *
 * Returns `null` when there is no usable JSON OR the summary is empty (nothing to write).
 */
export function parseSummaryGate(raw: string): GroundedSummary | null {
	const json = extractJsonObject(raw);
	if (json === null) return null;
	let candidate: unknown;
	try {
		candidate = JSON.parse(json);
	} catch {
		return null;
	}
	const parsed = SummaryGateSchema.safeParse(candidate);
	if (!parsed.success) return null;

	const extraction = parsed.data.extraction;
	const summary = parsed.data.summary.trim();
	if (summary === "") return null; // no narrative → nothing to write (worker removes the placeholder).

	// GROUND the key (b-AC-3): accept the gate's key ONLY if it introduces no un-extracted
	// noun; otherwise derive it purely from the extraction. Never blank.
	const gateKey = oneLineKey(parsed.data.key);
	let key = gateKey !== "" && isKeyGrounded(gateKey, extraction) ? gateKey : deriveKeyFromExtraction(extraction);
	if (key === "") key = oneLineKey(summary.replace(/^#+\s*/gm, ""));

	return { summary, key, extraction };
}

// ════════════════════════════════════════════════════════════════════════════
// DURABLE-fact key — the deferred 046b durable-key generator (PRD-046).
//
// 046b sharpened the EPISODIC key (`memory.key`, derived inside the summary gate) but
// left the DURABLE-fact key (`memories.key`) unpopulated, so the prime fell back to the
// fact's `content`. This closes that gap. A `memories` fact is ALREADY a short, distilled,
// curated truth — so the durable key is derived DETERMINISTICALLY (no second LLM/gate
// round-trip): scrub secrets, take the first sentence, collapse + cap to a one-line
// headline. It is grounded BY CONSTRUCTION (a slice of the fact's own content invents no
// noun the content does not assert), and {@link isKeyGroundedInText} proves it.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Take the first sentence of a (single-line) body: everything up to the first sentence
 * terminator (`.`/`!`/`?` followed by whitespace or end), so a multi-sentence fact yields
 * just its headline clause. Falls back to the whole body when there is no terminator. The
 * terminator is dropped so the cap/one-line step owns the final shape.
 */
function firstSentence(text: string): string {
	const m = text.match(/^(.*?[.!?])(?:\s|$)/);
	const head = m ? m[1].replace(/[.!?]+$/, "") : text;
	return head.trim();
}

/**
 * Derive the DURABLE Tier-1 key for a `memories` fact (the deferred 046b durable-key
 * generator). DETERMINISTIC by design — a durable fact is already distilled, so a sharp
 * key is a cheap derivation, not a second gate pass:
 *
 *   1. {@link redactSecrets} — the SAME deterministic floor the summary worker uses, so no
 *      secret/PII can ever land in a durable key (the security pass relied on this floor
 *      for the prime). Applied FIRST, before any token sees the value.
 *   2. {@link firstSentence} — a fact's lead clause is its headline; the rest is detail.
 *   3. {@link oneLineKey} — collapse whitespace + cap at {@link MAX_KEY_CHARS}.
 *
 * The result is GROUNDED by construction: it is a redacted slice of the fact's own
 * `content`, so it can introduce no noun the content does not already assert
 * (provable via {@link isKeyGroundedInText}). Returns `""` when the content is blank or
 * collapses to nothing after redaction — the write path then leaves `key` empty and the
 * prime keeps its legacy `content` fallback for that (un-keyed) row.
 */
export function deriveDurableKey(content: string): string {
	if (typeof content !== "string") return "";
	const safe = redactSecrets(content);
	const oneLine = safe.replace(/\s+/g, " ").trim();
	if (oneLine === "") return "";
	return oneLineKey(firstSentence(oneLine));
}
