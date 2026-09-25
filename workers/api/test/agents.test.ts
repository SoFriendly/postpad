// Agent hook payloads -> notes. Fixtures follow each agent's documented/source payload shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/lib.ts";
import { isAgentEvent } from "../src/agents.ts";

const done = (agent: string, text: string) => `## ✅ ${agent} · postpad\n\n**Finished**\n\n${text}\n`;

test("Claude Code Stop / permission prompt", () => {
  const base = { session_id: "s1", transcript_path: "/Users/j/.claude/x.jsonl", cwd: "/Users/j/GitHub/postpad", prompt_id: "p", permission_mode: "default" };
  assert.equal(renderMarkdown({ ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Tests pass." }), done("Claude Code", "Tests pass."));
  const wait = renderMarkdown({ ...base, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.match(wait, /^## ⏳ Claude Code · postpad\n\n\*\*Waiting for your approval\*\*\n\nClaude needs your permission/);
  assert.doesNotMatch(wait, /transcript|\.jsonl/); // local paths stay out of the note
});

test("Codex hooks and legacy notify", () => {
  assert.equal(renderMarkdown({ session_id: "s", turn_id: "t", cwd: "/w/postpad", hook_event_name: "Stop", model: "gpt-5", last_assistant_message: "Renamed." }), done("Codex", "Renamed."));
  assert.equal(renderMarkdown({ type: "agent-turn-complete", "thread-id": "b5", "turn-id": "1", cwd: "/w/postpad", "input-messages": ["x"], "last-assistant-message": "Done." }), done("Codex", "Done."));
  assert.match(renderMarkdown({ session_id: "s", turn_id: "t", cwd: "/w/postpad", hook_event_name: "PermissionRequest", tool_name: "shell", tool_input: { command: "rm -rf build" } }, "codex"),
    /Waiting for your approval\*\*\n\nWants to use \*\*shell\*\*:\n\n```\nrm -rf build\n```/);
});

test("Cursor, Gemini, Copilot, Windsurf", () => {
  const cursor = { conversation_id: "c", generation_id: "g", hook_event_name: "afterAgentResponse", cursor_version: "1.7", workspace_roots: ["/w/postpad"] };
  assert.equal(renderMarkdown({ ...cursor, text: "Fixed it." }), done("Cursor", "Fixed it."));
  assert.match(renderMarkdown({ ...cursor, hook_event_name: "stop", status: "error", loop_count: 0 }), /❌ Cursor · postpad\n\n\*\*Stopped with an error\*\*/);

  assert.equal(renderMarkdown({ session_id: "s", cwd: "/w/postpad", hook_event_name: "AfterAgent", prompt: "hi", prompt_response: "Hello." }), done("Gemini CLI", "Hello."));
  assert.match(renderMarkdown({ session_id: "s", cwd: "/w/postpad", hook_event_name: "Notification", notification_type: "ToolPermission", message: "Allow write_file?" }, "gemini"), /⏳ Gemini CLI/);

  assert.match(renderMarkdown({ sessionId: "s", timestamp: 1, cwd: "/w/postpad", transcriptPath: "/t", stopReason: "end_turn" }), /^## ✅ Copilot · postpad\n\n\*\*Finished\*\*\n$/);
  assert.equal(renderMarkdown({ agent_action_name: "post_cascade_response", trajectory_id: "t", tool_info: { response: "Shipped." } }), "## ✅ Windsurf\n\n**Finished**\n\nShipped.\n");
});

test("source header names the agent; user-agent fallback is ignored", () => {
  const stop = { session_id: "s", cwd: "/w/postpad", hook_event_name: "Stop", last_assistant_message: "ok" };
  assert.match(renderMarkdown(stop, "claude-code"), /^## ✅ Claude Code/);
  assert.match(renderMarkdown(stop, "my-bot"), /^## ✅ my-bot/);
  assert.match(renderMarkdown(stop, "curl/8.7.1"), /^## ✅ Agent/);
});

test("ordinary payloads are not mistaken for agent events", () => {
  assert.equal(isAgentEvent({ type: "agent-turn-complete" }), false); // no session id
  assert.equal(isAgentEvent({ status: "green", message: "x" }), false);
  assert.equal(renderMarkdown({ markdown: "# explicit", hook_event_name: "Stop", session_id: "s" }), "## explicit"); // explicit markdown wins
  assert.equal(isAgentEvent({ hook_event_name: "Stop", session_id: "s" }), true);
});

test("long agent messages are clipped", () => {
  const md = renderMarkdown({ session_id: "s", hook_event_name: "Stop", last_assistant_message: "x".repeat(10000) }, "codex");
  assert.ok(md.length < 6200 && md.endsWith("…\n"));
});
