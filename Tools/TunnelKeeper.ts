#!/usr/bin/env bun
/**
 * TunnelKeeper.ts — runs a cloudflared quick tunnel to the bridge and keeps the
 * ElevenLabs webhook tool URLs pointed at it. On start (and whenever cloudflared
 * restarts with a new trycloudflare.com URL) it PATCHes every tool id in
 * .tools-state.json to the fresh URL and records it in .tunnel-url.
 * Run under launchd with KeepAlive. Requires ELEVENLABS_API_KEY.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const HOME = process.env.HOME!;
const ROOT = join(HOME, "Projects", "PaiVoice");
const KEY = process.env.ELEVENLABS_API_KEY!;
const TOOLS_STATE = join(ROOT, ".tools-state.json");
const URL_FILE = join(ROOT, ".tunnel-url");
const API = "https://api.elevenlabs.io/v1/convai";
const H = { "xi-api-key": KEY, "Content-Type": "application/json" };

async function repoint(base: string) {
  if (!existsSync(TOOLS_STATE)) { console.log("no tools registered yet; recorded URL only"); }
  else {
    const { ids } = JSON.parse(readFileSync(TOOLS_STATE, "utf8"));
    for (const id of ids ?? []) {
      const get = await fetch(`${API}/tools/${id}`, { headers: { "xi-api-key": KEY } });
      if (!get.ok) { console.error(`get ${id}: ${get.status}`); continue; }
      const cfg = (await get.json()).tool_config;
      cfg.api_schema.url = `${base}/tools/${cfg.name}`;
      const patch = await fetch(`${API}/tools/${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ tool_config: cfg }) });
      console.log(`repoint ${cfg.name} -> ${base}: ${patch.status}`);
    }
  }
  // Post-call webhook URL must track the tunnel too.
  const WEBHOOK_STATE = join(ROOT, ".webhook-state.json");
  const TOKEN_FILE = join(ROOT, ".webhook-token");
  if (existsSync(WEBHOOK_STATE) && existsSync(TOKEN_FILE)) {
    const { webhook_id } = JSON.parse(readFileSync(WEBHOOK_STATE, "utf8"));
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    const patch = await fetch(`https://api.elevenlabs.io/v1/workspace/webhooks/${webhook_id}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({
        name: "pai-voice-post-call", is_disabled: false,
        settings: { name: "pai-voice-post-call", webhook_url: `${base}/webhooks/post-call/${token}`, auth_type: "hmac" },
      }),
    });
    console.log(`repoint post-call webhook -> ${base}: ${patch.status}`);
  }
}

const proc = spawn("/opt/homebrew/bin/cloudflared", ["tunnel", "--url", "http://localhost:31341", "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
let announced = false;

async function onChunk(chunk: Buffer) {
  const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !announced) {
    announced = true;
    const url = m[0];
    const prev = existsSync(URL_FILE) ? readFileSync(URL_FILE, "utf8").trim() : "";
    console.log(`tunnel up: ${url}${prev === url ? " (unchanged)" : ""}`);
    writeFileSync(URL_FILE, url);
    if (prev !== url) await repoint(url);
  }
}
proc.stdout.on("data", onChunk);
proc.stderr.on("data", onChunk);
proc.on("exit", code => { console.log(`cloudflared exited ${code}`); process.exit(code ?? 1); });
