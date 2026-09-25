// Run: npm test (node strips the TS types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBoxFile, decryptBoxFile } from "../src/vault.ts";

const box = { base_url: "https://api.postpad.dev", box_key: "ppb_" + "a".repeat(64), tokens: { n1: "t".repeat(64) } };

test("round-trips, and the file doesn't contain the secrets", async () => {
  const file = await encryptBoxFile(box, "correct horse");
  assert.ok(!file.includes(box.box_key) && !file.includes("t".repeat(64)));
  assert.equal(JSON.parse(file).format, "postpad-po-box");
  assert.deepEqual(await decryptBoxFile(file, "correct horse"), box);
});

test("wrong passphrase, tampering, junk and short passphrases fail clearly", async () => {
  const file = await encryptBoxFile(box, "correct horse");
  await assert.rejects(decryptBoxFile(file, "wrong horse"), /Wrong passphrase/);
  const f = JSON.parse(file); f.data = f.data.slice(0, -4) + (f.data.endsWith("AAA=") ? "BBB=" : "AAA=");
  await assert.rejects(decryptBoxFile(JSON.stringify(f), "correct horse"), /Wrong passphrase, or the file was changed/);
  await assert.rejects(decryptBoxFile("nope", "x"), /not JSON/);
  await assert.rejects(decryptBoxFile('{"format":"other"}', "x"), /isn't a PostPad PO Box file/);
  await assert.rejects(encryptBoxFile(box, "short"), /at least 8/);
});
