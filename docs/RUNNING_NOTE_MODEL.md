# PostPad — One pad, many entries (product model)

Captured / clarified 2026-09-25 from Justin (voice / Grok Bot). **Adopted direction** — supersedes treating each delivery target as its own openable “note.”

## The model

PostPad is **one running document** (your pad), not a mailbox of separate notes.

- You don’t “create notes.” You **add a sender** or **give someone (or something) an address**.
- Each address / sender is an **entry** in the pad — typically an H1 (or equivalent section) that that source owns.
- Ingest **rewrites that entry’s body** (latest-wins for that section). The rest of the pad stays.
- The UI is the pad (scroll / TOC of entries), not a list of notes you open one-by-one.

Quote gist: *They really shouldn’t be notes — you’d add a sender or give your address to someone. Every note is an entry in your PostPad, not a note on its own.*

## Contrast with earlier scaffold

| Old framing | Adopted framing |
|---|---|
| Many notes; open one to read | One pad; always in the document |
| “New note” as primary action | “Add sender” / “New address” |
| Latest-wins replaces a whole note | Latest-wins replaces that **entry** |
| Board of note cards | TOC / sidebar of entries + main pad view |

## Implications

1. **Ingest** — `POST` targets an entry id/slug; rewrites only that section.
2. **History / diffs** — Prefer per-entry revisions (whole-pad history optional later).
3. **UI** — VS Code–calm: sidebar = entries (senders/addresses); main = pad (or focused entry). No giant per-note modal theater. Demote compose; promote add-sender / copy address.
4. **Widgets** — Pin an **entry**, not a separate note object.
5. **REQUIREMENTS** — Update core concepts: Note → Entry; library → pad; create-note → add sender/address.

## Status

Product call locked for docs/UI/backend alignment. Update `REQUIREMENTS.md` and continue `UI_REDIRECT` against this model (sidebar TOC + pad, not multi-note board).
