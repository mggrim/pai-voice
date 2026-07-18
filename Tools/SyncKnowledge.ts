#!/usr/bin/env bun
/**
 * SyncKnowledge.ts — snapshots Matthew's context (TELOS, second-brain digests,
 * skills inventory, PAI architecture) into the ElevenLabs knowledge base and
 * attaches the docs to the PAI Voice agent with RAG. Re-runnable: replaces
 * previously-synced docs (tracked in .kb-state.json). Requires ELEVENLABS_API_KEY.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME!;
const KEY = process.env.ELEVENLABS_API_KEY!;
const AGENT_ID = "agent_8501kxv2sfnkeq9s0r2kqtc2s906";
const STATE = join(HOME, "Projects", "PaiVoice", ".kb-state.json");
const API = "https://api.elevenlabs.io/v1/convai";
const H = { "xi-api-key": KEY, "Content-Type": "application/json" };

const CRED_PATTERN = /(api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,}/i;

function safeRead(p: string, cap = 40_000): string {
  try {
    let t = readFileSync(p, "utf8").slice(0, cap);
    if (CRED_PATTERN.test(t)) t = t.replace(new RegExp(CRED_PATTERN, "gi"), "[redacted]");
    return t;
  } catch (e) {
    return `[unreadable: ${p}: ${e}]`;
  }
}

function latest(dir: string, n: number): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, n).map(f => join(dir, f));
  } catch { return []; }
}

// --- compose docs ---
const telos = safeRead(join(HOME, ".claude/PAI/USER/TELOS/PRINCIPAL_TELOS.md"));
const memoryIndex = safeRead(join(HOME, ".claude/projects/-Users-mgrimes/memory/MEMORY.md"));
const doc1 = `# Matthew — life goals (TELOS) and current infrastructure state\n\n${telos}\n\n# Current PAI working memory index\n\n${memoryIndex}`;

const sb = join(HOME, ".second-brain");
const digestFiles = [...latest(join(sb, "digests/daily"), 2), ...latest(join(sb, "digests/weekly"), 1)];
const doc2 = `# Matthew's second brain — recent digests\n\n` +
  digestFiles.map(f => `## ${f.split("/").slice(-2).join("/")}\n\n${safeRead(f, 25_000)}`).join("\n\n");

const skillsDir = join(HOME, ".claude/skills");
const skills: string[] = [];
for (const d of readdirSync(skillsDir)) {
  const p = join(skillsDir, d, "SKILL.md");
  if (!existsSync(p)) continue;
  const m = readFileSync(p, "utf8").match(/^description:\s*(.+)$/m);
  skills.push(`- **${d}**: ${(m?.[1] ?? "").slice(0, 160)}`);
}
const arch = safeRead(join(HOME, ".claude/PAI/DOCUMENTATION/ARCHITECTURE_SUMMARY.md"), 12_000);
const doc3 = `# PAI — Matthew's Personal AI Infrastructure\n\n## What PAI can do (skills, ${skills.length} installed)\n\n${skills.join("\n")}\n\n## Architecture\n\n${arch}`;

// --- upload, replacing prior sync ---
const prior = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { ids: [] };
const docs = [
  { name: "matthew-telos-and-state", text: doc1 },
  { name: "second-brain-digests", text: doc2 },
  { name: "pai-skills-and-architecture", text: doc3 },
];

const uploaded: { type: string; id: string; name: string; usage_mode: string }[] = [];
for (const d of docs) {
  const r = await fetch(`${API}/knowledge-base/text`, { method: "POST", headers: H, body: JSON.stringify({ text: d.text, name: d.name }) });
  if (!r.ok) { console.error(`upload ${d.name}: ${r.status} ${await r.text()}`); process.exit(1); }
  const j = await r.json();
  uploaded.push({ type: "text", id: j.id, name: d.name, usage_mode: "auto" });
  console.log(`uploaded ${d.name} -> ${j.id} (${d.text.length} chars)`);
}

const patch = await fetch(`${API}/agents/${AGENT_ID}`, {
  method: "PATCH", headers: H,
  body: JSON.stringify({ conversation_config: { agent: { prompt: { knowledge_base: uploaded, rag: { enabled: true } } } } }),
});
console.log(`agent patch: ${patch.status}${patch.ok ? "" : " " + (await patch.text()).slice(0, 300)}`);
if (!patch.ok) process.exit(1);

for (const id of prior.ids ?? []) {
  const del = await fetch(`${API}/knowledge-base/${id}`, { method: "DELETE", headers: { "xi-api-key": KEY } });
  console.log(`deleted stale ${id}: ${del.status}`);
}
writeFileSync(STATE, JSON.stringify({ ids: uploaded.map(u => u.id), synced: new Date().toISOString() }, null, 2));
console.log("state saved");
