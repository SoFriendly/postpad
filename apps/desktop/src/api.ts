// PostPad API client. Base URL is user-configurable (hosted vs self-host).
// There are no accounts: your pad lives in a PO Box, and a random box key is the whole
// identity. On first launch the app asks for a key or a PO Box file, or opens a new box;
// the PO Box file (vault.ts) and the box-key PDF (pdf.ts) move it between devices.
// Entry tokens are returned once on create; we cache them locally so the delivery
// address can be re-shown. ponytail: localStorage cache — move to the OS
// keychain (tauri-plugin-stronghold / keyring) before shipping, per ARCHITECTURE.
import { encryptBoxFile, decryptBoxFile } from "./vault";

const BASE_KEY = "postpad.baseUrl";
const BOX_KEY = "postpad.boxKey";
const TOKENS_KEY = "postpad.tokens";

export const DEFAULT_BASE = "https://api.postpad.dev";

export const getBase = () => localStorage.getItem(BASE_KEY) || DEFAULT_BASE;
export const setBase = (v: string) => localStorage.setItem(BASE_KEY, v.replace(/\/+$/, ""));
export const getBoxKey = () => localStorage.getItem(BOX_KEY) || "";
// Keys are typed from a printout, so whitespace and line breaks are dropped.
export const setBoxKey = (v: string) => v ? localStorage.setItem(BOX_KEY, v.replace(/\s+/g, "")) : localStorage.removeItem(BOX_KEY);

const tokens = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(TOKENS_KEY) || "{}"); } catch { return {}; }
};
export const getToken = (id: string) => tokens()[id] || "";
const rememberToken = (id: string, tok: string) => {
  const t = tokens(); t[id] = tok; localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
};
const forgetToken = (id: string) => {
  const t = tokens(); delete t[id]; localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
};

async function req(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const key = getBoxKey();
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(getBase() + path, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.hint ? `${data.error}: ${data.hint}` : data?.error || `HTTP ${res.status}`);
  return data;
}

// One running pad per PO Box. Each delivery address is an entry (a section under
// its own H1); a sender's post rewrites that entry, latest wins.
export type Entry = {
  id: string; slug: string; title: string; position: number; tags: string[]; pinned: boolean;
  updated_at: string; markdown: string; source: string | null; // markdown never has an H1: render the title as the entry's heading
  address: string; // the delivery address senders POST to
};
export type EntryDetail = Entry & {
  created_at: string; current_revision_id: string | null;
  ingest_filter: RuleSet | null; last_skipped_at: string | null; last_skip_reason: string | null;
  allow_url_token: boolean; signing: { header: string } | null;
};
export type Pad = { as_of: string; ids: string[]; entries: Entry[] };
// Delivery rules (docs/INGEST_FILTERS.md): exclude = never deliver when key = value; include = only when.
export type Rule = { key: string; equals: string[] };
export type RuleSet = { include: Rule[]; exclude: Rule[] };
export type Revision = { id: string; created_at: string; source: string | null; content_hash: string };
export type DiffLine = { op: " " | "-" | "+"; text: string };

// The whole pad in order. Pass the previous as_of as `since` to get only entries that
// changed; `ids` is always the full order (drop local entries that aren't in it).
export const getPad = (since?: string): Promise<Pad> => req(`/v1/pad${since ? `?since=${encodeURIComponent(since)}` : ""}`);
export const reorderPad = (ids: string[]) => req("/v1/pad/order", { method: "PUT", body: JSON.stringify({ ids }) });

// Add a sender / hand out an address = add an entry at the end of the pad.
export async function addEntry(title: string, tags: string[] = []) {
  const r = await req("/v1/entries", { method: "POST", body: JSON.stringify({ title, tags }) });
  rememberToken(r.id, r.token);
  return r as { id: string; slug: string; title: string; tags: string[]; address: string; token: string };
}
export const getEntry = (id: string): Promise<EntryDetail> => req(`/v1/entries/${id}`);
export const patchEntry = (id: string, patch: Record<string, unknown>) =>
  req(`/v1/entries/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// Removing an entry removes its delivery address: senders still posting get a 404.
export async function deleteEntry(id: string) {
  await req(`/v1/entries/${id}`, { method: "DELETE" });
  forgetToken(id);
}

// Open a new PO Box at the current post office. Doesn't store the key: the welcome
// screen shows it first, so the user can save it before continuing.
export async function openNewBox(): Promise<string> {
  const res = await fetch(getBase() + "/v1/boxes", { method: "POST" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.hint ?? `The post office didn't open a box (HTTP ${res.status}).`);
  return data.key;
}

// Check a box key against the current post office before using it.
export async function checkBoxKey(key: string) {
  const res = await fetch(getBase() + "/v1/pad", { headers: { authorization: `Bearer ${key.replace(/\s+/g, "")}` } });
  if (res.ok) return;
  const data = await res.json().catch(() => null);
  throw new Error(data?.hint ?? `The post office didn't accept that key (HTTP ${res.status}).`);
}

// The PO Box file: everything this device needs (post office, box key, entry tokens), encrypted.
export const exportBoxFile = (passphrase: string) =>
  encryptBoxFile({ base_url: getBase(), box_key: getBoxKey(), tokens: tokens() }, passphrase);
export async function importBoxFile(file: string, passphrase: string) {
  const box = await decryptBoxFile(file, passphrase);
  setBase(box.base_url);
  await checkBoxKey(box.box_key);
  setBoxKey(box.box_key);
  localStorage.setItem(TOKENS_KEY, JSON.stringify({ ...tokens(), ...box.tokens }));
}

export const listRevisions = (id: string): Promise<Revision[]> => req(`/v1/entries/${id}/revisions`);
export const getRevision = (id: string, rev: string): Promise<Revision & { raw_json: string; rendered_markdown: string }> => req(`/v1/entries/${id}/revisions/${rev}`);
export const restoreRevision = (id: string, rev: string) => req(`/v1/entries/${id}/restore/${rev}`, { method: "POST" });

export const diff = (id: string, from?: string, to?: string): Promise<{ from: string; to: string; diff: DiffLine[] }> => {
  const p = new URLSearchParams();
  if (from) p.set("from", from); if (to) p.set("to", to);
  return req(`/v1/entries/${id}/diff?${p}`);
};
