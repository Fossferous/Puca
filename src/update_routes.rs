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

/// The few property-list shapes a profile uses, and nothing else.
#[derive(Debug)]
enum Pl {
    Dict(Vec<(String, Pl)>),
    Array(Vec<Pl>),
    Str(String),
    Other,
}

/// A strict reader for the property list `make-web-clip-profile.mjs` writes. It reads the
/// real structure (so a payload type quoted inside a description, or a key
/// spelled with an entity, is what it is, not a string match) and fails closed on
/// anything it does not know: an unknown element, a comment, a duplicate key,
/// trailing text, nesting past 8.
struct PlReader<'a> {
    s: &'a str,
    i: usize,
}

impl<'a> PlReader<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.i..]
    }
    fn ws(&mut self) {
        let t = self.rest().trim_start();
        self.i = self.s.len() - t.len();
    }
    fn eat(&mut self, lit: &str) -> bool {
        if self.rest().starts_with(lit) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }
    /// Text up to the given closing tag, entities decoded; `<` or an unknown entity fails.
    fn text_until(&mut self, close: &str) -> Option<String> {
        let end = self.rest().find(close)?;
        let raw = &self.rest()[..end];
        self.i += end + close.len();
        if raw.contains('<') {
            return None;
        }
        let mut out = String::new();
        let mut it = raw;
        while let Some(p) = it.find('&') {
            out.push_str(&it[..p]);
            let semi = it[p..].find(';')? + p;
            let ent = &it[p + 1..semi];
            match ent {
                "amp" => out.push('&'),
                "lt" => out.push('<'),
                "gt" => out.push('>'),
                "quot" => out.push('"'),
                "apos" => out.push('\''),
                _ => {
                    let num = ent.strip_prefix('#')?;
                    let cp = match num.strip_prefix('x') {
                        Some(h) => u32::from_str_radix(h, 16).ok()?,
                        None => num.parse().ok()?,
                    };
                    out.push(char::from_u32(cp)?);
                }
            }
            it = &it[semi + 1..];
        }
        out.push_str(it);
        Some(out)
    }
    fn value(&mut self, depth: u8) -> Option<Pl> {
        if depth > 8 {
            return None;
        }
        self.ws();
        if self.eat("<true/>") || self.eat("<false/>") {
            return Some(Pl::Other);
        }
        if self.eat("<string/>") {
            return Some(Pl::Str(String::new()));
        }
        if self.eat("<string>") {
            return self.text_until("</string>").map(Pl::Str);
        }
        if self.eat("<integer>") || self.eat("<data>") {
            self.text_until(if self.s[..self.i].ends_with("<integer>") { "</integer>" } else { "</data>" })?;
            return Some(Pl::Other);
        }
        if self.eat("<array>") {
            let mut items = Vec::new();
            loop {
                self.ws();
                if self.eat("</array>") {
                    return Some(Pl::Array(items));
                }
                items.push(self.value(depth + 1)?);
            }
        }
        if self.eat("<dict>") {
            let mut entries: Vec<(String, Pl)> = Vec::new();
            loop {
                self.ws();
                if self.eat("</dict>") {
                    return Some(Pl::Dict(entries));
                }
                if !self.eat("<key>") {
                    return None;
                }
                let key = self.text_until("</key>")?;
                if entries.iter().any(|(k, _)| *k == key) {
                    return None;
                }
                entries.push((key, self.value(depth + 1)?));
            }
        }
        None
    }
    fn document(body: &'a str) -> Option<Pl> {
        let mut r = PlReader { s: body.trim_start_matches('\u{feff}'), i: 0 };
        r.ws();
        if !r.eat("<?xml") {
            return None;
        }
        r.i += r.rest().find("?>")? + 2;
        r.ws();
        if r.rest().starts_with("<!DOCTYPE plist") {
            r.i += r.rest().find('>')? + 1;
            r.ws();
        }
        if !r.eat("<plist") {
            return None;
        }
        r.i += r.rest().find('>')? + 1;
        let v = r.value(0)?;
        r.ws();
        if !r.eat("</plist>") {
            return None;
        }
        r.ws();
        if r.i != r.s.len() {
            return None;
        }
        Some(v)
    }
}

fn dict_entry<'a>(d: &'a [(String, Pl)], key: &str) -> Option<&'a Pl> {
    d.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn str_entry<'a>(d: &'a [(String, Pl)], key: &str) -> Option<&'a str> {
    match dict_entry(d, key)? {
        Pl::Str(s) => Some(s),
        _ => None,
    }
}

/// Every key of `d` is in `allowed` and every `required` one is present.
fn keys_within(d: &[(String, Pl)], required: &[&str], allowed: &[&str]) -> bool {
    d.iter().all(|(k, _)| allowed.contains(&k.as_str())) && required.iter().all(|k| dict_entry(d, k).is_some())
}

/// Is this the profile dual-ship rendered, and nothing else? The file is
/// operator-pushed, so a half-written upload or a stray file must not be handed
/// to a phone as a profile, and neither may a profile that does more than the page
/// promises. It must read as a property list with ONE outer dict whose only
/// payload is ONE dict of type `com.apple.webClip.managed`, with exactly the keys
/// make-web-clip-profile.mjs writes (no certificate, restriction, VPN or any other
/// key) and an https address.
fn is_web_clip_only_profile(body: &str) -> bool {
    const OUTER: &[&str] = &[
        "PayloadContent", "PayloadDescription", "PayloadDisplayName", "PayloadIdentifier",
        "PayloadRemovalDisallowed", "PayloadType", "PayloadUUID", "PayloadVersion",
    ];
    const INNER: &[&str] = &[
        "FullScreen", "Icon", "IsRemovable", "Label", "PayloadDescription", "PayloadDisplayName",
        "PayloadIdentifier", "PayloadType", "PayloadUUID", "PayloadVersion", "URL",
    ];
    let Some(Pl::Dict(outer)) = PlReader::document(body) else { return false };
    if !keys_within(&outer, &["PayloadContent", "PayloadIdentifier", "PayloadType", "PayloadUUID", "PayloadVersion"], OUTER)
        || str_entry(&outer, "PayloadType") != Some("Configuration")
    {
        return false;
    }
    let Some(Pl::Array(content)) = dict_entry(&outer, "PayloadContent") else { return false };
    let [Pl::Dict(clip)] = content.as_slice() else { return false };
    keys_within(clip, &["Label", "PayloadIdentifier", "PayloadType", "PayloadUUID", "PayloadVersion", "URL"], INNER)
        && str_entry(clip, "PayloadType") == Some("com.apple.webClip.managed")
        && str_entry(clip, "URL").is_some_and(|u| u.starts_with("https://"))
}

async fn ios_web_clip(path: String) -> axum::response::Response {
    match tokio::fs::read_to_string(&path).await {
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
            tracing::warn!("[Update] {path} is not a single Web Clip profile; not serving it");
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
    update_routes_with(IOS_WEB_CLIP_FILE.to_string())
}

/// The same router with the iPhone profile's file path given, so a test can point
/// it at a file of its own and send real requests through the real route table.
fn update_routes_with<S>(web_clip_file: String) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/app-version", get(app_version))
        // Path matches what frontend UpdateGate.tsx fetches on mobile launch.
        .route("/api/mobile-updates/check", get(mobile_update_check))
        // The iPhone/iPad one-tap install profile (see the module docs).
        .route(
            "/api/ios-web-clip",
            get(move || {
                let path = web_clip_file.clone();
                async move { ios_web_clip(path).await }
            }),
        )
}

#[cfg(test)]
mod tests {
    use super::{is_web_clip_only_profile, mobile_update_file_path, update_routes_with};
    use axum::{body::Body, http::Request, Router};
    use tower::ServiceExt;

    /// What dual-ship renders (deploy/ops/make-web-clip-profile.mjs), byte for
    /// byte: webClipProfile.test.ts fails if the generator stops producing this.
    const REAL: &str = include_str!("../deploy/ops/fixtures/web-clip-profile.example.mobileconfig");

    fn profile(inner: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n\
             <key>PayloadContent</key><array>{inner}</array>\n\
             <key>PayloadIdentifier</key><string>a.b</string>\n\
             <key>PayloadType</key><string>Configuration</string>\n\
             <key>PayloadUUID</key><string>U</string>\n\
             <key>PayloadVersion</key><integer>1</integer>\n</dict></plist>\n"
        )
    }

    fn clip(extra: &str, payload_type: &str, url: &str) -> String {
        format!(
            "<dict><key>Label</key><string>P</string><key>PayloadIdentifier</key><string>a.b.c</string>\
             <key>PayloadType</key><string>{payload_type}</string><key>PayloadUUID</key><string>V</string>\
             <key>PayloadVersion</key><integer>1</integer><key>URL</key><string>{url}</string>{extra}</dict>"
        )
    }

    const WC: &str = "com.apple.webClip.managed";

    /// The profile the generator really writes is accepted (positive control for
    /// everything below), and a minimal hand-written one too.
    #[test]
    fn the_generated_profile_is_accepted() {
        assert!(is_web_clip_only_profile(REAL), "the fixture the generator is pinned to");
        assert!(is_web_clip_only_profile(&profile(&clip("", WC, "https://app.invalid/"))));
    }

    /// Everything that is not exactly one Web Clip is refused: by reading the
    /// structure, not by looking for strings.
    #[test]
    fn nothing_but_a_lone_web_clip_profile_is_served() {
        let good = clip("", WC, "https://app.invalid/");
        // another payload type, alone and beside the clip
        assert!(!is_web_clip_only_profile(&profile(&clip("", "com.apple.security.root", "https://app.invalid/"))));
        assert!(!is_web_clip_only_profile(&profile(&format!("{good}{}", clip("", "com.apple.vpn.managed", "https://app.invalid/")))));
        assert!(!is_web_clip_only_profile(&profile(&format!("{good}{good}"))), "two clips");
        assert!(!is_web_clip_only_profile(&profile("")), "no payload");
        // a root-certificate payload that merely QUOTES the web clip type
        let quoted = clip("<key>PayloadDescription</key><string>com.apple.webClip.managed</string>", "com.apple.security.root", "https://app.invalid/");
        assert!(!is_web_clip_only_profile(&profile(&quoted)));
        // a key written with an entity is the key it decodes to: a duplicate here
        let entity = good.replace("<key>URL</key>", "<key>Payload&#84;ype</key><string>x</string><key>URL</key>");
        assert!(!is_web_clip_only_profile(&profile(&entity)), "Payload&#84;ype is PayloadType, twice");
        // any key the page does not promise
        for extra in ["<key>PayloadCertificateFileName</key><string>x</string>", "<key>IgnoreManifestScope</key><true/>", "<key>Restrictions</key><dict></dict>"] {
            assert!(!is_web_clip_only_profile(&profile(&clip(extra, WC, "https://app.invalid/"))), "{extra}");
        }
        // an address that is not https, and one missing
        assert!(!is_web_clip_only_profile(&profile(&clip("", WC, "http://app.invalid/"))));
        assert!(!is_web_clip_only_profile(&profile(&clip("", WC, "javascript:alert(1)"))));
        // the outer profile: a different type, an extra key
        assert!(!is_web_clip_only_profile(&profile(&good).replace("<string>Configuration</string>", "<string>Other</string>")));
        assert!(!is_web_clip_only_profile(&profile(&good).replace("<key>PayloadVersion</key><integer>1</integer>\n</dict>", "<key>PayloadVersion</key><integer>1</integer><key>ConsentText</key><dict></dict>\n</dict>")));
        // not a property list, cut off, trailing text, an unknown element, a comment
        assert!(!is_web_clip_only_profile(&profile(&good).replace("</plist>", "")));
        assert!(!is_web_clip_only_profile(&format!("{}x", profile(&good))));
        assert!(!is_web_clip_only_profile(&profile(&good).replace("<integer>1</integer>", "<real>1</real>")));
        assert!(!is_web_clip_only_profile(&profile(&good).replace("<array>", "<array><!-- c -->")));
        assert!(!is_web_clip_only_profile("<html>not a profile</html>"));
        assert!(!is_web_clip_only_profile(""));
    }

    fn scratch(name: &str, body: Option<&str>) -> String {
        let p = std::env::temp_dir().join(format!(
            "puca-clip-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        if let Some(b) = body {
            std::fs::write(&p, b).unwrap();
        }
        p.to_string_lossy().into_owned()
    }

    async fn get_clip(file: &str) -> (u16, Option<String>, Vec<u8>) {
        let app: Router = update_routes_with(file.to_string());
        let res = app
            .oneshot(Request::get("/api/ios-web-clip").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let ctype = res.headers().get("content-type").map(|v| v.to_str().unwrap().to_string());
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec();
        (status, ctype, bytes)
    }

    /// A REAL request through the REAL route table: the route is registered, the
    /// type is the one iOS needs, the bytes are the file's. Remove the
    /// `.route("/api/ios-web-clip", ...)` line and this is a 404.
    #[tokio::test]
    async fn the_route_serves_the_profile_as_ios_needs_it() {
        let file = scratch("ok.mobileconfig", Some(REAL));
        let (status, ctype, bytes) = get_clip(&file).await;
        assert_eq!(status, 200);
        assert_eq!(ctype.as_deref(), Some("application/x-apple-aspen-config"));
        assert_eq!(bytes, REAL.as_bytes());
        let _ = std::fs::remove_file(&file);
    }

    #[tokio::test]
    async fn the_route_is_a_404_for_a_missing_file_and_for_a_profile_that_does_more() {
        let (status, _, _) = get_clip(&scratch("missing.mobileconfig", None)).await;
        assert_eq!(status, 404, "no file yet (a host before the first ship)");
        let wrong = profile(&clip("", "com.apple.security.root", "https://app.invalid/"));
        let file = scratch("wrong.mobileconfig", Some(&wrong));
        let (status, ctype, _) = get_clip(&file).await;
        assert_eq!(status, 404, "a root-certificate profile is never served from here");
        assert_ne!(ctype.as_deref(), Some("application/x-apple-aspen-config"));
        let _ = std::fs::remove_file(&file);
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
