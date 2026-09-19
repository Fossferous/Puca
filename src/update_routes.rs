//! App-version endpoint driving the desktop "update available" prompt.
//!
//! `GET /app-version` serves the contents of a small JSON file that the
//! operator drops next to the binary when publishing a release:
//!
//! ```json
//! {
//!   "version": "0.9.1",
//!   "download_url": "https://download.example.com/Puca-Setup.exe",
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
//!
//! `GET /api/mobile-updates/check?variant=lite` serves a SEPARATE manifest
//! from the plain (full) one. This is the only variant-aware thing the
//! backend does for the lite build — the desktop updater needs no backend
//! change at all, because its endpoint is baked into each binary at build
//! time (tauri.conf.json vs tauri.lite.conf.json point at different URLs
//! before either one ever reaches this server). Mobile is different: both
//! APK variants call the SAME endpoint, and the OTA pushes a JS BUNDLE into
//! an already-installed app, so without this the only way to keep a lite
//! phone from being served the full remote-control bundle was for it to
//! receive NO updates at all (see frontend's bundleVariantMatches, which
//! still fails closed if this ever regresses to serving one file for both).
//!
//! `?variant=notes` serves a THIRD manifest, for Púca Notes' Android app
//! (`com.sovereign.notes`) — a different app, not a variant, whose bundles are
//! signed with a different key. An old server answers `?variant=notes` with
//! the full manifest; the Notes client refuses anything not tagged
//! `"variant": "notes"` (frontend `otaChannelMatches`), so that skew leaves
//! Notes un-updated, never running Púca's bundle.

use axum::{
    extract::Query, http::StatusCode, response::IntoResponse, routing::get, Router,
};
use std::collections::HashMap;

fn version_file_path() -> String {
    std::env::var("APP_VERSION_FILE").unwrap_or_else(|_| "app-version.json".to_string())
}

/// Path of the mobile OTA manifest. Same publish model as app-version.json:
/// drop `{"version": "...", "url": "https://.../sovereign-web-<v>.zip"}` next
/// to the binary and Capacitor clients (UpdateGate) pick it up on next launch.
///
/// `variant` is read from the query string, not trusted otherwise — it
/// selects between two ENV-VAR-CONFIGURED filenames, never becomes part of a
/// path itself, so there is nothing here for a caller to path-traverse with.
/// Anything other than exactly "lite" or exactly "notes" (including absent,
/// empty, "full", or a typo) resolves to the full manifest — fail toward the
/// artifact that has always been safe to serve broadly, not toward one that
/// was just carved out for a narrower audience.
fn mobile_update_file_path(variant: Option<&str>) -> String {
    match variant {
        Some("lite") => std::env::var("MOBILE_UPDATE_FILE_LITE")
            .unwrap_or_else(|_| "mobile-update-lite.json".to_string()),
        Some("notes") => std::env::var("MOBILE_UPDATE_FILE_NOTES")
            .unwrap_or_else(|_| "mobile-update-notes.json".to_string()),
        _ => std::env::var("MOBILE_UPDATE_FILE").unwrap_or_else(|_| "mobile-update.json".to_string()),
    }
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

async fn mobile_update_check(Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let variant = params.get("variant").map(String::as_str);
    let label = match variant {
        Some("lite") => "mobile-update (lite)",
        Some("notes") => "mobile-update (notes)",
        _ => "mobile-update",
    };
    serve_json_file(mobile_update_file_path(variant), label).await
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

#[cfg(test)]
mod tests {
    use super::mobile_update_file_path;

    // Deliberately does NOT set MOBILE_UPDATE_FILE{,_LITE,_NOTES}:
    // std::env::set_var is process-wide and other tests in this binary run in
    // parallel, so mutating it here would be a race against them, not a proof
    // of anything. These pin the DEFAULTS every real deployment relies on
    // unless it explicitly overrides them — which is the path actually
    // exercised in production.

    #[test]
    fn lite_variant_gets_its_own_file() {
        assert_eq!(mobile_update_file_path(Some("lite")), "mobile-update-lite.json");
    }

    /// Púca Notes' own manifest, asked for with exactly `?variant=notes`.
    #[test]
    fn notes_variant_gets_its_own_file() {
        assert_eq!(mobile_update_file_path(Some("notes")), "mobile-update-notes.json");
    }

    /// The safety property the whole endpoint exists for: anything that is
    /// NOT exactly "lite" or "notes" resolves to the manifest that has always
    /// been safe to serve broadly. A query string typo, an absent parameter,
    /// or a literal "full" must never accidentally select a narrower one.
    #[test]
    fn everything_else_fails_toward_full() {
        for v in [
            None,
            Some(""),
            Some("full"),
            Some("Lite"),
            Some("lite "),
            Some("lite2"),
            Some("Notes"),
            Some("notes "),
            Some("notes2"),
            Some("puca-notes"),
        ] {
            assert_eq!(mobile_update_file_path(v), "mobile-update.json", "variant={v:?}");
        }
    }
}
