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
  { name: "search_conversations", description: "Search Matthew's recent PAI conversation history, including his Telegram threads with the bot, from the last two weeks. Use when he references something 'we discussed' or a recent chat. CHECK THIS FIRST for anything about his recent life or interactions." },
  { name: "get_week_context", description: "Get Matthew's current week at a glance: his latest pre-dawn briefing with today's calendar, plus recent daily digests. Takes no meaningful query (pass an empty string). ALWAYS use this for questions like 'what am I doing this week / today / tomorrow', schedule questions, or 'what's on my plate'." },
  {
    name: "get_journal_context",
    description: "Gather everything needed to facilitate Matthew's morning journal reflection on YESTERDAY: yesterday's briefing and digest, his previous journal entry, yesterday's PAI/Telegram conversations, and his life goals. Call this ONCE at the start of a journaling session. Takes no meaningful query.",
  },
  {
    name: "save_journal_entry",
    description: "Save the completed journal entry at the END of a journaling session. Synthesize the conversation into a written entry Matthew would want to reread — his observations, feelings, and any commitments — in his voice, not a transcript.",
    schema: {
      type: "object", required: ["title", "content"], description: "Journal entry",
      properties: {
        title: { type: "string", description: "Short evocative title for the entry" },
        content: { type: "string", description: "The full journal entry text in markdown, first person, as Matthew" },
        themes: { type: "string", description: "Comma-separated themes, e.g. 'family, teaching, research'" },
        mood: { type: "string", description: "One-word mood if Matthew expressed one" },
        date: { type: "string", description: "YYYY-MM-DD of the day being reflected on; omit for yesterday" },
      },
    },
  },
  {
    name: "save_to_second_brain",
    description: "Store an idea, decision, insight, or piece of information from this conversation into Matthew's second brain for later processing. Use whenever he says 'note that down', 'remember this', 'capture that', or when something clearly worth keeping emerges.",
    schema: {
      type: "object", required: ["title", "content"], description: "Note to capture",
      properties: {
        title: { type: "string", description: "Short descriptive title" },
        content: { type: "string", description: "The content worth keeping, with enough context to be useful later" },
      },
    },
  },
  {
    name: "dispatch_task",
    description: "Dispatch a task to Matthew's full PAI agent running on his machine — it can send emails, edit files, do research, manage his calendar and second brain, and will report back to him on Telegram. Use when Matthew asks for something DONE (not just discussed): 'have PAI draft...', 'get it to look into...', 'add X to my...'. Confirm the task wording with Matthew before dispatching.",
    schema: {
      type: "object", required: ["task"], description: "Task dispatch",
      properties: {
        task: { type: "string", description: "Complete, self-contained task instruction with all context PAI needs — it cannot ask the voice call follow-up questions" },
      },
    },
  },
];

const QUERY_SCHEMA = {
  type: "object",
  required: ["query"],
  description: "Search request",
  properties: { query: { type: "string", description: "Short keyword query — one to three words work best" } },
};

function toolConfig(d: { name: string; description: string; schema?: object }) {
  return {
    tool_config: {
      type: "webhook",
      name: d.name,
      description: d.description,
      response_timeout_secs: 10,
      api_schema: {
        url: `${BASE}/tools/${d.name}`,
        method: "POST",
        request_headers: { "X-Bridge-Secret": SECRET },
        request_body_schema: d.schema ?? QUERY_SCHEMA,
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
