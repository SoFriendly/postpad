# Grok Bot ↔ PostPad integration (from Justin via Assistant)

> **Terminology (2026-09-25):** PostPad is now one pad of **entries** ([RUNNING_NOTE_MODEL.md](RUNNING_NOTE_MODEL.md)). Where this doc says *note*, read *entry*; API paths below are current.

**Priority:** Hooking Grok Bot up to PostPad is an important feature — design ingest + client UX so this path is first-class and actually works.

This doc explains how **Grok Bot webhooks** work in Justin’s setup, and what PostPad should support so agents (especially Grok Bot) can keep notes updated.

---

## What Grok Bot is (in this context)

Grok Bot is Justin’s always-on desktop assistant (Cursor / Grok Bot). It can run **routines**: saved prompts with triggers (cron, Slack, GitHub, **webhook**, etc.). Routines fire even when Justin is away.

Justin already has a standing **Webhook handler** routine whose job is: when a webhook arrives, **act on the payload** and tell him what it did. Book-related payloads are handed to a separate Books agent; everything else is handled in the assistant chat.

---

## How Grok Bot webhooks work (caller → Grok Bot)

1. A routine is created with trigger `{ "type": "webhook" }`.
2. The **routine panel** in the Grok Bot app exposes (user copies these; agents should not invent or paste secrets into chat):
   - Webhook **URL** (hosted on Cursor’s automation gateway, shape like `https://api2.cursor.sh/automations/webhook/<id>`)
   - Webhook **key** / **Authorization** header value (Bearer token, typically `Authorization: Bearer crsr_…`)
3. An external system (Hold & Talk, Pebble Agent Gateway, curl, another agent, CI, etc.) **POSTs** to that URL.

### Hard requirements on the request (learned the hard way)

| Requirement | Why |
|------------|-----|
| `Content-Type: application/json` | Gateway rejects non-JSON with **415 Unsupported Media Type** *before* the routine wakes |
| Body must be **JSON** | Headers alone do not convert plain text / multipart into JSON |
| `Authorization: Bearer <key>` | Wrong/missing auth → **401**; routine never runs |
| Valid JSON object | Even a simple `{"text":"…"}` or `{"message":"…"}` works; empty/non-JSON fails |

Rejection at the gateway means: **no routine run, no agent wake, status stays “never run.”** Connectivity tests only count once a real JSON POST succeeds.

### What the agent receives

When the POST is accepted, Grok Bot wakes with a webhook event (payload available to the automation). The saved routine prompt decides behavior (e.g. “act on payload and report back”). The automation run is isolated: it often **cannot** create other routines or talk to the user directly; it hands off to the parent assistant when needed.

### What webhooks are *not*

- Not a bidirectional RPC into PostPad by themselves
- Not guaranteed to preserve arbitrary content-types
- Not a place to put secrets in chat transcripts — URL/key live in the routine panel

---

## How this relates to PostPad (two directions)

### A. Grok Bot → PostPad (primary product path — “agents write notes”)

Grok Bot (or any of Justin’s agents/routines) should be able to **POST status into a PostPad note** whenever something important changes:

```http
POST {POSTPAD_BASE}/v1/ingest/{entry_id}
Authorization: Bearer {note_token}
Content-Type: application/json

{ "markdown": "## Crosspoint iOS\nSimulator build green…" }
```

or structured status JSON that PostPad already renders to markdown.

**Design implications for PostPad:**
1. Ingest must stay **simple, curl-friendly, JSON-only** — same class of caller as Grok Bot’s own webhook gateway (agents, shortcuts, Hold & Talk middlemen).
2. Document a **“status note for Grok Bot”** recipe: create note → copy `ingest_url` + token → paste into Grok Bot memory / routine prompt / skill (“when you finish X, POST latest status to this note”).
3. Optional later: a small **Grok Bot skill or routine template** that knows PostPad’s ingest contract (base URL, note id, token env var).
4. Replace semantics (latest wins) match how Justin uses Grok Bot status (“always the latest,” no notification spam).
5. Consider accepting a few **aliases** for body text (`markdown`, `body`, `text`, `message`) so whatever an agent naturally POSTs still renders — Grok Bot webhook payloads often use `text` / freeform JSON.
6. CORS and auth errors should be clear in JSON responses so agent debugging is easy.

### B. External world → Grok Bot webhook → (optional) PostPad

Some devices talk **to Grok Bot’s webhook** (e.g. Hold & Talk). That path updates the *assistant*, not PostPad, unless the routine explicitly forwards.

If we want “speak a status → PostPad note updates,” options are:
1. Teach the Webhook handler routine: when payload looks like a status update for a known note, **also** POST to PostPad ingest; or
2. Point the device at **PostPad ingest directly** (preferred when the only goal is updating a note — fewer hops, no agent wake).

PostPad should optimize for (2) and document (1) as an orchestration pattern on the Grok Bot side.

---

## Concrete asks for this codebase

1. Add or extend docs (this file + README) with a **Grok Bot** section: how to create a note and have Grok Bot keep it updated.
2. Ensure ingest JSON schema is **forgiving** for agent payloads (`text` / `message` / `markdown` / `body` / simple status objects).
3. Ship an example curl + example “routine prompt snippet” Justin can paste into Grok Bot.
4. Do **not** require PostPad to implement Cursor’s webhook gateway; PostPad is the **status store**. Grok Bot is a **writer client**.
5. If you add webhook *outbound* from PostPad later, that is optional and secondary — not required for v1 Grok Bot integration.

---

## Example: Grok Bot routine prompt snippet (for Justin to paste)

```
When you finish a meaningful step on {project}, update your PostPad entry {entry_id}:
POST {base}/v1/ingest/{entry_id}
Authorization: Bearer {token}
Content-Type: application/json
Body: {"markdown":"<short current status with bullets>"}
Do not notify; PostPad is glance-only. Replace status each time (latest wins).
```

Or store `POSTPAD_STATUS_URL` + `POSTPAD_STATUS_TOKEN` in Grok Bot secrets and have standing instructions reference them.

---

Justin’s Assistant (this message’s author) can wire real Grok Bot routines/skills once PostPad ingest URL + token patterns are stable. Prefer documenting the contract clearly over inventing a tight coupling inside PostPad’s Worker.

---

## Implementation status (PostPad side)

PostPad's role is the **status store**; Grok Bot is a **writer client** (direction A). PostPad does not implement or proxy Cursor's webhook gateway.

| Ask | Status |
|-----|--------|
| Simple, curl-friendly, JSON-only ingest | ✅ `POST /v1/ingest/<id>` with a per-note Bearer token. Valid JSON is accepted even when `Content-Type` is missing or wrong, so PostPad never 415s a well-formed agent payload. |
| Forgiving body aliases | ✅ `markdown` / `body` (verbatim), then `text` / `message` / `summary` / `description`; `title`/`name` become a heading, `status` a status line, leftover fields a list, nested values a JSON block. A bare JSON string also works. Full table: README → "Ingest contract". |
| Replace semantics, no notification spam | ✅ Latest wins. Identical re-posts return `"unchanged": true` and don't add a revision, so frequent routine runs keep History meaningful. |
| Clear JSON errors | ✅ Every error is `{ "error", "hint" }` (404 unknown note, 401 missing vs invalid token, 400 invalid JSON, 413 >256KB, JSON 404 for wrong routes). CORS is open. |
| Revisions attributed to the agent | ✅ Optional `X-PostPad-Source: grok-bot` header labels the revision in History (falls back to User-Agent). |
| "Status note for Grok Bot" recipe | ✅ README → "Grok Bot (and other agents)". The app's **Connect an agent → Grok Bot / any agent (prompt)** produces the routine snippet below with the real URL and token filled in. |
| Grok Bot skill / routine template | ⏳ Optional, on the Grok Bot side. The contract above is stable enough to write one against. |
| Direction B (device → Grok Bot → PostPad) | 📄 Orchestration on the Grok Bot side (the Webhook handler routine forwards to ingest). Prefer pointing devices straight at PostPad ingest. |

### Routine prompt the app generates

```
Keep the PostPad note "<title>" updated with the latest status.
Whenever something meaningful changes, replace the note by sending:
POST <address>
Authorization: Bearer <token>
Content-Type: application/json
X-PostPad-Source: grok-bot
Body: {"markdown":"<short current status: a headline, then a few bullets>"}
Rules: each POST replaces the whole note (latest wins), so send the full current status, not a delta. Keep it under a screen. Never include secrets. Don't notify me; PostPad is glance-only. If the response has an "error", read its "hint" and fix the request.
```

Preferred variant: store `POSTPAD_STATUS_URL` / `POSTPAD_STATUS_TOKEN` as Grok Bot secrets and reference those names instead of pasting the token.

### Gaps (not built yet), in priority order

1. **Token rotation / revocation.** Tokens now live in agent prompts and secrets, so a leaked one needs to be revocable. `REQUIREMENTS.md` lists this; there's no endpoint yet (today: delete the note and create a new one).
2. **Staleness signal.** Latest-wins means a dead routine looks the same as a healthy one with a steady status, and unchanged re-posts deliberately don't bump `updated_at`. Needs a `last_ingest_at` that every accepted POST bumps, plus a "no update in N hours" hint in the app and widget.
3. **One token per note.** A Grok Bot managing many notes needs one secret per note. A workspace-scoped agent key (write-only, can target notes by id or slug) would make "Grok Bot keeps all my project notes updated" one secret.
4. **Rate limits** per note/workspace (in `REQUIREMENTS.md`; not enforced yet). Low risk while tokens are private; needed before public signup.
5. **Idempotency key.** Not implemented; the unchanged-status check covers the common retry case (same body posted twice).
6. **Plain-text bodies.** Deliberately rejected (JSON-only contract). If a device like Hold & Talk can only send `text/plain` straight to PostPad, accepting it as markdown is a small change.
