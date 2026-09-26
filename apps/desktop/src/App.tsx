import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import * as api from "./api";
import type { Entry, EntryDetail, Revision, DiffLine, Rule } from "./api";
import { CONNECTORS } from "./connect";
import { boxKeyPdf } from "./pdf";
import { saveFile } from "./save";
import "./App.css";

marked.setOptions({ gfm: true, breaks: true });
// ponytail: server already strips unsafe HTML; marked has no built-in sanitizer.
// Add DOMPurify here before exposing untrusted ingest sources.
const md = (s: string) => ({ __html: marked.parse(s || "*empty*") as string });

// Pull, not push: the list re-checks quietly; new deliveries are marked, never alerted.
const POLL_MS = 30_000;

// Unread entries: updated since this device last jumped to or opened them. An entry seen for the
// first time is baselined, so only deliveries that arrive later look new.
const SEEN_KEY = "postpad.seen";
const seen = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch { return {}; }
};
const markSeen = (items: { id: string; updated_at: string }[], force = false) => {
  const s = seen();
  for (const n of items) if (force || !(n.id in s)) s[n.id] = n.updated_at;
  localStorage.setItem(SEEN_KEY, JSON.stringify(s));
};

// Android home-screen widgets (src-tauri/gen/android/.../widget): the native side exposes this bridge.
declare global {
  interface Window { PostPadWidgets?: { sync(base: string, key: string, entries: string): void; takeOpenEntry(): string } }
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);   // the pad, in order
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState<string | null>(null);   // an entry opened on its own
  const [current, setCurrent] = useState<string | null>(null); // last entry jumped to in the pad
  const [toc, setToc] = useState(false);                       // phone: contents drawer
  const [showSettings, setShowSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  // No accounts: without a box key on this device, the Welcome screen asks for one.
  const [boxKey, setBoxKey] = useState(api.getBoxKey());
  const [synced, setSynced] = useState("");
  // Poll the pad: pass the last as_of to get only changed entries; `ids` is always the full order.
  const asOf = useRef("");
  const refresh = () => api.getPad(asOf.current || undefined)
    .then((pad) => {
      setEntries((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        for (const e of pad.entries) byId.set(e.id, e);
        const next = pad.ids.flatMap((id) => byId.get(id) ?? []);
        markSeen(next);
        return next;
      });
      asOf.current = pad.as_of; setErr(""); setSynced(new Date().toISOString());
    })
    .catch((e) => setErr(String(e.message)));
  useEffect(() => {
    if (!boxKey) return;
    asOf.current = "";
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [boxKey]);

  // Widgets: hand them the pad after every sync (and the key, so they can refresh on their own);
  // an empty key clears them when this device leaves the PO Box.
  useEffect(() => {
    if (!window.PostPadWidgets || (boxKey && !synced)) return;
    const slim = entries.map(({ id, title, updated_at, markdown, source, pinned }) => ({ id, title, updated_at, markdown, source, pinned }));
    window.PostPadWidgets.sync(api.getBase(), boxKey, JSON.stringify(slim));
  }, [entries, boxKey, synced]);
  // A widget tap asks to open an entry: at launch, on return to the app, or while it's open.
  useEffect(() => {
    const take = () => {
      const id = window.PostPadWidgets?.takeOpenEntry();
      if (id) { setToc(false); setCurrent(id); setFocus(id); }
    };
    take();
    const onVisible = () => { if (document.visibilityState === "visible") take(); };
    addEventListener("postpad-widget-open", take);
    document.addEventListener("visibilitychange", onVisible);
    return () => { removeEventListener("postpad-widget-open", take); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // Back (Android button / gesture, browser back): anything open over the pad is one history
  // step, so back closes it (dialog, then drawer, then entry) instead of leaving the app.
  // Closing it from the UI consumes that step too, so no dead back press is left behind.
  const layered = !!(creating || showSettings || toc || focus);
  const pushed = useRef(false), ignorePop = useRef(false);
  useEffect(() => {
    if (layered && !pushed.current) { history.pushState({ postpad: "layer" }, ""); pushed.current = true; }
    if (!layered && pushed.current) { pushed.current = false; ignorePop.current = true; history.back(); }
  }, [layered]);
  useEffect(() => {
    const pop = () => {
      if (ignorePop.current) { ignorePop.current = false; return; }
      // Still something open after closing the top layer? Keep a step for the next back.
      pushed.current = [creating, showSettings, toc, focus].filter(Boolean).length > 1;
      if (pushed.current) history.pushState({ postpad: "layer" }, "");
      if (creating) setCreating(false);
      else if (showSettings) setShowSettings(false);
      else if (toc) setToc(false);
      else if (focus) {
        const id = focus;
        setFocus(null); setCurrent(id);
        requestAnimationFrame(() => document.getElementById(`e-${id}`)?.scrollIntoView({ block: "start" }));
      }
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [creating, showSettings, toc, focus]);

  const focused = entries.find((e) => e.id === focus);
  useEffect(() => { if (focused) markSeen([focused], true); }, [focused?.id, focused?.updated_at]);
  const s = seen();
  if (!boxKey) return <Welcome onDone={() => { setEntries([]); setFocus(null); setBoxKey(api.getBoxKey()); }} />;

  // Contents click: back to the pad, scrolled to that entry.
  const jump = (id: string) => {
    const n = entries.find((x) => x.id === id);
    if (n) markSeen([n], true);
    setFocus(null); setCurrent(id); setToc(false);
    requestAnimationFrame(() => document.getElementById(`e-${id}`)?.scrollIntoView({ block: "start" }));
  };
  const openEntry = (id: string) => { setCurrent(id); setToc(false); setFocus(id); };

  // Filter is client-side over the whole pad (titles and bodies).
  const needle = q.trim().toLowerCase();
  const rows = entries
    .filter((e) => !needle || `${e.title}\n${e.markdown}`.toLowerCase().includes(needle))
    .map((e) => ({ ...e, fresh: e.updated_at > (s[e.id] ?? "") }));
  const fresh = rows.filter((r) => r.fresh).length;
  return (
    <div className={`app${focus ? " focusing" : ""}${toc ? " toc-open" : ""}`}>
      {toc && <div className="scrim" onClick={() => setToc(false)} />}
      <aside className="side">
        <div className="side-head">
          <span className="stamp-mark" aria-hidden />
          <span className="side-title">PostPad</span>
          <button className="icon" aria-label="Add sender" title="Add sender (new address)" onClick={() => setCreating(true)}><PlusIcon /></button>
          <button className="icon" aria-label="Settings" title="Settings" onClick={() => setShowSettings(true)}><GearIcon /></button>
        </div>
        <input className="search" type="search" placeholder="Filter entries" value={q} onChange={(e) => setQ(e.target.value)} />
        {err && <div className="err" role="alert" onClick={() => setErr("")}>{err}</div>}
        <div className="side-list">
          {!!rows.length && <h2 className="side-sec">Contents</h2>}
          {/* The pad's outline, in pad order; the entry in view is highlighted as you scroll. */}
          <ul className="toc">
            {rows.map((r) => (
              <li key={r.id}>
                <button className={`toc-item${r.id === current ? " sel" : ""}${r.fresh ? " fresh" : ""}`} onClick={() => jump(r.id)}
                  aria-current={r.id === current || undefined}>
                  <span className="toc-title">{r.title}</span>
                  <time className="toc-age" dateTime={r.updated_at} title={new Date(r.updated_at).toLocaleString()}>{short(r.updated_at)}</time>
                </button>
              </li>
            ))}
          </ul>
          {!rows.length && !err && synced && <p className="side-empty">{needle ? "No entries match." : "No entries yet."}</p>}
        </div>
      </aside>
      <main className="main">
        {focus
          ? <EntryView id={focus} version={focused?.updated_at} onBack={() => jump(focus)} onChange={refresh}
              onDeleted={() => { setFocus(null); refresh(); }} />
          : <Pad rows={rows} q={needle} onOpen={openEntry} onAdd={() => setCreating(true)} onVisible={setCurrent} onRefresh={refresh} loading={!synced && !err}
              onContents={() => setToc(true)} onSettings={() => setShowSettings(true)} />}
      </main>
      <footer className="statusbar">
        <button className={`sb-sync${err ? " sb-bad" : ""}`} title="Check for new deliveries now" onClick={refresh}>
          {err ? "● offline" : synced ? `● synced ${short(synced)}` : "● connecting"}
        </button>
        <span>{entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
        {!!fresh && <span className="sb-new">{fresh} new</span>}
        <span className="sb-right">{api.getBase().replace(/^https?:\/\//, "")}</span>
      </footer>
      {showSettings && <Settings onClose={() => setShowSettings(false)} onLeave={() => { setShowSettings(false); setBoxKey(""); }} />}
      {creating && <AddSender onDone={(id) => { setCreating(false); refresh().then(() => { if (id) jump(id); }); }} />}
    </div>
  );
}

type Row = Entry & { fresh: boolean };
type RevisionBody = Awaited<ReturnType<typeof api.getRevision>>;

// The pad: one running document. Each sender/address owns one entry (an H1 section);
// a delivery rewrites only that entry.
function Pad({ rows, q, loading, onOpen, onAdd, onVisible, onRefresh, onContents, onSettings }: {
  rows: Row[]; q: string; loading: boolean; onOpen: (id: string) => void; onAdd: () => void;
  onVisible: (id: string) => void; onRefresh: () => Promise<unknown>; onContents: () => void; onSettings: () => void;
}) {
  // Scroll-spy: the current entry is the last one whose top has scrolled past the top of the pad.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let raf = 0;
    const spy = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        let id = "";
        for (const el of root.querySelectorAll<HTMLElement>(".entry")) {
          if (el.offsetTop <= root.scrollTop + 48) id = el.id; else break;
        }
        if (id) onVisible(id.slice(2));
      });
    };
    root.addEventListener("scroll", spy);
    spy();
    return () => { root.removeEventListener("scroll", spy); cancelAnimationFrame(raf); };
  }, [rows.map((r) => r.id).join()]);
  // Pull to refresh (touch): drag down from the top of the pad past PULL_AT, release to fetch now.
  const PULL_AT = 56;
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const from = useRef<number | null>(null);
  const touch = {
    onTouchStart: (e: React.TouchEvent) => { from.current = ref.current?.scrollTop === 0 ? e.touches[0].clientY : null; },
    onTouchMove: (e: React.TouchEvent) => {
      if (from.current === null || refreshing) return;
      const d = e.touches[0].clientY - from.current;
      setPull(d > 0 ? Math.min(d / 2, PULL_AT + 24) : 0);
    },
    onTouchEnd: () => {
      if (pull >= PULL_AT && !refreshing) { setRefreshing(true); onRefresh().finally(() => setRefreshing(false)); }
      setPull(0); from.current = null;
    },
  };
  return (
    <div className="padwrap">
      <div className="padbar">
        <button className="link" onClick={onContents}>☰ Contents</button>
        <span className="side-title">PostPad</span>
        <button className="icon" aria-label="Add sender" onClick={onAdd}><PlusIcon /></button>
        <button className="icon" aria-label="Settings" onClick={onSettings}><GearIcon /></button>
      </div>
      <div className="pad" ref={ref} {...touch}>
        {(pull > 0 || refreshing) && <div className="ptr" style={{ height: refreshing ? 40 : pull }} aria-live="polite">
          {refreshing ? "Checking for mail…" : pull >= PULL_AT ? "Release to refresh" : "Pull to refresh"}
        </div>}
        {rows.map((r) => <EntrySection key={r.id} row={r} onOpen={() => onOpen(r.id)} />)}
        {loading && <Loading label="Checking your PO Box…" />}
        {!loading && !rows.length && (q ? <p className="empty-main">No entries match.</p> : <div className="empty-main">
          <img className="stamp-art" src="/stamp-art.svg" alt="" />
          <p>Your PostPad is empty. Add a sender: you get an address, and whatever posts to it becomes an entry here, rewritten with each delivery.</p>
          <p><button className="primary" onClick={onAdd}>Add sender</button></p>
        </div>)}
      </div>
    </div>
  );
}

// Entry bodies never carry an H1 (the title is the pad's heading), but agent cards open with
// "## <icon> <Name> · <where>". Drop a leading heading that just repeats the entry name.
const withoutTitle = (md: string, title: string) => {
  const m = md.match(/^#{1,3}\s+(.*)\n+/);
  return m && m[1].replace(/^[^\p{L}\p{N}]+/u, "").trim() === title.trim() ? md.slice(m[0].length) : md;
};

function EntrySection({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const body = withoutTitle(row.markdown, row.title);
  return (
    <section className={`entry${row.fresh ? " fresh" : ""}`} id={`e-${row.id}`}>
      <header className="entry-head">
        <h1 className="entry-title"><button onClick={onOpen} title="Open this entry">{row.title}</button></h1>
        <span className="entry-meta">
          {row.source && <span className="chip">{row.source}</span>}
          <time className="entry-age" dateTime={row.updated_at} title={new Date(row.updated_at).toLocaleString()}>
            {row.fresh ? "new · " : ""}{ago(row.updated_at)}
          </time>
          {row.pinned && <span>pinned</span>}
        </span>
        <span className="entry-actions">
          <CopyButton className="link" text={row.address} label="Copy address" />
          <button className="link" onClick={onOpen}>Open</button>
        </span>
      </header>
      {body.trim()
        ? <div className="markdown" dangerouslySetInnerHTML={md(body)} />
        : <p className="waiting">No mail yet. POST JSON to <code>{row.address}</code>, or open this entry to connect a sender.</p>}
    </section>
  );
}

// Loading: the engraved stamp, gently bobbing, with a short caption. Used wherever we wait on the post office.
function Loading({ label, small }: { label: string; small?: boolean }) {
  return (
    <div className={`loading-state${small ? " small" : ""}`} role="status">
      <img className="stamp-art" src="/stamp-art.svg" alt="" />
      <p>{label}</p>
    </div>
  );
}

// Header icons: Lucide "plus" and "settings" (ISC), drawn at the same size and stroke so they match.
const svgIcon = (children: React.ReactNode) => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
const PlusIcon = () => svgIcon(<path d="M3.5 12h17M12 3.5v17" />); // spans ~the gear's width so they read the same size
const GearIcon = () => svgIcon(<>
  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
  <circle cx="12" cy="12" r="3" />
</>);

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return <button className={className} onClick={() => copy(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}>{done ? "Copied" : label}</button>;
}

// One entry on its own: title, who delivered it, the address strip, then the latest
// delivery filling the pane. History opens as a bottom panel. "‹ Pad" returns to the document.
function EntryView({ id, version, onBack, onChange, onDeleted }:
  { id: string; version?: string; onBack: () => void; onChange: () => void; onDeleted: () => void }) {
  const [note, setNote] = useState<EntryDetail | null>(null);
  const [rev, setRev] = useState<RevisionBody | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);       // an earlier delivery being viewed
  const [viewing, setViewing] = useState<RevisionBody | null>(null);
  const [cmp, setCmp] = useState<DiffLine[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState("");
  const load = () => api.getEntry(id).then(setNote).catch((e) => setErr(String(e.message)));
  useEffect(() => { setNote(null); setShowDetails(false); setConfirmDelete(false); setErr(""); setViewId(null); }, [id]);
  useEffect(() => {
    setViewing(null); setCmp(null);
    if (viewId) api.getRevision(id, viewId).then(setViewing).catch((e) => setErr(String(e.message)));
  }, [id, viewId]);
  useEffect(() => { load(); }, [id, version]);
  useEffect(() => {
    if (!note?.current_revision_id) return setRev(null);
    api.getRevision(note.id, note.current_revision_id).then(setRev).catch(() => setRev(null));
  }, [note?.id, note?.current_revision_id]);

  const back = <button className="back" onClick={onBack}>‹ Pad</button>;
  if (err) return <div className="noteview">{back}<div className="err" role="alert">{err}</div></div>;
  if (!note) return <div className="noteview"><header className="nv-head">{back}</header><Loading label="Opening entry…" /></div>;

  const token = api.getToken(id);
  const delivered = !!note.current_revision_id;
  return (
    <div className="noteview">
      <header className="nv-head">
        {back}
        <h1 className="nv-title">{note.title}</h1>
        <div className="nv-actions">
          <button className={showHistory ? "on" : ""} aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>History</button>
          <EntryMenu pinned={note.pinned} onDelete={() => setConfirmDelete(true)}
            onPin={() => api.patchEntry(id, { pinned: !note.pinned }).then(() => { load(); onChange(); })} />
        </div>
      </header>
      <p className="nv-meta">
        {delivered
          ? <>Delivered {ago(note.updated_at)} by <span className="chip">{note.source || "unnamed sender"}</span> · {new Date(note.updated_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</>
          : "Waiting for first delivery"}
        {note.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
      </p>
      <Address url={note.address} token={token} open={showDetails} onToggle={() => setShowDetails(!showDetails)} />
      {showDetails && <div className="details">
        <Connect title={note.title} url={note.address} token={token} />
        <UpdateRules note={note} raw={rev?.raw_json} onSaved={load} />
        <EndpointSettings note={note} token={token} onSaved={load} />
      </div>}

      {confirmDelete && (
        <div className="confirm" role="alertdialog" aria-label="Remove entry">
          <span>Remove this entry and its address? Anything still posting to it gets a 404, and its history is deleted. This can't be undone.</span>
          <button onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="danger" onClick={() => api.deleteEntry(id).then(onDeleted).catch((e) => setErr(String(e.message)))}>Remove entry and address</button>
        </div>
      )}
      {note.last_skipped_at && <p className="slip">Skipped a post {ago(note.last_skipped_at)}: {note.last_skip_reason}</p>}

      <div className="nv-body">
        {viewId ? <>
          <div className="viewing">
            <span>Earlier delivery{viewing && <> · {new Date(viewing.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · <span className="chip">{viewing.source || "unnamed sender"}</span></>}</span>
            <span className="viewing-actions">
              <button disabled={!viewing} onClick={() => api.diff(id, viewId, note.current_revision_id ?? undefined).then((d) => setCmp(d.diff)).catch((e) => setErr(String(e.message)))}>Compare with current</button>
              <button disabled={!viewing} onClick={() => api.restoreRevision(id, viewId).then(() => { setViewId(null); load(); onChange(); })}>Restore this version</button>
              <button className="link" onClick={() => setViewId(null)}>Back to latest</button>
            </span>
          </div>
          {cmp && <pre className="diff">{cmp.map((l, i) => <div key={i} className={l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx"}>{l.op} {l.text}</div>)}</pre>}
          {viewing ? <div className="markdown" dangerouslySetInnerHTML={md(viewing.rendered_markdown)} /> : <Loading label="Opening that delivery…" small />}
        </> : delivered
          ? <div className="markdown" dangerouslySetInnerHTML={md(note.markdown)} />
          : <div className="waiting">
              <p>No mail yet. POST JSON to the address above and the latest delivery shows here.</p>
              {!showDetails && <button onClick={() => setShowDetails(true)}>Connect a sender</button>}
            </div>}
      </div>
      {showHistory && <section className="panel" aria-label="History">
        <div className="panel-head"><span>History</span><button className="icon" aria-label="Close history" onClick={() => setShowHistory(false)}>×</button></div>
        <History id={id} version={note.current_revision_id} viewing={viewId} onView={setViewId} />
      </section>}
    </div>
  );
}

// "The address on the back": one line under the title, copyable, with connectors and
// delivery rules one click away instead of behind a tab.
function Address({ url, token, open, onToggle }: { url: string; token: string; open: boolean; onToggle: () => void }) {
  return (
    <div className="address">
      <span className="addr-verb">POST</span>
      <code className="addr-url" title={url}>{url}</code>
      <CopyButton text={url} label="Copy" />
      <CopyButton text={curlExample(url, token)} label="Copy curl" />
      {token && <CopyButton text={token} label="Copy token" />}
      <button className="link" aria-expanded={open} onClick={onToggle}>{open ? "Hide delivery settings" : "Connect & settings…"}</button>
    </div>
  );
}

// The one overflow menu for an entry: pin and remove, plain text.
function EntryMenu({ pinned, onPin, onDelete }: { pinned: boolean; onPin: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    // capture + preventDefault so Escape closes just this menu, not the entry behind it
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    addEventListener("pointerdown", click); addEventListener("keydown", esc, true);
    return () => { removeEventListener("pointerdown", click); removeEventListener("keydown", esc, true); };
  }, [open]);
  const pick = (f: () => void) => () => { setOpen(false); f(); };
  return (
    <div className="menu" ref={ref}>
      <button className="more" aria-label="Entry actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open && <div className="menu-list" role="menu">
        <button role="menuitem" onClick={pick(onPin)}>{pinned ? "Unpin" : "Pin to top"}</button>
        <button role="menuitem" className="danger" onClick={pick(onDelete)}>Remove entry…</button>
      </div>}
    </div>
  );
}

function Connect({ title, url, token }: { title: string; url: string; token: string }) {
  const [id, setId] = useState("");
  const c = CONNECTORS.find((x) => x.id === id);
  const text = c?.text(title, url, token) ?? "";
  return (
    <div className="card">
      <label className="eyebrow" htmlFor="pp-connect">Connect a sender</label>
      <select id="pp-connect" value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Choose an agent or service…</option>
        {CONNECTORS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      {c && <>
        <p className="hint">{c.where}{!token && " This device doesn't have the entry's token; replace <TOKEN>."}</p>
        <pre className="curl">{text}</pre>
        <div className="row start"><button onClick={() => copy(text)}>Copy</button></div>
      </>}
    </div>
  );
}

// Ingest filters: when a POST is allowed to update this entry (docs/INGEST_FILTERS.md).
type RuleRow = { key: string; values: string };
const toRows = (rs?: Rule[]): RuleRow[] => (rs ?? []).map((r) => ({ key: r.key, values: r.equals.join(", ") }));
const toRules = (rows: RuleRow[]): Rule[] => rows.filter((r) => r.key.trim())
  .map((r) => ({ key: r.key.trim(), equals: r.values.split(",").map((v) => v.trim()).filter(Boolean) }));
// Dot paths of the latest payload's leaves, offered as key suggestions.
const keyPaths = (v: unknown, p = "", out: string[] = []): string[] => {
  if (out.length >= 50) return out;
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v).slice(0, 50)) keyPaths(x, p ? `${p}.${k}` : k, out);
  else if (p) out.push(p);
  return out;
};
const parseKeys = (raw?: string) => { try { return raw ? keyPaths(JSON.parse(raw)) : []; } catch { return []; } };

function UpdateRules({ note, raw, onSaved }: { note: EntryDetail; raw?: string; onSaved: () => void }) {
  const [include, setInclude] = useState(toRows(note.ingest_filter?.include));
  const [exclude, setExclude] = useState(toRows(note.ingest_filter?.exclude));
  const [msg, setMsg] = useState("");
  useEffect(() => {
    setInclude(toRows(note.ingest_filter?.include)); setExclude(toRows(note.ingest_filter?.exclude)); setMsg("");
  }, [note.id]);
  const keys = parseKeys(raw);
  const count = (note.ingest_filter?.include.length ?? 0) + (note.ingest_filter?.exclude.length ?? 0);
  const save = () => {
    const rules = { include: toRules(include), exclude: toRules(exclude) };
    return api.patchEntry(note.id, { ingest_filter: rules })
      // Show exactly what was stored: blank rows dropped, values trimmed.
      .then(() => { setInclude(toRows(rules.include)); setExclude(toRows(rules.exclude)); setMsg("Saved."); onSaved(); })
      .catch((e) => setMsg(String(e.message)));
  };

  return (
    <details className="card rules" open={count > 0 || undefined}>
      <summary className="eyebrow">Delivery rules{count ? ` (${count})` : ""}</summary>
      <p className="hint">Decide which posts get delivered to this entry, by a key in the posted JSON. Several values in one rule mean any of them. Mail that doesn't qualify is returned unopened and doesn't change the entry.</p>
      <datalist id="pp-keys">{keys.map((k) => <option key={k} value={k} />)}</datalist>
      <RuleRows label="Only deliver when" rows={include} set={setInclude} />
      <RuleRows label="Never deliver when" rows={exclude} set={setExclude} />
      <div className="row start"><button className="primary" onClick={save}>Save rules</button>{msg && <span className="hint">{msg}</span>}</div>
    </details>
  );
}

// Endpoint settings for senders that can't send 'Authorization: Bearer': token in the URL,
// or a webhook signature (HMAC-SHA256 of the body). Body formats are auto-detected, so no setting.
const SIG_HEADERS = [
  ["X-Hub-Signature-256", "GitHub"], ["X-Gitea-Signature", "Gitea"], ["X-Forgejo-Signature", "Forgejo"],
  ["Linear-Signature", "Linear"], ["X-Shopify-Hmac-Sha256", "Shopify"],
];

function EndpointSettings({ note, token, onSaved }: { note: EntryDetail; token: string; onSaved: () => void }) {
  const [header, setHeader] = useState(note.signing?.header ?? SIG_HEADERS[0][0]);
  const [secret, setSecret] = useState(""); // shown once, right after it's generated
  const [msg, setMsg] = useState("");
  useEffect(() => { setHeader(note.signing?.header ?? SIG_HEADERS[0][0]); setSecret(""); setMsg(""); }, [note.id]);
  const patch = (body: Record<string, unknown>) => api.patchEntry(note.id, body)
    .then((r: { signing_secret?: string }) => { if (r.signing_secret) setSecret(r.signing_secret); setMsg("Saved."); onSaved(); })
    .catch((e) => setMsg(String(e.message)));
  const urlWithToken = `${note.address}?token=${token || "<TOKEN>"}`;

  return (
    <details className="card rules" open={note.allow_url_token || !!note.signing || undefined}>
      <summary className="eyebrow">Address settings</summary>
      <p className="hint">Accepts JSON (whatever the Content-Type), plain text (Content-Type: text/plain, shown as markdown) and form fields, including GitHub's form payloads. By default senders authenticate with 'Authorization: Bearer &lt;token&gt;'.</p>
      <label className="check">
        <input type="checkbox" checked={note.allow_url_token} onChange={(e) => patch({ allow_url_token: e.target.checked })} />
        <span>Allow the token in the URL, for senders that can only take a URL. URLs can end up in logs.</span>
      </label>
      {note.allow_url_token && <code onClick={() => copy(urlWithToken)} title="Click to copy">{urlWithToken}</code>}
      <label className="check">
        <input type="checkbox" checked={!!note.signing} onChange={(e) => { setSecret(""); patch({ signing: e.target.checked ? { header } : null }); }} />
        <span>Verify a webhook signature (HMAC-SHA256 of the body) instead of a token</span>
      </label>
      {note.signing && (
        <div className="rule">
          <input list="pp-sig-headers" aria-label="signature header" value={header} onChange={(e) => setHeader(e.target.value)} />
          <button onClick={() => patch({ signing: { header } })}>Save header</button>
          <button onClick={() => patch({ signing: { header, rotate: true } })}>New secret</button>
        </div>
      )}
      <datalist id="pp-sig-headers">{SIG_HEADERS.map(([h, who]) => <option key={h} value={h}>{who}</option>)}</datalist>
      {secret && (
        <div className="secret">
          <span className="hint">Signing secret. It's shown once: paste it into the sender's "Secret" field.</span>
          <code className="tok" onClick={() => copy(secret)} title="Click to copy">{secret}</code>
        </div>
      )}
      {msg && <span className="hint">{msg}</span>}
    </details>
  );
}

function RuleRows({ label, rows, set }: { label: string; rows: RuleRow[]; set: (r: RuleRow[]) => void }) {
  const edit = (i: number, patch: Partial<RuleRow>) => set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="rulegroup">
      <label>{label}</label>
      {rows.map((r, i) => (
        <div className="rule" key={i}>
          <input list="pp-keys" aria-label="key" placeholder="key, e.g. status" value={r.key} onChange={(e) => edit(i, { key: e.target.value })} />
          <span className="hint">equals</span>
          <input aria-label="values" placeholder="failed, error" value={r.values} onChange={(e) => edit(i, { values: e.target.value })} />
          <button className="link" aria-label="remove rule" onClick={() => set(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="link" onClick={() => set([...rows, { key: "", values: "" }])}>+ add rule</button>
    </div>
  );
}

// History: every delivery to this entry, newest first. Click one to read it in the pane
// (compare / restore live on that view); click Current to go back to latest.
function History({ id, version, viewing, onView }:
  { id: string; version: string | null; viewing: string | null; onView: (rev: string | null) => void }) {
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { setRevs(null); api.listRevisions(id).then(setRevs).catch((e) => setErr(String(e.message))); }, [id, version]);

  if (err) return <div className="history"><div className="err" role="alert">{err}</div></div>;
  if (!revs) return <div className="history"><Loading label="Loading history…" small /></div>;
  return (
    <div className="history">
      <ol className="ledger">
        {revs.map((r, i) => {
          const current = i === 0, on = current ? !viewing : viewing === r.id;
          return (
            <li key={r.id}>
              <button className={`ledger-item${on ? " on" : ""}`} aria-current={on || undefined} onClick={() => onView(current ? null : r.id)}>
                <time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time>
                <span className="rsrc">{r.source || "unnamed sender"}</span>
                <span className="badge">{current ? "Current" : on ? "Viewing" : "View"}</span>
              </button>
            </li>
          );
        })}
        {!revs.length && <li className="empty">No deliveries yet. POST to this entry's address.</li>}
      </ol>
    </div>
  );
}

// Adding a sender = issuing an address. The entry it owns appears in the pad.
function AddSender({ onDone }: { onDone: (id?: string) => void }) {
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [result, setResult] = useState<{ id: string; address: string; token: string } | null>(null);
  const [err, setErr] = useState("");
  const submit = () =>
    api.addEntry(title || "Untitled", tags.split(",").map((t) => t.trim()).filter(Boolean))
      .then((r) => setResult(r)).catch((e) => setErr(String(e.message)));

  return (
    <Modal onClose={() => onDone(result?.id)}>
      {!result ? <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>Add a sender</h2>
        <p className="hint">Name the entry this sender writes. You get an address; each post to it rewrites that entry in your pad.</p>
        <label htmlFor="pp-title">Entry name</label>
        <input id="pp-title" autoFocus placeholder="e.g. Nightly deploy, Claude Code" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="pp-tags">Tags (optional)</label>
        <input id="pp-tags" placeholder="comma, separated" value={tags} onChange={(e) => setTags(e.target.value)} />
        {err && <div className="err" role="alert">{err}</div>}
        <div className="row"><button type="button" onClick={() => onDone()}>Cancel</button><button className="primary">Create address</button></div>
      </form> : <>
        <h2>Address ready</h2>
        <p className="hint">Copy the token now; it's shown only once.</p>
        <label>Address</label>
        <div className="keyrow"><code className="boxkey">{result.address}</code><CopyButton text={result.address} label="Copy" /></div>
        <label>Token</label>
        <div className="keyrow"><code className="tok boxkey">{result.token}</code><CopyButton text={result.token} label="Copy" /></div>
        <Connect title={title || "Untitled"} url={result.address} token={result.token} />
        <div className="row"><button className="primary" onClick={() => onDone(result.id)}>Done</button></div>
      </>}
    </Modal>
  );
}

// --- Your PO Box: key, printout, PO Box file ---------------------------------
// There are no accounts. A box key opens a PO Box at a post office (the backend); the
// PDF printout and the encrypted PO Box file are how you take it to another device.

const downloadKeyPdf = (key: string) => saveFile("postpad-box-key.pdf", boxKeyPdf(key, api.getBase()), "application/pdf");

function Welcome({ onDone }: { onDone: () => void }) {
  const [base, setBaseV] = useState(api.getBase());
  const [key, setKey] = useState("");
  const [file, setFile] = useState("");
  const [pass, setPass] = useState("");
  const [newKey, setNewKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setMsg("");
    try { api.setBase(base || api.DEFAULT_BASE); await f(); }
    catch (e) { setMsg(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  if (newKey) return (
    <div className="welcome"><div className="modal" role="main">
      <h2>Your PO Box is open</h2>
      <p>This is your <strong>box key</strong>. PostPad has no accounts: this key is the only way into your box.</p>
      <code className="tok boxkey" onClick={() => copy(newKey)} title="Click to copy">{newKey}</code>
      <div className="row start">
        <button onClick={() => copy(newKey)}>Copy key</button>
        <button onClick={() => run(() => downloadKeyPdf(newKey))}>Download PDF</button>
      </div>
      <p className="hint">You'll need it to open this box on your phone or another computer, for widgets, and to get back in after reinstalling. Keep it in a password manager, or keep the PDF somewhere safe. Anyone with the key can read your pad, and a lost key can't be recovered.</p>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /><span>I've saved my box key</span></label>
      {msg && <p className="hint" role="alert">{msg}</p>}
      <div className="row"><button className="primary" disabled={!saved} onClick={() => { api.setBoxKey(newKey); onDone(); }}>Go to my pad</button></div>
    </div></div>
  );

  return (
    <div className="welcome"><div className="modal" role="main">
      <h2>Welcome to PostPad</h2>
      <p>Your pad lives in a PO Box at the post office, and senders deliver to its entries. Open yours with its box key, or open a new one.</p>

      <section className="way">
        <h3 className="eyebrow">I have a box key</h3>
        <div className="keyrow">
          <input type="password" autoComplete="off" aria-label="box key" placeholder="ppb_…" value={key} onChange={(e) => setKey(e.target.value)} />
          <button disabled={busy || !key.trim()} onClick={() => run(async () => { await api.checkBoxKey(key); api.setBoxKey(key); onDone(); })}>Open box</button>
        </div>
      </section>

      <section className="way">
        <h3 className="eyebrow">I have a PO Box file</h3>
        <input type="file" accept=".json,application/json" aria-label="PO Box file" onChange={(e) => e.target.files?.[0]?.text().then(setFile)} />
        <textarea rows={3} aria-label="PO Box file contents" placeholder="…or paste its contents" value={file} onChange={(e) => setFile(e.target.value)} />
        <div className="keyrow">
          <input type="password" autoComplete="off" aria-label="PO Box file passphrase" placeholder="passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
          <button disabled={busy || !file.trim()} onClick={() => run(async () => { await api.importBoxFile(file, pass); onDone(); })}>Import</button>
        </div>
      </section>

      <section className="way">
        <h3 className="eyebrow">I'm new here</h3>
        <button className="primary" disabled={busy} onClick={() => run(async () => setNewKey(await api.openNewBox()))}>Open a new PO Box</button>
      </section>

      <details className="way">
        <summary className="eyebrow">Post office</summary>
        <input aria-label="post office address" value={base} onChange={(e) => setBaseV(e.target.value)} placeholder={api.DEFAULT_BASE} />
        <p className="hint">Leave this as PostPad's post office, or enter your self-hosted server.</p>
      </details>
      {msg && <p className="hint" role="alert">{msg}</p>}
    </div></div>
  );
}

function Settings({ onClose, onLeave }: { onClose: () => void; onLeave: () => void }) {
  const key = api.getBoxKey();
  const [show, setShow] = useState(false);
  const [pass, setPass] = useState("");
  const [file, setFile] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [msg, setMsg] = useState("");
  const run = (p: Promise<unknown>) => p.then(() => setMsg("")).catch((e) => setMsg(String(e.message)));
  return (
    <Modal onClose={onClose}>
      <h2>Your PO Box</h2>
      <label>Post office</label>
      <code>{api.getBase()}</code>
      <label>Box key</label>
      <div className="keyrow">
        <code className="tok boxkey">{show ? key : `${key.slice(0, 8)}${"•".repeat(24)}`}</code>
        <button onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
      </div>
      <div className="row start">
        <button onClick={() => copy(key)}>Copy key</button>
        <button onClick={() => run(downloadKeyPdf(key))}>Download PDF</button>
      </div>
      <p className="hint">No account: this key is your box. Use it to open the box on another device. Anyone with it can read and manage your pad.</p>


      <details className="transfer">
        <summary className="eyebrow">Export PO Box file</summary>
        <p className="hint">An encrypted file with your post office, box key and delivery tokens, locked with a passphrase you choose. Import it on another device.</p>
        <div className="keyrow">
          <input type="password" autoComplete="new-password" aria-label="export passphrase" placeholder="passphrase, 8+ characters" value={pass} onChange={(e) => setPass(e.target.value)} />
          <button onClick={() => run(api.exportBoxFile(pass).then(async (f) => { setFile(f); await saveFile("postpad-po-box.json", new TextEncoder().encode(f), "application/json"); }))}>Export</button>
        </div>
        {file && <div className="row start"><button onClick={() => copy(file)}>Copy file contents</button><span className="hint">for pasting on a phone</span></div>}
      </details>

      <details className="transfer">
        <summary className="eyebrow">Use a different PO Box</summary>
        <p className="hint">This device forgets this box key and goes back to the welcome screen. Your pad stays in the box, but you'll need the key (PDF or PO Box file) to get back in.</p>
        {!leaving
          ? <div className="row start"><button className="danger" onClick={() => setLeaving(true)}>Forget this key on this device</button></div>
          : <div className="confirm" role="alertdialog" aria-label="Forget box key">
              <span>Have you saved your box key? Without it you can't open this box again.</span>
              <button onClick={() => setLeaving(false)}>Cancel</button>
              <button className="danger" onClick={() => { api.setBoxKey(""); onLeave(); }}>Forget it</button>
            </div>}
      </details>
      {msg && <p className="hint" role="alert">{msg}</p>}
      <div className="row"><button onClick={onClose}>Close</button></div>
    </Modal>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  return <div className="backdrop" onClick={onClose}><div className="modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>{children}</div></div>;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ago = (iso: string) => {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  for (const [unit, n] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  return "just now";
};
// Compact age for dense rows: now, 5m, 3h, 2d.
const short = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const copy = (s: string) => navigator.clipboard.writeText(s);
const curlExample = (url: string, token: string) =>
  `curl -X POST ${url} \\\n  -H "Authorization: Bearer ${token || "<TOKEN>"}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"status":"green","message":"all systems go"}'`;
