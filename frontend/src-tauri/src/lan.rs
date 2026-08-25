//! LAN details for this machine.
//!
//! The implementation moved to `puca_service::lan` when the SYSTEM service
//! needed it to answer wake requests — see that module's header. This re-export
//! keeps `crate::lan::collect()` working for the app's own callers, which is
//! most of them.

pub use puca_service::lan::{collect, LanInfo};

/// Async + `spawn_blocking`: this enumerates every network adapter, and a sync
/// Tauri command runs on the webview's main thread (the same hazard documented
/// on `get_running_apps` and `list_anticheat_processes`).
#[tauri::command]
pub async fn lan_info() -> Option<LanInfo> {
    tauri::async_runtime::spawn_blocking(collect)
        .await
        .unwrap_or(None)
}
