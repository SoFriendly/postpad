// "Connect a sender": paste-ready setup for each coding agent, with this entry's
// ingest URL + token filled in. Each hook just pipes the agent's native event JSON
// to ingest; the server renders it (workers/api/src/agents.ts). Details: docs/AGENTS.md.

export type Connector = { id: string; label: string; where: string; text: (title: string, url: string, token: string) => string };

// Command hooks: pipe the event on stdin to ingest. PostPad replies `{}`, which hook
// runners read as "no decision", so the agent is never blocked or redirected.
const curl = (url: string, token: string, source: string) =>
  `curl -fsS -m 10 -X POST ${url} -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -H 'X-PostPad-Source: ${source}' --data-binary @-`;
const cmd = (url: string, token: string, source: string, extra = {}) => ({ type: "command", command: curl(url, token, source), ...extra });
const json = (v: unknown) => JSON.stringify(v, null, 2);
const T = (t: string) => t || "<TOKEN>";

// Codex trusts each hook by a hash of its definition (/hooks approval), so its command
// must never change: URL + token live in an env file it sources. Silent if not configured.
export const CODEX_HOOK = `f="$HOME/.config/postpad/codex.env"; [ -f "$f" ] || exit 0; . "$f"; exec curl -fsS -m 10 -X POST "$POSTPAD_INGEST_URL" -H "Authorization: Bearer $POSTPAD_TOKEN" -H "Content-Type: application/json" -H "X-PostPad-Source: codex" --data-binary @-`;

export const CONNECTORS: Connector[] = [
  {
    id: "claude-code", label: "Claude Code",
    where: "Run in Claude Code. The plugin asks for the URL and token (stored in your OS keychain) and posts each finished turn and permission wait.",
    text: (_t, url, token) => `/plugin marketplace add SoFriendly/postpad
/plugin install postpad@postpad

Ingest URL: ${url}
Token:      ${T(token)}`,
  },
  {
    id: "codex", label: "Codex",
    where: "Two files. The hook command is static (no URL or token in it), so you approve it once in Codex's /hooks and can point it at another entry later by editing only the env file.",
    text: (_t, url, token) => `# 1) ~/.config/postpad/codex.env  (then: chmod 600 ~/.config/postpad/codex.env)
POSTPAD_INGEST_URL=${url}
POSTPAD_TOKEN=${T(token)}

# 2) Merge into ~/.codex/hooks.json, then in Codex run /hooks and trust both PostPad hooks (Stop, PermissionRequest)
${json({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: CODEX_HOOK, timeout: 15 }] }],
      PermissionRequest: [{ hooks: [{ type: "command", command: CODEX_HOOK, timeout: 15 }] }],
    } })}`,
  },
  {
    id: "cursor", label: "Cursor",
    where: "Merge into ~/.cursor/hooks.json. Posts Cursor's final response each turn (for cursor-agent CLI, use the \"stop\" event instead).",
    text: (_t, url, token) => json({ version: 1, hooks: { afterAgentResponse: [{ command: curl(url, T(token), "cursor") }] } }),
  },
  {
    id: "gemini", label: "Gemini CLI",
    where: "Merge the \"hooks\" key into ~/.gemini/settings.json.",
    text: (_t, url, token) => json({ hooks: {
      AfterAgent: [{ hooks: [cmd(url, T(token), "gemini", { timeout: 10000 })] }],
      Notification: [{ hooks: [cmd(url, T(token), "gemini", { timeout: 10000 })] }],
    } }),
  },
  {
    id: "copilot", label: "Copilot CLI",
    where: "Save as ~/.copilot/hooks/postpad.json. Copilot's turn-end event carries no message text, so the entry shows state only.",
    text: (_t, url, token) => {
      const http = { type: "http", url, headers: { Authorization: `Bearer ${T(token)}`, "X-PostPad-Source": "copilot" }, timeoutSec: 15 };
      return json({ version: 1, hooks: { agentStop: [http], notification: [{ ...http, matcher: "permission_prompt|elicitation_dialog" }] } });
    },
  },
  {
    id: "gha", label: "GitHub Actions",
    where: "Add after openai/codex-action (id: codex). Save the token as the repo secret POSTPAD_TOKEN.",
    text: (title, url) => `- name: Update PostPad
  if: always()
  env:
    MSG: \${{ steps.codex.outputs.final-message }}
  run: |
    jq -n --arg t ${JSON.stringify(title)} --arg s "\${{ job.status }}" --arg m "$MSG" \\
      '{title: $t, status: $s, text: $m}' |
    curl -fsS -X POST ${url} \\
      -H "Authorization: Bearer \${{ secrets.POSTPAD_TOKEN }}" \\
      -H "Content-Type: application/json" -H "X-PostPad-Source: github-actions" --data-binary @-`,
  },
  {
    id: "prompt", label: "Grok Bot / any agent (prompt)",
    where: "Paste into an agent routine or standing instructions (Grok Bot, etc.).",
    text: (title, url, token) => `Keep your PostPad entry "${title}" updated with the latest status.
Whenever something meaningful changes, replace the entry by sending:
POST ${url}
Authorization: Bearer ${T(token)}
Content-Type: application/json
X-PostPad-Source: grok-bot
Body: {"markdown":"<short current status: a headline, then a few bullets>"}
Rules: each POST replaces the whole entry (latest wins), so send the full current status, not a delta. Keep it under a screen. Never include secrets. Don't notify me; PostPad is glance-only. If the response has an "error", read its "hint" and fix the request.`,
  },
];
