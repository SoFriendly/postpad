# PostPad — Product Requirements

## One-liner
PostPad is one running status pad that you never write: agents and services POST the current state of something to an entry's delivery address, and that entry always shows the latest render, with git-style history when you want the past.

## Problem
Status is scattered across agent chats, webhooks, dashboards, and logs. One place to glance at “what’s true right now,” pin a few to the screen, and dig into how a status changed — without a notification firehose.

## Product principles
1. **Latest wins** — each entry is a living section of the pad. A new POST replaces that entry's body and leaves the rest of the pad alone; it does not append a feed.
2. **No notifications** — PostPad is pull/glance, not interrupt. Widgets and the app are the surface.
3. **Agents write, humans read** — humans add senders and hand out addresses (entries), search, pin, and inspect history.
4. **Readable by default** — JSON in, markdown out.
5. **History is optional depth** — current view is calm; diffs/history are one tap away.
6. **Clients are free** — users may use the hosted backend or self-host an equivalent backend.
7. **No accounts** — a random box key opens your PO Box. No email, no password, no recovery; lose the key and you open a new box.

## Core concepts

| Concept | Meaning |
|--------|---------|
| **Post office** | The backend: hosted PostPad (`api.postpad.dev`) or a self-hosted server. |
| **PO Box** | Your private box at a post office. It holds your pad. There are no accounts; the box *is* the identity. |
| **Box key** | Random 256-bit key (`ppb_…`) that opens a PO Box. Stored on the server only as a hash. Anyone with it can read and manage the box. |
| **Pad** | The one running document in a PO Box: its entries, in order. |
| **Entry** | A section of the pad under its own H1: stable id, title, slug (anchor), position, tags, current rendered body. Adding a sender or handing out an address adds an entry. |
| **Delivery address** | Per-entry ingest URL (+ auth) that senders POST to; rewrites that entry. Never changes, even when the entry is renamed. |
| **Sender** | Anything that posts to a delivery address: an agent (Claude Code, Codex, Grok Bot…), CI, cron, a webhook. Senders can only write. |
| **Delivery rules** | Per-entry conditions on the posted JSON that decide which posts update the entry; the rest are returned unopened. |
| **Revision** | Immutable snapshot after each successful ingest (history + diffs). |
| **Widget pin** | OS widget bound to an entry id; always shows its latest body. |

## User journeys

### First launch
1. With no box key on the device, the app shows a welcome screen with three choices: **I have a box key**, **I have a PO Box file**, or **Open a new PO Box**.
2. Opening a new box shows the box key with **Copy** and **Download PDF**. The printout explains what the key is for (other devices, widgets, reinstalling) and that it can't be recovered.
3. The user confirms "I've saved my box key" before reaching the mailbox.
4. An optional **Post office** field points the app at a self-hosted server.

### Another device
- Enter the box key (typed from the PDF works; whitespace is ignored), or import the encrypted **PO Box file** exported from ⚙ Your PO Box, using its passphrase.
- The same box, pad and delivery tokens appear. There's no sync service beyond the post office itself.

### Add a sender / hand out an address
1. User adds an entry (title, optional tags); it appears at the end of the pad.
2. PostPad returns the delivery address + token (shown once).
3. User connects a sender: **Connect a sender** gives a filled-in snippet per agent/service (Claude Code plugin, Codex, Cursor, Gemini CLI, Copilot, GitHub Actions, Grok Bot prompt, curl).

### External update
1. Sender `POST`s to its entry's delivery address.
2. Server validates auth, applies delivery rules, maps the body → markdown, stores a revision, rewrites that entry.
3. App and widgets refresh. **No push notification.**

### Glance and search
- Read the pad: entries in order under their H1s, with a table of contents (pins, tags, who wrote last).
- Search across the pad (titles and bodies).
- Focus an entry → History → revisions + diff.

### Pin to widget
- Pin an entry to a widget size.
- Widget shows title + latest rendered markdown.
- Updates without user-facing alerts.

## Product model (locked 2026-09-25)

**One pad, many entries — not a pile of notes.** Users add a sender or hand out an address; each target is an entry (section) in a single running PostPad. Ingest latest-wins **that entry**. See [RUNNING_NOTE_MODEL.md](RUNNING_NOTE_MODEL.md). UI follows [UI_REDIRECT.md](UI_REDIRECT.md) (VS Code–calm) against this model.

## Functional requirements

### PO Boxes & box keys
- No accounts, signup, email or recovery. A box key is the only credential for reading and managing the pad.
- Box keys are 256-bit random, stored as SHA-256 hashes, shown once when the box opens.
- Every read/manage call is scoped to the key's box. Another box's entry id returns 404 on every endpoint (one guard before all entry routes; covered by an isolation test).
- Moving devices: the key itself, its PDF printout, or an encrypted PO Box file (PBKDF2-SHA256 600k → AES-256-GCM, user passphrase) holding post office, box key and delivery tokens.
- The operator token (`ADMIN_TOKEN`) only opens boxes; it isn't a box and can't read anyone's pad.
- Opening boxes is public when `OPEN_BOXES=true`, otherwise operator-only. Rate-limited to 5 per minute per IP; up to 500 entries per pad.

### Pad & entries
- One pad per PO Box. Add, rename, reorder and remove entries. Renaming moves the entry's slug (anchor), never its delivery address.
- Removing an entry removes its delivery address and history (senders get 404); there's no archive or hiding.
- An entry body never contains an H1: the entry title is the H1, so headings inside a posted body move down a level.
- Tags; pin/favorite in-app.
- Search title, tags, current body.

### Ingest API
- Unique delivery address per entry: `POST /v1/ingest/{entry_id}`.
- Auth, per entry:
  - `Authorization: Bearer <entry token>` (default; write-only).
  - Token in the URL (`?token=`), opt-in, for senders that can only take a URL.
  - Webhook signature: HMAC-SHA256 of the raw body in a chosen header (GitHub, Gitea, Forgejo, Linear, Shopify); secret shown once, rotatable.
- Body formats, auto-detected: JSON (any `Content-Type`), `text/plain`/`text/markdown` as markdown, form fields (incl. GitHub's `payload=`).
- 256 KB cap. Every error is JSON with a `hint`.
- An identical re-post doesn't create a revision (`unchanged: true`).
- Optional `X-PostPad-Source` header labels the revision.
- *Open:* idempotency key; per-entry rate limits.

### Delivery rules
- Per entry: "only deliver when `key = value`" (include) and "never deliver when `key = value`" (exclude), on the posted JSON. Dot paths; several values per rule mean OR; include rules AND; exclude wins.
- A skipped post returns `200 {"skipped": true, "reason"}`, adds no revision, and is shown on the entry as "returned unopened" with the reason.
- Out of scope: if/else, other operators, transforms, routing. See [INGEST_FILTERS.md](INGEST_FILTERS.md).

### JSON → markdown
- Passthrough `{ "markdown" }` / `{ "body" }`.
- Text aliases: `text`, `message`, `summary`, `description`, or a bare JSON string.
- Status object → template: heading from `title`/`name`, a status line, the text, then leftover fields as a list and nested values as a JSON block (nothing silently dropped).
- First-party coding-agent payloads (Claude Code, Codex, Cursor, Gemini CLI, Copilot, Windsurf) render as one card: agent · project, finished / waiting for approval / error, final message. See [AGENTS.md](AGENTS.md).
- Markdown-only renderer; unsafe HTML stripped server-side.

### History & diffs
- Every successful ingest → revision (timestamp, source, raw JSON, rendered markdown).
- Diff latest vs previous (or any two).
- Restore = new revision copying old body (don’t rewrite history).

### Clients
- Tauri desktop + mobile targets, one shared UI (postal theme: [UI_SPEC.md](UI_SPEC.md)).
- Widgets are **first-class**: hybrid native extensions (WidgetKit / Glance) reading a shared cache. See [WIDGETS.md](WIDGETS.md).
- No notification permission required for core value.
- Files the user keeps (box key PDF, PO Box file) are saved through the native save dialog.

### Senders
- First-party integrations: Claude Code plugin + HTTP hooks, Codex lifecycle hooks, Cursor, Gemini CLI, Copilot CLI, GitHub Actions, Grok Bot ([GROKBOT_INTEGRATION.md](GROKBOT_INTEGRATION.md)).
- Agent hooks get a bare `{}` response so PostPad can never block or redirect an agent.

### Backend modes
- **Hosted**: official Cloudflare deployment (Workers + D1) at `api.postpad.dev`. Anyone can open a PO Box there (`OPEN_BOXES=true`).
- **Self-host**: the same Worker in your own Cloudflare account, or the same app in Docker (Node + SQLite).
- The client points at either via its **Post office** setting.

## Non-goals (v1)
- Human rich-text editing as primary authoring
- Push notifications, email digests, @mentions
- Real-time multiplayer editing
- Replacing Slack/email as a messaging bus
- Arbitrary plugin execution on the server
- Accounts, email login, password or key recovery
- End-to-end encryption: the post office renders what senders post, so its operator can read what's in the pad (self-host if that matters)

## Logical data model
- `Box`: id, key_hash, created_at
- `Entry`: id, box_id, title, slug, position, tags[], pinned, created_at, updated_at, current_revision_id, current_markdown, ingest_token_hash, ingest_filter, allow_url_token, signing_secret, signing_header, last_skipped_at, last_skip_reason
- `Revision` (per entry): id, entry_id, created_at, source, raw_json, rendered_markdown, content_hash
- `WidgetPin`: entry_id, device_id, sort, size (device-local; not built yet)
- The pad is not stored separately: it's a box's entries ordered by `position`.

## API sketch
```http
POST /v1/boxes                      (public if OPEN_BOXES, else Bearer <operator token>)
→ { box_id, key }

# /v1/pad and /v1/entries: Authorization: Bearer <box key>
GET    /v1/pad?since=               → { as_of, ids, entries } (full bodies; since = a previous as_of)
PUT    /v1/pad/order                { ids } in the new order
POST   /v1/entries                  → { id, slug, title, address, token }
GET    /v1/entries/{id}
PATCH  /v1/entries/{id}             title, tags, pinned, ingest_filter, allow_url_token, signing
DELETE /v1/entries/{id}             removes the entry, its delivery address and history
GET    /v1/entries/{id}/revisions
GET    /v1/entries/{id}/diff?from=&to=
POST   /v1/entries/{id}/restore/{rev}

POST /v1/ingest/{entry_id}
Authorization: Bearer <entry token>  (or ?token=, or a webhook signature)
→ { revision_id, updated_at, unchanged, markdown } | { skipped, reason } | {} for agent hooks
```

## Trust & safety
- Box keys and entry tokens are hashed at rest; entry tokens are write-only.
- Box isolation enforced by one ownership guard before every entry route.
- Token-in-URL is opt-in and warns that URLs get logged; signatures are verified in constant time.
- Size caps (256 KB per post, 500 entries per pad); rate limit on opening boxes.
- Avoid secrets in rendered markdown by default.
- *Open:* rotate/revoke per-entry tokens; revision retention policy; keep box key and entry tokens in the OS keychain instead of app storage.

## Backlog / later ideas

Captured from Hold & Talk → Grok Bot webhook on 2026-09-25:

- **Library include/exclude filters** — Simple include/exclude filtering (keywords / patterns) so noisy or irrelevant status stays out of glance views without deleting the note or turning off the writer. Justin’s follow-up (same day): include/exclude is probably enough for most users; defer richer if/else-style rules unless a real need shows up. *Clarified 2026-09-25: a per-note gate on incoming POSTs by JSON key; no hiding notes. **Built** as Delivery rules; see [INGEST_FILTERS.md](INGEST_FILTERS.md).*

- **Post-office visual branding** — Light blues/whites, legal-pad/lined paper, stamps, slightly skeuomorphic “envelopes that deliver to you.” Captured 2026-09-25 from Hold & Talk → Grok Bot; direction only. See [BRANDING.md](BRANDING.md). ***Built** as the postal UI shell; see [UI_SPEC.md](UI_SPEC.md).*

Known gaps (not scheduled):

- **Token rotation / revocation** for entry tokens (today: remove the entry and add a new one).
- **Staleness:** a "last delivery attempt" time so a dead sender is distinguishable from a steady status.
- **Widgets:** implement the native extensions per [WIDGETS.md](WIDGETS.md).
- **GitHub event cards:** render GitHub webhook events (workflow runs, PRs) as cards, like agent payloads.
- **QR code** on the box key PDF, for opening the box on a phone.
- **More signature schemes:** timestamped ones (Stripe, Slack).
