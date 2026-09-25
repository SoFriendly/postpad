# PostPad UI hard redirect (2026-09-25)

Justin’s read of the current mockups: **overly designed yet bad UX**. Costume on a generic notes app. Redirect immediately.

## Diagnosis (do not argue — fix)

- Postal theme is decoration (airmail stripes, lined paper, stamp stickers, accent names) on Board → modal → Latest/History/Delivery. That’s Notion-with-a-webhook, not a post office.
- Product job is **glance**: what changed, healthy?, who wrote last. Board is truncated markdown walls — not glanceable.
- Primary actions fight the product: “+ New note” is hero chrome on a receive-only surface; Delivery (the magic) is buried in tab 3.
- Near-fullscreen modal kills the desk metaphor.
- Skeuomorphism under ops tables/diffs is noise. Theme frames the shell; body stays calm and readable.
- Six accents + sticker chrome, but no system for new delivery / pin / writer / good-vs-bad.

## New direction

1. **Strip costume.** Kill lined paper backgrounds, airmail borders, stamp stickers, shredder gags, accent rainbow as a feature. Postal language can stay lightly in copy (PO Box, delivered) — not as texture spam.
2. **VS Code vibes.** Workbench energy: quiet chrome, dense but scannable, sidebar + main pane, monospace where it earns it, one restrained accent, hairlines, no modal theater. Think status board / editor layout, not stationery collage.
3. **IA around glance + delivery.**
   - Board of delivered statuses always visible (not a pile of markdown dumps). Show title, age, writer chip, and a one-line or status signal — not a wall of body text.
   - Selecting a note updates a **main pane** (VS Code-style), not a giant modal overlay.
   - Latest is default and dominant.
   - History/diff = secondary pane or drawer.
   - Delivery address = quiet “address on the back” / details section, easy to copy — not a buried third tab people must discover.
   - Empty slot = waiting for mail, not SaaS onboarding wall.
4. **Receive-first chrome.** Demote “New note.” Promote connect/copy ingest where it matters.
5. **One visual system:** new/unread delivery, pinned, writer identity, healthy vs broken — clear before pretty.

## Scope

Implement in `apps/desktop` now. Commit and push a coherent slice. Update `docs/UI_SPEC.md` / branding notes to match this redirect (post-office was direction; execution is VS Code–calm with light postal vocabulary).

Screenshots of desktop + mobile after the first solid pass.
