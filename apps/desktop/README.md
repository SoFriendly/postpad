# PostPad desktop + mobile (Tauri 2 + React)

One pad, many entries: a VS Code–calm workbench with the pad's contents on the left and the pad itself in the main pane. Design system: [docs/UI_SPEC.md](../../docs/UI_SPEC.md).

```sh
npm install
npm run dev          # browser at http://localhost:1420
npm run tauri dev    # desktop app
npm run tauri ios init && npm run tauri ios dev          # iOS (needs Xcode)
npm run tauri android init && npm run tauri android dev  # Android (needs Android SDK)
```

The backend URL is set in the app (⚙ → Post office). It defaults to `https://api.postpad.dev`.
