// PostPad's UI talks to the Worker API over HTTP (fetch) directly, so there are
// no custom Tauri commands yet. The shared-cache write path for widgets
// (see docs/WIDGETS.md) will live here when the widget spike lands.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
