//! What the waker knows, and where it keeps it.
//!
//! FILES, NEVER ENVIRONMENT VARIABLES. The same reasoning already written down
//! in `src/wake/fcm.rs`: a 0600 file gives filesystem protection that
//! `/proc/<pid>/environ` does not, and this box runs other services whose
//! operators can read a process listing.
//!
//! Split in two because the halves have different lifetimes and different
//! blast radii:
//!
//!   - `waker.json` is written ONCE at pairing and never again. It carries the
//!     device identity and the enrolment record the desktop signed.
//!   - `token` is rewritten every time the server hands back a renewed one, so
//!     it is the only file on a hot path and the only one worth an atomic
//!     replace.

use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

pub const DEFAULT_CONFIG: &str = "/etc/puca-waker/waker.json";
pub const DEFAULT_TOKEN: &str = "/var/lib/puca-waker/token";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// e.g. `https://chat.example.com` — no trailing slash.
    pub api_base: String,
    /// The account this waker belongs to. Part of the attestation transcript,
    /// so it must match the token's `sub` or every attestation fails.
    pub user_id: i64,
    pub device_id: String,
    pub device_pub: String,
    pub sign_pub: String,
    /// Base64 Ed25519 seed. The only secret in the file.
    pub sign_seed: String,
    /// This box's own LAN address. Bound explicitly rather than 0.0.0.0 so a
    /// route table cannot decide where the packet goes — see wol.rs.
    pub bind_ip: Ipv4Addr,
    /// This box's subnet-directed broadcast, e.g. `192.168.0.255`.
    pub broadcast: Ipv4Addr,
    #[serde(default = "default_token_path")]
    pub token_path: PathBuf,
}

fn default_token_path() -> PathBuf {
    PathBuf::from(DEFAULT_TOKEN)
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let cfg: Config = serde_json::from_str(&raw)
            .map_err(|e| format!("{} is not valid waker config: {e}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Refuse a config that would fail confusingly later.
    ///
    /// Every one of these produces a remote error hours after startup if it is
    /// allowed through — a bad `user_id` looks like a signature failure, a
    /// trailing slash looks like a 404, and a public `broadcast` looks like the
    /// wake silently doing nothing.
    pub fn validate(&self) -> Result<(), String> {
        if !self.api_base.starts_with("https://") {
            return Err("api_base must be https:// — this carries a bearer token".into());
        }
        if self.api_base.ends_with('/') {
            return Err("api_base must not end with a slash".into());
        }
        if self.user_id <= 0 {
            return Err("user_id must be the real account id".into());
        }
        if self.device_id.len() != 21 {
            return Err(format!("device_id must be 21 chars, got {}", self.device_id.len()));
        }
        if !crate::wol::is_local_wake_target(self.broadcast) {
            return Err(format!(
                "broadcast {} is not a private LAN address; a wake packet there does nothing",
                self.broadcast
            ));
        }
        self.seed().map(|_| ())
    }

    /// The Ed25519 seed as bytes.
    pub fn seed(&self) -> Result<[u8; 32], String> {
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&self.sign_seed)
            .map_err(|e| format!("sign_seed is not base64: {e}"))?;
        raw.try_into().map_err(|_| "sign_seed must be 32 bytes".to_string())
    }

    /// `wss://host/ws` — derived from `api_base` so the two can never point at
    /// different deployments.
    ///
    /// NO CREDENTIAL IN THE URL. This was `?token={token}`, and the waker
    /// re-dials on every boot and every socket expiry, so each connection
    /// deposited a live device-scoped JWT into the reverse proxy's access log —
    /// rotated, shipped and backed up. See `ws_request`.
    pub fn ws_url(&self) -> String {
        let host = self.api_base.trim_start_matches("https://");
        format!("wss://{host}/ws")
    }

    /// The handshake request, carrying the token in `Sec-WebSocket-Protocol` as
    /// `bearer, <jwt>` — the same shape the browser client sends, which the
    /// server checks BEFORE the query fallback, so this needs no server change.
    pub fn ws_request(
        &self,
        token: &str,
    ) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue};
        let mut req = self
            .ws_url()
            .into_client_request()
            .map_err(|e| format!("bad websocket url: {e}"))?;
        let value = HeaderValue::from_str(&format!("bearer, {token}"))
            .map_err(|_| "the waker token is not a valid header value".to_string())?;
        req.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, value);
        Ok(req)
    }
}

/// Read the current token, trimmed.
pub fn read_token(path: &Path) -> Result<String, String> {
    let t = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read the token at {}: {e}", path.display()))?;
    let t = t.trim().to_string();
    if t.is_empty() {
        return Err(format!("{} is empty — pair this waker again", path.display()));
    }
    Ok(t)
}

/// Replace the token atomically.
///
/// Write-then-rename because the alternative truncates in place: a crash or a
/// full disk midway through leaves a half-written token, and the waker then
/// cannot authenticate and cannot be told why by anything it still has access
/// to. Rename within the same directory is atomic on Linux.
/// NO OWNERSHIP CHANGES IN HERE — this runs inside the service's seccomp
/// sandbox, where the chown family is FILTERED (SIGSYS kill, not EPERM; the
/// 2026-08-17 outage). The service account's own writes need no chown, by
/// construction: `File::create` in its own 0700 directory produces a file it
/// owns. The one caller that genuinely writes as the wrong user — root running
/// `pair` — calls [`fix_owner_for_service`] explicitly afterwards, outside the
/// sandbox. Keeping the syscall out of this function is a guarantee; a runtime
/// ownership check in here was only a guard, and a guard is one odd state
/// (a gid mismatch, a foreign-owned leftover) away from the same kill.
pub fn write_token(path: &Path, token: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    // A leftover tmp from a crashed earlier write may be owned by SOMEONE
    // ELSE (root's `pair` dying between create and rename) — and then
    // File::create cannot open it, and every future renewal fails until a
    // human notices, which for a credential that expires daily means the
    // waker dies on schedule. Unlinking needs only write on the DIRECTORY,
    // which the service account owns, so this heals the foreign-owned case
    // the create below cannot.
    let _ = std::fs::remove_file(&tmp);
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        f.write_all(token.trim().as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("cannot flush {}: {e}", tmp.display()))?;
        restrict(&tmp)?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

/// Give `file` the same owner as `reference`'s parent directory.
#[cfg(unix)]
/// Give `path` the same owner as its directory — CALLED ONLY OUTSIDE THE
/// SANDBOX, by root-run `pair`/`init`.
///
/// Why it exists: those commands run as root via `pct exec`, and a root-owned
/// token inside the service's 0700 directory makes the unit start, report
/// `active`, and loop for ever on "Permission denied" reading its own
/// credential.
///
/// Why the SERVICE must never reach it: its systemd unit filters the chown
/// family (`SystemCallFilter=@system-service` + `~@privileged`), and a
/// FILTERED syscall is not a refused one — the kernel delivers SIGSYS and the
/// process is KILLED; `let _ =` cannot catch a signal. Measured live,
/// 2026-08-17 09:46:56: the first token renewal the waker ever received died
/// exactly there (`status=31/SYS`) and systemd restarted it into the same
/// death every 5 seconds, with Wake down the whole time. The fix is
/// structural: `write_token` contains no ownership code at all, and this
/// function is invoked only from the unsandboxed CLI paths. The owner check
/// below still skips the syscall when there is nothing to fix — root's own
/// re-pair over an already-correct file should not touch it either.
#[cfg(unix)]
pub fn fix_owner_for_service(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let Some(dir) = path.parent() else { return Ok(()) };
    let Ok(dir_meta) = std::fs::metadata(dir) else { return Ok(()) };
    let Ok(file_meta) = std::fs::metadata(path) else { return Ok(()) };
    if file_meta.uid() == dir_meta.uid() && file_meta.gid() == dir_meta.gid() {
        return Ok(());
    }
    let _ = std::os::unix::fs::chown(path, Some(dir_meta.uid()), Some(dir_meta.gid()));
    Ok(())
}

#[cfg(not(unix))]
pub fn fix_owner_for_service(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// 0600. A token is a bearer credential for the whole account.
#[cfg(unix)]
fn restrict(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("cannot chmod {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> Result<(), String> {
    // The waker only ever runs on the Linux box. Builds elsewhere are for
    // `cargo test` on a developer machine, where there is no token to protect.
    Ok(())
}

/// Seconds until a JWT's `exp`, read WITHOUT verifying it.
///
/// Deliberately unverified: the waker cannot check a signature it has no key
/// for, and it does not need to. This answer is only used to decide when to
/// re-dial and what date to display — the server is the only thing that
/// decides whether the token is good, and it re-checks on every frame. Treating
/// an unparseable token as "expired" is the safe direction: it triggers a
/// refresh attempt rather than a confident wait.
pub fn seconds_until_expiry(token: &str, now_unix: i64) -> Option<i64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let exp = v.get("exp")?.as_i64()?;
    Some(exp - now_unix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Config {
        Config {
            api_base: "https://chat.example.com".into(),
            user_id: 1,
            device_id: "A".repeat(21),
            device_pub: "x25519:AAAA".into(),
            sign_pub: "ed25519:BBBB".into(),
            sign_seed: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                [7u8; 32],
            ),
            bind_ip: "192.168.0.30".parse().unwrap(),
            broadcast: "192.168.0.255".parse().unwrap(),
            token_path: default_token_path(),
        }
    }

    #[test]
    fn a_valid_config_is_accepted() {
        // The positive control for every refusal below.
        sample().validate().expect("this is the shape the pairing flow writes");
    }

    #[test]
    fn a_config_that_would_fail_confusingly_later_is_refused_now() {
        let mut c = sample();
        c.api_base = "http://chat.example.com".into();
        assert!(c.validate().unwrap_err().contains("https"), "a bearer token over http");

        let mut c = sample();
        c.api_base = "https://chat.example.com/".into();
        assert!(c.validate().is_err(), "a trailing slash becomes a 404 much later");

        let mut c = sample();
        c.broadcast = "8.8.8.8".parse().unwrap();
        assert!(
            c.validate().unwrap_err().contains("private"),
            "a public broadcast makes every wake silently do nothing"
        );

        let mut c = sample();
        c.device_id = "short".into();
        assert!(c.validate().is_err());

        let mut c = sample();
        c.user_id = 0;
        assert!(c.validate().is_err(), "a wrong uid presents as a signature failure");
    }

    #[test]
    fn the_websocket_url_is_derived_from_the_api_base() {
        // Derived rather than configured separately, so the two cannot end up
        // pointing at different deployments — which would present as "enrolled
        // fine, never comes online".
        assert_eq!(sample().ws_url(), "wss://chat.example.com/ws");
    }

    /// The token rides a HEADER, never the URL. A query string is written
    /// verbatim into every proxy access log along the path, and the waker
    /// re-dials on every boot — so the old form deposited a live device-scoped
    /// JWT into a rotated, shipped, backed-up log file on each connection. On
    /// the waker specifically, a socket that stops reconnecting means missed
    /// wake doorbells, i.e. messages that never arrive on a sleeping machine —
    /// which is why the server keeps accepting the query form for now.
    #[test]
    fn the_handshake_carries_the_token_in_a_header_and_never_in_the_uri() {
        let jwt = "header.payload.signature";
        let req = sample().ws_request(jwt).expect("builds");

        let uri = req.uri().to_string();
        assert_eq!(uri, "wss://chat.example.com/ws");
        assert!(!uri.contains("token="), "the URI must carry no credential: {uri}");
        assert!(!uri.contains(jwt), "the URI must not contain the token: {uri}");

        let sent = req
            .headers()
            .get("sec-websocket-protocol")
            .expect("the bearer subprotocol must be offered")
            .to_str()
            .expect("ascii");
        assert_eq!(sent, format!("bearer, {jwt}"));
    }

    /// A token that cannot be a header value fails the dial up front rather
    /// than connecting without one.
    #[test]
    fn a_token_that_is_not_header_safe_is_refused_up_front() {
        assert!(sample().ws_request("bad
value").is_err());
    }

    /// The renewal write must survive inside the service's seccomp sandbox.
    ///
    /// The 2026-08-17 outage: the FIRST renewal the waker ever received died
    /// with SIGSYS on `inherit_dir_owner`'s unconditional chown — a syscall
    /// systemd's `SystemCallFilter` FILTERS (kill), not refuses (EPERM), so
    /// the `let _ =` best-effort could never catch it, and systemd restarted
    /// the process into the same death every 5 seconds. A unit test cannot
    /// carry a seccomp filter, but it CAN pin the property the fix relies on:
    /// when the file's owner already matches the directory's — always true
    /// for a file the service account itself just created inside its own
    /// directory — write_token must take the no-syscall path and succeed.
    /// (Refactoring back to an unconditional chown makes this pass too on a
    /// dev box, but the live-box verification recipe is in the fix's comment;
    /// this test is the regression floor, not the proof.)
    #[cfg(unix)]
    #[test]
    fn a_renewed_token_is_persisted_without_needing_a_chown() {
        use std::os::unix::fs::MetadataExt;
        let dir = std::env::temp_dir().join(format!("waker-tok-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("token");
        write_token(&path, "first.tok.value").expect("initial write");
        write_token(&path, "renewed.tok.value").expect("the renewal rewrite");
        assert_eq!(read_token(&path).expect("readable"), "renewed.tok.value");
        // The property the sandbox path depends on: what the process itself
        // wrote is already owned like its directory, so no chown was due.
        let f = std::fs::metadata(&path).unwrap();
        let d = std::fs::metadata(&dir).unwrap();
        assert_eq!((f.uid(), f.gid()), (d.uid(), d.gid()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expiry_is_read_from_an_unverified_token_and_fails_safe() {
        use base64::Engine;
        let b64 = |v: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string())
        };
        let tok = format!("hdr.{}.sig", b64(&serde_json::json!({ "exp": 1_000, "sub": 1 })));
        assert_eq!(seconds_until_expiry(&tok, 400), Some(600));
        assert_eq!(seconds_until_expiry(&tok, 1_500), Some(-500), "already expired");

        // Anything unreadable returns None, which callers treat as "refresh
        // now" rather than "wait confidently".
        assert_eq!(seconds_until_expiry("not-a-jwt", 0), None);
        assert_eq!(seconds_until_expiry("", 0), None);
        assert_eq!(seconds_until_expiry("a.!!!.c", 0), None);
    }
}
