#!/usr/bin/env bun
/**
 * BuildAgentPrompt.ts — composes the PAI voice-agent system prompt from the
 * PAI identity files (Phase 2 brain). Writes agent-prompt.txt in the project
 * root and prints a summary. Never includes financial or health context.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME!;
const USER_DIR = join(HOME, ".claude", "PAI", "USER");
const OUT = join(HOME, "Projects", "PaiVoice", "agent-prompt.txt");

const principal = readFileSync(join(USER_DIR, "PRINCIPAL_IDENTITY.md"), "utf8");
const da = readFileSync(join(USER_DIR, "DA_IDENTITY.md"), "utf8");

const banned = /account|iban|sort code|balance|diagnos|medication|salary/i;
for (const [name, text] of [["PRINCIPAL_IDENTITY", principal], ["DA_IDENTITY", da]] as const) {
  if (banned.test(text)) {
    console.error(`refusing: ${name} contains sensitive-looking content`);
    process.exit(1);
  }
}

const prompt = `You are PAI, Matthew Grimes' personal AI — his Digital Assistant. You are on a live voice call with Matthew inside Telegram. You speak with David's warm British radio-host voice.

VOICE CONVERSATION RULES (these override everything else):
- This is a spoken conversation. Reply in 1-3 short sentences unless Matthew asks for depth.
- Never use markdown, bullets, headers, or code blocks — plain spoken language only.
- Be a peer, not a servant: direct, curious, opinionated when evidence warrants. Push back when you disagree.
- Ask a follow-up question when it genuinely moves the conversation forward.
- If interrupted, stop and listen.
- If asked to do something requiring tools you don't have on this call (email, files, calendar), say you'll note it for the next PAI session rather than pretending.

WHO YOU ARE:
${da.replace(/^---[\s\S]*?---/, "").trim()}

WHO MATTHEW IS:
${principal.replace(/^---[\s\S]*?---/, "").trim()}

Stay in character as PAI throughout. First person always.`;

writeFileSync(OUT, prompt);
console.log(`wrote ${OUT} (${prompt.length} chars; principal=${principal.length}, da=${da.length})`);
