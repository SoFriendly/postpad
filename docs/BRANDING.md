# PostPad — Visual branding direction

Captured from Hold & Talk → Grok Bot webhook on 2026-09-25. Product direction for look-and-feel; not yet scoped into a UI sprint.

## Direction

**Lean hard into post-office vibes.** PostPad should feel like mail and desk stationery, not a generic SaaS status dashboard.

### Palette & materials
- Light blues and whites as the primary palette
- A4 / legal-pad cues: lined paper, notepad texture
- Stamps as a recurring motif (status marks, pins, “received” affordances)

### Form language
- Slightly **skeuomorphic** — tactile, paper-adjacent, not flat-only chrome
- Notes / updates arrive like **envelopes that deliver to you** — delivery, not a chat feed
- Branding style should read as postal / mailroom, not productivity-suite template

## How this should show up (open, for design/UI work)
- App chrome and empty states: paper, postal blues, stamp-like badges
- Note cards: envelope / pad metaphor over generic list rows
- Widget pins: stamp or envelope framing where OS widget constraints allow
- Ingest / “delivered” moments: subtle postal language (“delivered”, “postmarked”) without becoming cute copy spam

## Non-goals (for now)
- Full skeuomorphic OS recreation or heavy 3D chrome
- Blocking the Worker/API scaffold on a full brand system — capture direction first; apply when the React UI shell is real

**Execution (2026-09-25 redirect, [UI_REDIRECT.md](UI_REDIRECT.md)):** post office stays as *vocabulary* (PO Box, delivered, address, "no mail yet") and product model, not as texture. The UI itself is a calm, VS Code–style workbench framed by a vintage-stamp palette and type (cream, kraft, one rust ink; tracked serif caps; a stamp mark, a rust status band, engraved line art only in empty states). Airmail stripes, lined paper, sticker chrome and the theme picker were tried and dropped. Current system: [UI_SPEC.md](UI_SPEC.md).

## Source
Hold & Talk webhook payload (verbatim intent):

> What I'm thinking would be really cool is to really lean into the post office vibes: light blues and whites and A4 legal pads and lined paper and stamps. Maybe a slightly skeuomorphic design, almost like envelopes that deliver to you. Really lean into that post office branding style.
