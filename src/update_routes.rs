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
//! `GET /api/ios-web-clip` serves the iPhone/iPad configuration profile that puts
//! the web app on a Home Screen with one tap (the download page's "Install with
//! one tap"). The profile is rendered per deployment at ship time by
//! `deploy/ops/make-web-clip-profile.mjs` and dropped next to the binary as
//! `ios-web-clip.mobileconfig`, the same publish model as the files above. It is
//! served from here, not from the download host's Caddy, for one reason: iOS
//! offers to install a profile only when it arrives as
//! `application/x-apple-aspen-config`, and Caddy would take the type from the
//! host's mime database, which has no `.mobileconfig` on a stock distribution
//! (the same reason the web app's manifest is `.json`). Serving it here needs no
//! change to the production Caddyfile.
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

/// Where the rendered configuration profile lives, next to the binary.
const IOS_WEB_CLIP_FILE: &str = "ios-web-clip.mobileconfig";

/// `application/x-apple-aspen-config`: what makes iOS Safari offer the profile.
const IOS_PROFILE_TYPE: &str = "application/x-apple-aspen-config";

/// Is this plausibly the profile dual-ship rendered, and nothing else? The file
/// is operator-pushed, so a half-written upload or a stray file must not be
/// handed to a phone as a profile. It must be a property list holding exactly
/// one payload, a Web Clip (`com.apple.webClip.managed`): a profile that
/// carried a certificate, a restriction or a VPN would be an entirely different
/// thing to install, and this route refuses to be the way one gets served.
fn is_web_clip_only_profile(body: &str) -> bool {
    let payload_types = body.matches("<key>PayloadType</key>").count();
    body.starts_with("<?xml")
        && body.contains("<plist")
        && body.contains("</plist>")
        && payload_types == 2 // the profile's own, and the one Web Clip
        && body.contains("<string>Configuration</string>")
        && body.contains("<string>com.apple.webClip.managed</string>")
}

async fn ios_web_clip() -> impl IntoResponse {
    match tokio::fs::read_to_string(IOS_WEB_CLIP_FILE).await {
        Ok(body) if is_web_clip_only_profile(&body) => (
            [
                ("content-type", IOS_PROFILE_TYPE),
                ("content-disposition", "attachment; filename=\"Puca.mobileconfig\""),
                ("cache-control", "no-cache"),
                ("x-content-type-options", "nosniff"),
            ],
            body,
        )
            .into_response(),
        Ok(_) => {
            tracing::warn!("[Update] {IOS_WEB_CLIP_FILE} is not a single Web Clip profile; not serving it");
            StatusCode::NOT_FOUND.into_response()
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
    use super::{is_web_clip_only_profile, mobile_update_file_path};

    fn profile(inner_type: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n\
             <key>PayloadContent</key><array><dict><key>PayloadType</key><string>{inner_type}</string></dict></array>\n\
             <key>PayloadType</key><string>Configuration</string>\n</dict></plist>\n"
        )
    }

    /// The route serves the Web Clip profile (positive control) and refuses
    /// everything that is not exactly that: another payload type, a second
    /// payload, a truncated upload, not a property list at all.
    #[test]
    fn only_a_lone_web_clip_profile_is_served() {
        assert!(is_web_clip_only_profile(&profile("com.apple.webClip.managed")));
        assert!(!is_web_clip_only_profile(&profile("com.apple.security.root")));
        assert!(!is_web_clip_only_profile(&profile("com.apple.vpn.managed")));
        let two = profile("com.apple.webClip.managed").replace(
            "</array>",
            "<dict><key>PayloadType</key><string>com.apple.security.root</string></dict></array>",
        );
        assert!(!is_web_clip_only_profile(&two), "a second payload rides along");
        let cut = profile("com.apple.webClip.managed").replace("</plist>", "");
        assert!(!is_web_clip_only_profile(&cut), "a half-written file");
        assert!(!is_web_clip_only_profile("<html>not a profile</html>"));
        assert!(!is_web_clip_only_profile(""));
    }

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
