#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Saves live in app-data saves/profile.json; export and import go
        // through the native dialogs (SPEC §23, platform/storage.ts).
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::{Manager, TitleBarStyle};
            if let Some(window) = app.get_webview_window("main") {
                window.set_fullscreen(false)?;
                window.set_title_bar_style(TitleBarStyle::Overlay)?;
                window.maximize()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
