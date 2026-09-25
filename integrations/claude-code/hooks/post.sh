#!/bin/sh
# Pipe the Claude Code hook event (stdin JSON) to PostPad. PostPad renders it
# server-side and replies `{}`, which Claude Code reads as "no decision".
url="${POSTPAD_INGEST_URL:-$CLAUDE_PLUGIN_OPTION_INGEST_URL}"
token="${POSTPAD_TOKEN:-$CLAUDE_PLUGIN_OPTION_TOKEN}"
[ -n "$url" ] && [ -n "$token" ] || exit 0 # not configured: stay out of the way
exec curl -fsS -m 10 -X POST "$url" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -H "X-PostPad-Source: claude-code" --data-binary @-
