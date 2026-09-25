# PostPad — UI spec (workbench)

The visual system behind `apps/desktop` (desktop + Tauri mobile share one web UI), per the 2026-09-25 redirect in [UI_REDIRECT.md](UI_REDIRECT.md): **VS Code–calm workbench, built around glance and delivery.** Post-office is the product's vocabulary, not its texture ([BRANDING.md](BRANDING.md)). The product model is one running pad of entries ([RUNNING_NOTE_MODEL.md](RUNNING_NOTE_MODEL.md), locked): sidebar = the pad's contents, main pane = the pad.

## Layout (one pad, many entries)

Per [RUNNING_NOTE_MODEL.md](RUNNING_NOTE_MODEL.md) (locked): PostPad is **one running document**. Each sender/address owns one **entry** (an H1 section); a delivery rewrites only that entry.

- **Sidebar = contents.** "PostPad" (the app name) with the stamp mark, a small `+` (**Add sender**) and settings; a filter; then **Contents**: a one-line outline of the pad in pad order (title · compact age). Clicking scrolls the pad to that entry; the entry in view is highlighted as you scroll (scroll-spy), and the pad scrolls past its last entry so any entry can reach the top.
- **Main = the pad.** Every entry in order as an H1 section: title (serif), writer chip, age (`new ·` when unread), `pinned`, **Copy address** and **Open**; then its latest body. A repeated leading heading in the body is dropped. An entry with no delivery shows its address inline ("No mail yet. POST JSON to …").
- **Open = one entry on its own** (the focused view): "‹ Pad" back, title, History toggle, `⋯` (Pin / Unpin, Remove entry…), who delivered it, the **address strip** (POST URL, Copy / Copy curl / Copy token, "Connect & settings…" expanding connectors, delivery rules and address settings in place), then the latest body. **History** is a toggled bottom panel.
- **History** lists every delivery to the entry (time · sender · Current / Viewing / View). Clicking one shows that delivery's full body in the pane under an "Earlier delivery · date · sender" banner with **Compare with current**, **Restore this version** and **Back to latest**.
- **Loading** anywhere we wait on the post office (first pad load, opening an entry, history, an earlier delivery) is the engraved stamp, gently bobbing, over a short serif-caps caption ("Checking your PO Box…", "Opening entry…").
- **Add sender:** name the entry → **Address ready** (address + one-time token with Copy) with the connector picker right there. The new entry is scrolled into view.
- **Status bar:** sync state (click to check now), entry count, new count, post office host (rust band).
- No note board, no modal note view, no "New note".

## Signals (one system, used everywhere)

| Signal | Mark |
|---|---|
| New delivery (updated since this device last jumped to or opened the entry) | Bold title + accent age in the contents row; `new ·` in the entry header; "N new" in the status bar |
| Pinned | Pinned entries lead the pad (and so the contents); `pinned` in the entry header |
| Writer | Monospace chip (from the revision's source; in the list, from agent-event headings) |
| Skipped post (ingest filter) | Red left-ruled line above Latest |

No health/status tracking: an entry shows what was delivered, not a verdict on it.

## Tokens (`App.css :root`)

Vintage-stamp palette framing a calm workbench (the reference: low-saturation printed stamps). `--accent` #9a4b35 rust (the only accent: selection, links, new, primary, status band), `--bg` #fcf9f2 cream, `--side` #f1eadb kraft, `--line` #e0d6c2, `--ink` #2e2a24, `--muted` #7d7263, `--ok` / `--bad` for diffs, delete and offline. Type: system UI for chrome and prose; `--serif` for the "PostPad" wordmark, entry and dialog titles, and (in tracked capitals) the Contents label and panel heads; `--mono` only for addresses, ages, writer chips, code, diffs and history times. No theme picker.

Stamp touches, and only these: a small perforated stamp mark by "PostPad"; the status bar as the stamp's colored band (rust, cream lettering); one engraved line-art stamp (`public/stamp-art.svg`) in the empty main pane. Nothing decorative inside a note.

## Responsive

≤720px: the pad is home (pull down from the top to check for new deliveries now), under a bar with **☰ Contents** (opens the sidebar as a drawer), PostPad, `+` and settings. An opened entry fills the screen with "‹ Pad"; History takes the bottom half. Phone chrome is sized for thumbs: 56px top bar with 44px icon targets, 36px status bar, 40–44px header buttons, larger entry links. Safe-area insets, 16px inputs (no iOS focus zoom).

## Not yet

Dark theme; resizable sidebar/panel; writer in the list API; app icon still the stamp mark.
