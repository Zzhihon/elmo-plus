#!/bin/zsh
# Runs one weekly browser sampling pass headlessly with `codex exec`.
# Env: GEO_SAMPLER_REPO (repo root), GEO_MCP_KEY_FILE (API key file), optional GEO_SAMPLER_EXTRA (extra prompt text).
set -euo pipefail

REPO="${GEO_SAMPLER_REPO:?set GEO_SAMPLER_REPO to the repository root}"
KEY_FILE="${GEO_MCP_KEY_FILE:?set GEO_MCP_KEY_FILE to the GEO API key file}"
OUT="$REPO/infra/local/geo-browser-sampler"
mkdir -p "$OUT/logs"
PROFILE="${GEO_SAMPLER_PROFILE:-$HOME/.local/share/geo-sampler-chrome}"
if pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null; then
	print -u2 "a Chrome window is using $PROFILE (likely bin/login.sh); quit it with ⌘Q and rerun"
	exit 1
fi
STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"

PROMPT="$(awk '/^<!-- prompt:start -->/{f=1;next} /^<!-- prompt:end -->/{f=0} f && !/^```/' "$REPO/infra/geo-browser-sampler/automation-prompt.md")"
[[ -n "${GEO_SAMPLER_EXTRA:-}" ]] && PROMPT="$PROMPT"$'\n\n'"$GEO_SAMPLER_EXTRA"

export GEO_MCP_KEY="$(<"$KEY_FILE")"
print -r -- "$PROMPT" | codex exec -C "$REPO" -s workspace-write \
	-c sandbox_workspace_write.network_access=true \
	-o "$OUT/last-run.txt" - >"$OUT/logs/run-$STAMP.log" 2>&1
