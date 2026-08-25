//! App-version endpoint driving the desktop "update available" prompt.
//!
//! `GET /app-version` serves the contents of a small JSON file that the
//! operator drops next to the binary when publishing a release:
//!
//! ```json
//! {
//!   "version": "0.5.40",
//!   "download_url": "https://download.example.com/Sovereign-Setup.exe",
//!   "notes": "Game-only stream audio, DM reactions, …"
//! }
//! ```
//!
//! The file is read per request (it's tiny and traffic is low), so publishing
//! a new version is just pushing a new JSON file — **no server rebuild or
//! restart**. Returns 404 while the file is absent, which clients treat as
//! "no update info available".
//!
//! Path comes from `APP_VERSION_FILE` (default `app-version.json`, resolved
//! against the service working directory — `/opt/puca` in the packaged
//! deployment).
//!
//! This replaced a vestigial Tauri auto-updater manifest (hardcoded version
//! constant, axum 0.8 route syntax that axum 0.7 never matched, placeholder
//! signatures — and unsigned builds can't install updater artifacts anyway).
//! If signed builds ever happen, the updater-plugin flow can return; see
//! tauri.conf.json's `plugins.updater` section for the retained
//! endpoint/pubkey.

use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};

fn version_file_path() -> String {
    std::env::var("APP_VERSION_FILE").unwrap_or_else(|_| "app-version.json".to_string())
}

/// Path of the mobile OTA manifest. Same publish model as app-version.json:
/// drop `{"version": "...", "url": "https://.../sovereign-web-<v>.zip"}` next
/// to the binary and Capacitor clients (UpdateGate) pick it up on next launch.
fn mobile_update_file_path() -> String {
    std::env::var("MOBILE_UPDATE_FILE").unwrap_or_else(|_| "mobile-update.json".to_string())
}

/// Serve a small operator-pushed JSON file, 404 when absent or corrupt.
async fn serve_json_file(path: String, label: &str) -> axum::response::Response {
    match tokio::fs::read_to_string(&path).await {
        Ok(body) => {
            // Validate it's JSON so a corrupt push can't break clients.
            if serde_json::from_str::<serde_json::Value>(&body).is_ok() {
                ([("content-type", "application/json")], body).into_response()
            } else {
                tracing::warn!("[Update] {label} file is not valid JSON");
                StatusCode::NOT_FOUND.into_response()
            }
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn app_version() -> impl IntoResponse {
    serve_json_file(version_file_path(), "app-version").await
}

async fn mobile_update_check() -> impl IntoResponse {
    serve_json_file(mobile_update_file_path(), "mobile-update").await
}

/// Create the update routes router.
/// Generic over state type to allow merging with any Router state.
pub fn update_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/app-version", get(app_version))
        // Path matches what frontend UpdateGate.tsx fetches on mobile launch.
        .route("/api/mobile-updates/check", get(mobile_update_check))
}
