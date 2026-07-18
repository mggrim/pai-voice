#!/usr/bin/env bash
# Sends (or re-sends) the PAI Voice Mini App button to Matthew's chat,
# and sets the chat menu button. Reads secrets from local config; nothing hardcoded.
set -euo pipefail

TOKEN=$(grep -o '^TELEGRAM_BOT_TOKEN=.*' "$HOME/.claude/channels/telegram/.env.channels-only" | sed 's/TELEGRAM_BOT_TOKEN=//;s/"//g')
source "$HOME/.claude/daemon/config.sh" 2>/dev/null || true
CHAT_ID="${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID missing from daemon/config.sh}"
URL="https://mggrim.github.io/pai-voice/"

curl -s "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\":${CHAT_ID},\"text\":\"🎙️ PAI Voice is live — tap below for a real-time voice conversation.\",\"reply_markup\":{\"inline_keyboard\":[[{\"text\":\"📞 Call PAI\",\"web_app\":{\"url\":\"${URL}\"}}]]}}"
echo
curl -s "https://api.telegram.org/bot${TOKEN}/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\":${CHAT_ID},\"menu_button\":{\"type\":\"web_app\",\"text\":\"Call PAI\",\"web_app\":{\"url\":\"${URL}\"}}}"
echo
