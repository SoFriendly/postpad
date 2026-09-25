# PostPad — Architecture

## Goals
- Rust + **Tauri 2** client for **desktop and mobile**
- **Cloudflare-native** backend (prefer Workers, D1, KV, R2, Queues, Durable Objects only when needed)
- Free clients; **hosted or self-hosted** backend with the same API

## Proposed layout (monorepo)
```
postpad/
  apps/desktop/          # Tauri 2 app (shared web UI)
  packages/ui/           # Shared frontend (React/Solid/Svelte — pick one)
  workers/api/           # Cloudflare Worker: REST + ingest
  packages/api-types/    # Shared OpenAPI / TS + Rust types if practical
  docs/
```

## Backend (Cloudflare)
Prefer native services:
- **Workers** — HTTP API + ingest
- **D1** — notes + revisions metadata (and FTS if sufficient)
- **R2** — optional large raw payloads / revision blobs if D1 row limits hurt
- **KV** — edge cache of current note markdown for hot reads / widgets
- **Queues** — optional async fan-out / indexing (not notifications)
- Auth: per-note bearer tokens (hashed at rest); workspace API keys later

Self-host: ship `wrangler.toml` + migrations so a user can `wrangler deploy` their own copy; clients take a base URL (the post office) + a box key. There are no accounts: a random box key opens your PO Box, and moves between devices by the key itself, its PDF printout, or an encrypted PO Box file (see README "PO Boxes").

## Client (Tauri)
- One UI codebase; Tauri 2 desktop (macOS/Windows/Linux) and mobile (iOS/Android) where supported.
- Config: hosted URL default + “custom backend URL” for self-host.
- Local secure storage for tokens.

## Widgets (critical open question)
Homescreen / desktop **widgets are a product requirement**.

Research and decide before locking UI framework details:
1. Does Tauri 2 (or planned plugins) support **iOS WidgetKit**, **Android App Widgets**, **macOS WidgetKit**?
2. If not first-class: recommended approach (native thin widget extension + App Group / shared container talking to same API; or separate small native shell).
3. Risk: if Tauri mobile cannot ship widgets cleanly, recommend alternate client strategy for widget surfaces while keeping Tauri for the main app — or a hybrid.

Document findings in `docs/WIDGETS.md` with a clear recommendation.

## Build priorities for greenfield
1. Research widgets → write `docs/WIDGETS.md` with go/no-go + approach.
2. Scaffold CF Worker + D1 schema + ingest + notes CRUD (hosted-shaped, self-host documented).
3. Scaffold Tauri 2 app with list/detail, create note → show ingest URL/token, render markdown, revision list + basic diff.
4. Wire client to Worker (env for base URL).
5. Spike widget for at least one platform (prefer macOS or iOS based on research).
6. README: run locally, deploy Worker, point client at self-hosted URL.

## Non-negotiables
- No notification features in v1.
- Replace semantics for note body; revisions for history.
- Do not commit secrets; use `.dev.vars` / wrangler secrets examples only.
