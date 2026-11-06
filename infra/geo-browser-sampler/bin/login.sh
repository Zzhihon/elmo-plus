#!/bin/zsh
# Opens the sampling profile with the same keychain flags chrome-devtools-mcp
# launches it with, so cookies saved here can be read by unattended runs.
set -euo pipefail
PROFILE="${GEO_SAMPLER_PROFILE:-$HOME/.local/share/geo-sampler-chrome}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null; then
  print -u2 "a Chrome window is already using $PROFILE; close it first"
  exit 1
fi
if (( $# )); then urls=("$@"); else urls=(
  https://www.doubao.com/chat/
  https://chat.deepseek.com/
  https://www.qianwen.com/
  https://yuanbao.tencent.com/chat
  https://chatgpt.com/
  https://gemini.google.com/app
); fi
exec "$CHROME" --user-data-dir="$PROFILE" --use-mock-keychain --password-store=basic --no-first-run "${urls[@]}" >/dev/null 2>&1
