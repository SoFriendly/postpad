import { test } from "node:test";
import assert from "node:assert/strict";
import { boxKeyPdf, textPdf } from "../src/pdf.ts";

const key = "ppb_" + "0123456789abcdef".repeat(4);

test("box key PDF is structurally valid: every xref offset points at its object", () => {
  const pdf = new TextDecoder().decode(boxKeyPdf(key, "https://api.postpad.dev", new Date("2026-09-25T12:00:00Z")));
  assert.ok(pdf.startsWith("%PDF-1.4\n") && pdf.endsWith("%%EOF\n"));
  const startxref = Number(pdf.match(/startxref\n(\d+)\n/)![1]);
  assert.ok(pdf.slice(startxref).startsWith("xref\n"));
  const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(entries.length, 7);
  entries.forEach((off, i) => assert.ok(pdf.slice(off).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1} offset`));
  const len = Number(pdf.match(/<< \/Length (\d+) >>\nstream\n/)![1]);
  const body = pdf.split(/<< \/Length \d+ >>\nstream\n/)[1];
  assert.equal(body.indexOf("\nendstream"), len);
  // The key is on the page, split over two lines.
  assert.ok(pdf.includes(`(${key.slice(0, 34)})`) && pdf.includes(`(${key.slice(34)})`));
  assert.ok(pdf.includes("Opened: 2026-09-25"));
});

test("text is escaped and non-ASCII can't corrupt the stream", () => {
  const pdf = new TextDecoder().decode(textPdf([{ text: "a (b) \\ c — d" }]));
  assert.ok(pdf.includes("(a \\(b\\) \\\\ c ? d)"));
});
