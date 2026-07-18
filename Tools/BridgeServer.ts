#!/usr/bin/env bun
/**
 * BridgeServer.ts — read-only live-tools endpoint for the PAI Voice agent.
 * Exposed publicly ONLY via Tailscale funnel (HTTPS); every request must carry
 * X-Bridge-Secret matching .bridge-secret. Endpoints return trimmed text
 * snippets sized for a voice conversation, never raw files.
 *
 * Retrieval is BM25-ranked with a recency boost over lazily-built in-memory
 * indexes (10-min TTL). rg is retained only to pre-filter conversation
 * transcripts to a candidate set before local scoring.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import type { Dirent } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME!;
const PORT = 31341;
const SECRET = readFileSync(join(HOME, "Projects", "PaiVoice", ".bridge-secret"), "utf8").trim();
const RG = "/opt/homebrew/bin/rg";
const MAX_SNIPPETS = 8;

// Corpora roots. SECOND_BRAIN and MEMORY_DIR are indexed with BM25; SECOND_BRAIN
// is a symlink — that's fine, we readdir the path as given so it's followed.
const SECOND_BRAIN = join(HOME, ".second-brain");
const MEMORY_DIR = join(HOME, ".claude", "projects", "-Users-mgrimes", "memory");

const INDEX_TTL_MS = 10 * 60 * 1000; // lazy rebuild every 10 minutes
const MAX_DOC_BYTES = 200 * 1024;    // skip files larger than 200KB
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ~30-word English stopword set; dropped during tokenization.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "is", "are", "was", "were", "be", "been", "it", "this", "that",
  "these", "those", "as", "by", "from", "not", "no", "do", "does",
]);

// --- Tokenization ---------------------------------------------------------
// lowercase, split on non-alphanumerics, drop tokens <2 chars and stopwords.
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// --- In-memory BM25 index -------------------------------------------------
interface Doc {
  path: string;        // absolute path
  mtimeMs: number;
  raw: string;         // full file text (for snippet extraction)
  tf: Map<string, number>;
  tokenCount: number;
}
interface IndexCache { docs: Doc[]; builtAt: number; }
const indexes = new Map<string, IndexCache>(); // keyed by root path

// Recursively collect *.md files under root (follows the root symlink because we
// readdir the path as given). Per-file try/catch so unreadable files —
// iCloud-evicted or TCC-tagged — are skipped silently. Skips files >200KB.
function walkMd(root: string): Doc[] {
  const docs: Doc[] = [];
  const visit = (dir: string) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      try {
        const st = statSync(p); // follows symlinks
        if (st.isDirectory()) { visit(p); continue; }
        if (!e.name.endsWith(".md")) continue;
        if (st.size > MAX_DOC_BYTES) continue;
        const raw = readFileSync(p, "utf8");
        const tokens = tokenize(raw);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        docs.push({ path: p, mtimeMs: st.mtimeMs, raw, tf, tokenCount: tokens.length });
      } catch { /* unreadable (evicted/TCC) — skip silently */ }
    }
  };
  visit(root);
  return docs;
}

// Get (or lazily rebuild) the index for a corpus root, honoring the TTL.
// Each corpus is built and cached independently, keyed on its root path.
function getIndex(root: string): Doc[] {
  const cached = indexes.get(root);
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached.docs;
  const docs = walkMd(root);
  indexes.set(root, { docs, builtAt: Date.now() });
  return docs;
}

// Standard BM25 (k1=1.5, b=0.75) with a corpus IDF, then a recency boost of
// 1 + exp(-ageDays/21). Returns the top-N docs paired with their score.
function bm25(query: string, docs: Doc[], topN: number): { doc: Doc; score: number }[] {
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || docs.length === 0) return [];
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.tokenCount, 0) / N || 1;

  // Document frequency + IDF per query term, computed over the corpus.
  const idf = new Map<string, number>();
  for (const t of qTerms) {
    let n = 0;
    for (const d of docs) if (d.tf.has(t)) n++;
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const now = Date.now();
  const scored: { doc: Doc; score: number }[] = [];
  for (const d of docs) {
    let s = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (d.tokenCount / avgdl));
      s += idf.get(t)! * (f * (BM25_K1 + 1)) / denom;
    }
    if (s <= 0) continue;
    const ageDays = (now - d.mtimeMs) / 86400_000;
    const recency = 1 + Math.exp(-ageDays / 21);
    scored.push({ doc: d, score: s * recency });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

// Build a snippet: ±1-line window around the first line containing the rarest
// matched query term, capped at 400 chars, prefixed with the ~-relative path
// and the file's YYYY-MM-DD mtime. Rarest = highest corpus IDF among matches.
function snippet(doc: Doc, query: string, idf: Map<string, number>): string {
  const matched = [...new Set(tokenize(query))].filter(t => doc.tf.has(t));
  const lines = doc.raw.split("\n");
  let rarest = matched[0];
  if (matched.length > 1) {
    rarest = matched.reduce((a, b) => ((idf.get(a) ?? 0) >= (idf.get(b) ?? 0) ? a : b));
  }
  let hit = 0;
  if (rarest) {
    for (let i = 0; i < lines.length; i++) {
      if (tokenize(lines[i]).includes(rarest)) { hit = i; break; }
    }
  }
  const lo = Math.max(0, hit - 1);
  const hi = Math.min(lines.length - 1, hit + 1);
  const window = lines.slice(lo, hi + 1).join(" ").replace(/\s+/g, " ").trim();
  const relPath = doc.path.replace(HOME, "~");
  const date = new Date(doc.mtimeMs).toISOString().slice(0, 10);
  return `${relPath} ${date}: ${window}`.slice(0, 400);
}

// Corpus-level IDF for the current query, reused by snippet() to find the
// rarest matched term. Kept alongside bm25() to avoid recomputing.
function queryIdf(query: string, docs: Doc[]): Map<string, number> {
  const idf = new Map<string, number>();
  const N = docs.length || 1;
  for (const t of [...new Set(tokenize(query))]) {
    let n = 0;
    for (const d of docs) if (d.tf.has(t)) n++;
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }
  return idf;
}

// BM25 over a single markdown corpus, returning formatted snippets.
function bm25Search(root: string, query: string, topN: number): string[] {
  const docs = getIndex(root);
  const idf = queryIdf(query, docs);
  return bm25(query, docs, topN).map(({ doc }) => snippet(doc, query, idf));
}

function searchSecondBrain(query: string): string[] {
  return bm25Search(SECOND_BRAIN, query, 8);
}

function searchMemory(query: string): string[] {
  // Two sources merged: (a) MemoryRetriever.ts stdout first, then (b) local
  // BM25 over MEMORY_DIR. Combined cap 8. Spawn failure/timeout falls back to (b).
  const out: string[] = [];
  try {
    const r = spawnSync(
      "/Users/mgrimes/.bun/bin/bun",
      ["/Users/mgrimes/.claude/PAI/TOOLS/MemoryRetriever.ts", query, "--raw", "--top", "4"],
      { encoding: "utf8", timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (r.status === 0 && r.stdout) {
      const banner = /^-{3,}|^Memory Retrieval:|^No matching|^Searched \d/;
      for (const line of r.stdout.split("\n").map(l => l.trim()).filter(l => l && !banner.test(l))) {
        out.push(line.replace(HOME, "~"));
      }
    }
  } catch { /* spawn failed/timed out — fall back to local index only */ }
  for (const s of bm25Search(MEMORY_DIR, query, 4)) out.push(s);
  return out.slice(0, MAX_SNIPPETS);
}

function searchConversations(query: string): string[] {
  // Recent session transcripts include Telegram-channel threads (DMs route into sessions).
  // rg pre-filters to candidate messages; ranking is done locally by distinct
  // query-token coverage times a per-transcript recency boost.
  const dir = join(HOME, ".claude", "projects", "-Users-mgrimes");
  const cutoff = Date.now() - 14 * 86400_000;
  let files: { path: string; mtimeMs: number }[] = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".jsonl"))
      .map(f => join(dir, f))
      .map(p => { try { const st = statSync(p); return { path: p, mtimeMs: st.mtimeMs }; } catch { return null; } })
      .filter((x): x is { path: string; mtimeMs: number } => x !== null && x.mtimeMs > cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest transcripts first
  } catch { return ["conversation store unreadable"]; }

  const qTokens = [...new Set(tokenize(query))];
  const now = Date.now();
  interface Cand { type: string; date: string; text: string; score: number; }
  const cands: Cand[] = [];
  const MAX_CANDIDATES = 40;

  for (const f of files) {
    if (cands.length >= MAX_CANDIDATES) break;
    // Alternation over tokens, not the raw phrase — voice queries are multi-word
    // and the exact phrase rarely appears verbatim in transcripts.
    // -m is generous because most transcript lines are tool/meta noise that
    // fails message extraction below — real text messages are the minority.
    const pattern = qTokens.length ? qTokens.join("|") : query;
    const r = spawnSync(RG, ["-i", "-m", "25", pattern, f.path], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    const ageDays = (now - f.mtimeMs) / 86400_000;
    const recency = 1 + Math.exp(-ageDays / 14);
    for (const line of (r.stdout || "").split("\n").filter(Boolean)) {
      if (cands.length >= MAX_CANDIDATES) break;
      try {
        const j = JSON.parse(line);
        const c = j?.message?.content;
        // Text blocks + Telegram reply tool calls: PAI's side of Hub thread
        // conversations goes out via mcp reply tools, not text blocks —
        // without this, half of every thread is invisible to search.
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? c.map((b: any) =>
              b.type === "text" ? b.text
              : b.type === "tool_use" && /telegram.*reply/i.test(b.name || "") ? `(PAI→Hub) ${b.input?.text ?? ""}`
              : "").filter(Boolean).join(" ")
          : "";
        if (!text) continue;
        const textTokens = new Set(tokenize(text));
        const present = qTokens.filter(t => textTokens.has(t)).length;
        if (present === 0) continue;
        cands.push({
          type: String(j.type),
          date: String(j.timestamp || "").slice(0, 10),
          text,
          score: present * recency,
        });
      } catch { /* non-message line */ }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, MAX_SNIPPETS).map(c => `[${c.type} ${c.date}] ${c.text.slice(0, 350)}`);
}

function getWeekContext(_q: string): string[] {
  // Recency-based, no query: latest pre-dawn prep digest (has the calendar table)
  // plus the two most recent daily digests. For "what am I doing / this week" asks.
  const out: string[] = [];
  const grab = (dir: string, n: number, cap: number) => {
    let files: string[] = [];
    try { files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse(); } catch { return; }
    let taken = 0;
    for (const f of files) {
      if (taken >= n) break;
      try {
        out.push(`=== ${f} ===\n${readFileSync(join(dir, f), "utf8").slice(0, cap)}`);
        taken++;
      } catch {
        // iCloud-evicted (EDEADLK) — ask iCloud to rehydrate for next time, take the next file
        spawnSync("/usr/bin/brctl", ["download", join(dir, f)], { timeout: 2000 });
      }
    }
  };
  grab(join(HOME, ".second-brain", "digests", "prep"), 1, 5000);
  grab(join(HOME, ".second-brain", "digests", "daily"), 2, 2500);
  return out;
}

const TOOLS: Record<string, (q: string) => string[]> = {
  search_second_brain: searchSecondBrain,
  search_memory: searchMemory,
  search_conversations: searchConversations,
  get_week_context: getWeekContext,
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.headers.get("x-bridge-secret") !== SECRET) return new Response("forbidden", { status: 403 });
    const name = url.pathname.replace("/tools/", "");
    const tool = TOOLS[name];
    if (!tool || req.method !== "POST") return new Response("not found", { status: 404 });
    let query = "";
    try { query = String((await req.json())?.query ?? "").slice(0, 200); } catch { /* empty */ }
    if (!query && name !== "get_week_context") return Response.json({ results: [], note: "empty query" });
    const t0 = Date.now();
    const results = tool(query);
    console.log(`${new Date().toISOString()} ${name} q="${query}" -> ${results.length} in ${Date.now() - t0}ms`);
    return Response.json({ results });
  },
});
console.log(`bridge listening on :${PORT}`);
