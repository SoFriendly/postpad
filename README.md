# PostPad

One running status pad, written by agents and services — not by you.

Add a sender and it gets a delivery address: an entry (a section under its own
heading) in your pad. Senders `POST` to it and the entry always shows their
**latest** status. Git-style history and diffs per entry. Pin entries to widgets.
No notifications.

## Product summary

- **One pad, many entries** — each sender or handed-out address owns one entry; a post rewrites that entry and leaves the rest of the pad alone. History keeps revisions.
- **No notifications** — glance via app + widgets only.
- **Free clients** — connect to hosted PostPad **or** a self-hosted backend.
- **Agents write, humans read** — humans add senders, search, pin, inspect diffs.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/WIDGETS.md](docs/WIDGETS.md), and [docs/BRANDING.md](docs/BRANDING.md).

## Repo layout

```
postpad/
  workers/api/     API: Cloudflare Worker (D1) or Docker/Node (SQLite), one Hono app
  integrations/    Agent integrations (Claude Code plugin; marketplace in .claude-plugin/)
  apps/desktop/    Tauri 2 app (React UI, desktop + mobile targets)
  docs/            Requirements, architecture, widgets, branding
```

## Stack

| Layer | Choice |
|------|--------|
| Client | Rust + Tauri 2, shared React UI (desktop + iOS/Android targets) |
| Backend | Cloudflare Workers + D1 |
| Hosting | Official hosted deploy **or** self-host the same Worker |
| Widgets | Hybrid native extensions — see [docs/WIDGETS.md](docs/WIDGETS.md) |

## Run the backend locally

```sh
cd workers/api
npm install
npm run migrate:local           # apply D1 schema to the local SQLite
npm run dev                      # wrangler dev on http://127.0.0.1:8787
npm test                         # pure-logic self-check (json->md, diff, sanitize)
```

Quick smoke test:

```sh
B=http://127.0.0.1:8787
# open a PO Box -> returns { box_id, key }
KEY=$(curl -s -X POST $B/v1/boxes | node -pe 'JSON.parse(require("fs").readFileSync(0)).key')
# add an entry -> returns { id, slug, address, token }
curl -s -X POST $B/v1/entries -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"title":"CI Deploy"}'
# a sender delivers (use the entry token); the latest post replaces the entry
curl -s -X POST $B/v1/ingest/<ID> -H 'authorization: Bearer <TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"status":"green","message":"build passed"}'
# read the whole pad
curl -s $B/v1/pad -H "authorization: Bearer $KEY"
```

### API

Your pad calls (`/v1/pad…`, `/v1/entries…`) send `Authorization: Bearer <box key>`
and only ever see that PO Box. Senders use the per-entry token on `/v1/ingest` instead.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/boxes` | open a PO Box → `{ box_id, key }` (key shown once) |
| GET | `/v1/pad?since=` | the pad: `{ as_of, ids, entries }` in order, full bodies; `since` (a previous `as_of`) returns only changed entries, `ids` is always the full order |
| PUT | `/v1/pad/order` | reorder: `{ "ids": [...] }`, every entry exactly once |
| POST | `/v1/entries` | add an entry → `{ id, slug, title, address, token }` (token shown once); appends to the pad |
| GET | `/v1/entries/:id` | entry + `address` + delivery rules + address settings |
| PATCH | `/v1/entries/:id` | `title` (moves the `slug`, never the address) / `tags` / `pinned` / `ingest_filter` (delivery rules) / `allow_url_token` / `signing` (address settings) |
| DELETE | `/v1/entries/:id` | remove the entry **and its delivery address** (and its history); senders then get 404 |
| GET | `/v1/entries/:id/revisions` | revision list |
| GET | `/v1/entries/:id/diff?from=&to=` | line diff (default: latest vs previous) |
| POST | `/v1/entries/:id/restore/:rev` | restore = new revision copying an old body |
| POST | `/v1/ingest/:id` | a sender delivers: replaces the entry, new revision |

### Ingest contract

Built for agents. POST whatever shape comes naturally; each POST **replaces** the
entry (latest wins) and becomes a revision. The rest of the pad is untouched.

```http
POST /v1/ingest/<entry id>
Authorization: Bearer <entry token>
Content-Type: application/json
X-PostPad-Source: grok-bot        # optional label shown in History
```

| Body | Renders as |
|------|-----------|
| `{"markdown": "..."}` or `{"body": "..."}` | that markdown (`""` clears the entry) |
| `{"text": "..."}` / `{"message": "..."}` / `{"summary": ...}` / `{"description": ...}` | that text |
| `{"title": "iOS", "status": "green", "message": "build 42 passed", "branch": "main"}` | `## iOS`, a **Status** line, the text, then leftover fields as a list |
| `"build green"` (a bare JSON string) | that string |
| anything else (arrays, nested objects) | a fenced JSON block, so nothing is silently dropped |

Behavior agents should know:
- **Response:** `{ revision_id, updated_at, unchanged, markdown }`, where `markdown` is exactly what the entry now shows.
- **No H1 in an entry:** the entry's title is its H1 in the pad, so if a body contains an H1, all its headings move down one level (code blocks untouched).
- **Identical re-posts are free:** if the rendered markdown matches the current revision, no new revision is written (`"unchanged": true`), so a cron agent can post every few minutes without cluttering history.
- **Delivery rules can skip a POST:** an entry can say "only deliver when `status = failed`" or "never deliver when `status = heartbeat`" (keys in the posted JSON; [docs/INGEST_FILTERS.md](docs/INGEST_FILTERS.md)). A skipped POST gets `200 {"skipped": true, "reason": "..."}` and doesn't change the entry. It isn't an error, so don't retry.
- **Errors are JSON with a `hint`:** e.g. `{"error":"invalid token","hint":"..."}` (401), `{"error":"body is not valid JSON","hint":"..."}` (400), or 413 over 256KB.
- **Body formats are auto-detected; there's no per-entry setting:**
  - JSON is accepted whatever the `Content-Type`.
  - `text/plain` or `text/markdown` becomes the entry's markdown. `curl -d 'build green'` works too.
  - Form fields (`application/x-www-form-urlencoded`) become JSON, including GitHub's `payload=<json>` form style.
- **Auth, for senders that can't set `Authorization`** (per entry, under **Address settings**; both off by default):
  - **Token in URL:** `POST …/v1/ingest/<id>?token=<entry token>`, for senders that only take a URL. URLs can end up in logs.
  - **Webhook signature:** the entry gets a signing secret (shown once) and a header name. The sender puts the HMAC-SHA256 of the raw body there, as hex or base64, optionally prefixed `sha256=`. That's GitHub's `X-Hub-Signature-256`, Gitea, Forgejo, Linear and Shopify. API: `PATCH {"signing": {"header": "X-Hub-Signature-256"}}` returns `signing_secret`; `{"rotate": true}` issues a new one; `null` turns it off.
  - A bearer header, if present, always takes precedence. Timestamped schemes (Stripe, Slack) aren't supported yet.
- **Unsafe HTML** (`<script>`, event handlers, `javascript:`) is stripped server-side.

## Coding agents (Claude Code, Codex, Cursor, Gemini, Copilot)

First-party: an agent's hook POSTs its native event JSON to its entry, and PostPad
renders a clean card, e.g. **"✅ Claude Code · postpad: Finished"** plus its final
message, or **"⏳ Waiting for your approval"**. Add a sender in the app for a
filled-in snippet. For Claude Code, it's a plugin:

```text
/plugin marketplace add SoFriendly/postpad
/plugin install postpad@postpad
```

Per-agent setup, event choices and what's been live-tested: [docs/AGENTS.md](docs/AGENTS.md).

## Grok Bot (and other agents) keeping an entry updated

Agents are PostPad's primary writers. For Grok Bot:

1. In the app, add a sender (e.g. "Crosspoint iOS").
2. Under **Connect a sender**, pick **Grok Bot / any agent (prompt)**, copy it, and paste it into a Grok Bot routine or standing
   instructions. It already contains the delivery address and token.
3. Grok Bot POSTs the current status whenever it changes. Its entry, and later its widget, always show the latest. No notifications.

To keep the token out of the prompt, store `POSTPAD_STATUS_URL` and
`POSTPAD_STATUS_TOKEN` as Grok Bot secrets and reference those instead. Full
details, including routing Grok Bot's own webhooks into PostPad, are in
[docs/GROKBOT_INTEGRATION.md](docs/GROKBOT_INTEGRATION.md).

```sh
curl -X POST "$POSTPAD_STATUS_URL" \
  -H "Authorization: Bearer $POSTPAD_STATUS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-PostPad-Source: grok-bot" \
  -d '{"markdown":"## Crosspoint iOS\n- Simulator build: green\n- Next: TestFlight upload"}'
```

## PO Boxes: no accounts

There's no signup and no login. Your pad lives in a **PO Box** at the post
office (the backend), and a random 256-bit **box key**, stored on the server only as
a hash, is the only way in.

- **First launch:** the app asks for a box key or a PO Box file. New users choose **Open a new PO Box**, get the key with **Copy** and **Download PDF** (a printout explaining what it's for), and confirm they've saved it before continuing.
- **More devices:** enter the key (typed from the PDF works: spaces and line breaks are ignored), or use ⚙ → **Export PO Box file**. That's an encrypted JSON (PBKDF2-SHA256 → AES-256-GCM, your passphrase) with the post office, key and delivery tokens; import it from the welcome screen.
- **Isolation:** every read and manage call is scoped to the key's box. One guard runs before every entry route, so another box's entry id returns 404. Test: `workers/api/test/api.test.ts` → "a key only ever reaches its own pad".
- **Lost key:** there's no recovery by design. Open a new PO Box and point your senders at the new delivery addresses.
- **Senders** never see the box key; per-entry tokens can only write.
- **What it doesn't hide:** the server renders what writers post, so whoever runs the post office (hosted: PostPad on Cloudflare) can read what's in your pad. Self-host if that matters.

## Hosted backend

Hosted PostPad runs at **`https://api.postpad.dev`** (custom domain on the
`postpad-api` Worker). `postpad.dev` itself is reserved for the landing page and
`app.postpad.dev` for a possible web client. To redeploy: `cd workers/api &&
npm run deploy` (and `npm run migrate:remote` when migrations change).
Anyone can open a PO Box there: it's set as the `OPEN_BOXES=true` secret, rate-limited to 5 new
boxes per minute per IP.

## Self-host the backend

Two options, same API and same schema. Point the app's **⚙ Settings → Backend
base URL** at whichever you run.

### Option A: Docker (any server)

The same app on Node with a SQLite file in a volume. No Cloudflare account needed.

```sh
docker run -d --name postpad -p 8787:8787 \
  -v postpad-data:/data \
  -e ADMIN_TOKEN="$(openssl rand -hex 32)" \
  -e PUBLIC_URL=https://postpad.example.com \
  ghcr.io/sofriendly/postpad-api:latest
docker logs postpad            # "postpad api listening on :8787"
```

| Env | Default | Purpose |
|-----|---------|---------|
| `ADMIN_TOKEN` | *(unset = open)* | The operator's token: it can open PO Boxes while opening is closed. It isn't a box and can't read anyone's pad. Unset = anyone who can reach the server can open a box. **Set it on anything internet-facing.** |
| `OPEN_BOXES` | *(unset = closed)* | `true` lets anyone open a PO Box, as hosted PostPad does. Closed: only `ADMIN_TOKEN` can open them. |
| `PUBLIC_URL` | request origin | Origin used in ingest URLs; set it when behind a TLS reverse proxy. |
| `DB_PATH` | `/data/postpad.db` | SQLite file; keep `/data` on a volume. |
| `PORT` | `8787` | Listen port. |

Migrations apply automatically on start. Back up by copying the volume's
`postpad.db*` files. Build it yourself with `docker build -t postpad-api workers/api`,
or run without Docker: `cd workers/api && npm ci --omit=dev && node src/node.ts` (Node 24+).

### Option B: your own Cloudflare account

From `workers/api`:

```sh
npx wrangler login                        # opens a browser to authorize
npx wrangler d1 create postpad            # copy the printed database_id
#   -> replace database_id in wrangler.toml with yours
#   -> delete the `routes` block (or point it at a zone you own)
npm run migrate:remote                    # apply schema to the remote D1
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN   # required when internet-facing
# optional: let anyone open a PO Box (hosted PostPad does this; default is operator-only)
#   echo true | npx wrangler secret put OPEN_BOXES
npm run deploy                            # -> https://postpad-api.<subdomain>.workers.dev
```

Clients just point at your Worker URL. See `.dev.vars.example` for local secrets.

## Run the app

```sh
cd apps/desktop
npm install
npm run tauri dev          # desktop window; point Settings (⚙) at your backend
```

On first launch the app asks for your box key or PO Box file, or opens a new PO Box.
The post office defaults to `https://api.postpad.dev`; change it under **Post office**
on the welcome screen for a self-hosted server (or `http://127.0.0.1:8787` for local dev).
**⚙ Your PO Box** shows the key (Copy / Download PDF), exports the PO Box file, and can
forget the key to switch boxes. If a post office doesn't open boxes for the public, its
operator mints a key for you: `curl -X POST <server>/v1/boxes -H "Authorization: Bearer <ADMIN_TOKEN>"`.

Mobile targets (Tauri 2): `npm run tauri ios init` / `android init`, then
`npm run tauri ios dev` / `android dev`. Requires Xcode / Android SDK.

## Status

Working vertical slice: Worker API (D1 or Docker/SQLite), Tauri app with the pad
(entries, delivery addresses, history + diff, delivery rules, address settings,
PO Box welcome flow). Widgets
are researched and specced ([docs/WIDGETS.md](docs/WIDGETS.md)) but not yet built —
they need native extensions, not more API work.

## License

MIT, see [LICENSE](LICENSE). Clients are free, and you can self-host the same backend
(Cloudflare or Docker) or use hosted PostPad at `api.postpad.dev`.
