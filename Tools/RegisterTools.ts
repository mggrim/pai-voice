#!/usr/bin/env bun
/**
 * RegisterTools.ts — creates the three bridge webhook tools in ElevenLabs and
 * attaches them to the PAI Voice agent via prompt.tool_ids. Re-runnable:
 * replaces tools tracked in .tools-state.json. Requires ELEVENLABS_API_KEY.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME!;
const KEY = process.env.ELEVENLABS_API_KEY!;
const AGENT_ID = "agent_8501kxv2sfnkeq9s0r2kqtc2s906";
const BASE = readFileSync(join(HOME, "Projects", "PaiVoice", ".tunnel-url"), "utf8").trim();
const SECRET = readFileSync(join(HOME, "Projects", "PaiVoice", ".bridge-secret"), "utf8").trim();
const STATE = join(HOME, "Projects", "PaiVoice", ".tools-state.json");
const API = "https://api.elevenlabs.io/v1/convai";
const H = { "xi-api-key": KEY, "Content-Type": "application/json" };

const defs = [
  { name: "search_second_brain", description: "Search Matthew's second brain (notes, ideas, execution queue, journal, digests) for a topic. Use when he asks about his notes, tasks, ideas, or anything he may have captured." },
  { name: "search_memory", description: "Search PAI's long-term knowledge and working memory about people, projects, and past decisions. Use for questions about what PAI knows or remembers." },
  { name: "search_conversations", description: "Search Matthew's recent PAI conversation history, including his Telegram threads with the bot, from the last two weeks. Use when he references something 'we discussed' or a recent chat." },
];

function toolConfig(d: { name: string; description: string }) {
  return {
    tool_config: {
      type: "webhook",
      name: d.name,
      description: d.description,
      response_timeout_secs: 10,
      api_schema: {
        url: `${BASE}/tools/${d.name}`,
        method: "POST",
        request_headers: [{ type: "value", name: "X-Bridge-Secret", value: SECRET }],
        request_body_schema: {
          type: "object",
          required: ["query"],
          description: "Search request",
          properties: { query: { type: "string", description: "Short keyword query — one to three words work best" } },
        },
      },
    },
  };
}

const ids: string[] = [];
for (const d of defs) {
  const r = await fetch(`${API}/tools`, { method: "POST", headers: H, body: JSON.stringify(toolConfig(d)) });
  const body = await r.text();
  if (!r.ok) { console.error(`create ${d.name}: ${r.status} ${body.slice(0, 500)}`); process.exit(1); }
  const id = JSON.parse(body).id;
  ids.push(id);
  console.log(`tool ${d.name} -> ${id}`);
}

const patch = await fetch(`${API}/agents/${AGENT_ID}`, {
  method: "PATCH", headers: H,
  body: JSON.stringify({ conversation_config: { agent: { prompt: { tool_ids: ids } } } }),
});
console.log(`agent patch: ${patch.status}${patch.ok ? "" : " " + (await patch.text()).slice(0, 300)}`);
if (!patch.ok) process.exit(1);

const prior = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { ids: [] };
for (const id of prior.ids ?? []) {
  const del = await fetch(`${API}/tools/${id}`, { method: "DELETE", headers: { "xi-api-key": KEY } });
  console.log(`deleted stale tool ${id}: ${del.status}`);
}
writeFileSync(STATE, JSON.stringify({ ids, synced: new Date().toISOString() }, null, 2));
console.log("state saved");
