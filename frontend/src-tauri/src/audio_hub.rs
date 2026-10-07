//! Audio Hub control for My Devices: the five calls a CONTROLLER (the owner's
//! own phone) may ask this host to make against Audio Hub's local API.
//!
//! Audio Hub is a separate tray app that may run on this PC. It serves a
//! loopback-only HTTP/1.1 API on 127.0.0.1:47392: `GET /api/hello` (no token)
//! says it is running, `GET /api/status` reports both headsets, and four
//! `POST`s hand a headset to the phone or take it back. Every call but hello
//! needs `Authorization: Bearer <token>`, where the token is the trimmed
//! contents of `%APPDATA%\airpods-app\phone-token.txt` for the signed-in user.
//!
//! WHY HERE, IN THE TAURI PROCESS. This is `Puca.exe`, which runs as the
//! signed-in interactive user — the same account Audio Hub runs as, so the
//! roaming AppData folder below is that user's and the token is theirs. The
//! other two Púca processes on a Windows host are wrong for it: the SYSTEM
//! service (`puca-service`) and the agent it launches for the sign-in screen
//! resolve AppData to the system profile, and the user-flavour agent can only
//! answer the app's own pipe requests. The sealed signal the request arrives
//! on is handled by this process's webview already (session.ts), exactly like
//! `power_action` — see power.rs for the same reasoning.
//!
//! NOT A PROXY. The caller names an [`AudioHubOp`] and nothing else: the host,
//! port, method, path and headers are fixed in this file. There is no way to
//! reach any other port, any other path, or any other host, and no env var or
//! argument can change the target in a shipped build ([`Target::production`]
//! is the only constructor outside tests). The HTTP is written by hand on a
//! plain `TcpStream` on purpose: a general HTTP client honours `HTTP_PROXY`
//! and friends, which would hand the bearer token to whatever proxy the
//! environment names.
//!
//! Before any token-bearing call, `GET /api/hello` must answer as Audio Hub
//! (`"app":"audio-hub"`). If something else is listening on the port — Audio
//! Hub not running and another program bound it — the token is never sent.
//!
//! The token is read fresh on EVERY call (Audio Hub replaces it when the owner
//! "forgets paired phones") and is never logged, returned or echoed in an
//! error.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Audio Hub's local API port. Loopback only, fixed by Audio Hub itself
/// (`aap-app/src/phone.rs`, `LOCAL_PORT`).
pub const AUDIO_HUB_PORT: u16 = 47392;

/// Largest response accepted, headers included. Audio Hub's answers are a few
/// hundred bytes; the cap bounds memory and the size of the sealed reply.
const MAX_RESPONSE: usize = 16 * 1024;

/// The longest token accepted. Audio Hub makes 32 hex characters.
const MAX_TOKEN: usize = 256;

/// What the controller may ask for. This IS the allow-list: the wire spelling
/// is the kebab-case of each variant (`"airpods-phone"` …), pinned by
/// `ops_deserialize_from_the_controller_spelling` and mirrored in
/// `frontend/src/api/devices/audioHub.ts` (`AUDIO_HUB_OPS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioHubOp {
    /// `GET /api/hello`, then `GET /api/status`.
    Status,
    /// `POST /api/airpods/phone`: the PC lets go of the AirPods.
    AirpodsPhone,
    /// `POST /api/airpods/pc`: the PC takes the AirPods back.
    AirpodsPc,
    /// `POST /api/xm6/phone`: the dongle lets go of the XM6.
    Xm6Phone,
    /// `POST /api/xm6/pc`: the dongle takes the XM6 back.
    Xm6Pc,
}

impl AudioHubOp {
    /// The one request each op makes after hello. `'static` strings only:
    /// nothing a caller sends can become part of a request line.
    fn request(self) -> (&'static str, &'static str) {
        match self {
            AudioHubOp::Status => ("GET", "/api/status"),
            AudioHubOp::AirpodsPhone => ("POST", "/api/airpods/phone"),
            AudioHubOp::AirpodsPc => ("POST", "/api/airpods/pc"),
            AudioHubOp::Xm6Phone => ("POST", "/api/xm6/phone"),
            AudioHubOp::Xm6Pc => ("POST", "/api/xm6/pc"),
        }
    }
}

/// What the webview gets back, and passes on (sealed) to the controller.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AudioHubReply {
    /// false only when Audio Hub is not there: nothing answered on its port,
    /// or something that is not Audio Hub did.
    pub running: bool,
    /// Audio Hub's HTTP status for the op's own request (not hello's).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Audio Hub's JSON for that request, passed through unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
    /// A sentence for a person when there is no usable answer. Never names a
    /// path and never contains the token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AudioHubReply {
    fn not_running(why: &str) -> Self {
        AudioHubReply { running: false, status: None, body: None, error: Some(why.to_string()) }
    }
    fn failed(why: &str) -> Self {
        AudioHubReply { running: true, status: None, body: None, error: Some(why.to_string()) }
    }
}

pub(crate) const NOT_RUNNING: &str = "Audio Hub isn't running";
const NOT_AUDIO_HUB: &str = "something other than Audio Hub is answering on its port";
const NO_ANSWER: &str = "Audio Hub did not answer in time";
const UNREADABLE: &str = "Audio Hub sent an answer Púca could not read";
const TOO_LARGE: &str = "Audio Hub's answer was too large";
const NO_TOKEN: &str = "Audio Hub's access token could not be read — restart Audio Hub on this PC";
const BAD_TOKEN: &str = "Audio Hub's access token is not in a usable form — restart Audio Hub on this PC";
const BUSY: &str = "another Audio Hub request is still running on this PC";

/// Where the calls go and where the token is read from.
///
/// Fields are private and the only constructor outside `#[cfg(test)]` is
/// [`Target::production`], so a shipped build cannot be pointed anywhere but
/// 127.0.0.1:47392. Tests build one on an ephemeral port with a temp token.
#[derive(Debug, Clone)]
pub struct Target {
    addr: SocketAddr,
    token_path: Option<PathBuf>,
    connect_timeout: Duration,
    io_timeout: Duration,
}

impl Target {
    /// The real Audio Hub on this PC: loopback, its fixed port, and the
    /// signed-in user's own roaming AppData.
    pub fn production() -> Self {
        Target {
            addr: SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, AUDIO_HUB_PORT)),
            token_path: roaming_appdata().map(|d| d.join("airpods-app").join("phone-token.txt")),
            connect_timeout: Duration::from_millis(1500),
            io_timeout: Duration::from_secs(8),
        }
    }

    #[cfg(test)]
    fn for_test(port: u16, token_path: Option<PathBuf>) -> Self {
        Target {
            addr: SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)),
            token_path,
            connect_timeout: Duration::from_millis(1500),
            io_timeout: Duration::from_millis(1500),
        }
    }
}

/// The interactive user's roaming AppData (`%APPDATA%`), from the shell rather
/// than the environment, so a modified environment block cannot move it.
#[cfg(windows)]
fn roaming_appdata() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    // SAFETY: a documented call with a static GUID and no token (= this
    // process's user). On success the returned buffer is ours to free, which
    // happens once the string has been copied out.
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
        s.map(PathBuf::from)
    }
}

/// Audio Hub is Windows-only; elsewhere there is no token to find.
#[cfg(not(windows))]
fn roaming_appdata() -> Option<PathBuf> {
    None
}

/// Read the token as Audio Hub writes it: trimmed, and fit to go in a header.
/// Anything outside printable ASCII (a CR/LF in particular, which would let
/// the file inject a header) refuses the call rather than being sent.
fn read_token(path: Option<&PathBuf>) -> Result<String, &'static str> {
    let path = path.ok_or(NO_TOKEN)?;
    // Bounded read: the file is Audio Hub's 32 characters, and nothing it
    // could grow to is worth holding in memory.
    let mut raw = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take((MAX_TOKEN * 4 + 1) as u64).read_to_end(&mut raw))
        .map_err(|_| NO_TOKEN)?;
    if raw.len() > MAX_TOKEN * 4 {
        return Err(BAD_TOKEN);
    }
    let text = std::str::from_utf8(&raw).map_err(|_| BAD_TOKEN)?;
    let token = text.trim();
    if token.is_empty() || token.len() > MAX_TOKEN || !token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(BAD_TOKEN);
    }
    Ok(token.to_string())
}

#[derive(Debug, PartialEq)]
enum HttpError {
    Refused,
    Timeout,
    TooLarge,
    Malformed,
}

/// One request on one connection, `Connection: close`, no `Origin`.
fn exchange(
    target: &Target,
    method: &'static str,
    path: &'static str,
    token: Option<&str>,
) -> Result<(u16, Vec<u8>), HttpError> {
    // EVERY connect failure is "not running", a timeout included. On Windows
    // a loopback connect to a closed port is not refused at once: the stack
    // retries the SYN for about two seconds before reporting it (measured by
    // `a_closed_port_means_not_running_and_nothing_is_read`, which failed with
    // "did not answer in time" when this mapped a connect timeout separately).
    // A listening Audio Hub completes the handshake in the kernel even when
    // its own thread is stuck, so a hung Audio Hub still surfaces as a READ
    // timeout below, not here.
    let mut stream =
        TcpStream::connect_timeout(&target.addr, target.connect_timeout).map_err(|_| HttpError::Refused)?;
    let _ = stream.set_read_timeout(Some(target.io_timeout));
    let _ = stream.set_write_timeout(Some(target.io_timeout));
    let _ = stream.set_nodelay(true);

    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n",
        port = target.addr.port(),
    );
    if let Some(token) = token {
        head.push_str("Authorization: Bearer ");
        head.push_str(token);
        head.push_str("\r\n");
    }
    if method == "POST" {
        head.push_str("Content-Length: 0\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).map_err(io_error)?;
    let _ = stream.flush();

    // Read to EOF (the server closes after one answer), bounded in bytes and
    // in total time: a per-read timeout alone lets a trickling server hold the
    // call open indefinitely.
    let deadline = Instant::now() + target.io_timeout;
    let mut data = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(HttpError::Timeout);
        }
        // Each read waits only for what is left of the whole deadline.
        let _ = stream.set_read_timeout(Some(left));
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if data.len() + n > MAX_RESPONSE {
                    return Err(HttpError::TooLarge);
                }
                data.extend_from_slice(&chunk[..n]);
                // Stop as soon as a complete Content-Length body is in hand,
                // rather than waiting on a server that keeps the socket open.
                if let Some(done) = complete_len(&data) {
                    data.truncate(done);
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(io_error(e)),
        }
    }
    parse_response(&data)
}

fn io_error(e: std::io::Error) -> HttpError {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => HttpError::Timeout,
        std::io::ErrorKind::ConnectionRefused => HttpError::Refused,
        _ => HttpError::Malformed,
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn content_length(head: &str) -> Option<usize> {
    head.split("\r\n").skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse().ok())?
    })
}

/// The full length of the response once headers and a Content-Length body
/// are both in `data`.
fn complete_len(data: &[u8]) -> Option<usize> {
    let end = find(data, b"\r\n\r\n")?;
    let head = std::str::from_utf8(&data[..end]).ok()?;
    let len = content_length(head)?;
    // checked: a Content-Length near usize::MAX must not wrap into "done".
    let total = end.checked_add(4)?.checked_add(len)?;
    (data.len() >= total).then_some(total)
}

fn parse_response(data: &[u8]) -> Result<(u16, Vec<u8>), HttpError> {
    let end = find(data, b"\r\n\r\n").ok_or(HttpError::Malformed)?;
    let head = std::str::from_utf8(&data[..end]).map_err(|_| HttpError::Malformed)?;
    let mut status_line = head.split("\r\n").next().unwrap_or("").split_whitespace();
    let version = status_line.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return Err(HttpError::Malformed);
    }
    let status: u16 = status_line
        .next()
        .and_then(|s| s.parse().ok())
        .filter(|s| (100..600).contains(s))
        .ok_or(HttpError::Malformed)?;
    let mut body = data[end + 4..].to_vec();
    if let Some(len) = content_length(head) {
        if body.len() < len {
            return Err(HttpError::Malformed);
        }
        body.truncate(len);
    }
    Ok((status, body))
}

/// Is Audio Hub the thing answering? `Ok(())` when hello says so.
fn hello(target: &Target) -> Result<(), AudioHubReply> {
    match exchange(target, "GET", "/api/hello", None) {
        Ok((200, body)) => {
            let is_hub = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("app").and_then(|a| a.as_str()).map(|a| a == "audio-hub"))
                .unwrap_or(false);
            if is_hub {
                Ok(())
            } else {
                Err(AudioHubReply::not_running(NOT_AUDIO_HUB))
            }
        }
        Ok(_) => Err(AudioHubReply::not_running(NOT_AUDIO_HUB)),
        Err(HttpError::Refused) => Err(AudioHubReply::not_running(NOT_RUNNING)),
        Err(HttpError::Timeout) => Err(AudioHubReply::failed(NO_ANSWER)),
        Err(HttpError::TooLarge) | Err(HttpError::Malformed) => {
            Err(AudioHubReply::not_running(NOT_AUDIO_HUB))
        }
    }
}

/// Perform one allow-listed op against `target`. Blocking; call off the
/// async runtime.
pub fn perform(target: &Target, op: AudioHubOp) -> AudioHubReply {
    if let Err(reply) = hello(target) {
        return reply;
    }
    // Fresh every call: Audio Hub replaces the file when the owner forgets
    // paired phones, and a cached copy would then fail with 401 forever.
    let token = match read_token(target.token_path.as_ref()) {
        Ok(t) => t,
        Err(why) => return AudioHubReply::failed(why),
    };
    let (method, path) = op.request();
    match exchange(target, method, path, Some(&token)) {
        Ok((status, body)) => match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(v) if v.is_object() => AudioHubReply { running: true, status: Some(status), body: Some(v), error: None },
            _ => AudioHubReply { running: true, status: Some(status), body: None, error: Some(UNREADABLE.to_string()) },
        },
        // Hello answered a moment ago, so a refusal now is Audio Hub quitting
        // between the two — "not running" is still the honest summary.
        Err(HttpError::Refused) => AudioHubReply::not_running(NOT_RUNNING),
        Err(HttpError::Timeout) => AudioHubReply::failed(NO_ANSWER),
        Err(HttpError::TooLarge) => AudioHubReply::failed(TOO_LARGE),
        Err(HttpError::Malformed) => AudioHubReply::failed(UNREADABLE),
    }
}

/// One call at a time per machine: a second request while one is in flight
/// is refused rather than queued, so a burst cannot stack hand-overs.
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// The webview's entry point (session.ts, host side, after the sealed
/// `audio-hub` signal has passed every gate there). Only an [`AudioHubOp`]
/// crosses this boundary.
/// Clears [`IN_FLIGHT`] however the call ends — including a command future
/// that is dropped mid-await, which would otherwise leave every later
/// request answered "busy" until the app restarts.
struct InFlight;

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn audio_hub_request(op: AudioHubOp) -> Result<AudioHubReply, String> {
    if IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Ok(AudioHubReply::failed(BUSY));
    }
    let _guard = InFlight;
    let result = tauri::async_runtime::spawn_blocking(move || perform(&Target::production(), op)).await;
    let reply = result.map_err(|e| format!("Audio Hub request failed: {e}"))?;
    // No token, no path, no body: the op and the outcome are enough to read
    // the log by, and the body is the owner's device state.
    log::info!(
        "[audio-hub] {:?}: running={} status={:?}{}",
        op,
        reply.running,
        reply.status,
        if reply.error.is_some() { " (error)" } else { "" },
    );
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// A stand-in for Audio Hub's local API: answers each connection with the
    /// next scripted response and reports the raw request it read. Bound to
    /// an EPHEMERAL port — never 47392, which the real Audio Hub may claim.
    struct Mock {
        port: u16,
        requests: mpsc::Receiver<String>,
        handle: Option<thread::JoinHandle<()>>,
    }

    fn http(status: u16, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    const HELLO: &str = r#"{"app":"audio-hub","name":"PC","port":47390,"version":"0.1.0"}"#;

    impl Mock {
        /// Serve exactly `responses.len()` connections, then stop. Bounded,
        /// so a test that makes fewer calls cannot leave a thread blocked in
        /// accept forever: the listener is non-blocking with a deadline.
        fn start(responses: Vec<String>) -> Mock {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            assert_ne!(port, AUDIO_HUB_PORT);
            listener.set_nonblocking(true).unwrap();
            let (tx, rx) = mpsc::channel();
            let handle = thread::spawn(move || {
                for response in responses {
                    // Each connection gets its own short wait: a call that
                    // makes fewer requests than scripted ends the mock here.
                    let deadline = Instant::now() + Duration::from_millis(800);
                    let mut stream = loop {
                        match listener.accept() {
                            Ok((s, _)) => break s,
                            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                            Err(_) => return,
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut data = Vec::new();
                    let mut buf = [0u8; 1024];
                    while find(&data, b"\r\n\r\n").is_none() {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => data.extend_from_slice(&buf[..n]),
                        }
                    }
                    let _ = tx.send(String::from_utf8_lossy(&data).to_string());
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            Mock { port, requests: rx, handle: Some(handle) }
        }

        fn finish(mut self) -> Vec<String> {
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
            self.requests.try_iter().collect()
        }
    }

    /// A private scratch directory per test, removed on drop. Never the
    /// owner's real AppData: every test hands `Target::for_test` a path in
    /// here (or none at all).
    struct TempDir(PathBuf);

    impl TempDir {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tempdir() -> TempDir {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("puca-audio-hub-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn token_file(dir: &TempDir, contents: &str) -> PathBuf {
        let p = dir.path().join("phone-token.txt");
        std::fs::write(&p, contents).unwrap();
        p
    }

    fn header_lines(req: &str) -> Vec<String> {
        req.split("\r\n").map(|l| l.to_ascii_lowercase()).collect()
    }

    #[test]
    fn ops_deserialize_from_the_controller_spelling() {
        let cases = [
            ("status", AudioHubOp::Status),
            ("airpods-phone", AudioHubOp::AirpodsPhone),
            ("airpods-pc", AudioHubOp::AirpodsPc),
            ("xm6-phone", AudioHubOp::Xm6Phone),
            ("xm6-pc", AudioHubOp::Xm6Pc),
        ];
        for (wire, op) in cases {
            assert_eq!(serde_json::from_str::<AudioHubOp>(&format!("\"{wire}\"")).unwrap(), op, "{wire}");
        }
    }

    #[test]
    fn anything_outside_the_allow_list_does_not_deserialize() {
        for bad in [
            "\"pair\"", "\"/api/airpods/phone\"", "\"airpods/phone\"", "\"STATUS\"", "\"status \"",
            "\"hello\"", "\"airpods_phone\"", "\"xm6\"", "\"../api/pair\"", "{\"path\":\"/api/pair\"}",
            "null", "1",
        ] {
            assert!(serde_json::from_str::<AudioHubOp>(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn each_op_maps_to_exactly_one_fixed_request() {
        assert_eq!(AudioHubOp::Status.request(), ("GET", "/api/status"));
        assert_eq!(AudioHubOp::AirpodsPhone.request(), ("POST", "/api/airpods/phone"));
        assert_eq!(AudioHubOp::AirpodsPc.request(), ("POST", "/api/airpods/pc"));
        assert_eq!(AudioHubOp::Xm6Phone.request(), ("POST", "/api/xm6/phone"));
        assert_eq!(AudioHubOp::Xm6Pc.request(), ("POST", "/api/xm6/pc"));
    }

    #[test]
    fn production_is_hard_wired_to_loopback_47392() {
        let t = Target::production();
        assert_eq!(t.addr, "127.0.0.1:47392".parse::<SocketAddr>().unwrap());
        assert_eq!(AUDIO_HUB_PORT, 47392);
    }

    /// No env var, argument or file can retarget a shipped build: the
    /// production code (everything above this test module) reads no
    /// environment at all. A negative check on the source, with a positive
    /// control so a scan that matched nothing cannot pass vacuously.
    #[test]
    fn production_code_reads_no_environment() {
        let src = include_str!("audio_hub.rs");
        // Found by "\nmod tests" rather than "#[cfg(test)]\nmod tests": a
        // Windows checkout (core.autocrlf, as on the CI runner) has "\r\n".
        let end = src.find("\nmod tests").expect("tests marker");
        assert!(src[..end].trim_end().ends_with("#[cfg(test)]"), "the marker is the test module");
        let production = &src[..end];
        assert!(production.contains("fn perform("), "positive control: the scan covers the code");
        for needle in ["env::var", "env!(", "option_env!", "std::env"] {
            assert!(!production.contains(needle), "production code must not read {needle}");
        }
    }

    #[test]
    fn status_says_hello_first_then_sends_the_token_without_origin() {
        let dir = tempdir();
        let path = token_file(&dir, "  tok-abc123\r\n");
        let status = r#"{"name":"PC","airpods":{"on_pc":true,"handed_to_phone":false,"line":"AirPods: L 64%"},"xm6":{"on_pc":null,"available":true,"line":"XM6: connected"},"devices":"Out: x"}"#;
        let mock = Mock::start(vec![http(200, HELLO), http(200, status)]);
        let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::Status);
        let reqs = mock.finish();

        assert_eq!(reply.running, true);
        assert_eq!(reply.status, Some(200));
        assert_eq!(reply.error, None);
        assert_eq!(reply.body.as_ref().unwrap()["airpods"]["line"], "AirPods: L 64%");
        assert_eq!(reply.body.as_ref().unwrap()["xm6"]["on_pc"], serde_json::Value::Null);

        // One request per connection: two connections, two requests.
        assert_eq!(reqs.len(), 2, "{reqs:?}");
        assert!(reqs[0].starts_with("GET /api/hello HTTP/1.1\r\n"), "{}", reqs[0]);
        assert!(reqs[1].starts_with("GET /api/status HTTP/1.1\r\n"), "{}", reqs[1]);
        // Hello carries no token; the status call carries exactly the
        // trimmed one.
        assert!(!reqs[0].to_ascii_lowercase().contains("authorization"), "{}", reqs[0]);
        assert!(reqs[1].contains("\r\nAuthorization: Bearer tok-abc123\r\n"), "{}", reqs[1]);
        for r in &reqs {
            assert!(!header_lines(r).iter().any(|l| l.starts_with("origin:")), "Origin sent: {r}");
            assert!(header_lines(r).iter().any(|l| l == "connection: close"), "{r}");
            assert!(header_lines(r).iter().any(|l| l.starts_with("host: 127.0.0.1:")), "{r}");
        }
    }

    #[test]
    fn a_hand_over_posts_an_empty_body_and_passes_the_answer_through() {
        let dir = tempdir();
        let path = token_file(&dir, "tok");
        let ok = r#"{"ok":true,"message":"The PC let go of the AirPods - connect them on the phone."}"#;
        let mock = Mock::start(vec![http(200, HELLO), http(200, ok)]);
        let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::AirpodsPhone);
        let reqs = mock.finish();
        assert_eq!(reqs.len(), 2);
        assert!(reqs[1].starts_with("POST /api/airpods/phone HTTP/1.1\r\n"), "{}", reqs[1]);
        assert!(reqs[1].contains("\r\nContent-Length: 0\r\n"), "{}", reqs[1]);
        assert!(reqs[1].ends_with("\r\n\r\n"), "no body: {:?}", reqs[1]);
        assert_eq!(reply.status, Some(200));
        assert_eq!(reply.body.unwrap()["ok"], true);
    }

    #[test]
    fn every_hand_over_op_reaches_its_own_path() {
        for (op, line) in [
            (AudioHubOp::AirpodsPc, "POST /api/airpods/pc HTTP/1.1"),
            (AudioHubOp::Xm6Phone, "POST /api/xm6/phone HTTP/1.1"),
            (AudioHubOp::Xm6Pc, "POST /api/xm6/pc HTTP/1.1"),
        ] {
            let dir = tempdir();
            let path = token_file(&dir, "tok");
            let mock = Mock::start(vec![http(200, HELLO), http(200, r#"{"ok":true,"message":"m"}"#)]);
            perform(&Target::for_test(mock.port, Some(path)), op);
            let reqs = mock.finish();
            assert!(reqs[1].starts_with(line), "{op:?}: {}", reqs[1]);
        }
    }

    #[test]
    fn error_statuses_and_their_json_pass_through() {
        for (status, body) in [
            (401, r#"{"ok":false,"error":"not paired"}"#),
            (409, r#"{"ok":false,"error":"no AirPods chosen in Audio Hub yet"}"#),
            (503, r#"{"ok":false,"error":"FlooCast is not running on the PC"}"#),
        ] {
            let dir = tempdir();
            let path = token_file(&dir, "tok");
            let mock = Mock::start(vec![http(200, HELLO), http(status, body)]);
            let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::AirpodsPc);
            mock.finish();
            assert_eq!(reply.running, true);
            assert_eq!(reply.status, Some(status));
            assert_eq!(reply.body.unwrap()["ok"], false);
            assert_eq!(reply.error, None);
        }
    }

    #[test]
    fn the_token_is_read_fresh_on_every_call() {
        let dir = tempdir();
        let path = token_file(&dir, "first-token");
        let mock = Mock::start(vec![
            http(200, HELLO), http(200, r#"{"ok":true}"#),
            http(200, HELLO), http(200, r#"{"ok":true}"#),
        ]);
        let target = Target::for_test(mock.port, Some(path.clone()));
        perform(&target, AudioHubOp::Xm6Pc);
        // Audio Hub "forgot paired phones" and wrote a new one.
        std::fs::write(&path, "second-token\n").unwrap();
        perform(&target, AudioHubOp::Xm6Pc);
        let reqs = mock.finish();
        assert_eq!(reqs.len(), 4);
        assert!(reqs[1].contains("Bearer first-token\r\n"), "{}", reqs[1]);
        assert!(reqs[3].contains("Bearer second-token\r\n"), "{}", reqs[3]);
    }

    #[test]
    fn a_closed_port_means_not_running_and_nothing_is_read() {
        // Bind then drop: the port is free and nothing listens on it.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        // No token file at all: proves the refusal is decided before the
        // token is ever looked for.
        let reply = perform(&Target::for_test(port, None), AudioHubOp::AirpodsPhone);
        assert_eq!(reply, AudioHubReply::not_running(NOT_RUNNING));
        assert_eq!(reply.error.as_deref(), Some("Audio Hub isn't running"));
    }

    #[test]
    fn something_else_on_the_port_never_receives_the_token() {
        let dir = tempdir();
        let path = token_file(&dir, "secret-token");
        // Answers hello as another app; a second connection would be served
        // too, so the count below proves none was made.
        let mock = Mock::start(vec![http(200, r#"{"app":"not-audio-hub"}"#), http(200, "{}")]);
        let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::Status);
        let reqs = mock.finish();
        assert_eq!(reply.running, false);
        assert_eq!(reqs.len(), 1, "only hello: {reqs:?}");
        assert!(!reqs.iter().any(|r| r.contains("secret-token")));
    }

    #[test]
    fn a_missing_or_unsafe_token_is_refused_before_any_token_request() {
        for contents in [None, Some(""), Some("   \r\n"), Some("abc\r\nX-Evil: 1"), Some("tok en")] {
            let dir = tempdir();
            let path = match contents {
                Some(c) => token_file(&dir, c),
                None => dir.path().join("absent.txt"),
            };
            let mock = Mock::start(vec![http(200, HELLO), http(200, r#"{"ok":true}"#)]);
            let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::AirpodsPhone);
            let reqs = mock.finish();
            assert_eq!(reqs.len(), 1, "{contents:?}: only hello may go out: {reqs:?}");
            assert_eq!(reply.running, true);
            assert!(reply.error.is_some(), "{contents:?}");
            assert!(!reply.error.unwrap().contains("X-Evil"));
        }
    }

    #[test]
    fn an_oversized_answer_is_refused() {
        let dir = tempdir();
        let path = token_file(&dir, "tok");
        let huge = format!(r#"{{"ok":true,"message":"{}"}}"#, "x".repeat(MAX_RESPONSE));
        let mock = Mock::start(vec![http(200, HELLO), http(200, &huge)]);
        let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::Status);
        mock.finish();
        assert_eq!(reply.error.as_deref(), Some(TOO_LARGE));
        assert_eq!(reply.body, None);
    }

    #[test]
    fn a_silent_server_times_out_instead_of_hanging() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept and say nothing, for longer than the test target's timeout.
        let h = thread::spawn(move || {
            if let Ok((s, _)) = listener.accept() {
                thread::sleep(Duration::from_millis(2500));
                drop(s);
            }
        });
        let started = Instant::now();
        let reply = perform(&Target::for_test(port, None), AudioHubOp::Status);
        assert!(started.elapsed() < Duration::from_millis(2400), "{:?}", started.elapsed());
        assert_eq!(reply.error.as_deref(), Some(NO_ANSWER));
        let _ = h.join();
    }

    #[test]
    fn an_absurd_content_length_neither_panics_nor_passes() {
        let dir = tempdir();
        let path = token_file(&dir, "tok");
        let lying = "HTTP/1.1 200 OK\r\nContent-Length: 18446744073709551615\r\nConnection: close\r\n\r\n{}".to_string();
        let mock = Mock::start(vec![http(200, HELLO), lying]);
        let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::Status);
        mock.finish();
        assert_eq!(reply.body, None);
        assert_eq!(reply.error.as_deref(), Some(UNREADABLE));
    }

    #[test]
    fn a_huge_token_file_is_refused_without_being_sent() {
        let dir = tempdir();
        let path = token_file(&dir, &"a".repeat(MAX_TOKEN * 8));
        let mock = Mock::start(vec![http(200, HELLO), http(200, "{}")]);
        let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::Status);
        let reqs = mock.finish();
        assert_eq!(reqs.len(), 1, "only hello");
        assert_eq!(reply.error.as_deref(), Some(BAD_TOKEN));
    }

    #[test]
    fn non_json_from_audio_hub_is_reported_not_passed_on() {
        let dir = tempdir();
        let path = token_file(&dir, "tok");
        let mock = Mock::start(vec![http(200, HELLO), http(200, "<html>")]);
        let reply = perform(&Target::for_test(mock.port, Some(path)), AudioHubOp::Status);
        mock.finish();
        assert_eq!(reply.body, None);
        assert_eq!(reply.error.as_deref(), Some(UNREADABLE));
    }

    #[test]
    fn reply_serializes_in_the_shape_the_webview_reads() {
        let r = AudioHubReply { running: true, status: Some(409), body: Some(serde_json::json!({"ok":false})), error: None };
        assert_eq!(serde_json::to_value(&r).unwrap(), serde_json::json!({"running":true,"status":409,"body":{"ok":false}}));
        let n = AudioHubReply::not_running(NOT_RUNNING);
        assert_eq!(serde_json::to_value(&n).unwrap(), serde_json::json!({"running":false,"error":"Audio Hub isn't running"}));
    }
}
