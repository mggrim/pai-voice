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
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import type { Dirent } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME!;
const PORT = Number(process.env.PORT_OVERRIDE) || 31341;
const SECRET = readFileSync(join(HOME, "Projects", "PaiVoice", ".bridge-secret"), "utf8").trim();
const RG = "/opt/homebrew/bin/rg";
const MAX_SNIPPETS = 8;

// Corpora roots. SECOND_BRAIN and MEMORY_DIR are indexed with BM25; SECOND_BRAIN
// is a symlink — that's fine, we readdir the path as given so it's followed.
// SB is the write-side root (journal, inbox); overridable via PAI_SB_ROOT so
// endpoint tests can point at a throwaway /tmp dir and never touch the real vault.
const SB = process.env.PAI_SB_ROOT || join(HOME, ".second-brain");
const SECOND_BRAIN = SB;
const MEMORY_DIR = join(HOME, ".claude", "projects", "-Users-mgrimes", "memory");

// Scheduler injection. PROMPTS_ROOT is where prompt files land; SEND_PROMPT is the
// injector script. Both overridable so dispatch/webhook tests don't inject into the
// live Channels session (point SEND_PROMPT at /bin/true, PROMPTS_ROOT at /tmp).
const PROMPTS_ROOT = process.env.PAI_PROMPTS_ROOT ||
  join(HOME, ".claude", "channels", "scheduler", "prompts");
const SEND_PROMPT = process.env.PAI_SEND_PROMPT ||
  join(HOME, ".claude", "channels", "scheduler", "send-prompt.sh");

// --- Shared helpers -------------------------------------------------------
// Local-time yesterday as YYYY-MM-DD.
function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Local-time today as YYYY-MM-DD.
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// lowercase, non-alphanumerics → dash, trim/collapse dashes, max 40 chars.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}
// Newest .md filename in a dir (by mtime), or null. Non-recursive.
function newestMd(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md"))
      .map(f => { try { return { f, m: statSync(join(dir, f)).mtimeMs }; } catch { return null; } })
      .filter((x): x is { f: string; m: number } => x !== null)
      .sort((a, b) => b.m - a.m);
    return files.length ? files[0].f : null;
  } catch { return null; }
}
// Recursively collect all .md files under root, each with mtime. Per-entry
// try/catch so evicted/TCC-tagged files are skipped silently.
function walkMdPaths(root: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  const visit = (dir: string) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) { visit(p); continue; }
        if (e.name.endsWith(".md")) out.push({ path: p, mtimeMs: st.mtimeMs });
      } catch { /* skip */ }
    }
  };
  visit(root);
  return out;
}
// Fire-and-forget prompt injection: spawn send-prompt.sh detached and unref so we
// return to the caller immediately (10s voice timeout; the script retries ~6min).
function injectPrompt(promptFile: string, label: string): void {
  const child = Bun.spawn(["/bin/bash", SEND_PROMPT, promptFile, label], {
    stdout: "ignore", stderr: "ignore", stdin: "ignore",
  });
  child.unref();
}

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

// --- Journal context ------------------------------------------------------
// No query. Assembles four sections for an evening journaling voice session:
// yesterday's digests, the most recent journal entry (for continuity),
// yesterday's conversations, and the active TELOS goals.
function getJournalContext(_q: string): string[] {
  const results: string[] = [];
  const D = yesterdayISO();

  // (a) Yesterday's prep + daily digests, 3000-char cap each. Missing → newest.
  for (const kind of ["prep", "daily"] as const) {
    const dir = join(SB, "digests", kind);
    const target = join(dir, `${D}.md`);
    try {
      results.push(`=== ${kind} digest ${D} ===\n${readFileSync(target, "utf8").slice(0, 3000)}`);
    } catch {
      const latest = newestMd(dir);
      if (latest) {
        try {
          results.push(`=== ${kind} digest (latest available: ${latest}) ===\n${readFileSync(join(dir, latest), "utf8").slice(0, 3000)}`);
        } catch { /* skip */ }
      }
    }
  }

  // (b) Most recent journal entry (recursing into year/month subdirs), 2000-char cap.
  try {
    const entries = walkMdPaths(join(SB, "journal", "entries")).sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (entries.length) {
      const e = entries[0];
      results.push(`=== previous journal entry ${e.path.split("/").pop()} ===\n${readFileSync(e.path, "utf8").slice(0, 2000)}`);
    }
  } catch { /* skip */ }

  // (c) Yesterday's conversations from session transcripts (last 3 days of files).
  try {
    const dir = join(HOME, ".claude", "projects", "-Users-mgrimes");
    const cutoff = Date.now() - 3 * 86400_000;
    let files: { path: string; mtimeMs: number }[] = [];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".jsonl"))
        .map(f => join(dir, f))
        .map(p => { try { const st = statSync(p); return { path: p, mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; } })
        .filter((x): x is { path: string; mtimeMs: number; size: number } => x !== null && x.mtimeMs > cutoff && x.size <= 20 * 1024 * 1024);
    } catch { files = []; }

    const turns: string[] = [];
    for (const f of files) {
      let raw = "";
      try { raw = readFileSync(f.path, "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        const ts = String(j.timestamp || "");
        if (!ts.startsWith(D)) continue;
        const c = j?.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? c.map((b: any) =>
              b.type === "text" ? b.text
              : b.type === "tool_use" && /telegram.*reply/i.test(b.name || "") ? `(PAI→Hub) ${b.input?.text ?? ""}`
              : "").filter(Boolean).join(" ")
          : "";
        if (!text) continue;
        const hhmm = ts.slice(11, 16);
        turns.push(`[${String(j.type)} ${hhmm}] ${text.slice(0, 220)}`);
      }
    }
    if (turns.length) {
      results.push(`=== yesterday's conversations (${D}) ===\n${turns.slice(-12).join("\n")}`);
    }
  } catch { /* skip conversations entirely on any failure */ }

  // (d) TELOS active goals section only.
  try {
    const telos = readFileSync(join(HOME, ".claude", "PAI", "USER", "TELOS", "PRINCIPAL_TELOS.md"), "utf8");
    const lines = telos.split("\n");
    const start = lines.findIndex(l => l.startsWith("## Active Goals"));
    if (start >= 0) {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith("## ")) { end = i; break; }
      }
      results.push(`=== TELOS goals ===\n${lines.slice(start, end).join("\n").trim()}`);
    }
  } catch { /* skip */ }

  return results;
}

// --- Save journal entry ---------------------------------------------------
// Writes a house-convention journal entry. Never overwrites: if the date file
// exists, writes <date>-voice.md instead.
function saveJournalEntry(body: any): string[] {
  const title = String(body?.title ?? "").trim();
  const content = String(body?.content ?? "");
  const themesRaw = String(body?.themes ?? "").trim();
  const mood = String(body?.mood ?? "").trim();
  const dateArg = String(body?.date ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : yesterdayISO();

  const dir = join(SB, "journal", "entries");
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${date}.md`);
  if (existsSync(path)) path = join(dir, `${date}-voice.md`);

  const themes = themesRaw ? themesRaw.split(",").map(t => t.trim()).filter(Boolean) : [];
  const themesBlock = themes.length ? `themes:\n${themes.map(t => `  - ${t}`).join("\n")}\n` : "";
  const fm = `---\ndate: ${date}\ntitle: "${title.replace(/"/g, "'")}"\npeople: []\nlocations: []\n${themesBlock}mood: ${mood || "~"}\nsource: voice\n---\n\n${content}\n`;
  writeFileSync(path, fm, "utf8");
  return [`saved ${path}`];
}

// --- Save to second brain inbox -------------------------------------------
function saveToSecondBrain(body: any): string[] {
  const title = String(body?.title ?? "").trim();
  const content = String(body?.content ?? "");
  const dir = join(SB, "inbox");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${todayISO()}-voice-${slugify(title)}.md`);
  const doc = `# ${title}\n\n**Source:** PAI voice call — ${new Date().toISOString()}\n\n${content}`;
  writeFileSync(path, doc, "utf8");
  return [`saved ${path}`];
}

// --- Dispatch a task to the live PAI session ------------------------------
function dispatchTask(body: any): string[] {
  const task = String(body?.task ?? "").trim();
  mkdirSync(PROMPTS_ROOT, { recursive: true });
  const promptFile = join(PROMPTS_ROOT, `voice-dispatch-${Date.now()}.txt`);
  const prompt = `Matthew asked for this via a PAI voice call just now:\n\n${task}\n\nExecute it now with full PAI capabilities. When finished, report the outcome to Matthew on Telegram (the channel session's normal reply path).`;
  writeFileSync(promptFile, prompt, "utf8");
  injectPrompt(promptFile, "voice-dispatch");
  return ["dispatched to PAI — it will report back on Telegram"];
}

// Read-only, query-taking BM25 tools (existing) plus get_journal_context, which
// ignores its query arg and returns the assembled journaling context.
const TOOLS: Record<string, (q: string) => string[]> = {
  search_second_brain: searchSecondBrain,
  search_memory: searchMemory,
  search_conversations: searchConversations,
  get_week_context: getWeekContext,
  get_journal_context: getJournalContext,
};

// Body-taking (write/action) tools — these read the parsed JSON body, not a query
// string, so they're routed separately in the fetch handler below.
const BODY_TOOLS: Record<string, (body: any) => string[]> = {
  save_journal_entry: saveJournalEntry,
  save_to_second_brain: saveToSecondBrain,
  dispatch_task: dispatchTask,
};

// --- Webhook token --------------------------------------------------------
// ElevenLabs post-call webhook is NOT bridge-secret gated (their servers can't
// send our header), so the URL path itself carries a 32-hex-char secret token.
// Read the existing token or mint one (mode 600) at startup.
function loadWebhookToken(): string {
  const tokenPath = join(HOME, "Projects", "PaiVoice", ".webhook-token");
  try {
    const t = readFileSync(tokenPath, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch { /* not present / unreadable — mint below */ }
  const token = randomBytes(16).toString("hex");
  try { writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 }); }
  catch { writeFileSync(tokenPath, token, "utf8"); }
  return token;
}
const WEBHOOK_TOKEN = loadWebhookToken();

// Process an ElevenLabs post-call payload: persist the transcript to the inbox
// and, for substantive calls, queue a processing prompt for the live session.
function handlePostCall(payload: any): void {
  const data = payload?.data ?? {};
  const turns: { role: string; message: string }[] = Array.isArray(data.transcript)
    ? data.transcript.filter((t: any) => t && t.message != null)
        .map((t: any) => ({ role: String(t.role ?? "unknown"), message: String(t.message) }))
    : [];

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const dir = join(SB, "inbox");
  mkdirSync(dir, { recursive: true });
  const transcriptPath = join(dir, `voice-call-${stamp}.md`);
  const doc = `# Voice call transcript — ${now.toISOString()}\n\n**Conversation:** ${data.conversation_id ?? ""}\n\n`
    + turns.map(t => `**${t.role}:** ${t.message}`).join("\n");
  writeFileSync(transcriptPath, doc, "utf8");

  if (turns.length >= 6) {
    mkdirSync(PROMPTS_ROOT, { recursive: true });
    const promptFile = join(PROMPTS_ROOT, `voice-process-${Date.now()}.txt`);
    const prompt = `A PAI voice call just ended. Transcript saved at ${transcriptPath}. Read it and: extract any action items or commitments into the second brain inbox as separate notes; capture durable knowledge worth keeping; if the conversation was a journaling session, verify a journal entry exists in ~/.second-brain/journal/entries/ for the day discussed and create it from the transcript if missing. Keep Telegram notification to one short summary message.`;
    writeFileSync(promptFile, prompt, "utf8");
    injectPrompt(promptFile, "voice-process");
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");

    // Post-call webhook — token-in-path auth, NOT bridge-secret gated.
    if (url.pathname.startsWith("/webhooks/post-call/")) {
      if (url.pathname !== `/webhooks/post-call/${WEBHOOK_TOKEN}` || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      let payload: any = {};
      try { payload = await req.json(); } catch { /* keep empty */ }
      const turnCount = Array.isArray(payload?.data?.transcript)
        ? payload.data.transcript.filter((t: any) => t && t.message != null).length : 0;
      try { handlePostCall(payload); } catch (e) { console.log(`${new Date().toISOString()} post-call ERROR ${e}`); }
      console.log(`${new Date().toISOString()} webhook post-call conv="${payload?.data?.conversation_id ?? ""}" turns=${turnCount}`);
      return Response.json({ ok: true });
    }

    if (req.headers.get("x-bridge-secret") !== SECRET) return new Response("forbidden", { status: 403 });
    const name = url.pathname.replace("/tools/", "");
    if (req.method !== "POST") return new Response("not found", { status: 404 });

    // Body-taking action tools (journal save, second-brain capture, dispatch).
    const bodyTool = BODY_TOOLS[name];
    if (bodyTool) {
      let body: any = {};
      try { body = (await req.json()) ?? {}; } catch { /* empty body */ }
      const t0 = Date.now();
      const results = bodyTool(body);
      console.log(`${new Date().toISOString()} ${name} -> ${results.length} in ${Date.now() - t0}ms`);
      return Response.json({ results });
    }

    const tool = TOOLS[name];
    if (!tool) return new Response("not found", { status: 404 });
    let query = "";
    try { query = String((await req.json())?.query ?? "").slice(0, 200); } catch { /* empty */ }
    if (!query && name !== "get_week_context" && name !== "get_journal_context") {
      return Response.json({ results: [], note: "empty query" });
    }
    const t0 = Date.now();
    const results = tool(query);
    console.log(`${new Date().toISOString()} ${name} q="${query}" -> ${results.length} in ${Date.now() - t0}ms`);
    return Response.json({ results });
  },
});
console.log(`bridge listening on :${PORT}`);
