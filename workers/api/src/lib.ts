// Pure helpers for PostPad ingest: JSON->markdown, sanitize, line diff.
// No Worker/env deps here so they're unit-testable in plain node.
import { renderAgentEvent } from "./agents.ts";

/**
 * Map an ingested JSON payload to markdown. Forgiving on purpose: agents POST
 * whatever shape comes naturally (contract: README "Ingest contract").
 */
export function renderMarkdown(raw: unknown, source?: string): string {
  return demoteHeadings(renderBody(raw, source));
}

function renderBody(raw: unknown, source?: string): string {
  if (typeof raw === "string") return sanitize(raw); // bare JSON string: "build green"
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonBlock(raw);
  const o = raw as Record<string, unknown>;
  // Explicit markdown wins outright (an empty string clears the note).
  if (typeof o.markdown === "string") return sanitize(o.markdown);
  if (typeof o.body === "string") return sanitize(o.body);
  return sanitize(renderAgentEvent(o, source) ?? (statusTemplate(o) || jsonBlock(raw)));
}

/** Prose aliases, in priority order. */
export const TEXT_KEYS = ["text", "message", "summary", "description"];

/** Template for text/status-shaped objects: optional heading, status, prose, then leftovers. */
function statusTemplate(o: Record<string, unknown>): string {
  const parts: string[] = [];
  const used = new Set(["markdown", "body"]);
  const take = (k: string) => (used.add(k), o[k]);

  const titleKey = ["title", "name"].find((k) => str(o[k]));
  if (titleKey) parts.push(`# ${take(titleKey)}`);
  if (o.status != null && isScalar(o.status)) parts.push(`**Status:** ${take("status")}`);
  const textKey = TEXT_KEYS.find((k) => str(o[k]));
  if (textKey) parts.push(String(take(textKey)));

  // Leftovers stay visible: scalars as a list, nested values as a JSON block.
  const rest = Object.entries(o).filter(([k, v]) => !used.has(k) && v != null);
  const scalars = rest.filter(([, v]) => isScalar(v));
  if (scalars.length) parts.push(scalars.map(([k, v]) => `- **${k}:** ${v}`).join("\n"));
  const nested = rest.filter(([, v]) => !isScalar(v));
  if (nested.length) parts.push(jsonBlock(Object.fromEntries(nested)).trimEnd());
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

const jsonBlock = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```\n";
const isScalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * Reject unsafe HTML embedded in markdown. Markdown itself is safe to store;
 * we strip the tags/protocols that let raw HTML execute if a lax renderer is used.
 * ponytail: blocklist strip. Clients must ALSO render markdown with raw-HTML disabled
 * (see apps/desktop) — this is defense in depth, not the only line.
 */
export function sanitize(md: string): string {
  return md
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?(<\/\s*\1\s*>|$)/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

export type DiffLine = { op: " " | "-" | "+"; text: string };

/** LCS-based line diff. ponytail: O(n*m) DP, fine for note-sized bodies. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: " ", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: "-", text: A[i] }); i++; }
    else { out.push({ op: "+", text: B[j] }); j++; }
  }
  while (i < n) out.push({ op: "-", text: A[i++] });
  while (j < m) out.push({ op: "+", text: B[j++] });
  return out;
}

/** SHA-256 hex — available in Workers and modern node via WebCrypto. */
export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Ingest filters (docs/INGEST_FILTERS.md) ---------------------------------
// Per-note gate on incoming POSTs by JSON key: exclude = never update when
// key = value; include = only update when key = value. No if/else by design.

export type Rule = { key: string; equals: string[] };
export type RuleSet = { include: Rule[]; exclude: Rule[] };

const LIMITS = { rules: 20, values: 10, key: 100, value: 200 };

/** Validate + normalize a rule set from the API. Returns an error hint string on bad input. */
export function parseRuleSet(x: unknown): RuleSet | string {
  if (!x || typeof x !== "object" || Array.isArray(x)) return 'ingest_filter must be an object like {"include":[],"exclude":[]} or null.';
  const out: RuleSet = { include: [], exclude: [] };
  for (const side of ["include", "exclude"] as const) {
    const list = (x as any)[side] ?? [];
    if (!Array.isArray(list)) return `${side} must be an array of {"key","equals"} rules.`;
    for (const r of list) {
      const key = typeof r?.key === "string" ? r.key.trim() : "";
      if (!key || key.length > LIMITS.key) return `Each ${side} rule needs a "key" (dot path like "status" or "build.result", ≤${LIMITS.key} chars).`;
      const raw = Array.isArray(r.equals) ? r.equals : [r.equals];
      const equals = raw.filter((v: unknown) => ["string", "number", "boolean"].includes(typeof v)).map(String);
      if (!equals.length || equals.length > LIMITS.values || equals.some((v: string) => v.length > LIMITS.value))
        return `Rule "${key}" needs 1–${LIMITS.values} values in "equals" (strings, numbers or booleans, ≤${LIMITS.value} chars).`;
      out[side].push({ key, equals });
    }
  }
  if (out.include.length + out.exclude.length > LIMITS.rules) return `At most ${LIMITS.rules} rules per note.`;
  return out;
}

/** Value at a dot path, as a comparable string; undefined if missing. `a.b.0` indexes arrays. */
function valueAt(raw: unknown, key: string): string | undefined {
  let v: any = raw;
  for (const k of key.split(".")) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined;
    v = v[k];
  }
  return v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Should this POST update the note? Exclude wins; include rules must all match; values in a rule are OR. */
export function ingestAllowed(raw: unknown, rules: RuleSet | null): { ok: true } | { ok: false; reason: string } {
  if (!rules) return { ok: true };
  for (const r of rules.exclude) {
    const v = valueAt(raw, r.key);
    if (v !== undefined && r.equals.includes(v)) return { ok: false, reason: `exclude matched: ${r.key} = ${v}` };
  }
  for (const r of rules.include) {
    const v = valueAt(raw, r.key);
    if (v === undefined || !r.equals.includes(v))
      return { ok: false, reason: `include not met: ${r.key} is ${v === undefined ? "missing" : v}, needs ${r.equals.join(" or ")}` };
  }
  return { ok: true };
}

// --- Body formats + webhook signatures (README "Ingest contract") ------------

/**
 * Parse an ingest body by Content-Type. JSON is tried first whatever the header
 * says (sloppy clients stay supported); then form-encoded (incl. GitHub's
 * `payload=<json>` style) and plain text, which becomes the note's markdown.
 * Returns undefined when nothing fits.
 */
export function parseBody(text: string, contentType: string): unknown {
  const ct = contentType.toLowerCase();
  const isText = ct.startsWith("text/");
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  // For text/*, only take JSON objects/arrays, so a status like "404" or "true" stays text.
  if (json !== undefined && (!isText || (json !== null && typeof json === "object"))) return json;
  if (ct.includes("application/x-www-form-urlencoded") && text.includes("=")) {
    const form = new URLSearchParams(text);
    const payload = form.get("payload");
    if (payload && [...form.keys()].length === 1) { try { return JSON.parse(payload); } catch { /* plain field */ } }
    return Object.fromEntries(form);
  }
  // Plain text, or `curl -d 'build green'` (form header, no key=value): the text is the markdown.
  if (isText || ct.includes("application/x-www-form-urlencoded")) return text.trim() ? { markdown: text } : undefined;
  return undefined;
}

/**
 * Verify an HMAC-SHA256 signature of the raw body. Accepts hex or base64, with an
 * optional `sha256=` prefix (GitHub). Constant-time via WebCrypto verify.
 */
export async function verifySignature(secret: string, body: Uint8Array, provided: string | null): Promise<boolean> {
  const sig = decodeSig((provided ?? "").trim().replace(/^sha256=/i, ""));
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, body);
}

function decodeSig(s: string): Uint8Array | null {
  if (/^[0-9a-f]{64}$/i.test(s)) return Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
  try {
    const bin = atob(s);
    return bin.length === 32 ? Uint8Array.from(bin, (ch) => ch.charCodeAt(0)) : null;
  } catch { return null; }
}

// --- The pad: entries live under their title's H1 ------------------------------

/**
 * An entry's title is its H1 in the pad, so an entry body never contains one. If a
 * body has an H1, every heading moves down a level (H6 stays H6); fenced code is left alone.
 */
export function demoteHeadings(md: string): string {
  const lines = md.split("\n");
  let fenced = false;
  const outside = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return false; }
    return !fenced;
  });
  if (!lines.some((l, i) => outside[i] && /^#(\s|$)/.test(l))) return md;
  return lines.map((l, i) => (outside[i] && /^#{1,5}(\s|$)/.test(l) ? "#" + l : l)).join("\n");
}

/** URL-safe anchor for an entry title ("CI: Deploy prod" -> "ci-deploy-prod"). */
export const slugify = (title: string) =>
  title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "entry";
