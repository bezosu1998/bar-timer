// タイマー本体のロジックは全て WebView 側 (src/main.js) にある。
// Rust 側はウィンドウを立ち上げるだけ。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
