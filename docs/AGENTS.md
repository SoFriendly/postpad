# Coding agents → PostPad

PostPad has first-party support for coding agents updating their entry in your pad when they
finish a turn, or when they're **waiting on you** (a permission prompt). It's a
glance, not a notification: the entry always shows the agent's latest state.

The easiest setup is in the app: add a sender → **Connect a sender** → pick the
agent → copy the snippet (URL and token filled in). This doc explains what
those snippets do.

## How it works

Every agent's hook sends its **raw, native event JSON** straight to its entry's
ingest URL. There's no wrapper script or `jq`, just `curl` (or a built-in HTTP hook).
The server recognizes each agent's payload (`workers/api/src/agents.ts`) and
renders one consistent card:

```markdown
## ✅ Claude Code · postpad

**Finished**

Tests pass. I fixed the flaky diff test by tie-breaking on insertion order.
```

- **States:** ✅ finished, ⏳ waiting for your approval/input, ❌ stopped with an error, ⏹ session ended.
- **Project** is the last segment of the agent's working directory. Session ids, transcript paths and other local paths stay out of the entry. They're kept only in the revision's raw JSON.
- **Agent name** comes from the `X-PostPad-Source` header the snippets set, falling back to recognizing the payload shape.
- **Long messages** are clipped at 6,000 characters.
- **Response:** agent hooks get a bare `{}` back. Hook runners read the response as hook output (e.g. Claude Code's `decision`, Cursor's `followup_message`), and `{}` means "no decision", so PostPad can never block or redirect an agent. Errors are non-2xx, which every agent treats as a non-blocking hook failure.
- **Fixing it server-side:** new agents and payload changes are handled on the server, so nobody has to edit their hook configs.

### Which events, and why

Latest wins, so a hook that fires after the useful one erases it. The snippets
subscribe only to **turn finished** and **needs approval**. They deliberately
skip idle and session-end events, which would replace "here's what I finished"
with "idle".

## Setup per agent

`<URL>` is the entry's delivery address; `<TOKEN>` its token (shown once at creation,
kept on the device that created the entry, or in your PO Box file). All config files below are in your
**home directory**, so the token never lands in a repo.

### Claude Code: plugin (recommended)

```text
/plugin marketplace add SoFriendly/postpad
/plugin install postpad@postpad
```

Install asks for the ingest URL and token. The token is marked `sensitive`, so
Claude Code keeps it in your OS credential store rather than `settings.json`.
Hooks: `Stop` and `Notification` (`permission_prompt`). Unconfigured, the plugin
does nothing.

**Per-project entry:** set `POSTPAD_INGEST_URL` / `POSTPAD_TOKEN` in that repo's
gitignored `.claude/settings.local.json`; they override the plugin config there:

```json
{ "env": { "POSTPAD_INGEST_URL": "<URL>", "POSTPAD_TOKEN": "<TOKEN>" } }
```

### Claude Code: plain HTTP hook (no plugin)

In `~/.claude/settings.json` (or a project's `.claude/settings.local.json`), with
`POSTPAD_TOKEN` exported in your environment:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "http", "url": "<URL>",
      "headers": { "Authorization": "Bearer $POSTPAD_TOKEN", "X-PostPad-Source": "claude-code" },
      "allowedEnvVars": ["POSTPAD_TOKEN"], "timeout": 10 }] }],
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "http", "url": "<URL>",
      "headers": { "Authorization": "Bearer $POSTPAD_TOKEN", "X-PostPad-Source": "claude-code" },
      "allowedEnvVars": ["POSTPAD_TOKEN"], "timeout": 10 }] }]
  }
}
```

**Agent SDK (TS/Python):** register a `Stop` hook that POSTs the hook input
as-is: `fetch(URL, { method: "POST", headers: { Authorization: "Bearer …",
"X-PostPad-Source": "claude-code" }, body: JSON.stringify(input) })`.

### Codex

The integration uses Codex's **lifecycle hooks** (`Stop` for finished turns,
`PermissionRequest` for approval waits). Codex only runs non-managed hooks you
have **trusted once in `/hooks`**: it stores a `trusted_hash` of each hook's
definition in `~/.codex/config.toml` and silently skips untrusted hooks, even in
`codex exec`.

Because trust is pinned to the hook definition, the hook command is **static**:
no URL or token in it. It sources them from an env file, so you approve it once,
and pointing it at another entry or rotating the token only touches the env file. That also
keeps the token off the approval screen and out of `hooks.json`, and it works
when Codex is launched from ChatGPT.app, which doesn't load your shell profile.

**1. `~/.config/postpad/codex.env`** (then `chmod 600 ~/.config/postpad/codex.env`):

```sh
POSTPAD_INGEST_URL=<URL>
POSTPAD_TOKEN=<TOKEN>
```

**2. Merge into `~/.codex/hooks.json`.** Both entries use this exact command:

```json
{ "hooks": {
  "Stop": [{ "hooks": [{ "type": "command", "timeout": 15,
    "command": "f=\"$HOME/.config/postpad/codex.env\"; [ -f \"$f\" ] || exit 0; . \"$f\"; exec curl -fsS -m 10 -X POST \"$POSTPAD_INGEST_URL\" -H \"Authorization: Bearer $POSTPAD_TOKEN\" -H \"Content-Type: application/json\" -H \"X-PostPad-Source: codex\" --data-binary @-" }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "timeout": 15,
    "command": "<same command as Stop>" }] }]
} }
```

**3. Trust them in `/hooks`.** Start Codex interactively, run `/hooks`, and
trust exactly these two, both from `~/.codex/hooks.json`:

| Event | Command starts with |
|-------|---------------------|
| `Stop` | `f="$HOME/.config/postpad/codex.env"; [ -f "$f" ] \|\| exit 0; …` |
| `PermissionRequest` | the identical command |

Check that the command ends in `-H "X-PostPad-Source: codex" --data-binary @-`
and contains no URL or token. If it has either, it's not the PostPad hook
above.

To verify: `grep -A1 'hooks.state' ~/.codex/config.toml` should show two new
entries with a `trusted_hash`, for the `stop` and `permission_request` events.
Existing plugin hooks there follow the pattern `<source>:<event>:<group>:<index>`.
If you ever edit the hook command itself, expect Codex to ask for trust again.
Editing `codex.env` doesn't change the hook.

**Never use `--dangerously-bypass-hook-trust`** for this. It exists for
automation that vets hook sources itself, and PostPad doesn't need it.

**Why not `SessionEnd`:** the entry is latest-wins, so a `SessionEnd` post would
replace the last "here's what I finished" summary with a bare "Session
ended". Codex's `SessionEnd` reason is also always `other`. The server renders
it if you add it, but the default is `Stop` + `PermissionRequest`.

**`notify` is a probe only, not the integration.** The legacy `notify` setting
has no trust gate, so it's handy for a quick look at Codex's real turn-complete
payload without touching `/hooks`. That's how PostPad's Codex adapter was
checked against Codex 0.155. It only reports finished turns, Codex marks it
for removal, and running it alongside the `Stop` hook posts every turn twice.
For a one-off probe:

```sh
codex exec -c 'notify=["sh","-c","printf %s \"$1\" > /tmp/codex-notify.json","probe"]' "say hi"
```

### Cursor

Merge into `~/.cursor/hooks.json`:

```json
{ "version": 1, "hooks": { "afterAgentResponse": [{
  "command": "curl -fsS -m 10 -X POST <URL> -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -H 'X-PostPad-Source: cursor' --data-binary @-" }] } }
```

`afterAgentResponse` carries the final text. Cursor's `stop` event has only a
status (`completed`/`aborted`/`error`). If you add both, the text-less `stop`
replaces the message; if you want both, add the delivery rule "never deliver when `hook_event_name = stop`" to the entry ([INGEST_FILTERS.md](INGEST_FILTERS.md)). The `cursor-agent` CLI doesn't fire `afterAgentResponse`
(as of 2026-06), so use `stop` there. Cursor has no "waiting for approval" event.

### Gemini CLI

Merge the `hooks` key into `~/.gemini/settings.json` (timeouts are in ms):

```json
{ "hooks": {
  "AfterAgent": [{ "hooks": [{ "type": "command", "timeout": 10000,
    "command": "curl -fsS -m 10 -X POST <URL> -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -H 'X-PostPad-Source: gemini' --data-binary @-" }] }],
  "Notification": [{ "hooks": [{ "type": "command", "timeout": 10000,
    "command": "curl -fsS -m 10 -X POST <URL> -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -H 'X-PostPad-Source: gemini' --data-binary @-" }] }]
} }
```

If you'd rather reference the token as an env var, name it `GEMINI_CLI_…`.
Gemini's environment redaction (on in GitHub Actions) strips names containing
`TOKEN`, `KEY`, etc.

### Copilot CLI

Save as `~/.copilot/hooks/postpad.json` (Copilot has a built-in HTTP hook):

```json
{ "version": 1, "hooks": {
  "agentStop": [{ "type": "http", "url": "<URL>", "timeoutSec": 15,
    "headers": { "Authorization": "Bearer <TOKEN>", "X-PostPad-Source": "copilot" } }],
  "notification": [{ "type": "http", "url": "<URL>", "timeoutSec": 15, "matcher": "permission_prompt|elicitation_dialog",
    "headers": { "Authorization": "Bearer <TOKEN>", "X-PostPad-Source": "copilot" } }]
} }
```

Copilot's `agentStop` carries no message text, so the entry shows state only.
The Copilot cloud agent reads only `.github/hooks/` in the repo and is
firewalled, so it needs `api.postpad.dev` allow-listed and a way to inject the
token; that's not covered here.

### GitHub Actions

After `openai/codex-action` (step `id: codex`), with the token in the repo secret `POSTPAD_TOKEN`:

```yaml
- name: Update PostPad
  if: always()
  env:
    MSG: ${{ steps.codex.outputs.final-message }}
  run: |
    jq -n --arg t "CI: Codex" --arg s "${{ job.status }}" --arg m "$MSG" '{title: $t, status: $s, text: $m}' |
    curl -fsS -X POST <URL> -H "Authorization: Bearer ${{ secrets.POSTPAD_TOKEN }}" \
      -H "Content-Type: application/json" -H "X-PostPad-Source: github-actions" --data-binary @-
```

`anthropics/claude-code-action` has no final-message output. Post
`{"title":…, "status": "${{ job.status }}", "text": "<run URL>"}` the same way.

### Others

- **Windsurf / Devin Desktop:** `~/.codeium/windsurf/hooks.json` → `{"hooks":{"post_cascade_response":[{"command":"<same curl>"}]}}`. The response text is included.
- **Aider:** `notifications_command` runs with no payload. Post a fixed body instead: `curl … -d '{"title":"Aider","status":"waiting for input"}'`.
- **Amp, OpenCode, Cline:** these use in-process TypeScript plugins rather than hooks. From the plugin, `fetch` the ingest URL with `{"title": …, "status": …, "text": <final message>}`.
- **Grok Bot and prompt-driven agents:** see [GROKBOT_INTEGRATION.md](GROKBOT_INTEGRATION.md).

## Verification status

| Integration | Status |
|-------------|--------|
| Claude Code HTTP hook (`Stop`) | ✅ Live-tested: Claude Code 2.1.282, real run, env-var header expansion |
| Claude Code plugin | ✅ Live-tested via `--plugin-dir` with the env override; `claude plugin validate` passes. The install-dialog config path hasn't been run end to end. |
| Claude Code `permission_prompt` | Doc-based fixture |
| Codex hooks (`Stop`, `PermissionRequest`) | The static command was run under sh/zsh/bash with a `Stop` payload from Codex's source schema: silent when unconfigured, updates the entry when configured. A real Codex run is waiting on the one-time `/hooks` trust. Not verified: whether `{}` from `PermissionRequest` leaves Codex's normal approval prompt in place. |
| Codex `notify` (probe only) | ✅ Live: Codex 0.155 (ChatGPT.app) turn-complete payload matched the adapter |
| Cursor, Gemini CLI, Copilot CLI, Windsurf | Fixtures from official docs/source (`test/agents.test.ts`); not live-tested |
| GitHub Actions | Not run |

## Privacy

The agent's final message is sent to whichever PostPad backend the URL points
at (hosted or your own). Don't connect agents on repos where that isn't OK. Entry
tokens are write-only and per-entry: a leaked token can overwrite one entry, and
can't read anything.

## Known gaps

- **Stale detection:** a crashed or closed agent looks the same as a finished one. See the `last_ingest_at` gap in [GROKBOT_INTEGRATION.md](GROKBOT_INTEGRATION.md).
- **One entry per token:** a single write-only agent key covering many entries (e.g. one entry per repo, chosen automatically from `cwd`) would make "all my agents, all my repos" a one-time setup.
- **Windows:** the command snippets assume a POSIX shell with `curl`. The Claude Code HTTP hook and Copilot HTTP hook work anywhere.
