// Encrypted PO Box file: move your box between devices as a JSON file that's
// useless without its passphrase. WebCrypto only (PBKDF2-SHA256 -> AES-256-GCM),
// so it runs the same in the Tauri webview on every platform and in node for tests.

export type BoxFile = { base_url: string; box_key: string; tokens: Record<string, string> };

const ITERATIONS = 600_000; // OWASP guidance for PBKDF2-SHA256
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptBoxFile(box: BoxFile, passphrase: string): Promise<string> {
  if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(box))));
  return JSON.stringify({
    format: "postpad-po-box", version: 1,
    kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt) },
    cipher: { name: "AES-256-GCM", iv: b64(iv) },
    data: b64(data),
  }, null, 2);
}

export async function decryptBoxFile(text: string, passphrase: string): Promise<BoxFile> {
  let file: any;
  try { file = JSON.parse(text); } catch { throw new Error("That isn't a PostPad PO Box file (not JSON)."); }
  if (file?.format !== "postpad-po-box" || file.version !== 1) throw new Error("That isn't a PostPad PO Box file.");
  let plain: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, unb64(file.kdf.salt), file.kdf.iterations);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.cipher.iv) }, key, unb64(file.data));
  } catch {
    throw new Error("Wrong passphrase, or the file was changed."); // GCM authenticates: tampering fails here too
  }
  const box = JSON.parse(dec.decode(plain));
  if (typeof box.base_url !== "string" || typeof box.box_key !== "string") throw new Error("The file is missing its box key.");
  return { base_url: box.base_url, box_key: box.box_key, tokens: box.tokens ?? {} };
}
