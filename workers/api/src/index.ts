import { Hono } from "hono";
import { cors } from "hono/cors";
import { renderMarkdown, lineDiff, sha256hex, ingestAllowed, parseRuleSet, parseBody, verifySignature, slugify } from "./lib.ts";
import { isAgentEvent } from "./agents.ts";

// PostPad is one running pad per PO Box. Each delivery address is an entry (a section
// under its own H1); a post to the address rewrites that entry, latest wins.

type Bindings = {
  DB: D1Database;
  // The operator's token: it can open PO Boxes when opening is closed. It is not a
  // box and can't read the pad. Unset = anyone can open a box (local dev).
  ADMIN_TOKEN?: string;
  // "true" lets anyone open a PO Box (hosted PostPad). Default: only the operator can.
  OPEN_BOXES?: string;
  // Optional Cloudflare rate-limit binding on opening boxes (wrangler.toml).
  BOX_RATE_LIMIT?: RateLimit;
  // Optional: public origin for delivery addresses when behind a reverse proxy (e.g. https://postpad.example.com).
  PUBLIC_URL?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: { box: string } }>();
app.use("*", cors());

const now = () => new Date().toISOString();
// URL-safe random id/token. crypto.randomUUID is fine for ids; tokens want more entropy.
const id = () => crypto.randomUUID().replace(/-/g, "");
const token = () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

const json = (v: unknown) => JSON.stringify(v);
const origin = (c: any): string => (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, "");
const address = (c: any, entryId: string) => `${origin(c)}/v1/ingest/${entryId}`;
const parseTags = (s: string): string[] => { try { return JSON.parse(s); } catch { return []; } };
// Agent-facing: every error says how to fix it, since the caller is usually a bot
// whose only debugging tool is the response body.
const fail = (c: any, status: number, error: string, hint: string) => c.json({ error, hint }, status);
function bearer(req: Request): string | null {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// --- PO Boxes: the key is the identity --------------------------------------
// No accounts. Pad calls present a box key; everything they touch is scoped to that
// box. Ingest never uses it (senders hold a per-entry token and can't read).
for (const path of ["/v1/pad", "/v1/pad/*", "/v1/entries", "/v1/entries/*"]) app.use(path, boxAuth);
async function boxAuth(c: any, next: any) {
  const key = bearer(c.req.raw);
  if (!key) return fail(c, 401, "missing box key", "Send 'Authorization: Bearer <box key>'. In the PostPad app: enter your box key, import your PO Box file, or open a new box.");
  if (c.env.ADMIN_TOKEN && key === c.env.ADMIN_TOKEN)
    return fail(c, 401, "operator token isn't a PO Box", "The operator token only opens boxes (POST /v1/boxes). Use the box key it returns.");
  const box = await c.env.DB.prepare(`SELECT id FROM boxes WHERE key_hash=?`).bind(await sha256hex(key)).first();
  if (!box) return fail(c, 401, "unknown box key", "This key doesn't open a PO Box at this post office. Check the post office address and key, or open a new box.");
  c.set("box", box.id);
  return next();
}

// Ownership guard for every entry-scoped route (/v1/entries/:id and below): one check,
// before any handler, so no route can leak another box's entry. Foreign ids 404.
const ownEntry = async (c: any, next: any) => {
  const own = await c.env.DB.prepare(`SELECT 1 FROM entries WHERE id=? AND box_id=?`).bind(c.req.param("id"), c.get("box")).first();
  return own ? next() : fail(c, 404, "entry not found", "No entry with this id in your pad.");
};
app.use("/v1/entries/:id", ownEntry);
app.use("/v1/entries/:id/*", ownEntry);

// Open a PO Box. Hosted: anyone (rate-limited). Otherwise: the operator only.
app.post("/v1/boxes", async (c) => {
  const admin = c.env.ADMIN_TOKEN;
  const allowed = c.env.OPEN_BOXES === "true" || !admin || bearer(c.req.raw) === admin;
  if (!allowed) return fail(c, 403, "box opening is closed", "This post office's operator hands out box keys. Ask them for one, or self-host your own PostPad.");
  if (c.env.BOX_RATE_LIMIT) {
    const { success } = await c.env.BOX_RATE_LIMIT.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" });
    if (!success) return fail(c, 429, "too many new boxes", "Wait a minute and try again.");
  }
  const boxId = id(), key = `ppb_${token()}`;
  await c.env.DB.prepare(`INSERT INTO boxes (id,key_hash,created_at) VALUES (?,?,?)`).bind(boxId, await sha256hex(key), now()).run();
  return c.json({ box_id: boxId, key }, 201); // the key is shown once; only its hash is stored
});

// --- The pad ------------------------------------------------------------------
// Every entry with its full body, in pad order. ?since=<as_of from the last call>
// returns only entries that changed; `ids` is always the full order, so clients
// drop entries that disappeared and follow reorders without refetching bodies.
app.get("/v1/pad", async (c) => {
  const box = c.get("box"), since = c.req.query("since"), asOf = now();
  const [ids, changed] = await c.env.DB.batch<any>([
    c.env.DB.prepare(`SELECT id FROM entries WHERE box_id=? ORDER BY position`).bind(box),
    c.env.DB.prepare(
      `SELECT e.id,e.slug,e.title,e.position,e.tags,e.pinned,e.updated_at,e.current_markdown,r.source
         FROM entries e LEFT JOIN revisions r ON r.id = e.current_revision_id
        WHERE e.box_id=? AND e.updated_at > ? ORDER BY e.position`
    ).bind(box, since ?? ""),
  ]);
  return c.json({
    as_of: asOf,
    ids: ids.results.map((r: any) => r.id),
    entries: changed.results.map((r: any) => ({
      id: r.id, slug: r.slug, title: r.title, position: r.position, tags: parseTags(r.tags),
      pinned: !!r.pinned, updated_at: r.updated_at, markdown: r.current_markdown, source: r.source,
      address: address(c, r.id), // so "copy address" never needs a fetch first (WebKit drops clipboard access after an await)
    })),
  });
});

// Reorder the pad: the full list of the box's entry ids, in the new order.
app.put("/v1/pad/order", async (c) => {
  const box = c.get("box");
  const { ids } = await c.req.json().catch(() => ({ ids: null }));
  const { results } = await c.env.DB.prepare(`SELECT id FROM entries WHERE box_id=?`).bind(box).all<any>();
  const mine = new Set(results.map((r) => r.id));
  if (!Array.isArray(ids) || ids.length !== mine.size || new Set(ids).size !== ids.length || !ids.every((x) => mine.has(x)))
    return fail(c, 400, "invalid order", "Send {\"ids\": [...]} listing every entry id in your pad exactly once, in the new order.");
  if (ids.length) await c.env.DB.batch(ids.map((e: string, i: number) =>
    c.env.DB.prepare(`UPDATE entries SET position=? WHERE id=? AND box_id=?`).bind(i, e, box)));
  return c.json({ ok: true });
});

// --- Entries --------------------------------------------------------------------
// Adding a sender or handing out an address = adding an entry at the end of the pad.
const MAX_ENTRIES_PER_BOX = 500; // ponytail: flat cap against abuse; per-plan limits if hosted gets billing

// Slug for anchors, unique within the box ("deploys", "deploys-2", ...).
// ponytail: two concurrent adds with the same title can race to one slug and 500; retry if that ever shows up.
async function uniqueSlug(c: any, title: string, except = "") {
  const base = slugify(title);
  const { results } = await c.env.DB.prepare(`SELECT slug FROM entries WHERE box_id=? AND id<>? AND (slug=? OR slug LIKE ?)`)
    .bind(c.get("box"), except, base, `${base}-%`).all();
  const taken = new Set(results.map((r: any) => r.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

app.post("/v1/entries", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = (typeof body.title === "string" && body.title.trim()) || "Untitled";
  const tags: string[] = Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === "string") : [];
  const box = c.get("box");
  const { n } = (await c.env.DB.prepare(`SELECT count(*) AS n FROM entries WHERE box_id=?`).bind(box).first<any>())!;
  if (n >= MAX_ENTRIES_PER_BOX) return fail(c, 403, "pad is full", `A pad holds up to ${MAX_ENTRIES_PER_BOX} entries. Remove entries you no longer use.`);
  const entryId = id(), tok = token(), t = now(), slug = await uniqueSlug(c, title);
  await c.env.DB.prepare(
    `INSERT INTO entries (id,box_id,title,slug,position,tags,created_at,updated_at,ingest_token_hash)
     VALUES (?,?,?,?,(SELECT COALESCE(MAX(position), -1) + 1 FROM entries WHERE box_id=?),?,?,?,?)`
  ).bind(entryId, box, title, slug, box, json(tags), t, t, await sha256hex(tok)).run();
  return c.json({ id: entryId, slug, title, tags, address: address(c, entryId), token: tok }, 201); // token shown once
});

app.get("/v1/entries/:id", async (c) => {
  const r = (await c.env.DB.prepare(
    `SELECT e.*, rv.source FROM entries e LEFT JOIN revisions rv ON rv.id = e.current_revision_id WHERE e.id=?`
  ).bind(c.req.param("id")).first<any>())!;
  return c.json({
    id: r.id, slug: r.slug, title: r.title, position: r.position, tags: parseTags(r.tags), pinned: !!r.pinned,
    created_at: r.created_at, updated_at: r.updated_at, current_revision_id: r.current_revision_id,
    markdown: r.current_markdown, source: r.source, address: address(c, r.id),
    ingest_filter: r.ingest_filter ? JSON.parse(r.ingest_filter) : null,
    last_skipped_at: r.last_skipped_at, last_skip_reason: r.last_skip_reason,
    allow_url_token: !!r.allow_url_token,
    signing: r.signing_secret ? { header: r.signing_header } : null, // the secret itself is only returned when set
  });
});

// Rename / tags / pin / delivery rules / address settings.
app.patch("/v1/entries/:id", async (c) => {
  const entryId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [], binds: any[] = [];
  if (typeof body.title === "string" && body.title.trim()) {
    // The slug follows the title (anchors move); the delivery address never does.
    sets.push("title=?", "slug=?"); binds.push(body.title.trim(), await uniqueSlug(c, body.title, entryId));
  }
  if (Array.isArray(body.tags)) { sets.push("tags=?"); binds.push(json(body.tags.filter((t: unknown) => typeof t === "string"))); }
  if (typeof body.pinned === "boolean") { sets.push("pinned=?"); binds.push(body.pinned ? 1 : 0); }
  const touched = sets.length > 0; // updated_at means "the entry changed", not "its rules changed"
  if ("ingest_filter" in body) {
    const rules = body.ingest_filter === null ? null : parseRuleSet(body.ingest_filter);
    if (typeof rules === "string") return fail(c, 400, "invalid ingest_filter", rules);
    const empty = !rules || rules.include.length + rules.exclude.length === 0;
    sets.push("ingest_filter=?"); binds.push(empty ? null : json(rules));
  }
  if (typeof body.allow_url_token === "boolean") { sets.push("allow_url_token=?"); binds.push(body.allow_url_token ? 1 : 0); }
  // Webhook signing: null turns it off; {header, secret?, rotate?} turns it on. The secret is
  // generated unless supplied, and returned once, like the entry token.
  let signingSecret: string | undefined;
  if ("signing" in body) {
    const sg = body.signing;
    if (sg === null) sets.push("signing_secret=NULL", "signing_header=NULL");
    else {
      const header = typeof sg?.header === "string" ? sg.header.trim() : "X-Hub-Signature-256";
      if (!/^[A-Za-z0-9-]{1,100}$/.test(header)) return fail(c, 400, "invalid signing header", "Use the header name your sender puts the signature in, e.g. X-Hub-Signature-256.");
      if (sg?.secret !== undefined && (typeof sg.secret !== "string" || sg.secret.length < 16 || sg.secret.length > 200))
        return fail(c, 400, "invalid signing secret", "Use 16–200 characters, or omit it and PostPad generates one.");
      const cur = (await c.env.DB.prepare(`SELECT signing_secret FROM entries WHERE id=?`).bind(entryId).first<any>())!;
      if (sg?.secret) signingSecret = sg.secret;
      else if (sg?.rotate || !cur.signing_secret) signingSecret = token();
      sets.push("signing_header=?"); binds.push(header);
      if (signingSecret) { sets.push("signing_secret=?"); binds.push(signingSecret); }
    }
  }
  if (!sets.length) return fail(c, 400, "nothing to update", "Send title, tags, pinned, ingest_filter, allow_url_token or signing.");
  if (touched) { sets.push("updated_at=?"); binds.push(now()); }
  await c.env.DB.prepare(`UPDATE entries SET ${sets.join(",")} WHERE id=?`).bind(...binds, entryId).run();
  return c.json(signingSecret ? { ok: true, signing_secret: signingSecret } : { ok: true });
});

// Removing an entry removes its delivery address; its revisions go with it (ON DELETE
// CASCADE). Senders still posting get a 404 whose hint says the address is gone.
app.delete("/v1/entries/:id", async (c) => {
  await c.env.DB.prepare(`DELETE FROM entries WHERE id=?`).bind(c.req.param("id")).run();
  return c.json({ deleted: true });
});

// --- Revisions (per entry) --------------------------------------------------------
app.get("/v1/entries/:id/revisions", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id,created_at,source,content_hash FROM revisions WHERE entry_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200`
  ).bind(c.req.param("id")).all<any>();
  return c.json(results);
});

app.get("/v1/entries/:id/revisions/:rev", async (c) => {
  const r = await c.env.DB.prepare(`SELECT * FROM revisions WHERE id=? AND entry_id=?`)
    .bind(c.req.param("rev"), c.req.param("id")).first<any>();
  if (!r) return fail(c, 404, "revision not found", "List this entry's revisions for valid ids.");
  return c.json(r);
});

// Restore: copy an old body into a new revision (history is immutable).
app.post("/v1/entries/:id/restore/:rev", async (c) => {
  const entryId = c.req.param("id");
  const old = await c.env.DB.prepare(`SELECT raw_json,rendered_markdown FROM revisions WHERE id=? AND entry_id=?`)
    .bind(c.req.param("rev"), entryId).first<any>();
  if (!old) return fail(c, 404, "revision not found", "List this entry's revisions for valid ids.");
  const revId = id(), t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO revisions (id,entry_id,created_at,source,raw_json,rendered_markdown,content_hash) VALUES (?,?,?,?,?,?,?)`)
      .bind(revId, entryId, t, "restore", old.raw_json, old.rendered_markdown, await sha256hex(old.rendered_markdown)),
    c.env.DB.prepare(`UPDATE entries SET current_revision_id=?, current_markdown=?, updated_at=? WHERE id=?`)
      .bind(revId, old.rendered_markdown, t, entryId),
  ]);
  return c.json({ revision_id: revId, updated_at: t });
});

// Diff between two revision ids; default = latest vs previous.
app.get("/v1/entries/:id/diff", async (c) => {
  const entryId = c.req.param("id");
  let from = c.req.query("from"), to = c.req.query("to");
  if (!from || !to) {
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM revisions WHERE entry_id=? ORDER BY created_at DESC, rowid DESC LIMIT 2`
    ).bind(entryId).all<any>();
    if (results.length < 2) return fail(c, 400, "need at least two revisions", "Diff needs this entry to have been delivered twice.");
    to = to ?? results[0].id;
    from = from ?? results[1].id;
  }
  const [a, b] = await c.env.DB.batch<any>([
    c.env.DB.prepare(`SELECT rendered_markdown FROM revisions WHERE id=? AND entry_id=?`).bind(from, entryId),
    c.env.DB.prepare(`SELECT rendered_markdown FROM revisions WHERE id=? AND entry_id=?`).bind(to, entryId),
  ]);
  const fromMd = a.results[0]?.rendered_markdown, toMd = b.results[0]?.rendered_markdown;
  if (fromMd == null || toMd == null) return fail(c, 404, "revision not found", "List this entry's revisions for valid ids.");
  return c.json({ from, to, diff: lineDiff(fromMd, toMd) });
});

// --- Ingest: a sender rewrites its entry ------------------------------------------
const MAX_BODY = 256 * 1024;

app.post("/v1/ingest/:id", async (c) => {
  const entryId = c.req.param("id");
  const entry = await c.env.DB.prepare(
    `SELECT e.ingest_token_hash, e.current_revision_id, e.ingest_filter, e.allow_url_token,
            e.signing_secret, e.signing_header, r.content_hash
       FROM entries e LEFT JOIN revisions r ON r.id = e.current_revision_id
      WHERE e.id=?`
  ).bind(entryId).first<any>();
  if (!entry) return fail(c, 404, "entry not found", "Check the entry id in the delivery address. If the entry was removed, its address is gone: remove this sender or point it at a new address.");

  // Read the raw bytes first: webhook signatures are computed over them.
  const tooBig = () => fail(c, 413, "payload too large", `Keep the body under ${MAX_BODY / 1024}KB; send a summary, not logs.`);
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return tooBig();
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_BODY) return tooBig();

  // Auth, in order: bearer header; ?token= if the entry allows it; the entry's webhook signature.
  const urlToken = new URL(c.req.url).searchParams.get("token");
  const tok = bearer(c.req.raw) ?? (entry.allow_url_token ? urlToken : null);
  if (tok) {
    if ((await sha256hex(tok)) !== entry.ingest_token_hash)
      return fail(c, 401, "invalid token", "This token doesn't match the entry. Tokens are per-entry and shown once when the address is created.");
  } else if (entry.signing_secret) {
    const sig = c.req.header(entry.signing_header);
    if (!sig) return fail(c, 401, "missing signature", `Send the HMAC-SHA256 of the body in '${entry.signing_header}', or 'Authorization: Bearer <entry token>'.`);
    if (!(await verifySignature(entry.signing_secret, bytes, sig)))
      return fail(c, 401, "invalid signature", "The signature doesn't match this entry's signing secret. Check the secret configured at the sender.");
  } else if (urlToken) {
    return fail(c, 401, "token in URL is disabled", "Send 'Authorization: Bearer <entry token>', or enable 'token in URL' in the entry's address settings.");
  } else {
    return fail(c, 401, "missing bearer token", "Send header 'Authorization: Bearer <entry token>'.");
  }

  const raw = parseBody(new TextDecoder().decode(bytes), c.req.header("content-type") ?? "");
  if (raw === undefined)
    return fail(c, 400, "unsupported body", 'Send JSON (e.g. {"markdown":"..."}), plain text with Content-Type: text/plain, or form fields.');
  if (raw === null) return fail(c, 400, "body is null", 'Send a JSON object, e.g. {"text":"build green"}.');
  const rawJson = JSON.stringify(raw); // text/form bodies are stored normalized, so revisions' raw_json is always JSON

  // Agent hook runners parse the response as hook output (Claude Code: `decision`,
  // `continue`; Cursor: `followup_message`) and don't document unknown keys, so
  // agent hooks get a bare `{}`: success, no effect on the agent.
  const reply = (body: object) => c.json(isAgentEvent(raw) ? {} : body);

  // Delivery rules: a post that doesn't qualify is returned unopened. The entry is
  // untouched (no revision), but records why, so a quiet entry is explainable.
  // 200, not an error: senders shouldn't retry.
  const gate = ingestAllowed(raw, entry.ingest_filter ? JSON.parse(entry.ingest_filter) : null);
  if (!gate.ok) {
    await c.env.DB.prepare(`UPDATE entries SET last_skipped_at=?, last_skip_reason=? WHERE id=?`).bind(now(), gate.reason, entryId).run();
    return reply({ skipped: true, reason: gate.reason });
  }

  const source = c.req.header("x-postpad-source") ?? c.req.header("user-agent") ?? null;
  const markdown = renderMarkdown(raw, source ?? undefined);
  const hash = await sha256hex(markdown);
  // Latest wins, but an identical re-post (e.g. a cron agent) doesn't bloat history.
  if (hash === entry.content_hash)
    return reply({ revision_id: entry.current_revision_id, unchanged: true, markdown });

  const revId = id(), t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO revisions (id,entry_id,created_at,source,raw_json,rendered_markdown,content_hash) VALUES (?,?,?,?,?,?,?)`)
      .bind(revId, entryId, t, source, rawJson, markdown, hash),
    c.env.DB.prepare(`UPDATE entries SET current_revision_id=?, current_markdown=?, updated_at=? WHERE id=?`)
      .bind(revId, markdown, t, entryId),
  ]);
  return reply({ revision_id: revId, updated_at: t, unchanged: false, markdown });
});

app.get("/", (c) => c.json({ service: "postpad", ok: true }));
app.notFound((c) => fail(c, 404, "no such route", "Deliveries are POST /v1/ingest/<entry id>; your pad is GET /v1/pad. See the PostPad README for the API."));
app.onError((err, c) => { console.error(err); return fail(c, 500, "internal error", "Retry later; if it persists, check the server logs."); });

export default app;
