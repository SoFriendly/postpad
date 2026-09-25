# PostPad — Widget Strategy

Widgets are a first-class PostPad surface: a pinned note must show its latest
rendered markdown on the home screen / desktop, updating without notifications.
This doc records what Tauri 2 can and can't do (researched 2025–2026) and the
path we're taking.

## Bottom line

**Tauri 2 has no native widget API, and there is no roadmap for one.** The
official request ([tauri#9766](https://github.com/tauri-apps/tauri/issues/9766),
May 2024) was converted to an unowned discussion
([#14555](https://github.com/orgs/tauri-apps/discussions/14555), Nov 2025) with
no owner.

Widgets are still shippable — as a **hybrid**: the normal Tauri app plus
**native widget extensions** (Swift WidgetKit on Apple, Kotlin Glance on
Android) added into the Xcode/Gradle projects Tauri generates. This is a
manual-but-solved pattern.

**Recommendation: go hybrid. Do not wait for pure-Tauri widgets, and do not
build a separate widget-only client.**

## The core mechanism (all platforms)

The main app writes the latest rendered note into a **shared local cache**; the
widget reads that cache. **Widgets must not call the PostPad HTTP API
directly** — widget extensions have tight OS execution/network/battery budgets
and refresh on the OS timeline, so direct HTTP is unreliable. The body is
already rendered markdown, so render once in the app and let the widget be a
dumb view.

- **iOS / macOS:** App Group shared container (a file or `UserDefaults(suiteName:)`), then `WidgetCenter.reload`.
- **Android:** SharedPreferences / Jetpack DataStore (same app sandbox, no App Group), then the widget-update broadcast.

## Per-platform feasibility

| Platform | Feasible | Mechanism | Effort | Risk |
|----------|----------|-----------|--------|------|
| **iOS** WidgetKit | Yes (hybrid) | Swift Widget Extension target declared in `project.yml`; App Group | Medium-high | Medium |
| **Android** App Widget | Yes (hybrid) | Kotlin Glance/`RemoteViews` in `gen/android/`; SharedPreferences | Medium | Low-med |
| **macOS** WidgetKit | Yes (hybrid) | Same as iOS, shares the Swift widget code; App Group | Medium-high | Medium |

### The preservation caveat (decides the whole approach)

Tauri regenerates the native mobile projects, so hand edits can be wiped:

- **iOS/macOS** projects are **XcodeGen-generated** from `src-tauri/gen/apple/project.yml`. Only things declared in `project.yml` (or a custom template) survive `tauri ios build`. **Direct `.xcodeproj` GUI edits are lost on regen** — the widget target *must* be expressed in `project.yml`.
- **Android** (`gen/android/`) tolerates hand edits better; widget code + manifest entries added under the app module persist across rebuilds.

Known limits: on Apple, the widget works only in **release/TestFlight builds, not `tauri dev`**, and **signing must be correct or the widget silently fails** — iterate the widget in Xcode directly. On Android, keep Glance layouts flat (nesting is buggy on some launchers).

## Prior art / tooling

- **[`s00d/tauri-plugin-widgets`](https://github.com/s00d/tauri-plugin-widgets)** — the only real cross-platform attempt. JSON IR → SwiftUI (Apple) / Glance (Android) / Adaptive Cards (Windows) / HTML (desktop). Supplies the shared-cache storage + reload for free (`appGroup`/`userDefaults`/`widgetContainer`). **~v0.5, pre-1.0, single-maintainer, "experimental."** Evaluate first; don't hard-depend.
- **[`Choochmeque/tauri-apple-extensions`](https://github.com/Choochmeque/tauri-apple-extensions)** — CLI that scaffolds Apple extension targets into XcodeGen and wires up App Groups. Ships mainly a Share extension today; useful as the scaffolding mechanism even if we write the widget ourselves.
- Tracking: [plugins-workspace#2738](https://github.com/tauri-apps/plugins-workspace/issues/2738).

## Plan for PostPad

1. **Now (this slice):** ship the Tauri app + Worker API. Widget code is **not** built yet — it's blocked on native tooling, not on the API. The `WidgetPin` concept (note_id + size, per requirements) is deferred; the app just fetches and renders note bodies, which is the same data a widget will show.
2. **Widget spike (next):** shared-cache write path in the Rust core after each note fetch:
   - Apple → App Group container file + `WidgetCenter.reload`.
   - Android → SharedPreferences + widget update broadcast.
3. **Apple widget:** one SwiftUI WidgetKit target shared between iOS and macOS, declared in `project.yml` so `tauri build` preserves it. Enable App Groups on app + extension. Test in release/TestFlight (no dev preview).
4. **Android widget:** Glance widget in `gen/android/`, flat layout.
5. **Evaluate `tauri-plugin-widgets` early** — if its JSON IR expresses a status-board layout, it collapses steps 2–4 into one dependency using the same channels; if it's too limiting, hand-write the extensions (nothing is wasted — same App Group / SharedPreferences transport).

**Effort/risk order:** Android lowest, iOS/macOS medium-high (signing + no dev preview). Cross-cutting risk: all this tooling is community-grade and pre-1.0 — budget to maintain the native Swift/Kotlin ourselves rather than rely on a plugin staying alive.

### Sources
tauri#9766 · discussions#14555 · plugins-workspace#2738 · tauri/discussions#3122 · s00d/tauri-plugin-widgets · Choochmeque/tauri-apple-extensions · developer.android.com/develop/ui/views/appwidgets · tauri.app/release/@tauri-apps/cli/v2.5.0 · tauri#14332
