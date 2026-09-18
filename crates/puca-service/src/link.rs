//! The service's own connection to the server, for when nobody is signed in.
//!
//! WHY THE SERVICE NEEDS ONE AT ALL. Every other path in this product relies on
//! the desktop app holding the socket: it authenticates, it decides whether a
//! session may exist, and it drives the agent. At a cold-boot sign-in screen
//! there is no app, no JWT, and no readable device key — `device_key.rs` uses
//! DPAPI USER scope, which is unreadable with nobody logged on. So the machine
//! is unreachable by construction unless something running as SYSTEM holds the
//! connection itself.
//!
//! ONLY WHEN THE APP CANNOT. This socket is gated on the same condition the
//! supervisor already computes for the agent: it exists while the console is
//! locked or signed out, and is dropped the moment somebody signs in. Two live
//! sockets for one machine would mean two device rows online at once, and
//! `conn_of_device` resolves by first match (state.rs), so a connect could land
//! on whichever the scan reached first. One at a time, handed over cleanly.
//!
//! ADAPTED FROM `puca-waker`, deliberately and with the differences named.
//! That crate already solved "headless Rust process holds an attested WebSocket
//! and survives": the backoff shape, the re-dial-on-expiry rule and the
//! refresh-via-`x-renewed-token` trick are all its work and are reproduced here
//! rather than reinvented. What differs is the message set — the waker answers
//! one frame and this answers a session protocol — which is why it is adapted
//! rather than shared: a common crate whose two callers overlap only in the
//! connection preamble would be a shared thing pulled in two directions.

#![cfg(windows)]

use std::time::Duration;

/// Reconnect backoff in seconds, by consecutive failure count.
///
/// Bounded at a minute, and starting at zero, for the waker's reason: the usual
/// cause of a drop is the server restarting during a deploy, and an hour-long
/// backoff afterwards is indistinguishable from a machine that is simply
/// unreachable at the moment somebody needs it.
pub fn backoff_secs(consecutive_failures: u32) -> u64 {
    match consecutive_failures {
        0 => 0,
        1 => 1,
        2 => 5,
        3 => 15,
        4 => 30,
        _ => 60,
    }
}

/// Should the socket be re-dialled to pick up a renewed token?
///
/// The server captures `token_exp` once at upgrade and re-checks it on every
/// inbound frame, so a renewed token does not extend an open socket — there is
/// no in-place refresh to write, only a re-dial to schedule. An hour of margin,
/// because renewal only becomes available inside the last twelve.
pub fn should_redial_for_expiry(seconds_left: Option<i64>) -> bool {
    match seconds_left {
        // Unreadable: re-dial and let the server be the judge. Failing toward
        // "ask again" is right for a credential this process cannot verify.
        None => true,
        Some(s) => s < 3_600,
    }
}

/// Seconds until a JWT's `exp`, read WITHOUT verifying it.
///
/// This process has no key to check the signature with and does not need one —
/// the answer only decides when to re-dial, and the server is the sole authority
/// on whether a token is good. An unparseable token resolves to None, which
/// [`should_redial_for_expiry`] treats as "refresh now".
pub fn seconds_until_expiry(token: &str, now_unix: i64) -> Option<i64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    Some(v.get("exp")?.as_i64()? - now_unix)
}

/// The date a copied token stops being renewable, from its own `sst` claim.
///
/// THE CLIFF, computed rather than guessed. `sst` is the real sign-in time and
/// is preserved across every renewal, so a token can be renewed only within
/// `MAX_SESSION_DAYS` of it — after that the server refuses and no amount of
/// uptime helps. A machine that has been off past this date comes back with a
/// credential it cannot repair, which is exactly the case cold boot exists for.
/// Knowing the date in advance is what lets the owner be warned while the
/// machine is still reachable.
pub fn renewable_until_unix(token: &str, max_session_days: i64) -> Option<i64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let sst = v.get("sst")?.as_i64()?;
    Some(sst + max_session_days * 86_400)
}

/// What arrived that this process acts on. Everything else is ignored: the
/// service is not a chat client and has no business interpreting the rest.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Challenge(String),
    Attested,
    Wake { mac: String, broadcast: Option<String> },
    /// A controller wants a session with this machine.
    ///
    /// `eph` is the controller's ephemeral public key and is NOT optional: it is
    /// the peer half of the control-key derivation, so a request without it can
    /// never produce a session. The first version of this struct omitted it —
    /// the agent would then have had nothing to derive against, and the failure
    /// would have surfaced as "connects, never shows a picture".
    ConnectRequest {
        session_id: String,
        from_device: String,
        eph: String,
        proof: String,
        /// The account the controller is acting as, when it is not this one.
        ///
        /// ABSENT MEANS SAME-ACCOUNT — see `relay::ConnectFacts::from_user`,
        /// where this was documented backwards and refused every session.
        /// Present means a cross-user share, carrying the GRANTEE's id.
        ///
        /// Still carried rather than dropped: without it a share connect is
        /// indistinguishable from an ordinary one and the refusal in
        /// `relay::may_accept` could never fire.
        from_user: Option<i64>,
    },
    /// Opaque WebRTC signalling, sealed under a key this process lacks.
    Signalled { session_id: String, payload: String },
    /// One sealed input event.
    Inputted { session_id: String, event: String },
    Ended { session_id: String, reason: String },
    Other,
}

pub fn classify(text: &str) -> Incoming {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Incoming::Other,
    };
    let p = v.get("payload");
    let s = |k: &str| p.and_then(|p| p.get(k)).and_then(|x| x.as_str()).map(str::to_string);
    match v.get("type").and_then(|t| t.as_str()) {
        Some("DeviceChallenge") => match s("nonce") {
            Some(n) => Incoming::Challenge(n),
            None => Incoming::Other,
        },
        Some("DeviceAttested") => Incoming::Attested,
        Some("DeviceWakeRequested") => match s("mac") {
            Some(mac) => Incoming::Wake { mac, broadcast: s("broadcast") },
            None => Incoming::Other,
        },
        Some("DeviceConnectRequested") => {
            match (s("session_id"), s("from_device"), s("eph"), s("proof")) {
                (Some(session_id), Some(from_device), Some(eph), Some(proof)) => {
                    Incoming::ConnectRequest {
                        session_id,
                        from_device,
                        eph,
                        proof,
                        from_user: p
                            .and_then(|p| p.get("from_user"))
                            .and_then(|x| x.as_i64()),
                    }
                }
                // Missing any of them means a request this service cannot serve.
                // Refusing to classify it is better than accepting a half-formed
                // one and failing later with no idea which field was absent.
                _ => Incoming::Other,
            }
        }
        Some("DeviceSignalled") => match (s("session_id"), s("payload")) {
            (Some(session_id), Some(payload)) => Incoming::Signalled { session_id, payload },
            _ => Incoming::Other,
        },
        Some("DeviceInputted") => match (s("session_id"), s("event")) {
            (Some(session_id), Some(event)) => Incoming::Inputted { session_id, event },
            _ => Incoming::Other,
        },
        Some("DeviceEnded") => match s("session_id") {
            Some(session_id) => Incoming::Ended {
                session_id,
                reason: s("reason").unwrap_or_default(),
            },
            None => Incoming::Other,
        },
        _ => Incoming::Other,
    }
}

/// How often to ask for a renewed token. Four hours guarantees at least two
/// attempts inside the twelve-hour renewal window.
pub const REFRESH_EVERY: Duration = Duration::from_secs(4 * 3_600);

/// Why a sign-in-screen session ends when somebody signs in at the machine.
///
/// A MACHINE-READABLE HANDOVER, not a human sentence, and it has to travel
/// because of what the alternative did. This service drops its socket the
/// moment the console is unlocked (see `wants_up` below) — deliberately: the
/// desktop app takes over from there. But it used to close WITHOUT ending the
/// live session, so from the server's side an active session had merely lost
/// its host socket, which is the "phone went into the background" case: it
/// held the session for the 60-second detach grace and told the controller
/// `DevicePeerReconnecting`. The host was never coming back — it stopped on
/// purpose — so the controller sat frozen at "reconnecting" until the reaper
/// fired. Measured live: the user typed their PIN, Windows unlocked, and the
/// phone froze until they reconnected by hand.
///
/// Ending the session with THIS reason turns that dead minute into a signal:
/// the controller recognises the string and moves itself to the same
/// machine's desktop-app row, which is exactly where the picture now is.
///
/// The client half is `HANDOVER_REASON` in
/// `frontend/src/api/devices/session.ts`. These two literals are one wire
/// contract compiled separately; a test on each side pins the string.
pub const HANDOVER_REASON: &str = "console-unlocked-handover";

pub const CONFIG_FILE: &str = "link.json";


// ---------------------------------------------------------------------------
// Configuration and identity
// ---------------------------------------------------------------------------

/// Everything the service needs to hold a connection, as stored on disk.
///
/// Lives in the secrets directory (SYSTEM + Administrators only), NOT beside the
/// binaries: `provision.rs` grants `BUILTIN\Users` read on the install directory
/// and propagates it with `OICI`, so a key placed there is readable by every
/// local account. See `secrets.rs`.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct LinkConfig {
    /// e.g. `https://chat.example.com`. No trailing slash.
    pub api_base: String,
    /// The account this machine is enrolled to. Part of the attestation
    /// transcript, so a wrong value fails every signature check.
    pub user_id: i64,
    pub device_id: String,
    pub device_pub: String,
    pub sign_pub: String,
    /// The account's Ed25519 signing PUBLIC key, pinned when this machine was
    /// enrolled by someone signed in.
    ///
    /// WITHOUT THIS THE SERVICE IS MITM-ABLE BY ITS OWN SERVER. `GET /devices`
    /// returns whatever is in the table and the server never verifies
    /// `auth_sig` (device_handlers.rs length-checks it and stores it; its own
    /// header says the CLIENT verifies). So a server that wanted to read a
    /// session could hand back a row carrying its own `device_pub` and sit in
    /// the middle of the static DH. This key is what makes that visible, and
    /// the service holds only the public half: it can verify, and cannot enrol.
    pub account_sign_pub: String,
}

pub const TOKEN_FILE: &str = "link.token";
pub const DEVICE_PRIV_FILE: &str = "device.key";
pub const SIGN_SEED_FILE: &str = "sign.key";

impl LinkConfig {
    /// `wss://host/ws` — derived from `api_base` so there is one place the host
    /// is configured and no chance of the two disagreeing.
    ///
    /// NO CREDENTIAL IN THE URL. This was `?token={token}`, and this service
    /// re-dials on every boot and on every socket expiry, so each connection
    /// deposited a live device-scoped JWT into the reverse proxy's access log —
    /// which is rotated, shipped and backed up. Query strings are written
    /// verbatim by essentially every proxy; the subprotocol header is not
    /// logged by default anywhere in that path. See `ws_request`.
    pub fn ws_url(&self) -> String {
        let host = self.api_base.trim_start_matches("https://").trim_start_matches("http://");
        format!("wss://{host}/ws")
    }

    /// The handshake request, carrying the token in `Sec-WebSocket-Protocol` as
    /// `bearer, <jwt>` — the same shape the browser client sends and the server
    /// has accepted since `bearer_from_subprotocol` landed (it is checked BEFORE
    /// the query fallback, so this needs no server change).
    ///
    /// A browser has no choice about this — `new WebSocket(url, protocols)` is
    /// the only place it can put a credential. This is a tokio-tungstenite
    /// client and could set any header it likes; it used the query string only
    /// because the browser did.
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
            .map_err(|_| "the link token is not a valid header value".to_string())?;
        req.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, value);
        Ok(req)
    }

    pub fn load() -> Result<Self, String> {
        let raw = crate::secrets::read_secret(CONFIG_FILE)?;
        serde_json::from_slice(&raw).map_err(|e| format!("{CONFIG_FILE} is malformed: {e}"))
    }

    pub fn save(&self) -> Result<(), String> {
        let raw = serde_json::to_vec_pretty(self).map_err(|e| format!("cannot encode: {e}"))?;
        crate::secrets::write_secret(CONFIG_FILE, &raw)
    }
}

/// The Ed25519 transcript the server verifies.
///
/// Copied from `src/ws.rs` and pinned by a test. If it drifts, every attestation
/// fails with a signature error and the service looks broken rather than
/// mismatched — the same trap `puca-waker` documents on its own copy.
pub fn attestation_message(nonce: &str, user_id: i64) -> String {
    format!("sovereign-device-attest-v1|{nonce}|{user_id}")
}

pub fn sign_attestation(sign_seed: &[u8; 32], nonce: &str, user_id: i64) -> String {
    use ed25519_dalek::Signer;
    let sk = ed25519_dalek::SigningKey::from_bytes(sign_seed);
    base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        sk.sign(attestation_message(nonce, user_id).as_bytes()).to_bytes(),
    )
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Shared with the SCM thread: the supervisor flips this, the link thread obeys.
///
/// An atomic rather than a channel because the link asks "should I be up?" at
/// arbitrary points (between frames, mid-backoff) and only ever wants the
/// LATEST answer. A queue would make it act on a stale one — e.g. connecting
/// because a lock event arrived, after the unlock that superseded it.
///
/// The `Notify` beside it exists for one measured delay: with only the atomic,
/// `run_socket` could not learn about an unlock until the next frame arrived,
/// and between frames the only guaranteed traffic is the server's 15-second
/// ping. The person had typed their PIN and was LOOKING at their desktop while
/// the handover waited on a ping. The notify is a wake-up, never the answer —
/// every woken path re-reads `wants_up()`, so a stale or spurious wake costs
/// one loop iteration, and a missed one (the SCM flipping the flag in the gap
/// before a waiter registers) degrades to exactly the old ping-bounded wait.
#[derive(Clone, Default)]
pub struct LinkGate(Arc<GateInner>);

#[derive(Default)]
struct GateInner {
    up: AtomicBool,
    changed: tokio::sync::Notify,
}

impl LinkGate {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set(&self, up: bool) {
        // Wake waiters ONLY on a real change. The worker loop re-asserts the
        // gate on every liveness tick (main.rs) as belt and braces; waking the
        // socket's select on each of those would turn a quiet connection into
        // a permanent low-frequency spin.
        let prev = self.0.up.swap(up, Ordering::SeqCst);
        if prev != up {
            self.0.changed.notify_waiters();
        }
    }
    pub fn wants_up(&self) -> bool {
        self.0.up.load(Ordering::SeqCst)
    }
    /// Resolves when `set` next CHANGES the answer. Callers must treat this as
    /// a hint and re-read `wants_up()` — see the type-level comment.
    pub async fn changed(&self) {
        self.0.changed.notified().await;
    }
}




/// A pipe connection held for the life of one session.
///
/// ONE CONNECTION PER SESSION, NOT PER EXCHANGE. `pipe::serve` builds a FRESH
/// `Agent` for every client that connects (see its comment: rebuilding is what
/// stops a second Hello being refused with "already authenticated"), and sealed
/// sessions live on that `Agent`. So a connection-per-exchange design stores the
/// session in an object that is destroyed the moment the exchange ends, and the
/// next call answers "no sealed session with that id".
///
/// This code WAS written that way, justified by wanting a disarm to take effect
/// immediately. That traded a working feature for a latency nicety, and the
/// relay could not have worked at all. The arming record is now read once per
/// SESSION, which is the right semantics anyway: disarming should stop the next
/// session, not yank the screen away from one in progress.
pub type AgentConn = Arc<std::sync::Mutex<crate::agent_client::AgentClient>>;

/// Open the connection this session will keep.
async fn open_agent_conn(handle: &AgentHandle) -> Result<AgentConn, String> {
    let Some((pipe, token, pid)) = handle.lock().ok().and_then(|g| g.clone()) else {
        return Err("no agent is running on the sign-in screen".into());
    };
    tokio::task::spawn_blocking(move || {
        crate::agent_client::AgentClient::connect(&pipe, &token, 3, Some(pid))
            .map(|c| Arc::new(std::sync::Mutex::new(c)))
    })
    .await
    .map_err(|e| format!("the agent call did not finish: {e}"))?
}

/// Run one blocking pipe exchange off the socket's thread.
///
/// SPAWN_BLOCKING, not an inline call. The link runs on a current-thread
/// runtime with exactly one socket on it; a pipe call that hung would stop the
/// socket answering the server's 15-second ping, and the machine would drop
/// offline while the agent was merely slow.
async fn with_agent<T, F>(conn: &AgentConn, f: F) -> Result<T, String>
where
    F: FnOnce(&mut crate::agent_client::AgentClient) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let conn = conn.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = conn.lock().map_err(|_| "the agent connection is poisoned".to_string())?;
        f(&mut guard)
    })
    .await
    .map_err(|e| format!("the agent call did not finish: {e}"))?
}

/// Everything between a connect request and a session that exists.
///
/// Returns the agent's ephemeral public key and the sealed challenge to send.
#[allow(clippy::too_many_arguments)]
async fn accept_session(
    cfg: &LinkConfig,
    token: &str,
    agent: &AgentHandle,
    session_id: &str,
    from_device: &str,
    peer_eph: &str,
    from_user: Option<i64>,
    session_in_progress: bool,
    agent_alive: bool,
) -> Result<(String, Vec<String>, AgentConn), crate::relay::Refusal> {
    use crate::relay::Refusal;

    // The peer's real keys, verified against the pinned account key rather than
    // trusted because the server sent them. See peer_keys.rs.
    let row = fetch_device_row(cfg, token, from_device).await;
    let peer_verified = match &row {
        // fetch_device_row already logged specifically why: an http failure,
        // a body that wasn't {"devices":[...]}, or a real "not present" with a
        // count. Nothing more useful to say here.
        None => false,
        Some(r) => match crate::peer_keys::verify_device_row_diag(&cfg.account_sign_pub, r, cfg.user_id) {
            Ok(()) => true,
            Err(reason) => {
                // account_sign_pub is logged too, truncated: not a secret (it is
                // the public half, published in every auth_record this account
                // has ever signed), but full precision only matters for a diff.
                crate::log::line(&format!(
                    "[link] {from_device} failed peer verification: {reason} \
                     (this machine's account_sign_pub: {}...)",
                    &cfg.account_sign_pub.chars().take(20).collect::<String>()
                ));
                false
            }
        },
    };

    let facts = crate::relay::ConnectFacts {
        armed: crate::arming::is_armed(),
        agent_alive,
        session_in_progress,
        from_user,
        my_user: cfg.user_id,
        peer_verified,
        peer_device_pub: row.as_ref().map(|r| r.device_pub.as_str()),
    };
    crate::relay::may_accept(&facts)?;

    let peer_pub = row.as_ref().map(|r| r.device_pub.clone()).ok_or(Refusal::UnknownPeer)?;
    let identity = load_identity().map_err(Refusal::Agent)?;
    let static_shared = identity.static_shared(&peer_pub).ok_or(Refusal::BadHandshake)?;

    // Fetched now rather than at enrolment: TURN credentials are short-lived,
    // and an empty list means host candidates only — which works across a LAN
    // and fails from mobile data.
    let ice = fetch_ice_servers(cfg, token).await;

    // Opened ONCE, here, and kept for the whole session — see AgentConn.
    let conn = open_agent_conn(agent).await.map_err(crate::relay::Refusal::Agent)?;

    let sid = session_id.to_string();
    let peer_eph = peer_eph.to_string();
    let eph_pub = with_agent(&conn, move |c| {
        crate::relay::open_on_agent(c, &sid, &static_shared, &peer_eph, &ice)
            .map_err(|r| r.reason())
    })
    .await
    .map_err(Refusal::Agent)?;

    let sid = session_id.to_string();
    let challenge = with_agent(&conn, move |c| crate::relay::sealed_challenge(c, &sid))
        .await
        .map_err(Refusal::Agent)?;

    Ok((eph_pub, challenge, conn))
}

/// This machine's own device identity, as stored by enrolment.
fn load_identity() -> Result<crate::secrets::MachineIdentity, String> {
    let cfg = LinkConfig::load()?;
    let priv_raw = crate::secrets::read_secret(DEVICE_PRIV_FILE)?;
    let device_priv: [u8; 32] =
        priv_raw.try_into().map_err(|_| "the device key is not 32 bytes".to_string())?;
    let seed_raw = crate::secrets::read_secret(SIGN_SEED_FILE)?;
    let sign_seed: [u8; 32] =
        seed_raw.try_into().map_err(|_| "the signing key is not 32 bytes".to_string())?;
    Ok(crate::secrets::MachineIdentity {
        device_id: cfg.device_id,
        device_pub: cfg.device_pub,
        sign_pub: cfg.sign_pub,
        device_priv,
        sign_seed,
    })
}

/// `GET /devices`'s real response shape: `{"devices": [...]}`, per
/// `ListDevicesResponse` (src/device_handlers.rs). NOT a bare array.
///
/// The first version of this deserialised the response body directly as
/// `Vec<DeviceRow>`, which cannot parse a JSON object. That failure was
/// swallowed by `.ok()?` into a plain `None`, so THIS is what every refused
/// connection actually was: not a bad signature, not a stale device row, not
/// this account at all — the peer list was never successfully read, on any
/// attempt, since the day this was written.
#[derive(serde::Deserialize)]
struct DevicesListResponse {
    devices: Vec<crate::peer_keys::DeviceRow>,
}

async fn fetch_device_row(
    cfg: &LinkConfig,
    token: &str,
    device_id: &str,
) -> Option<crate::peer_keys::DeviceRow> {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(20)).build() {
        Ok(c) => c,
        Err(e) => {
            crate::log::line(&format!("[link] could not build an http client: {e}"));
            return None;
        }
    };
    let resp = match client.get(format!("{}/devices", cfg.api_base)).bearer_auth(token).send().await
    {
        Ok(r) => r,
        Err(e) => {
            crate::log::line(&format!("[link] GET /devices failed: {e}"));
            return None;
        }
    };
    let status = resp.status();
    if !status.is_success() {
        // The body on a real failure (401 expired token, 429, a proxy's HTML
        // error page) is worth the first 200 bytes of it: the status alone
        // does not distinguish "this token is dead" from "the server is
        // returning something that isn't JSON at all".
        let body = resp.text().await.unwrap_or_default();
        crate::log::line(&format!(
            "[link] GET /devices returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
        return None;
    }
    let text = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            crate::log::line(&format!("[link] GET /devices body unreadable: {e}"));
            return None;
        }
    };
    let parsed: DevicesListResponse = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            crate::log::line(&format!(
                "[link] GET /devices returned {status} but did not parse as \
                 {{\"devices\":[...]}}: {e}"
            ));
            return None;
        }
    };
    let count = parsed.devices.len();
    let found = parsed.devices.into_iter().find(|r| r.id == device_id);
    if found.is_none() {
        crate::log::line(&format!(
            "[link] GET /devices returned {count} device(s) for this account, \
             none with id {device_id}"
        ));
    }
    found
}

/// TURN/STUN for the stream. An empty list on failure rather than a refusal:
/// host candidates still connect across a LAN, which is the case this feature
/// exists for, and refusing the whole session because a side call failed would
/// be worse than a session that only works at home.
async fn fetch_ice_servers(cfg: &LinkConfig, token: &str) -> serde_json::Value {
    let empty = serde_json::json!([]);
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(10)).build() else {
        return empty;
    };
    let Ok(resp) =
        client.get(format!("{}/ice-config", cfg.api_base)).bearer_auth(token).send().await
    else {
        return empty;
    };
    let Ok(v) = resp.json::<serde_json::Value>().await else { return empty };
    v.get("iceServers").cloned().unwrap_or(empty)
}

/// Hold one socket until it dies or the gate closes. `Ok(())` on a clean end.
///
/// GATE CHECKED ON EVERY FRAME **and** the loop selects on `gate.changed()`,
/// so an unlock interrupts the wait instead of riding out the gap to the next
/// frame. The console can unlock at any moment, and the rule this service is
/// built on — never hold a connection while somebody is using the machine — is
/// only true if it can drop one mid-stream. The per-frame `wants_up()` check
/// stays even with the notify: it is the truth the wake-up merely points at,
/// and it is what bounds a missed notification to the server's 15-second ping
/// (the pre-notify behaviour) rather than forever.
pub async fn run_socket(
    cfg: &LinkConfig,
    token: &str,
    sign_seed: &[u8; 32],
    gate: &LinkGate,
    agent_running: &dyn Fn() -> bool,
    agent: &AgentHandle,
) -> Result<(), AttemptError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // TYPED, not a string: a 401 here means the stored token is dead, and the
    // loop must go to the device key next time instead of re-presenting it.
    let (mut ws, _) = tokio_tungstenite::connect_async(cfg.ws_request(token)?)
        .await
        .map_err(|e| classify_connect_error(&e))?;
    crate::log::line("[link] connected; waiting for the attestation challenge");

    let mut attested = false;
    let mut last_wake: Option<(String, std::time::Instant)> = None;
    // The one live session, if any. See relay.rs: a second would collide inside
    // the agent, and the collision would arrive AFTER the controller had been
    // told it was accepted.
    let mut session: Option<(crate::relay::Session, AgentConn)> = None;
    // BOUNDED ON PURPOSE. A socket left open indefinitely outlives its own
    // token: the server captures `token_exp` at upgrade and never re-reads a
    // renewed one, so the only way to pick one up is to re-dial. Coming back
    // here every few hours is what keeps a machine reachable across weeks of
    // being locked rather than only for the first day.
    let opened = std::time::Instant::now();

    loop {
        // `None` from the gate arm means "woken, no frame": fall through to
        // the checks below with nothing to process. The frame arm ending the
        // stream breaks out to the same clean return the old `while let` had.
        let frame = tokio::select! {
            maybe = ws.next() => match maybe {
                Some(f) => Some(f),
                None => break,
            },
            _ = gate.changed() => None,
        };
        if opened.elapsed() >= REFRESH_EVERY {
            crate::log::line("[link] re-dialling to pick up a renewed token");
            let _ = ws.close(None).await;
            return Ok(());
        }
        if !gate.wants_up() {
            // END THE SESSION FIRST, and say why. Closing the socket with a
            // live session still open looks identical to a host that dropped
            // off the network, so the server holds it for the detach grace
            // window and tells the controller "reconnecting" — for a host that
            // is never coming back, because it stopped on purpose. That is a
            // full minute of frozen picture right after the user typed their
            // PIN. `HANDOVER_REASON` is the controller's cue to move to this
            // machine's desktop-app row instead.
            if let Some((s, _)) = session.as_ref() {
                let out = serde_json::json!({
                    "type": "DeviceEnd",
                    "payload": { "session_id": s.id, "reason": HANDOVER_REASON }
                });
                let _ = ws.send(Message::Text(out.to_string())).await;
            }
            crate::log::line("[link] the console is in use — dropping the socket");
            let _ = ws.close(None).await;
            return Ok(());
        }
        let Some(frame) = frame else { continue };
        let msg = frame.map_err(|e| format!("socket error: {e}"))?;
        let text = match msg {
            Message::Text(t) => t,
            // tokio-tungstenite answers Ping automatically; the server's 15s
            // Ping is what keeps this connection accounted for as live.
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => {
                crate::log::line("[link] the server closed the socket");
                return Ok(());
            }
            _ => continue,
        };

        match classify(&text) {
            Incoming::Challenge(nonce) => {
                let sig = sign_attestation(sign_seed, &nonce, cfg.user_id);
                let out = serde_json::json!({
                    "type": "DeviceAttest",
                    "payload": { "device_id": cfg.device_id, "sig": sig }
                });
                ws.send(Message::Text(out.to_string()))
                    .await
                    .map_err(|e| format!("could not answer the challenge: {e}"))?;
            }
            Incoming::Attested => {
                attested = true;
                crate::log::line(&format!("[link] attested as {}", cfg.device_id));
                record(&cfg.device_id, LinkEvent::Attested);
            }
            Incoming::Wake { mac, broadcast } => {
                // ATTESTATION IS NOT OPTIONAL HERE. The server should never
                // relay a wake to an unattested connection, but this process
                // acts on a server-supplied MAC without asking anyone, so it
                // checks the property it depends on rather than assuming the
                // other end enforced it.
                if !attested {
                    crate::log::line("[link] refusing a wake on an unattested socket");
                    continue;
                }
                if let Some((last_mac, at)) = &last_wake {
                    if last_mac == &mac && at.elapsed() < MAC_COOLDOWN {
                        continue;
                    }
                }
                let local = crate::lan::collect();
                let bind_ip = local
                    .as_ref()
                    .and_then(|l| l.ip.parse::<std::net::Ipv4Addr>().ok())
                    .unwrap_or(std::net::Ipv4Addr::UNSPECIFIED);
                let local_bcast = local
                    .as_ref()
                    .and_then(|l| l.broadcast.parse::<std::net::Ipv4Addr>().ok());
                match crate::wol::send_from(bind_ip, local_bcast, &mac, broadcast.as_deref()) {
                    Ok(n) => {
                        last_wake = Some((mac.clone(), std::time::Instant::now()));
                        crate::log::line(&format!("[link] sent {n} wake packets for {mac}"));
                    }
                    Err(e) => crate::log::line(&format!("[link] wake for {mac} FAILED: {e}")),
                }
            }
            Incoming::ConnectRequest { session_id, from_device, eph, from_user, .. } => {
                if !attested {
                    continue;
                }
                let outcome = accept_session(
                    cfg,
                    token,
                    agent,
                    &session_id,
                    &from_device,
                    &eph,
                    from_user,
                    session.is_some(),
                    agent_running(),
                )
                .await;

                match outcome {
                    Ok((eph_pub, challenge, conn)) => {
                        crate::log::line(&format!(
                            "[link] session {session_id} accepted from {from_device}"
                        ));
                        session = Some((
                            crate::relay::Session {
                                id: session_id.clone(),
                                peer_device: from_device,
                                outbound: vec![],
                            },
                            conn,
                        ));
                        // ACCEPT FIRST, THEN CHALLENGE, matching the app
                        // (session.ts:2475 then :2519). The controller buffers
                        // signalling that arrives before it has derived its key,
                        // so the challenge landing immediately is expected.
                        let out = serde_json::json!({
                            "type": "DeviceConnectResponse",
                            "payload": {
                                "session_id": session_id,
                                "accepted": true,
                                "eph": eph_pub,
                            }
                        });
                        let _ = ws.send(Message::Text(out.to_string())).await;
                        for payload in challenge {
                            let sig = serde_json::json!({
                                "type": "DeviceSignal",
                                "payload": { "session_id": session_id, "payload": payload }
                            });
                            let _ = ws.send(Message::Text(sig.to_string())).await;
                        }
                    }
                    Err(refusal) => {
                        let why = refusal.reason();
                        crate::log::line(&format!("[link] refusing {session_id}: {why}"));
                        let out = serde_json::json!({
                            "type": "DeviceConnectResponse",
                            "payload": {
                                "session_id": session_id,
                                "accepted": false,
                                "reason": why,
                            }
                        });
                        let _ = ws.send(Message::Text(out.to_string())).await;
                    }
                }
            }

            Incoming::Signalled { session_id, payload } => {
                // Only for the session this machine actually accepted. A frame
                // naming another id is not ours to relay, and passing it to the
                // agent would let one controller drive another's session.
                let Some((live, conn)) = session.as_ref() else { continue };
                if live.id != session_id {
                    continue;
                }
                let conn = conn.clone();
                // Cloned INTO the closure: spawn_blocking needs 'static, and
                // borrowing the frame here would tie a background task to a
                // loop iteration that has already moved on.
                let (sid, pay) = (session_id.clone(), payload.clone());
                match with_agent(&conn, move |c| crate::relay::relay_signal(c, &sid, &pay)).await
                {
                    Ok(out_frames) => {
                        for p in out_frames {
                            let sig = serde_json::json!({
                                "type": "DeviceSignal",
                                "payload": { "session_id": session_id, "payload": p }
                            });
                            let _ = ws.send(Message::Text(sig.to_string())).await;
                        }
                    }
                    Err(e) => {
                        // Signalling failures ARE session-ending: a refused
                        // offer means there will never be a picture, and
                        // leaving the controller waiting is worse than telling
                        // it now.
                        crate::log::line(&format!("[link] session {session_id} failed: {e}"));
                        let out = serde_json::json!({
                            "type": "DeviceEnd",
                            "payload": { "session_id": session_id, "reason": e }
                        });
                        let _ = ws.send(Message::Text(out.to_string())).await;
                        let sid = session_id.clone();
                        let _ = with_agent(&conn, move |c| {
                            crate::relay::close_on_agent(c, &sid);
                            Ok::<(), String>(())
                        })
                        .await;
                        session = None;
                    }
                }
            }

            Incoming::Inputted { session_id, event } => {
                let Some((live, conn)) = session.as_ref() else { continue };
                if live.id != session_id {
                    continue;
                }
                let conn = conn.clone();
                // A refused keystroke is a refused keystroke. Tearing the
                // session down over one would turn a transient into a
                // disconnect in the middle of typing a password.
                let (sid, ev) = (session_id.clone(), event.clone());
                if let Err(e) =
                    with_agent(&conn, move |c| crate::relay::relay_input(c, &sid, &ev)).await
                {
                    crate::log::line(&format!("[link] input refused: {e}"));
                }
            }

            Incoming::Ended { session_id, reason } => {
                let Some((live, conn)) = session.as_ref() else { continue };
                if live.id != session_id {
                    continue;
                }
                let conn = conn.clone();
                crate::log::line(&format!("[link] session {session_id} ended: {reason}"));
                let sid = session_id.clone();
                let _ = with_agent(&conn, move |c| {
                    // MUST run even though the session is over: the capture
                    // stays reserved otherwise and the next session fails with
                    // "that session is already streaming".
                    crate::relay::close_on_agent(c, &sid);
                    Ok::<(), String>(())
                })
                .await;
                session = None;
            }
            Incoming::Other => {}
        }
    }
    Ok(())
}

/// Ignore a repeat wake for the same MAC inside this window. A user tapping the
/// button twice should not produce a second burst.
const MAC_COOLDOWN: Duration = Duration::from_secs(10);


/// Ask the API for a renewed token, and persist it if one comes back.
///
/// `GET /devices` rather than a dedicated endpoint, following the waker: it is
/// the only call that carries `x-renewed-token`, and its response doubles as a
/// self-check — a 401 means this machine was revoked, which is a DIFFERENT
/// problem from a network failure and must not be retried as one.
///
/// WHAT THIS CANNOT FIX, and the reason Stage 7 exists: renewal only extends a
/// token within `MAX_SESSION_DAYS` of its original sign-in (`sst`). A machine
/// that has been switched off past that date comes back holding a credential
/// the server will refuse to renew, and no amount of retrying helps. Renewal
/// keeps a machine reachable across reboots and weeks; it does not make it
/// reachable after months.
pub async fn refresh_token(cfg: &LinkConfig, token: &str) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(format!("{}/devices", cfg.api_base))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("GET /devices failed: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("the token was rejected — this machine needs enrolling again".into());
    }
    let renewed = resp
        .headers()
        .get("x-renewed-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if let Some(t) = &renewed {
        crate::secrets::write_secret(TOKEN_FILE, t.as_bytes())?;
        crate::log::line("[link] adopted a renewed token");
    }
    Ok(renewed)
}

/// Trade this machine's own device key for a fresh session.
///
/// THE ANSWER TO "EVEN IF IT'S BEEN OFF FOR A WHILE". A stored token dies two
/// ways and neither can be repaired by retrying: it expires (and
/// `validate_token` runs BEFORE `renew_if_stale`, so an expired one is never
/// renewed), or it passes `MAX_SESSION_DAYS` from its original sign-in and the
/// server refuses to renew it however fresh it looks. A machine switched off
/// past either point comes back unreachable exactly when someone wants it.
///
/// This asks the server for a nonce, signs it with the Ed25519 key enrolment
/// generated, and gets an hour-long session back. The key is on this machine's
/// disk under a SYSTEM-only ACL and does not expire, so a machine that was off
/// for a month recovers on its own.
///
/// Two round trips rather than a self-signed timestamp, because a timestamp is
/// replayable by anyone who saw it inside the acceptance window — and that
/// window has to be wide enough for a machine whose clock drifted while it was
/// switched off, which is precisely this machine.
pub async fn obtain_device_token(cfg: &LinkConfig) -> Result<String, AttemptError> {
    let sign_seed = read_seed(SIGN_SEED_FILE)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let chal: serde_json::Value = client
        .post(format!("{}/devices/token/challenge", cfg.api_base))
        .json(&serde_json::json!({ "device_id": cfg.device_id }))
        .send()
        .await
        .map_err(|e| format!("could not ask for a challenge: {e}"))?
        .json()
        .await
        .map_err(|e| format!("the challenge was unreadable: {e}"))?;

    let nonce = chal
        .get("nonce")
        .and_then(|x| x.as_str())
        .ok_or("the server did not send a challenge")?;

    // The SAME transcript the WebSocket attestation signs. One signing format
    // for one meaning: a second one here would be another thing to keep in step
    // with the server, the waker and the agent.
    let sig = sign_attestation(&sign_seed, nonce, cfg.user_id);

    let resp = client
        .post(format!("{}/devices/token", cfg.api_base))
        .json(&serde_json::json!({
            "device_id": cfg.device_id,
            "nonce": nonce,
            "sig": sig,
        }))
        .send()
        .await
        .map_err(|e| format!("could not redeem the challenge: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        // CAPTURE THE BODY. The server puts the real cause here (a 500 carried
        // "database error: mismatched types; Rust type i64 ... not compatible
        // with SQL type INT4" for an entire release), and discarding it is how
        // a server-side bug masqueraded as "this device was revoked" with
        // nothing to diagnose from on either end.
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        // 5xx IS NOT A REVOCATION. It is a server error or a transient one, and
        // retrying is exactly right — the loop above keeps going on an Err. The
        // old code called every non-2xx "no longer enrolled", which both sent
        // the owner to re-enrol a machine that IS enrolled and hid the real
        // fault. Even a 4xx is not proof the row is gone: the server answers
        // a database fault with the same 400 as a revoked row, on purpose
        // (src/device_token.rs `db_error`). So a refusal is recorded and
        // retried, never treated as final.
        if status.is_server_error() {
            return Err(AttemptError::Other(format!(
                "the server could not issue a token right now ({status}); will retry: {snippet}"
            )));
        }
        // ONLY A REFUSAL OF THE DEVICE IS RECORDED — see `is_refusal`. A 429,
        // or a challenge that expired because the server restarted between
        // the two round trips, is this attempt failing, not this computer.
        if is_refusal(status.as_u16(), &body) {
            record(&cfg.device_id, LinkEvent::Refused(status.as_u16()));
            return Err(AttemptError::Refused {
                device_id: cfg.device_id.clone(),
                message: format!(
                    "the server refused this computer's own key ({status}): {snippet}"
                ),
            });
        }
        return Err(AttemptError::Other(format!(
            "the server did not accept this attempt ({status}); will retry: {snippet}"
        )));
    }

    let body: serde_json::Value =
        resp.json().await.map_err(|e| format!("the token was unreadable: {e}"))?;
    let token = body
        .get("token")
        .and_then(|x| x.as_str())
        .ok_or("the server did not send a token")?
        .to_string();

    crate::secrets::write_secret(TOKEN_FILE, token.as_bytes())?;
    crate::log::line("[link] obtained a fresh session with this computer's own key");
    // The server accepted this computer's key: whatever was refused before is
    // over, even if the socket that follows fails for some other reason.
    record(&cfg.device_id, LinkEvent::Minted);
    Ok(token)
}

/// Is this machine enrolled for sign-in-screen access at all?
///
/// THE OPT-IN, checked as the presence of real state rather than a stored
/// boolean. A machine nobody enrolled has no config and no token, so the link
/// thread finds nothing, says so once, and never opens a socket. That is the
/// default for every install: the service can be present (it manages the agent
/// across session changes) while this feature is entirely absent.
pub fn is_enrolled() -> bool {
    // EVERY file the socket actually reads, not just the obvious two. Reporting
    // "enrolled" while the signing seed is missing produces a thread that fails
    // and retries for ever, one log line a minute, describing a machine that
    // looks enrolled to everyone reading the config.
    [CONFIG_FILE, TOKEN_FILE, SIGN_SEED_FILE, DEVICE_PRIV_FILE]
        .iter()
        .all(|f| crate::secrets::secret_exists(f))
}

/// The device id this machine is enrolled under, if it is enrolled at all.
///
/// WHY THE APP NEEDS TO BE TOLD. One physical PC is TWO device rows — the app's
/// own, and this service's, each with its own keypair because neither process
/// may hold the other's (see `enrol.rs`). Nothing tied them together, so the
/// list showed two entries for one machine, and the capabilities split badly
/// between them: only the app's row ever got a MAC recorded (`lanInfo.ts`
/// PATCHes `thisDeviceId()` and nothing else), so the row you can actually
/// reach at the sign-in screen was permanently un-wakeable, and its "no network
/// details yet" advice told you to open Puca on that machine — which
/// publishes to the OTHER row and can never help.
///
/// Handing the id out fixes both: the app PATCHes the same sealed LAN details
/// onto this row too, and two rows carrying the same MAC are self-evidently one
/// machine. This is PUBLIC — it is the account's own device list — and it is
/// derived from the public keys, so it discloses nothing the server does not
/// already store.
///
/// `None` rather than an error when unenrolled: "there is no id yet" is the
/// ordinary state of a machine nobody has turned this on for.
pub fn enrolled_device_id() -> Option<String> {
    if !is_enrolled() {
        return None;
    }
    LinkConfig::load().ok().map(|c| c.device_id)
}

fn read_seed(name: &str) -> Result<[u8; 32], String> {
    let raw = crate::secrets::read_secret(name)?;
    raw.try_into().map_err(|_| format!("{name} is not a 32-byte key"))
}

// ---------------------------------------------------------------------------
// Link health: what the server last said about this computer
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. "Reach this computer after it restarts" reads as ON from
// local files alone (`is_enrolled` is four files existing), while the server
// can be refusing this computer's own key on every attempt. That happened for
// ten days: the service logged "no longer enrolled (400)" once a minute into a
// file nobody reads, and the app kept showing a ticked box. This record is the
// server's answer, kept where the app can ask for it.
//
// A RECORD, NOT A VERDICT. The same 400 comes back for a revoked row AND for a
// server database fault (src/device_token.rs `db_error` answers identically on
// purpose), so this never stops retrying and never claims a revocation. The app
// decides what counts as persistent (`frontend/src/api/devices/linkHealth.ts`).

/// Where the record lives: the secrets directory, beside the config it
/// describes, so `enrol::forget` and `enrol::finish` can clear it with the rest.
pub const LINK_HEALTH_FILE: &str = "link-health.json";

/// How long to wait after the server refused this computer's own key, instead
/// of the one-minute ladder. Retrying a refusal every minute does nothing but
/// fill the log (~1,440 lines a day); a server-side fix still heals on its own
/// within a quarter of an hour, and locking the computer retries at once.
pub const REFUSED_RETRY_SECS: u64 = 900;

/// The server's recorded answers, for ONE enrolled identity.
///
/// `device_id` keys it: a record for an identity this machine no longer holds
/// says nothing about the one it does. `serde(default)` on every field so a
/// record written by another version still reads.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkHealth {
    #[serde(default)]
    pub device_id: String,
    /// Last time the WebSocket attested (unix seconds).
    #[serde(default)]
    pub attested_at: Option<i64>,
    /// First refusal of the current run of refusals.
    #[serde(default)]
    pub refused_first: Option<i64>,
    /// Most recent refusal.
    #[serde(default)]
    pub refused_last: Option<i64>,
    /// Refusals since the last success. With first/last, this is what lets the
    /// app tell one refusal (possibly a blip) from a persistent one.
    #[serde(default)]
    pub refused_count: u32,
    #[serde(default)]
    pub refused_status: Option<u16>,
}

/// Something the server said that the record keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkEvent {
    /// The WebSocket attested: the server accepts this computer.
    Attested,
    /// `/devices/token` minted a session for this computer's own key — the
    /// server accepts it, even if the socket has not attested yet.
    Minted,
    /// `/devices/token` refused this computer's own key (see [`is_refusal`]).
    Refused(u16),
}

/// Fold one event into the record. PURE, so every rule is testable without a
/// disk or a server.
pub fn fold_health(prev: &LinkHealth, device_id: &str, ev: LinkEvent, now: i64) -> LinkHealth {
    // Another identity's record says nothing about this one: start clean.
    let mut next = if prev.device_id == device_id {
        prev.clone()
    } else {
        LinkHealth { device_id: device_id.to_string(), ..LinkHealth::default() }
    };
    let clear_refusal = |h: &mut LinkHealth| {
        h.refused_first = None;
        h.refused_last = None;
        h.refused_count = 0;
        h.refused_status = None;
    };
    match ev {
        LinkEvent::Attested => {
            next.attested_at = Some(now);
            clear_refusal(&mut next);
        }
        LinkEvent::Minted => clear_refusal(&mut next),
        LinkEvent::Refused(status) => {
            next.refused_first = next.refused_first.or(Some(now));
            next.refused_last = Some(now);
            next.refused_count = next.refused_count.saturating_add(1);
            next.refused_status = Some(status);
        }
    }
    next
}

/// Is this `/devices/token` failure the server refusing THIS COMPUTER, as
/// opposed to refusing this one attempt?
///
/// NARROW ON PURPOSE. The endpoint answers 400 for several reasons, and only
/// one of them is about the device: "that device could not be verified" (row
/// missing or revoked, bad signature — or a server database fault, which is
/// why nothing downstream calls it a revocation). The challenge errors — "that
/// challenge is unknown or has expired", "that challenge was not issued for
/// this device" — happen when the server restarts between the two round trips
/// and say nothing about the device. 408 and 429 are the server being busy.
/// Recording those would raise a warning the owner cannot act on.
pub fn is_refusal(status: u16, body: &str) -> bool {
    match status {
        401 | 403 | 404 => true,
        400 => body.contains("that device could not be verified"),
        _ => false,
    }
}

/// The record for `device_id`, or None when the record is another identity's.
pub fn health_for(h: &LinkHealth, device_id: &str) -> Option<LinkHealth> {
    (!device_id.is_empty() && h.device_id == device_id).then(|| h.clone())
}

/// The process's copy of the record, loaded lazily from disk. The link thread
/// writes it and the control pipe reads it; both live in this process.
static HEALTH: std::sync::Mutex<Option<LinkHealth>> = std::sync::Mutex::new(None);
static HEALTH_WRITE_WARNED: AtomicBool = AtomicBool::new(false);

fn load_health_file() -> LinkHealth {
    crate::secrets::read_secret(LINK_HEALTH_FILE)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record one event for `device_id`. BEST-EFFORT: a failed write is logged once
/// and never fails the link — the link is the feature, this only describes it.
pub fn record(device_id: &str, ev: LinkEvent) {
    let mut guard = HEALTH.lock().unwrap_or_else(|p| p.into_inner());
    let prev = guard.get_or_insert_with(load_health_file).clone();
    let next = fold_health(&prev, device_id, ev, now_unix());
    if next == prev {
        return;
    }
    *guard = Some(next.clone());
    let written = serde_json::to_vec(&next)
        .map_err(|e| e.to_string())
        .and_then(|raw| crate::secrets::write_secret(LINK_HEALTH_FILE, &raw));
    if let Err(e) = written {
        if !HEALTH_WRITE_WARNED.swap(true, Ordering::SeqCst) {
            crate::log::line(&format!("[link] could not save the link-health record: {e}"));
        }
    }
}

/// Forget the record, in memory AND on disk. Called by `enrol::finish` and
/// `enrol::forget`: after the owner re-enrols, the warning about the previous
/// identity must go at once, not at the next attestation.
pub fn forget_health() {
    let mut guard = HEALTH.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(LinkHealth::default());
    if let Ok(dir) = crate::secrets::secrets_dir() {
        let _ = std::fs::remove_file(dir.join(LINK_HEALTH_FILE));
    }
}

/// The record for the identity currently enrolled, if there is one.
pub fn link_health_for(device_id: Option<&str>) -> Option<LinkHealth> {
    let id = device_id?;
    let mut guard = HEALTH.lock().unwrap_or_else(|p| p.into_inner());
    health_for(guard.get_or_insert_with(load_health_file), id)
}

impl From<LinkHealth> for crate::control::LinkHealthView {
    fn from(h: LinkHealth) -> Self {
        crate::control::LinkHealthView {
            attested_at: h.attested_at,
            refused_first: h.refused_first,
            refused_last: h.refused_last,
            refused_count: h.refused_count,
            refused_status: h.refused_status,
        }
    }
}

/// How one link attempt failed, where the difference changes what happens next.
#[derive(Debug, PartialEq, Eq)]
pub enum AttemptError {
    /// `/devices/token` refused this computer's own key (already recorded).
    /// Carries the identity it refused, so the long wait applies only while
    /// that identity is still the enrolled one.
    Refused { device_id: String, message: String },
    /// The WebSocket upgrade answered HTTP 401: the stored token is dead (a
    /// signed-out or revoked session), however far from expiry it looks.
    TokenRejected(String),
    /// Everything else — DNS, TLS, a 5xx, a challenge that expired.
    Other(String),
}

impl std::fmt::Display for AttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttemptError::Refused { message, .. } => f.write_str(message),
            AttemptError::TokenRejected(m) | AttemptError::Other(m) => f.write_str(m),
        }
    }
}

impl From<String> for AttemptError {
    fn from(s: String) -> Self {
        AttemptError::Other(s)
    }
}

impl From<&str> for AttemptError {
    fn from(s: &str) -> Self {
        AttemptError::Other(s.to_string())
    }
}

/// Classify a failed WebSocket connect. A 401 on the upgrade is the only case
/// that changes the next attempt: the token is dead, so go to the device key.
pub fn classify_connect_error(e: &tokio_tungstenite::tungstenite::Error) -> AttemptError {
    use tokio_tungstenite::tungstenite::Error;
    let message = format!("connect failed: {e}");
    match e {
        Error::Http(resp) if resp.status().as_u16() == 401 => AttemptError::TokenRejected(message),
        _ => AttemptError::Other(message),
    }
}

/// What the loop does after an attempt.
#[derive(Debug, PartialEq, Eq)]
pub struct AfterAttempt {
    pub failures: u32,
    pub wait_secs: u64,
    /// Skip the stored token next time and go straight to the device key.
    pub force_rekey: bool,
}

/// How THIS attempt got the token it presented, where that changes whether
/// the next attempt may present the stored token again.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AttemptPath {
    /// The attempt skipped the stored token and went straight to the device
    /// key, because the one before it had that token rejected.
    pub forced_rekey: bool,
    /// `/devices/token` minted (and stored) a fresh token during this attempt.
    pub minted: bool,
}

/// Decide the next step from THIS attempt's outcome — never from the record.
///
/// THE RECORD IS NOT CONSULTED, deliberately. A refusal recorded yesterday
/// followed by a DNS failure at boot (routine: the network is not up yet) must
/// get the fast ladder, or a machine the server has since accepted again would
/// sit unreachable for a quarter of an hour after every wake. Only an attempt
/// that itself ended in a refusal, for the identity still enrolled, waits long.
///
/// FORCE_REKEY FOLLOWS THE STORED TOKEN, not just the last error:
/// - a 401 on the upgrade marks the stored token dead, so the next attempt
///   goes to the device key;
/// - a forced rekey that then fails WITHOUT minting (refused, or a network
///   error) leaves that same dead token stored, so the rekey stays set —
///   otherwise every 15-minute cycle of a refused machine would open with a
///   wasted 401 on the token the server already rejected;
/// - a 401 on a token minted in this very attempt does NOT force another
///   mint. The device key was just accepted, so minting again would get the
///   same answer and add a server session per retry, up to one a minute, for
///   as long as the fault lasts. It goes on the plain ladder instead.
pub fn after_attempt(
    failures: u32,
    outcome: &Result<(), AttemptError>,
    enrolled_device: Option<&str>,
    path: AttemptPath,
) -> AfterAttempt {
    match outcome {
        Ok(()) => AfterAttempt { failures: 0, wait_secs: backoff_secs(0), force_rekey: false },
        Err(e) => {
            let failures = failures.saturating_add(1);
            let wait_secs = match e {
                AttemptError::Refused { device_id, .. }
                    if enrolled_device == Some(device_id.as_str()) =>
                {
                    REFUSED_RETRY_SECS
                }
                _ => backoff_secs(failures),
            };
            let force_rekey = match e {
                AttemptError::TokenRejected(_) => !path.minted,
                AttemptError::Refused { .. } | AttemptError::Other(_) => {
                    path.forced_rekey && !path.minted
                }
            };
            AfterAttempt { failures, wait_secs, force_rekey }
        }
    }
}

/// Run the link for as long as the service lives, on its own thread.
///
/// A DEDICATED THREAD WITH ITS OWN CURRENT-THREAD RUNTIME, rather than making
/// the service loop async. That loop is the single mutator of the supervisor and
/// the agent map, and it is driven by SCM callbacks; turning it async to
/// accommodate one socket would rewrite the part of this service that already
/// works for the part that does not yet exist.
///
/// Never returns. Every error path loops rather than exits: a service whose
/// network thread quietly died looks exactly like a machine that is switched
/// off, which is the single hardest failure to diagnose remotely.
/// Published by the service loop: the pipe name and launch token of the agent
/// it started.
///
/// THE TOKEN NEVER LEAVES THIS PROCESS — `main.rs` is explicit that nothing is
/// published — so the link cannot dial the agent without being handed it here.
/// A Mutex rather than an atomic because it is a pair of strings replaced
/// wholesale on every relaunch, and a half-updated pair would dial the old pipe
/// with the new token.
pub type AgentHandle = Arc<std::sync::Mutex<Option<(String, String, u32)>>>;

pub fn run_thread(gate: LinkGate, agent_alive: Arc<AtomicBool>, agent: AgentHandle) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                crate::log::line(&format!("[link] no runtime, the link is disabled: {e}"));
                return;
            }
        };
        rt.block_on(link_forever(gate, agent_alive, agent));
    });
}

async fn link_forever(gate: LinkGate, agent_alive: Arc<AtomicBool>, agent: AgentHandle) {
    let mut announced_absent = false;
    let mut failures: u32 = 0;
    // Set when the last attempt's WebSocket upgrade answered 401. The stored
    // token is then dead however far from expiry it looks (a signed-out or
    // revoked session), and re-presenting it loops on the same 401 for ever
    // without ever asking the one thing that can tell a sign-out from a
    // revoked row: this computer's own key.
    let mut force_rekey = false;

    loop {
        if !gate.wants_up() {
            // Somebody is using the machine. Nothing to do, and deliberately no
            // socket while that is true. The select means a lock starts the
            // connect immediately instead of paying up to 2s of this nap; the
            // sleep stays as the fallback for a wake-up lost to the register
            // race (see `LinkGate`).
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                _ = gate.changed() => {}
            }
            continue;
        }
        if !is_enrolled() {
            if !announced_absent {
                crate::log::line(
                    "[link] this machine is not enrolled for sign-in-screen access; \
                     the link stays closed",
                );
                announced_absent = true;
            }
            // Slowly, because this is the permanent state on every machine that
            // never opts in, and it must cost nothing.
            tokio::time::sleep(Duration::from_secs(60)).await;
            continue;
        }
        announced_absent = false;

        // Set inside the attempt the moment `/devices/token` hands back a
        // fresh token (see `AttemptPath`): a 401 on THAT token must not send
        // the next attempt to mint yet another one.
        let mut minted = false;
        let attempt = async {
            let cfg = LinkConfig::load()?;
            let token = String::from_utf8(crate::secrets::read_secret(TOKEN_FILE)?)
                .map_err(|_| "the stored token is not text".to_string())?;
            let token = token.trim().to_string();
            if token.is_empty() {
                return Err("the stored token is empty — this machine needs enrolling again".into());
            }
            // Renew BEFORE connecting when the token is close to expiry: the
            // server pins `token_exp` at upgrade, so connecting first would
            // open a socket already doomed to be closed under us.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let token = if force_rekey {
                // Straight to the device key: `refresh_token` presents the same
                // dead token to GET /devices and would only 401 again.
                crate::log::line(
                    "[link] the server refused the stored token; using this computer's own key",
                );
                let fresh = obtain_device_token(&cfg).await?;
                minted = true;
                fresh
            } else if should_redial_for_expiry(seconds_until_expiry(&token, now)) {
                // Try to renew first — cheaper, and it keeps one session sliding
                // rather than minting a new one every hour.
                match refresh_token(&cfg, &token).await {
                    Ok(Some(fresh)) => fresh,
                    Ok(None) => token,
                    // RENEWAL FAILED. On a machine that has been switched off
                    // this is the expected case, not an error: the token either
                    // expired or passed MAX_SESSION_DAYS from its original
                    // sign-in, and neither is repairable by asking again. The
                    // device key is, so use it.
                    Err(e) => {
                        crate::log::line(&format!("[link] {e}; using this computer's own key"));
                        let fresh = obtain_device_token(&cfg).await?;
                        minted = true;
                        fresh
                    }
                }
            } else {
                token
            };
            let seed = read_seed(SIGN_SEED_FILE)?;
            let alive = agent_alive.clone();
            run_socket(
                &cfg,
                &token,
                &seed,
                &gate,
                &move || alive.load(Ordering::SeqCst),
                &agent,
            )
            .await
        };

        let outcome = attempt.await;
        if let Err(e) = &outcome {
            crate::log::line(&format!("[link] {e}"));
        }
        // Decided by THIS attempt's outcome, for the identity enrolled NOW —
        // see `after_attempt` for why the record is not consulted.
        let path = AttemptPath { forced_rekey: force_rekey, minted };
        let next = after_attempt(failures, &outcome, enrolled_device_id().as_deref(), path);
        failures = next.failures;
        force_rekey = next.force_rekey;

        if next.wait_secs >= REFUSED_RETRY_SECS {
            // The long wait ends on any change of the gate, so LOCKING the
            // computer retries at once: an owner who has just fixed the
            // enrolment and locks the machine to try it should not wait a
            // quarter of an hour to find out. (An unlock ends the wait too,
            // but the gate is then down and the loop naps; nothing is tried
            // until the next lock.)
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(next.wait_secs)) => {}
                _ = gate.changed() => {}
            }
        } else if next.wait_secs > 0 {
            tokio::time::sleep(Duration::from_secs(next.wait_secs)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: serde_json::Value) -> String {
        use base64::Engine;
        let b = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        format!("hdr.{b}.sig")
    }

    /// A literal `GET /devices` response body, shaped exactly as
    /// `ListDevicesResponse` in src/device_handlers.rs actually serialises it —
    /// copied by hand from that struct's field list, not from what this file
    /// used to assume.
    const REAL_DEVICES_RESPONSE: &str = r#"{"devices":[
        {"id":"abc123","device_pub":"x25519:AAAA","sign_pub":"ed25519:BBBB",
         "name":"Phone","platform":"android","auth_record":"{}","auth_sig":"CCCC",
         "host_enabled":false,"host_policy":null,"host_sig":null,"lan_info":null,
         "created_at":"2026-01-01T00:00:00Z","last_seen_at":null,"online":true}
    ]}"#;

    #[test]
    fn the_devices_response_is_an_object_not_a_bare_array() {
        // THE BUG, PINNED DIRECTLY. fetch_device_row's first version parsed the
        // response body as `Vec<DeviceRow>`. Feed it the server's REAL shape and
        // watch that fail — which is the proof that every peer-verification
        // refusal before this fix was this bug, not a bad signature.
        let as_bare_array =
            serde_json::from_str::<Vec<crate::peer_keys::DeviceRow>>(REAL_DEVICES_RESPONSE);
        assert!(
            as_bare_array.is_err(),
            "the server wraps devices in an object; a bare-array parse must fail \
             on real server output, or this test no longer proves anything"
        );

        // The wrapper this file now uses succeeds, and finds the row.
        let parsed: DevicesListResponse =
            serde_json::from_str(REAL_DEVICES_RESPONSE).expect("the real shape must parse");
        assert_eq!(parsed.devices.len(), 1);
        assert_eq!(parsed.devices[0].id, "abc123");
        assert_eq!(parsed.devices[0].device_pub, "x25519:AAAA");
        // auth_record/auth_sig arrive as plain JSON strings server-side (not
        // optional), and must still land in the Option<String> fields this
        // struct shares with peer_keys::verify_device_row.
        assert_eq!(parsed.devices[0].auth_record.as_deref(), Some("{}"));
    }

    #[test]
    fn backoff_recovers_fast_and_is_bounded() {
        assert_eq!(backoff_secs(0), 0, "a deploy restart is over in seconds");
        assert_eq!(backoff_secs(1), 1);
        assert_eq!(backoff_secs(999), 60, "never longer than a minute");
        for n in 0..6 {
            assert!(backoff_secs(n) <= backoff_secs(n + 1), "monotonic at {n}");
        }
    }

    #[test]
    fn a_socket_is_redialled_before_its_token_dies_under_it() {
        assert!(!should_redial_for_expiry(Some(23 * 3_600)), "fresh: stay put");
        assert!(should_redial_for_expiry(Some(59 * 60)), "under an hour");
        assert!(should_redial_for_expiry(Some(-1)), "already expired");
        // Fail toward asking again, never toward a confident wait on a
        // credential this process cannot verify.
        assert!(should_redial_for_expiry(None));
    }

    #[test]
    fn expiry_is_read_without_verification_and_fails_safe() {
        let t = jwt(serde_json::json!({ "exp": 1_000, "sst": 500 }));
        assert_eq!(seconds_until_expiry(&t, 400), Some(600));
        assert_eq!(seconds_until_expiry(&t, 1_500), Some(-500));
        for bad in ["", "not-a-jwt", "a.!!!.c", "only.two"] {
            assert_eq!(seconds_until_expiry(bad, 0), None, "{bad}");
        }
    }

    #[test]
    fn the_renewal_cliff_is_computed_from_sst_not_from_exp() {
        // THE DATE THAT DECIDES WHETHER COLD BOOT WORKS. `sst` is the real
        // sign-in time and survives every renewal, so it — not `exp` — is what
        // bounds how long a copied token can be kept alive. Reading `exp` here
        // would give an answer 30 days too optimistic and the machine would go
        // dark with no warning.
        let sst = 1_000_000i64;
        let t = jwt(serde_json::json!({ "exp": sst + 86_400, "sst": sst }));
        assert_eq!(renewable_until_unix(&t, 30), Some(sst + 30 * 86_400));
        // A token with no sst cannot be reasoned about; None means "warn now"
        // rather than "assume fine".
        assert_eq!(renewable_until_unix(&jwt(serde_json::json!({ "exp": 1 })), 30), None);
    }

    #[test]
    fn the_frames_this_service_acts_on_are_recognised() {
        assert_eq!(
            classify(r#"{"type":"DeviceChallenge","payload":{"nonce":"n1"}}"#),
            Incoming::Challenge("n1".into())
        );
        assert_eq!(
            classify(r#"{"type":"DeviceAttested","payload":{"device_id":"d"}}"#),
            Incoming::Attested
        );
        assert_eq!(
            classify(r#"{"type":"DeviceWakeRequested","payload":{"mac":"AA:BB"}}"#),
            Incoming::Wake { mac: "AA:BB".into(), broadcast: None }
        );
        assert_eq!(
            classify(
                r#"{"type":"DeviceConnectRequested","payload":{"session_id":"s1","from_device":"d2","eph":"x25519:AAAA","proof":"sig"}}"#
            ),
            Incoming::ConnectRequest {
                session_id: "s1".into(),
                from_device: "d2".into(),
                eph: "x25519:AAAA".into(),
                proof: "sig".into(),
                from_user: None,
            }
        );
    }

    #[test]
    fn everything_else_reaches_no_code_path() {
        // The service is not a chat client. The less it interprets, the smaller
        // it is as a target — and it holds an internet socket as LocalSystem, so
        // that surface is the one that matters most in this product.
        for frame in [
            r#"{"type":"ChatMessage","payload":{"content":"hi"}}"#,
            r#"{"type":"DeviceWakeRequested","payload":{}}"#,
            // Missing eph: unservable, so it must not classify as a request.
            r#"{"type":"DeviceConnectRequested","payload":{"session_id":"s1","from_device":"d2","proof":"p"}}"#,
            r#"{"type":"DeviceConnectRequested","payload":{"session_id":"s1"}}"#,
            r#"{"type":"DeviceChallenge","payload":{}}"#,
            "not json",
            "{}",
            "[]",
        ] {
            assert_eq!(classify(frame), Incoming::Other, "{frame}");
        }
    }

    #[test]
    fn the_attestation_transcript_matches_the_server_byte_for_byte() {
        // Copied from src/ws.rs and from puca-waker's own pinned copy.
        // If this drifts, every attestation fails as a SIGNATURE ERROR — the
        // service looks broken rather than mismatched, and the real cause is a
        // string literal three crates away.
        assert_eq!(
            attestation_message("abc123", 42),
            "sovereign-device-attest-v1|abc123|42"
        );
        // The separator is load-bearing: a nonce containing '|' must not be
        // able to shift the user id into the nonce field.
        assert_eq!(
            attestation_message("a|1", 2),
            "sovereign-device-attest-v1|a|1|2"
        );
    }

    #[test]
    fn the_signature_verifies_under_the_published_public_key() {
        // End to end against ed25519-dalek's own verifier, because "it produced
        // 88 characters of base64" is not evidence that the server will accept
        // it.
        use ed25519_dalek::{Signature, Verifier};
        let seed = [3u8; 32];
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        let sig_b64 = sign_attestation(&seed, "nonce-1", 7);
        let raw = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &sig_b64,
        )
        .expect("base64");
        let sig = Signature::from_slice(&raw).expect("64 bytes");
        assert!(sk
            .verifying_key()
            .verify(attestation_message("nonce-1", 7).as_bytes(), &sig)
            .is_ok());
        // A different user id must NOT verify — the account is inside the
        // transcript precisely so a signature cannot be replayed across one.
        assert!(sk
            .verifying_key()
            .verify(attestation_message("nonce-1", 8).as_bytes(), &sig)
            .is_err());
    }

    #[test]
    fn the_websocket_url_is_derived_from_one_configured_host() {
        let mut cfg = LinkConfig {
            api_base: "https://chat.example.com".into(),
            user_id: 1,
            device_id: "d".into(),
            device_pub: "x25519:AAAA".into(),
            sign_pub: "ed25519:AAAA".into(),
            account_sign_pub: "ed25519:BBBB".into(),
        };
        assert_eq!(cfg.ws_url(), "wss://chat.example.com/ws");
        // http in the config must still produce wss: this connection carries an
        // attestation signature and a bearer token, and downgrading it because
        // someone typed the wrong scheme is not a failure mode worth having.
        cfg.api_base = "http://chat.example.com".into();
        assert_eq!(cfg.ws_url(), "wss://chat.example.com/ws");
    }

    /// The token rides a HEADER, never the URL. A query string is written
    /// verbatim into every proxy access log along the path, and this service
    /// re-dials on every boot — so the old form deposited a live device-scoped
    /// JWT into a rotated, shipped, backed-up log file on each connection.
    #[test]
    fn the_handshake_carries_the_token_in_a_header_and_never_in_the_uri() {
        let cfg = LinkConfig {
            api_base: "https://chat.example.com".into(),
            user_id: 1,
            device_id: "d".into(),
            device_pub: "x25519:AAAA".into(),
            sign_pub: "ed25519:AAAA".into(),
            account_sign_pub: "ed25519:BBBB".into(),
        };
        let jwt = "header.payload.signature";
        let req = cfg.ws_request(jwt).expect("builds");

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

    /// A token that cannot be a header value must FAIL the dial rather than
    /// silently connecting without one — an unauthenticated upgrade would be
    /// refused by the server anyway, but as a confusing 401 loop.
    #[test]
    fn a_token_that_is_not_header_safe_is_refused_up_front() {
        let cfg = LinkConfig {
            api_base: "https://chat.example.com".into(),
            user_id: 1,
            device_id: "d".into(),
            device_pub: "x25519:AAAA".into(),
            sign_pub: "ed25519:AAAA".into(),
            account_sign_pub: "ed25519:BBBB".into(),
        };
        assert!(cfg.ws_request("bad
value").is_err());
    }

    #[test]
    fn the_gate_reports_the_latest_answer_not_a_queued_one() {
        let gate = LinkGate::new();
        assert!(!gate.wants_up(), "closed until something says otherwise");
        let copy = gate.clone();
        gate.set(true);
        assert!(copy.wants_up(), "the clone shares the flag");
        // Superseded instantly: the link must see `false`, never act on the
        // `true` that preceded it. This is why it is an atomic and not a queue.
        gate.set(false);
        assert!(!copy.wants_up());
    }

    #[test]
    fn the_gate_wakes_a_waiter_only_when_the_answer_changes() {
        // Both halves matter. The wake is what turns the unlock handover from
        // ping-bounded (≤15s) into immediate; the NO-wake on a repeated value
        // is what stops the worker loop's belt-and-braces re-assert on every
        // liveness tick from spinning the socket's select forever.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("current-thread runtime");
        rt.block_on(async {
            let gate = LinkGate::new();
            gate.set(true);
            let watcher = gate.clone();
            let fut = watcher.changed();
            tokio::pin!(fut);

            // Poll once (via a timeout that expires) so the waiter is
            // REGISTERED — notify_waiters only reaches futures that have been
            // polled, which is exactly the register race the atomic covers.
            let quiet = tokio::time::timeout(Duration::from_millis(20), fut.as_mut()).await;
            assert!(quiet.is_err(), "nothing changed, nothing should wake");

            gate.set(true); // the liveness-tick re-assert
            let still = tokio::time::timeout(Duration::from_millis(20), fut.as_mut()).await;
            assert!(still.is_err(), "a repeated answer is not a change");

            gate.set(false); // the unlock
            let woken = tokio::time::timeout(Duration::from_secs(1), fut.as_mut()).await;
            assert!(woken.is_ok(), "positive control: a real change wakes the waiter");
        });
    }

    #[test]
    fn every_frame_this_link_sends_exists_in_the_servers_protocol() {
        // THIS TEST EXISTS BECAUSE THE BUG ALREADY HAPPENED TWICE. A guessed
        // type name does not fail loudly: the server cannot deserialise it, the
        // frame is dropped, and the symptom is a controller that waits for a
        // timeout and blames the network. `DeviceConnectRefused` was invented
        // whole and shipped in the commit before this one.
        //
        // Reading the server's own source is the only check that can catch it,
        // because the two ends are different crates with no shared type.
        let server = include_str!("../../../src/protocol.rs");
        // Only the non-test half: this module's own test prose mentions frame
        // names, and scanning it made the extractor report its own comment.
        let mine = include_str!("link.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("split always yields one");

        // Every emitted frame type.
        let mut sent = Vec::new();
        for part in mine.split(r#""type": ""#).skip(1) {
            if let Some(name) = part.split('"').next() {
                sent.push(name);
            }
        }
        assert!(!sent.is_empty(), "the extractor found nothing — it has rotted");

        for name in &sent {
            assert!(
                server.contains(&format!("    {name} {{"))
                    || server.contains(&format!("    {name},")),
                "this link sends `{name}`, which is not a variant in src/protocol.rs"
            );
        }

        // A POSITIVE CONTROL for the extractor itself: it must actually be
        // seeing the frames, not an empty list that passes vacuously.
        for expected in
            ["DeviceAttest", "DeviceConnectResponse", "DeviceSignal", "DeviceEnd"]
        {
            assert!(sent.contains(&expected), "{expected} not extracted from: {sent:?}");
        }

        // And the check must be capable of failing.
        assert!(!server.contains("    DeviceConnectRefused {"));
    }
}


#[cfg(test)]
mod handover_tests {
    use super::*;

    /// The unlock path must END the session, not just close the socket.
    ///
    /// THE FROZEN MINUTE THIS PREVENTS, measured live: the service drops its
    /// socket the moment the console is unlocked, which is correct — the
    /// desktop app takes over. But closing with a live session still open is
    /// indistinguishable, from the server's side, from a host that fell off
    /// the network. So the server held the session for its 60-second detach
    /// grace and told the controller "reconnecting", for a host that had
    /// stopped on purpose. The user typed their PIN, Windows unlocked, and the
    /// phone sat frozen until they reconnected by hand.
    ///
    /// Scanned from the NON-TEST source: `include_str!` pulls in this module
    /// too, and this comment names both the branch and the frame.
    #[test]
    fn unlocking_the_console_ends_the_session_rather_than_only_closing() {
        let src = include_str!("link.rs").split("#[cfg(test)]").next().unwrap();

        let branch = src
            .find("if !gate.wants_up() {")
            .expect("the unlock branch must still exist");
        let close = src[branch..]
            .find("ws.close(None)")
            .expect("the branch still closes the socket")
            + branch;
        let body = &src[branch..close];

        assert!(
            body.contains("DeviceEnd"),
            "the console-unlocked branch must end the live session BEFORE closing, \
             or the server treats it as a dropped host and freezes the controller \
             for the whole detach grace window: {body}"
        );
        assert!(
            body.contains("HANDOVER_REASON"),
            "the end must carry the handover reason, which is the controller's cue \
             to move to this machine's desktop-app row: {body}"
        );
        assert!(
            body.contains("session.as_ref()") || body.contains("session.as_mut()"),
            "it must only fire when a session actually exists: {body}"
        );
    }

    /// The literal itself, pinned on both sides of a wire it crosses.
    ///
    /// The client half lives in `frontend/src/api/devices/session.ts`. They are
    /// compiled separately and share no type, so nothing but this test couples
    /// them — and a silent mismatch does not error anywhere. It just restores
    /// the exact freeze the constant was added to remove, which is the kind of
    /// regression that gets rediagnosed from scratch months later.
    #[test]
    fn the_handover_reason_matches_the_clients_copy() {
        assert_eq!(HANDOVER_REASON, "console-unlocked-handover");

        let client = include_str!("../../../frontend/src/api/devices/session.ts");
        assert!(
            client.contains("'console-unlocked-handover'")
                || client.contains("\"console-unlocked-handover\""),
            "session.ts must recognise the exact reason this service sends"
        );
    }
}

/// The link-health record and the retry policy built on it.
///
/// PURE where it can be — the fold, the refusal test, the backoff decision and
/// the connect-error classification take no disk and no server — and SOURCE
/// PINS for the call sites, which the pure tests cannot see: deleting a
/// `record(...)` call would leave every fold test green while the app never
/// hears about a refusal again.
#[cfg(test)]
mod health_tests {
    use super::*;

    const VERIFIED_400: &str = "that device could not be verified";

    fn refused(device_id: &str) -> Result<(), AttemptError> {
        Err(AttemptError::Refused { device_id: device_id.into(), message: "refused".into() })
    }

    /// An attempt that presented the stored token and minted nothing.
    const PLAIN: AttemptPath = AttemptPath { forced_rekey: false, minted: false };

    fn rejected() -> Result<(), AttemptError> {
        Err(AttemptError::TokenRejected("connect failed: HTTP error: 401 Unauthorized".into()))
    }

    #[test]
    fn a_refusal_is_remembered_until_the_next_attestation() {
        let h0 = LinkHealth::default();
        let h1 = fold_health(&h0, "dev", LinkEvent::Refused(400), 1_000);
        assert_eq!(h1.device_id, "dev");
        assert_eq!(
            (h1.refused_first, h1.refused_last, h1.refused_count),
            (Some(1_000), Some(1_000), 1)
        );
        assert_eq!(h1.refused_status, Some(400));

        // The FIRST refusal is kept: it is what "since {date}" means, and it is
        // half of the persistence rule the app applies.
        let h2 = fold_health(&h1, "dev", LinkEvent::Refused(400), 1_900);
        assert_eq!(h2.refused_first, Some(1_000), "the run's start must not move");
        assert_eq!(h2.refused_last, Some(1_900));
        assert_eq!(h2.refused_count, 2);

        let h3 = fold_health(&h2, "dev", LinkEvent::Attested, 2_000);
        assert_eq!(h3.attested_at, Some(2_000));
        assert_eq!(
            (h3.refused_first, h3.refused_last, h3.refused_count, h3.refused_status),
            (None, None, 0, None),
            "an attestation ends the refusal"
        );
    }

    #[test]
    fn a_successful_mint_clears_the_refusal_too() {
        // The server accepting this computer's key IS the answer, even when the
        // socket that follows then fails for an unrelated reason.
        let h = fold_health(&LinkHealth::default(), "dev", LinkEvent::Refused(400), 1_000);
        let h = fold_health(&h, "dev", LinkEvent::Refused(400), 2_000);
        assert_eq!(h.refused_count, 2, "precondition: a refusal is on record");
        let m = fold_health(&h, "dev", LinkEvent::Minted, 3_000);
        assert_eq!(
            (m.refused_first, m.refused_last, m.refused_count, m.refused_status),
            (None, None, 0, None)
        );
        assert_eq!(m.attested_at, None, "a mint is not an attestation");
    }

    #[test]
    fn a_record_for_another_identity_is_not_carried_over() {
        let old = LinkHealth {
            device_id: "old".into(),
            attested_at: Some(5),
            refused_first: Some(10),
            refused_last: Some(900),
            refused_count: 7,
            refused_status: Some(400),
        };
        let fresh = fold_health(&old, "new", LinkEvent::Refused(401), 2_000);
        assert_eq!(fresh.device_id, "new");
        assert_eq!(fresh.refused_first, Some(2_000), "the old run must not be inherited");
        assert_eq!(fresh.refused_count, 1);
        assert_eq!(fresh.attested_at, None);

        // And the pipe reports nothing about an identity it does not hold.
        assert!(health_for(&old, "new").is_none());
        assert!(health_for(&old, "").is_none(), "an empty id matches nothing");
        assert!(health_for(&LinkHealth::default(), "").is_none(), "not even an empty record");
        assert_eq!(health_for(&old, "old"), Some(old.clone()), "positive control");
    }

    #[test]
    fn only_a_refusal_of_the_device_itself_is_recorded() {
        // The one 400 about the device.
        assert!(is_refusal(400, VERIFIED_400));
        // The challenge errors (src/device_token.rs) are about ONE attempt: a
        // server restart between the two round trips produces them.
        assert!(!is_refusal(400, "that challenge is unknown or has expired"));
        assert!(!is_refusal(400, "that challenge was not issued for this device"));
        assert!(!is_refusal(400, ""), "a bodyless 400 says nothing about the device");
        // Busy, not refusing.
        assert!(!is_refusal(429, VERIFIED_400));
        assert!(!is_refusal(408, VERIFIED_400));
        // Explicit auth refusals.
        assert!(is_refusal(401, ""));
        assert!(is_refusal(403, ""));
        assert!(is_refusal(404, ""));
        // A server fault is not a refusal.
        assert!(!is_refusal(500, VERIFIED_400));
        assert!(!is_refusal(503, ""));
    }

    #[test]
    fn a_refused_link_waits_longer_than_the_transient_ladder() {
        let next = after_attempt(0, &refused("dev"), Some("dev"), PLAIN);
        assert_eq!(next.wait_secs, REFUSED_RETRY_SECS);
        assert_eq!(REFUSED_RETRY_SECS, 900);
        assert_eq!(next.failures, 1);
        assert!(!next.force_rekey);
        // The ordinary ladder is unchanged.
        let ladder: Vec<u64> = (0..7).map(backoff_secs).collect();
        assert_eq!(ladder, vec![0, 1, 5, 15, 30, 60, 60]);
        // Success resets.
        let ok = after_attempt(9, &Ok(()), Some("dev"), PLAIN);
        assert_eq!((ok.failures, ok.wait_secs, ok.force_rekey), (0, 0, false));
    }

    #[test]
    fn a_persisted_refusal_followed_by_a_network_error_gets_the_fast_ladder() {
        // THE CRITICS' CASE. Yesterday's refusal is on disk; this boot's first
        // attempts fail on DNS because the network is not up yet. Waiting a
        // quarter of an hour after each would strand a machine the server has
        // since accepted again. The record exists here only to make the point
        // that nothing reads it: the wait comes from THIS attempt.
        let persisted = fold_health(&LinkHealth::default(), "dev", LinkEvent::Refused(400), 1);
        assert_eq!(persisted.refused_count, 1, "precondition: a refusal is on record");

        let dns = Err(AttemptError::Other("connect failed: dns error".into()));
        let first = after_attempt(0, &dns, Some("dev"), PLAIN);
        assert_eq!(first.wait_secs, backoff_secs(1));
        // Straight after a refusal, too: the refusal's long wait does not stick.
        let after_refusal = after_attempt(0, &refused("dev"), Some("dev"), PLAIN);
        assert_eq!(after_refusal.wait_secs, REFUSED_RETRY_SECS, "positive control");
        let then_dns = after_attempt(after_refusal.failures, &dns, Some("dev"), PLAIN);
        assert_eq!(then_dns.wait_secs, backoff_secs(2));
        assert_ne!(then_dns.wait_secs, REFUSED_RETRY_SECS);
    }

    #[test]
    fn a_refusal_of_an_identity_no_longer_enrolled_does_not_wait_long() {
        // The owner re-enrolled while an attempt for the old identity was in
        // flight: the new identity has not been refused and must not wait.
        assert_eq!(after_attempt(0, &refused("old"), Some("new"), PLAIN).wait_secs, backoff_secs(1));
        assert_eq!(after_attempt(0, &refused("old"), None, PLAIN).wait_secs, backoff_secs(1));
    }

    #[test]
    fn a_401_on_the_upgrade_sends_the_next_attempt_to_the_device_key() {
        use tokio_tungstenite::tungstenite::http::Response;
        use tokio_tungstenite::tungstenite::Error;

        let e401 = Error::Http(Response::builder().status(401).body(None).expect("response"));
        let got = classify_connect_error(&e401);
        assert!(matches!(got, AttemptError::TokenRejected(_)), "{got:?}");
        assert!(got.to_string().contains("401"), "the status must reach the log: {got}");
        let next = after_attempt(0, &Err(got), Some("dev"), PLAIN);
        assert!(next.force_rekey, "a dead token must not be presented again");
        assert_eq!(next.wait_secs, backoff_secs(1), "and it is not a refusal of the device");

        // Anything else leaves the token path alone.
        let e403 = Error::Http(Response::builder().status(403).body(None).expect("response"));
        assert!(matches!(classify_connect_error(&e403), AttemptError::Other(_)));
        let e502 = Error::Http(Response::builder().status(502).body(None).expect("response"));
        assert!(matches!(classify_connect_error(&e502), AttemptError::Other(_)));
        let io = Error::Io(std::io::Error::other("dns"));
        assert!(matches!(classify_connect_error(&io), AttemptError::Other(_)));
        assert!(!after_attempt(0, &Err(AttemptError::Other("x".into())), Some("dev"), PLAIN).force_rekey);
        assert!(!after_attempt(0, &refused("dev"), Some("dev"), PLAIN).force_rekey);
    }

    #[test]
    fn a_rekey_that_is_refused_does_not_present_the_dead_token_again() {
        // THE SEQUENCE: the upgrade 401s (the stored token is dead), the next
        // attempt goes straight to the device key, and the server refuses it.
        // Nothing was minted, so the stored token is STILL the dead one: the
        // attempt after the 15-minute wait must go to the device key again,
        // not open with a wasted 401 on a token the server already rejected.
        let first = after_attempt(0, &rejected(), Some("dev"), PLAIN);
        assert!(first.force_rekey, "precondition: the 401 sends the next attempt to the key");

        let rekey = AttemptPath { forced_rekey: first.force_rekey, minted: false };
        let refused_rekey = after_attempt(first.failures, &refused("dev"), Some("dev"), rekey);
        assert_eq!(refused_rekey.wait_secs, REFUSED_RETRY_SECS, "a refusal still waits long");
        assert!(refused_rekey.force_rekey, "the stored token is still the dead one");

        // And again, for as long as the refusal lasts: it stays set.
        let rekey = AttemptPath { forced_rekey: refused_rekey.force_rekey, minted: false };
        let again = after_attempt(refused_rekey.failures, &refused("dev"), Some("dev"), rekey);
        assert!(again.force_rekey, "a second refused rekey keeps it too");

        // The same for a rekey that failed on the network before minting.
        let net = Err(AttemptError::Other("could not redeem the challenge: dns".into()));
        assert!(after_attempt(1, &net, Some("dev"), rekey).force_rekey);

        // POSITIVE CONTROLS. A refusal or network error on the ordinary path
        // (no token was rejected) does not start rekeying; a rekey that
        // MINTED has replaced the dead token, so whatever fails afterwards
        // leaves the new one to be presented; and success clears it.
        assert!(!after_attempt(0, &refused("dev"), Some("dev"), PLAIN).force_rekey);
        assert!(!after_attempt(0, &net, Some("dev"), PLAIN).force_rekey);
        let minted_rekey = AttemptPath { forced_rekey: true, minted: true };
        assert!(!after_attempt(1, &net, Some("dev"), minted_rekey).force_rekey);
        assert!(!after_attempt(1, &Ok(()), Some("dev"), rekey).force_rekey);
    }

    #[test]
    fn a_401_on_a_token_minted_in_the_same_attempt_does_not_mint_again() {
        // THE SEQUENCE: the stored token 401s, the rekey mints a fresh token,
        // and the upgrade 401s on THAT one too (a server-side fault after the
        // mint, e.g. token_session_live failing). The device key was just
        // accepted, so another mint would get the same answer — and each one
        // adds a server session. It goes on the plain ladder instead.
        let first = after_attempt(0, &rejected(), Some("dev"), PLAIN);
        assert!(first.force_rekey, "precondition");
        let minted = AttemptPath { forced_rekey: first.force_rekey, minted: true };
        let second = after_attempt(first.failures, &rejected(), Some("dev"), minted);
        assert!(!second.force_rekey, "a token minted a moment ago must not trigger another mint");
        assert_eq!(second.wait_secs, backoff_secs(2), "the plain ladder, not the refusal wait");
        assert_eq!(second.failures, 2, "and the ladder keeps climbing");

        // The same when the mint came from the expiry path's refresh fallback.
        let fallback = AttemptPath { forced_rekey: false, minted: true };
        assert!(!after_attempt(3, &rejected(), Some("dev"), fallback).force_rekey);

        // POSITIVE CONTROL: a 401 on a token this attempt did NOT mint still
        // goes to the device key, on the plain path and after a forced rekey
        // that produced no token.
        assert!(after_attempt(0, &rejected(), Some("dev"), PLAIN).force_rekey);
        let unminted = AttemptPath { forced_rekey: true, minted: false };
        assert!(after_attempt(0, &rejected(), Some("dev"), unminted).force_rekey);
    }

    #[test]
    fn a_record_from_another_version_still_reads() {
        let empty: LinkHealth = serde_json::from_str("{}").expect("all fields default");
        assert_eq!(empty, LinkHealth::default());
        let h = LinkHealth {
            device_id: "d".into(),
            attested_at: Some(1),
            refused_first: Some(2),
            refused_last: Some(3),
            refused_count: 4,
            refused_status: Some(400),
        };
        let back: LinkHealth = serde_json::from_str(&serde_json::to_string(&h).unwrap()).unwrap();
        assert_eq!(back, h);
        let view: crate::control::LinkHealthView = h.into();
        assert_eq!(
            view,
            crate::control::LinkHealthView {
                attested_at: Some(1),
                refused_first: Some(2),
                refused_last: Some(3),
                refused_count: 4,
                refused_status: Some(400),
            }
        );
    }

    /// Scanned from the NON-TEST source, for the reason `handover_tests` gives:
    /// `include_str!` of this file includes these assertions, so searching the
    /// whole file would find every string and pass whatever the code says.
    fn src() -> &'static str {
        include_str!("link.rs").split("#[cfg(test)]").next().unwrap()
    }

    fn body_of<'a>(src: &'a str, start: &str) -> &'a str {
        let at = src.find(start).unwrap_or_else(|| panic!("missing {start}"));
        let rest = &src[at + start.len()..];
        // Up to the next top-level item.
        let end = ["\npub fn ", "\npub async fn ", "\nfn ", "\nasync fn ", "\n/// "]
            .iter()
            .filter_map(|m| rest.find(m))
            .min()
            .unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn the_device_token_path_records_what_the_server_said() {
        let body = body_of(src(), "pub async fn obtain_device_token(");
        assert!(
            body.contains("if is_refusal(status.as_u16(), &body) {"),
            "only a refusal of the device may be recorded: {body}"
        );
        assert!(
            body.contains("record(&cfg.device_id, LinkEvent::Refused(status.as_u16()));"),
            "the refusal arm must record it, or the app never hears: {body}"
        );
        assert!(
            body.contains("record(&cfg.device_id, LinkEvent::Minted);"),
            "a successful mint must clear the refusal: {body}"
        );
        // The refusal is recorded AFTER the 5xx arm has returned.
        let five = body.find("status.is_server_error()").expect("5xx arm");
        let rec = body.find("LinkEvent::Refused(").expect("refusal record");
        assert!(five < rec, "a 5xx must never reach the refusal record");
    }

    #[test]
    fn an_attestation_is_recorded() {
        let s = src();
        let at = s.find("Incoming::Attested => {").expect("the Attested arm");
        // Up to the NEXT arm, not a fixed byte count: a byte slice panics when
        // an edit lands a multi-byte character (this file is full of em
        // dashes) on the cut, which would fail this test for no code reason.
        let rest = &s[at + "Incoming::Attested => {".len()..];
        let arm = &rest[..rest.find("Incoming::").expect("the arm after Attested")];
        assert!(
            arm.contains("record(&cfg.device_id, LinkEvent::Attested);"),
            "the Attested arm must record it: {arm}"
        );
    }

    #[test]
    fn the_loop_rekeys_after_a_401_and_waits_by_the_last_attempt() {
        let body = body_of(src(), "async fn link_forever(");
        assert!(body.contains("let token = if force_rekey {"), "{body}");
        let rekey = body.find("let token = if force_rekey {").unwrap();
        let mint = body[rekey..].find("obtain_device_token(&cfg).await?").map(|i| i + rekey);
        let refresh = body.find("refresh_token(&cfg, &token)").expect("the refresh path");
        assert!(
            mint.is_some_and(|m| m < refresh),
            "force_rekey must go straight to the device key, not through the refresh"
        );
        assert!(body.contains(
            "after_attempt(failures, &outcome, enrolled_device_id().as_deref(), path)"
        ));
        assert!(body.contains("let path = AttemptPath { forced_rekey: force_rekey, minted };"));
        assert!(body.contains("force_rekey = next.force_rekey;"));
        // EVERY mint marks the attempt, or a 401 on a token minted a moment
        // ago would send the next attempt to mint yet another one.
        let mints: Vec<usize> =
            body.match_indices("obtain_device_token(&cfg).await?").map(|(i, _)| i).collect();
        assert_eq!(mints.len(), 2, "the forced rekey and the expiry fallback: {body}");
        for i in mints {
            let after = body[i..].trim_start_matches("obtain_device_token(&cfg).await?");
            assert!(
                after.trim_start_matches(';').trim_start().starts_with("minted = true;"),
                "a mint must set `minted` straight away: {after}"
            );
        }
        let long = body.find("if next.wait_secs >= REFUSED_RETRY_SECS {").expect("the long wait");
        let long_arm = &body[long..];
        assert!(
            long_arm.contains("_ = gate.changed() => {}"),
            "the long wait must wake on a lock change: {long_arm}"
        );
        assert!(!body.contains("backoff_secs("), "the wait is after_attempt's, not a second policy");
        // THE RECORD IS WRITE-ONLY ON THE RETRY PATH. `after_attempt` decides
        // from this attempt alone (see its doc); a loop that read the record
        // for its wait would strand a machine behind yesterday's refusal after
        // every boot, and no after_attempt test could see it.
        for read in ["health_for(", "HEALTH", "load_health_file", "LinkHealth"] {
            assert!(!body.contains(read), "link_forever must not read the record ({read}): {body}");
        }
    }
}
