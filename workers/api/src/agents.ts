// First-party adapters for coding-agent hook payloads.
// Each agent's hook POSTs its raw event JSON straight to ingest (no client-side
// script); we turn it into a glanceable status note instead of a dump of session
// ids and local paths. New agents or payload changes are fixed here, server-side,
// without users touching their configs. Setup per agent: docs/AGENTS.md.
//
// Most agents copy Claude Code's hook shape (hook_event_name, session_id, cwd,
// last_assistant_message), so one normalizer covers the family; the outliers
// (Codex notify, Copilot agentStop, Windsurf) are mapped field-by-field below.

type Obj = Record<string, any>;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const project = (path: unknown) => s(path)?.split(/[\\/]/).filter(Boolean).pop();

// Keep notes glanceable; the full payload is still stored as the revision's raw_json.
const MAX_TEXT = 6000;
const clip = (t: string) => (t.length > MAX_TEXT ? t.slice(0, MAX_TEXT).trimEnd() + "\n\n…" : t);

// X-PostPad-Source value -> display name. Unknown sources are shown as sent.
const NAMES: Record<string, string> = {
  "claude-code": "Claude Code", claude: "Claude Code", codex: "Codex", cursor: "Cursor",
  gemini: "Gemini CLI", copilot: "Copilot", windsurf: "Windsurf", aider: "Aider",
};

/** The event name, if this payload came from a known agent hook. */
function eventName(o: Obj): string | undefined {
  const ev = s(o.hook_event_name) ?? s(o.agent_action_name) // Claude family / Windsurf
    ?? (o.type === "agent-turn-complete" ? "agent-turn-complete" : undefined) // Codex notify
    ?? (s(o.stopReason) ? "agentStop" : undefined); // Copilot agentStop (no hook_event_name)
  // Require a session-ish id too, so an ordinary status object with a `type` field isn't hijacked.
  const session = o.session_id ?? o.sessionId ?? o.conversation_id ?? o["thread-id"] ?? o.trajectory_id;
  return ev && s(session) ? ev : undefined;
}

export const isAgentEvent = (raw: unknown) =>
  !!raw && typeof raw === "object" && !Array.isArray(raw) && !!eventName(raw as Obj);

function agentName(o: Obj, ev: string, source?: string): string {
  const src = s(source)?.toLowerCase();
  if (src && !src.includes("/")) return NAMES[src] ?? source!; // ignore User-Agent fallbacks like "curl/8.7"
  if (o.cursor_version) return "Cursor";
  if (o["thread-id"] || o.turn_id) return "Codex";
  if (ev === "AfterAgent" || o.prompt_response !== undefined) return "Gemini CLI";
  if (o.sessionId) return "Copilot";
  if (o.agent_action_name) return "Windsurf";
  if (o.prompt_id || o.effort) return "Claude Code";
  return "Agent";
}

type State = { icon: string; label: string; text?: string };

function state(o: Obj, ev: string): State {
  const text = s(o.last_assistant_message) ?? s(o["last-assistant-message"]) ?? s(o.prompt_response)
    ?? s(o.text) ?? s(o.tool_info?.response) ?? s(o.response);
  switch (ev) {
    // Turn / task finished.
    case "Stop": case "AfterAgent": case "afterAgentResponse": case "agent-turn-complete":
    case "agentStop": case "post_cascade_response": case "post_cascade_response_with_transcript":
      return { icon: "✅", label: "Finished", text };
    case "stop": // Cursor: status completed | aborted | error, no text
      return o.status === "error" ? { icon: "❌", label: "Stopped with an error" }
        : o.status === "aborted" ? { icon: "⏹", label: "Stopped" } : { icon: "✅", label: "Finished", text };
    case "SubagentStop": case "subagentStop":
      return { icon: "✅", label: `Subagent finished${s(o.agent_type) ? ` (${o.agent_type})` : ""}`, text };
    // Waiting on the human.
    case "PermissionRequest": { // Codex: tool_name + tool_input
      const cmd = s(o.tool_input?.command);
      return { icon: "⏳", label: "Waiting for your approval", text: s(o.tool_name) && `Wants to use **${o.tool_name}**${cmd ? `:\n\n\`\`\`\n${cmd}\n\`\`\`` : ""}` };
    }
    case "Notification": case "notification": {
      const t = o.notification_type;
      if (t === "permission_prompt" || t === "ToolPermission") return { icon: "⏳", label: "Waiting for your approval", text: s(o.message) };
      if (t === "elicitation_dialog" || t === "agent_needs_input") return { icon: "⏳", label: "Waiting for your input", text: s(o.message) };
      if (t === "idle_prompt" || t === "agent_idle") return { icon: "💤", label: "Idle, waiting for your next prompt", text: s(o.message) };
      return { icon: "💬", label: s(o.title) ?? "Needs attention", text: s(o.message) };
    }
    case "SessionEnd": case "sessionEnd": return { icon: "⏹", label: "Session ended" };
    case "errorOccurred": return { icon: "❌", label: "Error", text: s(o.error?.message) ?? s(o.message) };
    default: return { icon: "•", label: ev, text };
  }
}

/**
 * Markdown for a recognized agent hook payload, or null to fall through to the
 * generic renderer. Layout: `## <icon> <Agent> · <project>`, a state line, the agent's words.
 */
export function renderAgentEvent(o: Obj, source?: string): string | null {
  const ev = eventName(o);
  if (!ev) return null;
  const st = state(o, ev);
  const where = project(o.cwd ?? o.workspace_roots?.[0]);
  return [`## ${st.icon} ${agentName(o, ev, source)}${where ? ` · ${where}` : ""}`, `**${st.label}**`, st.text && clip(st.text)]
    .filter(Boolean).join("\n\n") + "\n";
}
