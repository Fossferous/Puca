//! `GET /config` — the handful of deployment facts a client needs BEFORE it
//! has an account, served without authentication.
//!
//! Two consumers, both first-run:
//!
//! 1. **Invite links.** The desktop app runs from `http://tauri.localhost`
//!    and the Android app from `https://localhost`, so a link built from
//!    `window.location.origin` — which is what every client did until 0.9.2 —
//!    put `http://tauri.localhost/invite/<code>` on the clipboard. The web
//!    app's public address is something only the operator knows; they set it
//!    as `APP_URL` (the same value the e-mail links already use) and every
//!    client builds `<APP_URL>/invite/<code>` from here.
//! 2. **The registration gate.** The sign-up form showed an "Invite code —
//!    required" field on every server, including the default open-registration
//!    one, because nothing told it whether `REGISTRATION_INVITE_CODE` was set.
//!    This says so, without revealing the code.
//!
//! Nothing here is secret: both values are already observable (the URL is on
//! every invite, the gate answers 403 to a missing code). It sits under the
//! general API rate limit like the other public routes.

use axum::Json;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct PublicConfig {
    /// Public base URL of the web app, with no trailing slash, or `null`
    /// when the operator has not set `APP_URL`. Clients then fall back to
    /// showing the bare invite code.
    pub app_url: Option<String>,
    /// Whether `POST /auth/register` will refuse a request that carries no
    /// (or the wrong) invite code.
    pub registration_invite_required: bool,
    /// The newest SRP verifier derivation this server records (migration
    /// 059): 2 = Argon2id. A client refuses to WRITE a verifier to a server
    /// that does not announce at least the version it derives, because a
    /// server predating the field would file an Argon2id verifier as SHA-256
    /// and the account could never sign in again (0.9.3 review, X0/X1).
    pub srp_version: i16,
}

/// Mirrors `SRP_VERSION_CURRENT` in the client (auth.ts) and the highest
/// `SrpVersion` handlers.rs accepts.
pub const SRP_VERSION_CURRENT: i16 = 2;

/// Normalise the raw `APP_URL` value: trimmed, trailing slashes dropped, and
/// only an absolute http(s) URL counts — a relative path or a bare host
/// would produce an invite link nobody's browser can open.
pub fn app_url_from(raw: Option<String>) -> Option<String> {
    let v = raw?;
    let v = v.trim().trim_end_matches('/');
    if v.is_empty() {
        return None;
    }
    let lower = v.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    Some(v.to_string())
}

/// Mirrors the exact test `handlers::register` applies to the same variable:
/// set AND non-blank ⇒ required. Kept in step by the test below rather than
/// by sharing a function, because this module deliberately touches nothing
/// else in `src/`.
pub fn invite_required_from(raw: Option<String>) -> bool {
    raw.map(|s| !s.trim().is_empty()).unwrap_or(false)
}

pub async fn get_public_config() -> Json<PublicConfig> {
    Json(PublicConfig {
        app_url: app_url_from(std::env::var("APP_URL").ok()),
        registration_invite_required: invite_required_from(
            std::env::var("REGISTRATION_INVITE_CODE").ok(),
        ),
        srp_version: SRP_VERSION_CURRENT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, routing::get, Router};
    use std::sync::Mutex;
    use tower::ServiceExt;

    /// Process-wide env is shared across the parallel test threads; every
    /// test that sets it takes this lock.
    static ENV: Mutex<()> = Mutex::new(());

    #[test]
    fn app_url_is_normalised_and_absolute_only() {
        assert_eq!(app_url_from(None), None);
        assert_eq!(app_url_from(Some("".into())), None);
        assert_eq!(app_url_from(Some("   ".into())), None);
        assert_eq!(
            app_url_from(Some("https://app.example.com/".into())),
            Some("https://app.example.com".into())
        );
        assert_eq!(
            app_url_from(Some("  http://localhost:5173//  ".into())),
            Some("http://localhost:5173".into())
        );
        // A bare host or a path is not a base a browser can open.
        assert_eq!(app_url_from(Some("app.example.com".into())), None);
        assert_eq!(app_url_from(Some("/app".into())), None);
        assert_eq!(app_url_from(Some("ftp://app.example.com".into())), None);
    }

    #[test]
    fn invite_required_matches_the_register_gate() {
        // handlers::register: `.ok().filter(|s| !s.trim().is_empty())`.
        assert!(!invite_required_from(None));
        assert!(!invite_required_from(Some("".into())));
        assert!(!invite_required_from(Some("   ".into())));
        assert!(invite_required_from(Some("secret".into())));
        assert!(invite_required_from(Some("  secret  ".into())));
    }

    async fn fetch_config() -> PublicConfig {
        let app = Router::new().route("/config", get(get_public_config));
        let res = app
            .oneshot(Request::get("/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        PublicConfig {
            app_url: v["app_url"].as_str().map(str::to_string),
            registration_invite_required: v["registration_invite_required"]
                .as_bool()
                .expect("registration_invite_required must be a bool"),
            srp_version: v["srp_version"].as_i64().expect("srp_version must be a number") as i16,
        }
    }

    #[tokio::test]
    async fn route_reports_the_env_in_the_same_process() {
        let _g = ENV.lock().unwrap();
        // Unset ⇒ null URL, open registration.
        std::env::remove_var("APP_URL");
        std::env::remove_var("REGISTRATION_INVITE_CODE");
        let got = fetch_config().await;
        assert_eq!(
            got,
            PublicConfig { app_url: None, registration_invite_required: false, srp_version: SRP_VERSION_CURRENT }
        );

        // Set ⇒ both flip, and the code itself is NOT in the body.
        std::env::set_var("APP_URL", "https://app.example.com/");
        std::env::set_var("REGISTRATION_INVITE_CODE", "hunter2");
        let app = Router::new().route("/config", get(get_public_config));
        let res = app
            .oneshot(Request::get("/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!text.contains("hunter2"), "the invite code leaked: {text}");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["app_url"], "https://app.example.com");
        assert_eq!(v["registration_invite_required"], true);

        std::env::remove_var("APP_URL");
        std::env::remove_var("REGISTRATION_INVITE_CODE");
    }
}
