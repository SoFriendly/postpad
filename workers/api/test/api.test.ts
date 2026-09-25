// End-to-end API check on the node:sqlite shim (the Docker runtime path).
import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";
import { openDb } from "../src/sqlite.ts";

const env = { DB: openDb(":memory:", new URL("../migrations", import.meta.url).pathname), ADMIN_TOKEN: "admin" };
// The operator token only opens boxes; every test works inside a real PO Box.
const openBox = (e: object = env) => app.fetch(new Request("http://x/v1/boxes", { method: "POST", headers: { authorization: "Bearer admin" } }), e)
  .then((r) => r.json()).then((j: any) => j.key as string);
const BOX = await openBox();
const call = async (method: string, path: string, body?: unknown, token = BOX) => {
  const res = await app.fetch(new Request(`http://x${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: res.status, json: await res.json() as any };
};

test("add entry, deliver, replace, diff, restore", async () => {
  assert.equal((await call("GET", "/v1/pad", undefined, "wrong")).status, 401);

  const { json: entry } = await call("POST", "/v1/entries", { title: "CI", tags: ["ci"] });
  assert.equal(entry.address, `http://x/v1/ingest/${entry.id}`);

  assert.equal((await call("POST", `/v1/ingest/${entry.id}`, { body: "x" }, "bad")).status, 401);
  await call("POST", `/v1/ingest/${entry.id}`, { status: "green" }, entry.token);
  await call("POST", `/v1/ingest/${entry.id}`, { markdown: "# red" }, entry.token);
  const again = await call("POST", `/v1/ingest/${entry.id}`, { markdown: "# red" }, entry.token);
  assert.equal(again.json.unchanged, true); // identical re-post: no new revision

  const { json: cur } = await call("GET", `/v1/entries/${entry.id}`);
  assert.equal(cur.markdown, "## red"); // the entry title is the H1, so the body's H1 moves down

  const { json: revs } = await call("GET", `/v1/entries/${entry.id}/revisions`);
  assert.equal(revs.length, 2);
  const { json: d } = await call("GET", `/v1/entries/${entry.id}/diff`);
  assert.ok(d.diff.some((l: any) => l.op === "+" && l.text === "## red"));

  await call("POST", `/v1/entries/${entry.id}/restore/${revs[1].id}`);
  assert.match((await call("GET", `/v1/entries/${entry.id}`)).json.markdown, /green/);
});

test("the pad: order, slugs, incremental fetch, reorder, rename", async () => {
  const key = await openBox();
  const as = (method: string, path: string, body?: unknown) => call(method, path, body, key);
  const a = (await as("POST", "/v1/entries", { title: "Deploys" })).json;
  const b = (await as("POST", "/v1/entries", { title: "Deploys" })).json;
  const c = (await as("POST", "/v1/entries", { title: "Claude Code" })).json;
  assert.deepEqual([a.slug, b.slug, c.slug], ["deploys", "deploys-2", "claude-code"]);

  const pad = (await as("GET", "/v1/pad")).json;
  assert.deepEqual(pad.ids, [a.id, b.id, c.id]); // new entries append at the end
  assert.deepEqual(pad.entries.map((e: any) => e.position), [0, 1, 2]);
  assert.deepEqual(pad.entries.map((e: any) => e.address), [a.address, b.address, c.address]);

  // One sender delivers; ?since= returns just that entry, with who wrote it.
  await new Promise((r) => setTimeout(r, 5));
  await app.fetch(new Request(`http://x/v1/ingest/${c.id}`, {
    method: "POST", headers: { authorization: `Bearer ${c.token}`, "x-postpad-source": "claude-code" },
    body: JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: "/w/postpad", last_assistant_message: "Done." }),
  }), env);
  const delta = (await as("GET", `/v1/pad?since=${encodeURIComponent(pad.as_of)}`)).json;
  assert.deepEqual(delta.ids, [a.id, b.id, c.id]);
  assert.deepEqual(delta.entries.map((e: any) => [e.id, e.source]), [[c.id, "claude-code"]]);
  assert.match(delta.entries[0].markdown, /^## ✅ Claude Code · postpad/);

  // Reorder: the full id list only.
  assert.equal((await as("PUT", "/v1/pad/order", { ids: [c.id, a.id] })).json.error, "invalid order");
  assert.equal((await as("PUT", "/v1/pad/order", { ids: [c.id, a.id, a.id] })).json.error, "invalid order");
  await as("PUT", "/v1/pad/order", { ids: [c.id, a.id, b.id] });
  assert.deepEqual((await as("GET", "/v1/pad")).json.ids, [c.id, a.id, b.id]);

  // Rename moves the anchor, never the address.
  await as("PATCH", `/v1/entries/${b.id}`, { title: "Staging deploys" });
  const renamed = (await as("GET", `/v1/entries/${b.id}`)).json;
  assert.equal(renamed.slug, "staging-deploys");
  assert.equal(renamed.address, b.address);

  // Removing an entry takes its revisions with it (ON DELETE CASCADE).
  await as("DELETE", `/v1/entries/${c.id}`);
  assert.deepEqual((await as("GET", "/v1/pad")).json.ids, [a.id, b.id]);
  const left = await env.DB.prepare(`SELECT count(*) AS n FROM revisions WHERE entry_id=?`).bind(c.id).first<any>();
  assert.equal(left.n, 0);
});

test("PUBLIC_URL overrides the delivery address origin", async () => {
  const res = await app.fetch(new Request("http://internal:8787/v1/entries", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${BOX}` }, body: "{}",
  }), { ...env, PUBLIC_URL: "https://pp.example.com/" });
  assert.match(((await res.json()) as any).address, /^https:\/\/pp\.example\.com\/v1\/ingest\//);
});

test("ingest errors carry actionable hints", async () => {
  const { json: entry } = await call("POST", "/v1/entries", { title: "hints" });
  const raw = (body: string, token = entry.token) => app.fetch(new Request(`http://x/v1/ingest/${entry.id}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body,
  }), env).then(async (r) => ({ status: r.status, json: await r.json() as any }));

  const text = await raw("deploy is **green**"); // text/plain is accepted as markdown
  assert.equal(text.status, 200);
  assert.equal(text.json.markdown, "deploy is **green**");
  const bad = await app.fetch(new Request(`http://x/v1/ingest/${entry.id}`, {
    method: "POST", headers: { authorization: `Bearer ${entry.token}`, "content-type": "application/json" }, body: "{oops",
  }), env);
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).hint, /Send JSON/);
  assert.equal((await raw('{"text":"x"}', "nope")).json.error, "invalid token");
  // Content-Type isn't enforced: valid JSON is accepted regardless of the header.
  assert.equal((await raw('{"text":"from a sloppy client"}')).status, 200);
  assert.equal((await call("GET", "/nope")).json.error, "no such route");
});

test("delivery rules: returned-unopened posts leave the entry untouched and say why", async () => {
  const { json: entry } = await call("POST", "/v1/entries", { title: "filtered" });
  const post = (body: unknown) => call("POST", `/v1/ingest/${entry.id}`, body, entry.token);
  assert.equal((await call("PATCH", `/v1/entries/${entry.id}`, { ingest_filter: { exclude: [{ key: "status", equals: ["x"] }], include: "nope" } })).json.error, "invalid ingest_filter");
  assert.equal((await call("PATCH", `/v1/entries/${entry.id}`, { ingest_filter: { exclude: [{ key: "status", equals: ["heartbeat"] }] } })).status, 200);

  await post({ status: "green" });
  const before = (await call("GET", `/v1/entries/${entry.id}`)).json;
  const skip = await post({ status: "heartbeat" });
  assert.deepEqual(skip.json, { skipped: true, reason: "exclude matched: status = heartbeat" });

  const after = (await call("GET", `/v1/entries/${entry.id}`)).json;
  assert.equal(after.markdown, before.markdown);
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(after.last_skip_reason, "exclude matched: status = heartbeat");
  assert.deepEqual(after.ingest_filter, { include: [], exclude: [{ key: "status", equals: ["heartbeat"] }] });
  assert.equal((await call("GET", `/v1/entries/${entry.id}/revisions`)).json.length, 1);

  // Agent hooks get {} for a skip too.
  await call("PATCH", `/v1/entries/${entry.id}`, { ingest_filter: { include: [{ key: "notification_type", equals: ["permission_prompt"] }] } });
  assert.deepEqual((await post({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "done" })).json, {});
  assert.equal((await call("GET", `/v1/entries/${entry.id}/revisions`)).json.length, 1);

  // Clearing rules: every post delivers again.
  await call("PATCH", `/v1/entries/${entry.id}`, { ingest_filter: null });
  assert.equal((await call("GET", `/v1/entries/${entry.id}`)).json.ingest_filter, null);
  assert.equal((await post({ status: "heartbeat" })).json.unchanged, false);
});

test("removing an entry removes its delivery address", async () => {
  const { json: entry } = await call("POST", "/v1/entries", { title: "doomed" });
  await call("POST", `/v1/ingest/${entry.id}`, { text: "hi" }, entry.token);
  assert.deepEqual((await call("DELETE", `/v1/entries/${entry.id}`)).json, { deleted: true });
  const gone = await call("POST", `/v1/ingest/${entry.id}`, { text: "still posting" }, entry.token);
  assert.equal(gone.status, 404);
  assert.match(gone.json.hint, /removed/);
  assert.equal((await call("GET", `/v1/entries/${entry.id}`)).status, 404);
  assert.equal((await call("DELETE", `/v1/entries/${entry.id}`)).status, 404);
  assert.equal((await call("DELETE", `/v1/entries/${entry.id}`, undefined, "wrong")).status, 401); // box-key gated
});

test("address settings: token in URL, webhook signatures, formats", async () => {
  const { createHmac } = await import("node:crypto");
  const { json: entry } = await call("POST", "/v1/entries", { title: "webhooks" });
  const post = (body: string, headers: Record<string, string>, qs = "") =>
    app.fetch(new Request(`http://x/v1/ingest/${entry.id}${qs}`, { method: "POST", headers, body }), env)
      .then(async (r) => ({ status: r.status, json: await r.json() as any }));

  // Token in URL: off by default, with a hint; works once enabled.
  const off = await post('{"text":"a"}', { "content-type": "application/json" }, `?token=${entry.token}`);
  assert.equal(off.json.error, "token in URL is disabled");
  await call("PATCH", `/v1/entries/${entry.id}`, { allow_url_token: true });
  assert.equal((await post('{"text":"a"}', {}, `?token=${entry.token}`)).status, 200);
  assert.equal((await post('{"text":"a"}', {}, "?token=wrong")).json.error, "invalid token");

  // Signing: generated secret returned once; GET shows only the header.
  const on = await call("PATCH", `/v1/entries/${entry.id}`, { signing: { header: "X-Hub-Signature-256" } });
  const secret = on.json.signing_secret;
  assert.equal(secret.length, 64);
  assert.deepEqual((await call("GET", `/v1/entries/${entry.id}`)).json.signing, { header: "X-Hub-Signature-256" });
  // Re-saving the header keeps the secret; rotate issues a new one.
  assert.equal((await call("PATCH", `/v1/entries/${entry.id}`, { signing: { header: "X-Hub-Signature-256" } })).json.signing_secret, undefined);

  // GitHub-style: form-encoded payload= body, signature over the raw bytes, no Authorization header.
  const body = "payload=" + encodeURIComponent(JSON.stringify({ action: "completed", status: "failed" }));
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const gh = await post(body, { "content-type": "application/x-www-form-urlencoded", "x-hub-signature-256": sig });
  assert.equal(gh.status, 200);
  assert.match(gh.json.markdown, /\*\*Status:\*\* failed/);
  assert.equal((await post(body, { "content-type": "application/x-www-form-urlencoded", "x-hub-signature-256": "sha256=" + "0".repeat(64) })).json.error, "invalid signature");
  assert.equal((await post(body, { "content-type": "application/x-www-form-urlencoded" })).json.error, "missing signature");
  const revs = (await call("GET", `/v1/entries/${entry.id}/revisions`)).json;
  const stored = (await call("GET", `/v1/entries/${entry.id}/revisions/${revs[0].id}`)).json.raw_json;
  assert.deepEqual(JSON.parse(stored), { action: "completed", status: "failed" }); // normalized to JSON

  const rotated = await call("PATCH", `/v1/entries/${entry.id}`, { signing: { header: "X-Hub-Signature-256", rotate: true } });
  assert.notEqual(rotated.json.signing_secret, secret);
  assert.equal((await post(body, { "content-type": "application/x-www-form-urlencoded", "x-hub-signature-256": sig })).json.error, "invalid signature");

  assert.equal((await call("PATCH", `/v1/entries/${entry.id}`, { signing: { header: "bad header!" } })).json.error, "invalid signing header");
  await call("PATCH", `/v1/entries/${entry.id}`, { signing: null });
  assert.equal((await call("GET", `/v1/entries/${entry.id}`)).json.signing, null);
});

test("PO Boxes: a key only ever reaches its own pad", async () => {
  const openEnv = { ...env, OPEN_BOXES: "true" };
  const as = async (key: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const r = await app.fetch(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), openEnv);
    return { status: r.status, json: await r.json() as any };
  };
  const a = (await as(null, "POST", "/v1/boxes")).json;
  const b = (await as(null, "POST", "/v1/boxes")).json;
  assert.match(a.key, /^ppb_[0-9a-f]{64}$/);
  assert.notEqual(a.key, b.key);

  const entry = (await as(a.key, "POST", "/v1/entries", { title: "A's secret" })).json;
  await as(entry.token, "POST", `/v1/ingest/${entry.id}`, { text: "one" });
  await as(entry.token, "POST", `/v1/ingest/${entry.id}`, { text: "two" });
  const revs = (await as(a.key, "GET", `/v1/entries/${entry.id}/revisions`)).json;
  assert.equal(revs.length, 2);

  // Every entry-scoped route, with B's key -> 404; B's pad is empty and can't reorder A's entries.
  const n = `/v1/entries/${entry.id}`;
  for (const [method, path, body] of [
    ["GET", n], ["PATCH", n, { title: "pwned" }], ["DELETE", n],
    ["GET", `${n}/revisions`], ["GET", `${n}/revisions/${revs[0].id}`],
    ["POST", `${n}/restore/${revs[1].id}`], ["GET", `${n}/diff`],
  ] as [string, string, unknown?][]) {
    const r = await as(b.key, method, path, body);
    assert.equal(r.status, 404, `${method} ${path} leaked across boxes`);
  }
  const bPad = (await as(b.key, "GET", "/v1/pad")).json;
  assert.deepEqual([bPad.ids, bPad.entries], [[], []]);
  assert.equal((await as(b.key, "PUT", "/v1/pad/order", { ids: [entry.id] })).json.error, "invalid order");

  // A's entry is untouched and visible to A only.
  const mine = (await as(a.key, "GET", n)).json;
  assert.equal(mine.title, "A's secret");
  assert.equal(mine.markdown, "two\n");
  // The operator token isn't a box: it can't read anyone's pad.
  assert.equal((await as("admin", "GET", n)).json.error, "operator token isn't a PO Box");
  assert.equal((await as("admin", "GET", "/v1/pad")).status, 401);

  // Bad / missing keys, and a sender's entry token, can't read or manage anything.
  assert.equal((await as("ppb_" + "0".repeat(64), "GET", "/v1/pad")).json.error, "unknown box key");
  assert.equal((await as(null, "GET", "/v1/pad")).json.error, "missing box key");
  assert.equal((await as(entry.token, "GET", n)).status, 401);
});

test("PO Boxes: opening is operator-only unless OPEN_BOXES", async () => {
  const closed = (key?: string) => app.fetch(new Request("http://x/v1/boxes", {
    method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {},
  }), env).then((r) => r.status);
  assert.equal(await closed(), 403);
  assert.equal(await closed("admin"), 201);
});

test("no default box: a keyless request is refused even with no ADMIN_TOKEN", async () => {
  const devEnv = { ...env, ADMIN_TOKEN: undefined }; // local dev / private self-host
  const r = await app.fetch(new Request("http://x/v1/pad"), devEnv);
  assert.equal(r.status, 401);
  // ...and with no operator token, anyone can open a box.
  assert.equal((await app.fetch(new Request("http://x/v1/boxes", { method: "POST" }), devEnv)).status, 201);
});
