---
project: PaiVoice
task: Live full-duplex voice conversations with PAI inside Telegram via Mini App
effort: E3
phase: observe
progress: 0/33
mode: build
started: 2026-07-18T17:00:00Z
updated: 2026-07-18T17:00:00Z
---

# PaiVoice — ISA

## Problem

Matthew's Telegram agent can only exchange text and pre-recorded voice notes — a press-play experience, not a conversation. ElevenLabs credits are available and unused for this. The Telegram Bot API cannot do live VOIP, so live voice must ride a Mini App + WebRTC, which nothing in PAI currently provides.

## Vision

Matthew taps a button in his existing Telegram bot chat, the Mini App opens, and within two seconds he is *talking* with PAI — interrupting it mid-sentence, hands-free, in David's voice — and it knows who he is and what he cares about. It feels like a phone call with his DA, not a demo.

## Out of Scope

Twilio/PSTN telephony (separate future project). Group-chat voice. Multi-user support — this is Matthew-only. Native iOS/Android apps. A full tool-calling PAI bridge over public ingress (Tailscale funnel) — evaluated this run, deferred if not already configured. Voice-note fallback flows.

## Constraints

- bun/TypeScript only for tooling; no npm/npx, no Python.
- Mini App page is pure static HTML/JS — no build step, SDK via CDN ESM.
- `ELEVENLABS_API_KEY` never ships to the client or the repo; agent is public-mode with origin allowlist + abuse caps instead of a token server (no Cloudflare auth available on this machine).
- Hosting = GitHub Pages via authenticated `gh` (only free HTTPS host available today).
- Telegram messages go only to Matthew's `TELEGRAM_CHAT_ID` from `daemon/config.sh`.
- Agent voice = DA main voice `5gLuKtB16QIQv1vuSas1` (David).

## Goal

A live ElevenLabs Conversational AI agent carrying PAI's identity is reachable through a Telegram Mini App button in Matthew's existing bot chat, over WebRTC, hosted on GitHub Pages, with the API key never exposed and abuse caps configured — verified by API reads, HTTPS probes, and Telegram API responses.

## Criteria

### F1 — ElevenLabs agent
- [ ] ISC-1: GET agent by id returns 200; agent_id recorded in this ISA
- [ ] ISC-2: Agent voice_id is `5gLuKtB16QIQv1vuSas1` (API read)
- [ ] ISC-3: Agent LLM is a Claude-family model (API read)
- [ ] ISC-4: Agent system prompt contains PAI persona and Matthew context (API read contains "Matthew")
- [ ] ISC-5: Agent has a non-empty first_message (API read)
- [ ] ISC-6: Agent auth/allowlist restricts origins to the Pages host (API read)
- [ ] ISC-7: Client overrides of system prompt disabled (API read)
- [ ] ISC-8: Call-duration cap ≤ 1800s set on agent (API read)

### F2 — Mini App page
- [ ] ISC-9: GitHub repo exists and is reachable via `gh repo view`
- [ ] ISC-10: `index.html` imports `@elevenlabs/client` from CDN (grep)
- [ ] ISC-11: Page includes `telegram-web-app.js` script (grep)
- [ ] ISC-12: Page has start/end call controls and status element (grep)
- [ ] ISC-13: `startSession` called with `connectionType: 'webrtc'` (grep)
- [ ] ISC-14: Page gates start on Telegram user id matching Matthew's id (grep)
- [ ] ISC-15: Anti: `ELEVENLABS_API_KEY` value absent from repo and served page (grep)
- [ ] ISC-16: Anti: no package.json/node_modules — zero build step (ls)

### F3 — Hosting
- [ ] ISC-17: Pages URL returns HTTP 200 over HTTPS (curl -i)
- [ ] ISC-18: Served page contains the agent id (curl | grep)
- [ ] ISC-19: README.md documents architecture, URLs, and relaunch steps (Read)
- [ ] ISC-20: Repo has initial commit; ISA.md committed (git log, git ls-files)
- [ ] ISC-21: .gitignore excludes .env and secrets (grep)
- [ ] ISC-22: Anti: no hardcoded `/Users/mgrimes` paths in committed scripts (grep)

### F4 — Telegram wiring
- [ ] ISC-23: Bot token valid — getMe returns ok:true (curl)
- [ ] ISC-24: web_app inline-button message delivered to Matthew's chat — sendMessage ok:true (curl)
- [ ] ISC-25: Chat menu button set to open the Mini App — setChatMenuButton ok:true (curl)
- [ ] ISC-26: Anti: no Telegram API call targets a chat other than TELEGRAM_CHAT_ID (transcript review)

### F5 — PAI brain (Phase 2)
- [ ] ISC-27: `Tools/BuildAgentPrompt.ts` exists and `bun run` exits 0 (Bash)
- [ ] ISC-28: Generated prompt draws on PRINCIPAL_IDENTITY + DA_IDENTITY content (grep output)
- [ ] ISC-29: Agent prompt updated via API; read-back reflects PAI persona (API read)
- [ ] ISC-30: Custom-LLM ingress decision (Tailscale funnel available or deferred with follow-up) recorded in Decisions
- [ ] ISC-31: Anti: no private financial/health file contents included in the uploaded prompt (grep output)

### Experience
- [ ] ISC-32: Antecedent: button's web_app URL is HTTPS and returns 200 (curl) — precondition for in-Telegram open
- [ ] ISC-33: Live mic-to-voice round-trip inside Telegram confirmed by Matthew — [DEFERRED-VERIFY: requires his tap; follow-up task PaiVoice-T1]

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| 1-8 | API | GET /v1/convai/agents/{id} fields | exact match | curl |
| 9-16 | static | repo/file content | pattern present/absent | gh, rg, ls |
| 17-18 | live | HTTPS probe of Pages URL | 200 + agent id | curl |
| 19-22 | repo | files and history | present | Read, git |
| 23-26 | API | Telegram Bot API responses | ok:true | curl |
| 27-31 | build | prompt generator run + agent read-back | exit 0, content match | bun, curl |
| 32 | live | HTTPS probe | 200 | curl |
| 33 | human | Matthew's live call | works | deferred |

## Features

| name | description | satisfies | depends_on | parallelizable |
|------|-------------|-----------|------------|----------------|
| elevenlabs-agent | Create + configure agent via API | ISC-1..8 | — | yes |
| miniapp-page | Static WebRTC voice page (Engineer) | ISC-9..16 | — | yes |
| hosting-pages | GitHub repo + Pages deploy | ISC-17..22 | miniapp-page | no |
| telegram-wiring | Bot button + menu button | ISC-23..26 | hosting-pages | no |
| pai-brain-prompt | Phase 2: PAI persona prompt generator + upload | ISC-27..31 | elevenlabs-agent | yes |

## Decisions

- 2026-07-18: Classifier returned E1 on "yes scaffold and execute"; context-override to E3 — approval of a proposed multi-file build (doctrine §effort step 3).
- 2026-07-18: Public-agent-with-allowlist over token server: no wrangler/cloudflared auth on machine; GitHub Pages is static-only. Mitigations: origin allowlist, overrides off, duration cap, client-side user-id gate. Upgrade path documented in README.
- 2026-07-18: Delegation floor 1/2 — show-your-math: remaining work is credential-bound sequential API calls; a second agent would need secret access and adds leak surface for zero parallelism gain.
