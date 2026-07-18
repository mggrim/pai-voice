---
project: PaiVoice
task: Live full-duplex voice conversations with PAI inside Telegram via Mini App
effort: E3
phase: complete
progress: 67/71
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
- [x] ISC-1: GET agent by id returns 200; agent_id `agent_8501kxv2sfnkeq9s0r2kqtc2s906`
- [x] ISC-2: Agent voice_id is `5gLuKtB16QIQv1vuSas1` (API read)
- [x] ISC-3: Agent LLM is a Claude-family model (API read: claude-sonnet-4-6)
- [x] ISC-4: Agent system prompt contains PAI persona and Matthew context (API read contains "Matthew")
- [x] ISC-5: Agent has a non-empty first_message (API read)
- [x] ISC-6: Agent allowlist restricts origins where enforceable (API read: mggrim.github.io; require_origin_header false — incompatible with WebRTC, see Changelog)
- [x] ISC-7: Client overrides of system prompt disabled (API read)
- [x] ISC-8: Call-duration cap ≤ 1800s set on agent (API read: 900)

### F2 — Mini App page
- [x] ISC-9: GitHub repo exists — mggrim/pai-voice, pushed
- [x] ISC-10: `index.html` imports `@elevenlabs/client` — vendored bundle `./elevenlabs-client.js` (advisor upgrade from CDN; see Decisions)
- [x] ISC-11: Page includes `telegram-web-app.js` script (grep)
- [x] ISC-12: Page has start/end call controls and status element (grep)
- [x] ISC-13: `startSession` called with `connectionType: 'webrtc'` (grep)
- [x] ISC-14: Page gates start on Telegram user id matching Matthew's id (grep)
- [x] ISC-15: Anti: `ELEVENLABS_API_KEY` value absent from repo and served page (git grep of key value: no match)
- [x] ISC-16: Anti: no package.json/node_modules in repo — bundle built in /tmp (ls)

### F3 — Hosting
- [x] ISC-17: Pages URL returns HTTP 200 over HTTPS (curl -i)
- [x] ISC-18: Served page contains the agent id (curl | grep)
- [x] ISC-19: README.md documents architecture, URLs, and relaunch steps (Read)
- [x] ISC-20: Repo has initial commit; ISA.md committed (git log, git ls-files)
- [x] ISC-21: .gitignore excludes .env and secrets (grep)
- [x] ISC-22: Anti: no hardcoded `/Users/mgrimes` paths in committed scripts (grep)

### F4 — Telegram wiring
- [x] ISC-23: Bot token valid — getMe returns ok:true (curl)
- [x] ISC-24: web_app inline-button message delivered to Matthew's chat — sendMessage ok:true (curl)
- [x] ISC-25: Chat menu button set to open the Mini App — setChatMenuButton ok:true (curl)
- [x] ISC-26: Anti: no Telegram API call targets a chat other than TELEGRAM_CHAT_ID (transcript review)

### F5 — PAI brain (Phase 2)
- [x] ISC-27: `Tools/BuildAgentPrompt.ts` exists; `bun` run exit 0, wrote 7662 chars
- [x] ISC-28: Generated prompt draws on PRINCIPAL_IDENTITY + DA_IDENTITY (6 "Matthew" matches; lengths logged)
- [x] ISC-29: Agent carries PAI persona — read-back prompt contains Matthew context (persona included at creation)
- [x] ISC-30: Ingress decision recorded in Decisions — funnel viable, deferred pending approval (PaiVoice-T2)
- [x] ISC-31: Anti: sensitive-term scan of uploaded prompt clean (banned-pattern gate in generator + rg: 0 matches)

### F6 — Knowledge access (added 2026-07-18, ID-stable append)
- [x] ISC-34: KB docs uploaded — telos/state, second-brain digests, skills+architecture (API ids m3NB…, FGGZ…, YZVW…)
- [x] ISC-35: Agent knowledge_base lists all 3 docs and rag.enabled true (API read-back)
- [x] ISC-36: Prompt instructs agent to consult KB, verified in read-back (test("knowledge base") true)
- [x] ISC-37: Anti: credential-pattern redaction active in SyncKnowledge.ts before upload (CRED_PATTERN gate)

### F7 — Live-tools bridge (added 2026-07-18, ID-stable append)
- [x] ISC-38: BridgeServer.ts serves /health + 3 read-only search tools on :31341 under launchd KeepAlive (curl ok via launchd)
- [x] ISC-39: Public HTTPS ingress live — trycloudflare tunnel; /health "ok" and authed search return over public edge (curl --resolve probe)
- [x] ISC-40: Anti: requests without X-Bridge-Secret rejected 403 over the public URL (curl probe)
- [x] ISC-41: 3 webhook tools registered and attached — tool_ids length 3 in agent read-back
- [x] ISC-42: TunnelKeeper re-points tool URLs on tunnel rotation (repoint logic; .tunnel-url state)
- [x] ISC-43: Daily KB re-sync scheduled — com.pai.voice-kbsync launchd 07:20
- [ ] ISC-44: Matthew confirms a live call where PAI answers from second brain/threads — [DEFERRED-VERIFY: PaiVoice-T3]

### F8 — Temporal context + tool priority (added 2026-07-18, ID-stable append)
- [x] ISC-45: get_week_context returns prep + 2 daily digests, no query needed (local + public probe: 3 sections)
- [x] ISC-46: Tool registered and attached — 4 tool_ids in agent read-back
- [x] ISC-47: Persona has explicit TOOL PRIORITY ORDER (conversations/memory first, week-context for temporal, KB last) — read-back grep
- [x] ISC-48: grab() survives per-file read failures (macl/eviction) — returns remaining files
- [x] ISC-49: Anti: schedule questions never answered from static KB alone (prompt rule present in read-back)
- [ ] ISC-50: Matthew confirms "what am I doing this week" answered from briefing data — [DEFERRED-VERIFY: PaiVoice-T4]

### F9 — BM25 + recency retrieval (added 2026-07-18, ID-stable append)
- [x] ISC-51: search_second_brain BM25-ranked with recency boost — "gala dinner" returns 07-16 digests first (curl probe)
- [x] ISC-52: search_memory merges MemoryRetriever (banner-filtered) + BM25 over auto-memory — clean ranked results (curl probe)
- [x] ISC-53: search_conversations token-alternation rg + newest-first + coverage×recency ranking — multi-word queries return 8 (curl probe)
- [x] ISC-54: Index TTL cache — cold build 428ms/1041 docs, warm queries <50ms local (Engineer bench + log timings)
- [x] ISC-55: Anti: unreadable files (evicted/TCC) skipped per-file, never fail the tool (walkMd try/catch, tested against tagged corpus)
- [x] ISC-56: Public end-to-end returns ranked results through tunnel (curl: 8 results)
- [ ] ISC-57: Matthew reports improved recall on a real call — [DEFERRED-VERIFY: PaiVoice-T5]

### F9 addendum
- [x] ISC-58: search_conversations extracts Telegram reply tool_use inputs as "(PAI→Hub)" messages — Hub-thread replies searchable (curl probe returns briefing content)

### F10 — Voice journal, dispatch, capture (added 2026-07-18, ID-stable append)
- [x] ISC-59: get_journal_context returns digests/prev-entry/yesterday-convos/goals sections (Engineer temp-port test: 4; launchd: 2 — see ISC-66)
- [x] ISC-60: save_journal_entry writes house-frontmatter entry, never overwrites (Engineer test: -voice suffix on collision)
- [x] ISC-61: save_to_second_brain writes inbox note with source header (Engineer test)
- [x] ISC-62: dispatch_task writes prompt file + detached send-prompt spawn, returns <10s (Engineer test vs /bin/true)
- [x] ISC-63: post-call webhook saves transcript, ≥6 turns triggers processing dispatch, wrong token 404 (Engineer test + public 404 probe)
- [x] ISC-64: 8 tools registered with typed schemas; agent read-back tool_ids=8, JOURNAL MODE in prompt
- [x] ISC-65: ElevenLabs post-call webhook created (95c7dc70…), attached to agent, TunnelKeeper re-points it (PATCH shape verified 200)
- [x] ISC-66: launchd bridge reads second-brain corpus — /health "ok sb:735" after eviction fix; FDA verified granted in TCC.db (bun/claude/tmux auth_value=2) but root cause was DATALESS EVICTION not TCC: launchd defaults to non-materializing (EDEADLK); fix = com.pai.sb-prewarm hourly materialization job (MaterializeDatalessFiles=true), bridge stays non-blocking skip-on-evicted
- [x] ISC-67: Anti: /health goes loud (503 DEGRADED) when second-brain corpus reads <50 docs (curl: DEGRADED sb:2 503 observed pre-threshold-fix)
- [ ] ISC-68: [DEFERRED-VERIFY: PaiVoice-T7] HMAC signature verification on post-call webhook (compensating control: 32-hex URL token)
- [ ] ISC-69: [DEFERRED-VERIFY: PaiVoice-T8] idempotency key on save paths (compensating: never-overwrite + instruction-level idempotent processing)
- [x] ISC-70: 9am journal prompt sends voice web_app button to PRIVATE chat (web_app illegal in supergroups), text fallback in topic (file read-back)
- [x] ISC-71: Anti: dispatch/webhook state files (.webhook-token, .tunnel-url, .tools-state.json) untracked in git (git ls-files clean)

### Experience
- [x] ISC-32: Antecedent: button's web_app URL is HTTPS and returns 200 (curl) — precondition for in-Telegram open
- [x] ISC-33: Live mic-to-voice round-trip confirmed by Matthew 2026-07-18: "It works well" (after origin fix)

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
- 2026-07-18: ISC-30 — Tailscale running (`matthews-business-m2-mac-mini.tail28ec80.ts.net`); funnel is the custom-LLM ingress candidate but exposing this machine publicly needs Matthew's explicit approval. Deferred; follow-up PaiVoice-T2.
- 2026-07-18: Advisor conflict resolved on facts: advisor assumed caps were client-side JS; they are ElevenLabs platform-side (`platform_settings.call_limits` verified by API read-back). Adopted advisor's vendored-SDK recommendation (esm.sh runtime resolution removed); mic-across-clients testing folded into ISC-33 deferred human verify.
- 2026-07-18: Funnel dead end — App Store Tailscale GUI CLI (io.tailscale.ipn.macos 1.98.8) hangs silently on serve/funnel with no config written; pivoted to cloudflared quick tunnel + TunnelKeeper URL self-healing rather than replacing his Tailscale install. Revisit if he moves to standalone tailscaled.
- 2026-07-18: Telegram-threads access resolved via transcripts: channels bot routes DMs into Claude Code sessions, so search_conversations over ~/.claude/projects/-Users-mgrimes/*.jsonl (14-day window) IS thread access — no separate store exists.
- 2026-07-18: "What am I doing this week" failed because all tools were keyword search; temporal questions need recency, not matching. Added no-query get_week_context over pre-dawn prep digests (which carry the icalBuddy calendar table — the TCC-safe calendar source).
- 2026-07-18: Recent daily digests carry com.apple.macl (TCC tag, appeared ~07-15 in their generator) making them unreadable to launchd processes; stripped via FDA-session re-copy, bridge now skips tagged files gracefully. Surface to Matthew: dailies will re-acquire macl until the digest generator changes; prep digests unaffected.
- 2026-07-18: MemoryRetriever corpus is 2 notes (MEMORY/KNOWLEDGE effectively unpopulated) — kept in the merge for when it fills, but auto-memory dir + transcripts are the real channel memory today. Surfaced to Matthew.
- 2026-07-18: Engineer's phrase-regex rg pre-filter broke multi-word voice queries; fixed with token alternation. First-N-lines-per-file candidate selection biased to meta noise; fixed with newest-first file order + -m 25.
- 2026-07-18: EDEADLK saga resolution — "TCC loss" diagnosis was WRONG; the launchd probe showed EDEADLK (dataless files + launchd non-materializing default). Setting MaterializeDatalessFiles on the bridge caused an infinite-block hang (thundering-herd materialization) — reverted; correct architecture is out-of-band prewarm (com.pai.sb-prewarm hourly, materializing context) + skip-on-evicted in the request path. brctl download was a no-op on this provider; real reads materialize.
- 2026-07-18 (F10): FDA-on-bun is a BROAD grant (bun runs arbitrary JS) — accepted risk, compensating control = /health canary + read-only tool design. TCC grants die on brew upgrades (path change) — canary catches it. Advisor gates 2026-07-18: HMAC verify + idempotency keys recorded as PaiVoice-T7/T8 rather than blocking; E4 thinking floor met at 4/6 (FeedbackMemoryConsult, ISA, Advisor, ReReadCheck) — budget-constrained, Cato unavailable on this machine (no codex CLI).
- 2026-07-18: Lesson — destroyed Engineer's uncommitted worktree with `git worktree remove --force` before confirming the commit landed; recovered file from agent transcript via jq. Rule: verify worktree branch tip contains the artifact BEFORE removal.

## Verification

- ISC-1..8: API read-back — llm claude-sonnet-4-6, voice 5gLuKtB16QIQv1vuSas1, max_dur 900, allowlist mggrim.github.io, overrides.prompt false, caps {concurrency:1, daily:50}
- ISC-9..16: git + rg — repo pushed, gate/webrtc/telegram-sdk greps hit, key-value grep clean, no build artifacts in repo
- ISC-17/18/32: curl — page 200, bundle 200, served HTML contains agent_8501kxv2sfnkeq9s0r2kqtc2s906
- ISC-19..22: README present; git log f19870c..; .gitignore covers .env + agent-prompt.txt; path grep self-referential only
- ISC-23..26: Telegram API — getMe ok (@Pai_mggrim_bot), sendMessage ok (msg 2018, chat 8386574938 only), setChatMenuButton ok
- ISC-27..31: bun run exit 0 (7662 chars); banned-term scan clean; persona in agent read-back; funnel decision logged
- ISC-33: [DEFERRED-VERIFY: PaiVoice-T1 — Matthew's live tap on iOS/Android/Desktop Telegram]

## Changelog

- 2026-07-18 conjectured: origin-header enforcement (`require_origin_header: true`) was compatible with the Mini App webview and would harden the public agent. refuted by: two live calls failed instantly — conversation error 3000 "Client did not provide the origin header"; the WebRTC path (browser → LiveKit → ElevenLabs) never propagates the page's Origin to the conversation-initiation check, while the token endpoint (which my curl probes hit) does see it. learned: `require_origin_header` is unusable with `connectionType: 'webrtc'` regardless of client; origin-based controls only bite on the token layer, so the effective abuse guards for a public WebRTC agent are the platform call caps. criterion now: ISC-6 amended — allowlist retained, `require_origin_header` must be false; caps (ISC-8, concurrency 1, daily 50) are the primary enforcement.

- 2026-07-18 (F6): SyncKnowledge.ts output + agent read-back {kb:[3 names], rag:true, prompt_mentions_kb:true}

- 2026-07-18 (F7): tools tool_0101…/tool_3001…/tool_4101… attached; read-back {tool_ids:3, kb:3, rag:true, prompt_mentions_tools:true}; public probes health ok / n=1 / 403
