// Self-check for the pure ingest logic. Run: `node --test` (node 22+ strips TS types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, sanitize, lineDiff, sha256hex } from "../src/lib.ts";

test("passthrough markdown/body", () => {
  assert.equal(renderMarkdown({ markdown: "# hi" }), "## hi"); // the entry title is the H1 in the pad
  assert.equal(renderMarkdown({ body: "plain" }), "plain");
});

test("status object -> template", () => {
  const md = renderMarkdown({ title: "Deploy", status: "green", message: "all good", region: "us" });
  assert.match(md, /# Deploy/);
  assert.match(md, /\*\*Status:\*\* green/);
  assert.match(md, /all good/);
  assert.match(md, /- \*\*region:\*\* us/);
});

test("non-object falls back to json block", () => {
  assert.match(renderMarkdown([1, 2]), /```json/);
});

test("sanitize strips scripts and handlers", () => {
  assert.doesNotMatch(sanitize("hi <script>evil()</script> there"), /script/i);
  assert.doesNotMatch(sanitize('<a href="x" onclick="bad()">x</a>'), /onclick/i);
  assert.doesNotMatch(sanitize("[x](javascript:alert(1))"), /javascript:/i);
});

test("line diff marks add/remove/context", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(d, [
    { op: " ", text: "a" },
    { op: "-", text: "b" },
    { op: "+", text: "B" },
    { op: " ", text: "c" },
  ]);
});

test("sha256hex is stable hex", async () => {
  assert.equal((await sha256hex("")).length, 64);
  assert.equal(await sha256hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("agent-friendly aliases", () => {
  assert.equal(renderMarkdown({ text: "build green" }), "build green\n");
  assert.equal(renderMarkdown({ message: "deploying" }), "deploying\n");
  assert.equal(renderMarkdown("bare string"), "bare string");
  assert.equal(renderMarkdown({ markdown: "" }), ""); // explicit empty clears
  assert.equal(renderMarkdown({ title: "iOS", text: "green" }), "## iOS\n\ngreen\n");
});

test("status keeps its status line when message is present", () => {
  assert.equal(renderMarkdown({ status: "green", message: "build passed" }), "**Status:** green\n\nbuild passed\n");
});

test("leftovers stay visible, nested as json", () => {
  const md = renderMarkdown({ text: "hi", user: "bob", meta: { a: 1 } });
  assert.match(md, /^hi\n\n- \*\*user:\*\* bob\n\n```json/);
  assert.match(renderMarkdown({ data: { a: 1 } }), /```json[\s\S]*"a": 1/);
});

import { ingestAllowed, parseRuleSet } from "../src/lib.ts";

test("ingest filters: exclude wins, includes AND, values OR", () => {
  const rules = parseRuleSet({
    include: [{ key: "status", equals: ["failed", "error"] }, { key: "repo", equals: "postpad" }],
    exclude: [{ key: "status", equals: ["error"] }],
  });
  assert.ok(typeof rules !== "string");
  assert.deepEqual(ingestAllowed({ status: "failed", repo: "postpad" }, rules), { ok: true });
  assert.equal(ingestAllowed({ status: "error", repo: "postpad" }, rules).ok, false); // exclude wins
  assert.match((ingestAllowed({ status: "failed", repo: "other" }, rules) as any).reason, /include not met: repo is other, needs postpad/);
  assert.match((ingestAllowed({ repo: "postpad" }, rules) as any).reason, /status is missing/);
  assert.equal(ingestAllowed("bare string", rules).ok, false); // no keys: include fails
  assert.deepEqual(ingestAllowed({ anything: 1 }, null), { ok: true });
});

test("ingest filters: dot paths, arrays, scalars compare as strings", () => {
  const r = parseRuleSet({ include: [{ key: "build.result", equals: ["ok"] }, { key: "roots.0", equals: ["/w"] }, { key: "exit_code", equals: [0] }] }) as any;
  assert.deepEqual(ingestAllowed({ build: { result: "ok" }, roots: ["/w"], exit_code: 0 }, r), { ok: true });
  assert.equal(ingestAllowed({ build: { result: "ok" }, roots: ["/w"], exit_code: "1" }, r).ok, false);
  const ex = parseRuleSet({ exclude: [{ key: "constructor", equals: ["x"] }] }) as any; // prototype keys aren't "present"
  assert.deepEqual(ingestAllowed({}, ex), { ok: true });
});

test("parseRuleSet rejects bad shapes with a hint", () => {
  assert.match(parseRuleSet([]) as string, /must be an object/);
  assert.match(parseRuleSet({ include: [{ key: "", equals: ["x"] }] }) as string, /needs a "key"/);
  assert.match(parseRuleSet({ exclude: [{ key: "s", equals: [] }] }) as string, /needs 1–10 values/);
  assert.match(parseRuleSet({ include: Array.from({ length: 21 }, () => ({ key: "k", equals: ["v"] })) }) as string, /At most 20/);
});

import { parseBody, verifySignature } from "../src/lib.ts";
import { createHmac } from "node:crypto";

test("parseBody: json first, then form, then text", () => {
  assert.deepEqual(parseBody('{"a":1}', ""), { a: 1 });
  assert.deepEqual(parseBody('{"a":1}', "text/plain"), { a: 1 }); // sloppy header, JSON body
  assert.deepEqual(parseBody("404", "text/plain"), { markdown: "404" }); // text stays text
  assert.deepEqual(parseBody("## Build\n- green", "text/markdown"), { markdown: "## Build\n- green" });
  assert.deepEqual(parseBody("status=green&repo=postpad", "application/x-www-form-urlencoded"), { status: "green", repo: "postpad" });
  assert.deepEqual(parseBody("payload=" + encodeURIComponent('{"action":"completed"}'), "application/x-www-form-urlencoded"), { action: "completed" });
  assert.deepEqual(parseBody("build green", "application/x-www-form-urlencoded"), { markdown: "build green" }); // curl -d 'build green'
  assert.equal(parseBody("not json", "application/json"), undefined);
  assert.equal(parseBody("   ", "text/plain"), undefined);
});

test("verifySignature: GitHub hex, base64, wrong secret, garbage", async () => {
  const body = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');
  const hmac = (k: string) => createHmac("sha256", k).update(body);
  assert.equal(await verifySignature("s3cret", body, "sha256=" + hmac("s3cret").digest("hex")), true);
  assert.equal(await verifySignature("s3cret", body, hmac("s3cret").digest("base64")), true); // Shopify style
  assert.equal(await verifySignature("s3cret", body, "sha256=" + hmac("other").digest("hex")), false);
  assert.equal(await verifySignature("s3cret", body, "sha256=zz"), false);
  assert.equal(await verifySignature("s3cret", body, null), false);
});

import { demoteHeadings, slugify } from "../src/lib.ts";

test("entry bodies never contain an H1; code fences are left alone", () => {
  assert.equal(demoteHeadings("# A\n## B\n```\n# not a heading\n```\n###### six"), "## A\n### B\n```\n# not a heading\n```\n###### six");
  assert.equal(demoteHeadings("## card\ntext"), "## card\ntext"); // already under the H1: unchanged
  assert.equal(demoteHeadings("#hashtag is not a heading"), "#hashtag is not a heading");
});

test("slugify makes stable anchors", () => {
  assert.equal(slugify("CI: Deploy — Prod ✅"), "ci-deploy-prod");
  assert.equal(slugify("Café déploiement"), "cafe-deploiement");
  assert.equal(slugify("!!!"), "entry");
  assert.ok(slugify("x".repeat(100)).length <= 60);
});
