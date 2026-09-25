# Ingest filters (include/exclude): scope for a later release

> **Terminology (2026-09-25):** PostPad is now one pad of **entries** ([RUNNING_NOTE_MODEL.md](RUNNING_NOTE_MODEL.md)). Where this doc says *note*, read *entry*; API paths below are current.

**Status:** v1 built (API, app editor, delete). Agent presets in Connect are not built yet. **Backlog item:** [REQUIREMENTS.md → Backlog](REQUIREMENTS.md#backlog--later-ideas).
**Size:** small: 1 migration, one pure function + tests, a check in ingest, and a rules editor on the note.

## What it is

A per-note gate on **incoming POSTs**, based on the JSON the writer sends:

- **Exclude:** don't update the note if a key equals something (e.g. `status = heartbeat`).
- **Include:** only update the note when a key equals something (e.g. `status = failed`).

The writer keeps posting everything; the note only changes on the posts you
care about. There's no hiding notes. A note you don't want is deleted, which
decommissions its endpoint.

## Thin v1

### Rules

Each note has an optional rule set:

```json
{
  "include": [ { "key": "status", "equals": ["failed", "error"] } ],
  "exclude": [ { "key": "hook_event_name", "equals": ["SubagentStop"] } ]
}
```

- **`key`**: a dot path into the posted JSON: `status`, `build.result`, `workspace_roots.0`.
- **`equals`**: one or more values. The rule matches if the key's value equals **any** of them. Values compare as exact strings, so `0`, `true` and `"green"` all work from a text box, and matching is case-sensitive. A missing key never matches.

### Evaluation (per POST, before rendering)

1. If **any exclude** rule matches → skip.
2. If there are include rules and **any include** rule doesn't match → skip. Include rules are ANDed, and each rule's value list is ORed. That covers "status is failed **or** error" and "repo is postpad **and** status is failed" without if/else.
3. Otherwise → update as today (render, revision, latest wins).

A **skipped** POST:
- **leaves the note untouched:** no revision, no change to `updated_at`. The whole point is that the note doesn't update.
- **gets `200 {"skipped": true, "reason": "exclude matched: status = heartbeat"}`**. It's not an error, so writers don't retry or treat the note as broken. Agent hook callers still get a bare `{}` (see [AGENTS.md](AGENTS.md)).
- **records `last_skipped_at` + `last_skip_reason` on the note**, so "why isn't my note updating?" has an answer in the app.

Rules match the **raw posted JSON**, not the rendered markdown, so they work on
any writer's native fields. Non-object bodies (a bare JSON string) have no keys:
they never match exclude, and they fail any include.

### Examples

| Goal | Rules |
|------|-------|
| Ignore a chatty heartbeat | exclude `status = heartbeat` |
| Only show failures | include `status = failed, error` |
| One repo's CI into this note | include `repository = SoFriendly/postpad` |
| Claude Code: only "waiting on me" | include `notification_type = permission_prompt` |
| Cursor: keep the message when `stop` fires after `afterAgentResponse` | exclude `hook_event_name = stop` (fixes the text-less overwrite in [AGENTS.md](AGENTS.md#cursor)) |
| Ignore subagent chatter | exclude `hook_event_name = SubagentStop` |

## Data model

```sql
-- migrations/0002_ingest_filter.sql
ALTER TABLE notes ADD COLUMN ingest_filter    TEXT;  -- JSON rule set; NULL = accept every POST
ALTER TABLE notes ADD COLUMN last_skipped_at  TEXT;
ALTER TABLE notes ADD COLUMN last_skip_reason TEXT;
```

Limits: ≤ 20 rules per note, ≤ 10 values per rule, key ≤ 100 chars, value ≤ 200 chars.

## API

| Method | Path | Change |
|--------|------|--------|
| PATCH | `/v1/entries/:id` | Accepts `ingest_filter` (rule set or `null` to clear). Validated; 400 with a `hint` on bad rules. |
| GET | `/v1/entries/:id` | Returns `ingest_filter`, `last_skipped_at`, `last_skip_reason`. |
| POST | `/v1/ingest/:id` | Evaluates the note's rules after JSON parse, before render. Skips return `200 {"skipped": true, "reason": …}`. The rules are already loaded with the token check, so this costs no extra query. |

Evaluation is a pure `ingestAllowed(raw, rules) → { ok } | { ok: false, reason }`
in `lib.ts`, with a node test. The dedupe check (identical re-post → `unchanged`)
runs after it, as today.

## UI touchpoints

1. **Note view → "Update rules"**, next to the ingest endpoint:
   - Two lists, **Only update when** (include) and **Never update when** (exclude).
   - Each row is `[key] equals [value, value…]` with a delete ×.
   - The key field suggests keys from the note's latest revision `raw_json`, so you pick `status` instead of guessing the writer's field names.
2. **Skip line:** "Last post skipped 3 min ago: status = heartbeat" under the endpoint, so a quiet note is explainable at a glance.
3. **Connect an agent:** optional presets per agent, e.g. Claude Code "only when waiting on me", which fill in the rule rows. *(Not built yet.)*

Mobile gets the same components through the shared Tauri UI.

## Explicitly out of scope

- **Rich rules:** if/else, OR across different keys, nesting, precedence beyond "exclude wins". Justin: include/exclude is enough unless a real need shows up.
- **Operators other than equals:** contains, not-equals, exists, `<`/`>`, regex. `exists` and numeric comparisons are the likely next asks, and they fit the same rule shape (`{key, op, values}`) when they come.
- **Matching rendered markdown text:** rules see the posted JSON only.
- **Transforming posts:** field mapping, templating, rewriting before render.
- **Routing:** sending a post to a different note based on its content.
- **Storing skipped posts:** they aren't revisions. If debugging needs the payload, keeping only the last skipped `raw_json` is the cheap add.
- **Global or workspace-wide rules:** rules belong to the note, since keys depend on its writer.
- **Notifications** of any kind (principle 2).

## Related

- **Staleness** (`last_ingest_at`, [GROKBOT_INTEGRATION.md](GROKBOT_INTEGRATION.md) gaps): a skipped POST still proves the writer is alive. When `last_ingest_at` lands, skips should bump it; `updated_at` stays "last time the note changed".
- **Delete:** `DELETE /v1/entries/:id` (app: remove → confirm) removes the entry, its revisions and its delivery address. Writers still posting get a 404 whose hint says the note was deleted.

## Acceptance criteria

- A note with no rules behaves exactly as today.
- Exclude `status = heartbeat`: posting `{"status":"heartbeat"}` returns `200 {"skipped":true,…}`, adds no revision, leaves `markdown`/`updated_at` unchanged, and sets `last_skip_reason`. Posting `{"status":"green"}` updates normally.
- Include `status = failed, error`: only those two values update the note; a missing `status` skips.
- Two include rules must both match; exclude wins over include.
- Dot paths and array indexes resolve (`build.result`, `workspace_roots.0`); non-string values compare by string (`exit_code = 0`).
- Agent hook callers get `{}` for skips too.
- PATCH rejects oversized/unknown rule shapes with a JSON `hint`; `null` clears the rules.
- `ingestAllowed` has a node test covering exclude/include precedence, AND/OR, missing keys and non-object bodies.
