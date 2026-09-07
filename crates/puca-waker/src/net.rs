//! One socket to production, held open, attested, answering one message.
//!
//! THE SHAPE OF THE PROBLEM. The server only relays a wake to a device it can
//! see: `conn_of_device` has to resolve, which means this process must hold a
//! live authenticated WebSocket and must have attested on it. So the entire job
//! is "stay connected and stay attested", and every failure mode is a variation
//! on going quietly dark.
//!
//! WHY RE-DIAL RATHER THAN REPAIR. A renewed token does not extend an already
//! open socket: the server captures `token_exp` once at upgrade and re-checks it
//! on every inbound frame, and it Pings every 15s, so a socket whose token has
//! expired dies within about fifteen seconds whatever this end believes. There
//! is no in-place refresh to implement, only a re-dial to schedule.

use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;

/// Don't fire the same MAC more than this often.
///
/// Mirrors the responder cooldown in `frontend/src/api/devices/wake.ts`. A
/// machine takes tens of seconds to POST, and a burst of packets neither speeds
/// that up nor tells anyone anything; it only makes a retry loop look like it is
/// working.
const MAC_COOLDOWN: Duration = Duration::from_secs(5);

/// Reconnect backoff, in seconds, by consecutive failure count.
///
/// Bounded at a minute rather than growing without limit: this box exists to be
/// reachable, and an hour-long backoff after a transient network blip is
/// indistinguishable from the waker being dead at exactly the moment the owner
/// presses Wake. Starts at zero because the overwhelmingly common cause of a
/// drop is the server restarting during a deploy, which is over in seconds.
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

/// Why a dial failed, in the only two categories that call for different
/// behaviour.
///
/// WHY THIS EXISTS. Every dial failure used to collapse into one string and be
/// paced identically, so a PERMANENT refusal was retried once a minute for
/// ever, at the same log level as a blip, and the response BODY — the one place
/// the server says what is wrong — was discarded by `format!("{e}")`.
///
/// Measured: this box logged `connect failed: HTTP error: 401 Unauthorized`
/// 6,743 times over five days while its token-refresh task printed success
/// every four hours. Nothing in that record says the binary was too old to
/// authenticate the way the server now requires, which is what had happened;
/// the server knew, and said so in a body nobody kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialError {
    /// The server answered the upgrade and REFUSED it. Retrying unchanged will
    /// not fix this: something about this waker's identity or its protocol is
    /// no longer acceptable.
    Auth { status: u16, body: String },
    /// Anything else — DNS, TCP, TLS, a proxy, a 5xx. Almost always transient.
    Transport(String),
}

impl std::fmt::Display for DialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DialError::Auth { status, body } if body.is_empty() => {
                write!(f, "connect REFUSED: HTTP {status} (no message from the server)")
            }
            DialError::Auth { status, body } => {
                write!(f, "connect REFUSED: HTTP {status} — {body}")
            }
            DialError::Transport(e) => write!(f, "connect failed: {e}"),
        }
    }
}

impl DialError {
    /// A refusal the server chose to make: 4xx. A 5xx is the server being
    /// broken rather than this waker being unwelcome, so it stays transport.
    pub fn is_auth(&self) -> bool {
        matches!(self, DialError::Auth { status, .. } if (400..500).contains(status))
    }
}

/// Classify a tungstenite dial error, KEEPING the response body.
pub fn describe_dial_error(e: &tokio_tungstenite::tungstenite::Error) -> DialError {
    use tokio_tungstenite::tungstenite::Error;
    match e {
        Error::Http(resp) => {
            let status = resp.status().as_u16();
            let body = resp
                .body()
                .as_deref()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .unwrap_or_default();
            // Bodies are small JSON or plain text; a runaway one must not turn
            // a log line into a memory problem.
            let body: String = body.chars().take(300).collect();
            DialError::Auth { status, body }
        }
        other => DialError::Transport(other.to_string()),
    }
}

/// How many consecutive AUTH refusals before the process gives up and exits.
///
/// Fifteen, at roughly one a minute, so ~15 minutes of being told "no" before
/// the unit goes red. Deliberately far above systemd's default start limit
/// (5 starts in 10 s) — a threshold small enough to restart quickly would trip
/// that limit and leave the unit permanently dead, which is worse than the
/// silence this replaces.
pub const AUTH_REFUSALS_BEFORE_EXIT: u32 = 15;

/// A connection that LIVED resets the failure count; one that died young
/// increments it — regardless of whether the ending was polite.
///
/// Sixty seconds because the server pings every 15: a connection that survived
/// four ping rounds was genuinely up, not merely accepted. Below that, a clean
/// close and an error are the same event from this side — "we did not get a
/// working connection" — and treating the polite one as success produced a
/// zero-backoff redial loop against any server that accepts-then-closes
/// (while a long-lived socket that happened to END with an error ratcheted
/// the backoff toward the ceiling as though the link were flapping).
pub fn next_failure_count(previous: u32, lived: Duration) -> u32 {
    if lived >= Duration::from_secs(60) {
        0
    } else {
        previous.saturating_add(1)
    }
}

/// Should the socket be re-dialled to pick up a renewed token?
///
/// Pure so the rule is testable without a network. An hour of margin: the
/// server renews only inside the last twelve hours of a token's life, so this
/// fires well after a renewal is available and well before the socket would be
/// hung up under us.
pub fn should_redial_for_expiry(seconds_left: Option<i64>) -> bool {
    match seconds_left {
        // Unreadable token: re-dial and let the server be the judge.
        None => true,
        Some(s) => s < 3_600,
    }
}

/// What arrived on the socket that we care about. Everything else is ignored —
/// this process is not a client and has no business acting on chat traffic.
enum Incoming {
    Challenge(String),
    Attested,
    Wake { mac: String, broadcast: Option<String> },
    Other,
}

fn classify(text: &str) -> Incoming {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Incoming::Other,
    };
    let payload = v.get("payload");
    match v.get("type").and_then(|t| t.as_str()) {
        Some("DeviceChallenge") => payload
            .and_then(|p| p.get("nonce"))
            .and_then(|n| n.as_str())
            .map(|n| Incoming::Challenge(n.to_string()))
            .unwrap_or(Incoming::Other),
        Some("DeviceAttested") => Incoming::Attested,
        Some("DeviceWakeRequested") => {
            let mac = payload.and_then(|p| p.get("mac")).and_then(|m| m.as_str());
            match mac {
                Some(mac) => Incoming::Wake {
                    mac: mac.to_string(),
                    broadcast: payload
                        .and_then(|p| p.get("broadcast"))
                        .and_then(|b| b.as_str())
                        .map(str::to_string),
                },
                None => Incoming::Other,
            }
        }
        _ => Incoming::Other,
    }
}

/// No frame (not even the server's 15s Ping) for this long = the connection is
/// dead however alive the TCP stack claims it is. A black-holed link (NAT
/// entry dropped, VM migration, conntrack flush) delivers no error and no
/// close — `ws.next()` just never resolves — and without a deadline the waker
/// sat "connected" and unreachable indefinitely, which for this service is
/// indistinguishable from off. Four missed ping rounds is decisively dead.
const READ_DEADLINE: Duration = Duration::from_secs(60);

/// Inbound frame ceilings. tungstenite's defaults are 64 MiB per message /
/// 16 MiB per frame — larger than the unit's MemoryMax=48M, so one oversized
/// frame from the server side would be an OOM kill (and a repeating one, a
/// restart loop). Everything this socket legitimately receives is a small
/// JSON control frame; 64 KiB is two orders of magnitude of headroom, and an
/// overrun is a protocol ERROR this side logs and re-dials from, not a kill.
const MAX_WS_MESSAGE: usize = 64 * 1024;

/// Hold one socket until it dies. Returns Ok(()) on a clean close.
pub async fn run_socket(cfg: &Config, token: &str) -> Result<(), DialError> {
    let mut ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    ws_config.max_message_size = Some(MAX_WS_MESSAGE);
    ws_config.max_frame_size = Some(MAX_WS_MESSAGE);
    let (mut ws, _) =
        tokio_tungstenite::connect_async_with_config(
            cfg.ws_request(token).map_err(DialError::Transport)?,
            Some(ws_config),
            false,
        )
            .await
            .map_err(|e| describe_dial_error(&e))?;
    eprintln!("[waker] connected; waiting for the attestation challenge");

    let seed = cfg.seed().map_err(DialError::Transport)?;
    let ident = crate::identity::Identity {
        device_id: cfg.device_id.clone(),
        device_pub: cfg.device_pub.clone(),
        sign_pub: cfg.sign_pub.clone(),
        sign_seed: seed,
    };

    let mut attested = false;
    let mut last_wake: Option<(String, Instant)> = None;

    loop {
        let frame = match tokio::time::timeout(READ_DEADLINE, ws.next()).await {
            Err(_) => {
                return Err(DialError::Transport(format!(
                    "no traffic for {}s (the server pings every 15s) — treating the connection as dead",
                    READ_DEADLINE.as_secs()
                )));
            }
            Ok(None) => break,
            Ok(Some(f)) => f,
        };
        let msg = frame.map_err(|e| DialError::Transport(format!("socket error: {e}")))?;
        let text = match msg {
            Message::Text(t) => t,
            // tokio-tungstenite answers Ping automatically; the server's 15s
            // Ping is what keeps this connection accounted for as live.
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => {
                eprintln!("[waker] server closed the socket");
                return Ok(());
            }
            _ => continue,
        };

        match classify(&text) {
            Incoming::Challenge(nonce) => {
                let sig = ident.attest(&nonce, cfg.user_id);
                let out = serde_json::json!({
                    "type": "DeviceAttest",
                    "payload": { "device_id": cfg.device_id, "sig": sig }
                });
                ws.send(Message::Text(out.to_string()))
                    .await
                    .map_err(|e| DialError::Transport(format!("could not answer the challenge: {e}")))?;
            }
            Incoming::Attested => {
                attested = true;
                eprintln!("[waker] attested as {} — ready to wake", cfg.device_id);
            }
            Incoming::Wake { mac, broadcast } => {
                // ATTESTATION IS NOT OPTIONAL HERE. The server should never
                // relay a wake to an unattested connection, but this process
                // acts on a server-supplied MAC without asking anyone, so it
                // checks the property it depends on rather than assuming the
                // other end enforced it.
                if !attested {
                    eprintln!("[waker] refusing a wake on an unattested socket");
                    continue;
                }
                if let Some((last_mac, at)) = &last_wake {
                    if last_mac == &mac && at.elapsed() < MAC_COOLDOWN {
                        eprintln!("[waker] ignoring a repeat wake for {mac} within the cooldown");
                        continue;
                    }
                }
                match crate::wol::send(cfg.bind_ip, cfg.broadcast, &mac, broadcast.as_deref()) {
                    Ok(dests) => {
                        last_wake = Some((mac.clone(), Instant::now()));
                        eprintln!("[waker] magic packet for {mac} sent to {}", dests.join(", "));
                    }
                    Err(e) => eprintln!("[waker] wake for {mac} FAILED: {e}"),
                }
            }
            Incoming::Other => {}
        }
    }
    Ok(())
}

/// Ask the API for the device list, and adopt a renewed token if one comes back.
///
/// `GET /devices` rather than a dedicated endpoint because it does double duty:
/// it is the only call that carries `x-renewed-token`, AND its response is the
/// waker's own self-check — a missing row means this device was revoked, and
/// `online: false` on its own row while it believes it is attested means the
/// attestation silently failed.
pub async fn refresh(cfg: &Config, token: &str) -> Result<Option<String>, String> {
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
        return Err("the token was rejected — this waker needs pairing again".into());
    }
    let renewed = resp
        .headers()
        .get("x-renewed-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // Bounded read. `.json()` buffers the entire body first, and this process
    // lives under MemoryMax=48M — an absurd device list (or an error page from
    // some middlebox) must become a logged refresh failure, not an OOM kill.
    // A real device list is a few KB; 2 MB is presence-of-mind headroom.
    const MAX_BODY: u64 = 2_000_000;
    if resp.content_length().is_some_and(|l| l > MAX_BODY) {
        return Err("device list response is implausibly large — refusing to buffer it".into());
    }
    let bytes = resp.bytes().await.map_err(|e| format!("bad device list: {e}"))?;
    if bytes.len() as u64 > MAX_BODY {
        return Err("device list response is implausibly large — refusing to parse it".into());
    }
    let body: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("bad device list: {e}"))?;
    let mine = body
        .get("devices")
        .and_then(|d| d.as_array())
        .and_then(|list| {
            list.iter()
                .find(|d| d.get("id").and_then(|i| i.as_str()) == Some(cfg.device_id.as_str()))
        });
    match mine {
        None => return Err("this device is no longer on the account — it was revoked".into()),
        Some(row) => {
            if row.get("online").and_then(|o| o.as_bool()) != Some(true) {
                // Not fatal: a refresh can land in the gap between a socket
                // dropping and the next dial. Worth saying, because the silent
                // version of this is a waker that looks healthy and is not
                // addressable.
                eprintln!("[waker] WARNING: the server does not currently see this device online");
            }
        }
    }
    Ok(renewed)
}

/// This box's broadcast, for the config template printed by `init`.
pub fn guess_broadcast(ip: Ipv4Addr) -> Ipv4Addr {
    let o = ip.octets();
    Ipv4Addr::new(o[0], o[1], o[2], 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pacing rule that replaced "clean close resets, error increments".
    ///
    /// Both directions of the old rule were wrong, and each has a test here so
    /// neither can quietly return:
    ///  - a server that ACCEPTS then immediately closes CLEANLY used to reset
    ///    the counter every lap → zero backoff → a full TLS dial per network
    ///    round trip, for ever;
    ///  - a socket that lived for HOURS and then died with an error used to
    ///    increment every lap → a healthy link ratcheted to the 60s ceiling
    ///    as though it were flapping.
    /// THE LINE THAT WAS THROWN AWAY. The server answers a refused upgrade
    /// with a body saying why; `format!("{e}")` on the tungstenite error
    /// rendered "HTTP error: 401 Unauthorized" and dropped it. Five days of
    /// that told nobody the binary was too old to authenticate the way the
    /// server now requires — which the body said.
    #[test]
    fn a_refusal_keeps_the_status_and_the_body() {
        use tokio_tungstenite::tungstenite::http::Response;
        let resp = Response::builder()
            .status(401)
            .body(Some(b"this client is too old to authenticate".to_vec()))
            .expect("response");
        let err = tokio_tungstenite::tungstenite::Error::Http(resp);
        let got = describe_dial_error(&err);
        assert_eq!(
            got,
            DialError::Auth { status: 401, body: "this client is too old to authenticate".into() }
        );
        assert!(got.is_auth());
        assert!(got.to_string().contains("too old"), "the body must reach the log: {got}");
    }

    /// A refusal with no body still says which status, and still counts as a
    /// refusal — an empty body is not a reason to treat it as a network blip.
    #[test]
    fn a_bodyless_refusal_is_still_a_refusal() {
        use tokio_tungstenite::tungstenite::http::Response;
        let resp = Response::builder().status(403).body(None).expect("response");
        let got = describe_dial_error(&tokio_tungstenite::tungstenite::Error::Http(resp));
        assert!(got.is_auth());
        assert!(got.to_string().contains("403"));
    }

    /// A 5xx is the SERVER being broken, not this waker being unwelcome:
    /// retrying is right and exiting after fifteen of them would be wrong.
    #[test]
    fn a_server_error_is_not_an_auth_refusal() {
        use tokio_tungstenite::tungstenite::http::Response;
        let resp = Response::builder().status(502).body(None).expect("response");
        assert!(!describe_dial_error(&tokio_tungstenite::tungstenite::Error::Http(resp)).is_auth());
        let io = tokio_tungstenite::tungstenite::Error::Io(std::io::Error::other("dns"));
        let got = describe_dial_error(&io);
        assert!(!got.is_auth());
        assert!(matches!(got, DialError::Transport(_)));
    }

    /// The exit threshold must stay clear of systemd's default start limit
    /// (5 starts in 10 s): a smaller one would restart-loop the unit into a
    /// permanently dead state, which is worse than the silence it replaces.
    #[test]
    fn the_exit_threshold_cannot_trip_systemds_start_limit() {
        let shortest_gap_secs = backoff_secs(u32::MAX) * AUTH_REFUSALS_BEFORE_EXIT as u64;
        assert!(
            AUTH_REFUSALS_BEFORE_EXIT >= 10 && shortest_gap_secs >= 600,
            "{AUTH_REFUSALS_BEFORE_EXIT} refusals at up to {}s apart is {shortest_gap_secs}s",
            backoff_secs(u32::MAX)
        );
    }

    #[test]
    fn pacing_is_decided_by_how_long_the_connection_lived_not_how_it_ended() {
        use std::time::Duration as D;
        // Died young (however politely): counts as a failure, so backoff grows
        // instead of spinning at zero.
        assert_eq!(next_failure_count(0, D::from_secs(0)), 1);
        assert_eq!(next_failure_count(1, D::from_secs(3)), 2);
        assert!(backoff_secs(next_failure_count(0, D::from_secs(0))) > 0,
            "an instant close must never redial with zero delay");
        // Lived through four ping rounds: genuinely up — reset, whatever
        // ended it.
        assert_eq!(next_failure_count(7, D::from_secs(60)), 0);
        assert_eq!(next_failure_count(3, D::from_secs(3600)), 0);
        // Saturates rather than wrapping.
        assert_eq!(next_failure_count(u32::MAX, D::from_secs(1)), u32::MAX);
    }

    /// The inbound ceilings must stay far below the unit's MemoryMax=48M —
    /// tungstenite's 64 MiB default was an OOM kill wearing a default's
    /// clothes.
    #[test]
    fn the_ws_message_ceiling_fits_inside_the_memory_budget() {
        assert!(MAX_WS_MESSAGE <= 1024 * 1024);
    }

    #[test]
    fn the_frames_we_act_on_are_recognised() {
        assert!(matches!(
            classify(r#"{"type":"DeviceChallenge","payload":{"nonce":"n1"}}"#),
            Incoming::Challenge(n) if n == "n1"
        ));
        assert!(matches!(
            classify(r#"{"type":"DeviceAttested","payload":{"device_id":"d"}}"#),
            Incoming::Attested
        ));
        assert!(matches!(
            classify(r#"{"type":"DeviceWakeRequested","payload":{"mac":"AA:BB:CC:DD:EE:FF"}}"#),
            Incoming::Wake { ref mac, broadcast: None } if mac == "AA:BB:CC:DD:EE:FF"
        ));
        assert!(matches!(
            classify(r#"{"type":"DeviceWakeRequested","payload":{"mac":"A","broadcast":"192.168.0.255"}}"#),
            Incoming::Wake { broadcast: Some(ref b), .. } if b == "192.168.0.255"
        ));
    }

    #[test]
    fn everything_else_on_the_socket_is_ignored() {
        // This process is not a client. Chat traffic, presence, and anything
        // it does not understand must reach no code path at all — the less it
        // interprets, the smaller it is as a target.
        for frame in [
            r#"{"type":"ChatMessage","payload":{"content":"hi"}}"#,
            r#"{"type":"DeviceWakeRequested","payload":{}}"#,      // no mac
            r#"{"type":"DeviceChallenge","payload":{}}"#,          // no nonce
            "not json at all",
            "{}",
        ] {
            assert!(matches!(classify(frame), Incoming::Other), "{frame}");
        }
    }

    #[test]
    fn backoff_recovers_fast_and_is_bounded() {
        // Fast at the start because the common cause of a drop is a deploy
        // restarting the server, which is over in seconds.
        assert_eq!(backoff_secs(0), 0);
        assert_eq!(backoff_secs(1), 1);
        // Bounded, because a long backoff is indistinguishable from a dead
        // waker at exactly the moment someone presses Wake.
        assert_eq!(backoff_secs(50), 60);
        assert!(backoff_secs(1000) <= 60);
        // Monotonic up to the cap.
        for n in 0..6 {
            assert!(backoff_secs(n) <= backoff_secs(n + 1), "n={n}");
        }
    }

    #[test]
    fn a_socket_is_redialled_before_its_token_dies_under_it() {
        assert!(!should_redial_for_expiry(Some(23 * 3_600)), "fresh: stay put");
        assert!(should_redial_for_expiry(Some(59 * 60)), "under an hour: re-dial");
        assert!(should_redial_for_expiry(Some(-1)), "already expired");
        // Fail SAFE: an unreadable token triggers a refresh rather than a
        // confident wait on a credential we cannot reason about.
        assert!(should_redial_for_expiry(None));
    }

    #[test]
    fn the_broadcast_guess_is_the_subnet_not_the_host() {
        assert_eq!(
            guess_broadcast("192.168.0.30".parse().unwrap()),
            "192.168.0.255".parse::<Ipv4Addr>().unwrap()
        );
    }
}
