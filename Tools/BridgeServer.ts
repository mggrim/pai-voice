#!/usr/bin/env bun
/**
 * BridgeServer.ts — read-only live-tools endpoint for the PAI Voice agent.
 * Exposed publicly ONLY via Tailscale funnel (HTTPS); every request must carry
 * X-Bridge-Secret matching .bridge-secret. Endpoints return trimmed text
 * snippets sized for a voice conversation, never raw files.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME!;
const PORT = 31341;
const SECRET = readFileSync(join(HOME, "Projects", "PaiVoice", ".bridge-secret"), "utf8").trim();
const RG = "/opt/homebrew/bin/rg";
const MAX_SNIPPETS = 8;

function rgSearch(query: string, paths: string[], extra: string[] = []): string[] {
  const r = spawnSync(RG, ["-i", "--no-heading", "-m", "3", "-g", "!*.oga", ...extra, query, ...paths], {
    encoding: "utf8", timeout: 8000, maxBuffer: 4 * 1024 * 1024,
  });
  return (r.stdout || "").split("\n").filter(Boolean).slice(0, MAX_SNIPPETS)
    .map(l => l.replace(HOME, "~").slice(0, 400));
}

function searchConversations(query: string): string[] {
  // Recent session transcripts include Telegram-channel threads (DMs route into sessions).
  const dir = join(HOME, ".claude", "projects", "-Users-mgrimes");
  const cutoff = Date.now() - 14 * 86400_000;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".jsonl"))
      .map(f => join(dir, f)).filter(p => { try { return statSync(p).mtimeMs > cutoff; } catch { return false; } });
  } catch { return ["conversation store unreadable"]; }
  const out: string[] = [];
  for (const f of files) {
    if (out.length >= MAX_SNIPPETS) break;
    const r = spawnSync(RG, ["-i", "-m", "2", query, f], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of (r.stdout || "").split("\n").filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        const c = j?.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
        if (text && text.toLowerCase().includes(query.toLowerCase()))
          out.push(`[${j.type} ${String(j.timestamp || "").slice(0, 10)}] ${text.slice(0, 350)}`);
      } catch { /* non-message line */ }
      if (out.length >= MAX_SNIPPETS) break;
    }
  }
  return out;
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
  search_second_brain: q => rgSearch(q, [join(HOME, ".second-brain")], ["-g", "!*.log"]),
  search_memory: q => rgSearch(q, [
    join(HOME, ".claude", "PAI", "MEMORY", "KNOWLEDGE"),
    join(HOME, ".claude", "projects", "-Users-mgrimes", "memory"),
  ]),
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
