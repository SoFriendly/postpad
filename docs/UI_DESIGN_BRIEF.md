# PostPad — UI design sprint brief (desktop + mobile)

Fresh Claude Code session focus. Do **not** divert into Worker/D1 deploy or backend migrations — that lives in the existing `postpad` tmux session.

## Goal

Design and implement the **front-end look and feel** for PostPad on **desktop and mobile** (Tauri 2), following the locked visual direction in `docs/BRANDING.md`.

## Brand (read first)

- Post-office vibes: light blues and whites, A4/legal-pad / lined paper, stamps
- Slightly skeuomorphic — tactile, paper-adjacent; not flat SaaS chrome
- Notes arrive like **envelopes that deliver to you** (delivery surface, not a chat feed or generic notes list)
- Postal / mailroom branding, not productivity-suite template
- Non-goals: full 3D OS recreation; blocking on a heavy brand system — ship a real UI shell that reads postal

Also skim: `docs/REQUIREMENTS.md` (product), `docs/WIDGETS.md` (hybrid widgets — design for widget-friendly cards, but don’t block the main shell on WidgetKit/Glance), `docs/ARCHITECTURE.md` if needed for data shapes.

## Product constraints that shape UI

- Humans **read**; agents/services **write** via ingest. No casual blank-page compose as the hero action.
- Latest-wins status notes + git-style history (show “who/what wrote last”, history behind a gesture).
- Free clients; hosted or self-hosted backend.

## Scope for this session

1. Audit current `apps/desktop` React/Tauri UI (what exists vs placeholder).
2. Propose a thin visual system (palette tokens, type, card/envelope metaphor, empty state, stamp/delivered affordances) and write it down under `docs/` if useful (e.g. extend BRANDING or a short UI_SPEC).
3. Implement the shell for **desktop** first in `apps/desktop`, then align **mobile** Tauri targets / responsive layout so the same web UI feels right on phone.
4. Prefer cohesive postal design over feature sprawl. History, connect/settings, and note detail should match the metaphor.
5. Commit and push when you have a coherent, reviewable UI slice — don’t leave a half-themed mess.

## Out of scope (leave to other session)

- Cloudflare login, remote migrate, `api.postpad.dev` deploy
- Ingest filter implementation beyond what’s already scoped in docs
- Native WidgetKit/Glance coding unless the card design needs a tiny shared cache hook later

## Success

Justin can open the desktop app (and mobile preview if available) and immediately feel “post office / delivered mail,” not a default Vite/Tauri starter.
